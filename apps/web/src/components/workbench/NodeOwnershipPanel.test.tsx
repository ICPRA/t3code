import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { NodeOwnershipPanel } from "../../../../../../project-workbench/extensions/workbench-ui/src/NodeOwnershipPanel";

const operation = (body: Record<string, unknown>, status = "pending") => ({
  id: "own-1", taskSlug: "work", idempotencyKey: body.idempotencyKey ?? "key-1", action: "take", status,
  beforeOwnerUserId: null, afterOwnerUserId: status === "committed" ? "human-1" : null,
  fromVersion: 2, toVersion: status === "committed" ? 3 : undefined, actorUserId: "human-1", reason: body.reason ?? "take",
  dispatches: [] as Array<Record<string, unknown>>, preparations: [], frozenClaim: null, handoffs: [], preparedHandoffs: [], claimHandoff: null, createdAt: "now",
});
const state = (pending?: ReturnType<typeof operation>, owner: string | null = null) => ({
  taskSlug: "work", version: pending ? 2 : owner ? 3 : 2, humanOwnerUserId: owner, currentClaim: null,
  ...(pending ? { pending } : {}), dispatchObservations: [], preparationObservations: [],
});
let renderer: ReactTestRenderer | undefined;
let storage: Map<string, string>;
const content = (node: ReactTestInstance | string = renderer!.root): string => typeof node === "string" ? node : node.children.map(content).join("");
const button = (label: string) => renderer!.root.findAllByType("button").find((node) => content(node) === label)!;
async function change(label: string, value: string | boolean) {
  await act(async () => renderer!.root.findByProps({ "aria-label": label }).props.onChange({ target: typeof value === "boolean" ? { checked: value } : { value } }));
}
async function mount(request: (url: string, init?: RequestInit) => Promise<Response>, taskSlug = "work", role: "work" | "summary" = "work", stage = "active") {
  await act(async () => { renderer = create(<NodeOwnershipPanel project="project" taskSlug={taskSlug} role={role} stage={stage} events={[]}
    language="en" request={request} onChanged={() => {}} onOpenRun={() => {}} />); });
}
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => { await act(async () => renderer?.unmount()); vi.unstubAllGlobals(); });

it("begins takeover with exact CAS and later permits return even for a completed summary node", async () => {
  let current = state();
  const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)); writes.push({ url, body });
      if (url.endsWith("/take-begin")) { current = state(undefined, "human-1"); return Response.json(operation(body, "committed")); }
      return Response.json({ ...operation(body, "committed"), action: "return", beforeOwnerUserId: "human-1", afterOwnerUserId: null, fromVersion: 3, toVersion: 4 });
    }
    return Response.json(current);
  });
  await mount(request);
  await change("Node owner take reason", "I will handle this"); await change("Confirm node owner take", true);
  await act(async () => button("I will handle this: begin named takeover").props.onClick());
  expect(writes[0]).toMatchObject({ url: "/workbench-api/loop/node-ownership/take-begin", body: { taskSlug: "work", expectedVersion: 2, expectedOwnerUserId: null, reason: "I will handle this" } });
  expect(storage.size).toBe(0);
  await act(async () => renderer?.unmount());
  await mount(request, "work", "summary", "done");
  expect(renderer!.root.findAllByProps({ "aria-label": "Node owner take reason" })).toHaveLength(0);
  await change("Node owner return reason", "Handoff complete"); await change("Confirm node owner return", true);
  await act(async () => button("Return for later AI dispatch").props.onClick());
  expect(writes[1]).toMatchObject({ url: "/workbench-api/loop/node-ownership/return", body: { expectedVersion: 3, expectedOwnerUserId: "human-1", reason: "Handoff complete" } });
  expect(writes.every((item) => !item.url.includes("start"))).toBe(true);
});

