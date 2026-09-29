import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { CandidateLoopPanel } from "../../../../../../project-workbench/extensions/workbench-ui/src/CandidateLoopPanel";
import type { WorkbenchRun } from "./workbenchModel";

const run: WorkbenchRun = { id: "run-original", taskSlug: "task", packageId: "package", generation: 1, threadRef: "", workspace: "", state: "bound", createdAt: "now", updatedAt: "now",
  candidateLoop: { status: "needs_human", maxAttempts: 2, attemptId: "attempt-2", attemptOrdinal: 2, deliveryId: "delivery-2", configuredBy: "operator" } };
const original = { runId: run.id, taskSlug: run.taskSlug, packageId: run.packageId, maxAttempts: 2, configuredBy: "operator", configuredAt: "now",
  terminationKind: "report",
  planSources: [{ kind: "specgraph", specSlug: "task", field: "test_plan", changeId: "change-1" }],
  attempts: [{ id: "attempt-1", number: 1, grantedAt: "before", deliveryId: "delivery-1" }, { id: "attempt-2", number: 2, grantedAt: "now", deliveryId: "delivery-2",
    consumedCondition: { value: "false", reason: "failed", reports: [{ id: "report-1", deliveryId: "delivery-1", commitSha: "abc", status: "failed", createdAt: "before" }], missingPlans: [] } }],
  currentAttempt: { id: "attempt-2", number: 2, grantedAt: "now", deliveryId: "delivery-2" },
  condition: { value: "false", reason: "failed", reports: [{ id: "report-2", deliveryId: "delivery-2", commitSha: "def", status: "failed", createdAt: "now" }], missingPlans: [] }, status: "needs_human" };
let renderer: ReactTestRenderer | undefined;
let storage: Map<string, string>;
const request = vi.fn();
function button(label: string) { return renderer!.root.findAllByType("button").find((entry) => entry.children.includes(label))!; }
async function submit(label: string) { await act(async () => button(label).parent!.props.onSubmit({ preventDefault() {} })); }
function content(node: ReactTestInstance | string = renderer!.root): string { return typeof node === "string" ? node : node.children.map(content).join(""); }
async function mount(props: Partial<Parameters<typeof CandidateLoopPanel>[0]> = {}) { await act(async () => { renderer = create(<CandidateLoopPanel project="project" run={run} language="en" request={request} onChanged={() => {}} {...props} />); }); }
beforeEach(() => { storage = new Map(); vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => { await act(async () => renderer?.unmount()); request.mockReset(); vi.unstubAllGlobals(); });

it("reads the exact candidate run without a model or host and displays fixed references", async () => {
  request.mockResolvedValueOnce(Response.json(original)); await mount();
  await act(async () => button("Read original candidate loop").props.onClick());
  expect(request).toHaveBeenCalledWith("/workbench-api/loop/candidate-loops/run-original", expect.objectContaining({ headers: { "X-Specgraph-Project": "project" } }));
  expect(content()).toContain("SpecGraph: task / test_plan / change-1");
  expect(content()).toContain("report-2"); expect(content()).toContain("delivery-2");
  expect(request).toHaveBeenCalledTimes(1);
});

it("requires an explicit pre-dispatch satisfaction mode, fixed plan, criterion and confirmation before human arm", async () => {
  const { candidateLoop: _loop, ...baseRun } = run;
  const unconfigured = { ...baseRun, executorKind: "agent" as const, workPurpose: "implementation", state: "prepared" };
  const plan = { kind: "specgraph", specSlug: "task", field: "test_plan", changeId: "change-1" };
  request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/context")) return Response.json({ runId: run.id, taskSlug: run.taskSlug, packageId: run.packageId,
      body: { workspace: "C:/project", dispatch_target: { workPurpose: "implementation", qaBasis: { testPlanSources: [plan] } } } });
    if (url.endsWith("/dispatch")) return Response.json({ admission: null, cancellation: null });
    if (init?.method === "POST") return Response.json({ ...original, configuredBy: "user:operator", terminationKind: "satisfaction", satisfaction: { criterion: "Accepted design and tests", value: "unknown" }, maxAttempts: 3 });
    throw new Error("Unexpected operation");
  });
  await mount({ run: unconfigured });
  expect(button("Arm formal candidate loop").props.disabled).toBe(true);
  await act(async () => button("Read original implementation package and admission").props.onClick());
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate plan 1" }).props.onChange({ target: { checked: true } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate max attempts" }).props.onChange({ target: { value: "3" } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate termination mode" }).props.onChange({ target: { value: "satisfaction" } }));
  expect(button("Arm formal candidate loop").props.disabled).toBe(true);
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate satisfaction criterion" }).props.onChange({ target: { value: "Accepted design and tests" } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Confirm candidate setup" }).props.onChange({ target: { checked: true } }));
  await act(async () => button("Arm formal candidate loop").props.onClick());
  expect(JSON.parse(request.mock.calls.find(([url]) => url.endsWith("/arm"))![1].body)).toEqual({ runId: run.id, maxAttempts: 3, planSources: [plan], terminationKind: "satisfaction", satisfactionCriterion: "Accepted design and tests" });
  expect(content()).toContain("Formal candidate loop");
  expect(request.mock.calls.some(([url]) => url.includes("/start"))).toBe(false);
});

