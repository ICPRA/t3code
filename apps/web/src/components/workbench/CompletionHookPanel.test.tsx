import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { CompletionHookPanel } from "../../../../../../project-workbench/extensions/workbench-ui/src/CompletionHookPanel";
import type { CompletionHookSummary, WorkbenchRun } from "./workbenchModel";

const source = { id: "source-spec-id", slug: "source", role: "work" as const, stage: "done" };
const run: WorkbenchRun = { id: "program", taskSlug: "target", packageId: "target-package", generation: 1, threadRef: "", workspace: "C:/target", state: "prepared",
  executorKind: "program", environmentId: "local", nativeProjectId: "native", createdAt: "now", updatedAt: "now" };
const context = { runId: "program", taskSlug: "target", packageId: "target-package", body: { program_target: {
  executable: "synthetic.exe", args: ["--check"], cwd: "C:/target", timeoutMs: 5000, workPurpose: "investigation", environmentId: "local", nativeProjectId: "native", qaBasis: null } } };
const fact = { kind: "execution" as const, id: "completion-1" };
function hook(body: Record<string, unknown>, state = "pending") {
  return { id: "hook-original", project: "project", sourceTaskSlug: "source", sourceSpecId: "source-spec-id", sourceRole: "work", targetRunId: "program", targetPackageId: "target-package",
    configuredByUserId: "human", hostConsumerUserId: "service", idempotencyKey: String(body.idempotencyKey ?? "original-key"), requestedFact: (body.fact ?? null) as typeof fact | null, fact: (body.fact ?? null) as typeof fact | null,
    state, createdAt: "now", triggeredAt: body.fact ? "now" : null, cancelledAt: null as string | null, cancelledByUserId: null as string | null, cancellationReason: null as string | null,
    dispatchStatus: null as string | null, dispatchDetail: null, retriedAt: null as string | null, programAdmissionId: null as string | null, admission: null as unknown };
}
function meta(value: ReturnType<typeof hook>): CompletionHookSummary { return { id: value.id, sourceTaskSlug: value.sourceTaskSlug, sourceSpecId: value.sourceSpecId,
  targetRunId: value.targetRunId, targetPackageId: value.targetPackageId, targetTaskSlug: "target", idempotencyKey: value.idempotencyKey as string,
  requestedFact: value.requestedFact as typeof fact | null, createdAt: value.createdAt, triggeredAt: value.triggeredAt, cancelledAt: value.cancelledAt,
  fact: value.fact as typeof fact | null, state: value.state, dispatchStatus: value.dispatchStatus, programAdmissionId: value.programAdmissionId }; }
let renderer: ReactTestRenderer | undefined;
let storage: Map<string, string>;
function content(node: ReactTestInstance | string = renderer!.root): string { return typeof node === "string" ? node : node.children.map(content).join(""); }
function button(label: string) { return renderer!.root.findAllByType("button").find((entry) => content(entry) === label)!; }
async function change(label: string, value: string | boolean) { await act(async () => renderer!.root.findByProps({ "aria-label": label }).props.onChange({ target: typeof value === "boolean" ? { checked: value } : { value } })); }
async function mount(request: (url: string, init?: RequestInit) => Promise<Response>, props: Partial<Parameters<typeof CompletionHookPanel>[0]> = {}) {
  await act(async () => { renderer = create(<CompletionHookPanel project="project" source={source} runs={[run]} events={[{ id: fact.id, type: "completion", agent: "run-source" }]}
    manualCompletions={[{ id: "manual-1", actor: "human", createdAt: "now" }]} hooks={[]} language="en" request={request} onChanged={() => {}} {...props} />); });
}
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => { await act(async () => renderer?.unmount()); vi.unstubAllGlobals(); });

