import { act, StrictMode, useState, type ReactNode } from "react";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// These tests cover workbench navigation, not the browser-owned canvas runtime.
const extensionRequire = createRequire(createRequire(import.meta.url).resolve("@project-workbench/ui/graph"));
const canvasModule = fileURLToPath(new URL("../esm/index.mjs", pathToFileURL(extensionRequire.resolve("@xyflow/react"))));
vi.doMock(canvasModule, async () => ({
  ...await vi.importActual<Record<string, unknown>>(canvasModule), ReactFlow: () => null,
}));

vi.mock("~/i18n/i18n", () => ({
  useI18n: () => ({ language: "en" }),
  LanguageSwitcher: () => null,
}));
vi.mock("./WorkbenchDeliveryGit", () => ({ WorkbenchDeliveryGit: () => null }));
vi.mock("./WorkbenchProgram", () => ({ WorkbenchProgram: () => null }));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));
vi.mock("./WorkbenchSessions", () => ({
  WorkbenchSessions: ({
    runs,
    selectedTask,
    selectedRunId,
  }: {
    runs: CurrentView["runs"];
    selectedTask: string | null;
    selectedRunId?: string | null;
  }) => (
    <section>
      {runs
        .filter((run) => (!selectedTask || run.taskSlug === selectedTask) && (!selectedRunId || run.id === selectedRunId))
        .map((run) => (
          <p key={run.id}>Host session: {run.id}</p>
        ))}
    </section>
  ),
}));

const { WorkbenchPage } = await import("./WorkbenchPage");
const { Page } = await import("../../../../../../project-workbench/extensions/workbench-ui/src/Page");
import type { CurrentView, DeliveryTestHook, WorkbenchSearch } from "./workbenchModel";
import { MailWorkspace } from "../../../../../../project-workbench/extensions/workbench-ui/src/MailWorkspace";
import { NodeEventsPanel } from "../../../../../../project-workbench/extensions/workbench-ui/src/NodeEventsPanel";
import { DeliveryHooksPanel } from "../../../../../../project-workbench/extensions/workbench-ui/src/DeliveryHooksPanel";
const { DependencyGraph } = await import("../../../../../../project-workbench/extensions/workbench-ui/src/DependencyGraph");

const deliveryHookFixture: DeliveryTestHook = {
  id: "hook-one", project: "one", sourceRunId: "source-run", sourceTaskSlug: "alpha", targetRunId: "test-run", targetTaskSlug: "beta", targetPackageId: "test-package",
  commitSha: "a".repeat(40), configuredByRunId: "pm-run", configuredByUserId: "pm-user", hostConsumerUserId: "host-service", createdAt: "now",
  deliveryId: null, triggeredAt: null, cancelledAt: null, cancelledByRunId: null, cancelledByUserId: null, cancellationReason: null,
  dispatchStatus: null, dispatchPhase: null, dispatchDetail: null, dispatchRecordedAt: null, state: "armed",
  retriedAt: null, retriedByRunId: null, retriedByUserId: null,
};

type PendingRequest = {
  url: string;
  body: BodyInit | null | undefined;
  method: string;
  project: string | null;
  signal: AbortSignal | null | undefined;
  resolve: (response: Response) => void;
};

let renderer: ReactTestRenderer | undefined;
let requests: PendingRequest[];
const searchChanged = vi.fn<(search: WorkbenchSearch) => void>();

function ControlledPage({ initial }: { initial: WorkbenchSearch }) {
  const [search, setSearch] = useState(initial);
  return (
    <WorkbenchPage
      search={search}
      onSearchChange={(next) => {
        searchChanged(next);
        setSearch(next);
      }}
    />
  );
}

function snapshot(project = "one", title = "Alpha task"): CurrentView {
  return {
    project,
    generatedAt: "2026-09-20T01:00:00Z",
    specs: [
      { slug: "alpha", title, stage: "specify", priority: "P1", version: 1 },
      { slug: "beta", title: "Beta task", stage: "done", priority: "P2", version: 2 },
    ],
    decisions: [],
    graph: { nodes: [], edges: [] },
    runs: [],
    deliveries: [],
    evidence: [],
    acceptances: [],
    capabilities: { independentVerification: false, discussionAuthorization: false, manualCompletion: true },
  };
}

function detail(slug: string, message: string) {
  return {
    slug,
    spec: {
      id: slug,
      slug,
      intent: `${slug} intent`,
      stage: "specify",
      priority: "P1",
      version: 1,
      createdAt: "2026-09-20T01:00:00Z",
      updatedAt: "2026-09-20T01:00:00Z",
    },
    dependencies: [],
    impactedBy: [],
    changes: [],
    events: [{ id: "event", message, createdAt: "2026-09-20T01:00:00Z" }],
  };
}

function content(node: ReactTestInstance | string = renderer!.root): string {
  return typeof node === "string" ? node : node.children.map(content).join("");
}

function button(label: string) {
  return renderer!.root
    .findAllByType("button")
    .find((entry) => entry.props["aria-label"] === label || content(entry) === label)!;
}

async function mount(initial: WorkbenchSearch = { project: "one" }) {
  await act(async () => {
    renderer = create(<ControlledPage initial={initial} />);
  });
}

async function respond(request: PendingRequest, body: unknown, status = 200) {
  await act(async () => {
    request.resolve(Response.json(body, { status }));
  });
}