it("keeps report termination explicit and omits a stale satisfaction criterion after switching modes", async () => {
  const { candidateLoop: _loop, ...baseRun } = run;
  const unconfigured = { ...baseRun, executorKind: "agent" as const, workPurpose: "implementation", state: "prepared" };
  const plan = { kind: "specgraph", specSlug: "task", field: "test_plan", changeId: "change-1" };
  request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/context")) return Response.json({ runId: run.id, taskSlug: run.taskSlug, packageId: run.packageId,
      body: { dispatch_target: { workPurpose: "implementation", qaBasis: { testPlanSources: [plan] } } } });
    if (url.endsWith("/dispatch")) return Response.json({ admission: null, cancellation: null });
    if (init?.method === "POST") return Response.json({ ...original, configuredBy: "user:operator", maxAttempts: 3 });
    throw new Error("Unexpected operation");
  });
  await mount({ run: unconfigured });
  await act(async () => button("Read original implementation package and admission").props.onClick());
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate plan 1" }).props.onChange({ target: { checked: true } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate max attempts" }).props.onChange({ target: { value: "3" } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate termination mode" }).props.onChange({ target: { value: "satisfaction" } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate satisfaction criterion" }).props.onChange({ target: { value: "Stale criterion" } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Confirm candidate setup" }).props.onChange({ target: { checked: true } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate termination mode" }).props.onChange({ target: { value: "report" } }));
  expect(renderer!.root.findByProps({ "aria-label": "Confirm candidate setup" }).props.checked).toBe(false);
  await act(async () => renderer!.root.findByProps({ "aria-label": "Confirm candidate setup" }).props.onChange({ target: { checked: true } }));
  await act(async () => button("Arm formal candidate loop").props.onClick());
  const body = JSON.parse(request.mock.calls.find(([url]) => url.endsWith("/arm"))![1].body);
  expect(body.terminationKind).toBe("report");
  expect(body).not.toHaveProperty("satisfactionCriterion");
});