it("reads the fixed prepared program, invalidates confirmation on target/fact edits, and arms without manual start", async () => {
  let posted: Record<string, unknown> | null = null;
  const request = vi.fn(async (url: string, init?: RequestInit) => init?.method === "POST"
    ? (posted = JSON.parse(String(init.body)), Response.json(hook(posted!)))
    : Response.json(url.endsWith("/context") ? context : { admission: null, cancellation: null }));
  const other: WorkbenchRun = { ...run, id: "other-program", packageId: "other-package" };
  await mount(request, { runs: [run, other] });
  await change("Completion hook target", "program");
  expect(button("Arm human completion trigger").props.disabled).toBe(true);
  await act(async () => button("Read original program preparation and admission").props.onClick());
  expect(content()).toContain("synthetic.exe"); expect(content()).toContain("C:/target");
  await change("Completion hook fact", "execution:completion-1");
  await change("Confirm completion hook", true);
  expect(button("Arm human completion trigger").props.disabled).toBe(false);
  await change("Completion hook fact", "manual:manual-1");
  expect(renderer!.root.findByProps({ "aria-label": "Confirm completion hook" }).props.checked).toBe(false);
  await change("Completion hook target", "other-program");
  expect(renderer!.root.findAllByProps({ "aria-label": "Completion hook program preview" })).toHaveLength(0);
  await change("Completion hook target", "program"); await act(async () => button("Read original program preparation and admission").props.onClick());
  await change("Completion hook fact", "execution:completion-1"); await change("Confirm completion hook", true);
  await act(async () => button("Arm human completion trigger").props.onClick());
  expect(posted).toMatchObject({ sourceTaskSlug: "source", sourceSpecId: "source-spec-id", targetRunId: "program", targetPackageId: "target-package", confirmTrigger: true, fact });
  expect(posted).toHaveProperty("idempotencyKey");
  expect(posted).not.toHaveProperty("hostCredential");
  expect(request.mock.calls.filter(([url]) => url.includes("/start"))).toHaveLength(0);
});

it("reconciles a lost arm only by the original key and requested fact, including cancelled history", async () => {
  let posted: Record<string, unknown> | null = null;
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posted = JSON.parse(String(init.body)); throw new Error("receipt lost"); }
    if (url.endsWith("/context")) return Response.json(context);
    if (url.endsWith("/dispatch")) return Response.json({ admission: null, cancellation: null });
    if (url.includes("/wb/specs/")) return Response.json({ spec: { id: source.id, slug: source.slug }, completionHooks: [meta({ ...hook(posted!), state: "cancelled", cancelledAt: "later" })] });
    if (url.includes("/completion-hooks/hook-original")) return Response.json({ hook: { ...hook(posted!), state: "cancelled", cancelledAt: "later" } });
    throw new Error("Unexpected read");
  });
  await mount(request);
  await change("Completion hook target", "program"); await act(async () => button("Read original program preparation and admission").props.onClick());
  await change("Confirm completion hook", true); await act(async () => button("Arm human completion trigger").props.onClick());
  expect(content()).toContain("Original request frozen");
  await act(async () => button("Read original source hooks").props.onClick());
  expect(content()).toContain("Original configuration observed; actual recorder: human · cancelled");
  expect(content()).not.toContain("Original request frozen");
  expect(renderer!.root.findByProps({ "aria-label": "Confirm completion hook" }).props.checked).toBe(false);
  expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("never offers a revoked summary as a current fact and keeps waiting-for-later available", async () => {
  let accepted = true;
  const request = vi.fn(async (url: string) => Response.json(url.includes("/summaries/") ? { summary: { goalSlug: "source", accepted,
    latestAcceptance: { id: "summary-acceptance", current: accepted, revokedAt: accepted ? null : "later" } } } : {}));
  await mount(request, { source: { ...source, role: "summary", stage: "approved" }, events: [], manualCompletions: [] });
  await act(async () => button("Read current summary acceptance").props.onClick());
  expect(content()).toContain("Current accepted summary · summary-acceptance");
  await change("Completion hook fact", "summary:summary-acceptance");
  accepted = false; await act(async () => button("Read current summary acceptance").props.onClick());
  expect(renderer!.root.findByProps({ "aria-label": "Completion hook fact" }).props.value).toBe("");
  expect(content()).not.toContain("Current accepted summary · summary-acceptance");
  expect(content()).toContain("Wait for a later original completion fact");
});

