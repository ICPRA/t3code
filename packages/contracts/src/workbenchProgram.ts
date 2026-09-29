import * as Schema from "effect/Schema";
import * as SchemaParser from "effect/SchemaParser";
import { EnvironmentId, ProjectId } from "./baseSchemas.ts";

const ProgramInputFields = Schema.Struct({
  project: Schema.NonEmptyString,
  nativeProjectId: ProjectId,
  runId: Schema.NonEmptyString,
});
export const WorkbenchProgramInput = Schema.declareConstructor<typeof ProgramInputFields.Type>()(
  [],
  () => (input) => SchemaParser.decodeUnknownEffect(ProgramInputFields, { onExcessProperty: "error" })(input),
);
export type WorkbenchProgramInput = typeof WorkbenchProgramInput.Type;

export const WorkbenchProgramTarget = Schema.Struct({
  executable: Schema.NonEmptyString,
  args: Schema.Array(Schema.String),
  cwd: Schema.NonEmptyString,
  environmentId: EnvironmentId,
  nativeProjectId: ProjectId,
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
  workPurpose: Schema.NonEmptyString,
  completeOnSuccess: Schema.optional(Schema.Boolean),
  authorizedByUserId: Schema.NonEmptyString,
  hostConsumerUserId: Schema.NonEmptyString,
});

export const WorkbenchProgramObservation = Schema.Struct({
  outcome: Schema.Literals(["exited", "timed_out", "cancel_requested", "unconfirmed"]),
  exitCode: Schema.NullOr(Schema.Int),
  observedAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  timedOutAt: Schema.NullOr(Schema.String),
  cancelRequestedAt: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
});
export type WorkbenchProgramObservation = typeof WorkbenchProgramObservation.Type;

export const WorkbenchProgramLoopPolicy = Schema.Struct({
  kind: Schema.Literals(["mechanical", "innovative"]),
  termination: Schema.Struct({
    kind: Schema.Literals(["exit_code", "judgment"]),
    exitCode: Schema.optional(Schema.Struct({ stopCode: Schema.Int, continueCodes: Schema.Array(Schema.Int) })),
    judgment: Schema.optional(Schema.Struct({ criterion: Schema.NonEmptyString })),
  }),
  maxAttempts: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  synchronousCompletionBasis: Schema.NonEmptyString,
});
export const WorkbenchProgramLoopEvent = Schema.Struct({
  id: Schema.NonEmptyString, runId: Schema.NonEmptyString, attemptId: Schema.optional(Schema.NonEmptyString),
  kind: Schema.Literals(["condition", "stop"]), value: Schema.optional(Schema.Literals(["true", "false", "unknown"])),
  actorUserId: Schema.NonEmptyString, actorRunId: Schema.optional(Schema.NonEmptyString), reason: Schema.String, recordedAt: Schema.String,
  predecessorId: Schema.optional(Schema.NonEmptyString),
});
export const WorkbenchProgramCompletion = Schema.Struct({
  eventId: Schema.NonEmptyString, attemptId: Schema.optional(Schema.NonEmptyString), judgmentId: Schema.optional(Schema.NonEmptyString),
});
export const WorkbenchProgramAttempt = Schema.Struct({
  id: Schema.NonEmptyString, ordinal: Schema.Int.check(Schema.isGreaterThan(0)), grantedAt: Schema.String,
  predecessorId: Schema.optional(Schema.NonEmptyString), consumedJudgmentId: Schema.optional(Schema.NonEmptyString),
});

export const WorkbenchProgramResult = Schema.Struct({
  ...WorkbenchProgramObservation.fields,
  reporterUserId: Schema.NonEmptyString,
  recordedAt: Schema.String,
});
export const WorkbenchProgramLoopHistory = Schema.Struct({
  attempts: Schema.Array(Schema.Struct({ ...WorkbenchProgramAttempt.fields, result: Schema.optional(WorkbenchProgramResult) })),
  events: Schema.Array(WorkbenchProgramLoopEvent), nextAttemptCursor: Schema.String, nextEventCursor: Schema.String,
});

export const WorkbenchProgramRun = Schema.Struct({
  context: Schema.Struct({
    runId: Schema.NonEmptyString,
    taskSlug: Schema.NonEmptyString,
    packageId: Schema.NonEmptyString,
    body: Schema.Record(Schema.String, Schema.Unknown),
    createdAt: Schema.String,
  }),
  executorKind: Schema.Literal("program"),
  state: Schema.String,
  dispatch: Schema.Struct({
    admission: Schema.Unknown,
    resolution: Schema.Unknown,
    cancellation: Schema.Unknown,
    stopConfirmation: Schema.Unknown,
  }),
  result: Schema.NullOr(WorkbenchProgramResult),
  currentAttempt: Schema.optional(WorkbenchProgramAttempt),
  loopState: Schema.optional(Schema.Struct({
    status: Schema.Literals(["prepared", "admitted", "ready", "waiting", "stopped", "needs_human", "cancelled", "completed"]),
    condition: Schema.optional(Schema.Struct({ value: Schema.Literals(["true", "false", "unknown"]), judgmentId: Schema.optional(Schema.NonEmptyString) })),
    stop: Schema.optional(WorkbenchProgramLoopEvent),
    completion: Schema.optional(WorkbenchProgramCompletion),
  })),
  completion: Schema.optional(WorkbenchProgramCompletion),
  replayed: Schema.Boolean,
});
export type WorkbenchProgramRun = typeof WorkbenchProgramRun.Type;

export const WorkbenchProgramStatus = Schema.Struct({
  run: WorkbenchProgramRun,
  // Tracks this host's runner fiber, not proof that the process tree is alive or stopped.
  running: Schema.Boolean,
  // These are observations of this server process, not durable run fields.
  resultWriteError: Schema.optional(Schema.String),
  completionError: Schema.optional(Schema.String),
  loopError: Schema.optional(Schema.String),
});
export type WorkbenchProgramStatus = typeof WorkbenchProgramStatus.Type;

export class WorkbenchProgramError extends Schema.TaggedError<WorkbenchProgramError>()(
  "WorkbenchProgramError",
  { message: Schema.String },
) {}