it("restores an uncertain human arm on the same run and observes its fixed policy without reposting", async () => {
  const { candidateLoop: _loop, ...baseRun } = run;
  const unconfigured = { ...baseRun, executorKind: "agent" as const, workPurpose: "implementation", state: "prepared" };
  const plan = { kind: "specgraph", specSlug: "task", field: "test_plan", changeId: "change-1" };
  let posted: Record<string, unknown> | null = null;
  request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posted = JSON.parse(String(init.body)); throw new Error("receipt lost"); }
    if (url.endsWith("/context")) return Response.json({ runId: run.id, taskSlug: run.taskSlug, packageId: run.packageId,
      body: { dispatch_target: { workPurpose: "implementation", qaBasis: { testPlanSources: [plan] } } } });
    if (url.endsWith("/dispatch")) return Response.json({ admission: null, cancellation: null });
    return Response.json({ ...original, configuredBy: "user:human", maxAttempts: 3, planSources: [plan] });
  });
  await mount({ run: unconfigured });
  await act(async () => button("Read original implementation package and admission").props.onClick());
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate plan 1" }).props.onChange({ target: { checked: true } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate max attempts" }).props.onChange({ target: { value: "3" } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate termination mode" }).props.onChange({ target: { value: "report" } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Confirm candidate setup" }).props.onChange({ target: { checked: true } }));
  await act(async () => button("Arm formal candidate loop").props.onClick());
  expect(storage.values().next().value).toContain(String(posted!.runId));
  await act(async () => renderer!.unmount());
  await mount({ run: unconfigured });
  expect(content()).toContain("Original configuration request frozen");
  await act(async () => button("Read original candidate loop").props.onClick());
  expect(content()).not.toContain("Original configuration request frozen");
  expect(storage.size).toBe(0);
  expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("records human stop only for the read original run and checks its receipt", async () => {
  request.mockResolvedValueOnce(Response.json(original)); await mount();
  await act(async () => button("Read original candidate loop").props.onClick());
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate loop reason" }).props.onChange({ target: { value: "No more candidates" } }));
  request.mockResolvedValueOnce(Response.json({ ...original, status: "condition_met", stop: { actorUserId: "human", reason: "No more candidates", recordedAt: "later" } }));
  await submit("Stop future candidates (not physical shutdown)");
  expect(JSON.parse(request.mock.calls[1]![1].body)).toEqual({ runId: "run-original", reason: "No more candidates" });
  expect(content()).toContain("Future candidates stopped (not physical shutdown)");
  expect(renderer!.root.findByProps({ "aria-label": "Candidate loop reason" })).toBeDefined();
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate loop reason" }).props.onChange({ target: { value: "End budget after stop" } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Confirm candidate budget abandonment" }).props.onChange({ target: { checked: true } }));
  request.mockResolvedValueOnce(Response.json({ ...original, status: "abandoned", abandon: { actorUserId: "human", reason: "End budget after stop", recordedAt: "later" } }));
  await submit("Abandon candidate budget");
  expect(JSON.parse(request.mock.calls[2]![1].body)).toEqual({ runId: "run-original", reason: "End budget after stop" });
});

it("requires abandonment confirmation, freezes uncertain writes, and re-reads before retry", async () => {
  request.mockResolvedValueOnce(Response.json(original)); await mount();
  await act(async () => button("Read original candidate loop").props.onClick());
  expect(button("Abandon candidate budget").props.disabled).toBe(true);
  expect(button("Stop future candidates (not physical shutdown)").props.disabled).toBe(true);
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate loop reason" }).props.onChange({ target: { value: "Budget ended" } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Confirm candidate budget abandonment" }).props.onChange({ target: { checked: true } }));
  await act(async () => button("Cancel").props.onClick());
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => renderer!.root.findByProps({ "aria-label": "Confirm candidate budget abandonment" }).props.onChange({ target: { checked: true } }));
  request.mockRejectedValueOnce(new Error("receipt lost"));
  await submit("Abandon candidate budget");
  expect(content()).toContain("Original request frozen");
  expect(button("Abandon candidate budget")).toBeUndefined();
  request.mockResolvedValueOnce(Response.json(original));
  await act(async () => button("Read original candidate loop").props.onClick());
  expect(button("Abandon candidate budget")).toBeUndefined();
  expect(button("Explicitly retry original request")).toBeDefined();
  request.mockResolvedValueOnce(Response.json({ ...original, status: "abandoned", abandon: { actorUserId: "human", reason: "Budget ended", recordedAt: "later" } }));
  await act(async () => button("Explicitly retry original request").props.onClick());
  expect(JSON.parse(request.mock.calls[3]![1].body)).toEqual({ runId: "run-original", reason: "Budget ended" });
  expect(content()).toContain("not success or responsibility release");
});

it("does not offer abandonment on a completed candidate loop", async () => {
  request.mockResolvedValueOnce(Response.json({ ...original, status: "completed", completedAt: "later" })); await mount();
  await act(async () => button("Read original candidate loop").props.onClick());
  expect(button("Abandon candidate budget")).toBeUndefined();
});

it("does not clear an uncertain stop for a different recorded decision", async () => {
  request.mockResolvedValueOnce(Response.json(original)); await mount();
  await act(async () => button("Read original candidate loop").props.onClick());
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate loop reason" }).props.onChange({ target: { value: "My decision" } }));
  request.mockRejectedValueOnce(new Error("receipt lost"));
  await submit("Stop future candidates (not physical shutdown)");
  request.mockResolvedValueOnce(Response.json({ ...original, status: "stopped", stop: { actorUserId: "other-human", reason: "Different decision", recordedAt: "later" } }));
  await act(async () => button("Read original candidate loop").props.onClick());
  expect(content()).toContain("A different candidate loop decision was recorded");
  expect(content()).toContain("Original request frozen");
  expect(button("Explicitly retry original request")).toBeUndefined();
});

