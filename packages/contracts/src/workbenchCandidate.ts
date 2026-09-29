import * as Schema from "effect/Schema";

const ref = Schema.NonEmptyString;
const source = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("specgraph"), specSlug: ref, field: ref, changeId: ref }),
  Schema.Struct({ kind: Schema.Literal("git"), environmentId: ref, repositoryRoot: ref, commitSha: ref,
    path: ref, entry: Schema.optional(Schema.String) }),
]);
const value = Schema.Literals(["true", "false", "unknown"]);
const report = Schema.Struct({ id: ref, deliveryId: ref, commitSha: ref, status: Schema.Literals(["passed", "failed", "not_run", "environment_blocked"]),
  planSources: Schema.Array(source), createdAt: Schema.String });
const branchJudgment = Schema.Struct({ id: ref, flowId: ref, conditionKey: ref, value, inputRefs: Schema.Array(source),
  reason: Schema.String, actorUserId: ref, actorRunId: Schema.optional(ref), recordedAt: Schema.String,
  predecessorId: Schema.optional(ref) });
const branchProof = Schema.Struct({ flowId: ref, conditionKey: ref, value,
  report: Schema.optional(report), judgment: Schema.optional(branchJudgment),
}).check(Schema.makeFilter((proof) => (proof.report === undefined) !== (proof.judgment === undefined)));
const completionRef = Schema.Struct({ id: ref, runId: ref, taskSlug: ref });
const joinMember = { runId: ref, packageId: ref, conditionKey: ref, when: Schema.Literals(["true", "false"]),
  admissionId: Schema.optional(ref), basis: Schema.optional(branchProof), completion: Schema.optional(completionRef) };
const joinEvaluation = Schema.Struct({ satisfied: Schema.Boolean, reason: Schema.optional(Schema.String),
  participants: Schema.Array(Schema.Struct({ ...joinMember, state: Schema.Literals(["admitted", "selected"]) })),
  unknown: Schema.Array(Schema.Struct({ ...joinMember, state: Schema.Literal("unknown") })),
  conditions: Schema.Array(Schema.Struct({ key: ref, evaluation: Schema.Struct({ value,
    report: Schema.optional(report), judgment: Schema.optional(branchJudgment), reason: Schema.optional(Schema.String) }) })),
  witness: Schema.optional(completionRef), explicitSkip: Schema.Boolean });
const joinConfig = Schema.Struct({ mode: Schema.Literals(["all", "any"]), allowEmptySkip: Schema.Boolean });
const joinProof = Schema.Struct({ sourceAttemptId: ref, flowId: ref, mode: joinConfig.fields.mode,
  evaluation: joinEvaluation });
const candidateCondition = Schema.Struct({ value, reason: Schema.optional(Schema.String),
  reports: Schema.Array(report), missingPlans: Schema.Array(source) });

export const WorkbenchCandidateSatisfactionJudgment = Schema.Struct({
  id: ref, runId: ref, attemptId: ref, deliveryId: ref, value, reason: Schema.String,
  actorUserId: ref, actorRunId: Schema.optional(ref), recordedAt: Schema.String,
  predecessorId: Schema.optional(ref),
});
export type WorkbenchCandidateSatisfactionJudgment = typeof WorkbenchCandidateSatisfactionJudgment.Type;

export const WorkbenchCandidateIntervention = Schema.Struct({
  id: ref, runId: ref, attemptId: ref, judgmentId: ref, reportIds: Schema.Array(ref),
  conflictKind: ref, reason: Schema.String, recordedAt: Schema.String,
  resolvedAt: Schema.optional(Schema.String), resolvedByUserId: Schema.optional(ref),
  resolutionReason: Schema.optional(Schema.String), resolutionJudgmentId: Schema.optional(ref),
  resolutionReportIds: Schema.optional(Schema.Array(ref)),
});
export type WorkbenchCandidateIntervention = typeof WorkbenchCandidateIntervention.Type;

