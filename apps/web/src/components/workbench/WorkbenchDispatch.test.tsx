import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { ROLE_GUIDANCE, PURPOSE_GUIDANCE, type WorkPurpose } from "@project-workbench/ui/dispatch";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  readHead: vi.fn(),
  fetch: vi.fn(),
  available: true,
  live: true,
  connected: true,
  threads: [] as Array<{
    environmentId: string;
    id: string;
    projectId: string;
    session: { status: string; activeTurnId: string | null } | null;
  }>,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ status: mocks.live ? "live" : "stale" }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("~/i18n/i18n", () => ({ useI18n: () => ({ language: "en" }) }));
vi.mock("~/state/shell", () => ({ environmentShell: { stateValueAtom: () => null } }));
vi.mock("~/state/threads", () => ({
  threadEnvironment: { create: "create", startTurn: "start", stopSession: "stop" },
}));
vi.mock("~/state/vcs", () => ({ vcsEnvironment: { readHead: "read-head" } }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "create"
      ? mocks.create
      : command === "read-head"
        ? mocks.readHead
        : command === "stop"
          ? mocks.stop
          : mocks.start,
}));
vi.mock("~/state/entities", () => ({
  useProjects: () => [
    { id: "native", environmentId: "local", title: "Native project", workspaceRoot: "C:\\project" },
  ],
  useServerConfigs: () => new Map([["local", { providers: [] }]]),
  useThreadShells: () => mocks.threads,
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    presentationById: new Map([
      ["local", { connection: { phase: mocks.connected ? "connected" : "disconnected" } }],
    ]),
  }),
}));
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({
    ...DEFAULT_SERVER_SETTINGS,
    defaultModelSelection: { instanceId: "codex", model: "exact" },
  }),
}));
vi.mock("~/modelSelection", () => ({
  getAppModelOptionsForInstance: () => (mocks.available ? [{ slug: "exact" }] : []),
}));
vi.mock("~/providerInstances", () => ({
  deriveProviderInstanceEntries: () => [{ instanceId: "codex", driverKind: "codex", models: [] }],
  isProviderInstancePickerReady: () => true,
}));
vi.mock("~/providerModels", () => ({
  getProviderModelCapabilities: () => ({ optionDescriptors: [] }),
}));
vi.mock("../chat/composerProviderState", () => ({
  getComposerProviderState: () => ({ promptEffort: null }),
}));
vi.mock("~/threadRoutes", () => ({ buildThreadRouteParams: (value: unknown) => value }));
vi.mock("./WorkbenchWorkspacePicker", () => ({
  WorkbenchWorkspacePicker: ({
    disabled,
    onChange,
  }: {
    disabled: boolean;
    onChange: (value: {
      workspace: string;
      branch: string | null;
      worktreePath: string | null;
      expectedCommitSha?: string;
    }) => void;
  }) => (
    <>
      <button
        data-testid="shared-workspace"
        disabled={disabled}
        onClick={() => onChange({ workspace: "C:\\project", branch: null, worktreePath: null })}
      >
        Shared fixture
      </button>
      <button
        data-testid="isolated-workspace"
        disabled={disabled}
        onClick={() =>
          onChange({
            workspace: "C:\\worktrees\\task",
            branch: "task",
            worktreePath: "C:\\worktrees\\task",
          })
        }
      >
        Isolated fixture
      </button>
      <button
        data-testid="commit-workspace"
        disabled={disabled}
        onClick={() =>
          onChange({
            workspace: "C:\\worktrees\\task",
            branch: "task",
            worktreePath: "C:\\worktrees\\task",
            expectedCommitSha: "a".repeat(40),
          })
        }
      >
        Commit fixture
      </button>
    </>
  ),
}));

import { WorkbenchDispatch } from "./WorkbenchDispatch";
import { DISPATCH_STORAGE_KEY } from "./WorkbenchDispatch.logic";
import { decodeDispatchTarget } from "./WorkbenchDispatch.logic";

let renderer: ReactTestRenderer | undefined;
let storage: Map<string, string>;
beforeEach(() => {
  mocks.create.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.start.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.stop.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.readHead
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { isRepo: true, commitSha: "a".repeat(40) } });
  mocks.fetch.mockReset();
  mocks.available = true;
  mocks.live = true;
  mocks.connected = true;
  mocks.threads = [];
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

async function selectProject(
  operationRequest?: Parameters<typeof WorkbenchDispatch>[0]["operationRequest"],
  workPurpose: WorkPurpose | "" = "implementation",
) {
  await act(async () => {
    renderer = create(
      <WorkbenchDispatch
        project="workbench"
        taskSlug="task"
        title="Task"
        runs={[]}
        onChanged={() => {}}
        {...(operationRequest ? { operationRequest } : {})}
      />,
    );
  });
  await act(async () =>
    renderer!.root.findByType("select").props.onChange({ target: { value: "local:native" } }),
  );
  const workspace = renderer!.root.findByProps({ "data-testid": "shared-workspace" });
  if (!workspace.props.disabled) await act(async () => workspace.props.onClick());
  if (workPurpose)
    await act(async () =>
      renderer!.root
        .findByProps({ "aria-label": "Work purpose" })
        .props.onChange({ target: { value: workPurpose } }),
    );
  if (workPurpose) await fillBasis(workPurpose);
}
async function fillBasis(purpose: WorkPurpose) {
  if (!["design", "test_design", "implementation", "test_execution"].includes(purpose)) return;
  if (purpose !== "test_execution")
    await act(async () =>
      renderer!.root
        .findByProps({ "aria-label": "Requirement approval decision IDs" })
        .props.onChange({ target: { value: "req-decision-1, req-decision-2" } }),
    );
  if (purpose === "implementation")
    await act(async () =>
      renderer!.root
        .findByProps({ "aria-label": "Design approval decision IDs" })
        .props.onChange({ target: { value: "design-decision-1" } }),
    );
  if (purpose !== "design") {
    const group = purpose === "test_design" ? "designSources" : "testPlanSources";
    await act(async () =>
      renderer!.root
        .findByProps({
          "aria-label": purpose === "test_design" ? "Add Design sources" : "Add Test plan sources",
        })
        .props.onClick(),
    );
    for (const [field, value] of [
      ["field", "specify"],
      ["changeId", "source-change-1"],
    ])
      await act(async () =>
        renderer!.root
          .findByProps({ "aria-label": `${group} 1 ${field}` })
          .props.onChange({ target: { value } }),
      );
  }
  await act(async () =>
    renderer!.root
      .findByProps({ "aria-label": "QA applicability" })
      .props.onChange({ target: { value: "Applies to this node's agreed scope." } }),
  );
}
async function confirm() {
  await act(async () =>
    renderer!.root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }),
  );
}
function dispatchButton() {
  return renderer!.root
    .findAllByType("button")
    .find(
      (button) =>
        button.children.includes("Create and dispatch") ||
        button.children.includes("Resume original dispatch"),
    )!;
}

