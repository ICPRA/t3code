import * as Schema from "effect/Schema";
import { WorkbenchProgramResult } from "./workbenchProgram.ts";

const id = Schema.NonEmptyString;
const summary = Schema.Struct({
  kind: id, eventId: Schema.optional(id), attemptId: Schema.optional(id),
  humanSubstitute: Schema.optional(Schema.Struct({ statement: id,
    sourceRefs: Schema.Array(Schema.String), missingInfo: Schema.Array(Schema.String) })),
});
export const WorkbenchRawPreparationHandoff = Schema.Struct({
  environmentId: id, threadId: id, summary,
});
export type WorkbenchRawPreparationHandoff = typeof WorkbenchRawPreparationHandoff.Type;

export const WorkbenchCancelPreparation = Schema.Struct({
  packageId: id, note: id, rawHandoff: Schema.optional(WorkbenchRawPreparationHandoff),
});
export type WorkbenchCancelPreparation = typeof WorkbenchCancelPreparation.Type;

export const WorkbenchRunPreparationCancellation = Schema.Struct({
  actor: id, note: id, cancelledAt: Schema.String,
  rawHandoff: Schema.optional(WorkbenchRawPreparationHandoff),
});
export type WorkbenchRunPreparationCancellation = typeof WorkbenchRunPreparationCancellation.Type;
const handoff = Schema.Struct({ runId: id, admissionId: id, summary });
const dispatch = Schema.Struct({ runId: id, admissionId: id, executorKind: id, environmentId: id,
  nativeProjectId: Schema.optional(id), attemptId: Schema.optional(id) });
const preparation = Schema.Struct({ runId: id, packageId: id, executorKind: id, state: id,
  environmentId: Schema.String, threadId: Schema.String, raw: Schema.Boolean });
const preparedHandoff = Schema.Struct({ runId: id, packageId: id, summary, stopNote: id });
const claim = Schema.Struct({ agent: id, claimedAt: Schema.String, leaseExpires: Schema.String });
const claimHandoff = Schema.Struct({ agent: id, claimedAt: Schema.String, summary, stopNote: id });

export const WorkbenchNodeOwnershipOperation = Schema.Struct({
  id, taskSlug: id, idempotencyKey: id, action: id, status: id,
  beforeOwnerUserId: Schema.NullOr(id), afterOwnerUserId: Schema.NullOr(id),
  fromVersion: Schema.Int, toVersion: Schema.optional(Schema.Int), actorUserId: id, reason: id,
  dispatches: Schema.Array(dispatch), preparations: Schema.Array(preparation),
  handoffs: Schema.Array(handoff), preparedHandoffs: Schema.Array(preparedHandoff),
  frozenClaim: Schema.NullOr(claim), claimHandoff: Schema.NullOr(claimHandoff),
  createdAt: Schema.String, finishedAt: Schema.optional(Schema.String),
  cancelActorUserId: Schema.optional(id), cancelReason: Schema.optional(Schema.String),
  replayed: Schema.optional(Schema.Boolean),
});
export type WorkbenchNodeOwnershipOperation = typeof WorkbenchNodeOwnershipOperation.Type;

export const WorkbenchNodeOwnershipState = Schema.Struct({
  taskSlug: id, version: Schema.Int, humanOwnerUserId: Schema.NullOr(id),
  pending: Schema.optional(WorkbenchNodeOwnershipOperation),
  dispatchObservations: Schema.Array(Schema.Struct({ runId: id, admissionId: id,
    stopConfirmedAt: Schema.optional(Schema.String), releaseKind: Schema.optional(id),
    currentAttemptId: Schema.optional(id), programResult: Schema.NullOr(WorkbenchProgramResult) })),
  preparationObservations: Schema.Array(Schema.Struct({ runId: id, packageId: id,
    cancelledAt: Schema.optional(Schema.String) })),
  currentClaim: Schema.NullOr(claim),
});
export type WorkbenchNodeOwnershipState = typeof WorkbenchNodeOwnershipState.Type;

export const WorkbenchNodeOwnershipPage = Schema.Struct({
  taskSlug: id, operations: Schema.Array(WorkbenchNodeOwnershipOperation),
  hasMore: Schema.Boolean, nextCursor: Schema.NullOr(id),
});
export type WorkbenchNodeOwnershipPage = typeof WorkbenchNodeOwnershipPage.Type;

export const WorkbenchBeginNodeOwnershipTake = Schema.Struct({
  taskSlug: id, expectedVersion: Schema.Int, expectedOwnerUserId: Schema.NullOr(id),
  idempotencyKey: id, reason: id,
});
export type WorkbenchBeginNodeOwnershipTake = typeof WorkbenchBeginNodeOwnershipTake.Type;

export const WorkbenchCommitNodeOwnershipTake = Schema.Struct({
  operationId: id, expectedVersion: Schema.Int, handoffs: Schema.Array(handoff),
  preparedHandoffs: Schema.Array(preparedHandoff), claimHandoff: Schema.NullOr(claimHandoff),
});
export type WorkbenchCommitNodeOwnershipTake = typeof WorkbenchCommitNodeOwnershipTake.Type;

export const WorkbenchCancelNodeOwnershipTake = Schema.Struct({ operationId: id, reason: id });
export type WorkbenchCancelNodeOwnershipTake = typeof WorkbenchCancelNodeOwnershipTake.Type;

export const WorkbenchReturnNodeOwnership = Schema.Struct({
  taskSlug: id, expectedVersion: Schema.Int, expectedOwnerUserId: Schema.NullOr(id),
  idempotencyKey: id, reason: id,
});
export type WorkbenchReturnNodeOwnership = typeof WorkbenchReturnNodeOwnership.Type;

export const WorkbenchRecordOwnNodeHandoffSummary = Schema.Struct({ eventId: id, message: id });
export type WorkbenchRecordOwnNodeHandoffSummary = typeof WorkbenchRecordOwnNodeHandoffSummary.Type;

export const WorkbenchNodeHandoffSummaryReceipt = Schema.Struct({
  eventId: id, runId: id, taskSlug: id, message: id, recordedAt: Schema.String, replayed: Schema.Boolean,
});
export type WorkbenchNodeHandoffSummaryReceipt = typeof WorkbenchNodeHandoffSummaryReceipt.Type;

export const WorkbenchConfirmProgramRunStopped = Schema.Struct({
  runId: id, admissionId: id, attemptId: id, environmentId: id, nativeProjectId: id, note: id,
});
export type WorkbenchConfirmProgramRunStopped = typeof WorkbenchConfirmProgramRunStopped.Type;