it("reconciles an uncertain stop only from the matching recorded decision", async () => {
  request.mockResolvedValueOnce(Response.json(original)); await mount();
  await act(async () => button("Read original candidate loop").props.onClick());
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate loop reason" }).props.onChange({ target: { value: "Original reason" } }));
  request.mockRejectedValueOnce(new Error("receipt lost"));
  await submit("Stop future candidates (not physical shutdown)");
  request.mockResolvedValueOnce(Response.json({ ...original, status: "stopped", stop: { actorUserId: "actual-human", reason: "Original reason", recordedAt: "later" } }));
  await act(async () => button("Read original candidate loop").props.onClick());
  expect(content()).toContain("Matching decision observed; actual recorder");
  expect(content()).toContain("actual-human");
  expect(content()).not.toContain("Original request frozen");
});

const joinEvaluation = { satisfied: false, reason: "member_waiting", participants: [{ runId: "branch-run", packageId: "branch-package", conditionKey: "plan-check", when: "true", state: "waiting" }], unknown: [],
  conditions: [{ key: "plan-check", evaluation: { value: "true", report: { id: "join-report", deliveryId: "delivery-2", commitSha: "abc", status: "passed", planSources: [], createdAt: "now" } } }], explicitSkip: false };

it("shows configured current join separately from a met report termination", async () => {
  request.mockResolvedValueOnce(Response.json({ ...original, status: "condition_met", condition: { ...original.condition, value: "true" },
    attempts: original.attempts.map((attempt, index) => index === 1 ? { ...attempt, flowId: "flow-current" } : attempt),
    currentAttempt: { ...original.currentAttempt, flowId: "flow-current" },
    join: { mode: "all", allowEmptySkip: false, flowId: "flow-current", evaluation: joinEvaluation, reason: "member_waiting" } }));
  await mount(); await act(async () => button("Read original candidate loop").props.onClick());
  expect(content()).toContain("Report termination met; current attempt join and original completion still required");
  expect(content()).toContain("Current attempt flow: flow-current");
  expect(content()).toContain("Current join: not satisfied");
  expect(content()).toContain("join-report");
  expect(content()).toContain("branch-run");
});

it("shows missing flow only when join is configured and does not call ready_next a grant", async () => {
  request.mockResolvedValueOnce(Response.json({ ...original, status: "ready_next", join: { mode: "any", allowEmptySkip: false, reason: "flow_missing" } }));
  await mount(); await act(async () => button("Read original candidate loop").props.onClick());
  expect(content()).toContain("Report-side condition is ready for a next candidate; this is not a grant and a configured join may still block");
  expect(content()).toContain("Current join: flow_missing");
  expect(content()).not.toContain("Current join: satisfied");
  await act(async () => renderer!.unmount());
  request.mockResolvedValueOnce(Response.json(original)); await mount(); await act(async () => button("Read original candidate loop").props.onClick());
  expect(content()).not.toContain("Current join");
});

it("does not invent a join wait for an unconfigured met condition", async () => {
  request.mockResolvedValueOnce(Response.json({ ...original, status: "condition_met", condition: { ...original.condition, value: "true" } }));
  await mount(); await act(async () => button("Read original candidate loop").props.onClick());
  expect(content()).toContain("Report termination met; original completion still required");
  expect(content()).not.toContain("Current join");
});

it("separates a passed report from an opposing satisfaction judgment and durable intervention", async () => {
  const report = { id: "report-pass", deliveryId: "delivery-2", commitSha: "abc", status: "passed", createdAt: "now" };
  request.mockResolvedValueOnce(Response.json({ ...original, terminationKind: "satisfaction", status: "needs_human",
    condition: { value: "true", reason: "plans_passed", reports: [report], missingPlans: [] },
    satisfaction: { criterion: "User accepts the result", value: "false", judgment: { id: "judgment-1", runId: run.id, attemptId: "attempt-2", deliveryId: "delivery-2",
      value: "false", reason: "Not satisfactory", actorUserId: "reviewer", recordedAt: "now" },
      intervention: { id: "intervention-1", runId: run.id, attemptId: "attempt-2", judgmentId: "judgment-1", reportIds: ["report-pass"],
        conflictKind: "passed_false", reason: "Reports and judgment disagree", recordedAt: "now" } } }))
    .mockResolvedValueOnce(Response.json({ runId: run.id, attemptId: "attempt-2", judgments: [], interventions: [] }));
  await mount(); await act(async () => button("Read original candidate loop").props.onClick());
  expect(content()).toContain("Report reference: report-pass");
  expect(content()).toContain("Current satisfaction judgment: false");
  expect(content()).toContain("Original human intervention: intervention-1");
  expect(content()).toContain("unresolved; blocks next and first completion");
  expect(content()).not.toContain("Report termination met");
});