describe("manual T3 dispatch consumer", () => {
  it("blocks a new dispatch under human ownership without removing the original execution surface", async () => {
    await act(async () => {
      renderer = create(
        <WorkbenchDispatch
          project="workbench"
          taskSlug="task"
          title="Task"
          runs={[]}
          ownerHold
          onChanged={() => {}}
        />,
      );
    });
    await act(async () =>
      renderer!.root.findByType("select").props.onChange({ target: { value: "local:native" } }),
    );
    expect(dispatchButton().props.disabled).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "Original run read, stop and release remain available",
    );
    await act(async () => dispatchButton().props.onClick());
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("requires an explicit work purpose without inferring it from executor responsibility", async () => {
    await selectProject(undefined, "");
    await confirm();
    expect(
      renderer!.root.findByProps({ "aria-label": "Dispatch responsibility" }).props.value,
    ).toBe("executor");
    expect(renderer!.root.findByProps({ "aria-label": "Work purpose" }).props.value).toBe("");
    expect(dispatchButton().props.disabled).toBe(true);
    await act(async () => dispatchButton().props.onClick());
    expect(mocks.readHead).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    await act(async () =>
      renderer!.root
        .findByProps({ "aria-label": "Work purpose" })
        .props.onChange({ target: { value: "test_design" } }),
    );
    expect(dispatchButton().props.disabled).toBe(true);
    await confirm();
    expect(dispatchButton().props.disabled).toBe(true);
    expect(
      renderer!.root.findAllByProps({ "aria-label": "Design approval decision IDs" }),
    ).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ "aria-label": "Test plan sources" })).toHaveLength(0);
    await fillBasis("test_design");
    await confirm();
    expect(dispatchButton().props.disabled).toBe(false);
  });

  it("pins an explicitly requested current SpecGraph source without inventing a missing change ID", async () => {
    await selectProject(undefined, "test_design");
    mocks.fetch.mockResolvedValueOnce(
      Response.json({ kind: "spec", slug: "task", sourceRefs: { specify: "current-change-2" } }),
    );
    const pin = () =>
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Use recorded current source"))!;
    await act(async () => pin().props.onClick());
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/workbench-api/knowledge/spec/task",
      expect.objectContaining({ method: "GET" }),
    );
    expect(
      renderer!.root.findByProps({ "aria-label": "designSources 1 changeId" }).props.value,
    ).toBe("current-change-2");
    mocks.fetch.mockResolvedValueOnce(
      Response.json({ kind: "spec", slug: "task", sourceRefs: {} }),
    );
    await act(async () => pin().props.onClick());
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "No recorded source change ID for this field",
    );
    expect(
      renderer!.root.findByProps({ "aria-label": "designSources 1 changeId" }).props.value,
    ).toBe("current-change-2");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it.each(["implementation", "test_execution"] as const)(
    "prepares %s with the selected worktree's actual commit and recorded guidance",
    async (workPurpose) => {
      let target: Record<string, unknown> = {};
      mocks.fetch.mockImplementation(async (url: string, options: RequestInit) => {
        if (url.endsWith("/loop/runs")) {
          const body = JSON.parse(String(options.body));
          target = body.dispatch_target;
          expect(body.workspace).toBe("C:\\worktrees\\task");
          expect(target.projectWorkspaceRoot).toBe("C:\\project");
          expect(target.gitBaseline).toEqual({ isRepo: true, commitSha: "a".repeat(40) });
          return Response.json({ binding_id: "run" });
        }
        if (url.endsWith("/context"))
          return Response.json({
            runId: "run",
            taskSlug: "task",
            packageId: "package",
            createdAt: target.createdAt,
            body: {
              task_slug: "task",
              workspace: target.workspace,
              dispatch_target: target,
              bundle: {
                Version: 2,
                Spec: { Slug: "task", Role: "work", Intent: "Task" },
                Decisions: [],
                Dependencies: null,
              },
            },
          });
        if (url.endsWith("/dispatch"))
          return Response.json({
            admission: null,
            resolution: null,
            cancellation: null,
            stopConfirmation: null,
          });
        if (url.endsWith("/bind") || url.endsWith("/authorize")) return Response.json({});
        throw new Error(url);
      });
      await selectProject(undefined, workPurpose);
      await act(async () =>
        renderer!.root
          .findByProps({
            "data-testid":
              workPurpose === "test_execution" ? "commit-workspace" : "isolated-workspace",
          })
          .props.onClick(),
      );
      await act(async () =>
        renderer!.root.findByProps({ "aria-label": "Add Test plan sources" }).props.onClick(),
      );
      await act(async () =>
        renderer!.root
          .findByProps({ "aria-label": "testPlanSources 2 kind" })
          .props.onChange({ target: { value: "git" } }),
      );
      for (const [field, value] of [
        ["environmentId", "local"],
        ["repositoryRoot", "C:/project"],
        ["commitSha", "b".repeat(40)],
        ["path", "QA-TEST-PLAN.md"],
        ["entry", "Q3"],
      ]) {
        await act(async () =>
          renderer!.root
            .findByProps({ "aria-label": `testPlanSources 2 ${field}` })
            .props.onChange({ target: { value } }),
        );
      }
      await confirm();
      await act(async () => dispatchButton().props.onClick());
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ branch: "task", worktreePath: "C:\\worktrees\\task" }),
        }),
      );
      expect(mocks.start.mock.calls[0]![0].input.message.text).toContain("worktrees");
      expect(mocks.readHead).toHaveBeenCalledWith({
        environmentId: "local",
        input: { cwd: "C:\\worktrees\\task" },
      });
      expect(mocks.start.mock.calls[0]![0].input.message.text).toContain("a".repeat(40));
      expect(mocks.start.mock.calls[0]![0].input.message.text).toContain("b".repeat(40));
      expect(mocks.start.mock.calls[0]![0].input.message.text).toContain('"entry": "Q3"');
      expect(mocks.start.mock.calls[0]![0].input.message.text).toContain(
        PURPOSE_GUIDANCE[workPurpose],
      );
      expect(target).not.toHaveProperty("expectedCommitSha");
    },
  );
  it.each(["b".repeat(40), null])(
    "does not prepare when an explicitly selected commit differs from HEAD %s",
    async (commitSha) => {
      mocks.readHead.mockResolvedValueOnce({
        _tag: "Success",
        value: { isRepo: commitSha !== null, commitSha },
      });
      await selectProject(undefined, "test_execution");
      await act(async () =>
        renderer!.root.findByProps({ "data-testid": "commit-workspace" }).props.onClick(),
      );
      await confirm();
      await act(async () => dispatchButton().props.onClick());
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.start).not.toHaveBeenCalled();
      expect(storage.has(DISPATCH_STORAGE_KEY)).toBe(false);
      expect(JSON.stringify(renderer!.toJSON())).toContain(
        "The selected worktree is not at the requested commit",
      );
      expect(JSON.stringify(renderer!.toJSON())).toContain("a".repeat(40));
    },
  );
  it("does not prepare or start after a failed Git baseline read", async () => {
    mocks.readHead.mockRejectedValueOnce(new Error("Git baseline unavailable"));
    await selectProject();
    await confirm();
    await act(async () => dispatchButton().props.onClick());
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Git baseline unavailable");
  });
  it("recovers an already admitted run after abort refusal without sending native commands", async () => {
    let original: { key: string; target: Record<string, unknown> };
    mocks.fetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/loop/runs")) throw new Error("prepare response lost");
      if (url.endsWith("/preparations/abort")) {
        expect(JSON.parse(String(options?.body)).idempotencyKey).toBe(original.key);
        return Response.json(
          {
            error: "dispatch already admitted; preparation was not cancelled",
            runId: "run",
            idempotencyKey: original.key,
          },
          { status: 428 },
        );
      }
      if (url.endsWith("/context"))
        return Response.json({
          runId: "run",
          taskSlug: "task",
          packageId: "package",
          createdAt: original.target.createdAt,
          body: { dispatch_target: original.target },
        });
      if (url.endsWith("/dispatch"))
        return Response.json({
          admission: { id: "admission", actor: "human" },
          resolution: null,
          cancellation: null,
          stopConfirmation: null,
        });
      throw new Error(`Unexpected endpoint: ${url}`);
    });
    await selectProject();
    await confirm();
    await act(async () => dispatchButton().props.onClick());
    original = JSON.parse(storage.get(DISPATCH_STORAGE_KEY)!);
    await act(async () =>
      renderer!.root
        .findByProps({ "aria-label": "Original request abort reason" })
        .props.onChange({ target: { value: "Withdraw request" } }),
    );
    await act(async () =>
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Fence original preparation"))!
        .props.onClick(),
    );
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "dispatch already admitted; preparation was not cancelled",
    );
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Original preparation fenced");
    expect(storage.has(DISPATCH_STORAGE_KEY)).toBe(false);
    expect(dispatchButton().props.disabled).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("fences an unknown preparation with the original key and retains abort intent through response loss", async () => {
    const aborts: unknown[] = [];
    mocks.fetch.mockImplementation(async (url: string, options: RequestInit) => {
      if (url.endsWith("/loop/runs")) throw new Error("prepare response lost");
      if (url.endsWith("/preparations/abort")) {
        const body = JSON.parse(String(options.body));
        aborts.push(body);
        if (aborts.length === 1) throw new Error("abort response lost");
        return Response.json({ idempotencyKey: body.idempotencyKey, runId: null, replayed: true });
      }
      throw new Error("Unexpected endpoint");
    });
    await selectProject();
    await confirm();
    await act(async () => dispatchButton().props.onClick());
    const original = JSON.parse(storage.get(DISPATCH_STORAGE_KEY)!);
    await act(async () =>
      renderer!.root
        .findByProps({ "aria-label": "Original request abort reason" })
        .props.onChange({ target: { value: "Withdraw request" } }),
    );
    const abortButton = () =>
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Fence original preparation"))!;
    await act(async () => abortButton().props.onClick());
    expect(JSON.parse(storage.get(DISPATCH_STORAGE_KEY)!)).toMatchObject({
      key: original.key,
      abortNote: "Withdraw request",
    });
    expect(dispatchButton().props.disabled).toBe(true);
    await act(async () => abortButton().props.onClick());
    expect(aborts[0]).toEqual(aborts[1]);
    expect(aborts[0]).toMatchObject({ idempotencyKey: original.key, target: original.target });
    expect(storage.has(DISPATCH_STORAGE_KEY)).toBe(false);
    expect(dispatchButton().props.disabled).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("requires explicit review and rejects an unavailable exact model", async () => {
    mocks.available = false;
    await selectProject();
    await confirm();
    expect(dispatchButton().props.disabled).toBe(true);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("persists target before prepare and suppresses continuation after unmount", async () => {
    let finish!: (response: Response) => void;
    mocks.fetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    await selectProject();
    expect(dispatchButton().props.disabled).toBe(true);
    await confirm();
    await act(async () => dispatchButton().props.onClick());
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(storage.get(DISPATCH_STORAGE_KEY)!);
    const request = JSON.parse(mocks.fetch.mock.calls[0]![1].body);
    expect(request.dispatch_target).toEqual(saved.target);
    expect(saved.target.qaBasis).toMatchObject({
      requirementDecisionIds: ["req-decision-1", "req-decision-2"],
      designDecisionIds: ["design-decision-1"],
      applicability: "Applies to this node's agreed scope.",
    });
    expect(renderer!.root.findByProps({ "aria-label": "QA applicability" }).props.disabled).toBe(
      true,
    );
    expect(
      renderer!.root.findByProps({ "aria-label": "testPlanSources 1 changeId" }).props.disabled,
    ).toBe(true);
    expect(request.idempotency_key).toBe(saved.key);
    await act(async () => renderer!.unmount());
    renderer = undefined;
    await act(async () => finish(Response.json({ binding_id: "run" })));
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(storage.has(DISPATCH_STORAGE_KEY)).toBe(true);
    await act(async () => {
      renderer = create(
        <WorkbenchDispatch
          project="workbench"
          taskSlug="task"
          title="Task"
          runs={[]}
          onChanged={() => {}}
        />,
      );
    });
    expect(renderer!.root.findByProps({ "aria-label": "QA applicability" }).props.value).toBe(
      saved.target.qaBasis.applicability,
    );
    expect(renderer!.root.findByProps({ "aria-label": "QA applicability" }).props.disabled).toBe(
      true,
    );
    expect(
      renderer!.root.findByProps({ "aria-label": "testPlanSources 1 changeId" }).props.value,
    ).toBe("source-change-1");
    expect(
      renderer!.root.findByProps({ "aria-label": "testPlanSources 1 changeId" }).props.disabled,
    ).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("releases the preparation slot after context proof, then resumes the same native payload", async () => {
    const networkFetch = vi.fn(() => {
      throw new Error("Injected dispatch must not use HTTP");
    });
    vi.stubGlobal("fetch", networkFetch);
    const order: string[] = [];
    let target: Record<string, unknown>;
    mocks.create.mockImplementation(async () => {
      order.push("native-create");
      return { _tag: "Success" };
    });
    mocks.start
      .mockImplementationOnce(async () => {
        order.push("native-start");
        return { _tag: "Failure" };
      })
      .mockImplementation(async () => {
        order.push("native-start");
        return { _tag: "Success" };
      });
    mocks.fetch.mockImplementation(async (url: string, options: RequestInit) => {
      if (url.endsWith("/loop/runs")) {
        order.push("prepare");
        target = JSON.parse(options.body as string).dispatch_target;
        return Response.json({ binding_id: "run" });
      }
      if (url.endsWith("/context"))
        return Response.json({
          runId: "run",
          taskSlug: "task",
          packageId: "package",
          createdAt: "2026-09-21T00:00:00.000Z",
          body: {
            task_slug: "task",
            workspace: "C:\\project",
            dispatch_target: target,
            bundle: {
              Version: 2,
              Spec: { Slug: "task", Role: "work", Intent: "Do task" },
              Decisions: [],
              Dependencies: null,
            },
          },
        });
      if (url.endsWith("/dispatch"))
        return Response.json({
          admission: order.includes("authorize") ? { id: "admission", actor: "human" } : null,
          resolution: null,
          cancellation: null,
          stopConfirmation: null,
        });
      if (url.endsWith("/bind")) {
        order.push("bind");
        return Response.json({});
      }
      if (url.endsWith("/authorize")) {
        order.push("authorize");
        return Response.json({});
      }
      throw new Error(`Unexpected endpoint: ${url}`);
    });
    await selectProject(mocks.fetch, "test_design");
    const responsibility = () =>
      renderer!.root.findByProps({ "aria-label": "Dispatch responsibility" });
    expect(responsibility().props.value).toBe("executor");
    await act(async () => responsibility().props.onChange({ target: { value: "knowledge" } }));
    await confirm();
    await act(async () => dispatchButton().props.onClick());
    expect(networkFetch).not.toHaveBeenCalled();
    expect(order).toEqual(["prepare", "native-create", "bind", "authorize", "native-start"]);
    expect(target!).toMatchObject({
      assignmentRole: "knowledge",
      roleGuidance: ROLE_GUIDANCE.knowledge,
      workPurpose: "test_design",
      purposeGuidance: PURPOSE_GUIDANCE.test_design,
    });
    expect(
      mocks.start.mock.calls[0]![0].input.message.text.startsWith(
        PURPOSE_GUIDANCE.test_design + ROLE_GUIDANCE.knowledge,
      ),
    ).toBe(true);
    expect(renderer!.root.findByProps({ "aria-label": "Work purpose" }).props.value).toBe(
      "test_design",
    );
    expect(renderer!.root.findByProps({ "aria-label": "Work purpose" }).props.disabled).toBe(true);
    expect(target!.qaBasis).toMatchObject({
      requirementDecisionIds: ["req-decision-1", "req-decision-2"],
      designDecisionIds: [],
      designSources: [
        { kind: "specgraph", specSlug: "task", field: "specify", changeId: "source-change-1" },
      ],
      testPlanSources: [],
    });
    expect(mocks.start.mock.calls[0]![0].input.message.text).toContain('"source-change-1"');
    expect(mocks.start.mock.calls[0]![0].input.message.text).toContain(
      "Applies to this node's agreed scope.",
    );
    expect(renderer!.root.findByProps({ "aria-label": "QA applicability" }).props.disabled).toBe(
      true,
    );
    expect(
      renderer!.root.findByProps({ "aria-label": "designSources 1 changeId" }).props.disabled,
    ).toBe(true);
    expect(responsibility().props.value).toBe("knowledge");
    expect(responsibility().props.disabled).toBe(true);
    expect(mocks.create.mock.calls[0]![0].input.modelSelection).toEqual(
      mocks.start.mock.calls[0]![0].input.modelSelection,
    );
    expect(storage.has(DISPATCH_STORAGE_KEY)).toBe(false);
    await confirm();
    await act(async () => dispatchButton().props.onClick());
    expect(order.filter((item) => item === "prepare")).toHaveLength(1);
    expect(mocks.start.mock.calls[0]).toEqual(mocks.start.mock.calls[1]);
    expect(JSON.stringify(renderer!.toJSON())).toContain("does not prove the model has started");
  });

  it.each([undefined, "implementation"] as const)(
    "keeps incomplete historical purpose %s readable and cancellable but cannot launch it",
    async (workPurpose) => {
      const target = decodeDispatchTarget({
        version: 1,
        promptFormatVersion: "vacpms-run-v2",
        environmentId: "local",
        projectId: "native",
        workspace: "C:\\project",
        threadId: "thread",
        createCommandId: "create",
        startCommandId: "start",
        messageId: "message",
        createdAt: "2026-09-21T00:00:00.000Z",
        title: "Task",
        modelSelection: { instanceId: "codex", model: "exact" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        promptInjectedEffort: null,
        promptPrefix: "",
        ...(workPurpose ? { workPurpose, purposeGuidance: PURPOSE_GUIDANCE[workPurpose] } : {}),
      });
      let cancelled = false;
      mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/context"))
          return Response.json({
            runId: "run",
            taskSlug: "task",
            packageId: "package",
            createdAt: target.createdAt,
            body: { dispatch_target: target },
          });
        if (url.endsWith("/cancel-preparation")) {
          expect(JSON.parse(String(init?.body))).toEqual({
            packageId: "package",
            note: "Change plan",
          });
          cancelled = true;
          return Response.json({ recorded: true });
        }
        if (url.endsWith("/dispatch"))
          return Response.json({
            admission: null,
            resolution: null,
            cancellation: cancelled
              ? { actor: "human", note: "Change plan", cancelledAt: target.createdAt }
              : null,
            stopConfirmation: null,
          });
        throw new Error("Unexpected request");
      });
      await act(async () => {
        renderer = create(
          <WorkbenchDispatch
            project="workbench"
            taskSlug="task"
            title="Task"
            runs={[
              {
                id: "run",
                taskSlug: "task",
                packageId: "package",
                generation: 1,
                threadRef: "",
                workspace: target.workspace,
                state: "prepared",
                createdAt: target.createdAt,
                updatedAt: target.createdAt,
              },
            ]}
            onChanged={() => {}}
          />,
        );
      });
      await act(async () =>
        renderer!.root.findByType("select").props.onChange({ target: { value: "local:native" } }),
      );
      expect(
        renderer!.root.findByProps({ "aria-label": "Dispatch responsibility" }).props.value,
      ).toBe("");
      expect(
        renderer!.root.findByProps({ "aria-label": "Dispatch responsibility" }).props.disabled,
      ).toBe(true);
      expect(renderer!.root.findByProps({ "aria-label": "Work purpose" }).props.value).toBe(
        workPurpose ?? "",
      );
      expect(renderer!.root.findByProps({ "aria-label": "Work purpose" }).props.disabled).toBe(
        true,
      );
      expect(JSON.stringify(renderer!.toJSON())).toContain(
        workPurpose ? "No recorded QA basis" : "Unknown (no recorded work purpose)",
      );
      await confirm();
      expect(dispatchButton().props.disabled).toBe(true);
      await act(async () => dispatchButton().props.onClick());
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.start).not.toHaveBeenCalled();
      await act(async () =>
        renderer!.root
          .findByProps({ "aria-label": "Preparation cancellation reason" })
          .props.onChange({ target: { value: "Change plan" } }),
      );
      const cancel = renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Cancel unadmitted preparation"))!;
      await act(async () => cancel.props.onClick());
      expect(cancelled).toBe(true);
      expect(dispatchButton().props.disabled).toBe(true);
      expect(
        renderer!.root
          .findAllByType("button")
          .some((button) => button.children.includes("Review a new attempt")),
      ).toBe(true);
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.start).not.toHaveBeenCalled();
    },
  );

  it("closes an original raw bound preparation only with named stop and real handoff evidence", async () => {
    const target = decodeDispatchTarget({
      version: 1,
      promptFormatVersion: "vacpms-run-v2",
      environmentId: "local",
      projectId: "native",
      workspace: "C:\\project",
      threadId: "original-thread",
      createCommandId: "create",
      startCommandId: "start",
      messageId: "message",
      createdAt: "2026-09-21T00:00:00.000Z",
      title: "Task",
      modelSelection: { instanceId: "codex", model: "exact" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      promptInjectedEffort: null,
      promptPrefix: "",
    });
    let cancellation: {
      actor: string;
      note: string;
      cancelledAt: string;
      rawHandoff: unknown;
    } | null = null;
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/context"))
        return Response.json({
          runId: "run",
          taskSlug: "task",
          packageId: "package",
          createdAt: target.createdAt,
          body: { dispatch_target: target },
        });
      if (url.endsWith("/cancel-preparation")) {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          packageId: "package",
          note: "Verified original thread stopped",
          rawHandoff: {
            environmentId: "local",
            threadId: "original-thread",
            summary: {
              kind: "human_substitute",
              humanSubstitute: {
                statement: "Recovered original result",
                sourceRefs: ["original log"],
                missingInfo: ["final model response unavailable"],
              },
            },
          },
        });
        cancellation = {
          actor: "human",
          note: body.note,
          cancelledAt: target.createdAt,
          rawHandoff: body.rawHandoff,
        };
        return Response.json({ recorded: true });
      }
      if (url.endsWith("/dispatch"))
        return Response.json({
          admission: null,
          resolution: null,
          cancellation,
          stopConfirmation: null,
        });
      throw new Error(url);
    });
    await act(async () => {
      renderer = create(
        <WorkbenchDispatch
          project="workbench"
          taskSlug="task"
          title="Task"
          runs={[
            {
              id: "run",
              taskSlug: "task",
              packageId: "package",
              generation: 1,
              threadRef: target.threadId,
              environmentId: target.environmentId,
              workspace: target.workspace,
              state: "bound",
              createdAt: target.createdAt,
              updatedAt: target.createdAt,
            },
          ]}
          onChanged={() => {}}
        />,
      );
    });
    await act(async () =>
      renderer!.root.findByType("select").props.onChange({ target: { value: "local:native" } }),
    );
    const cancel = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Cancel unadmitted preparation"))!;
    expect(cancel.props.disabled).toBe(true);
    await act(async () =>
      renderer!.root
        .findByProps({ "aria-label": "Raw handoff summary kind" })
        .props.onChange({ target: { value: "human_substitute" } }),
    );
    for (const [name, value] of [
      ["Raw handoff statement", "Recovered original result"],
      ["Raw handoff source references", "original log"],
      ["Raw handoff missing information", "final model response unavailable"],
      ["Original raw stop explanation", "Verified original thread stopped"],
    ] as const)
      await act(async () =>
        renderer!.root.findByProps({ "aria-label": name }).props.onChange({ target: { value } }),
      );
    expect(cancel.props.disabled).toBe(true);
    await act(async () =>
      renderer!.root
        .findByProps({ "aria-label": "Confirm original raw stopped" })
        .props.onChange({ target: { checked: true } }),
    );
    expect(cancel.props.disabled).toBe(false);
    await act(async () => cancel.props.onClick());
    expect(cancellation).toMatchObject({
      actor: "human",
      rawHandoff: { threadId: "original-thread" },
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Recovered original result");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("stops the original isolated run but confirms only a live stopped session without an active turn", async () => {
    const target = decodeDispatchTarget({
      version: 1,
      promptFormatVersion: "vacpms-run-v2",
      environmentId: "local",
      projectId: "native",
      workspace: "C:\\project",
      threadId: "original-thread",
      createCommandId: "create",
      startCommandId: "start",
      messageId: "message",
      createdAt: "2026-09-21T00:00:00.000Z",
      title: "Task",
      modelSelection: { instanceId: "codex", model: "exact" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      promptInjectedEffort: null,
      promptPrefix: "",
    });
    const resolution = {
      actor: "operator",
      kind: "isolated_workspace",
      note: "Original worktree isolated",
      releasedAt: target.createdAt,
    };
    let stopConfirmation: { actor: string; note: string; confirmedAt: string } | null = null;
    mocks.threads = [
      {
        environmentId: "local",
        id: target.threadId,
        projectId: "native",
        session: { status: "running", activeTurnId: "turn" },
      },
    ];
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/context"))
        return Response.json({
          runId: "run",
          taskSlug: "task",
          packageId: "package",
          createdAt: target.createdAt,
          body: { dispatch_target: target },
        });
      if (url.endsWith("/confirm-stopped")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          admissionId: "admission",
          environmentId: "local",
          threadId: "original-thread",
          note: "Observed live stopped projection",
        });
        stopConfirmation = {
          actor: "operator",
          note: "Observed live stopped projection",
          confirmedAt: target.createdAt,
        };
        return Response.json({
          admission: { id: "admission", actor: "operator" },
          resolution,
          cancellation: null,
          stopConfirmation,
        });
      }
      if (url.endsWith("/dispatch"))
        return Response.json({
          admission: { id: "admission", actor: "operator" },
          resolution,
          cancellation: null,
          stopConfirmation,
        });
      throw new Error(`Unexpected endpoint ${url}`);
    });
    const props = {
      project: "workbench",
      taskSlug: "task",
      title: "Task",
      runs: [
        {
          id: "run",
          taskSlug: "task",
          packageId: "package",
          generation: 1,
          threadRef: target.threadId,
          environmentId: target.environmentId,
          workspace: target.workspace,
          state: "bound",
          createdAt: target.createdAt,
          updatedAt: target.createdAt,
        },
      ],
      onChanged: vi.fn(),
    };
    await act(async () => {
      renderer = create(<WorkbenchDispatch {...props} />);
    });
    await act(async () =>
      renderer!.root.findByType("select").props.onChange({ target: { value: "local:native" } }),
    );
    const stopButton = () =>
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Request original session stop"))!;
    const confirmation = () =>
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Record stop confirmation"))!;
    await act(async () =>
      renderer!.root
        .findByType("textarea")
        .props.onChange({ target: { value: "Observed live stopped projection" } }),
    );
    expect(stopButton().props.disabled).toBe(false);
    expect(confirmation().props.disabled).toBe(true);
    expect(mocks.stop).not.toHaveBeenCalled();
    await act(async () => stopButton().props.onClick());
    expect(mocks.stop).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { threadId: "original-thread" },
    });
    expect(confirmation().props.disabled).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "Stop command accepted; this does not prove the session stopped",
    );
    await act(async () => confirmation().props.onClick());
    expect(stopConfirmation).toBeNull();
    for (const session of [
      null,
      { status: "error", activeTurnId: null },
      { status: "stopped", activeTurnId: "still-active" },
    ]) {
      mocks.threads[0]!.session = session;
      await act(async () => renderer!.update(<WorkbenchDispatch {...props} />));
      expect(confirmation().props.disabled).toBe(true);
    }
    mocks.threads[0]!.session = { status: "stopped", activeTurnId: null };
    for (const [connected, live] of [
      [false, true],
      [true, false],
    ]) {
      mocks.connected = connected!;
      mocks.live = live!;
      await act(async () => renderer!.update(<WorkbenchDispatch {...props} />));
      expect(confirmation().props.disabled).toBe(true);
      await act(async () => confirmation().props.onClick());
      expect(stopConfirmation).toBeNull();
    }
    mocks.connected = true;
    mocks.live = true;
    await act(async () => renderer!.update(<WorkbenchDispatch {...props} />));
    expect(confirmation().props.disabled).toBe(false);
    expect(stopConfirmation).toBeNull();
    await act(async () => confirmation().props.onClick());
    expect(stopConfirmation).not.toBeNull();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Original worktree isolated");
    expect(JSON.stringify(renderer!.toJSON())).toContain("the node has not been abandoned");
    expect(dispatchButton().props.disabled).toBe(true);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(["resolution", "cancellation", "stopConfirmation"])(
    "offers a new attempt only after recorded %s and a fresh human review",
    async (kind) => {
      const target = decodeDispatchTarget({
        version: 1,
        promptFormatVersion: "vacpms-run-v2",
        environmentId: "local",
        projectId: "native",
        workspace: "C:\\project",
        threadId: "thread",
        createCommandId: "create",
        startCommandId: "start",
        messageId: "message",
        createdAt: "2026-09-21T00:00:00.000Z",
        title: "Task",
        modelSelection: { instanceId: "codex", model: "exact" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        promptInjectedEffort: null,
        promptPrefix: "",
      });
      mocks.fetch.mockImplementation(async (url: string) => {
        if (url.endsWith("/context"))
          return Response.json({
            runId: "run",
            taskSlug: "task",
            packageId: "package",
            createdAt: target.createdAt,
            body: { dispatch_target: target },
          });
        if (url.endsWith("/dispatch"))
          return Response.json({
            admission: kind !== "cancellation" ? { id: "admission", actor: "human" } : null,
            resolution:
              kind === "resolution"
                ? {
                    actor: "human",
                    kind: "stopped_writing",
                    note: "Verified externally",
                    releasedAt: target.createdAt,
                  }
                : null,
            cancellation:
              kind === "cancellation"
                ? { actor: "human", note: "Preparation cancelled", cancelledAt: target.createdAt }
                : null,
            stopConfirmation:
              kind === "stopConfirmation"
                ? { actor: "human", note: "Live projection stopped", confirmedAt: target.createdAt }
                : null,
          });
        throw new Error("No mutation expected before fresh review");
      });
      await act(async () => {
        renderer = create(
          <WorkbenchDispatch
            project="workbench"
            taskSlug="task"
            title="Task"
            runs={[
              {
                id: "run",
                taskSlug: "task",
                packageId: "package",
                generation: 1,
                threadRef: "thread",
                workspace: target.workspace,
                state: "bound",
                createdAt: target.createdAt,
                updatedAt: target.createdAt,
              },
            ]}
            onChanged={() => {}}
          />,
        );
      });
      await act(async () =>
        renderer!.root.findByType("select").props.onChange({ target: { value: "local:native" } }),
      );
      expect(dispatchButton().props.disabled).toBe(true);
      const review = renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Review a new attempt"))!;
      await act(async () => review.props.onClick());
      expect(dispatchButton().children).toContain("Create and dispatch");
      expect(dispatchButton().props.disabled).toBe(true);
      await confirm();
      expect(dispatchButton().props.disabled).toBe(true);
      await act(async () =>
        renderer!.root
          .findByProps({ "aria-label": "Work purpose" })
          .props.onChange({ target: { value: "test_execution" } }),
      );
      await fillBasis("test_execution");
      await confirm();
      expect(dispatchButton().props.disabled).toBe(false);
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.start).not.toHaveBeenCalled();
    },
  );
});

