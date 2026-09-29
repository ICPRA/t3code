import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { NodeEventsPanel } from "../../../../../../project-workbench/extensions/workbench-ui/src/NodeEventsPanel";
import type { CurrentView, NodeEvent } from "@project-workbench/ui/model";

afterEach(() => vi.unstubAllGlobals());

const runs: CurrentView["runs"] = ["task", "other"].map((taskSlug) => ({ id: `${taskSlug}-run`, taskSlug, packageId: "package", generation: 1,
  threadRef: `${taskSlug}-thread`, workspace: "workspace", state: "completed", createdAt: "2026-09-24", updatedAt: "2026-09-24" }));
const deliveries = runs.map((run) => ({ id: `${run.taskSlug}-delivery`, runBindingId: run.id, submittedBy: "operator", submittedAt: "2026-09-24" }));
const event: NodeEvent = { id: "old", taskSlug: "task", kind: "retry", reason: "Earlier failure", actor: "operator", previousRunId: "task-run", runId: null, deliveryId: null, recordedAt: "2026-09-24T10:00:00Z" };
const page = (events: NodeEvent[], nextCursor: string | null = null) => ({ taskSlug: "task", events, hasMore: nextCursor !== null, nextCursor });
const content = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(content).join("");

it("records only explicit same-node retry/rework declarations, preserving auth, references and history pagination", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let signedIn = false;
  const writes: Record<string, unknown>[] = [];
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/workbench-api/api/auth/login") { signedIn = true; return Response.json({}); }
    expect(new Headers(init?.headers).get("X-Specgraph-Project")).toBe("project");
    if (!signedIn) return Response.json({}, { status: 401 });
    if (init?.method === "POST") {
      const command = JSON.parse(String(init.body)); writes.push(command);
      return Response.json({ ...event, id: command.eventId, kind: command.kind, reason: command.reason,
        previousRunId: command.previousRunId ?? null, runId: command.runId ?? null, deliveryId: command.deliveryId ?? null });
    }
    return Response.json(url.includes("?cursor=") ? page([{ ...event, id: "older", reason: "Older failure" }]) : page([event], "older/page"));
  });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<NodeEventsPanel project="project" slug="task" language="en" counts={undefined} runs={runs} deliveries={deliveries} request={request} onChanged={() => {}} />); });
    expect(content(renderer.root)).toContain("Historical counts unavailable");
    await act(async () => renderer.root.findByType("input").props.onChange({ target: { value: "credential" } }));
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(writes).toEqual([]);
    expect(content(renderer.root)).not.toContain("other-run");
    await act(async () => renderer.root.findAllByType("button").find((node) => content(node) === "Load more")!.props.onClick());
    expect(request).toHaveBeenLastCalledWith("/workbench-api/node-events/task?cursor=older%2Fpage", expect.anything());
    expect(renderer.root.findAllByType("li")).toHaveLength(2);
    const form = renderer.root.findByProps({ "aria-label": "Record node event" });
    expect(form.findAllByType("select")[1]!.props.value).toBe("");
    await act(async () => form.findByType("textarea").props.onChange({ target: { value: "  Explicit retry  " } }));
    await act(async () => form.props.onSubmit({ preventDefault() {} }));
    expect(writes).toHaveLength(0);
    await act(async () => form.findAllByType("select")[1]!.props.onChange({ target: { value: "task-run" } }));
    await act(async () => form.findAllByType("select")[2]!.props.onChange({ target: { value: "task-run" } }));
    await act(async () => form.props.onSubmit({ preventDefault() {} }));
    expect(writes[0]).toEqual({ eventId: expect.stringMatching(/^[0-9a-f]{32}$/), kind: "retry", reason: "Explicit retry", previousRunId: "task-run", runId: "task-run" });
    await act(async () => form.findAllByType("select")[0]!.props.onChange({ target: { value: "rework" } }));
    expect(content(form)).not.toContain("other-delivery");
    await act(async () => form.findAllByType("select")[1]!.props.onChange({ target: { value: "task-delivery" } }));
    await act(async () => form.findByType("textarea").props.onChange({ target: { value: "Rework needed" } }));
    await act(async () => form.props.onSubmit({ preventDefault() {} }));
    expect(writes[1]).toEqual({ eventId: expect.stringMatching(/^[0-9a-f]{32}$/), kind: "rework", reason: "Rework needed", deliveryId: "task-delivery" });
    expect(writes[0]!.eventId).not.toBe(writes[1]!.eventId);
  } finally { await act(async () => renderer?.unmount()); }
});