it("keeps completed satisfaction consumption distinct from a later current judgment", async () => {
  request.mockResolvedValueOnce(Response.json({ ...original, terminationKind: "satisfaction", status: "completed", completedAt: "later",
    satisfaction: { criterion: "User accepts the result", value: "false", judgment: { id: "judgment-later", runId: run.id, attemptId: "attempt-2", deliveryId: "delivery-2",
      value: "false", reason: "Later correction", actorUserId: "reviewer", recordedAt: "later" } },
    completedCondition: { value: "true", reason: "plans_passed", reports: [{ id: "report-original", deliveryId: "delivery-2", commitSha: "abc", status: "passed", createdAt: "before" }], missingPlans: [] },
    completedSatisfaction: { value: "true", judgmentId: "judgment-original", reportIds: ["report-original"] } }))
    .mockResolvedValueOnce(Response.json({ runId: run.id, attemptId: "attempt-2", judgments: [], interventions: [] }));
  await mount(); await act(async () => button("Read original candidate loop").props.onClick());
  expect(content()).toContain("judgment-later");
  expect(content()).toContain("Recorded completion satisfaction (not current judgment): true · judgment-original · report-original");
  expect(button("Abandon candidate budget")).toBeUndefined();
});

it("records an exact first satisfaction CAS fact without granting another candidate", async () => {
  const current = { ...original, terminationKind: "satisfaction", status: "candidate", satisfaction: { criterion: "User accepts result", value: "unknown" } };
  request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ judgment: { id: "judgment-1", runId: run.id, attemptId: "attempt-2", deliveryId: "delivery-2",
      value: "true", reason: "Meets the criterion", actorUserId: "human", recordedAt: "later" }, replayed: false });
    return Response.json(url.includes("satisfaction-history") ? { runId: run.id, attemptId: "attempt-2", judgments: [], interventions: [] } : current);
  });
  await mount(); await act(async () => button("Read original candidate loop").props.onClick());
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate satisfaction value" }).props.onChange({ target: { value: "true" } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate satisfaction reason" }).props.onChange({ target: { value: "Meets the criterion" } }));
  await act(async () => button("Append exact candidate judgment").props.onClick());
  const body = JSON.parse(request.mock.calls.find(([, init]) => init?.method === "POST")![1].body);
  expect(body).toEqual({ runId: run.id, attemptId: "attempt-2", expectedJudgmentId: null, value: "true", reason: "Meets the criterion" });
  expect(content()).toContain("No intervention is automatically cleared or successor started");
  expect(request.mock.calls.some(([url]) => url.includes("/next") || url.includes("/start"))).toBe(false);
  expect(storage.size).toBe(0);
});

it("resolves only the named intervention after current satisfaction and reports agree", async () => {
  const judgment = { id: "judgment-2", runId: run.id, attemptId: "attempt-2", deliveryId: "delivery-2", value: "true", reason: "Corrected finding", actorUserId: "human", recordedAt: "later", predecessorId: "judgment-1" };
  const hold = { id: "intervention-1", runId: run.id, attemptId: "attempt-2", judgmentId: "judgment-1", reportIds: ["report-1"], conflictKind: "passed_false", reason: "Conflict", recordedAt: "before" };
  const current = { ...original, terminationKind: "satisfaction", status: "needs_human", condition: { value: "true", reports: [{ id: "report-1", deliveryId: "delivery-2", commitSha: "abc", status: "passed", createdAt: "now" }], missingPlans: [] },
    satisfaction: { criterion: "User accepts result", value: "true", judgment, intervention: hold } };
  request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ ...hold, resolvedAt: "now", resolvedByUserId: "human", resolutionReason: "Current facts agree", resolutionJudgmentId: "judgment-2", resolutionReportIds: ["report-1"] });
    return Response.json(url.includes("satisfaction-history") ? { runId: run.id, attemptId: "attempt-2", judgments: [judgment], interventions: [hold] } : current);
  });
  await mount(); await act(async () => button("Read original candidate loop").props.onClick());
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate intervention reason" }).props.onChange({ target: { value: "Current facts agree" } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Confirm candidate intervention resolution" }).props.onChange({ target: { checked: true } }));
  await act(async () => button("Resolve original intervention").props.onClick());
  const body = JSON.parse(request.mock.calls.find(([, init]) => init?.method === "POST")![1].body);
  expect(body).toEqual({ runId: run.id, attemptId: "attempt-2", interventionId: "intervention-1", expectedJudgmentId: "judgment-2", expectedReportIds: ["report-1"], reason: "Current facts agree" });
  expect(content()).toContain("no forced continuation or new candidate was started");
  expect(storage.size).toBe(0);
});