it("cancels only an unadmitted hook and retries only the same blocked hook without changing target or fact", async () => {
  const blocked = { ...hook({ idempotencyKey: "original-key", fact }, "blocked"), dispatchStatus: "blocked" };
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json(url.endsWith("/retry") ? { ...blocked, state: "pending", dispatchStatus: null, retriedAt: "later" }
      : { ...blocked, state: "cancelled", cancelledAt: "later", cancelledByUserId: "human", cancellationReason: "No longer applicable" });
    return Response.json({ hook: blocked });
  });
  await mount(request, { hooks: [meta(blocked)] });
  await act(async () => button("hook-original · program · blocked").props.onClick());
  await act(async () => button("Retry original hook readiness (no restart)").props.onClick());
  expect(JSON.parse(String(request.mock.calls.find(([, init]) => init?.method === "POST")![1]!.body))).toEqual({ hookId: "hook-original" });
  expect(content()).toContain("no new target or program restart");
  await change("Completion hook cancel reason", "No longer applicable"); await change("Confirm completion hook cancellation", true);
  await act(async () => button("Cancel confirmation").props.onClick());
  expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  await change("Confirm completion hook cancellation", true); await act(async () => button("Cancel unadmitted hook").props.onClick());
  expect(JSON.parse(String(request.mock.calls.filter(([, init]) => init?.method === "POST")[1]![1]!.body))).toEqual({ hookId: "hook-original", reason: "No longer applicable" });
  expect(content()).toContain("not proof that a running program stopped");
});

it("keeps a bad arm receipt frozen and retries only the original key after reading an empty source list", async () => {
  let posted: Record<string, unknown> | null = null;
  let writes = 0;
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted = JSON.parse(String(init.body)); writes++;
      return Response.json(writes === 1 ? { ...hook(posted!), sourceSpecId: "wrong-source-id" } : hook(posted!));
    }
    if (url.endsWith("/context")) return Response.json(context);
    if (url.endsWith("/dispatch")) return Response.json({ admission: null, cancellation: null });
    if (url.includes("/wb/specs/")) return Response.json({ spec: { id: source.id, slug: source.slug }, completionHooks: [] });
    throw new Error("Unexpected read");
  });
  await mount(request);
  await change("Completion hook target", "program"); await act(async () => button("Read original program preparation and admission").props.onClick());
  await change("Confirm completion hook", true); await act(async () => button("Arm human completion trigger").props.onClick());
  const original = posted;
  expect(content()).toContain("Original request frozen");
  expect(content()).not.toContain("Original completion trigger recorded");
  await act(async () => button("Read original source hooks").props.onClick());
  expect(button("Explicitly retry original request")).toBeDefined();
  expect(writes).toBe(1);
  await act(async () => button("Explicitly retry original request").props.onClick());
  expect(posted).toEqual(original);
  expect(writes).toBe(2);
  expect(content()).toContain("Original completion trigger recorded");
});

it("does not offer stale work completion facts or cancellation after an admission", async () => {
  const admitted = { ...hook({ idempotencyKey: "original-key", fact }, "admitted"), programAdmissionId: "admission", admission: { id: "admission" } };
  const request = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ hook: admitted }));
  await mount(request, { source: { ...source, stage: "in_progress" }, hooks: [{ ...meta(admitted), programAdmissionId: "admission" }] });
  expect(content()).not.toContain("Original execution completion · completion-1");
  await act(async () => button("hook-original · program · admitted").props.onClick());
  expect(button("Cancel unadmitted hook")).toBeUndefined();
  expect(button("Retry original hook readiness (no restart)")).toBeUndefined();
  expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
});

it("drops stale hook controls after a definitive retry rejection or a failed detail read", async () => {
  const blocked = { ...hook({ idempotencyKey: "original-key", fact }, "blocked"), dispatchStatus: "blocked" };
  let failRead = false;
  const request = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST" ? Response.json({ code: "conflict" }, { status: 409 })
    : failRead ? Response.json({ code: "unavailable" }, { status: 503 }) : Response.json({ hook: blocked }));
  await mount(request, { hooks: [meta(blocked)] });
  await act(async () => button("hook-original · program · blocked").props.onClick());
  expect(button("Retry original hook readiness (no restart)")).toBeDefined();
  await act(async () => button("Retry original hook readiness (no restart)").props.onClick());
  expect(content()).toContain("HTTP 409");
  expect(button("Retry original hook readiness (no restart)")).toBeUndefined();
  failRead = true;
  await act(async () => button("hook-original · program · blocked").props.onClick());
  expect(content()).toContain("HTTP 503");
  expect(button("Cancel unadmitted hook")).toBeUndefined();
});

