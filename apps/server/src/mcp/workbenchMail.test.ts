import { EnvironmentId, ProjectId, ProviderInstanceId, ProviderDriverKind, ThreadId, GitManagerError,
  WorkbenchCandidateLoop, WorkbenchCandidateLoopPolicy,
  WorkbenchNodeOwnershipState,
  WorkbenchMergePreview, WorkbenchMergeRequest, WorkbenchMergeReceipt,
  type OrchestrationProjectShell, type OrchestrationThreadShell, type ServerProvider } from "@t3tools/contracts";
import { afterEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";
import * as Context from "effect/Context";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import { mailHandlers, WorkbenchMailToolkit, WorkbenchMailRegistrationLive } from "./workbenchMail.ts";
import * as MailClient from "@project-workbench/mail/client";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../orchestration/Services/ThreadDeletionReactor.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { ProjectCloneTracker } from "../project/ProjectCloneTracker.ts";
import { WorkspaceEntries } from "../workspace/WorkspaceEntries.ts";

const readHead = vi.fn<GitWorkflowService["Service"]["readHead"]>();
const hasCommit = vi.fn<GitWorkflowService["Service"]["hasCommit"]>();
const gitLayer = Layer.mock(GitWorkflowService)({ readHead, hasCommit });
const providerSnapshots = vi.fn<() => ReadonlyArray<ServerProvider>>(() => []);
const providerLayer = Layer.mock(ProviderRegistry)({ getProviders: Effect.sync(providerSnapshots) });
// Registration must not invoke the real native command owners.
const dispatchLayer = Layer.mergeAll(Layer.mock(OrchestrationEngineService)({}), Layer.mock(ThreadDeletionReactor)({}),
  Layer.mock(ServerRuntimeStartup)({}), Layer.mock(ProjectCloneTracker)({}));
const searchContents = vi.fn<WorkspaceEntries["Service"]["searchContents"]>();
const workspaceLayer = Layer.mock(WorkspaceEntries)({ searchContents });
const searchThreads = vi.fn<ProjectionSnapshotQuery["Service"]["searchThreads"]>();

const invocation: McpInvocationScope = {
  environmentId: EnvironmentId.make("native-environment"), threadId: ThreadId.make("native-thread"),
  providerSessionId: "native-session", providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(), issuedAt: 1,
};
const config = { endpoint: "http://127.0.0.1:8690", token: "fixture-only-secret", projects: { "native-project": "spec-project" } };
// Only these shell fields are consumed; all other projection methods fail if called.
const thread = { projectId: ProjectId.make("native-project"), archivedAt: null, worktreePath: null } as OrchestrationThreadShell;
const project = { id: thread.projectId, workspaceRoot: "C:/host/project" } as OrchestrationProjectShell;
const snapshots = (value: OrchestrationThreadShell | null = thread, projectValue: OrchestrationProjectShell | null = project) => Layer.mock(ProjectionSnapshotQuery)({
  getThreadShellById: (id) => {
    expect(id).toBe(invocation.threadId);
    return Effect.succeed(Option.fromNullishOr(value));
  },
  getProjectShellById: (id) => {
    expect(id).toBe(thread.projectId);
    return Effect.succeed(Option.fromNullishOr(projectValue));
  },
  searchThreads,
});
const build = (value: OrchestrationThreadShell | null = thread) =>
  WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(config).pipe(Layer.provide(snapshots(value)))));
type Built = Effect.Success<ReturnType<typeof build>>;
const call = (built: Built, name: keyof typeof WorkbenchMailToolkit.tools, payload: unknown) =>
  built.handle(name, payload as never).pipe(Stream.unwrap, Stream.runCollect,
    Effect.provideService(McpInvocationContext, invocation), Effect.provide(Layer.mergeAll(gitLayer, providerLayer, dispatchLayer, workspaceLayer)));