it("keeps a lost original begin across remount and blocks another node until the original history is observed", async () => {
  let original: Record<string, unknown> | null = null;
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { original = JSON.parse(String(init.body)); throw new Error("receipt lost"); }
    if (url.endsWith("/history")) return Response.json({ taskSlug: "work", operations: original ? [operation(original)] : [], hasMore: false, nextCursor: null });
    return Response.json({ ...state(), taskSlug: url.includes("/other") ? "other" : "work" });
  });
  await mount(request);
  await change("Node owner take reason", "take"); await change("Confirm node owner take", true);
  await act(async () => button("I will handle this: begin named takeover").props.onClick());
  expect(storage.size).toBe(1);
  await act(async () => renderer?.unmount());
  await mount(request, "other");
  expect(content()).toContain("Resolve the original request for another node first: project / work");
  expect(button("I will handle this: begin named takeover").props.disabled).toBe(true);
  await act(async () => renderer?.unmount());
  await mount(request);
  expect(storage.size).toBe(0);
  expect(content()).toContain("Original owner action observed; actual actor: human-1");
  expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("freezes a lost program stop and reconciles by the original admission and named stop note", async () => {
  const pending = { ...operation({}), dispatches: [{ runId: "program", admissionId: "admission", executorKind: "program", environmentId: "local", nativeProjectId: "native", attemptId: "attempt" }] };
  const observed = { ...state(pending), dispatchObservations: [{ runId: "program", admissionId: "admission", currentAttemptId: "attempt", programResult: null }] };
  let wrote = false;
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { wrote = true; throw new Error("receipt lost"); }
    if (url.endsWith("/dispatch")) return Response.json({ admission: { id: "admission", runId: "program" }, resolution: { kind: "isolated_workspace" }, stopConfirmation: { actor: "human-2", note: "process tree checked", confirmedAt: "now", programAttemptId: "attempt" } });
    return Response.json(observed);
  });
  await mount(request);
  await change("Program stop note program", "process tree checked"); await change("Confirm program stopped program", true);
  await act(async () => button("Record named original program stop").props.onClick());
  expect(wrote).toBe(true); expect(storage.size).toBe(1);
  await act(async () => renderer?.unmount());
  await mount(request);
  expect(storage.size).toBe(0);
  expect(content()).toContain("Original program stop observed; actual actor: human-2");
});

it("does not reconcile a stop for a different program attempt even with the same run, admission and note", async () => {
  const body = { runId: "program", admissionId: "admission", attemptId: "attempt-old", environmentId: "local", nativeProjectId: "native", note: "process tree checked" };
  storage.set("workbench.pending-node-owner.v1", JSON.stringify({ project: "project", taskSlug: "work", pending: { action: "program-stop", body } }));
  const request = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith("/dispatch")
    ? Response.json({ admission: { id: "admission", runId: "program" }, resolution: { kind: "isolated_workspace" }, stopConfirmation: { actor: "human-2", note: body.note, confirmedAt: "now", programAttemptId: "attempt-new" } })
    : Response.json(state()));
  await mount(request);
  expect(storage.size).toBe(1);
  expect(content()).toContain("different stop record; request remains frozen");
  expect(request.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
});

it("accepts an exact stop receipt after prior workspace isolation without rewriting that release history", async () => {
  const pending = { ...operation({}), dispatches: [{ runId: "program", admissionId: "admission", executorKind: "program", environmentId: "local", nativeProjectId: "native", attemptId: "attempt" }] };
  const request = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
    ? Response.json({ admission: { id: "admission", runId: "program" }, resolution: { kind: "isolated_workspace" },
      stopConfirmation: { actor: "human-2", note: "process tree checked", confirmedAt: "now", programAttemptId: "attempt" } })
    : Response.json({ ...state(pending), dispatchObservations: [{ runId: "program", admissionId: "admission", currentAttemptId: "attempt", programResult: null }] }));
  await mount(request);
  await change("Program stop note program", "process tree checked"); await change("Confirm program stopped program", true);
  await act(async () => button("Record named original program stop").props.onClick());
  expect(storage.size).toBe(0);
  expect(content()).toContain("Human stop observation recorded for the exact program attempt");
});