it("restores a lost first CAS across nodes and finds it on a later bounded history page", async () => {
  const initial = { ...original, terminationKind: "satisfaction", status: "candidate", satisfaction: { criterion: "Accepted result", value: "unknown" } };
  const later = { ...initial, satisfaction: { criterion: "Accepted result", value: "true", judgment: { id: "judgment-60", runId: run.id, attemptId: "attempt-2", deliveryId: "delivery-2", value: "true", reason: "Later opinion", actorUserId: "human", recordedAt: "later" } } };
  let lost = false;
  const judgments = Array.from({ length: 60 }, (_, index) => ({ id: `judgment-${index + 1}`, runId: run.id, attemptId: "attempt-2", deliveryId: "delivery-2",
    value: index === 0 ? "false" : "true", reason: index === 0 ? "Original dissatisfaction" : "Later opinion", actorUserId: "human", recordedAt: "now",
    ...(index ? { predecessorId: `judgment-${index}` } : {}) }));
  request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { lost = true; throw new Error("receipt lost"); }
    if (url.includes("satisfaction-history")) return Response.json({ runId: run.id, attemptId: "attempt-2", judgments: !lost ? [] : url.includes("judgmentCursor=11") ? judgments.slice(0, 10).reverse() : judgments.slice(10).reverse(),
      interventions: [], ...(!lost || url.includes("judgmentCursor=11") ? {} : { nextJudgmentCursor: "11" }) });
    return Response.json(lost ? later : initial);
  });
  await mount(); await act(async () => button("Read original candidate loop").props.onClick());
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate satisfaction value" }).props.onChange({ target: { value: "false" } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate satisfaction reason" }).props.onChange({ target: { value: "Original dissatisfaction" } }));
  await act(async () => button("Append exact candidate judgment").props.onClick());
  const stored = storage.values().next().value;
  expect(stored).toContain("Original dissatisfaction");
  await act(async () => renderer!.unmount());
  await mount({ run: { ...run, id: "other-run", taskSlug: "other" } });
  expect(content()).toContain("Resolve the original candidate request for another run first");
  expect(storage.values().next().value).toBe(stored);
  await act(async () => renderer!.unmount());
  await mount(); await act(async () => button("Read original candidate loop").props.onClick());
  expect(content()).toContain("Original CAS request frozen");
  expect(button("Explicitly retry original CAS request")).toBeUndefined();
  await act(async () => button("Read more original judgment history").props.onClick());
  expect(content()).toContain("Matching judgment observed; actual recorder: human");
  expect(content()).not.toContain("Original CAS request frozen");
  expect(storage.size).toBe(0);
  expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("restores a lost intervention resolution by its original judgment and report IDs", async () => {
  const judgment = { id: "judgment-2", runId: run.id, attemptId: "attempt-2", deliveryId: "delivery-2", value: "true", reason: "Aligned", actorUserId: "human", recordedAt: "now" };
  const hold = { id: "intervention-1", runId: run.id, attemptId: "attempt-2", judgmentId: "judgment-1", reportIds: ["report-1"], conflictKind: "passed_false", reason: "Conflict", recordedAt: "before" };
  const resolved = { ...hold, resolvedAt: "later", resolvedByUserId: "reviewer", resolutionReason: "Facts reconciled", resolutionJudgmentId: "judgment-2", resolutionReportIds: ["report-1"] };
  const current = { ...original, terminationKind: "satisfaction", status: "needs_human", condition: { value: "true", reports: [{ id: "report-1", deliveryId: "delivery-2", commitSha: "abc", status: "passed", createdAt: "now" }], missingPlans: [] },
    satisfaction: { criterion: "Accepted result", value: "true", judgment, intervention: hold } };
  let lost = false;
  request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { lost = true; throw new Error("receipt lost"); }
    if (url.includes("satisfaction-history")) return Response.json({ runId: run.id, attemptId: "attempt-2", judgments: [judgment], interventions: [lost ? resolved : hold] });
    return Response.json(lost ? { ...current, status: "condition_met", satisfaction: { ...current.satisfaction, intervention: resolved } } : current);
  });
  await mount(); await act(async () => button("Read original candidate loop").props.onClick());
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate intervention reason" }).props.onChange({ target: { value: "Facts reconciled" } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Confirm candidate intervention resolution" }).props.onChange({ target: { checked: true } }));
  await act(async () => button("Resolve original intervention").props.onClick());
  expect(storage.size).toBe(1);
  await act(async () => renderer!.unmount());
  await mount(); await act(async () => button("Read original candidate loop").props.onClick());
  expect(content()).toContain("Original intervention resolution observed; actual actor: reviewer");
  expect(storage.size).toBe(0);
  expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("reads a predecessor attempt's bounded history without offering a new grant or judgment on that old attempt", async () => {
  const current = { ...original, terminationKind: "satisfaction", status: "candidate",
    attempts: [{ id: "attempt-1", number: 1, grantedAt: "before", deliveryId: "delivery-1" }, ...original.attempts],
    satisfaction: { criterion: "Accepted result", value: "unknown" } };
  request.mockImplementation(async (url: string) => Response.json(url.includes("satisfaction-history")
    ? { runId: run.id, attemptId: url.includes("attemptId=attempt-1") ? "attempt-1" : "attempt-2", judgments: url.includes("attemptId=attempt-1")
      ? [{ id: "old-judgment", runId: run.id, attemptId: "attempt-1", deliveryId: "delivery-1", value: "false", reason: "Old result", actorUserId: "human", recordedAt: "before" }] : [], interventions: [] }
    : current));
  await mount(); await act(async () => button("Read original candidate loop").props.onClick());
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate history attempt" }).props.onChange({ target: { value: "attempt-1" } }));
  expect(content()).toContain("old-judgment");
  expect(button("Append exact candidate judgment")).toBeUndefined();
  expect(request.mock.calls.some(([url]) => url.includes("/next") || url.includes("/start"))).toBe(false);
});