afterEach(() => { readHead.mockReset(); hasCommit.mockReset(); searchContents.mockReset(); searchThreads.mockReset(); providerSnapshots.mockReset(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("source mail toolkit consumer", () => {
  it.effect("keeps named candidate satisfaction separate from reports and human intervention", () => Effect.gen(function* () {
    const local = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-secret", projects: { "native-project": "spec-project" } };
    const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(snapshots()))));
    const source = { kind: "specgraph", specSlug: "plan", field: "tests", changeId: "plan-change" };
    const arm = { runId: "bound-run", maxAttempts: 2, planSources: [source], terminationKind: "satisfaction" as const,
      satisfactionCriterion: "The delivered result meets the named acceptance" };
    const loop = { runId: arm.runId, taskSlug: "task", packageId: "package", maxAttempts: arm.maxAttempts,
      planSources: arm.planSources, terminationKind: arm.terminationKind,
      satisfaction: { criterion: arm.satisfactionCriterion, value: "unknown" },
      configuredBy: "actual-pm", configuredAt: "now", attempts: [], status: "waiting" };
    const manager = vi.spyOn(MailClient, "requestManagerPlan").mockResolvedValueOnce(loop);
    const own = vi.spyOn(MailClient, "requestOwnCandidateSatisfaction");
    const ownDelivery = vi.spyOn(MailClient, "requestOwnDelivery");
    const knowledge = vi.spyOn(MailClient, "requestProjectKnowledge");
    expect(yield* Schema.decodeUnknownEffect(WorkbenchCandidateLoopPolicy)(arm)).toEqual(arm);
    expect((yield* call(built, "workbench_arm_candidate_loop", { ...arm, actor: "forged", project: "foreign" })).at(-1)!.result)
      .toEqual(loop);
    expect(manager).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation,
      "pm-candidate-loop-arm", arm, expect.any(AbortSignal));
    for (const invalid of [{ ...arm, satisfactionCriterion: undefined }, { ...arm, terminationKind: "report" },
      { ...arm, satisfactionCriterion: " " }]) {
      expect(Exit.isFailure(yield* call(built, "workbench_arm_candidate_loop", invalid).pipe(Effect.exit))).toBe(true);
      expect(Exit.isFailure(yield* Schema.decodeUnknownEffect(WorkbenchCandidateLoopPolicy)(invalid).pipe(Effect.exit))).toBe(true);
    }
    manager.mockResolvedValueOnce({ ...loop, satisfaction: { criterion: "Different criterion", value: "unknown" } });
    expect((yield* call(built, "workbench_arm_candidate_loop", arm).pipe(Effect.flip)).message).toContain("outcome unconfirmed");
    const report = { id: "report-failed", deliveryId: "delivery-1", commitSha: "a".repeat(40), status: "failed",
      planSources: [source], createdAt: "now" };
    const attempt = { id: "attempt-1", number: 1, grantedAt: "now", deliveryId: report.deliveryId };
    const judgment = { id: "judgment-1", runId: arm.runId, attemptId: attempt.id, deliveryId: report.deliveryId,
      value: "true", reason: "I assessed the result", actorUserId: "real-user", actorRunId: "actual-pm", recordedAt: "now" };
    const intervention = { id: "hold-1", runId: arm.runId, attemptId: attempt.id, judgmentId: judgment.id,
      reportIds: [report.id], conflictKind: "report_false_judgment_true", reason: "Facts disagree", recordedAt: "now" };
    const held = { ...loop, attempts: [attempt], currentAttempt: attempt,
      condition: { value: "false", reports: [report], missingPlans: [] },
      satisfaction: { criterion: arm.satisfactionCriterion, value: "unknown", judgment, intervention }, status: "needs_human" };
    expect(yield* Schema.decodeUnknownEffect(WorkbenchCandidateLoop)(held)).toEqual(held);
    knowledge.mockResolvedValueOnce(held);
    expect((yield* call(built, "workbench_read_candidate_loop", { runId: arm.runId })).at(-1)!.result).toEqual(held);
    const pmInput = { runId: arm.runId, attemptId: attempt.id, expectedJudgmentId: null, value: "true", reason: judgment.reason };
    manager.mockResolvedValueOnce({ judgment, replayed: false });
    expect((yield* call(built, "workbench_record_candidate_satisfaction", { ...pmInput, actor: "forged" })).at(-1)!.result)
      .toEqual({ judgment, replayed: false });
    expect(manager).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation,
      "pm-candidate-satisfaction-record", pmInput, expect.any(AbortSignal));
    const correction = { attemptId: attempt.id, expectedJudgmentId: judgment.id, value: "false", reason: "Corrected assessment" };
    const ownJudgment = { ...judgment, id: "judgment-2", value: correction.value, reason: correction.reason,
      actorRunId: arm.runId, predecessorId: judgment.id, recordedAt: "later" };
    own.mockResolvedValueOnce({ judgment: ownJudgment, replayed: false });
    expect((yield* call(built, "workbench_record_own_candidate_satisfaction", { ...correction, runId: "forged", actor: "forged" })).at(-1)!.result)
      .toEqual({ judgment: ownJudgment, replayed: false });
    expect(own).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation, correction, expect.any(AbortSignal));
    expect(ownDelivery).not.toHaveBeenCalled();
    const stillHeld = { ...held, satisfaction: { ...held.satisfaction, judgment: ownJudgment } };
    knowledge.mockResolvedValueOnce(stillHeld);
    expect((yield* call(built, "workbench_read_candidate_loop", { runId: arm.runId })).at(-1)!.result).toEqual(stillHeld);
    const history = { runId: arm.runId, attemptId: attempt.id, judgments: [ownJudgment, judgment], interventions: [intervention],
      nextJudgmentCursor: judgment.id, nextInterventionCursor: intervention.id };
    knowledge.mockResolvedValueOnce(history);
    expect((yield* call(built, "workbench_read_candidate_satisfaction_history", { runId: arm.runId, attemptId: attempt.id,
      judgmentCursor: "older", interventionCursor: "older", actor: "forged" })).at(-1)!.result).toEqual(history);
    expect(knowledge).toHaveBeenLastCalledWith({ ...local, project: "spec-project" },
      { environmentId: invocation.environmentId, nativeProjectId: thread.projectId },
      "candidate-satisfaction-history", { runId: arm.runId, attemptId: attempt.id,
        judgmentCursor: "older", interventionCursor: "older" }, expect.any(AbortSignal));
    const resolved = { ...intervention, resolvedAt: "later", resolvedByUserId: "human-user",
      resolutionReason: "Reviewed both facts", resolutionJudgmentId: ownJudgment.id, resolutionReportIds: [report.id] };
    const basis = { value: "false", judgmentId: ownJudgment.id, reportIds: [report.id], interventionId: intervention.id };
    const nextAttempt = { id: "attempt-2", number: 2, grantedAt: "later", predecessorId: attempt.id,
      consumedCondition: held.condition, consumedSatisfaction: basis };
    const granted = { ...loop, attempts: [attempt, nextAttempt], currentAttempt: nextAttempt,
      grantedAttempt: nextAttempt, status: "candidate", satisfaction: { criterion: arm.satisfactionCriterion, value: "unknown" } };
    ownDelivery.mockResolvedValueOnce({ runId: arm.runId, taskSlug: "task", workspace: "C:/saved" })
      .mockResolvedValueOnce(granted);
    expect((yield* call(built, "workbench_next_own_candidate", { expectedPreviousAttemptId: attempt.id })).at(-1)!.result)
      .toEqual(granted);
    const passed = { ...report, id: "report-passed", status: "passed" };
    const completed = { ...granted, status: "completed", completedAt: "done",
      condition: { value: "unknown", reports: [], missingPlans: [source] },
      satisfaction: { criterion: arm.satisfactionCriterion, value: "unknown", intervention: resolved },
      completedCondition: { value: "true", reports: [passed], missingPlans: [] },
      completedSatisfaction: { value: "true", judgmentId: "judgment-final", reportIds: [passed.id], interventionId: intervention.id } };
    knowledge.mockResolvedValueOnce(completed);
    expect((yield* call(built, "workbench_read_candidate_loop", { runId: arm.runId })).at(-1)!.result).toEqual(completed);
    expect(yield* Schema.decodeUnknownEffect(WorkbenchCandidateLoop)(completed)).toEqual(completed);
    for (const bad of [{ ...judgment, runId: "other" }, { ...judgment, attemptId: "other" },
      { ...judgment, predecessorId: "other" }, { ...judgment, value: "false" }]) {
      manager.mockResolvedValueOnce({ judgment: bad, replayed: false });
      expect((yield* call(built, "workbench_record_candidate_satisfaction", pmInput).pipe(Effect.flip)).message).toContain("outcome unconfirmed");
    }
    own.mockResolvedValueOnce({ judgment: { ...ownJudgment, actorRunId: "other" }, replayed: false });
    expect((yield* call(built, "workbench_record_own_candidate_satisfaction", correction).pipe(Effect.flip)).message)
      .toContain("outcome unconfirmed");
    knowledge.mockResolvedValueOnce({ ...history, interventions: [{ ...intervention, runId: "other" }] });
    expect((yield* call(built, "workbench_read_candidate_satisfaction_history", { runId: arm.runId, attemptId: attempt.id }).pipe(Effect.flip)).message)
      .toContain("identity mismatch");
    for (const [name, fields, readonly] of [
      ["workbench_record_candidate_satisfaction", ["runId", "attemptId", "expectedJudgmentId", "value", "reason"], false],
      ["workbench_record_own_candidate_satisfaction", ["attemptId", "expectedJudgmentId", "value", "reason"], false],
      ["workbench_read_candidate_satisfaction_history", ["runId", "attemptId", "judgmentCursor", "interventionCursor"], true],
    ] as const) {
      const tool = WorkbenchMailToolkit.tools[name];
      expect(Object.keys(Tool.getJsonSchema(tool).properties ?? {})).toEqual(fields);
      expect(Context.get(tool.annotations, Tool.Readonly)).toBe(readonly);
    }
    expect(Object.hasOwn(WorkbenchMailToolkit.tools, "workbench_resolve_candidate_intervention")).toBe(false);
  }));
  it.effect("registers fixed candidate loops and grants only the exact false predecessor", () => Effect.gen(function* () {
    const local = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-secret", projects: { "native-project": "spec-project" } };
    const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(snapshots()))));
    const source = { kind: "specgraph", specSlug: "plan", field: "tests", changeId: "change" };
    const input = { runId: "bound-run", maxAttempts: 3, planSources: [source], terminationKind: "report" as const };
    const initial = { runId: "bound-run", taskSlug: "task", packageId: "original-package", maxAttempts: 3,
      planSources: [source], terminationKind: "report", configuredBy: "actual-pm", configuredAt: "now", attempts: [], status: "waiting" };
    const report = { id: "failed-report", deliveryId: "delivery-1", commitSha: "a".repeat(40), status: "failed",
      planSources: [source], createdAt: "now" };
    const failed = { value: "false", reports: [report], missingPlans: [] };
    const previous = { id: "attempt-1", number: 1, grantedAt: "now", deliveryId: "delivery-1" };
    const ready = { ...initial, attempts: [previous], currentAttempt: previous, condition: failed, status: "ready_next" };
    const manager = vi.spyOn(MailClient, "requestManagerPlan").mockResolvedValueOnce(initial);
    const knowledge = vi.spyOn(MailClient, "requestProjectKnowledge").mockResolvedValueOnce(ready);
    const own = vi.spyOn(MailClient, "requestOwnDelivery");
    expect((yield* call(built, "workbench_arm_candidate_loop", { ...input, actor: "forged", project: "foreign", status: "condition_met" })).at(-1)!.result).toEqual(initial);
    expect(manager).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation,
      "pm-candidate-loop-arm", input, expect.any(AbortSignal));
    const joinInput = { ...input, join: { mode: "all" as const, allowEmptySkip: false } };
    const joinConfigured = { ...initial, join: { ...joinInput.join, reason: "flow_missing" } };
    manager.mockResolvedValueOnce(joinConfigured);
    expect((yield* call(built, "workbench_arm_candidate_loop", { ...joinInput, join: { ...joinInput.join,
      flowId: "forged", evaluation: { satisfied: true } } })).at(-1)!.result).toEqual(joinConfigured);
    expect(manager).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation,
      "pm-candidate-loop-arm", joinInput, expect.any(AbortSignal));
    expect((yield* call(built, "workbench_read_candidate_loop", { runId: "bound-run", project: "foreign" })).at(-1)!.result).toEqual(ready);
    expect(knowledge).toHaveBeenLastCalledWith({ ...local, project: "spec-project" },
      { environmentId: invocation.environmentId, nativeProjectId: thread.projectId },
      "candidate-loop-read", { runId: "bound-run" }, expect.any(AbortSignal));
    const middle = { ...previous, id: "attempt-2", number: 2 };
    const last = { ...previous, id: "attempt-3", number: 3 };
    const passed = { value: "true", reports: [{ ...report, id: "passed-report", status: "passed" }], missingPlans: [] };
    const unknownCondition = { value: "unknown", reports: [], missingPlans: [source] };
    for (const projection of [
      { ...ready, condition: unknownCondition, status: "waiting" },
      { ...ready, attempts: [previous, middle, last], currentAttempt: last, condition: failed, status: "needs_human" },
      { ...ready, attempts: [previous, middle, last], currentAttempt: last, condition: passed, status: "condition_met" },
      { ...ready, status: "abandoned", abandon: { actorUserId: "human", reason: "Budget abandoned", recordedAt: "later" } },
      { ...ready, condition: failed, status: "completed", completedAt: "after-original-completion" },
    ]) {
      knowledge.mockResolvedValueOnce(projection);
      expect((yield* call(built, "workbench_read_candidate_loop", { runId: "bound-run" })).at(-1)!.result).toEqual(projection);
    }
    const next = { id: "attempt-2", number: 2, grantedAt: "later", predecessorId: "attempt-1", consumedCondition: failed };
    const granted = { ...initial, attempts: [previous, next], currentAttempt: next, grantedAttempt: next, status: "candidate" };
    own.mockResolvedValueOnce({ runId: "bound-run", taskSlug: "task", workspace: "C:/saved", currentAttemptId: "attempt-1" })
      .mockResolvedValueOnce(granted);
    expect((yield* call(built, "workbench_next_own_candidate", { expectedPreviousAttemptId: "attempt-1", runId: "forged", actor: "forged" })).at(-1)!.result).toEqual(granted);
    expect(own).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation,
      "candidate-next-own", { expectedPreviousAttemptId: "attempt-1" }, expect.any(AbortSignal));
    const later = { ...next, id: "attempt-3", number: 3, predecessorId: "attempt-2" };
    const replay = { ...granted, attempts: [previous, next, later], currentAttempt: later, replayed: true };
    own.mockResolvedValueOnce({ runId: "bound-run", taskSlug: "task", workspace: "C:/saved", currentAttemptId: "attempt-3" })
      .mockResolvedValueOnce(replay);
    expect((yield* call(built, "workbench_next_own_candidate", { expectedPreviousAttemptId: "attempt-1" })).at(-1)!.result).toEqual(replay);
    const stop = { runId: "bound-run", reason: "Stop future slots" };
    const stopped = { ...granted, status: "stopped", stop: { actorUserId: "actual-user", actorRunId: "actual-pm",
      reason: stop.reason, recordedAt: "later" } };
    manager.mockResolvedValueOnce(stopped);
    expect((yield* call(built, "workbench_stop_candidate_loop", { ...stop, actor: "forged" })).at(-1)!.result).toEqual(stopped);
    expect(manager).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation,
      "pm-candidate-loop-stop", stop, expect.any(AbortSignal));
    for (const [name, fields, readonly] of [
      ["workbench_arm_candidate_loop", ["runId", "maxAttempts", "planSources", "join", "terminationKind", "satisfactionCriterion"], false],
      ["workbench_read_candidate_loop", ["runId"], true],
      ["workbench_stop_candidate_loop", ["runId", "reason"], false],
      ["workbench_next_own_candidate", ["expectedPreviousAttemptId"], false],
    ] as const) {
      const tool = WorkbenchMailToolkit.tools[name];
      expect(Object.keys(Tool.getJsonSchema(tool).properties ?? {})).toEqual(fields);
      expect(Context.get(tool.annotations, Tool.Readonly)).toBe(readonly);
    }
    for (const bad of [{ ...initial, runId: "other" }, { ...initial, maxAttempts: 4 }, { ...initial, planSources: [] },
      { ...initial, join: joinConfigured.join }]) {
      manager.mockResolvedValueOnce(bad);
      expect((yield* call(built, "workbench_arm_candidate_loop", input).pipe(Effect.flip)).message).toContain("outcome unconfirmed");
    }
    manager.mockResolvedValueOnce({ ...joinConfigured, join: { ...joinConfigured.join, mode: "any" } });
    expect((yield* call(built, "workbench_arm_candidate_loop", joinInput).pipe(Effect.flip)).message).toContain("outcome unconfirmed");
    knowledge.mockResolvedValueOnce({ ...ready, runId: "other" });
    expect((yield* call(built, "workbench_read_candidate_loop", { runId: "bound-run" }).pipe(Effect.flip)).message).toContain("identity mismatch");
    manager.mockResolvedValueOnce({ ...stopped, stop: undefined });
    expect((yield* call(built, "workbench_stop_candidate_loop", stop).pipe(Effect.flip)).message).toContain("outcome unconfirmed");
    for (const bad of [{ ...granted, runId: "other" }, { ...granted, grantedAttempt: { ...next, predecessorId: "other" } },
      { ...granted, grantedAttempt: { ...next, consumedCondition: undefined } }, { ...granted, grantedAttempt: undefined }]) {
      own.mockResolvedValueOnce({ runId: "bound-run", taskSlug: "task", workspace: "C:/saved" }).mockResolvedValueOnce(bad);
      expect((yield* call(built, "workbench_next_own_candidate", { expectedPreviousAttemptId: "attempt-1" }).pipe(Effect.flip)).message)
        .toContain("outcome unconfirmed");
    }
    expect(readHead).not.toHaveBeenCalled();
  }));
  it.effect("keeps a candidate join bound to its exact predecessor flow and frozen proof", () => Effect.gen(function* () {
    const local = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-secret", projects: { "native-project": "spec-project" } };
    const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(snapshots()))));
    const reportR1 = { id: "report-r1", deliveryId: "delivery-1", commitSha: "a".repeat(40), status: "passed", planSources: [], createdAt: "r1" };
    const reportR2 = { ...reportR1, id: "report-r2", createdAt: "r2" };
    const source = { kind: "specgraph", specSlug: "criterion", field: "intent", changeId: "change" };
    const judgmentR1 = { id: "judgment-r1", flowId: "flow-1", conditionKey: "semantic", value: "true",
      inputRefs: [source], reason: "Original fact", actorUserId: "pm-user", recordedAt: "r1" };
    const judgmentR2 = { ...judgmentR1, id: "judgment-r2", predecessorId: "judgment-r1", recordedAt: "r2" };
    const admittedBasis = { flowId: "flow-1", conditionKey: "admitted-semantic", value: "true",
      judgment: { ...judgmentR1, id: "judgment-frozen", conditionKey: "admitted-semantic" } };
    const admittedMember = { runId: "branch-admitted", packageId: "branch-package", conditionKey: "admitted-semantic",
      when: "true", state: "admitted", admissionId: "branch-admission",
      completion: { id: "completion", runId: "branch-admitted", taskSlug: "branch-task" }, basis: admittedBasis };
    const evaluatedR1 = { satisfied: true, participants: [admittedMember], unknown: [], conditions: [
      { key: "condition", evaluation: { value: "true", report: reportR1 } },
      { key: "semantic", evaluation: { value: "true", judgment: judgmentR1 } }], explicitSkip: false };
    const evaluatedR2 = { ...evaluatedR1, conditions: [
      { key: "condition", evaluation: { value: "true", report: reportR2 } },
      { key: "semantic", evaluation: { value: "true", judgment: judgmentR2 } }] };
    const proof = { sourceAttemptId: "attempt-1", flowId: "flow-1", mode: "any", evaluation: evaluatedR1 };
    const prior = { id: "attempt-1", number: 1, grantedAt: "now", deliveryId: "delivery-1", flowId: "flow-1" };
    const next = { id: "attempt-2", number: 2, grantedAt: "later", predecessorId: "attempt-1",
      consumedCondition: { value: "false", reports: [{ ...reportR1, id: "failed-report", status: "failed" }], missingPlans: [] }, consumedJoin: proof };
    const join = { mode: "any", allowEmptySkip: false, reason: "flow_missing" };
    const loop = { runId: "bound-run", taskSlug: "task", packageId: "package", maxAttempts: 2, planSources: [], terminationKind: "report",
      join, configuredBy: "pm", configuredAt: "now", attempts: [prior, next], currentAttempt: next,
      grantedAttempt: next, status: "candidate" };
    const own = vi.spyOn(MailClient, "requestOwnDelivery");
    const context = { runId: "bound-run", taskSlug: "task", workspace: "C:/saved", currentAttemptId: "attempt-1" };
    own.mockResolvedValueOnce(context).mockResolvedValueOnce(loop);
    expect((yield* call(built, "workbench_next_own_candidate", { expectedPreviousAttemptId: "attempt-1" })).at(-1)!.result).toEqual(loop);
    const knowledge = vi.spyOn(MailClient, "requestProjectKnowledge");
    const completed = { ...loop, currentAttempt: { ...next, flowId: "flow-2" },
      join: { ...join, flowId: "flow-2", evaluation: evaluatedR2 }, status: "completed", completedAt: "done",
      completedJoin: { sourceAttemptId: "attempt-2", flowId: "flow-2", mode: "any", evaluation: evaluatedR1 } };
    knowledge.mockResolvedValueOnce(completed);
    const read = (yield* call(built, "workbench_read_candidate_loop", { runId: "bound-run" })).at(-1)!.result as typeof completed;
    expect(read.completedJoin.evaluation.conditions[0]!.evaluation.report!.id).toBe("report-r1");
    expect(read.join.evaluation.conditions[0]!.evaluation.report!.id).toBe("report-r2");
    expect(read.completedJoin.evaluation.conditions[1]!.evaluation.judgment!.id).toBe("judgment-r1");
    expect(read.join.evaluation.conditions[1]!.evaluation.judgment!.id).toBe("judgment-r2");
    expect(read.completedJoin.evaluation.participants[0]!.basis.judgment.id).toBe("judgment-frozen");
    expect(read.completedJoin.evaluation.participants[0]!.basis.judgment.inputRefs).toEqual([source]);
    const joined = { flowId: "flow-1", runId: "join-run", packageId: "join-package", mode: "any", allowEmptySkip: false,
      configuredBy: "pm", configuredAt: "now", evaluation: evaluatedR2,
      admission: { id: "join-admission", proof: { flowId: "flow-1", targetRunId: "join-run", mode: "any", evaluation: evaluatedR1 } } };
    knowledge.mockResolvedValueOnce(joined);
    const joinRead = (yield* call(built, "workbench_read_report_join", { runId: "join-run" })).at(-1)!.result as typeof joined;
    expect(joinRead.admission.proof.evaluation.conditions[1]!.evaluation.judgment!.id).toBe("judgment-r1");
    expect(joinRead.evaluation.conditions[1]!.evaluation.judgment!.id).toBe("judgment-r2");
    expect(joinRead.admission.proof.evaluation.participants[0]!.basis.judgment.id).toBe("judgment-frozen");
    for (const bad of [
      { ...loop, grantedAttempt: { ...next, consumedJoin: { ...proof, sourceAttemptId: "other" } } },
      { ...loop, grantedAttempt: { ...next, consumedJoin: { ...proof, flowId: "other" } } },
      { ...loop, grantedAttempt: { ...next, consumedJoin: undefined } },
      { ...loop, grantedAttempt: { ...next, consumedJoin: { ...proof, evaluation: { ...evaluatedR1, satisfied: false } } } },
    ]) {
      own.mockResolvedValueOnce(context).mockResolvedValueOnce(bad);
      expect((yield* call(built, "workbench_next_own_candidate", { expectedPreviousAttemptId: "attempt-1" }).pipe(Effect.flip)).message)
        .toContain("outcome unconfirmed");
    }
    expect(readHead).not.toHaveBeenCalled();
  }));
  it.effect("scopes report joins by original target and preserves all/any/unknown/skip projections", () => Effect.gen(function* () {
    const local = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-secret", projects: { "native-project": "spec-project" } };
    const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(snapshots()))));
    const input = { flowId: "flow", runId: "join-run", mode: "all" as const, allowEmptySkip: false };
    const completion = { id: "completion-a", runId: "branch-a", taskSlug: "task-a" };
    const selected = { runId: "branch-a", packageId: "package-a", conditionKey: "condition-a", when: "true", state: "selected" };
    const unknown = { runId: "branch-b", packageId: "package-b", conditionKey: "condition-b", when: "false", state: "unknown" };
    const reportR1 = { id: "report-r1", deliveryId: "delivery-a", commitSha: "a".repeat(40), status: "passed", planSources: [], createdAt: "r1" };
    const reportR2 = { ...reportR1, id: "report-r2", createdAt: "r2" };
    const reportFalse = { ...reportR1, id: "report-false", deliveryId: "delivery-c", status: "failed" };
    const conditionsR1 = [{ key: "condition-a", evaluation: { value: "true", report: reportR1 } },
      { key: "condition-b", evaluation: { value: "unknown", reason: "Awaiting exact report" } },
      { key: "condition-c", evaluation: { value: "false", report: reportFalse } }];
    const conditionsR2 = [{ key: "condition-a", evaluation: { value: "true", report: reportR2 } }, conditionsR1[1]!, conditionsR1[2]!];
    const evaluation = { satisfied: false, reason: "Waiting for exact run completion", participants: [selected], unknown: [unknown],
      conditions: conditionsR2, explicitSkip: false };
    const join = { ...input, packageId: "join-package", configuredBy: "actual-pm", configuredAt: "now", evaluation };
    const manager = vi.spyOn(MailClient, "requestManagerPlan").mockResolvedValue(join);
    const knowledge = vi.spyOn(MailClient, "requestProjectKnowledge").mockResolvedValue(join);
    expect((yield* call(built, "workbench_arm_report_join", { ...input, project: "forged", actor: "forged",
      packageId: "forged", evaluation: { satisfied: true }, admission: {} })).at(-1)!.result).toEqual(join);
    expect(manager).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation,
      "pm-report-join-arm", input, expect.any(AbortSignal));
    expect((yield* call(built, "workbench_arm_report_join", input)).at(-1)!.result).toEqual(join);
    expect(manager).toHaveBeenCalledTimes(2);
    expect((yield* call(built, "workbench_read_report_join", { runId: "join-run", project: "forged" })).at(-1)!.result).toEqual(join);
    expect(knowledge).toHaveBeenLastCalledWith({ ...local, project: "spec-project" },
      { environmentId: invocation.environmentId, nativeProjectId: thread.projectId },
      "report-join-read", { runId: "join-run" }, expect.any(AbortSignal));
    const all = { ...join, evaluation: { satisfied: true, participants: [{ ...selected, completion }],
      unknown: [], conditions: [conditionsR1[0]!, conditionsR1[2]!], explicitSkip: false } };
    const any = { ...join, mode: "any", evaluation: { satisfied: true, participants: [{ ...selected, completion }],
      unknown: [unknown], conditions: conditionsR1, witness: completion, explicitSkip: false } };
    const admittedOnly = { ...join, evaluation: { satisfied: true, participants: [{ ...selected, state: "admitted", admissionId: "admission-a", completion }],
      unknown: [], conditions: [], explicitSkip: false } };
    const skip = { ...join, allowEmptySkip: true, evaluation: { satisfied: true, participants: [], unknown: [], conditions: [], explicitSkip: true } };
    const notEmpty = { ...join, allowEmptySkip: true, evaluation: { satisfied: false, participants: [], unknown: [unknown],
      conditions: [conditionsR1[1]!, conditionsR1[2]!], explicitSkip: false } };
    for (const projection of [all, any, admittedOnly, skip, notEmpty]) {
      knowledge.mockResolvedValueOnce(projection);
      expect((yield* call(built, "workbench_read_report_join", { runId: "join-run" })).at(-1)!.result).toEqual(projection);
    }
    const admitted = { ...all, admission: { id: "join-admission", proof: {
      flowId: "flow", targetRunId: "join-run", mode: "all", evaluation: all.evaluation,
    } }, evaluation };
    knowledge.mockResolvedValueOnce(admitted);
    const admittedResult = (yield* call(built, "workbench_read_report_join", { runId: "join-run" })).at(-1)!.result as typeof admitted;
    expect(admittedResult).toEqual(admitted);
    expect(admittedResult.admission.proof.evaluation.conditions[0]!.evaluation.report!.id).toBe("report-r1");
    expect(admittedResult.evaluation.conditions[0]!.evaluation.report!.id).toBe("report-r2");
    expect(admittedResult.admission.proof.evaluation.conditions.some((condition) => condition.key === "condition-c" &&
      condition.evaluation.value === "false")).toBe(true);
    for (const [name, fields, readonly] of [
      ["workbench_arm_report_join", ["flowId", "runId", "mode", "allowEmptySkip"], false],
      ["workbench_read_report_join", ["runId"], true],
    ] as const) {
      const tool = WorkbenchMailToolkit.tools[name];
      expect(Object.keys(Tool.getJsonSchema(tool).properties ?? {})).toEqual(fields);
      expect(Context.get(tool.annotations, Tool.Readonly)).toBe(readonly);
    }
    for (const wrong of [{ ...join, flowId: "other" }, { ...join, runId: "other" }, { ...join, mode: "any" },
      { ...join, allowEmptySkip: true }, { ...admitted, admission: { ...admitted.admission, proof: { ...admitted.admission.proof, targetRunId: "other" } } },
      { ...join, evaluation: { ...evaluation, participants: null } },
      { ...join, evaluation: { ...evaluation, conditions: undefined } },
      { ...join, evaluation: { ...evaluation, conditions: [conditionsR1[0], conditionsR1[0]] } }]) {
      manager.mockResolvedValueOnce(wrong);
      expect((yield* call(built, "workbench_arm_report_join", input).pipe(Effect.flip)).message).toContain("outcome unconfirmed");
    }
    for (const wrong of [{ ...join, runId: "other" }, { ...admitted, admission: { ...admitted.admission,
      proof: { ...admitted.admission.proof, flowId: "other" } } }]) {
      knowledge.mockResolvedValueOnce(wrong);
      expect((yield* call(built, "workbench_read_report_join", { runId: "join-run" }).pipe(Effect.flip)).message)
        .toContain("identity mismatch");
    }
    expect(readHead).not.toHaveBeenCalled();
  }));
  it.effect("registers report flow PM actions and exact host-scoped discovery without accepting replaced definitions", () => Effect.gen(function* () {
    const local = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-secret", projects: { "native-project": "spec-project" } };
    const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(snapshots()))));
    const git = { kind: "git", environmentId: "native-environment", repositoryRoot: "C:/repo", commitSha: "a".repeat(40), path: "plan.md" };
    const spec = { kind: "specgraph", specSlug: "plan", field: "specify", changeId: "change" };
    const input = { idempotencyKey: "original-key", conditions: [
      { key: "pass", kind: "report", report: { deliveryId: "delivery-a", planSource: git, inputSources: [spec] } },
      { key: "wait", kind: "report", report: { deliveryId: "delivery-b", planSource: spec, inputSources: [git, spec] } },
    ], branches: [
      { runId: "run-a", conditionKey: "pass", when: "true" },
      { runId: "run-b", conditionKey: "wait", when: "false" },
    ] };
    const report = { id: "report", deliveryId: "delivery-a", commitSha: "a".repeat(40), status: "passed",
      planSources: [spec], createdAt: "now" };
    const receipt = { id: "flow", project: "spec-project", idempotencyKey: input.idempotencyKey,
      conditions: [
        { ...input.conditions[1]!, report: { ...input.conditions[1]!.report, inputSources: [spec, git] },
          evaluation: { value: "unknown", reason: "Awaiting report" } },
        { ...input.conditions[0]!, evaluation: { value: "true", report } },
      ], branches: [
        { ...input.branches[1], packageId: "package-b", eligibility: "unknown" },
        { ...input.branches[0], packageId: "package-a", eligibility: "admitted", admission: { id: "admission", proof: {
          flowId: "flow", conditionKey: "pass", value: "true", report,
        } } },
      ], joins: [], configuredBy: "actual-pm", configuredAt: "now" };
    const manager = vi.spyOn(MailClient, "requestManagerPlan").mockResolvedValue(receipt);
    const knowledge = vi.spyOn(MailClient, "requestProjectKnowledge").mockResolvedValue(receipt);
    expect((yield* call(built, "workbench_arm_report_flow", { ...input, actor: "forged", project: "other",
      conditions: input.conditions.map((condition) => ({ ...condition, evaluation: { value: "false" } })),
      branches: input.branches.map((branch) => ({ ...branch, packageId: "forged", admission: {} })),
    })).at(-1)!.result).toEqual(receipt);
    expect(manager).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation, "pm-report-flow-arm", input, expect.any(AbortSignal));
    const candidateInput = { ...input, candidateAttemptId: "attempt-1" };
    const candidateReceipt = { ...receipt, candidateAttemptId: "attempt-1" };
    manager.mockResolvedValueOnce(candidateReceipt);
    expect((yield* call(built, "workbench_arm_report_flow", candidateInput)).at(-1)!.result).toEqual(candidateReceipt);
    expect(manager).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation,
      "pm-report-flow-arm", candidateInput, expect.any(AbortSignal));
    manager.mockResolvedValueOnce(receipt);
    expect((yield* call(built, "workbench_arm_report_flow", candidateInput).pipe(Effect.flip)).message).toContain("outcome unconfirmed");
    expect((yield* call(built, "workbench_read_report_flow", { runId: "run-b", project: "other" })).at(-1)!.result).toEqual(receipt);
    expect(knowledge).toHaveBeenLastCalledWith({ ...local, project: "spec-project" },
      { environmentId: invocation.environmentId, nativeProjectId: thread.projectId }, "report-flow-read", { runId: "run-b" }, expect.any(AbortSignal));
    expect((yield* call(built, "workbench_read_report_flow", { flowId: "flow" })).at(-1)!.result).toEqual(receipt);
    for (const [value, eligibility] of [["unknown", "unknown"], ["false", "unselected"], ["true", "selected"],
      ["true", "admitted"], ["false", "cancelled"]] as const) {
      const projection = { ...receipt,
        conditions: receipt.conditions.map((condition) => condition.key === "wait" ? { ...condition, evaluation: { value } } : condition),
        branches: receipt.branches.map((branch) => branch.runId === "run-b" ? { ...branch, eligibility } : branch) };
      knowledge.mockResolvedValueOnce(projection);
      expect((yield* call(built, "workbench_read_report_flow", { runId: "run-b" })).at(-1)!.result).toEqual(projection);
    }
    const cancelled = { ...receipt, cancelledBy: "actual-pm", cancelReason: "Stop future work", cancelledAt: "later" };
    manager.mockResolvedValueOnce(cancelled);
    expect((yield* call(built, "workbench_cancel_report_flow", { flowId: "flow", reason: "  Stop future work  ", actor: "forged" })).at(-1)!.result).toEqual(cancelled);
    expect(manager).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation,
      "pm-report-flow-cancel", { flowId: "flow", reason: "Stop future work" }, expect.any(AbortSignal));
    for (const [name, fields, readonly] of [
      ["workbench_arm_report_flow", ["idempotencyKey", "conditions", "branches", "candidateAttemptId"], false],
      ["workbench_read_report_flow", ["flowId", "runId"], true],
      ["workbench_cancel_report_flow", ["flowId", "reason"], false],
    ] as const) {
      const tool = WorkbenchMailToolkit.tools[name];
      expect(Object.keys(Tool.getJsonSchema(tool).properties ?? {})).toEqual(fields);
      expect(Context.get(tool.annotations, Tool.Readonly)).toBe(readonly);
    }
    for (const invalid of [{}, { flowId: "flow", runId: "run-a" }]) {
      expect(Exit.isFailure(yield* call(built, "workbench_read_report_flow", invalid).pipe(Effect.exit))).toBe(true);
    }
    expect(knowledge).toHaveBeenCalledTimes(7);
    for (const wrong of [
      { ...receipt, idempotencyKey: "other" },
      { ...receipt, conditions: receipt.conditions.map((condition) => condition.key === "pass" ? { ...condition, report: { ...condition.report, deliveryId: "other" } } : condition) },
      { ...receipt, conditions: receipt.conditions.map((condition) => condition.key === "pass" ? { ...condition, report: { ...condition.report, inputSources: [git] } } : condition) },
      { ...receipt, branches: receipt.branches.map((branch) => branch.runId === "run-a" ? { ...branch, conditionKey: "wait" } : branch) },
      { ...receipt, conditions: receipt.conditions.map((condition) => condition.key === "pass" ? { ...condition, evaluation: undefined } : condition) },
    ]) {
      manager.mockResolvedValueOnce(wrong);
      expect((yield* call(built, "workbench_arm_report_flow", input).pipe(Effect.flip)).message).toContain("outcome unconfirmed");
    }
    knowledge.mockResolvedValueOnce({ ...receipt, id: "other" });
    expect((yield* call(built, "workbench_read_report_flow", { flowId: "flow" }).pipe(Effect.flip)).message).toContain("identity mismatch");
    knowledge.mockResolvedValueOnce({ ...receipt, branches: receipt.branches.filter((branch) => branch.runId !== "run-b") });
    expect((yield* call(built, "workbench_read_report_flow", { runId: "run-b" }).pipe(Effect.flip)).message).toContain("identity mismatch");
    for (const wrong of [receipt, { ...cancelled, id: "other" }, { ...cancelled, cancelledAt: undefined },
      { ...cancelled, cancelledBy: undefined }, { ...cancelled, cancelReason: "Different reason" }]) {
      manager.mockResolvedValueOnce(wrong);
      expect((yield* call(built, "workbench_cancel_report_flow", { flowId: "flow", reason: "Stop future work" }).pipe(Effect.flip)).message)
        .toContain("outcome unconfirmed");
    }
    expect(readHead).not.toHaveBeenCalled();
  }));
  it.effect("keeps report and judgment conditions distinct with exact append-only judgment receipts", () => Effect.gen(function* () {
    const local = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-secret", projects: { "native-project": "spec-project" } };
    const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(snapshots()))));
    const source = { kind: "specgraph", specSlug: "criterion", field: "intent", changeId: "source-change" };
    const git = { kind: "git", environmentId: "native-environment", repositoryRoot: "C:/repo", commitSha: "a".repeat(40), path: "evidence.md" };
    const input = { idempotencyKey: "mixed-flow", conditions: [
      { key: "test", kind: "report", report: { deliveryId: "delivery", planSource: source, inputSources: [git] } },
      { key: "human", kind: "judgment", judgment: { criterion: "Original evidence is sufficient", inputSources: [source, git], deliveryId: "delivery" } },
    ], branches: [{ runId: "prepared-run", conditionKey: "human", when: "true" }] };
    const report = { id: "test-report", deliveryId: "delivery", commitSha: "a".repeat(40), status: "passed",
      planSources: [source], createdAt: "earlier" };
    const initial = { id: "flow", project: "spec-project", idempotencyKey: input.idempotencyKey,
      conditions: [
        { ...input.conditions[1]!, judgment: { ...input.conditions[1]!.judgment, inputSources: [git, source] },
          evaluation: { value: "unknown", reason: "judgment_missing" } },
        { ...input.conditions[0]!, evaluation: { value: "true", report } },
      ], branches: [{ ...input.branches[0], packageId: "package", eligibility: "unknown" }], joins: [],
      configuredBy: "actual-pm", configuredAt: "now" };
    const manager = vi.spyOn(MailClient, "requestManagerPlan").mockResolvedValueOnce(initial);
    const knowledge = vi.spyOn(MailClient, "requestProjectKnowledge");
    expect((yield* call(built, "workbench_arm_report_flow", input)).at(-1)!.result).toEqual(initial);
    expect(manager).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation, "pm-report-flow-arm", input, expect.any(AbortSignal));
    for (const inputSources of [undefined, null]) {
      const malformed = { ...input, conditions: [input.conditions[0], { ...input.conditions[1],
        judgment: { ...input.conditions[1]!.judgment, inputSources } }] };
      expect(Exit.isFailure(yield* call(built, "workbench_arm_report_flow", malformed).pipe(Effect.exit))).toBe(true);
    }
    const humanOnly = { idempotencyKey: "pure-human", conditions: [{ key: "human", kind: "judgment",
      judgment: { criterion: "Explicit human selection", inputSources: [] } }], branches: input.branches };
    const humanOnlyView = { ...initial, id: "human-flow", idempotencyKey: humanOnly.idempotencyKey,
      conditions: [{ ...humanOnly.conditions[0], evaluation: { value: "unknown", reason: "judgment_missing" } }] };
    manager.mockResolvedValueOnce(humanOnlyView);
    expect((yield* call(built, "workbench_arm_report_flow", humanOnly)).at(-1)!.result).toEqual(humanOnlyView);
    const emptyRecord = { flowId: "human-flow", conditionKey: "human", expectedJudgmentId: null,
      value: "true", inputRefs: [], reason: "Human selected this path" };
    const emptyJudgment = { id: "human-judgment", flowId: "human-flow", conditionKey: "human", value: "true",
      inputRefs: [], reason: emptyRecord.reason, actorUserId: "actual-user", recordedAt: "now" };
    manager.mockResolvedValueOnce({ judgment: emptyJudgment, replayed: false });
    expect((yield* call(built, "workbench_record_report_judgment", emptyRecord)).at(-1)!.result)
      .toEqual({ judgment: emptyJudgment, replayed: false });
    for (const changed of [
      { ...initial, conditions: initial.conditions.map((condition) => condition.key === "human"
        ? { ...condition, judgment: { ...condition.judgment, criterion: "Different question" } } : condition) },
      { ...initial, conditions: initial.conditions.map((condition) => condition.key === "human"
        ? { ...condition, kind: "report", report: input.conditions[0]!.report, judgment: undefined } : condition) },
    ]) {
      manager.mockResolvedValueOnce(changed);
      expect((yield* call(built, "workbench_arm_report_flow", input).pipe(Effect.flip)).message).toContain("outcome unconfirmed");
    }
    const record = { flowId: "flow", conditionKey: "human", expectedJudgmentId: null, value: "true",
      inputRefs: [source, git], reason: "Originals establish the criterion" };
    const first = { id: "judgment-1", flowId: "flow", conditionKey: "human", value: "true", inputRefs: [git, source],
      reason: record.reason, actorUserId: "actual-user", actorRunId: "actual-pm", recordedAt: "r1" };
    manager.mockResolvedValueOnce({ judgment: first, replayed: false });
    expect((yield* call(built, "workbench_record_report_judgment", { ...record, actor: "forged", project: "forged" })).at(-1)!.result)
      .toEqual({ judgment: first, replayed: false });
    for (const inputRefs of [undefined, null]) {
      expect(Exit.isFailure(yield* call(built, "workbench_record_report_judgment", { ...record, inputRefs }).pipe(Effect.exit))).toBe(true);
    }
    expect(manager).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation,
      "pm-report-judgment-record", record, expect.any(AbortSignal));
    manager.mockResolvedValueOnce({ judgment: first, replayed: true });
    expect((yield* call(built, "workbench_record_report_judgment", record)).at(-1)!.result).toEqual({ judgment: first, replayed: true });
    const correction = { ...record, expectedJudgmentId: "judgment-1", value: "unknown", reason: "New source revision needs review" };
    const second = { ...first, id: "judgment-2", predecessorId: "judgment-1", value: "unknown", reason: correction.reason, recordedAt: "r2" };
    manager.mockResolvedValueOnce({ judgment: second, replayed: false });
    expect((yield* call(built, "workbench_record_report_judgment", correction)).at(-1)!.result).toEqual({ judgment: second, replayed: false });
    const page = { flowId: "flow", conditionKey: "human", judgments: [second, first], hasMore: true, nextCursor: "judgment-1" };
    knowledge.mockResolvedValueOnce(page);
    expect((yield* call(built, "workbench_read_report_judgment_history", { flowId: "flow", conditionKey: "human", cursor: "older", actor: "forged" })).at(-1)!.result)
      .toEqual(page);
    expect(knowledge).toHaveBeenLastCalledWith({ ...local, project: "spec-project" },
      { environmentId: invocation.environmentId, nativeProjectId: thread.projectId },
      "report-judgment-history", { flowId: "flow", conditionKey: "human", cursor: "older" }, expect.any(AbortSignal));
    knowledge.mockResolvedValueOnce({ flowId: "flow", conditionKey: "human", judgments: [], hasMore: false });
    expect((yield* call(built, "workbench_read_report_judgment_history", { flowId: "flow", conditionKey: "human" })).at(-1)!.result)
      .toEqual({ flowId: "flow", conditionKey: "human", judgments: [], hasMore: false });
    const correctedFlow = { ...initial, conditions: initial.conditions.map((condition) => condition.key === "human"
      ? { ...condition, evaluation: { value: "unknown", judgment: second } } : condition),
      branches: [{ ...initial.branches[0], eligibility: "admitted", admission: { id: "admission", proof: {
        flowId: "flow", conditionKey: "human", value: "true", judgment: first,
      } } }] };
    knowledge.mockResolvedValueOnce(correctedFlow);
    const read = (yield* call(built, "workbench_read_report_flow", { flowId: "flow" })).at(-1)!.result as typeof correctedFlow;
    const current = read.conditions.find((condition) => condition.key === "human")?.evaluation;
    expect(current && "judgment" in current ? current.judgment?.id : undefined).toBe("judgment-2");
    expect(read.branches[0]!.admission.proof.judgment.id).toBe("judgment-1");
    for (const bad of [
      { judgment: { ...first, flowId: "other" }, replayed: false },
      { judgment: { ...first, predecessorId: "other" }, replayed: false },
      { judgment: { ...first, value: "false" }, replayed: false },
      { judgment: { ...first, inputRefs: [source] }, replayed: false },
    ]) {
      manager.mockResolvedValueOnce(bad);
      expect((yield* call(built, "workbench_record_report_judgment", record).pipe(Effect.flip)).message).toContain("outcome unconfirmed");
    }
    knowledge.mockResolvedValueOnce({ ...page, judgments: [{ ...first, conditionKey: "other" }] });
    expect((yield* call(built, "workbench_read_report_judgment_history", { flowId: "flow", conditionKey: "human" }).pipe(Effect.flip)).message)
      .toContain("identity mismatch");
    for (const [name, fields, readonly] of [
      ["workbench_record_report_judgment", ["flowId", "conditionKey", "expectedJudgmentId", "value", "inputRefs", "reason"], false],
      ["workbench_read_report_judgment_history", ["flowId", "conditionKey", "cursor"], true],
    ] as const) {
      const tool = WorkbenchMailToolkit.tools[name];
      expect(Object.keys(Tool.getJsonSchema(tool).properties ?? {})).toEqual(fields);
      expect(Context.get(tool.annotations, Tool.Readonly)).toBe(readonly);
    }
  }));
  it.effect("searches three host-scoped literal sources and exposes their independent truncation", () => Effect.gen(function* () {
    const spec = { query: "source", scope: "specgraph-records", hasMore: true, items: [
      { kind: "spec", id: "spec-id", slug: "source-node", title: "Source", status: "approved", version: 2,
        excerpt: "Original excerpt", updatedAt: "2026-09-24T00:00:00Z" },
    ] };
    const file = { path: "src/source.ts", lineNumber: 4, lineContent: "source", matchRanges: [{ start: 0, end: 6 }] };
    const conversations = Array.from({ length: 21 }, (_, index) => ({ threadId: ThreadId.make(`history-${index}`),
      projectId: thread.projectId, source: "user" as const, snippet: "source", messageCreatedAt: null }));
    const knowledge = vi.spyOn(MailClient, "requestProjectKnowledge").mockResolvedValue(spec);
    searchContents.mockReturnValue(Effect.succeed({ matches: [file], truncated: true }));
    searchThreads.mockReturnValue(Effect.succeed({ matches: conversations }));
    const built = yield* build({ ...thread, worktreePath: "C:/host/worktree" });
    const result = (yield* call(built, "workbench_search_knowledge", { query: " source ", cwd: "C:/foreign", projectId: "foreign" })).at(-1)!.result;
    expect(result).toEqual({ query: "source", complete: true, sources: {
      specgraph: { ok: true, ...spec },
      workspace: { ok: true, cwd: "C:/host/worktree", matches: [file], truncated: true },
      conversations: { ok: true, projectId: thread.projectId, matches: conversations.slice(0, 20),
        hasMore: true, includeArchived: true, oneMatchPerThread: true },
    } });
    expect(searchContents).toHaveBeenCalledExactlyOnceWith({ cwd: "C:/host/worktree", query: "source", limit: 20,
      caseSensitive: false, wholeWord: false, useRegex: false });
    expect(searchThreads).toHaveBeenCalledExactlyOnceWith({ projectId: thread.projectId, query: "source", limit: 21, includeArchived: true });
    expect(knowledge).toHaveBeenCalledExactlyOnceWith({ ...config, project: "spec-project" },
      { environmentId: invocation.environmentId, nativeProjectId: thread.projectId }, "knowledge-search", { query: "source" }, expect.any(AbortSignal));
    expect(Object.keys(Tool.getJsonSchema(WorkbenchMailToolkit.tools.workbench_search_knowledge).properties ?? {})).toEqual(["query"]);
    expect(Context.get(WorkbenchMailToolkit.tools.workbench_search_knowledge.annotations, Tool.Readonly)).toBe(true);
    expect(Context.get(WorkbenchMailToolkit.tools.workbench_search_knowledge.annotations, Tool.OpenWorld)).toBe(false);
    for (const query of ["a", " ", "x".repeat(201)]) yield* call(built, "workbench_search_knowledge", { query }).pipe(Effect.flip);
    expect(searchContents).toHaveBeenCalledTimes(1);
  }));

  it.effect("keeps per-source failures visible and fails when every source fails", () => Effect.gen(function* () {
    const spec = { query: "source", scope: "specgraph-records", hasMore: true, items: [] };
    const knowledge = vi.spyOn(MailClient, "requestProjectKnowledge").mockResolvedValueOnce(spec)
      .mockRejectedValue(new Error("Knowledge request rejected (HTTP 503)"));
    searchContents.mockReturnValue(Effect.fail(new Error("private workspace path") as never));
    searchThreads.mockReturnValue(Effect.succeed({ matches: [] }));
    const built = yield* build();
    const partial = (yield* call(built, "workbench_search_knowledge", { query: "source" })).at(-1)!.result as { complete: boolean; sources: Record<string, unknown> };
    expect(partial.complete).toBe(false);
    expect(partial.sources.workspace).toEqual({ ok: false, error: "Workspace content search failed" });
    expect(searchContents).toHaveBeenCalledWith({ cwd: project.workspaceRoot, query: "source", limit: 20,
      caseSensitive: false, wholeWord: false, useRegex: false });
    expect(partial.sources.specgraph).toEqual({ ok: true, ...spec });
    searchThreads.mockReturnValue(Effect.fail(new Error("private database path") as never));
    const failure = yield* call(built, "workbench_search_knowledge", { query: "source" }).pipe(Effect.flip);
    expect(failure.message).toContain("All knowledge sources failed");
    expect(failure.message).not.toContain("private");
    expect(knowledge).toHaveBeenCalledTimes(2);
  }));

  it.effect("requires active thread and native project before any source query", () => Effect.gen(function* () {
    const knowledge = vi.spyOn(MailClient, "requestProjectKnowledge");
    for (const [shell, nativeProject] of [[null, project], [{ ...thread, archivedAt: "now" }, project], [thread, null]] as const) {
      const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(config).pipe(Layer.provide(snapshots(shell, nativeProject)))));
      yield* call(built, "workbench_search_knowledge", { query: "source" }).pipe(Effect.flip);
    }
    expect(knowledge).not.toHaveBeenCalled();
    expect(searchContents).not.toHaveBeenCalled();
    expect(searchThreads).not.toHaveBeenCalled();
  }));

  it.effect("reads exact program state/history and records PM judgments without command or identity overrides", () => Effect.gen(function* () {
    const local = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-secret", projects: { "native-project": "spec-project" } };
    const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(snapshots()))));
    const policy = { kind: "innovative", termination: { kind: "judgment", judgment: { criterion: "Original output satisfies task" } },
      maxAttempts: 3, synchronousCompletionBasis: "Process returns after final durable output write" };
    const attempt = { id: "attempt-original", ordinal: 1, grantedAt: "now" };
    const result = { outcome: "exited", exitCode: 0, observedAt: "now", startedAt: "earlier", finishedAt: "now", timedOutAt: null,
      cancelRequestedAt: null, summary: "Observed process exit", reporterUserId: "actual-host", recordedAt: "now" };
    const run = { context: { runId: "program", taskSlug: "task", packageId: "frozen-package", body: { program: { loop: policy } }, createdAt: "then" },
      executorKind: "program", state: "dispatched", dispatch: { admission: {}, resolution: null, cancellation: null, stopConfirmation: null },
      result, currentAttempt: attempt, loopState: { status: "waiting" }, replayed: false };
    const event = { id: "event-original", runId: "program", attemptId: attempt.id, kind: "condition", value: "unknown",
      actorUserId: "actual-user", actorRunId: "actual-pm", reason: "Original outputs insufficient", recordedAt: "now" };
    const knowledge = vi.spyOn(MailClient, "requestProjectKnowledge").mockResolvedValueOnce(run);
    expect((yield* call(built, "workbench_read_program_loop", { runId: "program", project: "foreign", scope: "forged" })).at(-1)!.result).toEqual(run);
    expect(knowledge).toHaveBeenLastCalledWith({ ...local, project: "spec-project" },
      { environmentId: invocation.environmentId, nativeProjectId: thread.projectId }, "program-loop-read", { runId: "program" }, expect.any(AbortSignal));
    const completion = { eventId: "completion-event", attemptId: attempt.id, judgmentId: "event-original" };
    const completed = { ...run, state: "completed", completion,
      loopState: { status: "completed", condition: { value: "true", judgmentId: "later-judgment" }, completion } };
    knowledge.mockResolvedValueOnce(completed);
    expect((yield* call(built, "workbench_read_program_loop", { runId: "program" })).at(-1)!.result).toEqual(completed);
    const history = { attempts: [{ ...attempt, result }], events: [event], nextAttemptCursor: attempt.id, nextEventCursor: event.id };
    for (const [input, page] of [
      [{ runId: "program" }, history],
      [{ runId: "program", attemptCursor: attempt.id, eventCursor: event.id }, { attempts: [], events: [], nextAttemptCursor: "", nextEventCursor: "" }],
    ]) {
      knowledge.mockResolvedValueOnce(page);
      expect((yield* call(built, "workbench_read_program_loop_history", { ...input, actor: "forged", limit: 1000 })).at(-1)!.result).toEqual(page);
      expect(knowledge).toHaveBeenLastCalledWith({ ...local, project: "spec-project" },
        { environmentId: invocation.environmentId, nativeProjectId: thread.projectId }, "program-loop-history", input, expect.any(AbortSignal));
    }
    knowledge.mockResolvedValueOnce({ ...run, context: { ...run.context, runId: "foreign" } });
    expect((yield* call(built, "workbench_read_program_loop", { runId: "program" }).pipe(Effect.flip)).message).toContain("identity mismatch");
    knowledge.mockResolvedValueOnce({ ...history, events: [{ ...event, runId: "foreign" }] });
    expect((yield* call(built, "workbench_read_program_loop_history", { runId: "program" }).pipe(Effect.flip)).message).toContain("identity mismatch");
    const manager = vi.spyOn(MailClient, "requestManagerPlan");
    const decision = { runId: "program", attemptId: attempt.id, value: "unknown", basis: event.reason,
      expectedJudgmentId: null };
    const stop = { runId: "program", reason: "Stop future only" };
    for (const value of ["true", "false", "unknown"]) {
      const input = { ...decision, value };
      manager.mockResolvedValueOnce({ ...event, value });
      expect((yield* call(built, "workbench_record_program_loop_decision", { ...input, command: "forged", maxAttempts: 100, actorUserId: "forged" })).at(-1)!.result).toEqual({ ...event, value });
      expect(manager).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation, "pm-record-program-loop-decision", input, expect.any(AbortSignal));
    }
    const correction = { ...decision, value: "false", basis: "Corrected original evidence", expectedJudgmentId: event.id };
    const correctedEvent = { ...event, id: "event-corrected", value: "false", reason: correction.basis, predecessorId: event.id };
    manager.mockResolvedValueOnce(correctedEvent);
    expect((yield* call(built, "workbench_record_program_loop_decision", correction)).at(-1)!.result).toEqual(correctedEvent);
    const laterCorrection = { ...decision, value: "true", basis: "Later grounds", expectedJudgmentId: correctedEvent.id };
    const laterEvent = { ...event, id: "event-later", value: "true", reason: laterCorrection.basis, predecessorId: correctedEvent.id };
    manager.mockResolvedValueOnce(laterEvent);
    expect((yield* call(built, "workbench_record_program_loop_decision", laterCorrection)).at(-1)!.result).toEqual(laterEvent);
    manager.mockResolvedValueOnce(correctedEvent);
    expect((yield* call(built, "workbench_record_program_loop_decision", correction)).at(-1)!.result).toEqual(correctedEvent);
    const stopEvent = { id: "stop-original", runId: "program", kind: "stop", reason: stop.reason,
      actorUserId: "actual-user", actorRunId: "actual-pm", recordedAt: "now" };
    manager.mockResolvedValueOnce(stopEvent);
    expect((yield* call(built, "workbench_stop_program_loop", { ...stop, scope: "forged", project: "foreign" })).at(-1)!.result).toEqual(stopEvent);
    expect(manager).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation, "pm-stop-program-loop", stop, expect.any(AbortSignal));
    for (const invalid of [{ ...decision, value: true }, { ...decision, value: "success" }, { ...decision, attemptId: "" },
      { ...decision, basis: " " }, { ...decision, expectedJudgmentId: undefined }]) {
      expect(Exit.isFailure(yield* call(built, "workbench_record_program_loop_decision", invalid).pipe(Effect.exit))).toBe(true);
    }
    expect(manager).toHaveBeenCalledTimes(7);
    for (const receipt of [{ ...event, runId: "foreign" }, { ...event, attemptId: "later-attempt" }, { ...event, value: "true" },
      { ...event, reason: "Different grounds" }, { ...event, actorRunId: undefined },
      { ...event, predecessorId: "other" }, {}]) {
      manager.mockResolvedValueOnce(receipt);
      expect((yield* call(built, "workbench_record_program_loop_decision", decision).pipe(Effect.flip)).message).toContain("outcome unconfirmed");
    }
    manager.mockResolvedValueOnce({ ...correctedEvent, predecessorId: laterEvent.id });
    expect((yield* call(built, "workbench_record_program_loop_decision", correction).pipe(Effect.flip)).message).toContain("outcome unconfirmed");
    manager.mockResolvedValueOnce({ ...stopEvent, kind: "condition" });
    expect((yield* call(built, "workbench_stop_program_loop", stop).pipe(Effect.flip)).message).toContain("outcome unconfirmed");
    manager.mockRejectedValueOnce(new Error("Planning request rejected (conflict): judgment consumed"));
    expect((yield* call(built, "workbench_record_program_loop_decision", decision).pipe(Effect.flip)).message).toContain("conflict");
    expect(manager).toHaveBeenCalledTimes(17);
    for (const [name, fields] of [
      ["workbench_read_program_loop", ["runId"]], ["workbench_read_program_loop_history", ["runId", "attemptCursor", "eventCursor"]],
      ["workbench_record_program_loop_decision", ["runId", "attemptId", "value", "basis", "expectedJudgmentId"]], ["workbench_stop_program_loop", ["runId", "reason"]],
    ] as const) {
      const tool = WorkbenchMailToolkit.tools[name];
      expect(Tool.getJsonSchema(tool).type).toBe("object");
      expect(Object.keys(Tool.getJsonSchema(tool).properties ?? {})).toEqual(fields);
      expect(Tool.getJsonSchemaFromSchema(tool.successSchema).type).toBe("object");
    }
    expect(readHead).not.toHaveBeenCalled();
    expect(providerSnapshots).not.toHaveBeenCalled();
  }));

  it.effect("registers scoped conditional PM marks and validates original paginated receipts without retry", () => Effect.gen(function* () {
    const local = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-secret", projects: { "native-project": "spec-project" } };
    const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(snapshots()))));
    const mark = { id: "41", taskSlug: "task", kind: "risk", value: "watch", reason: "Original basis", actor: "pm:actual", createdAt: "now" };
    const input = { taskSlug: "task", kind: "risk", value: "watch", reason: "Original basis", expectedMarkId: "" };
    const manager = vi.spyOn(MailClient, "requestManagerPlan").mockResolvedValueOnce(mark);
    expect((yield* call(built, "workbench_set_node_mark", { ...input, project: "foreign", actor: "forged", scope: "forged", confidence: 1, confirmed: true })).at(-1)!.result).toEqual(mark);
    expect(manager).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation, "pm-set-node-mark", input, expect.any(AbortSignal));
    for (const [kind, value] of [["risk", "high"], ["risk", "cleared"], ["critical", "marked"], ["critical", "cleared"]]) {
      const changed = { ...input, kind, value, expectedMarkId: "41" };
      manager.mockResolvedValueOnce({ ...mark, kind, value });
      expect((yield* call(built, "workbench_set_node_mark", changed)).at(-1)!.result).toEqual({ ...mark, kind, value });
      expect(manager).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation, "pm-set-node-mark", changed, expect.any(AbortSignal));
    }
    const invalid = [{ ...input, expectedMarkId: undefined }, { ...input, expectedMarkId: "01" }, { ...input, expectedMarkId: 41 },
      { ...input, kind: "risk", value: "marked" }, { ...input, kind: "critical", value: "high" },
      { ...input, reason: " " }, { ...input, reason: "x".repeat(4001) }];
    for (const value of invalid) expect(Exit.isFailure(yield* call(built, "workbench_set_node_mark", value).pipe(Effect.exit))).toBe(true);
    expect(manager).toHaveBeenCalledTimes(5);
    for (const result of [{ ...mark, id: "" }, { ...mark, actor: null }, { ...mark, kind: "critical" },
      { ...mark, taskSlug: "foreign" }, { ...mark, value: "high" }, { ...mark, reason: "Different grounds" }]) {
      manager.mockResolvedValueOnce(result);
      expect((yield* call(built, "workbench_set_node_mark", input).pipe(Effect.flip)).message).toContain("outcome unconfirmed");
    }
    manager.mockRejectedValueOnce(new Error("Planning request rejected (conflict)"));
    expect((yield* call(built, "workbench_set_node_mark", input).pipe(Effect.flip)).message).toContain("conflict");
    manager.mockRejectedValueOnce(new Error("Planning outcome unconfirmed; inspect history"));
    expect((yield* call(built, "workbench_set_node_mark", input).pipe(Effect.flip)).message).toContain("outcome unconfirmed");
    expect(manager).toHaveBeenCalledTimes(13);
    const knowledge = vi.spyOn(MailClient, "requestProjectKnowledge");
    for (const [readInput, history] of [
      [{ taskSlug: "task" }, { items: [mark], hasMore: true, nextCursor: "41" }],
      [{ taskSlug: "task", cursor: "41" }, { items: [], hasMore: false, nextCursor: "" }],
      [{ taskSlug: "task", cursor: "" }, { items: [mark], hasMore: false, nextCursor: "" }],
    ]) {
      knowledge.mockResolvedValueOnce(history);
      expect((yield* call(built, "workbench_read_node_mark_history", { ...readInput, project: "foreign", actor: "forged", scope: "forged" })).at(-1)!.result).toEqual(history);
      expect(knowledge).toHaveBeenLastCalledWith({ ...local, project: "spec-project" },
        { environmentId: invocation.environmentId, nativeProjectId: thread.projectId }, "node-mark-history", readInput, expect.any(AbortSignal));
    }
    expect(Exit.isFailure(yield* call(built, "workbench_read_node_mark_history", { taskSlug: "task", cursor: "01" }).pipe(Effect.exit))).toBe(true);
    expect(knowledge).toHaveBeenCalledTimes(3);
    for (const history of [{ items: [{ ...mark, taskSlug: "foreign" }], hasMore: false, nextCursor: "" },
      { items: [{ ...mark, kind: "critical" }], hasMore: false, nextCursor: "" }, { items: [], hasMore: false, nextCursor: null }]) {
      knowledge.mockResolvedValueOnce(history);
      expect((yield* call(built, "workbench_read_node_mark_history", { taskSlug: "task" }).pipe(Effect.flip)).message).toContain("mark history");
    }
    for (const name of ["workbench_set_node_mark", "workbench_read_node_mark_history"] as const) {
      const fields = Object.keys(Tool.getJsonSchema(WorkbenchMailToolkit.tools[name]).properties ?? {});
      for (const field of ["actor", "project", "scope", "confidence", "confirmed", "environment_id", "native_project_id"]) expect(fields).not.toContain(field);
    }
    expect(Object.keys(Tool.getJsonSchema(WorkbenchMailToolkit.tools.workbench_set_node_mark).properties ?? {}))
      .toEqual(["taskSlug", "kind", "value", "reason", "expectedMarkId"]);
    expect(readHead).not.toHaveBeenCalled();
    expect(providerSnapshots).not.toHaveBeenCalled();
  }));

  it.effect("round trips summary references and history through host-scoped reads and current PM writes", () => Effect.gen(function* () {
    const local = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-secret", projects: { "native-project": "spec-project" } };
    const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(snapshots()))));
    const references = { nodes: [
      { id: "goal-id", slug: "goal", role: "summary", sourceRefs: { intent: "goal-source" }, lifecycleChangeId: "role-change" },
      { id: "work-id", slug: "work", role: "work", sourceRefs: { specify: "work-source" }, lifecycleChangeId: "terminal-change" },
    ], relations: [
      { fromSlug: "goal", toSlug: "work", type: "COMPOSES", changeId: "live-edge", present: true },
      { fromSlug: "goal", toSlug: "former-work", type: "COMPOSES", changeId: "removed-edge", present: false },
    ], dispositionIds: ["disposition"], decisionSources: [{ id: "decision-id", slug: "decision", sourceRefs: { body: "decision-source" } }] };
    const source = { kind: "specgraph", specSlug: "work", field: "specify", changeId: "work-source" };
    const dispositionInput = { goalSlug: "goal", affectedSlug: "work", disposition: "retain", reviewDecisionId: "approval",
      beforeSources: [source], afterSources: [source], reason: "Actual sources preserve obligations", idempotencyKey: "disposition-intent" };
    const actor = { actorKind: "agent", actorUserId: "actual-user", actorRunId: "actual-pm", createdAt: "now" };
    const disposition = { ...dispositionInput, ...actor, id: "disposition" };
    const state = { goalSlug: "goal", acceptable: true, accepted: false, blockers: [],
      obligations: [{ slug: "work", role: "work", stage: "done", disposition: "retain", dispositionId: "disposition", effective: true, pendingReview: false }],
      latestAcceptance: null, dispositions: [disposition], references,
      changedSources: [{ slug: "work", field: "specify", before: "previous-change", after: "work-source" }], scopeChanged: true, reviewCandidates: ["work"] };
    const knowledge = vi.spyOn(MailClient, "requestProjectKnowledge").mockResolvedValueOnce(state);
    const read = (yield* call(built, "workbench_read_summary", { goalSlug: "goal", actor: "forged", project: "foreign", environment_id: "forged" })).at(-1)!.result;
    expect(read).toEqual(state);
    expect(knowledge).toHaveBeenLastCalledWith({ ...local, project: "spec-project" },
      { environmentId: invocation.environmentId, nativeProjectId: thread.projectId }, "summary-status", { goalSlug: "goal" }, expect.any(AbortSignal));
    const acceptInput = { goalSlug: "goal", basis: "Read current original sources", evidenceSources: [source], goalsSatisfied: true,
      idempotencyKey: "accept-intent", expectedReferences: (read as typeof state).references,
      impactReview: [{ slug: "work", basis: "Compared original versions", dispositionId: "disposition" }] };
    const acceptance = { ...acceptInput, ...actor, id: "acceptance", revokedAt: null, revokedByUserId: null,
      revokedByRunId: null, revocationReason: null, current: true };
    const manager = vi.spyOn(MailClient, "requestManagerPlan").mockResolvedValueOnce(disposition);
    expect((yield* call(built, "workbench_record_summary_disposition", { ...dispositionInput, actor: "forged", scope: "forged", project: "foreign" })).at(-1)!.result).toEqual(disposition);
    expect(manager).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation, "pm-summary-disposition", dispositionInput, expect.any(AbortSignal));
    manager.mockResolvedValueOnce(acceptance);
    expect((yield* call(built, "workbench_accept_summary", { ...acceptInput, actor: "forged", scope: "forged" })).at(-1)!.result).toEqual(acceptance);
    expect(manager).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation, "pm-accept-summary", acceptInput, expect.any(AbortSignal));
    const revoke = { acceptanceId: "acceptance", reason: "Original source changed" };
    const revoked = { ...acceptance, current: false, revokedAt: "later", revokedByUserId: "actual-user", revokedByRunId: "actual-pm", revocationReason: revoke.reason };
    manager.mockResolvedValueOnce(revoked);
    expect((yield* call(built, "workbench_revoke_summary_acceptance", { ...revoke, actor: "forged", scope: "forged" })).at(-1)!.result).toEqual(revoked);
    expect(manager).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation, "pm-revoke-summary-acceptance", revoke, expect.any(AbortSignal));
    for (const [input, history] of [
      [{ goalSlug: "goal", kind: "acceptances" }, { goalSlug: "goal", kind: "acceptances", acceptances: [revoked], hasMore: true, nextCursor: "original-row-id" }],
      [{ goalSlug: "goal", kind: "acceptances", cursor: "original-row-id" }, { goalSlug: "goal", kind: "acceptances", hasMore: false, nextCursor: "" }],
      [{ goalSlug: "goal", kind: "dispositions" }, { goalSlug: "goal", kind: "dispositions", dispositions: [disposition], hasMore: false, nextCursor: "" }],
    ] as const) {
      knowledge.mockResolvedValueOnce(history);
      expect((yield* call(built, "workbench_read_summary_history", { ...input, project: "foreign", actor: "forged" })).at(-1)!.result).toEqual(history);
      expect(knowledge).toHaveBeenLastCalledWith({ ...local, project: "spec-project" },
        { environmentId: invocation.environmentId, nativeProjectId: thread.projectId }, "summary-history", input, expect.any(AbortSignal));
    }
    manager.mockRejectedValueOnce(new Error("conflict: Current references changed"));
    expect((yield* call(built, "workbench_accept_summary", acceptInput).pipe(Effect.flip)).message).toBe("conflict: Current references changed");
    const pendingInput = { goalSlug: "goal", affectedSlug: "work", disposition: "needs_review", reason: "Unknown impact needs investigation", idempotencyKey: "pending-intent" };
    const pending = { ...pendingInput, ...actor, id: "pending", reviewDecisionId: "", beforeSources: [], afterSources: [] };
    manager.mockResolvedValueOnce(pending);
    expect((yield* call(built, "workbench_record_summary_disposition", pendingInput)).at(-1)!.result).toEqual(pending);
    expect(manager).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation, "pm-summary-disposition", pendingInput, expect.any(AbortSignal));
    manager.mockRejectedValueOnce(new Error("invalid_request: Formal disposition requires matching approval and sources"));
    expect((yield* call(built, "workbench_record_summary_disposition", { ...pendingInput, disposition: "withdraw" }).pipe(Effect.flip)).message)
      .toBe("invalid_request: Formal disposition requires matching approval and sources");
    knowledge.mockResolvedValueOnce({});
    expect((yield* call(built, "workbench_read_summary", { goalSlug: "goal" }).pipe(Effect.flip)).message).toBe("Invalid summary response");
    for (const name of ["workbench_read_summary", "workbench_read_summary_history", "workbench_record_summary_disposition", "workbench_accept_summary", "workbench_revoke_summary_acceptance"] as const) {
      const fields = Object.keys(Tool.getJsonSchema(WorkbenchMailToolkit.tools[name]).properties ?? {});
      for (const field of ["actor", "project", "scope", "environment_id", "native_project_id", "hostCredential"]) expect(fields).not.toContain(field);
    }
    expect(readHead).not.toHaveBeenCalled();
    expect(providerSnapshots).not.toHaveBeenCalled();
  }));

  it.effect("configures delivery hooks through current host identity without starting execution", () => Effect.gen(function* () {
    const local = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-secret", projects: { "native-project": "spec-project" } };
    const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(snapshots()))));
    const receipt = { id: "hook", project: "spec-project", sourceRunId: "implementation", targetRunId: "prepared-test", targetPackageId: "package",
      commitSha: "a".repeat(40), configuredByRunId: "actual-pm", configuredByUserId: "actual-user", hostConsumerUserId: "actual-user", createdAt: "now",
      deliveryId: null, triggeredAt: null, cancelledAt: null, cancelledByRunId: null, cancelledByUserId: null, cancellationReason: null,
      retriedAt: null, retriedByRunId: null, retriedByUserId: null,
      dispatchStatus: null, dispatchPhase: null, dispatchDetail: null, dispatchRecordedAt: null, state: "armed" };
    const arm = { sourceRunId: receipt.sourceRunId, targetRunId: receipt.targetRunId, commitSha: receipt.commitSha, idempotencyKey: "hook-intent" };
    const cancelled = { ...receipt, state: "cancelled", cancelledAt: "later", cancelledByRunId: "actual-pm", cancelledByUserId: "actual-user", cancellationReason: "Plan changed" };
    const request = vi.spyOn(MailClient, "requestManagerPlan");
    const cases = [
      ["workbench_arm_delivery_hook", "pm-arm-delivery-hook", arm, receipt],
      ["workbench_arm_delivery_hook", "pm-arm-delivery-hook", { ...arm, deliveryId: "delivery" }, { ...receipt, deliveryId: "delivery", triggeredAt: "later", state: "pending" }],
      ["workbench_read_delivery_hook", "pm-read-delivery-hook", { hookId: "hook" }, receipt],
      ["workbench_list_delivery_hooks", "pm-list-delivery-hooks", { limit: 10, cursor: "before" }, { hooks: [receipt], nextCursor: "after" }],
      ["workbench_list_delivery_hooks", "pm-list-delivery-hooks", {}, { hooks: [], nextCursor: "" }],
      ["workbench_cancel_delivery_hook", "pm-cancel-delivery-hook", { hookId: "hook", reason: "Plan changed" }, cancelled],
      ["workbench_retry_delivery_hook", "pm-retry-delivery-hook", { hookId: "hook", reason: "Guard repaired" }, { ...receipt, state: "pending" }],
    ] as const;
    for (const [name, operation, input, result] of cases) {
      request.mockResolvedValueOnce(result);
      expect((yield* call(built, name, { ...input, actor: "forged", scope: "forged", project: "foreign", targetPackageId: "forged" })).at(-1)!.result).toEqual(result);
      expect(request).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation, operation, input, expect.any(AbortSignal));
    }
    expect(Exit.isFailure(yield* call(built, "workbench_arm_delivery_hook", { ...arm, commitSha: "HEAD" }).pipe(Effect.exit))).toBe(true);
    expect(Exit.isFailure(yield* call(built, "workbench_arm_delivery_hook", { ...arm, deliveryId: null }).pipe(Effect.exit))).toBe(true);
    expect(request).toHaveBeenCalledTimes(cases.length);
    request.mockRejectedValueOnce(new Error("Planning request rejected (forbidden)"));
    expect((yield* call(built, "workbench_read_delivery_hook", { hookId: "hook" }).pipe(Effect.flip)).message).toContain("forbidden");
    request.mockResolvedValueOnce({ ...receipt, state: "started" });
    expect((yield* call(built, "workbench_arm_delivery_hook", arm).pipe(Effect.flip)).message).toContain("outcome unconfirmed");
    for (const [name, fields] of [
      ["workbench_arm_delivery_hook", ["sourceRunId", "targetRunId", "commitSha", "idempotencyKey", "deliveryId"]],
      ["workbench_read_delivery_hook", ["hookId"]],
      ["workbench_list_delivery_hooks", ["limit", "cursor"]],
      ["workbench_cancel_delivery_hook", ["hookId", "reason"]],
      ["workbench_retry_delivery_hook", ["hookId", "reason"]],
    ] as const) expect(Object.keys(Tool.getJsonSchema(WorkbenchMailToolkit.tools[name]).properties ?? {})).toEqual(fields);
    const linked = { hookId: "hook", deliveryId: "delivery", sourceRunId: "implementation", targetRunId: "prepared-test", commitSha: receipt.commitSha };
    const own = vi.spyOn(MailClient, "requestOwnDelivery").mockResolvedValueOnce(linked);
    const forged = yield* call(built, "workbench_read_delivery_hook_context", { targetRunId: "forged", scope: "forged" }).pipe(Effect.exit);
    expect(Exit.isFailure(forged)).toBe(true);
    if (Exit.isFailure(forged)) expect(Cause.pretty(forged.cause)).toContain("ToolParameterValidationError");
    expect(own).not.toHaveBeenCalled();
    expect((yield* call(built, "workbench_read_delivery_hook_context", {})).at(-1)!.result).toEqual(linked);
    expect(own).toHaveBeenCalledExactlyOnceWith({ ...local, project: "spec-project" }, invocation, "delivery-hook-context", {}, expect.any(AbortSignal));
    expect(Object.keys(Tool.getJsonSchema(WorkbenchMailToolkit.tools.workbench_read_delivery_hook_context).properties ?? {})).toEqual([]);
    expect(readHead).not.toHaveBeenCalled();
    expect(providerSnapshots).not.toHaveBeenCalled();
  }));
  it.effect("routes PM takeover and independent history through the caller's real mailbox scope", () => Effect.gen(function* () {
    const local = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-secret", projects: { "native-project": "spec-project" } };
    const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(snapshots()))));
    const input = { mail_thread_id: "old-mail", recipient_run_id: "successor", body: "Old owner retired", idempotency_key: "takeover-intent" };
    const event = { id: "owner-event", thread_id: "old-mail", from_run: "retired", to_run: "successor", actor_kind: "agent", actor_user_id: "actual-user", actor_run_id: "actual-pm", reason: input.body, created_at: "now" };
    const receipt = { thread: { id: "old-mail", owner_run: "successor" }, event };
    const request = vi.spyOn(MailClient, "requestMail").mockResolvedValueOnce(receipt);
    expect((yield* call(built, "workbench_mail_takeover", { ...input, actor_kind: "human", actor_user_id: "forged", actor_run_id: "forged", project: "foreign", scope: "forged" })).at(-1)!.result).toEqual(receipt);
    expect(request).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation, "takeover", input, expect.any(AbortSignal));
    request.mockResolvedValueOnce({ events: [{ ...event, actor_kind: "human", actor_run_id: null }], next_cursor: "older-event" });
    const history = yield* call(built, "workbench_mail_owner_history", { mail_thread_id: "old-mail", limit: 10, cursor: "event-cursor" });
    expect(history.at(-1)!.result).toMatchObject({ next_cursor: "older-event" });
    expect(request).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation, "owner-history", { mail_thread_id: "old-mail", limit: 10, cursor: "event-cursor" }, expect.any(AbortSignal));
    request.mockResolvedValueOnce({ threads: [], next_cursor: "" });
    expect((yield* call(built, "workbench_mail_retired_threads", { limit: 10, owner_run: "forged" })).at(-1)!.result).toEqual({ threads: [], next_cursor: "" });
    expect(request).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation, "retired", { limit: 10 }, expect.any(AbortSignal));
    request.mockResolvedValueOnce({ ...receipt, event: { ...event, actor_kind: "human", actor_run_id: null } });
    expect((yield* call(built, "workbench_mail_takeover", input).pipe(Effect.flip)).message).toContain("unconfirmed");
  }));
  it.effect("hands off mail using host identity without accepting an owner or sender override", () => Effect.gen(function* () {
    const local = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-secret", projects: { "native-project": "spec-project" } };
    const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(snapshots()))));
    const input = { mail_thread_id: "mail-thread", recipient_run_id: "successor", body: "Continue unresolved work", idempotency_key: "original-handoff" };
    const receipt = { thread: { id: "mail-thread", opened_by_run: "opener", owner_run: "successor" }, message: { id: "handoff-message", handoff_to_run: "successor" } };
    const request = vi.spyOn(MailClient, "requestMail").mockResolvedValueOnce(receipt);
    expect((yield* call(built, "workbench_mail_handoff", { ...input, owner_run: "forged", sender_run: "forged", project: "foreign", scope: "forged" })).at(-1)!.result).toEqual(receipt);
    expect(request).toHaveBeenCalledExactlyOnceWith({ ...local, project: "spec-project" }, invocation, "handoff", input, expect.any(AbortSignal));
    request.mockRejectedValueOnce(new Error("Mailbox handoff rejected (forbidden)"));
    expect((yield* call(built, "workbench_mail_handoff", input).pipe(Effect.flip)).message).toContain("forbidden");
    expect(Object.keys(Tool.getJsonSchema(WorkbenchMailToolkit.tools.workbench_mail_handoff).properties ?? {})).toEqual(["mail_thread_id", "recipient_run_id", "body", "idempotency_key"]);
    const owned = { threads: [{ id: "mail-thread", owner_run: "current" }], next_cursor: "older" };
    request.mockResolvedValueOnce(owned);
    expect((yield* call(built, "workbench_mail_owned_threads", { limit: 10, cursor: "newer", owner_run: "forged" })).at(-1)!.result).toEqual(owned);
    expect(request).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation, "owned", { limit: 10, cursor: "newer" }, expect.any(AbortSignal));
  }));
  it.effect("reads native model snapshots without exposing account metadata or refreshing providers", () => Effect.gen(function* () {
    const models: ServerProvider["models"] = [{ slug: "model", name: "Model", isCustom: false,
      capabilities: { optionDescriptors: [{ id: "effort", label: "Effort", type: "select", options: [{ id: "high", label: "High" }] }] } },
      { slug: "configured-custom", name: "Configured custom", isCustom: true, capabilities: null }];
    const ready: ServerProvider = { instanceId: ProviderInstanceId.make("primary"), driver: ProviderDriverKind.make("codex"),
      enabled: true, installed: true, status: "ready", version: "test", auth: { status: "authenticated", email: "private@example.test" },
      checkedAt: "2026-09-25T00:00:00.000Z", availability: "available", models, skills: [], slashCommands: [] };
    providerSnapshots.mockReturnValue([ready, { ...ready, instanceId: ProviderInstanceId.make("disabled"), enabled: false, status: "disabled", availability: "unavailable", models: [] }]);
    const built = yield* build();
    const result = (yield* call(built, "workbench_list_dispatch_models", {})).at(-1)!.result;
    expect(result).toEqual([
      { instanceId: "primary", driver: "codex", enabled: true, status: "ready", availability: "available", checkedAt: ready.checkedAt, models },
      { instanceId: "disabled", driver: "codex", enabled: false, status: "disabled", availability: "unavailable", checkedAt: ready.checkedAt, models: [] },
    ]);
    expect(result).not.toHaveProperty("0.auth");
    providerSnapshots.mockReturnValue([]);
    expect((yield* call(built, "workbench_list_dispatch_models", {})).at(-1)!.result).toEqual([]);
    const missing = yield* build(null);
    expect((yield* call(missing, "workbench_list_dispatch_models", {}).pipe(Effect.flip)).message).toContain("active thread");
    expect(providerSnapshots).toHaveBeenCalledTimes(2);
  }));
  it.effect("reads current graph pages without model-owned project identity or swallowed failures", () => Effect.gen(function* () {
    const graph = {
      nodes: [{ slug: "child", label: "Spec", stage: "spark", priority: "p2" }],
      edges: [{ from: "parent", to: "child", type: "COMPOSES" }, { from: "child", to: "prerequisite", type: "DEPENDS_ON" }],
      totalNodes: 101, totalEdges: 2, hasMore: true, nextOffset: 100,
    };
    const request = vi.spyOn(MailClient, "requestProjectKnowledge").mockResolvedValueOnce(graph);
    const built = yield* build();
    expect((yield* call(built, "workbench_read_current_graph", { project: "forged" })).at(-1)!.result).toEqual(graph);
    expect(request).toHaveBeenLastCalledWith({ ...config, project: "spec-project" },
      { environmentId: invocation.environmentId, nativeProjectId: thread.projectId }, "graph-current", {}, expect.any(AbortSignal));
    const end = { nodes: [], edges: [], totalNodes: 101, totalEdges: 2, hasMore: false, nextOffset: null };
    request.mockResolvedValueOnce(end);
    expect((yield* call(built, "workbench_read_current_graph", { offset: 200 })).at(-1)!.result).toEqual(end);
    expect(request.mock.calls.at(-1)![3]).toEqual({ offset: 200 });
    expect(Exit.isFailure(yield* call(built, "workbench_read_current_graph", { offset: -1 }).pipe(Effect.exit))).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    request.mockRejectedValueOnce(new Error("Project knowledge rejected (forbidden)"));
    expect((yield* call(built, "workbench_read_current_graph", {}).pipe(Effect.flip)).message).toContain("forbidden");
    request.mockResolvedValueOnce({ nodes: [], edges: [] });
    expect((yield* call(built, "workbench_read_current_graph", {}).pipe(Effect.flip)).message).toBe("Invalid current graph response");
    expect(Object.keys(Tool.getJsonSchema(WorkbenchMailToolkit.tools.workbench_read_current_graph).properties ?? {})).toEqual(["offset"]);
  }));
  it.effect("routes PM plan actions through host identity and preserves exact dependency revisions", () => Effect.gen(function* () {
    const local = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-secret", projects: { "native-project": "spec-project" } };
    const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(snapshots()))));
    const request = vi.spyOn(MailClient, "requestManagerPlan");
    const draft = { slug: "child", intent: "Approved work", priority: "p2", complexity: "medium" };
    const dependency = { taskSlug: "child", prerequisite: "parent", expected_version: 1, expected_prerequisite_version: 2, expected_revision: "9007199254740993", reason: "Existing plan" };
    const cases = [
      ["workbench_create_node", "pm-create-node", draft, { spec: { slug: "child", stage: "SPEC_STAGE_SPARK", version: 1 } }],
      ["workbench_subdivide_node", "pm-subdivide-node", { taskSlug: "parent", expectedVersion: 2, reason: "Divide scope", children: [draft] }, { id: "division", parent: "parent", parentVersion: 3, childSlugs: ["child"] }],
      ["workbench_approve_execution", "pm-approve-node", { taskSlug: "child", expectedVersion: 1, basis: "Within approved scope" }, { approved: "child", version: 2 }],
      ["workbench_add_dependency", "pm-add-dependency", dependency, { operation: "add", dependent: "child", prerequisite: "parent", revision: "9007199254740994", changed: true, replayed: false }],
      ["workbench_remove_dependency", "pm-remove-dependency", dependency, { operation: "remove", dependent: "child", prerequisite: "parent", revision: "9007199254740994", changed: true, replayed: false }],
    ] as const;
    for (const [name, operation, input, receipt] of cases) {
      request.mockResolvedValueOnce(receipt);
      const result = yield* call(built, name, { ...input, actor: "forged", assignmentRole: "manager", project: "other" });
      expect(result.at(-1)!.result).toEqual(receipt);
      expect(request).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation, operation, input, expect.any(AbortSignal));
    }
    const state = { specVersion: 1, revision: "9007199254740993", operations: [] };
    const read = vi.spyOn(MailClient, "requestProjectKnowledge").mockResolvedValueOnce(state);
    expect((yield* call(built, "workbench_read_dependency_state", { taskSlug: "child", project: "other" })).at(-1)!.result).toEqual(state);
    expect(read).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, { environmentId: invocation.environmentId, nativeProjectId: thread.projectId }, "dependency-state", { taskSlug: "child" }, expect.any(AbortSignal));
    request.mockRejectedValueOnce(new Error("Planning request rejected (forbidden)"));
    expect((yield* call(built, "workbench_create_node", draft).pipe(Effect.flip)).message).toBe("Planning request rejected (forbidden)");
    request.mockResolvedValueOnce({ approved: "child" });
    expect((yield* call(built, "workbench_approve_execution", { taskSlug: "child", expectedVersion: 1, basis: "scope" }).pipe(Effect.flip)).message).toContain("outcome unconfirmed");
    expect(Context.get(WorkbenchMailToolkit.tools.workbench_remove_dependency.annotations, Tool.Destructive)).toBe(true);
  }));
  it.effect("previews and writes formal node merges with exact source identities", () => Effect.gen(function* () {
    const preview = { sources: [{ id: "id-a", slug: "a", version: 2, stage: "done", role: "work" },
      { id: "id-b", slug: "b", version: 3, stage: "shape", role: "work" }],
    relations: [{ fromSlug: "a", toSlug: "goal", type: "COMPOSES", changeId: "0" }],
    contexts: [{ id: "id-goal", slug: "goal", version: 4, stage: "shape", role: "summary" }],
    lineage: [], ancestors: [] };
    const relation = { before: preview.relations[0]!, action: "rewire", replacements: [
      { fromSlug: "c", toSlug: "goal", type: "COMPOSES", changeId: "" }] };
    const input = { expected: preview, target: { slug: "c", intent: "Combined scope", role: "work",
      priority: "p2", complexity: "medium" }, relations: [relation], addedRelations: [],
    dispositions: [], reason: "Reviewed relationships", idempotencyKey: "merge-intent" };
    const receipt = { id: "merge-1", idempotencyKey: input.idempotencyKey, request: input,
      actorUserId: "pm-user", sources: [{ id: "id-a", slug: "a", beforeVersion: 2, afterVersion: 3 },
        { id: "id-b", slug: "b", beforeVersion: 3, afterVersion: 4 }],
      target: { id: "id-c", slug: "c" }, insertedRelations: relation.replacements,
      deletedRelations: preview.relations, dispositionIds: [], createdAt: "now", replayed: false };
    expect(yield* Schema.decodeUnknownEffect(WorkbenchMergePreview)(preview)).toEqual(preview);
    expect(yield* Schema.decodeUnknownEffect(WorkbenchMergeRequest)(input)).toEqual(input);
    expect(yield* Schema.decodeUnknownEffect(WorkbenchMergeReceipt)(receipt)).toEqual(receipt);
    const read = vi.spyOn(MailClient, "requestProjectKnowledge").mockResolvedValueOnce(preview);
    const write = vi.spyOn(MailClient, "requestManagerPlan").mockResolvedValueOnce(receipt);
    const built = yield* build();
    expect((yield* call(built, "workbench_preview_node_merge", { sourceSlugs: ["a", "b"], contextSlugs: ["goal"], actor: "forged" })).at(-1)!.result).toEqual(preview);
    expect(read).toHaveBeenLastCalledWith({ ...config, project: "spec-project" },
      { environmentId: invocation.environmentId, nativeProjectId: thread.projectId },
      "preview-node-merge", { sourceSlugs: ["a", "b"], contextSlugs: ["goal"] }, expect.any(AbortSignal));
    expect((yield* call(built, "workbench_merge_nodes", { ...input, actor: "forged", project: "other" })).at(-1)!.result).toEqual(receipt);
    expect(write).toHaveBeenLastCalledWith({ ...config, project: "spec-project" }, invocation,
      "pm-merge-nodes", input, expect.any(AbortSignal));
    read.mockResolvedValueOnce({ items: [receipt], hasMore: false, nextCursor: "" });
    expect((yield* call(built, "workbench_read_node_merge_history", { taskSlug: "a" })).at(-1)!.result).toEqual({
      items: [receipt], hasMore: false, nextCursor: "",
    });
    read.mockResolvedValueOnce(receipt);
    expect((yield* call(built, "workbench_read_node_merge_receipt", { id: "merge-1" })).at(-1)!.result).toEqual(receipt);
    write.mockResolvedValueOnce({ ...receipt, target: { id: "id-other", slug: "other" } });
    expect((yield* call(built, "workbench_merge_nodes", input).pipe(Effect.flip)).message).toContain("outcome unconfirmed");
    read.mockResolvedValueOnce({ ...preview, sources: preview.sources.slice(0, 1) });
    expect((yield* call(built, "workbench_preview_node_merge", { sourceSlugs: ["a", "b"] }).pipe(Effect.flip)).message).toContain("identity mismatch");
  }));
  it.effect("submits only its saved workspace's native Git head and never writes after a Git read failure", () => Effect.gen(function* () {
    const context = { runId: "bound-run", taskSlug: "bound-task", workspace: "C:/saved-worktree" };
    const receipt = { deliveryId: "new-delivery", runId: context.runId, taskSlug: context.taskSlug };
    const head = { isRepo: true, commitSha: "b".repeat(40) };
    const request = vi.spyOn(MailClient, "requestOwnDelivery").mockResolvedValueOnce(context).mockResolvedValueOnce(receipt);
    readHead.mockReturnValueOnce(Effect.succeed(head));
    const built = yield* build();
    const result = yield* call(built, "workbench_submit_own_delivery", { summary: "Implemented scope", expectedRunId: "forged", workspace: "other", head: { isRepo: false, commitSha: null } });
    expect(result.at(-1)!.result).toEqual(receipt);
    expect(readHead).toHaveBeenCalledExactlyOnceWith({ cwd: context.workspace });
    expect(request).toHaveBeenLastCalledWith({ ...config, project: "spec-project" }, invocation, "delivery-submit-self",
      { expectedRunId: context.runId, summary: "Implemented scope", head }, expect.any(AbortSignal));
    expect(Object.keys(Tool.getJsonSchema(WorkbenchMailToolkit.tools.workbench_submit_own_delivery).properties ?? {})).toEqual(["summary", "expectedAttemptId"]);
    request.mockResolvedValueOnce(context);
    readHead.mockReturnValueOnce(Effect.fail(new GitManagerError({ operation: "readHead", cwd: context.workspace, detail: "fixture failure" })));
    const failed = yield* call(built, "workbench_submit_own_delivery", { summary: "Not recorded" }).pipe(Effect.flip);
    expect(failed.message).toBe("Git reference read failed; nothing submitted");
    expect(request).toHaveBeenCalledTimes(3);
  }));
  it.effect("requires the caller's exact formal attempt before reading HEAD or submitting delivery", () => Effect.gen(function* () {
    const context = { runId: "bound-run", taskSlug: "bound-task", workspace: "C:/saved-worktree", currentAttemptId: "attempt-2" };
    const head = { isRepo: true, commitSha: "b".repeat(40) };
    const request = vi.spyOn(MailClient, "requestOwnDelivery");
    const built = yield* build();
    for (const input of [{ summary: "Old candidate" }, { summary: "Old candidate", expectedAttemptId: "attempt-1" }]) {
      request.mockResolvedValueOnce(context);
      expect((yield* call(built, "workbench_submit_own_delivery", input).pipe(Effect.flip)).message)
        .toBe("Delivery attempt identity mismatch; nothing submitted");
    }
    expect(readHead).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
    request.mockResolvedValueOnce(context).mockResolvedValueOnce({ deliveryId: "delivery-2", runId: context.runId,
      taskSlug: context.taskSlug, attemptId: "attempt-2" });
    readHead.mockReturnValueOnce(Effect.succeed(head));
    const result = (yield* call(built, "workbench_submit_own_delivery", { summary: "Formal candidate", expectedAttemptId: "attempt-2",
      runId: "forged", actor: "forged" })).at(-1)!.result;
    expect(result).toEqual({ deliveryId: "delivery-2", runId: context.runId, taskSlug: context.taskSlug, attemptId: "attempt-2" });
    expect(request).toHaveBeenLastCalledWith({ ...config, project: "spec-project" }, invocation, "delivery-submit-self",
      { expectedRunId: context.runId, expectedAttemptId: "attempt-2", summary: "Formal candidate", head }, expect.any(AbortSignal));
    request.mockResolvedValueOnce(context).mockResolvedValueOnce({ deliveryId: "delivery-2", runId: context.runId,
      taskSlug: context.taskSlug, attemptId: "attempt-1" });
    readHead.mockReturnValueOnce(Effect.succeed(head));
    expect((yield* call(built, "workbench_submit_own_delivery", { summary: "Formal candidate", expectedAttemptId: "attempt-2" }).pipe(Effect.flip)).message)
      .toContain("outcome unconfirmed");
    request.mockResolvedValueOnce({ runId: context.runId, taskSlug: context.taskSlug, workspace: context.workspace });
    expect((yield* call(built, "workbench_submit_own_delivery", { summary: "Foreign slot", expectedAttemptId: "attempt-2" }).pipe(Effect.flip)).message)
      .toBe("Delivery attempt identity mismatch; nothing submitted");
    expect(readHead).toHaveBeenCalledTimes(2);
    expect(Object.keys(Tool.getJsonSchema(WorkbenchMailToolkit.tools.workbench_submit_own_delivery).properties ?? {}))
      .toEqual(["summary", "expectedAttemptId"]);
  }));
  it.effect("records own retry/rework declarations without inventing execution proof or another identity", () => Effect.gen(function* () {
    const local = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-secret", projects: { "native-project": "spec-project" } };
    const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(snapshots()))));
    const request = vi.spyOn(MailClient, "requestOwnNodeEvent");
    const own = vi.spyOn(MailClient, "requestOwnDelivery");
    const knowledge = vi.spyOn(MailClient, "requestProjectKnowledge");
    const retry = { eventId: "retry-1", kind: "retry" as const, reason: "A new attempt is needed" };
    const retryReceipt = { id: retry.eventId, taskSlug: "task", kind: retry.kind, reason: retry.reason,
      actor: "bound-run", previousRunId: "bound-run", runId: "bound-run", deliveryId: null, recordedAt: "now" };
    request.mockResolvedValueOnce(retryReceipt);
    expect((yield* call(built, "workbench_record_own_node_event", { ...retry, actor: "forged", taskSlug: "other", runId: "other" })).at(-1)!.result)
      .toEqual(retryReceipt);
    expect(request).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation, retry, expect.any(AbortSignal));
    const explicit = { ...retry, eventId: "retry-2", previousRunId: "previous-run" };
    request.mockResolvedValueOnce({ ...retryReceipt, id: explicit.eventId, previousRunId: explicit.previousRunId });
    expect((yield* call(built, "workbench_record_own_node_event", explicit)).at(-1)!.result)
      .toMatchObject({ id: explicit.eventId, previousRunId: explicit.previousRunId });
    const rework = { eventId: "rework-1", kind: "rework" as const, reason: "Revise the submitted artifact", deliveryId: "delivery-1" };
    const reworkReceipt = { id: rework.eventId, taskSlug: "task", kind: rework.kind, reason: rework.reason,
      actor: "bound-run", previousRunId: null, runId: null, deliveryId: rework.deliveryId, recordedAt: "later" };
    request.mockResolvedValueOnce(reworkReceipt);
    expect((yield* call(built, "workbench_record_own_node_event", rework)).at(-1)!.result)
      .toEqual(reworkReceipt);
    for (const malformed of [{ ...retry, deliveryId: "forged" }, { ...rework, previousRunId: "forged" },
      { eventId: "rework-2", kind: "rework", reason: "Missing delivery" }]) {
      expect(Exit.isFailure(yield* call(built, "workbench_record_own_node_event", malformed).pipe(Effect.exit))).toBe(true);
    }
    expect(request).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation, rework, expect.any(AbortSignal));
    const page = { taskSlug: "task", events: [reworkReceipt, retryReceipt], hasMore: false, nextCursor: null };
    knowledge.mockResolvedValueOnce(page);
    expect((yield* call(built, "workbench_read_node_events", { taskSlug: "task", cursor: "older", actor: "forged" })).at(-1)!.result).toEqual(page);
    expect(knowledge).toHaveBeenLastCalledWith({ ...local, project: "spec-project" },
      { environmentId: invocation.environmentId, nativeProjectId: thread.projectId },
      "node-events", { taskSlug: "task", cursor: "older" }, expect.any(AbortSignal));
    for (const bad of [{ ...retryReceipt, id: "other" }, { ...retryReceipt, reason: "different" },
      { ...retryReceipt, actor: "other" }, { ...retryReceipt, previousRunId: "other" },
      { ...retryReceipt, deliveryId: "delivery" }]) {
      request.mockResolvedValueOnce(bad);
      expect((yield* call(built, "workbench_record_own_node_event", retry).pipe(Effect.flip)).message).toContain("outcome unconfirmed");
    }
    request.mockResolvedValueOnce({ ...reworkReceipt, runId: "bound-run" });
    expect((yield* call(built, "workbench_record_own_node_event", rework).pipe(Effect.flip)).message).toContain("outcome unconfirmed");
    knowledge.mockResolvedValueOnce({ ...page, events: [{ ...retryReceipt, taskSlug: "other" }] });
    expect((yield* call(built, "workbench_read_node_events", { taskSlug: "task" }).pipe(Effect.flip)).message).toContain("identity mismatch");
    expect(Tool.getJsonSchemaFromSchema(WorkbenchMailToolkit.tools.workbench_record_own_node_event.successSchema).type).toBe("object");
    expect(Context.get(WorkbenchMailToolkit.tools.workbench_record_own_node_event.annotations, Tool.Readonly)).toBe(false);
    expect(Context.get(WorkbenchMailToolkit.tools.workbench_read_node_events.annotations, Tool.Readonly)).toBe(true);
    expect(request).toHaveBeenCalledTimes(9);
    expect(own).not.toHaveBeenCalled();
    expect(hasCommit).not.toHaveBeenCalled();
    expect(readHead).not.toHaveBeenCalled();
  }));
  it.effect("checks declared Git undo commits in the bound workspace before recording, without Git writes", () => Effect.gen(function* () {
    const local = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-secret", projects: { "native-project": "spec-project" } };
    const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(snapshots()))));
    const context = { runId: "bound-run", taskSlug: "task", workspace: "C:/bound-worktree" };
    const sourceCommit = "a".repeat(40);
    const resultCommit = "b".repeat(40);
    const input = { eventId: "undo-1", kind: "git_undo" as const, reason: "Declared revert",
      gitUndo: { operation: "revert" as const, sourceCommit, resultCommit } };
    const receipt = { id: input.eventId, taskSlug: context.taskSlug, kind: input.kind, reason: input.reason,
      actor: context.runId, previousRunId: null, runId: context.runId, deliveryId: null, gitUndo: input.gitUndo, recordedAt: "now" };
    const own = vi.spyOn(MailClient, "requestOwnDelivery").mockResolvedValueOnce(context);
    const request = vi.spyOn(MailClient, "requestOwnNodeEvent").mockResolvedValueOnce(receipt);
    hasCommit.mockReturnValueOnce(Effect.succeed(true)).mockReturnValueOnce(Effect.succeed(true));
    expect((yield* call(built, "workbench_record_own_node_event", { ...input, expectedRunId: "forged", taskSlug: "forged" })).at(-1)!.result)
      .toEqual(receipt);
    expect(own).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation,
      "delivery-self-context", {}, expect.any(AbortSignal));
    expect(hasCommit).toHaveBeenNthCalledWith(1, { cwd: context.workspace, refName: sourceCommit });
    expect(hasCommit).toHaveBeenNthCalledWith(2, { cwd: context.workspace, refName: resultCommit });
    expect(request).toHaveBeenLastCalledWith({ ...local, project: "spec-project" }, invocation,
      { ...input, expectedRunId: context.runId }, expect.any(AbortSignal));
    for (const malformed of [
      { ...input, gitUndo: { ...input.gitUndo, sourceCommit: "HEAD" } },
      { ...input, gitUndo: { ...input.gitUndo, resultCommit: sourceCommit } },
      { ...input, gitUndo: { ...input.gitUndo, resultCommit: sourceCommit.toUpperCase() } },
      { ...input, gitUndo: undefined },
      { ...input, previousRunId: "forged" },
    ]) expect(Exit.isFailure(yield* call(built, "workbench_record_own_node_event", malformed).pipe(Effect.exit))).toBe(true);
    expect(own).toHaveBeenCalledTimes(1);
    expect(hasCommit).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(1);
    const reset = { ...input, eventId: "undo-reset", gitUndo: { operation: "reset" as const,
      sourceCommit, resultCommit: sourceCommit.toUpperCase() } };
    own.mockResolvedValueOnce(context);
    hasCommit.mockReturnValueOnce(Effect.succeed(true)).mockReturnValueOnce(Effect.succeed(true));
    request.mockResolvedValueOnce({ ...receipt, id: reset.eventId, gitUndo: reset.gitUndo });
    expect((yield* call(built, "workbench_record_own_node_event", reset)).at(-1)!.result)
      .toMatchObject({ id: reset.eventId, gitUndo: reset.gitUndo });
    for (const [first, second] of [[false, true], [true, false]] as const) {
      own.mockResolvedValueOnce(context);
      hasCommit.mockReturnValueOnce(Effect.succeed(first));
      if (first) hasCommit.mockReturnValueOnce(Effect.succeed(second));
      expect((yield* call(built, "workbench_record_own_node_event", input).pipe(Effect.flip)).message)
        .toContain("nothing recorded");
    }
    own.mockResolvedValueOnce(context);
    hasCommit.mockReturnValueOnce(Effect.fail(new Error("private path") as never));
    expect((yield* call(built, "workbench_record_own_node_event", input).pipe(Effect.flip)).message)
      .toContain("nothing recorded");
    expect(request).toHaveBeenCalledTimes(2);
    for (const bad of [
      { ...receipt, actor: "other" }, { ...receipt, runId: "other" }, { ...receipt, taskSlug: "other" },
      { ...receipt, gitUndo: { ...input.gitUndo, operation: "reset" } },
      { ...receipt, gitUndo: { ...input.gitUndo, resultCommit: "c".repeat(40) } },
    ]) {
      own.mockResolvedValueOnce(context);
      hasCommit.mockReturnValueOnce(Effect.succeed(true)).mockReturnValueOnce(Effect.succeed(true));
      request.mockResolvedValueOnce(bad);
      expect((yield* call(built, "workbench_record_own_node_event", input).pipe(Effect.flip)).message).toContain("outcome unconfirmed");
    }
    const knowledge = vi.spyOn(MailClient, "requestProjectKnowledge").mockResolvedValueOnce({
      taskSlug: context.taskSlug, events: [receipt], hasMore: false, nextCursor: null,
    });
    expect((yield* call(built, "workbench_read_node_events", { taskSlug: context.taskSlug })).at(-1)!.result)
      .toEqual({ taskSlug: context.taskSlug, events: [receipt], hasMore: false, nextCursor: null });
    expect(knowledge).toHaveBeenCalledWith({ ...local, project: "spec-project" },
      { environmentId: invocation.environmentId, nativeProjectId: thread.projectId },
      "node-events", { taskSlug: context.taskSlug }, expect.any(AbortSignal));
    expect(readHead).not.toHaveBeenCalled();
  }));
  it.effect("reads pending human ownership without changing it and records only the bound run's phase summary", () => Effect.gen(function* () {
    const local = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-secret", projects: { "native-project": "spec-project" } };
    const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(snapshots()))));
    const pending = { id: "take-operation", taskSlug: "task", idempotencyKey: "original-take", action: "take", status: "pending",
      beforeOwnerUserId: null, afterOwnerUserId: "human-user", fromVersion: 4, actorUserId: "human-user",
      reason: "Taking responsibility after handoff", dispatches: [{ runId: "program-run", admissionId: "admission",
        executorKind: "program", environmentId: "env", nativeProjectId: "native-project", attemptId: "attempt" }],
      preparations: [{ runId: "prepared-run", packageId: "package", executorKind: "agent", state: "prepared",
        environmentId: "", threadId: "", raw: false },
      { runId: "raw-run", packageId: "raw-package", executorKind: "agent", state: "prepared",
        environmentId: "", threadId: "", raw: true }],
      handoffs: [], preparedHandoffs: [],
      frozenClaim: { agent: "claim-run", claimedAt: "before", leaseExpires: "later" }, claimHandoff: null,
      createdAt: "earlier" };
    const programResult = { outcome: "cancel_requested", exitCode: null, observedAt: "now", startedAt: "before",
      finishedAt: null, timedOutAt: null, cancelRequestedAt: "now", summary: "Request issued, not stop proof",
      reporterUserId: "host", recordedAt: "now" };
    const state = { taskSlug: "task", version: 4, humanOwnerUserId: null, pending,
      dispatchObservations: [{ runId: "program-run", admissionId: "admission", programResult }],
      preparationObservations: [{ runId: "prepared-run", packageId: "package" },
        { runId: "raw-run", packageId: "raw-package" }],
      currentClaim: { agent: "claim-run", claimedAt: "before", leaseExpires: "later" } };
    expect(yield* Schema.decodeUnknownEffect(WorkbenchNodeOwnershipState)(state)).toEqual(state);
    const knowledge = vi.spyOn(MailClient, "requestProjectKnowledge").mockResolvedValueOnce(state);
    const own = vi.spyOn(MailClient, "requestOwnNodeHandoffSummary");
    const delivery = vi.spyOn(MailClient, "requestOwnDelivery");
    expect((yield* call(built, "workbench_read_node_owner", { taskSlug: "task", actor: "forged", humanOwnerUserId: "forged" })).at(-1)!.result)
      .toEqual(state);
    expect(knowledge).toHaveBeenLastCalledWith({ ...local, project: "spec-project" },
      { environmentId: invocation.environmentId, nativeProjectId: thread.projectId },
      "node-owner-read", { taskSlug: "task" }, expect.any(AbortSignal));
    const input = { eventId: "progress-event", message: "Completed review, remaining verification is open" };
    const receipt = { ...input, runId: "bound-run", taskSlug: "task", recordedAt: "now", replayed: false };
    own.mockResolvedValueOnce(receipt);
    expect((yield* call(built, "workbench_record_own_handoff_summary", { ...input, runId: "forged", actor: "forged",
      taskSlug: "other", owner: "forged" })).at(-1)!.result).toEqual(receipt);
    expect(own).toHaveBeenLastCalledWith({ ...local, project: "spec-project" },
      { ...invocation, nativeProjectId: thread.projectId }, input, expect.any(AbortSignal));
    own.mockResolvedValueOnce({ ...receipt, replayed: true });
    expect((yield* call(built, "workbench_record_own_handoff_summary", input)).at(-1)!.result).toEqual({ ...receipt, replayed: true });
    for (const bad of [{ ...receipt, eventId: "other" }, { ...receipt, message: "Different summary" }, { ...receipt, runId: "" }]) {
      own.mockResolvedValueOnce(bad);
      expect((yield* call(built, "workbench_record_own_handoff_summary", input).pipe(Effect.flip)).message).toContain("outcome unconfirmed");
    }
    knowledge.mockResolvedValueOnce({ ...state, taskSlug: "other" });
    expect((yield* call(built, "workbench_read_node_owner", { taskSlug: "task" }).pipe(Effect.flip)).message).toContain("identity mismatch");
    knowledge.mockResolvedValueOnce({ ...state, pending: { ...pending, taskSlug: "other" } });
    expect((yield* call(built, "workbench_read_node_owner", { taskSlug: "task" }).pipe(Effect.flip)).message).toContain("identity mismatch");
    expect(Object.keys(Tool.getJsonSchema(WorkbenchMailToolkit.tools.workbench_read_node_owner).properties ?? {})).toEqual(["taskSlug"]);
    expect(Object.keys(Tool.getJsonSchema(WorkbenchMailToolkit.tools.workbench_record_own_handoff_summary).properties ?? {}))
      .toEqual(["eventId", "message"]);
    expect(Context.get(WorkbenchMailToolkit.tools.workbench_read_node_owner.annotations, Tool.Readonly)).toBe(true);
    expect(Context.get(WorkbenchMailToolkit.tools.workbench_record_own_handoff_summary.annotations, Tool.Readonly)).toBe(false);
    expect(delivery).not.toHaveBeenCalled();
    expect(readHead).not.toHaveBeenCalled();
  }));
  it.effect("finds a node's delivery IDs with host project identity and follows the original artifact", () => Effect.gen(function* () {
    const entry = { id: "delivery-1", runBindingId: "run-1", submittedBy: "author", submittedAt: "now" };
    const page = { taskSlug: "node", deliveries: [entry], hasMore: true, nextCursor: entry.id };
    const list = vi.spyOn(MailClient, "requestProjectKnowledge").mockResolvedValueOnce(page);
    const detail = vi.spyOn(MailClient, "requestReview").mockResolvedValueOnce({ ...entry, snapshot: { git: { head: { commitSha: "a".repeat(40) } } } });
    const built = yield* build();
    const found = yield* call(built, "workbench_list_node_deliveries", { taskSlug: "node", cursor: "older", project: "forged", scope: "forged" });
    expect(found.at(-1)!.result).toEqual(page);
    expect(list).toHaveBeenLastCalledWith({ ...config, project: "spec-project" },
      { environmentId: invocation.environmentId, nativeProjectId: thread.projectId }, "node-deliveries", { taskSlug: "node", cursor: "older" }, expect.any(AbortSignal));
    const original = yield* call(built, "workbench_read_review_delivery", { deliveryId: entry.id });
    expect(original.at(-1)!.result).toMatchObject({ ...entry, snapshot: { git: { head: { commitSha: "a".repeat(40) } } } });
    expect(detail).toHaveBeenCalledTimes(1);
    list.mockResolvedValueOnce({ taskSlug: "node", deliveries: [] });
    const invalid = yield* call(built, "workbench_list_node_deliveries", { taskSlug: "node" }).pipe(Effect.flip);
    expect(invalid.message).toBe("Invalid node delivery list response");
  }));
  it.effect("completes only the host-bound run without exposing target arguments", () => Effect.gen(function* () {
    const receipt = { runId: "bound-run", completed: "bound-task" };
    const request = vi.spyOn(MailClient, "completeOwnRun").mockResolvedValueOnce(receipt);
    const built = yield* build();
    const forged = yield* call(built, "workbench_complete_own_run", { runId: "forged", taskSlug: "forged", scope: "forged" }).pipe(Effect.exit);
    expect(Exit.isFailure(forged)).toBe(true);
    expect(request).not.toHaveBeenCalled();
    const result = yield* call(built, "workbench_complete_own_run", {});
    expect(result.at(-1)!.result).toEqual(receipt);
    expect(request).toHaveBeenLastCalledWith({ ...config, project: "spec-project" }, invocation, expect.any(AbortSignal));
    expect(Object.keys(Tool.getJsonSchema(WorkbenchMailToolkit.tools.workbench_complete_own_run).properties ?? {})).toEqual([]);
    request.mockResolvedValueOnce({ completed: "bound-task" });
    const invalid = yield* call(built, "workbench_complete_own_run", {}).pipe(Effect.flip);
    expect(invalid.message).toBe("Invalid completion receipt; outcome unconfirmed");
    expect(request).toHaveBeenCalledTimes(2);
  }));
  it.effect("records tests with host scope, preserves unknown exit code and reads paged reports", () => Effect.gen(function* () {
    const input = { deliveryId: "delivery", commitSha: "a".repeat(40),
      planSources: [{ kind: "specgraph", specSlug: "test-plan", field: "specify_output", changeId: "cl-plan" }],
      status: "passed", command: "go test ./feature", exitCode: null, summary: "Planned suite passed", outputRefs: ["test conversation output"] };
    const report = { ...input, id: "evidence", testRunId: "bound-run", reporter: "bound-run", createdAt: "now" };
    const history = { deliveryId: "delivery", reports: [report], hasMore: true, nextCursor: "20" };
    const request = vi.spyOn(MailClient, "requestTests").mockResolvedValueOnce(report).mockResolvedValueOnce(history);
    const local = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-secret", projects: {} };
    const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(snapshots()))));
    const recorded = yield* call(built, "workbench_record_test_result", { ...input, testRunId: "forged", actor: "forged", project: "forged" });
    expect(recorded.at(-1)!.result).toEqual(report);
    expect(request).toHaveBeenLastCalledWith({ ...local, project: undefined }, { ...invocation, nativeProjectId: thread.projectId },
      "test-result-submit", input, expect.any(AbortSignal));
    const results = yield* call(built, "workbench_read_test_results", { deliveryId: "delivery", cursor: "40", project: "forged" });
    expect(results.at(-1)!.result).toEqual(history);
    expect(request).toHaveBeenLastCalledWith({ ...local, project: undefined }, { ...invocation, nativeProjectId: thread.projectId },
      "test-results", { deliveryId: "delivery", cursor: "40" }, expect.any(AbortSignal));
    expect(Object.keys(Tool.getJsonSchema(WorkbenchMailToolkit.tools.workbench_record_test_result).properties ?? {}))
      .toEqual(["deliveryId", "commitSha", "planSources", "status", "command", "exitCode", "summary", "outputRefs"]);
    const crashedInput = { ...input, status: "environment_blocked", exitCode: 3221225477, summary: "Windows process access violation" };
    const crashedReport = { ...report, ...crashedInput, id: "crash-report" };
    request.mockResolvedValueOnce(crashedReport);
    const crashed = yield* call(built, "workbench_record_test_result", crashedInput);
    expect(crashed.at(-1)!.result).toEqual(crashedReport);
    request.mockResolvedValueOnce({ recorded: true });
    const invalid = yield* call(built, "workbench_record_test_result", input).pipe(Effect.flip);
    expect(invalid.message).toBe("Invalid test report receipt; outcome unconfirmed");
    expect(request).toHaveBeenCalledTimes(4);
  }));
  it.effect("uses host scope for front review and preserves exact sources without implying code completion", () => Effect.gen(function* () {
    const state = { kind: "requirements", request: null, agentRejections: 0, maxReviewRounds: 3, humanHold: false, responsibleUserId: null };
    const status = { taskSlug: "task", reviews: [state, { ...state, kind: "design" }] };
    const input = { taskSlug: "task", kind: "requirements", sources: [{ kind: "specgraph", specSlug: "task", field: "intent", changeId: "cl-source" }],
      authorResponsibility: { kind: "agent", runId: "author" }, requirementDecisionIds: [], reviewerRunId: "reviewer", completionRunId: "author" };
    const assignedRequest = { ...input, id: "request", responsibleUserId: "human", maxReviewRounds: 3,
      createdBy: "manager", createdAt: "now", decidedAt: null, decisions: [] };
    const assigned = { ...status, reviews: [{ ...state, responsibleUserId: "human", request: assignedRequest }, status.reviews[1]] };
    const delivery = { id: "delivery", runBindingId: "run", submittedBy: "author", submittedAt: "now",
      snapshot: { git: { base: "original-base", head: "original-head" }, summary: "Original submitted artifact", evidence: ["Recorded verification command"] } };
    const request = vi.spyOn(MailClient, "requestReview").mockResolvedValueOnce(status).mockResolvedValueOnce(delivery).mockResolvedValueOnce(assigned);
    const mailbox = vi.spyOn(MailClient, "requestMail");
    const local = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-secret", projects: {} };
    const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(snapshots()))));
    const read = yield* call(built, "workbench_read_review", { taskSlug: " task ", project: "forged", actor: "forged" });
    expect(read.at(-1)!.result).toEqual(status);
    expect(request).toHaveBeenLastCalledWith({ ...local, project: undefined }, { ...invocation, nativeProjectId: thread.projectId },
      "review-status", { taskSlug: "task" }, expect.any(AbortSignal));
    const source = yield* call(built, "workbench_read_review_delivery", { deliveryId: " delivery ", project: "forged", scope: { thread_id: "forged" } });
    expect(source.at(-1)!.result).toEqual(delivery);
    expect(request).toHaveBeenLastCalledWith({ ...local, project: undefined }, { ...invocation, nativeProjectId: thread.projectId },
      "review-delivery-source", { deliveryId: "delivery" }, expect.any(AbortSignal));
    const assignment = yield* call(built, "workbench_assign_review", { ...input,
      maxReviewRounds: 999, scope: { thread_id: "forged" }, actor: "forged", project: "forged" });
    expect(assignment.at(-1)!.result).toEqual(assigned);
    expect(request).toHaveBeenLastCalledWith({ ...local, project: undefined }, { ...invocation, nativeProjectId: thread.projectId },
      "review-assign", input, expect.any(AbortSignal));
    request.mockResolvedValueOnce(assignedRequest);
    const historical = yield* call(built, "workbench_read_review_request", { requestId: "request", project: "forged" });
    expect(historical.at(-1)!.result).toEqual(assignedRequest);
    expect(request).toHaveBeenLastCalledWith({ ...local, project: undefined }, { ...invocation, nativeProjectId: thread.projectId },
      "review-request-source", { requestId: "request" }, expect.any(AbortSignal));
    request.mockResolvedValueOnce(assignedRequest);
    const byDecision = yield* call(built, "workbench_read_review_request", { decisionId: "decision", project: "forged" });
    expect(byDecision.at(-1)!.result).toEqual(assignedRequest);
    expect(request).toHaveBeenLastCalledWith({ ...local, project: undefined }, { ...invocation, nativeProjectId: thread.projectId },
      "review-request-source", { decisionId: "decision" }, expect.any(AbortSignal));
    for (const verdict of ["accepted", "rejected"] as const) {
      const decision = { id: "decision", requestId: "request", verdict, basis: "Evidence from original sources",
        actorKind: "agent", actor: "service-account", reviewerRunId: "reviewer", createdAt: "later" };
      const receipt = { recorded: true, decision,
        ...(verdict === "accepted" ? { authoringCompletion: { runId: "author", taskSlug: "task", status: "failed", message: "Approval saved; current writing output changed" } } : {}),
        status: { ...status, reviews: [
        { ...state, responsibleUserId: "human", request: { ...assignedRequest, decidedAt: "later", decisions: [decision] } }, status.reviews[1],
      ] } };
      request.mockResolvedValueOnce(receipt);
      const result = yield* call(built, "workbench_submit_review", { requestId: "request", verdict, basis: " Evidence from original sources ",
        scope: { thread_id: "forged" }, actor: "forged", project: "forged" });
      expect(result.at(-1)!.result).toEqual(receipt);
      expect(request).toHaveBeenLastCalledWith({ ...local, project: undefined }, { ...invocation, nativeProjectId: thread.projectId },
        "review-submit", { requestId: "request", verdict, basis: "Evidence from original sources" }, expect.any(AbortSignal));
    }
    expect(mailbox).not.toHaveBeenCalled();
    for (const [name, fields] of [
      ["workbench_read_review", ["taskSlug"]],
      ["workbench_read_review_request", ["requestId", "decisionId"]],
      ["workbench_read_review_delivery", ["deliveryId"]],
      ["workbench_assign_review", ["taskSlug", "kind", "sources", "authorResponsibility", "requirementDecisionIds", "reviewerRunId", "completionRunId"]],
      ["workbench_submit_review", ["requestId", "verdict", "basis"]],
    ] as const) expect(Object.keys(Tool.getJsonSchema(WorkbenchMailToolkit.tools[name]).properties ?? {})).toEqual(fields);
  }));

  it.effect("rejects inactive review callers, malformed receipts and invalid input without retrying writes", () => Effect.gen(function* () {
    const request = vi.spyOn(MailClient, "requestReview").mockResolvedValue({});
    const local = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-secret", projects: { "native-project": "mapped-project" } };
    const assignment = { taskSlug: "task", kind: "design", sources: [{ kind: "git", environmentId: "native-environment", repositoryRoot: "C:/repo",
      commitSha: "a".repeat(40), path: "design.md" }], authorResponsibility: { kind: "human", userId: "human" }, requirementDecisionIds: ["approved-requirements"], reviewerRunId: "reviewer" };
    for (const value of [null, { ...thread, archivedAt: "now" }]) {
      const unavailable = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(snapshots(value)))));
      yield* call(unavailable, "workbench_read_review", { taskSlug: "task" }).pipe(Effect.flip);
      yield* call(unavailable, "workbench_assign_review", assignment).pipe(Effect.flip);
      yield* call(unavailable, "workbench_submit_review", { requestId: "request", verdict: "rejected", basis: "Evidence" }).pipe(Effect.flip);
    }
    const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(snapshots()))));
    for (const basis of [" ", "x".repeat(4001)]) yield* call(built, "workbench_submit_review", { requestId: "request", verdict: "accepted", basis }).pipe(Effect.flip);
    yield* call(built, "workbench_submit_review", { requestId: "request", verdict: "testsPassed", basis: "Evidence" }).pipe(Effect.flip);
    expect(request).not.toHaveBeenCalled();
    const malformed = yield* call(built, "workbench_submit_review", { requestId: "request", verdict: "rejected", basis: "Evidence" }).pipe(Effect.flip);
    expect(malformed.message).toBe("Invalid review receipt; outcome unconfirmed");
    expect(request).toHaveBeenLastCalledWith({ ...local, project: "mapped-project" }, { ...invocation, nativeProjectId: thread.projectId },
      "review-submit", { requestId: "request", verdict: "rejected", basis: "Evidence" }, expect.any(AbortSignal));
    request.mockRejectedValueOnce(new Error("Project review request failed or was cancelled; outcome unconfirmed"));
    const failed = yield* call(built, "workbench_assign_review", assignment).pipe(Effect.flip);
    expect(failed.message).toContain("outcome unconfirmed");
    expect(request).toHaveBeenCalledTimes(2);
  }));

  it.effect("reads project records for an ordinary native thread without mailbox identity or role", () => Effect.gen(function* () {
    const search = { query: "source", scope: "specgraph-records", hasMore: false,
      items: [{ kind: "spec", id: "spec-id", slug: "source-node", title: "Source", status: "approved", version: 2, excerpt: "Original excerpt", updatedAt: "2026-09-24T00:00:00Z" }] };
    const request = vi.spyOn(MailClient, "requestProjectKnowledge").mockResolvedValue(search);
    const mailbox = vi.spyOn(MailClient, "requestMail");
    const local = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-secret", projects: {} };
    const lookup = vi.fn(() => Effect.succeed(Option.some(thread)));
    const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({ getThreadShellById: lookup }),
    ))));
    const results = yield* call(built, "workbench_search_project_knowledge", { query: " source ",
      project: "forged", native_project_id: "forged", environment_id: "forged", scope: { thread_id: "forged" } });
    expect(results.at(-1)!.result).toEqual(search);
    expect(request).toHaveBeenLastCalledWith({ ...local, project: undefined },
      { environmentId: invocation.environmentId, nativeProjectId: thread.projectId }, "knowledge-search", { query: "source" }, expect.any(AbortSignal));
    for (const kind of ["spec", "decision", "change"] as const) {
      const record = { kind, id: "source-id", slug: "source-node", version: 2, specgraphProject: "actual-spec-project",
        ...(kind === "spec" ? { sourceRefs: { intent: "cl-intent", specify_output: "cl-design" } } : {}),
        record: { body: "Original source text", references: ["original-reference"] } };
      request.mockResolvedValueOnce(record);
      const before = lookup.mock.calls.length;
      const payload = { kind, reference: kind === "change" ? "source-id" : "source-node",
        ...(kind === "spec" ? { expectedProject: "actual-spec-project" } : {}) };
      const result = yield* call(built, "workbench_read_project_record", { ...payload, project: "forged",
        nativeProjectId: "forged", environmentId: "forged" });
      expect(result.at(-1)!.result).toEqual({ ...record, nativeProjectId: thread.projectId,
        environmentId: invocation.environmentId });
      expect(lookup.mock.calls.length - before).toBe(1);
      expect(request).toHaveBeenLastCalledWith({ ...local, project: undefined },
        { environmentId: invocation.environmentId, nativeProjectId: thread.projectId }, "knowledge-record",
        payload, expect.any(AbortSignal));
    }
    const mapped = { ...local, projects: { "native-project": "configured-project" } };
    const mappedToolkit = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(mapped).pipe(Layer.provide(snapshots()))));
    yield* call(mappedToolkit, "workbench_search_project_knowledge", { query: "source" });
    expect(request).toHaveBeenLastCalledWith({ ...mapped, project: "configured-project" },
      { environmentId: invocation.environmentId, nativeProjectId: thread.projectId }, "knowledge-search", { query: "source" }, expect.any(AbortSignal));
    expect(mailbox).not.toHaveBeenCalled();
    expect(Object.keys(Tool.getJsonSchema(WorkbenchMailToolkit.tools.workbench_search_project_knowledge).properties ?? {})).toEqual(["query"]);
    expect(Object.keys(Tool.getJsonSchema(WorkbenchMailToolkit.tools.workbench_read_project_record).properties ?? {})).toEqual(["kind", "reference", "expectedProject"]);
  }));

  it.effect("lists every run bound to a same-project historical thread without accepting model identity", () => Effect.gen(function* () {
    const targetId = ThreadId.make("history-thread");
    let target: OrchestrationThreadShell | null = { ...thread, archivedAt: "2026-09-01T00:00:00Z" };
    const local = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-secret", projects: {} };
    const lookup = vi.fn((id: ThreadId) => Effect.succeed(Option.fromNullishOr(id === invocation.threadId ? thread : id === targetId ? target : null)));
    const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({ getThreadShellById: lookup }),
    ))));
    const runs = [
      { runId: "run-a", taskSlug: "first", state: "completed", createdAt: "2026-09-01T00:00:00Z", dispatchMessageId: "message-a" },
      { runId: "run-b", taskSlug: "second", state: "dispatched", createdAt: "2026-09-02T00:00:00Z", dispatchMessageId: null },
    ];
    const request = vi.spyOn(MailClient, "requestProjectKnowledge").mockResolvedValue({ threadId: targetId, runs, hasMore: true, nextCursor: "run-b" });
    const response = (yield* call(built, "workbench_list_conversation_runs", { threadId: targetId, cursor: " run-a ",
      environment_id: "forged", native_project_id: "forged", project: "forged", cwd: "C:/foreign" })).at(-1)!.result;
    expect(response).toEqual({ threadId: targetId, runs, hasMore: true, nextCursor: "run-b" });
    expect(request).toHaveBeenCalledExactlyOnceWith({ ...local, project: undefined },
      { environmentId: invocation.environmentId, nativeProjectId: thread.projectId }, "conversation-runs",
      { threadId: targetId, cursor: "run-a" }, expect.any(AbortSignal));
    expect(lookup.mock.calls.map(([id]) => id)).toEqual([invocation.threadId, targetId]);
    expect(Object.keys(Tool.getJsonSchema(WorkbenchMailToolkit.tools.workbench_list_conversation_runs).properties ?? {})).toEqual(["threadId", "cursor"]);

    for (const cursor of ["", "   "]) yield* call(built, "workbench_list_conversation_runs", { threadId: targetId, cursor }).pipe(Effect.flip);
    expect(request).toHaveBeenCalledTimes(1);
    target = null;
    yield* call(built, "workbench_list_conversation_runs", { threadId: targetId }).pipe(Effect.flip);
    target = { ...thread, projectId: ProjectId.make("foreign-project") };
    yield* call(built, "workbench_list_conversation_runs", { threadId: targetId }).pipe(Effect.flip);
    expect(request).toHaveBeenCalledTimes(1);

    target = { ...thread, archivedAt: null };
    request.mockResolvedValueOnce({ threadId: "wrong-thread", runs: [], hasMore: false, nextCursor: null });
    const mismatch = yield* call(built, "workbench_list_conversation_runs", { threadId: targetId }).pipe(Effect.flip);
    expect(mismatch.message).toContain("identity mismatch");
  }));

  it.effect("rejects inactive native threads, invalid queries and malformed knowledge responses", () => Effect.gen(function* () {
    const request = vi.spyOn(MailClient, "requestProjectKnowledge").mockResolvedValue({});
    const local = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-secret", projects: {} };
    for (const value of [null, { ...thread, archivedAt: "now" }]) {
      const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(snapshots(value)))));
      const failure = yield* call(built, "workbench_search_project_knowledge", { query: "source" }).pipe(Effect.flip);
      expect(failure.message).toBe("Mailbox requires an active thread");
    }
    const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(snapshots()))));
    for (const query of ["", "   ", "x".repeat(257)]) {
      yield* call(built, "workbench_search_project_knowledge", { query }).pipe(Effect.flip);
    }
    yield* call(built, "workbench_read_project_record", { kind: "unknown", reference: "source" }).pipe(Effect.flip);
    yield* call(built, "workbench_read_project_record", { kind: "spec", reference: "   " }).pipe(Effect.flip);
    expect(request).not.toHaveBeenCalled();
    const failure = yield* call(built, "workbench_search_project_knowledge", { query: "source" }).pipe(Effect.flip);
    expect(failure.message).toBe("Invalid project knowledge search response");
    request.mockResolvedValueOnce({ kind: "spec", id: "id", slug: "slug", version: 1, record: {} });
    const recordFailure = yield* call(built, "workbench_read_project_record", { kind: "spec", reference: "slug" }).pipe(Effect.flip);
    expect(recordFailure.message).toBe("Invalid project knowledge record response");
  }));

  it.effect("discovers role contacts using host identity rather than model supplied project or scope", () => Effect.gen(function* () {
    const response = { contacts: [{ run_id: "knowledge-run", task_slug: "knowledge-work", assignment_role: "knowledge" }], next_cursor: "knowledge-run" };
    const request = vi.spyOn(MailClient, "requestMail").mockResolvedValue(response);
    const local = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-secret", projects: {} };
    const built = yield* WorkbenchMailToolkit.pipe(Effect.provide(mailHandlers(local).pipe(Layer.provide(snapshots()))));
    const results = yield* call(built, "workbench_mail_directory", { limit: 1, assignment_role: "knowledge", project: "forged", scope: { thread_id: "forged" } });
    expect(results.at(-1)!.result).toEqual(response);
    expect(request).toHaveBeenCalledWith({ ...local, project: undefined }, invocation, "directory", { limit: 1, assignment_role: "knowledge" }, expect.any(AbortSignal));
  }));
  it.effect("uses authenticated scope and mapped project, never model identity", () => Effect.gen(function* () {
    const fetch = vi.fn().mockResolvedValue(Response.json({ thread: { id: "mail-thread" }, message: { id: "message", references: [{
      message_id: "source-message", kind: "reply", thread_id: "source-thread", task_slug: "source-task",
      sender_run_id: "source-run", subject: "Original", body: "Actual source", created_at: "2026-09-20T00:00:00Z",
    }] } }));
    vi.stubGlobal("fetch", fetch);
    const built = yield* build();
    yield* call(built, "workbench_mail_send", {
      subject: "question", body: "body", recipient_run_ids: ["other-run"], idempotency_key: "intent-1",
      references: [{ message_id: "source-message", kind: "reply", body: "forged quotation", sender_run_id: "attacker" }],
      scope: { thread_id: "attacker" }, sender: "attacker", project: "attacker", task: "attacker",
      endpoint: "http://example.com", token: "attacker",
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, request] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:8690/loop/mail/send");
    expect(request.headers["X-Specgraph-Project"]).toBe("spec-project");
    expect(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(request.body)).toEqual({ subject: "question", body: "body", recipient_run_ids: ["other-run"], idempotency_key: "intent-1", references: [{ message_id: "source-message", kind: "reply" }], scope: {
      environment_id: invocation.environmentId, thread_id: invocation.threadId,
      provider_session_id: invocation.providerSessionId, provider_instance_id: invocation.providerInstanceId,
    } });
    for (const tool of Object.values(WorkbenchMailToolkit.tools)) {
      const schema = Tool.getJsonSchema(tool);
      for (const forbidden of ["scope", "sender", "task", "project", "endpoint", "token"]) {
        expect(Object.keys(schema.properties ?? {})).not.toContain(forbidden);
      }
      expect(Context.get(tool.annotations, Tool.Idempotent)).toBe(!["workbench_record_own_node_event", "workbench_stop_program_loop", "workbench_set_node_mark", "workbench_retry_delivery_hook", "workbench_create_node", "workbench_subdivide_node", "workbench_approve_execution", "workbench_add_dependency", "workbench_remove_dependency", "workbench_submit_own_delivery", "workbench_complete_own_run", "workbench_record_test_result", "workbench_assign_review", "workbench_submit_review"].includes(tool.name));
      expect(Context.get(tool.annotations, Tool.Readonly)).toBe(["workbench_read_node_owner", "workbench_read_candidate_satisfaction_history", "workbench_read_node_events", "workbench_read_report_judgment_history", "workbench_read_candidate_loop", "workbench_read_report_join", "workbench_read_report_flow", "workbench_read_program_loop", "workbench_read_program_loop_history", "workbench_read_node_mark_history", "workbench_read_summary", "workbench_read_summary_history", "workbench_read_delivery_hook_context", "workbench_read_delivery_hook", "workbench_list_delivery_hooks", "workbench_list_dispatch_models", "workbench_read_current_graph", "workbench_preview_node_merge", "workbench_read_node_merge_history", "workbench_read_node_merge_receipt", "workbench_read_dependency_state", "workbench_list_node_deliveries", "workbench_list_conversation_runs", "workbench_read_test_results", "workbench_read_review", "workbench_read_review_request", "workbench_read_review_delivery", "workbench_search_project_knowledge", "workbench_search_knowledge", "workbench_read_project_record", "workbench_mail_context", "workbench_mail_directory", "workbench_mail_owned_threads", "workbench_mail_retired_threads", "workbench_mail_owner_history", "workbench_mail_inbox", "workbench_mail_thread"].includes(tool.name));
      expect(Context.get(tool.annotations, Tool.OpenWorld)).toBe(tool.name === "workbench_dispatch_prepared_run");
    }
  }));

  it.effect("returns only trusted enrollment metadata without fetching or authorizing", () => Effect.gen(function* () {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const built = yield* build();
    const results = yield* call(built, "workbench_mail_context", {});
    expect(results.at(-1)!.result).toEqual({
      scope: { environment_id: invocation.environmentId, thread_id: invocation.threadId,
        provider_session_id: invocation.providerSessionId, provider_instance_id: invocation.providerInstanceId },
      native_project_id: "native-project", project: "spec-project",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(Object.keys(Tool.getJsonSchema(WorkbenchMailToolkit.tools.workbench_mail_context).properties ?? {})).toEqual([]);
    for (const value of [null, { ...thread, archivedAt: "now" }, { ...thread, projectId: ProjectId.make("unmapped") }]) {
      const unavailable = yield* build(value);
      const failure = yield* call(unavailable, "workbench_mail_context", {}).pipe(Effect.flip);
      expect(failure.message).toMatch(/Mailbox/);
    }
    expect(fetch).not.toHaveBeenCalled();
  }));

  it.effect("runs all six operations and keeps read and acknowledgment distinct", () => Effect.gen(function* () {
    const fetch = vi.fn(async (url: URL) => Response.json(url.pathname.endsWith("/send")
      ? { thread: { id: "t" }, message: { id: "m" } }
      : url.pathname.endsWith("/close") ? { id: "t", closed_at: "now" }
      : url.pathname.endsWith("/read") ? { read_at: "now", acknowledged_at: null }
      : url.pathname.endsWith("/ack") ? { read_at: null, acknowledged_at: "now" }
      : { thread: { id: "t" }, items: [], next_cursor: "" }));
    vi.stubGlobal("fetch", fetch);
    const built = yield* build();
    const inputs = {
      workbench_mail_send: { subject: "q", body: "b", recipient_run_ids: ["r"], idempotency_key: "k" },
      workbench_mail_inbox: { limit: 10 }, workbench_mail_thread: { mail_thread_id: "t", limit: 10 },
      workbench_mail_read: { message_id: "m" }, workbench_mail_ack: { message_id: "m" },
      workbench_mail_close: { mail_thread_id: "t", resolution: "done" },
    };
    for (const name of Object.keys(inputs) as Array<keyof typeof inputs>) yield* call(built, name, inputs[name]);
    expect(fetch.mock.calls.map(([url]) => url.pathname)).toEqual(["send", "inbox", "thread", "read", "ack", "close"].map((op) => `/loop/mail/${op}`));
  }));

  it.effect("missing/deleted, archived or unmapped threads never fetch", () => Effect.gen(function* () {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    for (const value of [null, { ...thread, archivedAt: "now" }, { ...thread, projectId: ProjectId.make("unmapped") }]) {
      const built = yield* build(value);
      const failure = yield* call(built, "workbench_mail_inbox", { limit: 10 }).pipe(Effect.flip);
      expect(failure.message).toMatch(/Mailbox/);
    }
    expect(fetch).not.toHaveBeenCalled();
  }));

  it.effect("preserves rejection status without exposing response or credentials", () => Effect.gen(function* () {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret-response", { status: 403 })));
    const built = yield* build();
    const failure = yield* call(built, "workbench_mail_ack", { message_id: "m" }).pipe(Effect.flip);
    expect(failure.message).toBe("Mailbox ack rejected (HTTP 403)");
  }));

  it.effect("cancellation reaches fetch and does not retry", () => Effect.gen(function* () {
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { started = resolve; });
    let signal!: AbortSignal;
    const fetch = vi.fn((_url, request) => new Promise((_resolve, reject) => {
      signal = request.signal;
      signal.addEventListener("abort", () => reject(new Error("fixture-only-secret")), { once: true });
      started();
    }));
    vi.stubGlobal("fetch", fetch);
    const built = yield* build();
    const fiber = yield* call(built, "workbench_mail_inbox", { limit: 10 }).pipe(Effect.forkChild);
    yield* Effect.promise(() => pending);
    yield* Fiber.interrupt(fiber);
    expect(signal.aborted).toBe(true); expect(fetch).toHaveBeenCalledOnce();
  }));

  it.effect("omits registration when unconfigured and fails startup when configured incorrectly", () => Effect.gen(function* () {
    vi.stubEnv("T3_WORKBENCH_MAIL_CONFIG", undefined);
    const deps = Layer.mergeAll(snapshots(), McpServer.McpServer.layer, gitLayer, providerLayer, dispatchLayer, workspaceLayer);
    yield* Layer.build(WorkbenchMailRegistrationLive.pipe(Layer.provide(deps))).pipe(Effect.scoped);
    vi.stubEnv("T3_WORKBENCH_MAIL_CONFIG", "not-an-absolute-config-path");
    const result = yield* Layer.build(WorkbenchMailRegistrationLive.pipe(Layer.provide(deps))).pipe(Effect.scoped, Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("Invalid T3_WORKBENCH_MAIL_CONFIG");
  }));

  it.effect("registers all tools and preserves invocation through the native MCP call path", () => Effect.gen(function* () {
    const fetch = vi.fn(async (_url: URL, _request: RequestInit) => Response.json({ items: [], next_cursor: "" }));
    vi.stubGlobal("fetch", fetch);
    const server = yield* McpServer.McpServer;
    yield* McpServer.registerToolkit(WorkbenchMailToolkit);
    expect(server.tools.map(({ tool }) => tool.name)).toEqual(Object.keys(WorkbenchMailToolkit.tools));
    const client = McpSchema.McpServerClient.of({
      clientId: 1, clientCapabilities: {}, clientInfo: { name: "mail-test", version: "1" },
      protocolVersion: "2025-06-18",
      initializePayload: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mail-test", version: "1" } },
      getClient: Effect.die("unused"),
    });
    providerSnapshots.mockReturnValue([]);
    const discovered = yield* server.callTool({ name: "workbench_list_dispatch_models", arguments: {} }).pipe(
      Effect.provideService(McpInvocationContext, invocation), Effect.provideService(McpSchema.McpServerClient, client),
    );
    expect(discovered.isError).toBe(false);
    expect(discovered.content).toEqual([{ type: "text", text: "[]" }]);
    expect(providerSnapshots).toHaveBeenCalledOnce();
    for (const providerSessionId of ["session-one", "session-two"]) {
      const result = yield* server.callTool({ name: "workbench_mail_inbox", arguments: { limit: 10 } }).pipe(
        Effect.provideService(McpInvocationContext, { ...invocation, providerSessionId }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
      expect(result.isError).toBe(false);
      expect(fetch.mock.lastCall![1].body).toContain(providerSessionId);
      expect(result.content).toEqual([{ type: "text", text: '{"items":[],"next_cursor":""}' }]);
    }
    const context = { runId: "native-run", taskSlug: "native-task", workspace: "C:/original-worktree" };
    const receipt = { deliveryId: "native-delivery", runId: context.runId, taskSlug: context.taskSlug };
    const request = vi.spyOn(MailClient, "requestOwnDelivery").mockResolvedValueOnce(context).mockResolvedValueOnce(receipt);
    readHead.mockReturnValueOnce(Effect.succeed({ isRepo: true, commitSha: "c".repeat(40) }));
    const recorded = yield* server.callTool({ name: "workbench_submit_own_delivery", arguments: { summary: "Native handoff" } }).pipe(
      Effect.provideService(McpInvocationContext, invocation), Effect.provideService(McpSchema.McpServerClient, client),
    );
    expect(recorded.isError).toBe(false);
    expect(readHead).toHaveBeenLastCalledWith({ cwd: context.workspace });
    expect(request).toHaveBeenLastCalledWith({ ...config, project: "spec-project" }, invocation, "delivery-submit-self",
      { expectedRunId: context.runId, summary: "Native handoff", head: { isRepo: true, commitSha: "c".repeat(40) } }, expect.any(AbortSignal));
    const mark = { id: "41", taskSlug: "native-task", kind: "risk", value: "watch", reason: "Original clear basis", actor: "pm:actual", createdAt: "now" };
    const markInput = { taskSlug: mark.taskSlug, kind: mark.kind, value: mark.value, reason: mark.reason, expectedMarkId: "" };
    const markRequest = vi.spyOn(MailClient, "requestManagerPlan").mockResolvedValueOnce(mark);
    const marked = yield* server.callTool({ name: "workbench_set_node_mark", arguments: { ...markInput, project: "foreign", actor: "forged" } }).pipe(
      Effect.provideService(McpInvocationContext, invocation), Effect.provideService(McpSchema.McpServerClient, client),
    );
    expect(marked.isError).toBe(false);
    expect(marked.content).toEqual([{ type: "text", text: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(mark) }]);
    expect(markRequest).toHaveBeenCalledExactlyOnceWith({ ...config, project: "spec-project" }, invocation, "pm-set-node-mark", markInput, expect.any(AbortSignal));
    const history = { items: [mark], hasMore: true, nextCursor: "41" };
    const markHistory = vi.spyOn(MailClient, "requestProjectKnowledge").mockResolvedValueOnce(history)
      .mockResolvedValueOnce({ items: [], hasMore: false, nextCursor: "" });
    for (const cursor of [undefined, history.nextCursor]) {
      const input = { taskSlug: mark.taskSlug, ...(cursor === undefined ? {} : { cursor }) };
      const read = yield* server.callTool({ name: "workbench_read_node_mark_history", arguments: { ...input, scope: "forged" } }).pipe(
        Effect.provideService(McpInvocationContext, invocation), Effect.provideService(McpSchema.McpServerClient, client),
      );
      expect(read.isError).toBe(false);
      expect(read.content).toEqual([{ type: "text", text: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        cursor === undefined ? history : { items: [], hasMore: false, nextCursor: "" },
      ) }]);
      expect(markHistory).toHaveBeenLastCalledWith({ ...config, project: "spec-project" },
        { environmentId: invocation.environmentId, nativeProjectId: thread.projectId }, "node-mark-history", input, expect.any(AbortSignal));
    }
    expect(markHistory).toHaveBeenCalledTimes(2);
    const loopEvent = { id: "loop-event", runId: "native-program", attemptId: "exact-attempt", kind: "condition", value: "false",
      actorUserId: "actual-user", actorRunId: "actual-pm", reason: "Read exact original output", recordedAt: "now" };
    const loopInput = { runId: loopEvent.runId, attemptId: loopEvent.attemptId, value: loopEvent.value, basis: loopEvent.reason,
      expectedJudgmentId: null };
    markRequest.mockResolvedValueOnce(loopEvent);
    const loopDecision = yield* server.callTool({ name: "workbench_record_program_loop_decision", arguments: {
      ...loopInput, project: "foreign", actorRunId: "forged", command: "forged", maxAttempts: 100,
    } }).pipe(Effect.provideService(McpInvocationContext, invocation), Effect.provideService(McpSchema.McpServerClient, client));
    expect(loopDecision.isError).toBe(false);
    expect(loopDecision.content).toEqual([{ type: "text", text: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(loopEvent) }]);
    expect(markRequest).toHaveBeenLastCalledWith({ ...config, project: "spec-project" }, invocation, "pm-record-program-loop-decision", loopInput, expect.any(AbortSignal));
    const loopStop = { runId: loopEvent.runId, reason: "Correction stops future attempts only" };
    const stopEvent = { id: "stop-event", runId: loopEvent.runId, kind: "stop", reason: loopStop.reason,
      actorUserId: "actual-user", actorRunId: "actual-pm", recordedAt: "now" };
    markRequest.mockResolvedValueOnce(stopEvent);
    const stopped = yield* server.callTool({ name: "workbench_stop_program_loop", arguments: loopStop }).pipe(
      Effect.provideService(McpInvocationContext, invocation), Effect.provideService(McpSchema.McpServerClient, client),
    );
    expect(stopped.isError).toBe(false);
    expect(markRequest).toHaveBeenLastCalledWith({ ...config, project: "spec-project" }, invocation, "pm-stop-program-loop", loopStop, expect.any(AbortSignal));
    const loopRun = { context: { runId: loopEvent.runId, taskSlug: "task", packageId: "original-package", body: {}, createdAt: "then" },
      executorKind: "program", state: "dispatched", dispatch: { admission: {}, resolution: null, cancellation: null, stopConfirmation: null },
      result: null, currentAttempt: { id: loopEvent.attemptId, ordinal: 1, grantedAt: "now" }, loopState: { status: "waiting" }, replayed: false };
    markHistory.mockResolvedValueOnce(loopRun);
    const loopRead = yield* server.callTool({ name: "workbench_read_program_loop", arguments: { runId: loopEvent.runId, environment_id: "forged" } }).pipe(
      Effect.provideService(McpInvocationContext, invocation), Effect.provideService(McpSchema.McpServerClient, client),
    );
    expect(loopRead.isError).toBe(false);
    expect(markHistory).toHaveBeenLastCalledWith({ ...config, project: "spec-project" },
      { environmentId: invocation.environmentId, nativeProjectId: thread.projectId }, "program-loop-read", { runId: loopEvent.runId }, expect.any(AbortSignal));
    const loopHistory = { attempts: [loopRun.currentAttempt], events: [loopEvent], nextAttemptCursor: "a-before", nextEventCursor: "e-before" };
    markHistory.mockResolvedValueOnce(loopHistory);
    const readInput = { runId: loopEvent.runId, attemptCursor: "a-before", eventCursor: "e-before" };
    const loopHistoryRead = yield* server.callTool({ name: "workbench_read_program_loop_history", arguments: readInput }).pipe(
      Effect.provideService(McpInvocationContext, invocation), Effect.provideService(McpSchema.McpServerClient, client),
    );
    expect(loopHistoryRead.isError).toBe(false);
    expect(loopHistoryRead.content).toEqual([{ type: "text", text: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(loopHistory) }]);
    expect(markHistory).toHaveBeenLastCalledWith({ ...config, project: "spec-project" },
      { environmentId: invocation.environmentId, nativeProjectId: thread.projectId }, "program-loop-history", readInput, expect.any(AbortSignal));
    markRequest.mockResolvedValueOnce({});
    const unknownReceipt = yield* server.callTool({ name: "workbench_record_program_loop_decision", arguments: loopInput }).pipe(
      Effect.provideService(McpInvocationContext, invocation), Effect.provideService(McpSchema.McpServerClient, client),
    );
    expect(unknownReceipt.isError).toBe(true);
    expect(unknownReceipt.content).toEqual([{ type: "text", text: expect.stringContaining("outcome unconfirmed") }]);
  }).pipe(
    Effect.provide(Layer.mergeAll(mailHandlers(config).pipe(Layer.provide(snapshots())), McpServer.McpServer.layer, gitLayer, providerLayer, dispatchLayer, workspaceLayer)),
  ));
});