describe("project binding", () => {
  const binding = {
    id: "7",
    projectSlug: "workbench",
    environmentId: "local",
    nativeProjectId: "native",
    workspaceRoot: "C:\\project",
    reason: "First human-reviewed dispatch: task",
    actor: "operator",
    createdAt: "2026-09-29T00:00:00.000Z",
    revokedAt: null,
    revokeReason: null,
    revokedBy: null,
  };

  it("preselects and locks the bound T3 project with its recorded identity", async () => {
    await act(async () => {
      renderer = create(
        <WorkbenchDispatch
          project="workbench"
          taskSlug="task"
          title="Task"
          runs={[]}
          binding={binding}
          onChanged={() => {}}
        />,
      );
    });
    const select = renderer!.root.findAllByType("select")[0]!;
    expect(select.props.value).toBe("local:native");
    expect(select.props.disabled).toBe(true);
    const rendered = JSON.stringify(renderer!.toJSON());
    expect(rendered).toContain("Project binding");
    expect(rendered).toContain(
      "local · native · C:\\\\project · operator · 2026-09-29T00:00:00.000Z",
    );
    expect(rendered).toContain(
      "Bound to this project; unbind before dispatching to another project.",
    );
    expect(renderer!.root.findByProps({ "aria-label": "Work purpose" })).toBeTruthy();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("blocks dispatch with an explicit warning when the bound workspace drifted", async () => {
    await act(async () => {
      renderer = create(
        <WorkbenchDispatch
          project="workbench"
          taskSlug="task"
          title="Task"
          runs={[]}
          binding={{ ...binding, workspaceRoot: "D:\\other" }}
          onChanged={() => {}}
        />,
      );
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "The bound workspace has changed or no longer exists; unbind the project before dispatching again",
    );
    await act(async () =>
      renderer!.root
        .findByProps({ "aria-label": "Work purpose" })
        .props.onChange({ target: { value: "implementation" } }),
    );
    await fillBasis("implementation");
    await confirm();
    expect(dispatchButton().props.disabled).toBe(true);
    await act(async () => dispatchButton().props.onClick());
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("blocks dispatch when the bound project no longer exists on the host", async () => {
    await act(async () => {
      renderer = create(
        <WorkbenchDispatch
          project="workbench"
          taskSlug="task"
          title="Task"
          runs={[]}
          binding={{ ...binding, environmentId: "gone" }}
          onChanged={() => {}}
        />,
      );
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "The bound workspace has changed or no longer exists",
    );
    expect(renderer!.root.findByType("select").props.disabled).toBe(true);
    expect(renderer!.root.findAllByProps({ "aria-label": "Work purpose" })).toHaveLength(0);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "records the project binding after the first confirmed dispatch (binding write fails: %s)",
    async (bindFails) => {
      let target: Record<string, unknown> = {};
      const order: string[] = [];
      mocks.fetch.mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.endsWith("/loop/runs")) {
          order.push("prepare");
          target = JSON.parse(String(options?.body)).dispatch_target;
          return Response.json({ binding_id: "run" });
        }
        if (url.endsWith("/context"))
          return Response.json({
            runId: "run",
            taskSlug: "task",
            packageId: "package",
            createdAt: "2026-09-21T00:00:00.000Z",
            body: {
              task_slug: "task",
              workspace: target.workspace,
              dispatch_target: target,
              bundle: {
                Version: 2,
                Spec: { Slug: "task", Role: "work", Intent: "Task" },
                Decisions: [],
                Dependencies: null,
              },
            },
          });
        if (url.endsWith("/dispatch"))
          return Response.json({
            admission: null,
            resolution: null,
            cancellation: null,
            stopConfirmation: null,
          });
        if (url.endsWith("/project-binding/task")) {
          order.push("project-binding");
          const body = JSON.parse(String(options?.body));
          expect(body).toEqual({
            environmentId: "local",
            nativeProjectId: "native",
            workspaceRoot: "C:\\project",
            reason: "First human-reviewed dispatch: task",
          });
          if (bindFails)
            return Response.json(
              { code: "invalid_argument", error: "binding store unavailable" },
              { status: 400 },
            );
          return Response.json({ ...binding, reason: body.reason });
        }
        if (url.endsWith("/bind")) {
          order.push("bind");
          return Response.json({});
        }
        if (url.endsWith("/authorize")) {
          order.push("authorize");
          return Response.json({});
        }
        throw new Error(`Unexpected endpoint: ${url}`);
      });
      mocks.start.mockImplementation(async () => {
        order.push("native-start");
        return { _tag: "Success" };
      });
      await act(async () => {
        renderer = create(
          <WorkbenchDispatch
            project="workbench"
            taskSlug="task"
            title="Task"
            runs={[]}
            binding={null}
            onChanged={() => {}}
            operationRequest={mocks.fetch}
          />,
        );
      });
      await act(async () =>
        renderer!.root.findByType("select").props.onChange({ target: { value: "local:native" } }),
      );
      await act(async () =>
        renderer!.root.findByProps({ "data-testid": "shared-workspace" }).props.onClick(),
      );
      await act(async () =>
        renderer!.root
          .findByProps({ "aria-label": "Work purpose" })
          .props.onChange({ target: { value: "implementation" } }),
      );
      await fillBasis("implementation");
      await confirm();
      await act(async () => dispatchButton().props.onClick());
      expect(order).toEqual(["prepare", "bind", "authorize", "native-start", "project-binding"]);
      expect(order.indexOf("project-binding")).toBeGreaterThan(order.indexOf("authorize"));
      expect(mocks.start).toHaveBeenCalled();
      const rendered = JSON.stringify(renderer!.toJSON());
      expect(rendered).toContain("does not prove the model has started");
      expect(rendered.includes("Dispatch succeeded; the project binding was not recorded: ")).toBe(
        bindFails,
      );
      if (bindFails) expect(rendered).toContain("binding store unavailable");
      await act(async () => renderer!.unmount());
      renderer = undefined;
    },
  );

  it("revokes the binding only with a named reason and reports rejection without unlocking", async () => {
    const onChanged = vi.fn();
    mocks.fetch
      .mockResolvedValueOnce(
        Response.json(
          { code: "not_found", error: "active project binding not found" },
          { status: 404 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ ...binding, revokedAt: "2026-09-29T01:00:00.000Z" }));
    await act(async () => {
      renderer = create(
        <WorkbenchDispatch
          project="workbench"
          taskSlug="task"
          title="Task"
          runs={[]}
          binding={binding}
          onChanged={onChanged}
        />,
      );
    });
    const unbindButton = () =>
      renderer!.root
        .findAllByType("button")
        .find((button) => button.children.includes("Unbind project"))!;
    expect(unbindButton().props.disabled).toBe(true);
    await act(async () =>
      renderer!.root
        .findByProps({ "aria-label": "Unbind reason" })
        .props.onChange({ target: { value: "Rebinding to another workspace" } }),
    );
    expect(unbindButton().props.disabled).toBe(false);
    await act(async () => unbindButton().props.onClick());
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/workbench-api/project-binding/task/revoke",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ reason: "Rebinding to another workspace" }),
      }),
    );
    expect(onChanged).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer!.toJSON())).toContain("active project binding not found");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Project binding");
    await act(async () => unbindButton().props.onClick());
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