beforeEach(() => {
  requests = [];
  searchChanged.mockReset();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", {
    hidden: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, options?: RequestInit) => {
      if (url === "/workbench-api/wb/projects")
        return Promise.resolve(
          Response.json({
            projects: [
              { slug: "one", managed: true },
              { slug: "two", managed: true },
            ],
          }),
        );
      // Deliberately allow an aborted request to finish, testing the component's stale-response guard.
      return new Promise<Response>((resolve) =>
        requests.push({
          url,
          body: options?.body,
          method: options?.method ?? "GET",
          project: new Headers(options?.headers).get("X-Specgraph-Project"),
          signal: options?.signal,
          resolve,
        }),
      );
    }),
  );
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("WorkbenchPage request lifecycle", () => {
  it("mounts the human summary controls only for the selected exact summary node", async () => {
    const data = snapshot();
    data.specs[0] = { ...data.specs[0]!, role: "summary" };
    const readData = vi.fn(async (input: { resource: string; slug?: string }) => input.resource === "projects" ? { projects: [{ slug: "one", managed: true }] }
      : input.resource === "current-view" ? data : { ...detail(input.slug!, "Original summary"), spec: { ...detail(input.slug!, "Original summary").spec!, role: "summary" } });
    const requestOperation = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ taskSlug: "alpha", version: 1, humanOwnerUserId: null, currentClaim: null,
      dispatchObservations: [], preparationObservations: [] }));
    await act(async () => { renderer = create(<Page search={{ project: "one", selected: "alpha", tab: "tasks" }} onSearchChange={() => {}} language="en" languageControl={null}
      readData={readData} requestOperation={requestOperation} renderSessions={() => null} renderTooltip={(_label, trigger) => trigger} />); });
    expect(renderer!.root.findByProps({ "aria-label": "Summary goal" })).toBeDefined();
    expect(renderer!.root.findByProps({ "aria-label": "Node merge and lineage" })).toBeDefined();
    expect(renderer!.root.findByProps({ "aria-label": "Completion-triggered program hook" })).toBeDefined();
    expect(requestOperation).toHaveBeenCalledWith("/workbench-api/loop/node-ownership/alpha", expect.objectContaining({ headers: { "X-Specgraph-Project": "one" } }));
    expect(requestOperation.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });

  it("keeps original merge history reachable on a superseded source", async () => {
    const data = snapshot();
    data.specs[0] = { ...data.specs[0]!, stage: "superseded", role: "work" };
    const readData = vi.fn(async (input: { resource: string; slug?: string }) => input.resource === "projects" ? { projects: [{ slug: "one", managed: true }] }
      : input.resource === "current-view" ? data : { ...detail(input.slug!, "Original node"), spec: { ...detail(input.slug!, "Original node").spec!, role: "work", stage: "superseded" } });
    const requestOperation = vi.fn(async () => Response.json({ taskSlug: "alpha", version: 1, humanOwnerUserId: null, currentClaim: null,
      dispatchObservations: [], preparationObservations: [] }));
    await act(async () => { renderer = create(<Page search={{ project: "one", selected: "alpha", tab: "tasks" }} onSearchChange={() => {}} language="en" languageControl={null}
      readData={readData} requestOperation={requestOperation} renderSessions={() => null} renderTooltip={(_label, trigger) => trigger} />); });
    const merge = renderer!.root.findByProps({ "aria-label": "Node merge and lineage" });
    await act(async () => merge.findByType("button").props.onClick());
    expect(merge.findAllByType("button").some((button) => button.children.includes("Read this node's merge history"))).toBe(true);
  });

  it("opens the exact unconfigured implementation run for pre-dispatch candidate setup", async () => {
    const data = snapshot();
    data.runs = [{ id: "candidate-run", taskSlug: "alpha", packageId: "package", generation: 1, threadRef: "thread", workspace: "workspace", state: "prepared",
      executorKind: "agent", workPurpose: "implementation", createdAt: "now", updatedAt: "now" }];
    const readData = vi.fn(async (input: { resource: string; slug?: string }) => input.resource === "projects" ? { projects: [{ slug: "one", managed: true }] }
      : input.resource === "current-view" ? data : detail(input.slug!, "Original node"));
    const onSearchChange = vi.fn();
    const requestOperation = vi.fn();
    await act(async () => { renderer = create(<Page search={{ project: "one", selected: "alpha", tab: "tasks" }} onSearchChange={onSearchChange} language="en" languageControl={null}
      readData={readData} requestOperation={requestOperation} renderSessions={() => null} renderTooltip={(_label, trigger) => trigger} />); });
    await act(async () => button("Configure formal candidate loop: candidate-run").props.onClick());
    expect(onSearchChange).toHaveBeenCalledWith({ project: "one", tab: "sessions", selected: "alpha", runId: "candidate-run" });
    expect(requestOperation).not.toHaveBeenCalled();
  });
  it("surfaces recorded risk flags in pending work without treating cleared or critical-only marks as risk", async () => {
    await mount({ project: "one", tab: "pending" });
    const view = snapshot();
    view.capabilities.nodeMarks = true;
    const base = { actor: "operator", createdAt: view.generatedAt, reason: "Review interface assumptions" };
    view.nodeMarks = [
      { ...base, id: "1", taskSlug: "alpha", kind: "risk", value: "watch" },
      { ...base, id: "2", taskSlug: "beta", kind: "risk", value: "high" },
      { ...base, id: "3", taskSlug: "gamma", kind: "risk", value: "cleared" },
      { ...base, id: "4", taskSlug: "alpha", kind: "critical", value: "marked" },
    ];
    await respond(requests[0]!, view);
    const section = renderer!.root.findByProps({ "aria-label": "Flagged nodes" });
    expect(section.findAllByType("li")).toHaveLength(2);
    expect(section.findAllByType("button")[0]!.props["aria-label"]).toBe("Open flagged node: beta");
    expect(content(section)).toContain(base.reason);
    await act(async () => button("Open flagged node: beta").props.onClick());
    expect(searchChanged).toHaveBeenLastCalledWith({ project: "one", tab: "tasks", selected: "beta" });
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });
  it("keeps acknowledged but open mail in pending work and navigates without touching receipts", async () => {
    const readMail = vi.fn(async (request: { resource: string }) => {
      if (request.resource === "mail-identity") return { identity: { subject: "operator", display_name: "Operator" } };
      if (request.resource === "mail-threads") return { threads: [
        { id: "acknowledged", task_slug: "alpha", subject: "Still unresolved", opened_by_run: "run-a", owner_run: "run-b", message_count: 2, pending_ack_count: 0, created_at: "2026-09-23", closed_at: null },
        { id: "waiting", task_slug: "alpha", subject: "Awaiting receipt", opened_by_run: "run-a", owner_run: "run-a", message_count: 1, pending_ack_count: 1, created_at: "2026-09-23", closed_at: null },
      ], next_cursor: "" };
      throw new Error("Unexpected operation");
    });
    const onOpenPendingThread = vi.fn();
    await act(async () => { renderer = create(<MailWorkspace project="one" task="alpha" language="en" revision="1" runs={[]} readMail={readMail} onOpenNode={() => {}} onClearTask={() => {}} onOpenPendingThread={onOpenPendingThread} />); });
    expect(readMail).toHaveBeenCalledWith({ resource: "mail-threads", project: "one", state: "open", cursor: "", taskSlug: "alpha" }, expect.any(AbortSignal));
    expect(renderer!.root.findAllByProps({ className: "wb-mail-thread" })).toHaveLength(2);
    expect(content()).toContain("All receipts acknowledged; thread remains open");
    await act(async () => renderer!.root.findAllByProps({ className: "wb-mail-thread" })[0]!.props.onClick());
    expect(onOpenPendingThread).toHaveBeenCalledWith("acknowledged");
    expect(readMail.mock.calls.map(([request]) => request.resource)).toEqual(["mail-identity", "mail-threads"]);
    expect(renderer!.root.findAllByProps({ className: "wb-mail-detail" })).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads child-node mail only when selected and resets scope pagination, detail and stale responses without writes", async () => {
    const thread = (id: string) => ({ id, task_slug: "alpha", subject: id, opened_by_run: "run-a", owner_run: "run-a", created_at: "now", closed_at: null, closure_note: null, message_count: 0, pending_ack_count: 0, last_message_at: null, node_links: [] });
    let pageLoads = 0;
    let finishOldList!: (result: unknown) => void;
    let oldSignal!: AbortSignal;
    const readMail = vi.fn(async (request: { resource: string; cursor?: string; threadId?: string; includeDescendants?: boolean }, signal: AbortSignal) => {
      if (request.resource === "mail-identity") return { identity: { subject: "operator", display_name: "Operator" } };
      if (request.resource === "mail-threads") {
        if (request.includeDescendants) return { threads: [thread("Child-scope thread")], next_cursor: "child-next" };
        if (request.cursor) {
          if (++pageLoads === 2) {
            oldSignal = signal;
            return new Promise<unknown>((resolve) => { finishOldList = resolve; });
          }
          return { threads: [thread("Direct page two")], next_cursor: "" };
        }
        return { threads: [thread("Direct page one")], next_cursor: "direct-next" };
      }
      if (request.resource === "mail-thread") return { thread: thread(request.threadId!), items: [], next_cursor: "" };
      if (request.resource === "mail-owner-history") return { events: [], next_cursor: "" };
      throw new Error("Unexpected mail operation");
    });
    const requestOperation = vi.fn(async () => { throw new Error("Unexpected write"); });
    await act(async () => { renderer = create(<MailWorkspace project="one" task="alpha" language="en" revision="1" runs={[]} readMail={readMail} request={requestOperation} onOpenNode={() => {}} onClearTask={() => {}} />); });
    expect(renderer!.root.findByProps({ "aria-label": "Include child nodes" }).props.checked).toBe(false);
    expect(readMail).toHaveBeenCalledWith({ resource: "mail-threads", project: "one", state: "open", cursor: "", taskSlug: "alpha" }, expect.any(AbortSignal));
    await act(async () => renderer!.root.findByProps({ "aria-label": "Thread pages" }).findAllByType("button")[1]!.props.onClick());
    await act(async () => renderer!.root.findByProps({ className: "wb-mail-thread" }).props.onClick());
    expect(content(renderer!.root.findByProps({ "aria-label": "Mail details" }))).toContain("Direct page two");
    expect(renderer!.root.findAllByProps({ "aria-label": "Takeover history" })).toHaveLength(1);
    await act(async () => button("Refresh mail").props.onClick());
    await act(async () => renderer!.root.findByProps({ "aria-label": "Include child nodes" }).props.onChange({ target: { checked: true } }));
    expect(oldSignal.aborted).toBe(true);
    expect(readMail).toHaveBeenCalledWith({ resource: "mail-threads", project: "one", state: "open", cursor: "", taskSlug: "alpha", includeDescendants: true }, expect.any(AbortSignal));
    expect(content()).toContain("Child-scope thread");
    expect(content(renderer!.root.findByProps({ "aria-label": "Mail details" }))).toContain("No thread selected.");
    expect(renderer!.root.findAllByProps({ "aria-label": "Takeover history" })).toHaveLength(0);
    expect(renderer!.root.findByProps({ "aria-label": "Thread pages" }).findAllByType("button")[0]!.props.disabled).toBe(true);
    await act(async () => finishOldList({ threads: [thread("Stale direct page")], next_cursor: "" }));
    expect(content()).toContain("Child-scope thread");
    expect(content()).not.toContain("Stale direct page");
    await act(async () => renderer!.root.findByProps({ "aria-label": "Include child nodes" }).props.onChange({ target: { checked: false } }));
    expect(readMail.mock.calls.filter(([entry]) => entry.resource === "mail-threads").at(-1)![0]).toEqual({ resource: "mail-threads", project: "one", state: "open", cursor: "", taskSlug: "alpha" });
    expect(requestOperation).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps retry/rework history separate from stage and review rejections, including completed nodes", async () => {
    const data = snapshot();
    data.capabilities.nodeEvents = true;
    data.graph.nodes = data.specs.map((spec) => ({ ...spec, label: "Spec" }));
    data.runs = [{ id: "run", taskSlug: "beta", packageId: "package", generation: 1, threadRef: "thread", workspace: "workspace", state: "completed", createdAt: data.generatedAt, updatedAt: data.generatedAt }];
    data.deliveries = [{ id: "delivery", runBindingId: "run", submittedBy: "operator", submittedAt: data.generatedAt }];
    data.acceptances = [{ id: "review", deliveryId: "delivery", verdict: "rejected", approver: "reviewer", createdAt: data.generatedAt }];
    const graph = () => <DependencyGraph data={data} selected={null} onSelect={() => {}} language="en" stageLabel={(stage) => stage} onOpenMail={() => {}} />;
    await act(async () => { renderer = create(graph()); });
    const beta = () => renderer!.root.find((node) => typeof node.props.onEdgeClick === "function").props.nodes.find((node: { id: string }) => node.id === "beta").data;
    expect(beta()).toMatchObject({ eventText: "", rejectionText: "Historical rejections 1", stageText: "done" });
    expect(content()).toContain("Retry/rework history counts unavailable");
    for (const [retries, reworks, eventTone] of [[0, 0, "none"], [1, 0, "amber"], [1, 1, "amber"], [1, 2, "red"]] as const) {
      data.nodeEventCounts = retries + reworks ? [{ taskSlug: "beta", retries, reworks }] : [];
      await act(async () => renderer!.update(graph()));
      expect(beta()).toMatchObject({ eventText: `History signal: retries ${retries} / reworks ${reworks} / Git undo history count unavailable`, eventTone, stageText: "done", rejectionText: "Historical rejections 1" });
      expect(content()).not.toContain("Retry/rework history counts unavailable");
    }
    data.nodeEventCounts = [{ taskSlug: "beta", retries: 0, reworks: 0, gitUndos: 3 }];
    await act(async () => renderer!.update(graph()));
    expect(beta()).toMatchObject({ eventText: "History signal: retries 0 / reworks 0 / Git undo references 3", eventTone: "none" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("opens event history in completed node details without recording a new event", async () => {
    await mount({ project: "one", selected: "beta", tab: "tasks" });
    const data = snapshot();
    data.capabilities.nodeEvents = true;
    data.nodeEventCounts = [{ taskSlug: "beta", retries: 2, reworks: 1 }];
    await respond(requests[0]!, data);
    const nodeDetail = detail("beta", "Completed work");
    nodeDetail.spec.stage = "done";
    await respond(requests[1]!, nodeDetail);
    const history = requests.find((request) => request.url === "/workbench-api/node-events/beta")!;
    expect(history.project).toBe("one");
    await respond(history, { taskSlug: "beta", events: [{ id: "event-id", taskSlug: "beta", kind: "rework", reason: "Past returned delivery", actor: "operator", previousRunId: null, runId: null, deliveryId: "real-delivery", gitUndo: null, recordedAt: data.generatedAt }], hasMore: false, nextCursor: null });
    const panel = renderer!.root.findByProps({ "aria-label": "Retry, rework and Git undo references" });
    expect(content(panel)).toContain("Historical retries 2 / Reworks 1");
    expect(content(panel)).toContain("Past returned delivery");
    expect(content(panel)).toContain("real-delivery");
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("reads Git undo references without rejecting the page or counting them as retry risk", async () => {
    const sourceCommit = "a".repeat(40), resultCommit = "b".repeat(40);
    const request = vi.fn(async () => Response.json({ taskSlug: "beta", events: [{ id: "undo-event", taskSlug: "beta", kind: "git_undo", reason: "Operator-declared reversal", actor: "human",
      previousRunId: null, runId: "run", deliveryId: null, gitUndo: { operation: "revert", sourceCommit, resultCommit }, recordedAt: "now" }], hasMore: false, nextCursor: null }));
    const run = { id: "run", taskSlug: "beta", packageId: "package", generation: 1, threadRef: "thread", workspace: "workspace", state: "completed", createdAt: "now", updatedAt: "now" };
    await act(async () => { renderer = create(<NodeEventsPanel project="one" slug="beta" language="en" runs={[run]} deliveries={[]} counts={[{ taskSlug: "beta", retries: 0, reworks: 0, gitUndos: 1 }]} request={request} onChanged={() => {}} />); });
    expect(content()).toContain("Git undo references 1");
    expect(content()).toContain("Undone commit"); expect(content()).toContain("Revert commit");
    expect(content()).toContain(sourceCommit); expect(content()).toContain(resultCommit);
    expect(content()).toContain("Named Git undo reference declaration");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps a lost Git undo write on its original eventId until the exact history is read", async () => {
    const sourceCommit = "a".repeat(40), resultCommit = "b".repeat(40);
    let posted: Record<string, unknown> | null = null;
    let reads = 0;
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") { posted = JSON.parse(String(init.body)); throw new Error("receipt lost"); }
      return Response.json({ taskSlug: "beta", events: reads++ === 0 ? [] : [{ id: posted!.eventId, taskSlug: "beta", kind: "git_undo", reason: posted!.reason, actor: "human",
        previousRunId: null, runId: "run", deliveryId: null, gitUndo: posted!.gitUndo, recordedAt: "now" }], hasMore: false, nextCursor: null });
    });
    const run = { id: "run", taskSlug: "beta", packageId: "package", generation: 1, threadRef: "thread", workspace: "workspace", state: "completed", createdAt: "now", updatedAt: "now" };
    await act(async () => { renderer = create(<NodeEventsPanel project="one" slug="beta" language="en" runs={[run]} deliveries={[]} counts={[{ taskSlug: "beta", retries: 0, reworks: 0, gitUndos: 0 }]} request={request} onChanged={() => {}} />); });
    await act(async () => renderer!.root.findByProps({ "aria-label": "Node event kind" }).props.onChange({ target: { value: "git_undo" } }));
    await act(async () => renderer!.root.findByProps({ "aria-label": "Git undo run" }).props.onChange({ target: { value: "run" } }));
    await act(async () => renderer!.root.findByProps({ "aria-label": "Git undo source commit" }).props.onChange({ target: { value: sourceCommit } }));
    await act(async () => renderer!.root.findByProps({ "aria-label": "Git undo result commit" }).props.onChange({ target: { value: resultCommit } }));
    await act(async () => renderer!.root.findByProps({ "aria-label": "Node event reason" }).props.onChange({ target: { value: "Reverse the bad commit" } }));
    const form = renderer!.root.findByProps({ "aria-label": "Record node event" });
    await act(async () => form.props.onSubmit({ preventDefault() {} }));
    expect(posted).toMatchObject({ kind: "git_undo", runId: "run", reason: "Reverse the bad commit", gitUndo: { operation: "revert", sourceCommit, resultCommit } });
    expect(posted).toHaveProperty("eventId");
    expect(content()).toContain("Pending event ID");
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await act(async () => button("Refresh history").props.onClick());
    expect(content()).toContain("Event recorded");
    expect(content()).not.toContain("Pending event ID");
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("distinguishes reset HEAD references, rejects invalid revert pairs, and leaves an explicit 400 editable", async () => {
    const sha = "a".repeat(40);
    const request = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? Response.json({ code: "invalid_argument" }, { status: 400 })
      : Response.json({ taskSlug: "beta", events: [], hasMore: false, nextCursor: null }));
    const run = { id: "run", taskSlug: "beta", packageId: "package", generation: 1, threadRef: "thread", workspace: "workspace", state: "completed", createdAt: "now", updatedAt: "now" };
    await act(async () => { renderer = create(<NodeEventsPanel project="one" slug="beta" language="en" runs={[run]} deliveries={[]} counts={[]} request={request} onChanged={() => {}} />); });
    expect(content()).toContain("Git undo history count unavailable");
    await act(async () => renderer!.root.findByProps({ "aria-label": "Node event kind" }).props.onChange({ target: { value: "git_undo" } }));
    await act(async () => renderer!.root.findByProps({ "aria-label": "Git undo run" }).props.onChange({ target: { value: "run" } }));
    await act(async () => renderer!.root.findByProps({ "aria-label": "Git undo operation" }).props.onChange({ target: { value: "reset" } }));
    expect(content()).toContain("HEAD before reset"); expect(content()).toContain("HEAD after reset");
    await act(async () => renderer!.root.findByProps({ "aria-label": "Git undo source commit" }).props.onChange({ target: { value: sha } }));
    await act(async () => renderer!.root.findByProps({ "aria-label": "Git undo result commit" }).props.onChange({ target: { value: sha } }));
    await act(async () => renderer!.root.findByProps({ "aria-label": "Node event reason" }).props.onChange({ target: { value: "Reset HEAD reference" } }));
    const submit = () => renderer!.root.findByProps({ "aria-label": "Record node event" }).findByProps({ type: "submit" });
    expect(submit().props.disabled).toBe(false);
    await act(async () => renderer!.root.findByProps({ "aria-label": "Record node event" }).props.onSubmit({ preventDefault() {} }));
    expect(content()).toContain("Event not saved: 400");
    expect(content()).not.toContain("Pending event ID");
    await act(async () => renderer!.root.findByProps({ "aria-label": "Git undo operation" }).props.onChange({ target: { value: "revert" } }));
    expect(submit().props.disabled).toBe(true);
    await act(async () => renderer!.root.findByProps({ "aria-label": "Git undo result commit" }).props.onChange({ target: { value: sha.toUpperCase() } }));
    expect(submit().props.disabled).toBe(true);
    await act(async () => renderer!.root.findByProps({ "aria-label": "Git undo result commit" }).props.onChange({ target: { value: "b".repeat(39) } }));
    expect(submit().props.disabled).toBe(true);
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("loads the mail layer on demand and opens the exact thread without changing dependencies", async () => {
    const data = snapshot();
    data.capabilities.mailInspection = true;
    data.graph.nodes = data.specs.map((spec) => ({ ...spec, label: "Spec" }));
    data.graph.edges = [{ from: "alpha", to: "beta", type: "BLOCKS" }];
    const original = structuredClone(data.graph);
    const onOpenMail = vi.fn();
    const readMail = vi.fn(async (request: { cursor?: string }) => request.cursor ? ({ threads: [{ id: "mail-2", subject: "Second review", node_links: [{ sender_task_slug: "beta", recipient_task_slug: "alpha", message_count: 3, pending_ack_count: 1 }] }], next_cursor: "" }) : ({ threads: [{ id: "mail-1", subject: "Review", node_links: [
      { sender_task_slug: "beta", recipient_task_slug: "alpha", message_count: 2, pending_ack_count: 1 },
      { sender_task_slug: "beta", recipient_task_slug: "beta", message_count: 1, pending_ack_count: 0 },
    ] }], next_cursor: "more" }));
    await act(async () => { renderer = create(<DependencyGraph data={data} selected={null} onSelect={() => {}} language="en" stageLabel={(stage) => stage} readMail={readMail} onOpenMail={onOpenMail} />); });
    expect(readMail).not.toHaveBeenCalled();
    const label = renderer!.root.findAllByType("label").find((node) => content(node).includes("Mail collaboration"))!;
    await act(async () => label.findByType("input").props.onChange({ target: { checked: true } }));
    expect(readMail).toHaveBeenCalledWith({ resource: "mail-threads", project: "one", state: "open", cursor: "" }, expect.any(AbortSignal));
    const canvas = renderer!.root.find((node) => typeof node.props.onEdgeClick === "function");
    const edge = canvas.props.edges.find((entry: { data?: { mail?: unknown } }) => entry.data?.mail);
    expect(edge).toMatchObject({ source: "beta", target: "alpha", label: "Deliveries 2 · pending 1" });
    await act(async () => canvas.props.onEdgeClick({}, edge));
    expect(onOpenMail).toHaveBeenCalledWith("mail-1");
    expect(content()).toContain("partial view");
    expect(canvas.props.edges).toHaveLength(2);
    expect(content()).toContain("Within-node deliveries: 1");
    await act(async () => button("Load more").props.onClick());
    const updatedCanvas = renderer!.root.find((node) => typeof node.props.onEdgeClick === "function");
    const combined = updatedCanvas.props.edges.find((entry: { data?: { mail?: unknown } }) => entry.data?.mail);
    expect(combined.label).toBe("Deliveries 5 · pending 2");
    expect(updatedCanvas.props.edges).toHaveLength(2);
    await act(async () => updatedCanvas.props.onEdgeClick({}, combined));
    const selection = renderer!.root.findByProps({ "aria-label": "Selected communication link" });
    await act(async () => selection.findAllByType("button").find((node) => content(node) === "Second review")!.props.onClick());
    expect(onOpenMail).toHaveBeenLastCalledWith("mail-2");
    expect(data.graph).toEqual(original);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("overlays grouped original hooks without changing layout or dependency facts and opens the actual target and record", async () => {
    const data = snapshot();
    data.capabilities.deliveryHooks = true;
    data.readySpecSlugs = ["alpha"];
    data.graph.nodes = data.specs.map((spec) => ({ ...spec, label: "Spec" }));
    data.graph.edges = [{ from: "alpha", to: "beta", type: "BLOCKS" }];
    data.deliveryHooks = [deliveryHookFixture,
      { ...deliveryHookFixture, id: "hook-accepted", state: "commandAccepted", deliveryId: "real-delivery", dispatchStatus: "commandAccepted", dispatchPhase: "start", dispatchDetail: "Native command accepted" },
      { ...deliveryHookFixture, id: "hook-missing", targetTaskSlug: "missing-test", state: "blocked", dispatchStatus: "blocked", dispatchDetail: "Original target is absent" }];
    data.runs = [{ id: "source-run", taskSlug: "alpha", packageId: "implementation-package", generation: 1, threadRef: "source-thread", workspace: "workspace", state: "completed", createdAt: "now", updatedAt: "later" }];
    data.deliveries = [{ id: "real-delivery", runBindingId: "source-run", submittedBy: "source-user", submittedAt: "later" }];
    const original = structuredClone(data.graph);
    const onSelect = vi.fn(); const onOpenHook = vi.fn(); const onOpenDelivery = vi.fn();
    await act(async () => { renderer = create(<DependencyGraph data={data} selected={null} onSelect={onSelect} onOpenHook={onOpenHook} onOpenDelivery={onOpenDelivery} language="en" stageLabel={(stage) => stage} onOpenMail={() => {}} />); });
    const canvas = () => renderer!.root.find((node) => typeof node.props.onEdgeClick === "function");
    const originalNodes = canvas().props.nodes.map((node: { data: Record<string, unknown> }) => ({ ...node, data: { ...node.data, select: undefined } }));
    const originalEdges = canvas().props.edges;
    expect(originalEdges).toHaveLength(1);
    const layer = renderer!.root.findAllByType("label").find((node) => content(node) === "Hook relations")!;
    expect(layer.findByType("input").props.checked).toBe(false);
    await act(async () => layer.findByType("input").props.onChange({ target: { checked: true } }));
    expect(canvas().props.nodes.map((node: { data: Record<string, unknown> }) => ({ ...node, data: { ...node.data, select: undefined } }))).toEqual(originalNodes);
    expect(canvas().props.edges.filter((edge: { data?: { dependency?: boolean } }) => edge.data?.dependency)).toEqual(originalEdges);
    const edge = canvas().props.edges.find((entry: { data?: { hooks?: unknown } }) => entry.data?.hooks);
    expect(edge).toMatchObject({ source: "alpha", target: "beta", label: "Delivery test hook · 2", data: { dependency: false } });
    expect(canvas().props.edges).toHaveLength(2);
    expect(canvas().props.nodes.map((node: { id: string }) => node.id)).toEqual(["alpha", "beta"]);
    await act(async () => canvas().props.onEdgeClick({}, edge));
    expect(onSelect).toHaveBeenCalledWith("beta");
    const selection = renderer!.root.findByProps({ "aria-label": "Selected hook relation" });
    expect(selection.findAllByType("button").map(content)).toEqual(["hook-one", "hook-accepted"]);
    await act(async () => button("hook-accepted").props.onClick());
    expect(onOpenHook).toHaveBeenCalledWith("hook-accepted");
    expect(content()).toContain("Command accepted");
    expect(content()).toContain(deliveryHookFixture.commitSha);
    expect(content()).toContain("Configured by: pm-user · pm-run");
    expect(content()).toContain("Native command accepted");
    expect(content()).not.toContain("Test passed");
    await act(async () => button("Open delivery").props.onClick());
    expect(onOpenDelivery).toHaveBeenCalledWith("real-delivery", "alpha");
    expect(data.graph).toEqual(original);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads source and target hook details with honest states, original missing references and no writes", async () => {
    await mount({ project: "one", tab: "tasks", selected: "alpha" });
    const data = snapshot(); data.capabilities.deliveryHooks = true;
    const states: DeliveryTestHook["state"][] = ["armed", "pending", "commandAccepted", "blocked", "unconfirmed", "rejected", "cancelled"];
    data.deliveryHooks = states.map((state) => ({ ...deliveryHookFixture, id: `hook-${state}`, state,
      ...(state === "cancelled" ? { cancelledAt: "cancel-time", cancelledByUserId: "cancel-user", cancelledByRunId: "cancel-run", cancellationReason: "PM cancelled this preparation" } : {}),
      ...(state === "blocked" ? { sourceTaskSlug: "missing-source", targetTaskSlug: "alpha", dispatchDetail: "Fixed commit is unavailable" } : {}) }));
    data.deliveryHooks.push({ ...deliveryHookFixture, id: "unrelated-hook", sourceTaskSlug: "beta", targetTaskSlug: "beta" });
    await respond(requests[0]!, data);
    await respond(requests[1]!, detail("alpha", "Original task"));
    const panel = renderer!.root.findByProps({ "aria-label": "Delivery test hooks" });
    for (const label of ["Waiting for delivery", "Pending dispatch", "Command accepted", "Blocked", "Outcome unknown", "Rejected", "Cancelled"]) expect(content(panel)).toContain(label);
    expect(content(panel)).toContain("missing-source");
    expect(content(panel)).toContain("Fixed commit is unavailable");
    expect(content(panel)).toContain("PM cancelled this preparation");
    expect(content(panel)).toContain("cancel-user · cancel-run");
    expect(content(panel)).not.toContain("unrelated-hook");
    expect(panel.findAllByType("button").some((node) => content(node) === "missing-source")).toBe(false);
    expect(requests.every((entry) => entry.method === "GET")).toBe(true);
  });

  it("does not claim zero hooks when the current-view capability or array is unavailable", async () => {
    const data = snapshot();
    await act(async () => { renderer = create(<DependencyGraph data={data} selected={null} onSelect={() => {}} language="en" stageLabel={(stage) => stage} onOpenMail={() => {}} />); });
    const layer = renderer!.root.findAllByType("label").find((node) => content(node) === "Hook relations")!;
    await act(async () => layer.findByType("input").props.onChange({ target: { checked: true } }));
    expect(content()).toContain("Hook data unavailable.");
    expect(content()).not.toContain("0 hook records");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("enables a human hook only after explicit fixed-run selection and preserves the exact intent through unknown or mismatched receipts", async () => {
    const data = snapshot(); data.capabilities.deliveryHooks = true; data.deliveryHooks = [];
    const run = { packageId: "test-package", generation: 1, threadRef: "", workspace: "workspace", createdAt: "now", updatedAt: "now" };
    data.runs = [
      { ...run, id: "source-run", taskSlug: "alpha", state: "completed", workPurpose: "implementation" },
      { ...run, id: "test-run", taskSlug: "beta", state: "prepared", workPurpose: "test_execution", gitBaseline: { isRepo: true, commitSha: deliveryHookFixture.commitSha } },
      { ...run, id: "already-bound", taskSlug: "beta", state: "bound", workPurpose: "test_execution", gitBaseline: { isRepo: true, commitSha: deliveryHookFixture.commitSha } },
      { ...run, id: "missing-baseline", taskSlug: "beta", state: "prepared", workPurpose: "test_execution" },
      { ...run, id: "program-source", executorKind: "program", taskSlug: "alpha", state: "completed", workPurpose: "implementation" },
      { ...run, id: "program-test", executorKind: "program", taskSlug: "beta", state: "prepared", workPurpose: "test_execution", gitBaseline: { isRepo: true, commitSha: deliveryHookFixture.commitSha } },
    ];
    data.deliveries = ["older-delivery", "newest-delivery"].map((id) => ({ id, runBindingId: "source-run", submittedBy: "source-user", submittedAt: id }));
    const receipt: DeliveryTestHook = { ...deliveryHookFixture, id: "human-hook", configuredByRunId: null, configuredByUserId: "human-user", deliveryId: "older-delivery", state: "pending", triggeredAt: "trigger-time" };
    const readData = vi.fn(async ({ resource }: { resource: string }) => resource === "projects" ? { projects: [{ slug: "one", managed: true }] } : resource === "current-view" ? data : detail("alpha", "Implementation"));
    let attempts = 0;
    const requestOperation = vi.fn(async (_url: string, _init?: RequestInit) => {
      attempts++;
      if (attempts === 1) throw new Error("connection lost");
      if (attempts === 2) return Response.json({ ...receipt, sourceTaskSlug: undefined, targetTaskSlug: undefined, targetRunId: "wrong-target" });
      data.deliveryHooks = [receipt]; return Response.json({ ...receipt, sourceTaskSlug: undefined, targetTaskSlug: undefined });
    });
    await act(async () => { renderer = create(<Page search={{ project: "one", tab: "tasks", selected: "alpha" }} onSearchChange={searchChanged} language="en" languageControl={null} renderSessions={() => null} renderTooltip={(_label, trigger) => trigger} readData={readData} requestOperation={requestOperation} />); });
    expect(requestOperation).not.toHaveBeenCalled();
    expect(renderer!.root.findByType(DependencyGraph).props.requestOperation).toBe(requestOperation);
    await act(async () => button("Configure delivery test hook").props.onClick());
    const form = () => renderer!.root.findByProps({ "aria-label": "Enable test trigger" });
    expect(form().findByProps({ "aria-label": "Implementation run" }).findAllByType("option").map((entry) => entry.props.value)).toEqual(["", "source-run"]);
    expect(form().findByProps({ "aria-label": "Prepared test run" }).findAllByType("option").map((entry) => entry.props.value)).toEqual(["", "test-run"]);
    await act(async () => form().findByProps({ "aria-label": "Implementation run" }).props.onChange({ target: { value: "source-run" } }));
    await act(async () => form().findByProps({ "aria-label": "Prepared test run" }).props.onChange({ target: { value: "test-run" } }));
    expect(content(form())).toContain("Target package: test-package");
    expect(content(form())).toContain(deliveryHookFixture.commitSha);
    expect(form().findByProps({ "aria-label": "Existing source delivery" }).props.value).toBe("");
    await act(async () => form().findByProps({ "aria-label": "Existing source delivery" }).props.onChange({ target: { value: "older-delivery" } }));
    expect(requestOperation).not.toHaveBeenCalled();
    await act(async () => form().props.onSubmit({ preventDefault() {} }));
    expect(content()).toContain("Outcome unconfirmed");
    expect(form().findByProps({ "aria-label": "Prepared test run" }).props.disabled).toBe(true);
    const first = requestOperation.mock.calls[0]!;
    expect(first[0]).toBe("/workbench-api/wb/delivery-hooks/arm");
    const payload = JSON.parse(first[1]!.body as string);
    expect(payload).toEqual({ sourceRunId: "source-run", targetRunId: "test-run", commitSha: deliveryHookFixture.commitSha, deliveryId: "older-delivery", idempotencyKey: expect.any(String) });
    expect(payload.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    await act(async () => button("Refresh records").props.onClick());
    expect(requestOperation).toHaveBeenCalledTimes(1);
    await act(async () => button("Collapse").props.onClick());
    await act(async () => button("Unconfirmed hook request").props.onClick());
    expect(form().findByProps({ "aria-label": "Prepared test run" }).props.value).toBe("test-run");
    await act(async () => form().props.onSubmit({ preventDefault() {} }));
    expect(content()).toContain("Invalid hook arm receipt");
    expect(readData.mock.calls.filter(([entry]) => entry.resource === "current-view")).toHaveLength(2);
    await act(async () => form().props.onSubmit({ preventDefault() {} }));
    expect(requestOperation.mock.calls.map((call) => call[1]!.body)).toEqual([first[1]!.body, first[1]!.body, first[1]!.body]);
    expect(content()).toContain("Operation recorded.");
    expect(content()).toContain("Configured by: Human: human-user");
    expect(content()).toContain("Pending dispatch");
    expect(content()).not.toContain("Test passed");
    expect(readData.mock.calls.filter(([entry]) => entry.resource === "current-view")).toHaveLength(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["cancel", "retry"] as const)("submits explicit human %s for the original PM hook and exposes denial without impersonation", async (operation) => {
    const data = snapshot();
    const hook: DeliveryTestHook = { ...deliveryHookFixture, state: "blocked", dispatchStatus: "blocked" };
    const receipt: DeliveryTestHook = operation === "cancel" ? { ...hook, state: "cancelled", cancelledAt: "cancel-time", cancelledByRunId: null, cancelledByUserId: "human-user", cancellationReason: "Cancel this trigger" }
      : { ...hook, state: "pending", dispatchStatus: null, retriedAt: "retry-time", retriedByRunId: null, retriedByUserId: "human-user" };
    let attempts = 0;
    const requestOperation = vi.fn(async (_url: string, _init?: RequestInit) => ++attempts === 1 ? Response.json({ error: "Original admission disallows this operation" }, { status: 403 }) : Response.json({ ...receipt, sourceTaskSlug: undefined, targetTaskSlug: undefined }));
    const onChanged = vi.fn();
    await act(async () => { renderer = create(<DeliveryHooksPanel hooks={[hook]} available data={data} language="en" onOpenNode={() => {}} request={requestOperation} onChanged={onChanged} />); });
    const label = operation === "cancel" ? "Cancel trigger" : "Resume original dispatch";
    await act(async () => button(label).props.onClick());
    const form = () => renderer!.root.findByProps({ "aria-label": label });
    if (operation === "cancel") await act(async () => form().findByProps({ "aria-label": "Cancellation reason" }).props.onChange({ target: { value: "Cancel this trigger" } }));
    expect(requestOperation).not.toHaveBeenCalled();
    await act(async () => form().props.onSubmit({ preventDefault() {} }));
    expect(content()).toContain("Original admission disallows this operation");
    expect(content()).not.toContain("Operation recorded.");
    expect(onChanged).not.toHaveBeenCalled();
    expect(requestOperation.mock.calls[0]![0]).toBe(`/workbench-api/wb/delivery-hooks/${operation}`);
    expect(JSON.parse(requestOperation.mock.calls[0]![1]!.body as string)).toEqual({ hookId: hook.id, ...(operation === "cancel" ? { reason: "Cancel this trigger" } : {}) });
    await act(async () => form().props.onSubmit({ preventDefault() {} }));
    expect(onChanged).toHaveBeenCalledTimes(1);
    await act(async () => renderer!.update(<DeliveryHooksPanel hooks={[receipt]} available data={data} language="en" onOpenNode={() => {}} request={requestOperation} onChanged={onChanged} />));
    expect(content()).toContain("Configured by: pm-user · pm-run");
    expect(content()).toContain(operation === "cancel" ? "Cancelled by: Human: human-user" : "Retried by: Human: human-user");
    expect(content()).not.toContain("Test passed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requests operator login only after hook 401 and retains the original fixed request", async () => {
    const hook: DeliveryTestHook = { ...deliveryHookFixture, state: "unconfirmed", dispatchStatus: "unconfirmed" };
    const receipt: DeliveryTestHook = { ...hook, state: "pending", dispatchStatus: null, retriedAt: "later", retriedByRunId: null, retriedByUserId: "human-user" };
    let authorized = false;
    const requestOperation = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/auth/login")) { authorized = true; return Response.json({ identity: { subject: "apikey:operator-key", display_name: "Operator" } }); }
      return authorized ? Response.json({ ...receipt, sourceTaskSlug: undefined, targetTaskSlug: undefined }) : Response.json({ error: "Unauthorized" }, { status: 401 });
    });
    const onChanged = vi.fn();
    await act(async () => { renderer = create(<DeliveryHooksPanel hooks={[hook]} available data={snapshot()} language="en" onOpenNode={() => {}} request={requestOperation} onChanged={onChanged} />); });
    expect(requestOperation).not.toHaveBeenCalled();
    await act(async () => button("Resume original dispatch").props.onClick());
    const form = () => renderer!.root.findByProps({ "aria-label": "Resume original dispatch" });
    await act(async () => form().props.onSubmit({ preventDefault() {} }));
    expect(requestOperation).toHaveBeenCalledTimes(1);
    await act(async () => form().findByProps({ type: "password" }).props.onChange({ target: { value: "operator-test-key" } }));
    await act(async () => form().props.onSubmit({ preventDefault() {} }));
    expect(requestOperation.mock.calls.map(([url]) => url)).toEqual(["/workbench-api/wb/delivery-hooks/retry", "/workbench-api/api/auth/login", "/workbench-api/wb/delivery-hooks/retry"]);
    expect(requestOperation.mock.calls[2]![1]!.body).toBe(requestOperation.mock.calls[0]![1]!.body);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(content()).toContain("Operation recorded.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps human hook enablement unavailable without a prepared fixed-commit target", async () => {
    const data = snapshot();
    data.runs = [{ id: "target", taskSlug: "beta", packageId: "package", generation: 1, state: "prepared", workPurpose: "test_execution", threadRef: "", workspace: "workspace", createdAt: "now", updatedAt: "now" }];
    const requestOperation = vi.fn(async () => { throw new Error("Unexpected write"); });
    await act(async () => { renderer = create(<DeliveryHooksPanel hooks={[]} available data={data} language="en" onOpenNode={() => {}} request={requestOperation} onChanged={() => {}} />); });
    await act(async () => button("Configure delivery test hook").props.onClick());
    expect(content()).toContain("No prepared test run with a recorded Git commit is available.");
    expect(button("Enable test trigger").props.disabled).toBe(true);
    expect(requestOperation).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("inspects mail and signs out through IPC without HTTP or receipt mutation", async () => {
    const thread = { id: "mail", task_slug: "alpha", subject: "IPC collaboration", opened_by_run: "sender", owner_run: "recipient", created_at: "2026-09-22", closed_at: null, closure_note: null, message_count: 1, pending_ack_count: 1, last_message_at: "2026-09-22" };
    const readMail = vi.fn(async (request: { resource: string }) => {
      if (request.resource === "mail-identity") return { identity: { subject: "operator", display_name: "Operator" } };
      if (request.resource === "mail-threads") return { threads: [thread], next_cursor: "" };
      if (request.resource === "mail-thread") return { thread, next_cursor: "", items: [{ message: { id: "message", sender_run: "sender", handoff_to_run: "recipient", body: "Mail through IPC", created_at: "2026-09-22", references: [] }, receipts: [{ recipient_run_id: "recipient", read_at: null, acknowledged_at: null }] }] };
      if (request.resource === "mail-owner-history") return { events: [], next_cursor: "" };
      if (request.resource === "mail-signout") return { signedOut: true };
      throw new Error("Unexpected operation");
    });
    const onOpenNode = vi.fn();
    const runs = ["sender", "recipient"].map((id) => ({ id, taskSlug: `${id}-task`, packageId: "package", generation: 1, threadRef: id, workspace: "workspace", state: "bound", createdAt: "2026-09-22", updatedAt: "2026-09-22" }));
    await act(async () => { renderer = create(<MailWorkspace project="one" task="alpha" language="en" revision="1" initialThread="mail" runs={runs} readMail={readMail} onOpenNode={onOpenNode} onClearTask={() => {}} />); });
    expect(readMail).toHaveBeenCalledWith(expect.objectContaining({ resource: "mail-thread", project: "one", threadId: "mail" }), expect.any(AbortSignal));
    expect(content()).toContain("Mail through IPC");
    expect(content()).toContain("Opened by: sender");
    expect(content()).toContain("Current owner: recipient");
    expect(content()).toContain("Transferred to: recipient");
    expect(content()).toContain("No read receipt");
    await act(async () => button("sender-task").props.onClick());
    await act(async () => button("recipient-task").props.onClick());
    expect(onOpenNode.mock.calls).toEqual([["sender-task"], ["recipient-task"]]);
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => button("Sign out").props.onClick());
    expect(readMail.mock.calls.map(([request]) => request.resource)).toEqual(["mail-identity", "mail-threads", "mail-thread", "mail-owner-history", "mail-signout"]);
    expect(content()).toContain("Sign in");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("records an explicit human takeover with paged real contacts and separate actor history, retaining an uncertain command", async () => {
    let thread = { id: "mail", task_slug: "alpha", subject: "Retired owner", opened_by_run: "old-run", owner_run: "old-run", created_at: "now", closed_at: null, closure_note: null, message_count: 1, pending_ack_count: 1, last_message_at: "now", node_links: [] };
    const audit = { id: "takeover", thread_id: "mail", from_run: "old-run", to_run: "next-run", actor_kind: "human", actor_user_id: "user-one", actor_run_id: null, reason: "Continue the unresolved review", created_at: "later" };
    const readMail = vi.fn(async (request: { resource: string; cursor?: string }) => {
      if (request.resource === "mail-identity") return { identity: { subject: "apikey:key-one", display_name: "Operator" } };
      if (request.resource === "mail-threads") return { threads: [thread], next_cursor: "" };
      if (request.resource === "mail-thread") return { thread, next_cursor: "message-next", items: [{ message: { id: "message", sender_run: "old-run", handoff_to_run: null, body: "Original mail", created_at: "now", references: [] }, receipts: [{ recipient_run_id: "old-run", read_at: null, acknowledged_at: null }] }] };
      if (request.resource === "mail-directory") return request.cursor
        ? { contacts: [{ run_id: "next-run", task_slug: "next-task", assignment_role: "implementer" }], next_cursor: "" }
        : { contacts: [{ run_id: "other-run", task_slug: "other-task", assignment_role: "reviewer" }], next_cursor: "directory-next" };
      if (request.resource === "mail-owner-history") return request.cursor
        ? { events: [{ ...audit, id: "pm-takeover", actor_kind: "agent", actor_user_id: "pm-user", actor_run_id: "pm-run", reason: "PM takeover audit" }], next_cursor: "" }
        : { events: [audit], next_cursor: "audit-next" };
      throw new Error("Unexpected operation");
    });
    let attempts = 0;
    const requestOperation = vi.fn(async (_url: string, _init?: RequestInit) => {
      if (++attempts === 1) throw new Error("connection lost");
      thread = { ...thread, owner_run: "later-owner" };
      return Response.json({ thread, event: audit });
    });
    const onOpenNode = vi.fn();
    const runs = [{ id: "pm-run", taskSlug: "pm-task", packageId: "package", generation: 1, threadRef: "pm", workspace: "workspace", state: "bound", createdAt: "now", updatedAt: "now" }];
    await act(async () => { renderer = create(<MailWorkspace project="one" task={null} language="en" revision="1" initialThread="mail" runs={runs} readMail={readMail} request={requestOperation} onOpenNode={onOpenNode} onClearTask={() => {}} />); });
    expect(requestOperation).not.toHaveBeenCalled();
    expect(content()).toContain("Human: user-one");
    expect(content()).toContain("Original mail");
    await act(async () => renderer!.root.findByProps({ "aria-label": "Takeover history pages" }).findAllByType("button")[1]!.props.onClick());
    expect(content()).toContain("PM: pm-user · pm-run");
    await act(async () => button("pm-task").props.onClick());
    expect(onOpenNode).toHaveBeenCalledWith("pm-task");
    expect(readMail).toHaveBeenCalledWith({ resource: "mail-owner-history", project: "one", threadId: "mail", cursor: "audit-next", limit: 50 }, expect.any(AbortSignal));
    expect(readMail.mock.calls.filter(([entry]) => entry.resource === "mail-thread")).toHaveLength(1);
    await act(async () => button("Assign successor").props.onClick());
    await act(async () => renderer!.root.findByProps({ "aria-label": "Directory pages" }).findAllByType("button")[1]!.props.onClick());
    expect(readMail).toHaveBeenCalledWith({ resource: "mail-directory", project: "one", cursor: "directory-next", limit: 50 }, expect.any(AbortSignal));
    await act(async () => renderer!.root.findByProps({ "aria-label": "Successor" }).props.onChange({ target: { value: "next-run" } }));
    await act(async () => renderer!.root.findByProps({ "aria-label": "Takeover reason" }).props.onChange({ target: { value: audit.reason } }));
    expect(requestOperation).not.toHaveBeenCalled();
    await act(async () => renderer!.root.findByProps({ "aria-label": "Human takeover" }).props.onSubmit({ preventDefault() {} }));
    expect(content()).toContain("Outcome unconfirmed");
    expect(renderer!.root.findByProps({ "aria-label": "Successor" }).props.disabled).toBe(true);
    const first = requestOperation.mock.calls[0]!;
    expect(first[0]).toBe("/workbench-api/wb/mail/takeover");
    expect(first[1]).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json", "X-Specgraph-Project": "one" } });
    const payload = JSON.parse(first[1]!.body as string);
    expect(payload).toEqual({ mail_thread_id: "mail", recipient_run_id: "next-run", body: audit.reason, idempotency_key: expect.any(String) });
    expect(payload.idempotency_key).toHaveLength(32);
    await act(async () => renderer!.root.findByProps({ "aria-label": "Human takeover" }).props.onSubmit({ preventDefault() {} }));
    expect(requestOperation.mock.calls[1]![1]!.body).toBe(first[1]!.body);
    expect(content()).toContain("Human takeover recorded.");
    expect(content()).toContain("Current owner: later-owner");
    expect(content()).toContain("Opened by: old-run");
    expect(content()).toContain("Original mail");
    expect(content()).toContain("Pending acknowledgment");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows denied human takeover without changing owner, messages or receipts", async () => {
    const thread = { id: "mail", task_slug: "alpha", subject: "Still bound", opened_by_run: "old-run", owner_run: "old-run", created_at: "now", closed_at: null, closure_note: null, message_count: 1, pending_ack_count: 1, last_message_at: "now", node_links: [] };
    const readMail = vi.fn(async ({ resource }: { resource: string }) => {
      if (resource === "mail-identity") return { identity: { subject: "operator", display_name: "Operator" } };
      if (resource === "mail-threads") return { threads: [thread], next_cursor: "" };
      if (resource === "mail-thread") return { thread, next_cursor: "", items: [{ message: { id: "message", sender_run: "old-run", handoff_to_run: null, body: "Untouched mail", created_at: "now", references: [] }, receipts: [{ recipient_run_id: "next-run", read_at: null, acknowledged_at: null }] }] };
      if (resource === "mail-directory") return { contacts: [{ run_id: "next-run", task_slug: "next-task", assignment_role: "reviewer" }], next_cursor: "" };
      if (resource === "mail-owner-history") return { events: [], next_cursor: "" };
      throw new Error("Unexpected operation");
    });
    const requestOperation = vi.fn(async () => Response.json({ error: "Current owner is still bound" }, { status: 403 }));
    await act(async () => { renderer = create(<MailWorkspace project="one" task={null} language="en" revision="1" initialThread="mail" runs={[]} readMail={readMail} request={requestOperation} onOpenNode={() => {}} onClearTask={() => {}} />); });
    expect(requestOperation).not.toHaveBeenCalled();
    await act(async () => button("Assign successor").props.onClick());
    await act(async () => renderer!.root.findByProps({ "aria-label": "Successor" }).props.onChange({ target: { value: "next-run" } }));
    await act(async () => renderer!.root.findByProps({ "aria-label": "Takeover reason" }).props.onChange({ target: { value: "Continue review" } }));
    await act(async () => renderer!.root.findByProps({ "aria-label": "Human takeover" }).props.onSubmit({ preventDefault() {} }));
    expect(requestOperation).toHaveBeenCalledTimes(1);
    expect(content()).toContain("Current owner is still bound");
    expect(content()).toContain("Current owner: old-run");
    expect(content()).toContain("Untouched mail");
    expect(content()).toContain("Pending acknowledgment");
    expect(content()).not.toContain("Human takeover recorded.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["human", "agent"])("rejects takeover history with an empty %s actor user ID", async (actorKind) => {
    const thread = { id: "mail", task_slug: "alpha", subject: "Owner audit", opened_by_run: "old-run", owner_run: "next-run", created_at: "now", closed_at: null, closure_note: null, message_count: 0, pending_ack_count: 0, last_message_at: null, node_links: [] };
    const readMail = vi.fn(async ({ resource }: { resource: string }) => {
      if (resource === "mail-identity") return { identity: { subject: "apikey:key-one", display_name: "Operator" } };
      if (resource === "mail-threads") return { threads: [thread], next_cursor: "" };
      if (resource === "mail-thread") return { thread, items: [], next_cursor: "" };
      if (resource === "mail-owner-history") return { events: [{ id: "audit", thread_id: "mail", from_run: "old-run", to_run: "next-run", actor_kind: actorKind, actor_user_id: "", actor_run_id: actorKind === "agent" ? "pm-run" : null, reason: "Invalid actor audit", created_at: "now" }], next_cursor: "" };
      throw new Error("Unexpected operation");
    });
    await act(async () => { renderer = create(<MailWorkspace project="one" task={null} language="en" revision="1" initialThread="mail" runs={[]} readMail={readMail} onOpenNode={() => {}} onClearTask={() => {}} />); });
    expect(content()).toContain("Invalid owner history");
    expect(content()).not.toContain("Invalid actor audit");
    expect(content()).not.toContain("No takeover records.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses desktop IPC for page reads and never falls back to HTTP", async () => {
    const view = { ...snapshot(), readOnlyTransport: true };
    const readWorkbench = vi.fn(async (request: { resource: string }) => {
      if (request.resource === "projects") return { projects: [{ slug: "one", managed: true }] };
      if (request.resource === "current-view") return view;
      return detail("alpha", "IPC event");
    });
    vi.stubGlobal("window", { desktopBridge: { readWorkbench } });
    await mount({ project: "one", selected: "alpha" });
    expect(readWorkbench.mock.calls.map(([request]) => request.resource)).toEqual(["projects", "current-view", "spec"]);
    expect(fetch).not.toHaveBeenCalled();
    expect(content()).toContain("IPC event");
    expect(content()).not.toContain("mail panel is inspection-only");
    expect(button("New requirement node").props.disabled).toBe(true);
    readWorkbench.mockRejectedValue(new Error("IPC unavailable"));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(content()).toContain("IPC unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  async function openDependencies(view = snapshot()) {
    view.capabilities.dependencyEditing = true;
    await mount({ project: "one", selected: "alpha" });
    await respond(requests[0]!, view);
    await respond(requests[1]!, detail("alpha", "Recorded event"));
    await act(async () => { button(view.capabilities.dependencyRemoval ? "Edit prerequisites" : "Add prerequisite").props.onClick(); });
    return requests.find((entry) => entry.url.endsWith("/dependencies"))!;
  }

  async function enterDependency() {
    const form = renderer!.root.findByProps({ "aria-label": "Add prerequisite form" });
    await act(async () => {
      form.findByProps({ "aria-label": "Prerequisite spec" }).props.onChange({ target: { value: "beta" } });
      form.findByType("textarea").props.onChange({ target: { value: "Required before alpha" } });
    });
    return form;
  }

  it("does not offer dependency edits when the backend capability is absent", async () => {
    await mount({ project: "one", selected: "alpha" });
    await respond(requests[0]!, snapshot());
    await respond(requests[1]!, detail("alpha", "Recorded event"));
    expect(button("Add prerequisite")).toBeUndefined();
  });

  it("keeps an older add-only backend free of removal controls", async () => {
    await respond(await openDependencies(), { specVersion: 1, revision: "0", operations: [] });
    expect(renderer!.root.findAllByProps({ "aria-label": "Dependency operation" })).toHaveLength(0);
    expect(button("Confirm remove prerequisite")).toBeUndefined();
  });

  async function enterRemoval() {
    const view = snapshot(); view.capabilities.dependencyRemoval = true;
    view.specs.push({ slug: "gamma", title: "Unrelated spec", version: 3, stage: "spark", priority: "P2" });
    view.graph.nodes = [...view.specs.map((spec) => ({ ...spec, label: "Spec" })), { slug: "slice", title: "Slice only", label: "Slice", stage: "", priority: "" }];
    view.graph.edges = [{ from: "alpha", to: "beta", type: "DEPENDS_ON" }, { from: "alpha", to: "slice", type: "DEPENDS_ON" }];
    await respond(await openDependencies(view), { specVersion: 1, revision: "8", operations: [] });
    await act(async () => { renderer!.root.findByProps({ "aria-label": "Dependency operation" }).props.onChange({ target: { value: "remove" } }); });
    const form = renderer!.root.findByProps({ "aria-label": "Remove prerequisite form" });
    expect(form.findByProps({ "aria-label": "Prerequisite spec" }).findAllByType("option").map((entry) => entry.props.value)).toEqual(["", "beta"]);
    await act(async () => {
      form.findByProps({ "aria-label": "Prerequisite spec" }).props.onChange({ target: { value: "beta" } });
      form.findByType("textarea").props.onChange({ target: { value: "Relation no longer required" } });
    });
    return form;
  }

  it.each([true, false])("removes only explicitly selected existing Spec relations and preserves no-op meaning: changed=%s", async (changed) => {
    const form = await enterRemoval();
    expect(requests.every((entry) => entry.method === "GET")).toBe(true);
    expect(content(form)).toContain("nodes and operation history are retained");
    expect(button("Confirm remove prerequisite").props.disabled).toBe(false);
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
    const write = requests.find((entry) => entry.method === "POST")!;
    expect(write.url).toBe("/workbench-api/loop/specs/alpha/dependencies/remove");
    expect(write.project).toBe("one");
    expect(JSON.parse(String(write.body))).toEqual({ prerequisite: "beta", expected_version: 1, expected_prerequisite_version: 2, expected_revision: "8", reason: "Relation no longer required", idempotency_key: expect.any(String) });
    await respond(write, { dependent: "alpha", prerequisite: "beta", revision: changed ? "9" : "8", changed, replayed: false, operation: "remove" });
    expect(content()).toContain(changed ? "Prerequisite removed; nodes and operation history retained." : "Prerequisite already absent; no change made.");
    const entry = { actor: "operator", reason: "Recorded reason", prerequisite: "beta", revision: "8", createdAt: "time" };
    await respond(requests.filter((request) => request.method === "GET" && request.url.endsWith("/dependencies")).at(-1)!, {
      specVersion: 1, revision: "9", operations: [
        { ...entry, id: "legacy-add", changed: true }, { ...entry, id: "add-noop", operation: "add", changed: false },
        { ...entry, id: "remove", operation: "remove", changed: true }, { ...entry, id: "remove-noop", operation: "remove", changed: false },
      ],
    });
    const history = renderer!.root.findByProps({ "aria-label": "Latest 20 manual dependency operations" });
    expect(content(history)).toContain("Added"); expect(content(history)).toContain("Removed");
    expect(content(history)).toContain("Already present; unchanged"); expect(content(history)).toContain("Already absent; unchanged");
  });

  it("allows explicit removal of an existing self-dependency without allowing a self-add", async () => {
    const view = snapshot(); view.capabilities.dependencyRemoval = true;
    view.graph.nodes = view.specs.map((spec) => ({ ...spec, label: "Spec" }));
    view.graph.edges = [{ from: "alpha", to: "alpha", type: "DEPENDS_ON" }];
    await respond(await openDependencies(view), { specVersion: 1, revision: "9007199254740993", operations: [] });
    const target = renderer!.root.findByProps({ "aria-label": "Prerequisite spec" });
    expect(target.findAllByType("option").map((entry) => entry.props.value)).not.toContain("alpha");
    await act(async () => { renderer!.root.findByProps({ "aria-label": "Dependency operation" }).props.onChange({ target: { value: "remove" } }); });
    expect(target.findAllByType("option").map((entry) => entry.props.value)).toEqual(["", "alpha"]);
    const form = renderer!.root.findByProps({ "aria-label": "Remove prerequisite form" });
    await act(async () => {
      target.props.onChange({ target: { value: "alpha" } });
      form.findByType("textarea").props.onChange({ target: { value: "Remove imported self-dependency" } });
    });
    expect(button("Confirm remove prerequisite").props.disabled).toBe(false);
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
    const write = requests.find((entry) => entry.method === "POST")!;
    expect(write.url).toBe("/workbench-api/loop/specs/alpha/dependencies/remove");
    expect(JSON.parse(String(write.body))).toEqual({ prerequisite: "alpha", expected_version: 1, expected_prerequisite_version: 1, expected_revision: "9007199254740993", reason: "Remove imported self-dependency", idempotency_key: expect.any(String) });
    await respond(write, { dependent: "alpha", prerequisite: "alpha", revision: "9007199254740994", changed: true, replayed: false, operation: "remove" });
    expect(content()).toContain("Prerequisite removed; nodes and operation history retained.");
  });

  it.each([500, 200])("preserves exact removal route/body through uncertainty and refresh: HTTP %s", async (status) => {
    const form = await enterRemoval();
    const mode = renderer!.root.findByProps({ "aria-label": "Dependency operation" });
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
    expect(mode.props.disabled).toBe(true);
    await act(async () => { mode.props.onChange({ target: { value: "add" } }); });
    const first = requests.find((entry) => entry.method === "POST")!;
    // A removal receipt without operation must not inherit the legacy add-only contract.
    await respond(first, { dependent: "alpha", prerequisite: "beta", revision: "9", changed: true, replayed: false }, status);
    expect(content()).toContain("Result unconfirmed");
    await act(async () => { mode.props.onChange({ target: { value: "add" } }); });
    expect(mode.props.value).toBe("remove");
    await act(async () => { button("Reload and review").props.onClick(); });
    await respond(requests.filter((entry) => entry.method === "GET" && entry.url.endsWith("/dependencies")).at(-1)!, { specVersion: 99, revision: "42", operations: [] });
    const refreshed = snapshot(); refreshed.capabilities.dependencyEditing = true; refreshed.capabilities.dependencyRemoval = true; refreshed.specs[1]!.version = 77;
    await respond(requests.filter((entry) => entry.url.endsWith("/wb/current-view")).at(-1)!, refreshed);
    expect(mode.props.disabled).toBe(true);
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
    const writes = requests.filter((entry) => entry.method === "POST");
    expect(writes).toHaveLength(2); expect(writes[1]!.url).toBe(first.url); expect(writes[1]!.body).toBe(first.body);
    await respond(writes[1]!, { dependent: "alpha", prerequisite: "beta", revision: "9", changed: true, replayed: true, operation: "remove" });
    expect(content()).toContain("Original operation confirmed; refreshed state determines current dependencies.");
    expect(content()).not.toContain("Outcome unknown");
  });

  it("loads dependency controls after StrictMode replays the initial effect", async () => {
    await act(async () => {
      renderer = create(<StrictMode><ControlledPage initial={{ project: "one", selected: "alpha" }} /></StrictMode>);
    });
    const view = snapshot(); view.capabilities.dependencyEditing = true;
    await respond(requests.filter((entry) => entry.url.endsWith("/wb/current-view")).at(-1)!, view);
    await respond(requests.filter((entry) => entry.url.endsWith("/wb/specs/alpha")).at(-1)!, detail("alpha", "Recorded event"));
    await act(async () => { button("Add prerequisite").props.onClick(); });
    const reads = requests.filter((entry) => entry.url.endsWith("/dependencies"));
    expect(reads).toHaveLength(2);
    expect(reads[0]!.signal?.aborted).toBe(true);
    expect(reads[1]!.signal?.aborted).toBe(false);
    await respond(reads[1]!, { specVersion: 1, revision: "0", operations: [] });
    const form = await enterDependency();
    expect(form.findByType("select").props.disabled).toBe(false);
    expect(button("Confirm add prerequisite").props.disabled).toBe(false);
    await respond(reads[0]!, {}, 401);
    expect(renderer!.root.findAllByProps({ type: "password" })).toHaveLength(0);
    expect(button("Confirm add prerequisite").props.disabled).toBe(false);
  });

  it("does not silently upgrade a selected prerequisite version during snapshot polling", async () => {
    await respond(await openDependencies(), { specVersion: 1, revision: "0", operations: [] });
    const form = await enterDependency();
    await act(async () => { vi.advanceTimersByTime(15_000); });
    const updated = snapshot(); updated.capabilities.dependencyEditing = true; updated.specs[1]!.version = 3;
    await respond(requests.filter((entry) => entry.url.endsWith("/wb/current-view")).at(-1)!, updated);
    expect(content(form)).toContain("Prerequisite version: 2");
    expect(content()).toContain("Selected prerequisite version changed");
    expect(button("Confirm add prerequisite").props.disabled).toBe(true);
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
    expect(requests.every((entry) => entry.method === "GET")).toBe(true);
  });

  it("adds only an explicitly submitted Spec prerequisite using exact versions and lossless revision", async () => {
    const view = snapshot();
    view.runs = ["alpha", "beta"].map((taskSlug) => ({ id: `${taskSlug}-run`, taskSlug, packageId: "package", generation: 1, threadRef: "", workspace: "", state: "bound", createdAt: view.generatedAt, updatedAt: view.generatedAt }));
    view.deliveries = ["alpha", "beta"].map((taskSlug) => ({ id: `${taskSlug}-delivery`, runBindingId: `${taskSlug}-run`, submittedBy: "writer", submittedAt: view.generatedAt }));
    view.acceptances = ["alpha", "beta"].map((taskSlug) => ({ id: `${taskSlug}-acceptance`, deliveryId: `${taskSlug}-delivery`, verdict: "accepted", approver: "reviewer", createdAt: view.generatedAt }));
    view.specs.push({ slug: "unversioned", title: "No version", stage: "spark", priority: "P2" });
    view.graph.nodes.push({ slug: "decision", title: "Decision only", label: "Decision", stage: "", priority: "" });
    const read = await openDependencies(view);
    expect(read.project).toBe("one");
    await respond(read, { specVersion: 7, revision: "9007199254740993", operations: [{ id: "actual-op", prerequisite: "beta", actor: "real-operator", reason: "Actual recorded reason", revision: "9007199254740992", changed: true, createdAt: "actual-time" }] });
    const form = await enterDependency();
    const options = form.findAllByType("option");
    expect(options.map((entry) => entry.props.value)).toEqual(["", "beta", "unversioned"]);
    expect(options.find((entry) => entry.props.value === "unversioned")!.props.disabled).toBe(true);
    expect(content(form)).toContain("Prerequisite beta → Current dependent alpha");
    expect(content(form)).toContain("Registered runs for current dependent: 1");
    expect(content(form)).toContain("Recorded acceptance entries: 1");
    expect(requests.every((entry) => entry.method === "GET")).toBe(true);
    expect(content()).toContain("Latest 20 manual dependency operations (not full history)");
    expect(content()).toContain("real-operator"); expect(content()).toContain("Actual recorded reason");
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); form.props.onSubmit({ preventDefault() {} }); });
    const writes = requests.filter((entry) => entry.method === "POST");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.project).toBe("one");
    expect(JSON.parse(String(writes[0]!.body))).toEqual({ prerequisite: "beta", expected_version: 7, expected_prerequisite_version: 2, expected_revision: "9007199254740993", reason: "Required before alpha", idempotency_key: expect.any(String) });
    await respond(writes[0]!, { dependent: "alpha", prerequisite: "beta", revision: "9007199254740994", changed: true, replayed: false });
    expect(content()).toContain("Prerequisite added.");
    expect(requests.filter((entry) => entry.url.endsWith("/wb/current-view"))).toHaveLength(2);
    expect(requests.filter((entry) => entry.url.endsWith("/dependencies") && entry.method === "GET")).toHaveLength(2);
    expect(view.graph.edges).toHaveLength(0);
  });

  it.each([500, 200])("locks uncertain writes and retries the same body after refresh (HTTP %s)", async (status) => {
    const read = await openDependencies();
    await respond(read, { specVersion: 1, revision: "8", operations: [] });
    const form = await enterDependency();
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
    const first = requests.find((entry) => entry.method === "POST")!;
    await respond(first, {}, status);
    expect(content()).toContain("Result unconfirmed");
    expect(form.findByType("select").props.disabled).toBe(true);
    expect(form.findByType("textarea").props.disabled).toBe(true);
    await act(async () => { button("Reload and review").props.onClick(); });
    await respond(requests.filter((entry) => entry.url.endsWith("/dependencies") && entry.method === "GET").at(-1)!, { specVersion: 99, revision: "42", operations: [] });
    expect(form.findByType("textarea").props.disabled).toBe(true);
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
    const writes = requests.filter((entry) => entry.method === "POST");
    expect(writes).toHaveLength(2); expect(writes[1]!.body).toBe(first.body);
    await respond(writes[1]!, { dependent: "alpha", prerequisite: "beta", revision: "9", changed: true, replayed: true });
    expect(content()).toContain("Original operation confirmed; refreshed state determines current dependencies.");
    expect(content()).not.toContain("Outcome unknown");
  });

  it("requires review after conflict rather than automatically retrying with new versions", async () => {
    const read = await openDependencies();
    await respond(read, { specVersion: 1, revision: "8", operations: [] });
    const form = await enterDependency();
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
    await respond(requests.find((entry) => entry.method === "POST")!, {}, 409);
    expect(content()).toContain("Reload and review before submitting again");
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
    expect(requests.filter((entry) => entry.method === "POST")).toHaveLength(1);
    await act(async () => { button("Reload and review").props.onClick(); });
    await respond(requests.filter((entry) => entry.url.endsWith("/dependencies") && entry.method === "GET").at(-1)!, { specVersion: 2, revision: "9", operations: [] });
    expect(requests.filter((entry) => entry.method === "POST")).toHaveLength(1);
    await enterDependency();
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
    expect(JSON.parse(String(requests.filter((entry) => entry.method === "POST")[1]!.body))).toMatchObject({ expected_version: 2, expected_revision: "9" });
  });

  it("logs in only after dependency 401 and reads state without auto-submitting a mutation", async () => {
    await respond(await openDependencies(), {}, 401);
    const form = renderer!.root.findByType("form");
    await act(async () => { form.findByProps({ type: "password" }).props.onChange({ target: { value: "fixture-key" } }); });
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
    const login = requests.find((entry) => entry.url.endsWith("/api/auth/login"))!;
    expect(JSON.parse(String(login.body))).toEqual({ key: "fixture-key" });
    await respond(login, { identity: { subject: "operator" } });
    await respond(requests.filter((entry) => entry.url.endsWith("/dependencies")).at(-1)!, { specVersion: 1, revision: "0", operations: [] });
    expect(requests.filter((entry) => entry.method === "POST")).toHaveLength(1);
    expect(content()).toContain("No manual dependency operations returned.");
  });

  it.each([403, 503, 200])("does not turn dependency HTTP %s or malformed state into anonymous/empty history", async (status) => {
    await respond(await openDependencies(), {}, status);
    expect(renderer!.root.findAllByProps({ type: "password" })).toHaveLength(0);
    expect(content()).toContain(status === 403 ? "Insufficient privilege" : "Dependency state unavailable");
    expect(content()).not.toContain("No manual dependency operations returned.");
    expect(requests.every((entry) => entry.method === "GET")).toBe(true);
  });

  it.each(["close", "node", "project"])("ignores a late dependency receipt after %s switch", async (change) => {
    await respond(await openDependencies(), { specVersion: 1, revision: "0", operations: [] });
    const form = await enterDependency();
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
    const write = requests.find((entry) => entry.method === "POST")!;
    await act(async () => {
      if (change === "close") button("Close dependency editor").props.onClick();
      else if (change === "node") button("Beta task").props.onClick();
      else renderer!.root.findByProps({ "aria-label": "Project" }).props.onChange({ target: { value: "two" } });
    });
    expect(write.signal?.aborted).toBe(true);
    const count = requests.length;
    await respond(write, { dependent: "alpha", prerequisite: "beta", revision: "1", changed: true, replayed: false });
    expect(content()).not.toContain("Prerequisite added.");
    expect(requests).toHaveLength(count);
  });

  it.each([false, true])("gates fixed-delivery test reports and avoids duplicate command evidence when capability is %s", async (enabled) => {
    await act(async () => { renderer = create(<Page search={{ project: "one", tab: "acceptance", selected: "alpha" }} onSearchChange={searchChanged}
      language="en" languageControl={null} renderSessions={() => null} renderTooltip={(_label, trigger) => trigger} requestOperation={fetch}
      renderDeliveryGit={(run) => <p>Git preview: {run.id}</p>} />); });
    const view = snapshot();
    view.capabilities.testReports = enabled;
    view.capabilities.deliveryReview = true;
    view.runs = [{ id: "run", taskSlug: "alpha", packageId: "package", generation: 1, threadRef: "thread", workspace: "C:/repo", state: "bound", workPurpose: "implementation", createdAt: view.generatedAt, updatedAt: view.generatedAt }];
    view.deliveries = [{ id: "delivery", runBindingId: "run", submittedBy: "writer", submittedAt: view.generatedAt }];
    view.acceptances = [{ id: "old-opinion", deliveryId: "delivery", verdict: "accepted", approver: "old-opinion-author", createdAt: view.generatedAt }];
    view.evidence = [{ id: "report", deliveryId: "delivery", kind: "test_report", command: "report-only-command", exitCode: null, verifier: "human", createdAt: view.generatedAt }, { id: "command", deliveryId: "delivery", kind: "command", command: "legacy-command", exitCode: 0, verifier: "runner", createdAt: view.generatedAt }];
    await respond(requests[0]!, view);
    await act(async () => button("Inspect delivery evidence: delivery").props.onClick());
    expect(renderer!.root.findAllByProps({ "aria-label": "Test reports" })).toHaveLength(enabled ? 1 : 0);
    expect(renderer!.root.findAllByProps({ "aria-label": "Delivery review" })).toHaveLength(enabled ? 0 : 1);
    expect(content()).toContain("legacy-command");
    expect(content()).toContain("old-opinion-author");
    if (enabled) {
      expect(content()).not.toContain("report-only-command");
      await respond(requests.find((entry) => entry.url.endsWith("/deliveries/delivery"))!, { id: "delivery", runBindingId: "run", snapshot: { git: { head: { isRepo: true, commitSha: "fixed-delivery-commit" } } } });
      await respond(requests.find((entry) => entry.url.endsWith("/runs/run/context"))!, { runId: "run", body: { dispatch_target: { workPurpose: "implementation", qaBasis: { testPlanSources: [{ kind: "specgraph", specSlug: "plan", field: "specify", changeId: "plan-change" }] } } } });
      await respond(requests.find((entry) => entry.url.endsWith("/deliveries/delivery/tests"))!, { deliveryId: "delivery", reports: [], hasMore: false, nextCursor: null });
      expect(content()).toContain("fixed-delivery-commit");
      expect(content()).toContain("Git preview: run");
      expect(content()).toContain("Manual delivery opinions (not test results)");
      expect(content()).toContain("No test reports");
    } else {
      expect(content()).toContain("report-only-command");
      expect(requests.some((entry) => entry.url.endsWith("/tests"))).toBe(false);
    }
    expect(requests.every((entry) => entry.method === "GET")).toBe(true);
  });

  it.each(["requirements", undefined])("preserves legacy delivery review for purpose %s when test reports are available", async (workPurpose) => {
    await act(async () => { renderer = create(<Page search={{ project: "one", tab: "acceptance", selected: "alpha" }} onSearchChange={searchChanged}
      language="en" languageControl={null} renderSessions={() => null} renderTooltip={(_label, trigger) => trigger} requestOperation={fetch} />); });
    const view = snapshot();
    view.capabilities.testReports = true; view.capabilities.deliveryReview = true;
    view.runs = [{ id: "run", taskSlug: "alpha", packageId: "package", generation: 1, threadRef: "thread", workspace: "C:/repo", state: "bound", ...(workPurpose ? { workPurpose } : {}), createdAt: view.generatedAt, updatedAt: view.generatedAt }];
    view.deliveries = [{ id: "delivery", runBindingId: "run", submittedBy: "writer", submittedAt: view.generatedAt }];
    await respond(requests[0]!, view);
    await act(async () => button("Inspect delivery evidence: delivery").props.onClick());
    expect(renderer!.root.findAllByProps({ "aria-label": "Delivery review" })).toHaveLength(1);
    expect(content()).toContain("Decision history");
    expect(content()).not.toContain("Manual delivery opinions (not test results)");
  });

  it("lists only exhausted loops and navigates the original run without per-run reads", async () => {
    await mount({ project: "one", tab: "pending" });
    const view = snapshot();
    view.runs = ["needs_human", "stopped", "waiting"].map((status, index) => ({ id: `loop-${status}`, taskSlug: "alpha", packageId: "package", generation: 1, threadRef: "", workspace: "", state: "bound", createdAt: "now", updatedAt: "now",
      programLoop: { kind: "innovative", maxAttempts: 3, status, attemptId: `attempt-${index}`, attemptOrdinal: status === "waiting" ? 1 : 3, authorizedByUserId: "original-human" } }));
    await respond(requests[0]!, view);
    const holds = renderer!.root.findByProps({ "aria-label": "Program loops needing human judgment" });
    expect(content(holds)).toContain("Program loops needing human judgment · 1");
    expect(content(holds)).toContain("Attempts exhausted; human judgment required");
    expect(content(holds)).toContain("Admitted attempts: 3 / 3");
    expect(content(holds)).toContain("Original authorizer: original-human");
    expect(content(holds)).not.toContain("loop-stopped"); expect(content(holds)).not.toContain("loop-waiting");
    expect(requests.some((entry) => entry.url.includes("/loop/program-runs/") || entry.url.includes("/context"))).toBe(false);
    await act(async () => holds.findByType("button").props.onClick());
    expect(searchChanged).toHaveBeenLastCalledWith({ project: "one", selected: "alpha", tab: "sessions", runId: "loop-needs_human" });
    expect(content()).toContain("Host session: loop-needs_human");
    expect(content()).not.toContain("Host session: loop-stopped");
  });

  it("lists exhausted candidate loops and opens only the exact original run", async () => {
    await mount({ project: "one", tab: "pending" });
    const view = snapshot();
    view.runs = ["candidate-old", "candidate-exhausted"].map((id) => ({ id, taskSlug: "alpha", packageId: "package", generation: 1, threadRef: "", workspace: "", state: "bound", createdAt: "now", updatedAt: "now",
      candidateLoop: { status: id === "candidate-exhausted" ? "needs_human" : "waiting", maxAttempts: 3, attemptId: "attempt-3", attemptOrdinal: 3, deliveryId: "delivery-3", configuredBy: "original-human" } }));
    await respond(requests[0]!, view);
    const holds = renderer!.root.findByProps({ "aria-label": "Candidate loops needing human action" });
    expect(content(holds)).toContain("Candidate loops needing human action · 1");
    expect(content(holds)).toContain("Admitted candidates: 3 / 3");
    expect(content(holds)).not.toContain("candidate-old");
    expect(requests).toHaveLength(1);
    await act(async () => holds.findByType("button").props.onClick());
    expect(searchChanged).toHaveBeenLastCalledWith({ project: "one", selected: "alpha", tab: "sessions", runId: "candidate-exhausted" });
    expect(content()).toContain("Host session: candidate-exhausted");
    expect(content()).not.toContain("Host session: candidate-old");
    await act(async () => button("Show all runs for node").props.onClick());
    expect(searchChanged).toHaveBeenLastCalledWith({ project: "one", selected: "alpha", tab: "sessions" });
    expect(content()).toContain("Host session: candidate-old");
  });

  it("does not substitute a sibling when the exact run is missing or belongs to another task", async () => {
    await mount({ project: "one", tab: "sessions", selected: "alpha", runId: "missing" });
    const view = snapshot();
    view.runs = [{ id: "sibling", taskSlug: "alpha", packageId: "package", generation: 1, threadRef: "", workspace: "", state: "bound", createdAt: "now", updatedAt: "now" }];
    await respond(requests[0]!, view);
    expect(content()).toContain("Original run is unavailable in this task");
    expect(content()).not.toContain("Host session: sibling");
  });

  it("shows separate source review holds and selects the node without opening a delivery or writing", async () => {
    await mount({ project: "one", tab: "pending" });
    const view = snapshot();
    view.capabilities.independentReview = true;
    view.runs = [{ id: "run", taskSlug: "alpha", packageId: "package", generation: 1, threadRef: "thread", workspace: "", state: "bound", createdAt: view.generatedAt, updatedAt: view.generatedAt }];
    view.reviewStates = [{ taskSlug: "alpha", reviews: (["requirements", "design"] as const).map((kind) => ({ kind, agentRejections: 3, maxReviewRounds: 3, humanHold: true, responsibleUserId: "human-owner", request: { id: `${kind}-request`, taskSlug: "alpha", kind, sources: [{ kind: "specgraph", specSlug: "alpha", field: "intent", changeId: "change" }], authorResponsibility: { kind: "agent", runId: "run" }, completionRunId: null, requirementDecisionIds: [], decisions: [], reviewerRunId: "reviewer", responsibleUserId: "human-owner", maxReviewRounds: 3, createdBy: "human-owner", createdAt: view.generatedAt, decidedAt: view.generatedAt } })) }];
    await respond(requests[0]!, view);
    const holds = renderer!.root.findByProps({ "aria-label": "Human review holds" });
    expect(content(holds)).toContain("Requirements review");
    expect(content(holds)).toContain("Design review");
    expect(content(holds)).toContain("requirements-request");
    expect(content(holds)).toContain("design-request");
    expect(content(holds)).toContain("Responsible human: human-owner");
    await act(async () => holds.findAllByType("button")[0]!.props.onClick());
    expect(searchChanged).toHaveBeenLastCalledWith({ project: "one", tab: "pending", layout: "graph", selected: "alpha" });
    expect(requests.every((entry) => entry.method === "GET")).toBe(true);
    expect(view.reviewStates[0]!.reviews.every((review) => review.humanHold)).toBe(true);
  });

  it("separates implementation completion from legacy opinions using explicit run and node states", async () => {
    await mount({ project: "one" });
    const view = snapshot();
    view.capabilities.testReports = true;
    view.specs = [
      { slug: "alpha", title: "Alpha task", stage: "review", priority: "P1" },
      { slug: "done", title: "Done task", stage: "done", priority: "P1" },
      { slug: "abandoned", title: "Abandoned task", stage: "abandoned", priority: "P1" },
      { slug: "superseded", title: "Superseded task", stage: "superseded", priority: "P1" },
    ];
    view.runs = [
      { id: "code-run", taskSlug: "alpha", state: "bound", workPurpose: "implementation" },
      { id: "code-peer", taskSlug: "alpha", state: "bound", workPurpose: "implementation" },
      { id: "completed-run", taskSlug: "alpha", state: "completed", workPurpose: "implementation" },
      { id: "cancelled-run", taskSlug: "alpha", state: "preparation_cancelled", workPurpose: "implementation" },
      { id: "handed-off-run", taskSlug: "alpha", state: "handed_off", workPurpose: "implementation" },
      { id: "done-run", taskSlug: "done", state: "bound", workPurpose: "implementation" },
      { id: "abandoned-run", taskSlug: "abandoned", state: "bound", workPurpose: "implementation" },
      { id: "superseded-run", taskSlug: "superseded", state: "bound", workPurpose: "implementation" },
      { id: "no-delivery", taskSlug: "alpha", state: "bound", workPurpose: "implementation" },
      { id: "legacy-unknown", taskSlug: "alpha", state: "bound" },
      { id: "legacy-design", taskSlug: "alpha", state: "bound", workPurpose: "design" },
    ].map((run) => ({ packageId: "package", generation: 1, threadRef: "thread", workspace: "C:/repo", createdAt: view.generatedAt, updatedAt: view.generatedAt, ...run }));
    view.deliveries = [
      { id: "z-earlier", runBindingId: "code-run", submittedBy: "writer", submittedAt: "2026-09-20T01:00:00.000001Z" },
      ...view.runs.filter((run) => run.id !== "code-run" && run.id !== "no-delivery").map((run) => ({ id: `${run.id}-delivery`, runBindingId: run.id, submittedBy: "writer", submittedAt: "2026-09-20T01:00:00.000001Z" })),
      { id: "a-latest", runBindingId: "code-run", submittedBy: "writer", submittedAt: "2026-09-20T01:00:00.000002Z" },
    ];
    view.acceptances = [{ id: "opinion", deliveryId: "a-latest", verdict: "accepted", approver: "human", createdAt: view.generatedAt }];
    await respond(requests[0]!, view);
    const codeCount = renderer!.root.findAllByType("dt").find((entry) => content(entry) === "Code testing and completion")!;
    const opinionCount = renderer!.root.findAllByType("dt").find((entry) => content(entry) === "Delivery opinions pending")!;
    expect(content(codeCount.parent!.findByType("dd"))).toBe("2");
    expect(content(opinionCount.parent!.findByType("dd"))).toBe("2");
    await act(async () => button("Pending").props.onClick());
    const queue = renderer!.root.findByProps({ "aria-label": "Code testing and completion" });
    expect(content(queue)).toContain("a-latest");
    expect(content(queue)).toContain("code-peer-delivery");
    expect(content(queue)).not.toContain("z-earlier");
    for (const id of ["completed-run", "cancelled-run", "handed-off-run", "done-run", "abandoned-run", "superseded-run", "no-delivery"]) expect(content(queue)).not.toContain(id);
    expect(content(queue)).not.toMatch(/\b(Passed|Failed)\b/);
    expect(button("Review pending delivery: legacy-unknown-delivery")).toBeDefined();
    expect(button("Review pending delivery: legacy-design-delivery")).toBeDefined();
    expect(button("Review pending delivery: completed-run-delivery")).toBeUndefined();
    expect(button("Review pending delivery: a-latest")).toBeUndefined();
    expect(requests.some((entry) => entry.url.includes("/tests"))).toBe(false);
    await act(async () => button("Open implementation delivery: a-latest").props.onClick());
    expect(searchChanged).toHaveBeenLastCalledWith(expect.objectContaining({ project: "one", tab: "acceptance", selected: "alpha" }));
    expect(content(renderer!.root.findByProps({ "aria-label": "Selected delivery evidence" }))).toContain("a-latest");
    expect(requests.every((entry) => entry.method === "GET")).toBe(true);
  });

  it("opens the exact delivery from pending decisions and failed evidence without writes", async () => {
    await mount({ project: "one", tab: "pending", selected: "alpha" });
    const view = snapshot();
    view.runs = [{ id: "run", taskSlug: "alpha", packageId: "package", generation: 1, threadRef: "", workspace: "", state: "bound", createdAt: view.generatedAt, updatedAt: view.generatedAt }];
    view.deliveries = ["waiting", "failed"].map((id) => ({ id, runBindingId: "run", submittedBy: "writer", submittedAt: view.generatedAt }));
    view.evidence = [{ id: "failure", deliveryId: "failed", kind: "command", command: "actual-failed-command", exitCode: 1, verifier: "runner", createdAt: view.generatedAt }];
    await respond(requests[0]!, view);
    await act(async () => { button("Review pending delivery: waiting").props.onClick(); });
    expect(searchChanged).toHaveBeenLastCalledWith({ project: "one", tab: "acceptance", selected: "alpha" });
    expect(content(renderer!.root.findByProps({ "aria-label": "Selected delivery evidence" }))).toContain("waiting");
    await act(async () => { button("Pending").props.onClick(); });
    await act(async () => { button("Inspect failed evidence: failure").props.onClick(); });
    const evidence = renderer!.root.findByProps({ "aria-label": "Selected delivery evidence" });
    expect(content(evidence)).toContain("actual-failed-command");
    expect(content(evidence)).not.toContain("waiting");
    expect(requests.every((entry) => entry.method === "GET")).toBe(true);
  });

  it("navigates nested composition maps through breadcrumbs without submitting graph changes", async () => {
    await mount({ project: "one", selected: "alpha", tab: "tasks", layout: "graph" });
    const view = snapshot();
    view.specs.push({ slug: "gamma", title: "Gamma task", stage: "spark", priority: "P2" });
    view.graph.nodes = view.specs.map((spec) => ({ ...spec, label: "Spec" }));
    view.graph.edges = [
      { from: "alpha", to: "beta", type: "COMPOSES" },
      { from: "beta", to: "gamma", type: "COMPOSES" },
    ];
    await respond(requests[0]!, view);
    await act(async () => { button("Open submap (1)").props.onClick(); });
    let trail = renderer!.root.findByProps({ "aria-label": "Submap path" });
    expect(content(trail)).toContain("Alpha task");
    await act(async () => { button("Beta task").props.onClick(); });
    await act(async () => { button("Open submap (1)").props.onClick(); });
    trail = renderer!.root.findByProps({ "aria-label": "Submap path" });
    expect(content(trail)).toContain("Alpha task");
    expect(content(trail)).toContain("Beta task");
    await act(async () => { button("Project graph").props.onClick(); });
    expect(content(renderer!.root.findByProps({ "aria-label": "Submap path" }))).toBe("Project graph");
    expect(requests.every((entry) => entry.method === "GET")).toBe(true);
  });

  it("does not treat an identity service error as an anonymous session and can retry", async () => {
    await mount(); await respond(requests[0]!, snapshot());
    await act(async () => { button("New requirement node").props.onClick(); });
    await respond(requests.find((entry) => entry.url.endsWith("whoami"))!, {}, 503);
    const form = renderer!.root.findByType("form");
    expect(content(form)).toContain("Unable to verify identity");
    expect(form.findAllByProps({ type: "password" })).toHaveLength(0);
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
    expect(requests.some((entry) => entry.method === "POST")).toBe(false);
    await act(async () => { button("Retry identity check").props.onClick(); });
    const checks = requests.filter((entry) => entry.url.endsWith("whoami"));
    expect(checks).toHaveLength(2);
    await respond(checks[1]!, { identity: { subject: "operator" } });
    expect(content(form)).not.toContain("Unable to verify identity");
    expect(button("Create draft").props.disabled).toBe(false);
  });

  it("creates a draft through the existing scoped SpecService and refreshes instead of inventing a local node", async () => {
    await mount(); await respond(requests[0]!, snapshot());
    await act(async () => { button("New requirement node").props.onClick(); });
    await respond(requests.find((entry) => entry.url.endsWith("whoami"))!, {}, 401);
    const form = renderer!.root.findByType("form");
    await act(async () => {
      form.findAllByType("input").find((entry) => entry.props.type !== "password")!.props.onChange({ target: { value: "new-node" } });
      form.findByProps({ type: "password" }).props.onChange({ target: { value: "fixture-operator-key" } });
      form.findByType("textarea").props.onChange({ target: { value: "New requirement" } });
    });
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
    expect(requests.some((entry) => entry.url.endsWith("/CreateSpec"))).toBe(false);
    const login = requests.find((entry) => entry.url.endsWith("/login"))!;
    expect(JSON.parse(String(login.body))).toEqual({ key: "fixture-operator-key" });
    await respond(login, { identity: { subject: "operator" } });
    const createRequest = requests.find((entry) => entry.url.endsWith("/CreateSpec"))!;
    expect(createRequest.method).toBe("POST"); expect(createRequest.project).toBe("one");
    expect(JSON.parse(String(createRequest.body))).toEqual({ slug: "new-node", intent: "New requirement", priority: "p2", complexity: "medium" });
    await respond(createRequest, { spec: { slug: "new-node", stage: "spark" } });
    expect(searchChanged).toHaveBeenLastCalledWith({ project: "one", selected: "new-node", tab: "tasks", layout: "graph" });
    expect(renderer!.root.findAllByType("form")).toHaveLength(0);
    expect(requests.filter((entry) => entry.url.endsWith("/wb/current-view"))).toHaveLength(2);
  });

  it.each([409, 500])("does not claim a created node on HTTP %s", async (status) => {
    await mount(); await respond(requests[0]!, snapshot());
    await act(async () => { button("New requirement node").props.onClick(); });
    await respond(requests.find((entry) => entry.url.endsWith("whoami"))!, { identity: { subject: "operator" } });
    const form = renderer!.root.findByType("form");
    await act(async () => {
      form.findByType("input").props.onChange({ target: { value: "new-node" } });
      form.findByType("textarea").props.onChange({ target: { value: "New requirement" } });
    });
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
    await respond(requests.find((entry) => entry.url.endsWith("/CreateSpec"))!, {}, status);
    expect(searchChanged).not.toHaveBeenCalled();
    expect(content()).toContain(status === 409 ? "Identifier already exists" : "Creation result unconfirmed");
    if (status === 500) {
      await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
      expect(requests.filter((entry) => entry.url.endsWith("/CreateSpec"))).toHaveLength(1);
    }
  });

  it("does not navigate back to an old project after a late creation response", async () => {
    await mount(); await respond(requests[0]!, snapshot());
    await act(async () => { button("New requirement node").props.onClick(); });
    await respond(requests.find((entry) => entry.url.endsWith("whoami"))!, { identity: { subject: "operator" } });
    const form = renderer!.root.findByType("form");
    await act(async () => {
      form.findByType("input").props.onChange({ target: { value: "new-node" } });
      form.findByType("textarea").props.onChange({ target: { value: "New requirement" } });
    });
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
    const pending = requests.find((entry) => entry.url.endsWith("/CreateSpec"))!;
    await act(async () => { renderer!.root.findByProps({ "aria-label": "Project" }).props.onChange({ target: { value: "two" } }); });
    expect(pending.signal?.aborted).toBe(true);
    await respond(pending, { spec: { slug: "new-node", stage: "spark" } });
    expect(searchChanged).toHaveBeenLastCalledWith({ project: "two", tab: "overview", layout: "graph" });
  });

  it("separates other graph relations and keeps the layer control available after a layer error", async () => {
    await mount();
    const view = snapshot();
    view.graph.edges = [{ from: "missing-a", to: "missing-b", type: "RELATES_TO" }];
    await respond(requests[0]!, view);
    expect(content()).toContain("No graph nodes returned by the backend.");
    expect(content()).not.toContain("Missing graph endpoint");
    const layer = renderer!.root.findAllByType("label").find((node) => content(node).includes("Show other relationships"))!.findByProps({ type: "checkbox" });
    expect(layer.props.checked).toBe(false);
    await act(async () => { layer.props.onChange({ target: { checked: true } }); });
    expect(content()).toContain("Missing graph endpoint");
    expect(layer.props.checked).toBe(true);
    await act(async () => { layer.props.onChange({ target: { checked: false } }); });
    expect(content()).not.toContain("Missing graph endpoint");
    expect(content()).toContain("No graph nodes returned by the backend.");
    expect(view.graph.edges).toHaveLength(1);
  });

  it("does not hide invalid hard dependencies when other relations are disabled", async () => {
    await mount();
    const view = snapshot();
    view.graph.edges = [{ from: "missing-a", to: "missing-b", type: "DEPENDS_ON" }];
    await respond(requests[0]!, view);
    expect(renderer!.root.findAllByType("label").find((node) => content(node).includes("Show other relationships"))!.findByProps({ type: "checkbox" }).props.checked).toBe(false);
    expect(content()).toContain("Missing graph endpoint");
  });

  it("requires mail login and keeps a denied supervision request distinct from an empty mailbox", async () => {
    await mount({ project: "one", tab: "collaboration" });
    const view = snapshot(); view.capabilities.mailInspection = true;
    await respond(requests[0]!, view);
    await respond(requests.find((entry) => entry.url.endsWith("whoami"))!, {}, 401);
    expect(requests.some((entry) => entry.url.includes("/loop/mail/"))).toBe(false);
    await act(async () => { renderer!.root.findByProps({ type: "password" }).props.onChange({ target: { value: "test-key" } }); });
    await act(async () => { renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    const login = requests.find((entry) => entry.url.endsWith("/login"))!;
    expect(login.method).toBe("POST");
    expect(JSON.parse(String(login.body))).toEqual({ key: "test-key" });
    await respond(login, { identity: { subject: "reader" } });
    await respond(requests.find((entry) => entry.url.includes("/threads?"))!, {}, 403);
    expect(content()).toContain("This account cannot inspect project mail.");
    expect(content()).not.toContain("No threads match this filter.");
  });

  it("shows source-linked collaboration and separate recipient receipts without acknowledging for agents", async () => {
    await mount({ project: "one", tab: "collaboration" });
    const view = snapshot(); view.capabilities.mailInspection = true;
    await respond(requests[0]!, view);
    await respond(requests.find((entry) => entry.url.endsWith("whoami"))!, { identity: { subject: "operator", display_name: "Operator" } });
    const summary = { id: "mail-one", task_slug: "alpha", subject: "Shared question", opened_by_run: "run-a", owner_run: "run-a", created_at: "now", closed_at: null,
      closure_note: null, message_count: 1, pending_ack_count: 1, last_message_at: "now" };
    await respond(requests.find((entry) => entry.url.includes("/loop/mail/threads?"))!, { threads: [summary], next_cursor: "" });
    await act(async () => { renderer!.root.findByProps({ className: "wb-mail-thread" }).props.onClick(); });
    await respond(requests.find((entry) => entry.url.includes("/threads/mail-one?"))!, {
      thread: summary, next_cursor: "", items: [{ message: { id: "message", sender_run: "run-a", handoff_to_run: null, body: "Please review", created_at: "now",
        references: [{ message_id: "source", kind: "reply", thread_id: "old-thread", task_slug: "beta", sender_run_id: "run-b", subject: "Original question", body: "Original source text", created_at: "earlier" }] },
        receipts: [{ recipient_run_id: "run-c", read_at: "read-time", acknowledged_at: null }, { recipient_run_id: "run-d", read_at: null, acknowledged_at: "ack-time" }] }],
    });
    expect(content()).toContain("Original source text");
    expect(content()).toContain("Read: read-time");
    expect(content()).toContain("Pending acknowledgment");
    expect(content()).toContain("No read receipt");
    expect(content()).toContain("Acknowledged: ack-time");
    expect(requests.every((entry) => entry.method === "GET")).toBe(true);
    expect(requests.filter((entry) => entry.url.includes("/loop/mail/")).every((entry) => entry.project === "one")).toBe(true);
    await act(async () => { button("beta").props.onClick(); });
    expect(searchChanged).toHaveBeenLastCalledWith({ project: "one", tab: "tasks", selected: "beta" });
  });

  it("does not let a late aborted mail response replace a selected thread or sign out the operator", async () => {
    await mount({ project: "one", tab: "collaboration" });
    const view = snapshot(); view.capabilities.mailInspection = true;
    await respond(requests[0]!, view);
    await respond(requests.find((entry) => entry.url.endsWith("whoami"))!, { identity: { subject: "operator" } });
    const thread = (id: string) => ({ id, task_slug: "alpha", subject: id, opened_by_run: "run-a", owner_run: "run-a", created_at: "now", closed_at: null, message_count: 0, pending_ack_count: 0 });
    await respond(requests.find((entry) => entry.url.includes("/threads?"))!, { threads: [thread("old"), thread("new")], next_cursor: "" });
    await act(async () => { renderer!.root.findAllByProps({ className: "wb-mail-thread" })[0]!.props.onClick(); });
    const old = requests.find((entry) => entry.url.includes("/threads/old?"))!;
    await act(async () => { renderer!.root.findAllByProps({ className: "wb-mail-thread" })[1]!.props.onClick(); });
    expect(old.signal?.aborted).toBe(true);
    await respond(requests.find((entry) => entry.url.includes("/threads/new?"))!, { thread: thread("new"), items: [], next_cursor: "" });
    await respond(old, {}, 401);
    expect(renderer!.root.findAllByProps({ type: "password" })).toHaveLength(0);
    expect(content(renderer!.root.findByProps({ "aria-label": "Mail details" }))).toContain("new");
  });

  it("requires operator authentication and retries an uncertain manual completion with the same command", async () => {
    await mount({ project: "one", selected: "alpha" });
    await respond(requests[0]!, snapshot());
    await respond(requests[1]!, detail("alpha", "Recorded event"));
    await act(async () => { button("Complete manually").props.onClick(); });
    await respond(requests[2]!, {}, 401);
    expect(requests.some((entry) => entry.url.includes("manual-complete"))).toBe(false);
    await act(async () => {
      renderer!.root.findByProps({ type: "password" }).props.onChange({ target: { value: "test-operator-key" } });
    });
    await act(async () => { renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    expect(JSON.parse(String(requests[3]!.body))).toEqual({ key: "test-operator-key" });
    await respond(requests[3]!, { identity: { subject: "human", display_name: "Operator", role: "admin" } });
    expect(content()).toContain("not technical verification");
    await act(async () => { renderer!.root.findByType("textarea").props.onChange({ target: { value: "Checked manually" } }); });
    await act(async () => { renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    const first = requests[4]!;
    expect(first.url).toBe("/workbench-api/loop/specs/alpha/manual-complete");
    expect(first.project).toBe("one");
    expect(JSON.parse(String(first.body))).toMatchObject({ expected_version: 1, note: "Checked manually" });
    await respond(first, {}, 500);
    expect(content()).toContain("Result unconfirmed");
    expect(renderer!.root.findByType("textarea").props.disabled).toBe(true);
    await act(async () => { renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    expect(requests[5]!.body).toBe(first.body);
    await respond(requests[5]!, { completed: "alpha", version: 2, replayed: true });
    expect(content()).toContain("Manual completion recorded.");
    expect(requests[6]!.url).toBe("/workbench-api/wb/current-view");
  });

  it("does not turn a completion conflict into local success", async () => {
    await mount({ project: "one", selected: "alpha" });
    await respond(requests[0]!, snapshot());
    await respond(requests[1]!, detail("alpha", "Recorded event"));
    await act(async () => { button("Complete manually").props.onClick(); });
    await respond(requests[2]!, { identity: { subject: "human", display_name: "Operator", role: "admin" } });
    await act(async () => { renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    await respond(requests[3]!, {}, 409);
    expect(content()).toContain("Node changed or is still claimed");
    expect(content()).not.toContain("Manual completion recorded.");
    expect(requests).toHaveLength(4);
  });

  it("keeps the project graph mounted while switching the auxiliary board and table", async () => {
    await mount({ project: "one", selected: "alpha" });
    await respond(requests[0]!, snapshot());
    await respond(requests[1]!, detail("alpha", "Recorded event"));
    const graphRegion = renderer!.root.findByProps({ className: "wb-overview-graph" });
    expect(content(graphRegion)).toContain("No graph nodes returned by the backend.");
    const auxiliary = renderer!.root.findByProps({ "aria-label": "Auxiliary tasks" });
    expect(auxiliary.findAllByProps({ className: "wb-board" })).toHaveLength(1);
    expect(content(auxiliary)).toContain("Alpha task");
    await act(async () => { button("Table").props.onClick(); });
    expect(renderer!.root.findByProps({ className: "wb-overview-graph" })).toBe(graphRegion);
    expect(auxiliary.findAllByType("table")).toHaveLength(1);
    expect(searchChanged).toHaveBeenLastCalledWith({ project: "one", tab: "overview", layout: "table", selected: "alpha" });
    expect(content(renderer!.root.findByType("aside"))).toContain("alpha intent");
    await act(async () => { button("Board").props.onClick(); });
    expect(renderer!.root.findByProps({ className: "wb-overview-graph" })).toBe(graphRegion);
    expect(auxiliary.findAllByProps({ className: "wb-board" })).toHaveLength(1);
  });

  it("uses backend claimability rather than inferring it from a task's authored stage", async () => {
    await mount();
    await respond(requests[0]!, snapshot());
    expect(content()).toContain("Claimable specsNot available");
    expect(button("Claimable specs").props.disabled).toBe(true);
    await act(async () => {
      button("Refresh").props.onClick();
    });
    await respond(requests[1]!, { ...snapshot(), readySpecSlugs: ["beta"] });
    await act(async () => {
      button("Claimable specs").props.onClick();
    });
    const directory = renderer!.root.findByProps({ "aria-label": "Task directory" });
    expect(content(directory)).toContain("Beta task");
    expect(content(directory)).not.toContain("Alpha task");
    await act(async () => {
      button("Refresh").props.onClick();
    });
    await respond(requests[2]!, { ...snapshot(), readySpecSlugs: [] });
    expect(content()).toContain("Claimable specs0");
    expect(content(directory)).toContain("No matching specs");
    expect(content(directory)).not.toMatch(/accepted|verified|failed/i);
  });

  it("filters direct prerequisite and dependent tasks without treating other relations as dependencies", async () => {
    await mount({ project: "one", tab: "tasks", layout: "board" });
    const view = snapshot();
    view.specs.push(
      { slug: "gamma", title: "Gamma task", stage: "approved", priority: "P1" },
      { slug: "delta", title: "Delta task", stage: "approved", priority: "P1" },
    );
    view.graph.nodes = view.specs.map((spec) => ({ ...spec, label: "Spec" }));
    view.graph.edges = [
      { from: "alpha", to: "beta", type: "DEPENDS_ON" },
      { from: "alpha", to: "gamma", type: "BLOCKS" },
      { from: "alpha", to: "delta", type: "RELATES_TO" },
    ];
    await respond(requests[0]!, view);
    await act(async () => {
      button("Alpha task").props.onClick();
    });
    await act(async () => {
      button("Related").props.onClick();
    });
    const directory = renderer!.root.findByProps({ "aria-label": "Task directory" });
    expect(content(directory)).toContain("Alpha task");
    expect(content(directory)).toContain("Beta task");
    expect(content(directory)).toContain("Gamma task");
    expect(content(directory)).not.toContain("Delta task");
    expect(searchChanged).toHaveBeenLastCalledWith({
      project: "one",
      tab: "tasks",
      layout: "board",
      selected: "alpha",
    });
    await act(async () => {
      button("Clear task filter").props.onClick();
    });
    expect(button("All").props["aria-pressed"]).toBe(true);
    expect(content(directory)).toContain("Delta task");
  });

  it("does not carry task filters, search text, or old readiness into another project", async () => {
    await mount();
    await respond(requests[0]!, { ...snapshot(), readySpecSlugs: ["alpha"] });
    await act(async () => {
      button("Claimable specs").props.onClick();
      renderer!.root
        .findByProps({ "aria-label": "Search tasks" })
        .props.onChange({ target: { value: "Alpha" } });
    });
    await act(async () => {
      renderer!.root.findByType("select").props.onChange({ target: { value: "two" } });
    });
    await respond(requests[1]!, snapshot("two", "New project task"));
    expect(button("All").props["aria-pressed"]).toBe(true);
    expect(button("Claimable specs").props.disabled).toBe(true);
    expect(renderer!.root.findByProps({ "aria-label": "Search tasks" }).props.value).toBe("");
    expect(content()).toContain("New project task");
    expect(content()).toContain("Claimable specsNot available");
  });

  it("opens native-session content and evidence for the exact delivery without treating missing results as success", async () => {
    await mount({ project: "one", selected: "alpha", layout: "board" });
    const view = snapshot();
    view.runs = ["alpha", "beta"].map((taskSlug) => ({
      id: `${taskSlug}-run`,
      taskSlug,
      packageId: "package",
      generation: 1,
      threadRef: `${taskSlug}-thread`,
      workspace: "workspace",
      state: "bound",
      createdAt: view.generatedAt,
      updatedAt: view.generatedAt,
    }));
    view.deliveries = ["d1", "d2"].map((id) => ({
      id,
      runBindingId: "alpha-run",
      submittedBy: "agent",
      submittedAt: view.generatedAt,
    }));
    view.acceptances = [
      { id: "a1", deliveryId: "d1", verdict: "rejected", approver: "first-reviewer", createdAt: view.generatedAt },
      { id: "a2", deliveryId: "d1", verdict: "accepted", approver: "second-reviewer", createdAt: view.generatedAt,
        requirementsFingerprint: "caller-recorded-basis", conditions: { review: "Check accessibility" } },
    ];
    view.evidence = [
      {
        id: "e1",
        deliveryId: "d1",
        kind: "command",
        command: "first-command",
        exitCode: 0,
        verifier: "runner",
        createdAt: view.generatedAt,
      },
      {
        id: "e2",
        deliveryId: "d2",
        kind: "command",
        command: "second-command",
        exitCode: null,
        verifier: "runner",
        createdAt: view.generatedAt,
      },
    ];
    await respond(requests[0]!, view);
    await respond(requests[1]!, detail("alpha", "Recorded event"));
    expect(content(renderer!.root.findByType("aside"))).toContain("Host session: alpha-run");
    expect(content(renderer!.root.findByType("aside"))).not.toContain("Host session: beta-run");
    await act(async () => {
      button("Inspect delivery evidence: d2").props.onClick();
    });
    let evidence = renderer!.root.findByProps({ "aria-label": "Selected delivery evidence" });
    expect(content(evidence)).toContain("second-command");
    expect(content(evidence)).toContain("Unknown result (no exit code)");
    expect(content(evidence)).not.toContain("first-command");
    expect(content(evidence)).not.toMatch(/accepted|verified|succeeded/i);
    await act(async () => {
      button("Inspect delivery evidence: d1").props.onClick();
    });
    evidence = renderer!.root.findByProps({ "aria-label": "Selected delivery evidence" });
    expect(content(evidence)).toContain("first-command");
    expect(content(evidence)).toContain("This command succeeded only");
    expect(content(evidence)).not.toContain("second-command");
    const history = evidence.findByProps({ "aria-label": "Delivery decision history" });
    expect(content(history)).toContain("Recorded acceptance");
    expect(content(history)).toContain("Recorded rejection");
    expect(content(history)).toContain("applicability unverified");
    expect(content(history)).toContain("caller-recorded-basis");
    expect(content(history)).toContain("Check accessibility");
    expect(content(history)).toContain("Not provided by backend");
    expect(content(history).indexOf("second-reviewer")).toBeLessThan(content(history).indexOf("first-reviewer"));
    await act(async () => {
      button("Beta task").props.onClick();
    });
    await respond(requests[2]!, detail("beta", "Beta event"));
    expect(
      renderer!.root.findAllByProps({ "aria-label": "Selected delivery evidence" }),
    ).toHaveLength(0);
    expect(content(renderer!.root.findByType("aside"))).not.toContain("first-command");
  });

  it("renders the selected task's recorded contract before metadata without claiming verification", async () => {
    await mount({ project: "one", selected: "alpha" });
    await respond(requests[0]!, snapshot());
    const response = detail("alpha", "Recorded event");
    const longPath = `src/${"long-segment-".repeat(30)}module.ts`;
    await respond(requests[1]!, {
      ...response,
      spec: {
        ...response.spec,
        shape: { scope_in: ["Read real graph records"], scope_out: ["No orchestration changes"] },
        specify: {
          verify_criteria: [
            {
              category: "behavior",
              description: "Selection opens the matching task\nNo invented task records",
            },
          ],
          invariants: ["Preserve dependency direction"],
          interfaces: [
            { name: "Current view", body: "GET /wb/current-view\nReturns the recorded graph" },
          ],
          touches: [{ path: longPath, purpose: "Render task contracts", change_type: "modify" }],
        },
      },
    });
    const aside = renderer!.root.findByType("aside");
    const rendered = content(aside);
    for (const value of [
      "In scope",
      "Read real graph records",
      "Out of scope",
      "No orchestration changes",
      "Acceptance criteria (specification)",
      "behavior",
      "Selection opens the matching task\nNo invented task records",
      "Preserve dependency direction",
      "Current view",
      "GET /wb/current-view\nReturns the recorded graph",
      longPath,
      "Render task contracts",
      "modify",
    ]) {
      expect(rendered).toContain(value);
    }
    expect(rendered.indexOf("Scope")).toBeLessThan(rendered.indexOf("Business stage"));
    expect(aside.findAllByProps({ type: "checkbox" })).toHaveLength(0);
    expect(rendered).not.toMatch(/passed|verified|accepted|succeeded/i);
    expect(requests[1]!.url).toBe("/workbench-api/wb/specs/alpha");
  });

  it("distinguishes an older backend's missing contract fields from unrecorded outputs", async () => {
    await mount({ project: "one", selected: "alpha" });
    await respond(requests[0]!, snapshot());
    await respond(requests[1]!, detail("alpha", "Recorded event"));
    const rendered = content(renderer!.root.findByType("aside"));
    expect(rendered.match(/Contract data not provided by backend/g)).toHaveLength(6);
    expect(rendered).not.toContain("Not recorded");
    expect(rendered).not.toMatch(/passed|verified|accepted|succeeded|failed/i);
  });

  it.each([
    null,
    {},
    {
      scope_in: [],
      scope_out: [],
      verify_criteria: [],
      invariants: [],
      interfaces: [],
      touches: [],
    },
  ])("shows absent contract fields as unrecorded, not successful: %s", async (contract) => {
    await mount({ project: "one", selected: "alpha" });
    await respond(requests[0]!, snapshot());
    const response = detail("alpha", "Recorded event");
    await respond(requests[1]!, {
      ...response,
      spec: { ...response.spec, shape: contract, specify: contract },
    });
    const aside = renderer!.root.findByType("aside");
    const rendered = content(aside);
    expect(rendered).toContain("Acceptance criteria (specification)Not recorded");
    expect(rendered.match(/Not recorded/g)).toHaveLength(6);
    expect(rendered).not.toMatch(/passed|verified|accepted|succeeded|failed/i);
    expect(aside.findAllByProps({ type: "checkbox" })).toHaveLength(0);
  });

  it("places the dependency graph in project overview without synthesizing nodes from specs", async () => {
    await mount({ project: "one" });
    await respond(requests[0]!, snapshot());
    expect(content()).toContain("Completed / current work nodes");
    expect(content()).toContain("No graph nodes returned by the backend.");
    expect(content()).toContain("Alpha task");
    expect(button("Overview").props["aria-current"]).toBe("page");
    expect(requests).toHaveLength(1);
  });

  it("renders host sessions through the external page and preserves the task filter", async () => {
    await mount({ project: "one", tab: "tasks", layout: "board" });
    const view = snapshot();
    view.runs = ["alpha", "beta"].map((slug) => ({
      id: `${slug}-run`,
      taskSlug: slug,
      packageId: "package",
      generation: 1,
      threadRef: `${slug}-thread`,
      workspace: "workspace",
      state: "bound",
      createdAt: view.generatedAt,
      updatedAt: view.generatedAt,
    }));
    await respond(requests[0]!, view);
    await act(async () => {
      button("Alpha task").props.onClick();
    });
    await act(async () => {
      button("Sessions").props.onClick();
    });
    expect(content()).toContain("Host session: alpha-run");
    expect(content()).not.toContain("Host session: beta-run");
    await act(async () => {
      button("Clear task filter").props.onClick();
    });
    expect(content()).toContain("Host session: alpha-run");
    expect(content()).toContain("Host session: beta-run");
  });

  it("does not overlap polling and ignores a late response after switching projects", async () => {
    await mount();
    const first = requests[0]!;
    expect(first.project).toBe("one");
    await act(async () => {
      vi.advanceTimersByTime(45_000);
    });
    expect(requests).toHaveLength(1);

    await act(async () => {
      renderer!.root.findByType("select").props.onChange({ target: { value: "two" } });
    });
    expect(first.signal?.aborted).toBe(true);
    const second = requests[1]!;
    expect(second.project).toBe("two");
    await respond(second, snapshot("two", "Second project task"));
    await respond(first, snapshot("one", "Obsolete first project task"));
    expect(content()).toContain("Second project task");
    expect(content()).not.toContain("Obsolete first project task");
    expect(searchChanged).toHaveBeenLastCalledWith({
      project: "two",
      tab: "overview",
      layout: "graph",
    });
  });

  it("keeps the last snapshot visibly stale after refresh failure, then clears the error on success", async () => {
    await mount();
    await respond(requests[0]!, snapshot());
    await act(async () => {
      button("Refresh").props.onClick();
    });
    await respond(requests[1]!, { error: "unavailable" }, 503);
    expect(content()).toContain("Alpha task");
    expect(content()).toContain("Refresh failed; displayed data is stale");
    expect(content()).toContain("HTTP 503");

    await act(async () => {
      button("Refresh").props.onClick();
    });
    await respond(requests[2]!, snapshot("one", "Recovered task"));
    expect(content()).toContain("Recovered task");
    expect(content()).not.toContain("HTTP 503");
    expect(content()).not.toContain("displayed data is stale");
    expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  });

  it("never requests a current view or spec for an unknown project", async () => {
    await mount({ project: "missing", selected: "alpha", tab: "tasks", layout: "table" });
    expect(requests).toHaveLength(0);
    expect(content()).toContain("The selected project is not in the backend project list");
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(requests).toHaveLength(0);
  });

  it("does not carry an old project's fetch error across a browser-history search change", async () => {
    await act(async () => {
      renderer = create(
        <WorkbenchPage search={{ project: "one" }} onSearchChange={searchChanged} />,
      );
    });
    await respond(requests[0]!, {}, 503);
    expect(content()).toContain("HTTP 503");
    await act(async () => {
      renderer!.update(
        <WorkbenchPage search={{ project: "two" }} onSearchChange={searchChanged} />,
      );
    });
    expect(requests[1]!.project).toBe("two");
    expect(content()).not.toContain("HTTP 503");
    expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  });

  it("releases loading when browser history switches an in-flight project to an unknown one", async () => {
    await act(async () => {
      renderer = create(
        <WorkbenchPage search={{ project: "one" }} onSearchChange={searchChanged} />,
      );
    });
    expect(button("Refresh").props.disabled).toBe(true);
    expect(content()).toContain("Refreshing…");
    await act(async () => {
      renderer!.update(
        <WorkbenchPage search={{ project: "missing" }} onSearchChange={searchChanged} />,
      );
    });
    expect(requests[0]!.signal?.aborted).toBe(true);
    expect(content()).not.toContain("Refreshing…");
    expect(button("Refresh").props.disabled).toBe(false);
    expect(content()).toContain("The selected project is not in the backend project list");
    await act(async () => {
      button("Refresh").props.onClick();
    });
    expect(requests).toHaveLength(1);
  });

  it("applies tab, layout and task searches while cancelling old details and clearing the selection", async () => {
    await mount();
    await respond(requests[0]!, snapshot());
    await act(async () => {
      button("Tasks & dependencies").props.onClick();
    });
    expect(searchChanged).toHaveBeenLastCalledWith({
      project: "one",
      tab: "tasks",
      layout: "graph",
    });
    expect(button("Dependency graph").props["aria-pressed"]).toBe(true);
    expect(content()).toContain("No graph nodes returned by the backend.");
    await act(async () => {
      button("Table").props.onClick();
    });
    expect(searchChanged).toHaveBeenLastCalledWith({
      project: "one",
      tab: "tasks",
      layout: "table",
    });
    expect(renderer!.root.findAllByType("table")).toHaveLength(1);

    await act(async () => {
      button("Beta task").props.onClick();
    });
    const beta = requests[1]!;
    expect(beta.url).toBe("/workbench-api/wb/specs/beta");
    expect(beta.project).toBe("one");
    await act(async () => {
      button("Alpha task").props.onClick();
    });
    expect(searchChanged).toHaveBeenLastCalledWith({
      project: "one",
      tab: "tasks",
      layout: "table",
      selected: "alpha",
    });
    expect(beta.signal?.aborted).toBe(true);
    await respond(requests[2]!, detail("alpha", "Alpha execution event"));
    await respond(beta, detail("beta", "Obsolete beta event"));
    expect(content()).toContain("Alpha execution event");
    expect(content()).not.toContain("Obsolete beta event");

    await act(async () => {
      button("Clear task filter").props.onClick();
    });
    expect(searchChanged).toHaveBeenLastCalledWith({
      project: "one",
      tab: "tasks",
      layout: "table",
    });
    expect(renderer!.root.findAllByType("aside")).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    await respond(requests[3]!, snapshot());
    expect(requests.filter((request) => request.url.includes("/specs/"))).toHaveLength(2);
  });

  it("refreshes selected details with new snapshots and labels retained detail failures", async () => {
    await mount({ project: "one", selected: "alpha" });
    await respond(requests[0]!, snapshot());
    await respond(requests[1]!, detail("alpha", "Initial execution event"));
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    await respond(requests[2]!, snapshot());
    expect(requests[3]!.url).toBe("/workbench-api/wb/specs/alpha");
    expect(content()).toContain("Refreshing details; showing the previous detail snapshot");
    await respond(requests[3]!, {}, 503);
    expect(content()).toContain("Initial execution event");
    expect(content()).toContain("Detail refresh failed; displayed details are stale");
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    await respond(requests[4]!, snapshot());
    await respond(requests[5]!, detail("alpha", "Latest execution event"));
    expect(content()).toContain("Latest execution event");
    expect(content()).not.toContain("Initial execution event");
    expect(content()).not.toContain("HTTP 503");
  });
});