it("retains the exact command after uncertain writes and reconciles matching history without automatic resubmission", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const writes: Record<string, unknown>[] = [];
  let recorded: NodeEvent | undefined;
  const request = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const command = JSON.parse(String(init.body)); writes.push(command);
      if (writes.length === 2) recorded = { ...event, id: command.eventId, reason: command.reason };
      throw new Error("connection lost");
    }
    return Response.json(page(recorded ? [recorded] : []));
  });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<NodeEventsPanel project="project" slug="task" language="en" counts={[]} runs={runs} deliveries={deliveries} request={request} onChanged={() => {}} />); });
    const form = renderer.root.findByProps({ "aria-label": "Record node event" });
    await act(async () => form.findAllByType("select")[1]!.props.onChange({ target: { value: "task-run" } }));
    await act(async () => form.findByType("textarea").props.onChange({ target: { value: "Retry declared" } }));
    await act(async () => form.props.onSubmit({ preventDefault() {} }));
    expect(content(renderer.root)).toContain("Result unconfirmed");
    expect(form.findByType("button").props.disabled).toBe(true);
    await act(async () => form.props.onSubmit({ preventDefault() {} }));
    expect(writes).toHaveLength(1);
    await act(async () => renderer.root.findAllByType("button").find((node) => content(node) === "Refresh history")!.props.onClick());
    expect(writes).toHaveLength(1);
    expect(form.findByType("button").props.disabled).toBe(false);
    expect(form.findByType("textarea").props.disabled).toBe(true);
    await act(async () => form.props.onSubmit({ preventDefault() {} }));
    expect(writes[1]).toEqual(writes[0]);
    await act(async () => renderer.root.findAllByType("button").find((node) => content(node) === "Refresh history")!.props.onClick());
    expect(writes).toHaveLength(2);
    expect(content(renderer.root)).toContain("Event recorded.");
    expect(content(renderer.root)).not.toContain("Pending event ID");
  } finally { await act(async () => renderer?.unmount()); }
});

it("exposes duplicate-ID conflict and the differing original instead of declaring success", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let original: NodeEvent | undefined;
  const request = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      original = { ...event, id: JSON.parse(String(init.body)).eventId, reason: "Original different reason" };
      return Response.json({ error: "duplicate event ID" }, { status: 409 });
    }
    return Response.json(page(original ? [original] : []));
  });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<NodeEventsPanel project="project" slug="task" language="en" counts={[]} runs={runs} deliveries={deliveries} request={request} onChanged={() => {}} />); });
    const form = renderer.root.findByProps({ "aria-label": "Record node event" });
    await act(async () => form.findAllByType("select")[1]!.props.onChange({ target: { value: "task-run" } }));
    await act(async () => form.findByType("textarea").props.onChange({ target: { value: "New reason" } }));
    await act(async () => form.props.onSubmit({ preventDefault() {} }));
    expect(content(renderer.root)).toContain("409");
    expect(form.findByType("button").props.disabled).toBe(true);
    await act(async () => renderer.root.findAllByType("button").find((node) => content(node) === "Refresh history")!.props.onClick());
    expect(content(renderer.root)).toContain("Original different reason");
    expect(content(renderer.root)).toContain(original!.id);
    expect(content(renderer.root)).not.toContain("Event recorded.");
    expect(form.findByType("button").props.disabled).toBe(true);
    await act(async () => renderer.root.findAllByType("button").find((node) => content(node) === "Discard conflicting declaration")!.props.onClick());
    expect(form.findByType("textarea").props.disabled).toBe(false);
  } finally { await act(async () => renderer?.unmount()); }
});