it("restores one pending arm after remount and prevents another source from overwriting its key", async () => {
  let posted: Record<string, unknown> | null = null;
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posted = JSON.parse(String(init.body)); throw new Error("receipt lost"); }
    if (url.endsWith("/context")) return Response.json(context);
    if (url.endsWith("/dispatch")) return Response.json({ admission: null, cancellation: null });
    if (url.includes("/wb/specs/source")) return Response.json({ spec: { id: source.id, slug: source.slug }, completionHooks: [meta(hook(posted!))] });
    if (url.includes("/completion-hooks/hook-original")) return Response.json({ hook: hook(posted!) });
    throw new Error("Unexpected request");
  });
  await mount(request); await change("Completion hook target", "program");
  await act(async () => button("Read original program preparation and admission").props.onClick());
  await change("Confirm completion hook", true); await act(async () => button("Arm human completion trigger").props.onClick());
  const original = storage.values().next().value;
  expect(original).toContain(String(posted!.idempotencyKey));
  await act(async () => renderer!.unmount());
  await mount(request, { source: { id: "other-spec-id", slug: "other", role: "work", stage: "done" }, events: [], manualCompletions: [] });
  expect(content()).toContain("Resolve the original pending request for another source first: project / source / source-spec-id");
  expect(button("Arm human completion trigger").props.disabled).toBe(true);
  expect(storage.values().next().value).toBe(original);
  expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  await act(async () => renderer!.unmount());
  await mount(request);
  expect(content()).toContain("Original request frozen");
  await act(async () => button("Read original source hooks").props.onClick());
  expect(content()).toContain("Original configuration observed; actual recorder: human");
  expect(content()).not.toContain("Original request frozen");
  expect(storage.size).toBe(0);
  expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("does not submit when recovery is malformed or cannot be saved", async () => {
  const request = vi.fn(async (url: string, init?: RequestInit) => Response.json(url.endsWith("/context") ? context : { admission: null, cancellation: null }));
  storage.set("workbench.pending-completion-hook.v1", JSON.stringify({ project: "project", sourceSlug: "source", sourceSpecId: "source-spec-id",
    pending: { action: "arm", body: { sourceTaskSlug: "source", sourceSpecId: "source-spec-id", targetRunId: "program", targetPackageId: "target-package", idempotencyKey: "key", confirmTrigger: true,
      fact: { kind: "invented", id: "not-a-fact" } } } }));
  await mount(request);
  expect(content()).toContain("Recovery record cannot be read; no new request was created");
  expect(button("Arm human completion trigger").props.disabled).toBe(true);
  await act(async () => renderer!.unmount());
  storage.clear();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: () => { throw new Error("storage unavailable"); }, removeItem: (key: string) => storage.delete(key) });
  await mount(request); await change("Completion hook target", "program");
  await act(async () => button("Read original program preparation and admission").props.onClick());
  await change("Confirm completion hook", true);
  await act(async () => button("Arm human completion trigger").props.onClick());
  expect(content()).toContain("Recovery record could not be saved; no new request was sent");
  expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
});

it("restores an uncertain cancel against the same fixed hook after remount", async () => {
  const armed = hook({ idempotencyKey: "original-key", fact }, "pending");
  const cancelled = { ...armed, state: "cancelled", cancelledAt: "later", cancelledByUserId: "human", cancellationReason: "Withdraw trigger" };
  let written = false;
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { written = true; throw new Error("receipt lost"); }
    if (url.includes("/wb/specs/")) return Response.json({ spec: { id: source.id, slug: source.slug }, completionHooks: [meta(written ? cancelled : armed)] });
    if (url.includes("/completion-hooks/hook-original")) return Response.json({ hook: written ? cancelled : armed });
    throw new Error("Unexpected request");
  });
  await mount(request, { hooks: [meta(armed)] });
  await act(async () => button("hook-original · program · pending").props.onClick());
  await change("Completion hook cancel reason", "Withdraw trigger"); await change("Confirm completion hook cancellation", true);
  await act(async () => button("Cancel unadmitted hook").props.onClick());
  expect(content()).toContain("Original request frozen");
  await act(async () => renderer!.unmount());
  await mount(request, { hooks: [meta(armed)] });
  expect(content()).toContain("Original request frozen");
  await act(async () => button("Read original source hooks").props.onClick());
  expect(content()).toContain("Matching original hook state observed");
  expect(storage.size).toBe(0);
  expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});