it("requires observed stop and release in addition to a program result before commit", async () => {
  const pending = { ...operation({}), dispatches: [{ runId: "program", admissionId: "admission", executorKind: "program", environmentId: "local", nativeProjectId: "native", attemptId: "attempt" }] };
  const result = { outcome: "exited", exitCode: 0, summary: "result" };
  let stopped = false;
  const posts: Record<string, unknown>[] = [];
  const request = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") { const body = JSON.parse(String(init.body)); posts.push(body); return Response.json({ ...pending, status: "committed", toVersion: 3, handoffs: body.handoffs }); }
    return Response.json({ ...state(pending), dispatchObservations: [{ runId: "program", admissionId: "admission", currentAttemptId: "attempt", programResult: result,
      ...(stopped ? { stopConfirmedAt: "now", releaseKind: "stopped_writing" } : {}) }] });
  });
  await mount(request);
  await change("Owner summary kind dispatch:program", "program_result");
  expect(content()).toContain("Recorded attempt result (not stop proof)");
  expect(button("Commit takeover using original facts").props.disabled).toBe(true);
  stopped = true;
  await act(async () => button("Read original owner and handoff observations").props.onClick());
  expect(button("Commit takeover using original facts").props.disabled).toBe(false);
  await act(async () => button("Commit takeover using original facts").props.onClick());
  expect(posts[0]).toMatchObject({ operationId: "own-1", expectedVersion: 2, handoffs: [{ runId: "program", admissionId: "admission", summary: { kind: "program_result", attemptId: "attempt" } }] });
});

it("keeps an older frozen takeover readable after the node version advances and commits against the fresh version", async () => {
  const pending = { ...operation({}), dispatches: [{ runId: "program", admissionId: "admission", executorKind: "program", environmentId: "local", nativeProjectId: "native", attemptId: "attempt" }] };
  let posted: Record<string, unknown> | null = null;
  const request = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted = JSON.parse(String(init.body));
      return Response.json({ ...pending, status: "committed", toVersion: 5, handoffs: posted!.handoffs });
    }
    return Response.json({ ...state(pending), version: 4, dispatchObservations: [{ runId: "program", admissionId: "admission", currentAttemptId: "attempt",
      programResult: { outcome: "exited", exitCode: 0, summary: "result" }, stopConfirmedAt: "now", releaseKind: "stopped_writing" }] });
  });
  await mount(request);
  expect(content()).toContain("Current human owner: none · v4");
  expect(content()).toContain("Take operation: own-1");
  await change("Owner summary kind dispatch:program", "program_result");
  expect(button("Commit takeover using original facts").props.disabled).toBe(false);
  await act(async () => button("Commit takeover using original facts").props.onClick());
  expect(posted).toMatchObject({ operationId: "own-1", expectedVersion: 4, handoffs: [{ runId: "program", admissionId: "admission", summary: { kind: "program_result", attemptId: "attempt" } }] });
  expect(content()).not.toContain("Node owner scope or response mismatch");
});

it("offers only an explicit identical retry when an uncertain commit is still pending", async () => {
  const body = { operationId: "own-1", expectedVersion: 2, handoffs: [], preparedHandoffs: [], claimHandoff: null };
  storage.set("workbench.pending-node-owner.v1", JSON.stringify({ project: "project", taskSlug: "work", pending: { action: "take-commit", body } }));
  const posted: Record<string, unknown>[] = [];
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posted.push(JSON.parse(String(init.body))); return Response.json({ ...operation({}), status: "committed", toVersion: 3 }); }
    if (url.endsWith("/history")) return Response.json({ taskSlug: "work", operations: [operation({})], hasMore: false, nextCursor: null });
    return Response.json(state(operation({})));
  });
  await mount(request);
  expect(button("Explicitly retry original request")).toBeDefined();
  expect(posted).toHaveLength(0);
  await act(async () => button("Explicitly retry original request").props.onClick());
  expect(posted).toEqual([body]); expect(storage.size).toBe(0);
});

it("fails closed on a corrupt recovery record and clears a definite CAS rejection before new review", async () => {
  storage.set("workbench.pending-node-owner.v1", JSON.stringify({ project: "project", taskSlug: "work", pending: { action: "take-begin", body: {} } }));
  const request = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST" ? Response.json({}, { status: 409 }) : Response.json(state()));
  await mount(request);
  expect(content()).toContain("Recovery record unreadable; no new request sent");
  expect(button("I will handle this: begin named takeover").props.disabled).toBe(true);
  await act(async () => renderer?.unmount());
  storage.clear();
  await mount(request);
  await change("Node owner take reason", "stale baseline"); await change("Confirm node owner take", true);
  await act(async () => button("I will handle this: begin named takeover").props.onClick());
  expect(storage.size).toBe(0);
  expect(content()).toContain("HTTP 409");
  expect(renderer!.root.findAllByProps({ "aria-label": "Node owner take reason" })).toHaveLength(0);
  expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});