it("does not send a new candidate request from damaged or unwritable recovery storage", async () => {
  storage.set("workbench.pending-candidate-loop.v1", JSON.stringify({ project: "project", taskSlug: "task", runId: run.id,
    pending: { action: "judgment", body: { runId: run.id, attemptId: "attempt-2", expectedJudgmentId: null, value: "invented", reason: "Bad record" } } }));
  await mount();
  expect(content()).toContain("Candidate recovery record cannot be read; no new request was created");
  await act(async () => renderer!.unmount()); storage.clear();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: () => { throw new Error("storage unavailable"); }, removeItem: (key: string) => storage.delete(key) });
  const current = { ...original, terminationKind: "satisfaction", status: "candidate", satisfaction: { criterion: "Accepted result", value: "unknown" } };
  request.mockImplementation(async (url: string) => Response.json(url.includes("satisfaction-history") ? { runId: run.id, attemptId: "attempt-2", judgments: [], interventions: [] } : current));
  await mount(); await act(async () => button("Read original candidate loop").props.onClick());
  await act(async () => renderer!.root.findByProps({ "aria-label": "Candidate satisfaction reason" }).props.onChange({ target: { value: "Needs correction" } }));
  await act(async () => button("Append exact candidate judgment").props.onClick());
  expect(content()).toContain("Recovery record could not be saved; request was not sent");
  expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
});