const satisfactionBasis = Schema.Struct({ value, judgmentId: ref, reportIds: Schema.Array(ref),
  interventionId: Schema.optional(ref) });
const satisfactionState = Schema.Struct({ criterion: ref, value, reason: Schema.optional(Schema.String),
  judgment: Schema.optional(WorkbenchCandidateSatisfactionJudgment),
  intervention: Schema.optional(WorkbenchCandidateIntervention) });
const attempt = Schema.Struct({ id: ref, number: Schema.Int.check(Schema.isGreaterThan(0)), grantedAt: Schema.String,
  predecessorId: Schema.optional(ref), deliveryId: Schema.optional(ref), consumedCondition: Schema.optional(candidateCondition),
  flowId: Schema.optional(ref), consumedJoin: Schema.optional(joinProof), consumedSatisfaction: Schema.optional(satisfactionBasis) });
const event = Schema.Struct({ actorUserId: ref, actorRunId: Schema.optional(ref), reason: Schema.String, recordedAt: Schema.String });

export const WorkbenchCandidateLoopPolicy = Schema.Struct({
  runId: ref, maxAttempts: Schema.Int.check(Schema.isGreaterThan(0)), planSources: Schema.Array(source).check(Schema.isMinLength(1)),
  join: Schema.optional(joinConfig), terminationKind: Schema.Literals(["report", "satisfaction"]),
  satisfactionCriterion: Schema.optional(Schema.Trim.check(Schema.isMinLength(1))),
}).check(Schema.makeFilter((policy) => policy.terminationKind === "satisfaction"
  ? policy.satisfactionCriterion !== undefined : policy.satisfactionCriterion === undefined));
export type WorkbenchCandidateLoopPolicy = typeof WorkbenchCandidateLoopPolicy.Type;

export const WorkbenchCandidateLoop = Schema.Struct({
  runId: ref, taskSlug: ref, packageId: ref, maxAttempts: Schema.Int.check(Schema.isGreaterThan(0)),
  planSources: Schema.Array(source), terminationKind: Schema.Literals(["report", "satisfaction"]),
  satisfaction: Schema.optional(satisfactionState),
  join: Schema.optional(Schema.Struct({ ...joinConfig.fields, flowId: Schema.optional(ref),
    evaluation: Schema.optional(joinEvaluation), reason: Schema.optional(Schema.String) })),
  configuredBy: ref, configuredAt: Schema.String, attempts: Schema.Array(attempt),
  currentAttempt: Schema.optional(attempt), grantedAttempt: Schema.optional(attempt),
  condition: Schema.optional(candidateCondition),
  status: Schema.Literals(["waiting", "candidate", "ready_next", "condition_met", "needs_human", "stopped", "abandoned", "completed"]),
  stop: Schema.optional(event), abandon: Schema.optional(event), completedAt: Schema.optional(Schema.String),
  completedJoin: Schema.optional(joinProof), completedCondition: Schema.optional(candidateCondition),
  completedSatisfaction: Schema.optional(satisfactionBasis), replayed: Schema.optional(Schema.Boolean),
});
export type WorkbenchCandidateLoop = typeof WorkbenchCandidateLoop.Type;

export const WorkbenchCandidateSatisfactionJudgmentResult = Schema.Struct({
  judgment: WorkbenchCandidateSatisfactionJudgment, replayed: Schema.Boolean,
});
export type WorkbenchCandidateSatisfactionJudgmentResult = typeof WorkbenchCandidateSatisfactionJudgmentResult.Type;

export const WorkbenchCandidateSatisfactionHistoryPage = Schema.Struct({
  runId: ref, attemptId: ref, judgments: Schema.Array(WorkbenchCandidateSatisfactionJudgment),
  interventions: Schema.Array(WorkbenchCandidateIntervention),
  nextJudgmentCursor: Schema.optional(ref), nextInterventionCursor: Schema.optional(ref),
});
export type WorkbenchCandidateSatisfactionHistoryPage = typeof WorkbenchCandidateSatisfactionHistoryPage.Type;