it("rejects a satisfaction read whose latest judgment belongs to another run", async () => {
  request.mockResolvedValueOnce(Response.json({ ...original, terminationKind: "satisfaction", satisfaction: { criterion: "Accepted result", value: "true",
    judgment: { id: "judgment-wrong", runId: "other-run", attemptId: "attempt-2", deliveryId: "delivery-2", value: "true", reason: "Wrong scope", actorUserId: "human", recordedAt: "now" } } }));
  await mount(); await act(async () => button("Read original candidate loop").props.onClick());
  expect(content()).toContain("Candidate loop scope or receipt mismatch");
  expect(renderer!.root.findAllByProps({ "aria-label": "Candidate satisfaction control" })).toHaveLength(0);
  expect(request).toHaveBeenCalledTimes(1);
});

it("separates frozen consumed and completion join proofs from the current projection", async () => {
  const frozen = { ...joinEvaluation, satisfied: true, reason: "all_completed", participants: [{ ...joinEvaluation.participants[0], state: "completed", completion: { id: "completion-1", runId: "branch-run", taskSlug: "branch" } }] };
  request.mockResolvedValueOnce(Response.json({ ...original, status: "completed", completedAt: "completed-now",
    attempts: [{ ...original.attempts[0], flowId: "flow-old" }, { ...original.attempts[1], flowId: "flow-current", consumedJoin: { sourceAttemptId: "attempt-1", flowId: "flow-old", mode: "all", evaluation: frozen } }],
    join: { mode: "all", allowEmptySkip: false, flowId: "flow-current", evaluation: joinEvaluation, reason: "member_waiting" },
    completedJoin: { sourceAttemptId: "attempt-2", flowId: "flow-current", mode: "all", evaluation: frozen } }));
  await mount(); await act(async () => button("Read original candidate loop").props.onClick());
  expect(content()).toContain("Consumed prior join: attempt-1 / flow-old");
  expect(content()).toContain("Recorded completion join: attempt-2 / flow-current");
  expect(content()).toContain("Current join: not satisfied");
  expect(content()).toContain("Frozen join: satisfied");
  expect(content()).toContain("completion-1");
});

it("shows original judgment identity, actor, reason and source refs in current and frozen joins", async () => {
  const judgment = { id: "judgment-current", flowId: "flow-current", conditionKey: "acceptance", value: "true", reason: "Accepted after source review",
    inputRefs: [{ kind: "specgraph", specSlug: "task", field: "specify", changeId: "source-change" }], actorUserId: "reviewer-human", actorRunId: "pm-run", recordedAt: "judged-now", predecessorId: "judgment-prior" };
  const admittedJudgment = { ...judgment, id: "judgment-admitted", value: "false", reason: "Earlier evaluation", inputRefs: [], predecessorId: undefined };
  const judged = { ...joinEvaluation, satisfied: true, reason: "all_completed",
    participants: [{ ...joinEvaluation.participants[0], admissionId: "branch-admission", basis: { flowId: "flow-current", conditionKey: "acceptance", value: "false", judgment: admittedJudgment } }],
    conditions: [{ key: "acceptance", evaluation: { value: "true", judgment } }] };
  const prior = { ...judged, conditions: [{ key: "acceptance", evaluation: { value: "false", judgment: { ...judgment, id: "judgment-prior", value: "false", inputRefs: [], predecessorId: undefined } } }] };
  request.mockResolvedValueOnce(Response.json({ ...original, status: "completed", completedAt: "completed-now",
    attempts: [{ ...original.attempts[0], flowId: "flow-prior" }, { ...original.attempts[1], flowId: "flow-current", consumedJoin: { sourceAttemptId: "attempt-1", flowId: "flow-prior", mode: "all", evaluation: prior } }],
    join: { mode: "all", allowEmptySkip: false, flowId: "flow-current", evaluation: judged },
    completedJoin: { sourceAttemptId: "attempt-2", flowId: "flow-current", mode: "all", evaluation: judged } }));
  await mount(); await act(async () => button("Read original candidate loop").props.onClick());
  expect(content()).toContain("Judgment reference: judgment-current");
  expect(content()).toContain("Judgment reference: judgment-prior");
  expect(content()).toContain("Admitted basis: branch-admission · flow-current / acceptance · false");
  expect(content()).toContain("Judgment reference: judgment-admitted");
  expect(content()).toContain("reviewer-human");
  expect(content()).toContain("pm-run");
  expect(content()).toContain("Accepted after source review");
  expect(content()).toContain("SpecGraph: task / specify / source-change");
  expect(content()).toContain("No external sources declared");
  expect(content()).toContain("Predecessor judgment: judgment-prior");
  expect(content()).not.toContain("no report");
});
