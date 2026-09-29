import { requestHostProgramRun, requestHostHook, type HostProgramRunOperation, type HostHookOperation, type MailConnection } from "@project-workbench/mail/client";
import { loadMailConfig } from "@project-workbench/mail/config";
import { WorkbenchProgramError, WorkbenchProgramInput, WorkbenchProgramLoopEvent, WorkbenchProgramObservation, WorkbenchProgramResult, WorkbenchProgramRun, WorkbenchProgramStatus, WorkbenchProgramTarget } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { ServerEnvironment } from "./environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProcessRunner } from "./processRunner.ts";

const Admission = Schema.Struct({ run: WorkbenchProgramRun, mayStart: Schema.Boolean });
const Completion = Schema.Struct({ runId: Schema.String, completed: Schema.String });
const HookAdmission = Schema.Struct({ id: Schema.NonEmptyString, runId: Schema.NonEmptyString, packageId: Schema.NonEmptyString });
export const CompletionProgramHook = Schema.Struct({
  id: Schema.NonEmptyString,
  project: Schema.NonEmptyString,
  targetRunId: Schema.NonEmptyString,
  targetPackageId: Schema.NonEmptyString,
  hostConsumerUserId: Schema.NonEmptyString,
  state: Schema.Literals(["armed", "pending", "cancelled", "blocked", "unconfirmed", "admitted"]),
  dispatchStatus: Schema.NullOr(Schema.Literals(["blocked", "unconfirmed"])),
  admission: Schema.NullOr(HookAdmission),
});
const HookPreparation = Schema.Struct({
  hook: CompletionProgramHook,
  run: WorkbenchProgramRun,
  readinessError: Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String })),
});
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const failure = (message: string) => new WorkbenchProgramError({ message });
type OwnedRun = {
  running: boolean;
  fiber?: Fiber.Fiber<void>;
  cancelRequestedAt: string | null;
  resultWriteError?: string;
  completionError?: string;
  pendingObservation?: WorkbenchProgramObservation;
  attemptId?: string;
  pendingAttemptId?: string;
  loopError?: string;
  lock: Semaphore.Semaphore;
};

export class WorkbenchProgramRuns extends Context.Service<WorkbenchProgramRuns, {
  readonly start: (input: WorkbenchProgramInput) => Effect.Effect<WorkbenchProgramStatus, WorkbenchProgramError>;
  readonly startFromHook: (input: WorkbenchProgramInput, hookId: string) => Effect.Effect<WorkbenchProgramStatus, WorkbenchProgramError>;
  readonly cancel: (input: WorkbenchProgramInput) => Effect.Effect<WorkbenchProgramStatus, WorkbenchProgramError>;
  readonly read: (input: WorkbenchProgramInput) => Effect.Effect<WorkbenchProgramStatus, WorkbenchProgramError>;
  readonly complete: (input: WorkbenchProgramInput) => Effect.Effect<WorkbenchProgramStatus, WorkbenchProgramError>;
  readonly resumeLoop: (input: WorkbenchProgramInput) => Effect.Effect<WorkbenchProgramStatus, WorkbenchProgramError>;
}>()("t3/workbenchProgramRuns") {}

export const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner;
  const snapshots = yield* ProjectionSnapshotQuery;
  const environment = yield* ServerEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Scope.make("parallel");
  const owned = new Map<string, OwnedRun>();
  let closing = false;
  yield* Effect.addFinalizer(() => Effect.sync(() => { closing = true; }).pipe(
    Effect.andThen(Scope.close(scope, Exit.void)),
  ));
  const key = (input: WorkbenchProgramInput) => JSON.stringify([input.project, input.nativeProjectId, input.runId]);

  const context = Effect.fnUntraced(function* (input: WorkbenchProgramInput) {
    const config = yield* Effect.try({
      try: () => loadMailConfig(process.env.T3_WORKBENCH_MAIL_CONFIG),
      catch: () => failure("Program host configuration could not be loaded"),
    });
    if (config === undefined || !("executable" in config)) return yield* failure("Program execution requires configured local transport");
    if (Object.hasOwn(config.projects, input.nativeProjectId) && config.projects[input.nativeProjectId] !== input.project) {
      return yield* failure("Program project does not match the native project's configured SpecGraph project");
    }
    const project = yield* snapshots.getProjectShellById(input.nativeProjectId).pipe(Effect.mapError(() => failure("Program native project lookup failed")));
    if (Option.isNone(project)) return yield* failure("Program requires its original native project");
    const environmentId = yield* environment.getEnvironmentId.pipe(Effect.mapError(() => failure("Program environment identity unavailable")));
    return { connection: { ...config, project: input.project } satisfies MailConnection, host: { environmentId, nativeProjectId: input.nativeProjectId } };
  });
  type HostContext = Effect.Success<ReturnType<typeof context>>;
  const invoke = Effect.fnUntraced(function* (ctx: HostContext, input: WorkbenchProgramInput, operation: HostProgramRunOperation, payload: Readonly<Record<string, unknown>> = {}) {
    const response = yield* Effect.tryPromise({
      try: (signal) => requestHostProgramRun(ctx.connection, ctx.host, operation, { runId: input.runId, ...payload }, signal),
      catch: (error) => failure(`Program transport outcome is unconfirmed: ${error instanceof Error ? error.message : String(error)}`),
    }).pipe(Effect.interruptible, Effect.timeout("10 seconds"), Effect.mapError((error) => failure(error.message)));
    if (response.error) return yield* failure(`Program operation rejected (${response.error.code}): ${response.error.message}`);
    return response.data;
  });
  const readRun = Effect.fnUntraced(function* (ctx: HostContext, input: WorkbenchProgramInput) {
    const raw = yield* invoke(ctx, input, "host-read-program-run");
    const run = yield* Schema.decodeUnknownEffect(WorkbenchProgramRun)(raw).pipe(Effect.mapError(() => failure("Invalid program run response")));
    yield* verifyTarget(ctx, input, run);
    return run;
  });
  const verifyTarget = Effect.fnUntraced(function* (ctx: HostContext, input: WorkbenchProgramInput, run: WorkbenchProgramRun) {
    const target = yield* Schema.decodeUnknownEffect(WorkbenchProgramTarget)(run.context.body.program_target).pipe(Effect.mapError(() => failure("Invalid fixed program target")));
    if (run.context.runId !== input.runId || target.environmentId !== ctx.host.environmentId || target.nativeProjectId !== input.nativeProjectId) {
      return yield* failure("Program run does not match its original host and project");
    }
    return target;
  });
  const status = (input: WorkbenchProgramInput, run: WorkbenchProgramRun): WorkbenchProgramStatus => {
    const entry = owned.get(key(input));
    return { run, running: entry?.running ?? false, ...(entry?.resultWriteError === undefined ? {} : { resultWriteError: entry.resultWriteError }), ...(entry?.completionError === undefined ? {} : { completionError: entry.completionError }), ...(entry?.loopError === undefined ? {} : { loopError: entry.loopError }) };
  };
  const record = Effect.fnUntraced(function* (ctx: HostContext, input: WorkbenchProgramInput, observation: WorkbenchProgramObservation, attemptId?: string) {
    const raw = yield* invoke(ctx, input, attemptId === undefined ? "host-result-program-run" : "host-result-program-attempt", { observation, ...(attemptId === undefined ? {} : { attemptId }) });
    const result = yield* attemptId === undefined
      ? Schema.decodeUnknownEffect(WorkbenchProgramResult)(raw).pipe(Effect.mapError(() => failure("Program result persistence is unconfirmed: invalid receipt")))
      : Effect.gen(function* () {
        const receipt = yield* Schema.decodeUnknownEffect(Schema.Struct({ runId: Schema.NonEmptyString, attemptId: Schema.NonEmptyString, result: WorkbenchProgramResult }))(raw).pipe(Effect.mapError(() => failure("Program attempt result persistence is unconfirmed: invalid receipt")));
        if (receipt.runId !== input.runId || receipt.attemptId !== attemptId) return yield* failure("Program attempt result persistence is unconfirmed: mismatched identity");
        return receipt.result;
      });
    if (result.outcome !== observation.outcome || result.exitCode !== observation.exitCode || result.summary !== observation.summary) {
      return yield* failure("Program result persistence is unconfirmed: mismatched receipt");
    }
    for (const field of ["observedAt", "startedAt", "finishedAt", "timedOutAt", "cancelRequestedAt"] as const) {
      const received = result[field];
      const observed = observation[field];
      if (received === null || observed === null) {
        if (received !== observed) return yield* failure("Program result persistence is unconfirmed: mismatched receipt");
        continue;
      }
      const receivedTime = DateTime.make(received);
      const observedTime = DateTime.make(observed);
      if (Option.isNone(receivedTime) || Option.isNone(observedTime) || !DateTime.Equivalence(receivedTime.value, observedTime.value)) return yield* failure("Program result persistence is unconfirmed: mismatched receipt");
    }
  });
  const completeRun = Effect.fnUntraced(function* (ctx: HostContext, input: WorkbenchProgramInput, run: WorkbenchProgramRun) {
    const raw = yield* invoke(ctx, input, "host-complete-program-run");
    const receipt = yield* Schema.decodeUnknownEffect(Completion)(raw).pipe(Effect.mapError(() => failure("Program completion is unconfirmed: invalid receipt")));
    if (receipt.runId !== input.runId || receipt.completed !== run.context.taskSlug) return yield* failure("Program completion is unconfirmed: mismatched receipt");
  });
  const read = Effect.fnUntraced(function* (input: WorkbenchProgramInput) {
    const ctx = yield* context(input);
    const entry = owned.get(key(input));
    const current = Effect.gen(function* () { return status(input, yield* readRun(ctx, input)); });
    return yield* entry === undefined ? current : entry.lock.withPermits(1)(current);
  });

  const retryResult = Effect.fnUntraced(function* (ctx: HostContext, input: WorkbenchProgramInput, entry: OwnedRun) {
    yield* entry.lock.withPermits(1)(Effect.gen(function* () {
      if (entry.running || entry.pendingObservation === undefined) return;
      yield* record(ctx, input, entry.pendingObservation, entry.pendingAttemptId);
      delete entry.pendingObservation;
      delete entry.pendingAttemptId;
      delete entry.resultWriteError;
      if (entry.completionError === undefined) owned.delete(key(input));
    }));
  });

  const launch: (ctx: HostContext, input: WorkbenchProgramInput, run: WorkbenchProgramRun, entry: OwnedRun) => Effect.Effect<void, WorkbenchProgramError> = Effect.fnUntraced(function* (ctx: HostContext, input: WorkbenchProgramInput, run: WorkbenchProgramRun, entry: OwnedRun) {
    const target = yield* verifyTarget(ctx, input, run);
    const attemptId = run.loopState === undefined ? undefined : run.currentAttempt?.id;
    if (run.loopState !== undefined && attemptId === undefined) return yield* failure("Program loop admission has no attempt identity");
    if (attemptId === undefined) delete entry.attemptId;
    else entry.attemptId = attemptId;
    if (closing || entry.cancelRequestedAt !== null || run.loopState !== undefined && run.loopState.status !== "admitted") {
      const observation: WorkbenchProgramObservation = { outcome: "unconfirmed", exitCode: null, observedAt: yield* now, startedAt: null, finishedAt: null, timedOutAt: null, cancelRequestedAt: entry.cancelRequestedAt, summary: "Host shutdown or loop stop followed admission; no physical start was observed" };
      const saved = yield* record(ctx, input, observation, attemptId).pipe(Effect.result);
      if (saved._tag === "Failure") {
        entry.pendingObservation = observation;
        if (attemptId !== undefined) entry.pendingAttemptId = attemptId;
        entry.resultWriteError = saved.failure.message;
        return yield* saved.failure;
      }
      return;
    }
    entry.running = true;
    const finish = (exit: Exit.Exit<import("./processRunner.ts").ProcessRunOutput, import("./processRunner.ts").ProcessRunError>) => entry.lock.withPermits(1)(Effect.gen(function* () {
      entry.running = false;
      const observedAt = yield* now;
      const output = Exit.isSuccess(exit) ? exit.value : undefined;
      const timedOut = output?.timedOut === true;
      const exited = output !== undefined && !timedOut && output.code !== null;
      const observation: WorkbenchProgramObservation = {
        outcome: exited ? "exited" : timedOut ? "timed_out" : entry.cancelRequestedAt !== null ? "cancel_requested" : "unconfirmed",
        exitCode: exited ? output.code : null, observedAt, startedAt: null,
        finishedAt: exited ? observedAt : null, timedOutAt: timedOut ? observedAt : null, cancelRequestedAt: entry.cancelRequestedAt,
        summary: (output === undefined ? "Process exit is unconfirmed; process tree termination is not verified" : timedOut ? "Program timed out; process tree termination is not verified" : `${output.stdout}\n${output.stderr}`).replaceAll("\0", "").slice(0, 3900),
      };
      const saved = yield* record(ctx, input, observation, attemptId).pipe(Effect.result);
      if (saved._tag === "Failure") {
        entry.pendingObservation = observation;
        if (attemptId === undefined) delete entry.pendingAttemptId;
        else entry.pendingAttemptId = attemptId;
        entry.resultWriteError = saved.failure.message;
        yield* Effect.logError("Program result write failed", { runId: input.runId, attemptId, message: entry.resultWriteError });
        return;
      }
      delete entry.resultWriteError;
      const current = run.loopState === undefined ? run : yield* readRun(ctx, input);
      if (current.context.packageId !== run.context.packageId) return yield* failure("Program loop result does not match its fixed package");
      if (run.loopState !== undefined && current.currentAttempt?.id !== attemptId) return;
      if (target.completeOnSuccess && exited && output.code === 0 && entry.cancelRequestedAt === null && (run.loopState === undefined || current.loopState?.status === "stopped" && current.loopState.condition?.value === "true")) {
        const completed = yield* completeRun(ctx, input, current).pipe(Effect.result);
        if (completed._tag === "Failure") {
          entry.completionError = completed.failure.message;
          yield* Effect.logError("Program completion failed", { runId: input.runId, message: entry.completionError });
          return;
        }
      }
      if (exited && entry.cancelRequestedAt === null && current.loopState?.status === "ready") {
        yield* advance(ctx, input, current, entry);
      } else owned.delete(key(input));
    }).pipe(Effect.catch((error) => Effect.sync(() => { entry.loopError = error.message; }).pipe(Effect.andThen(Effect.logError("Program loop continuation failed", { runId: input.runId, message: error.message }))))));
    entry.fiber = yield* runner.run({ command: target.executable, args: target.args, cwd: target.cwd, timeout: target.timeoutMs, maxOutputBytes: 4096, outputMode: "truncate", timeoutBehavior: "timedOutResult" }).pipe(
      Effect.onExit(finish), Effect.asVoid,
      Effect.catchCause((cause) => Effect.logError("Program process ended without a confirmed normal result", { runId: input.runId, cause: Cause.pretty(cause) })),
      Effect.forkIn(scope, { startImmediately: true }),
    );
  });
  const advance = Effect.fnUntraced(function* (ctx: HostContext, input: WorkbenchProgramInput, previous: WorkbenchProgramRun, entry: OwnedRun) {
    if (closing || entry.running || entry.cancelRequestedAt !== null || previous.loopState?.status !== "ready") return;
    const predecessor = previous.currentAttempt?.id;
    if (predecessor === undefined) return yield* failure("Ready program loop has no previous attempt identity");
    const target = yield* verifyTarget(ctx, input, previous);
    const directory = yield* fs.stat(target.cwd).pipe(Effect.mapError(() => failure("Authorized program working directory is unavailable")));
    if (directory.type !== "Directory") return yield* failure("Authorized program working directory is not a directory");
    const raw = yield* invoke(ctx, input, "host-authorize-next-program-attempt", { expectedPreviousAttemptId: predecessor });
    const admission = yield* Schema.decodeUnknownEffect(Admission)(raw).pipe(Effect.mapError(() => failure("Program attempt admission is unconfirmed; read before taking further action")));
    yield* verifyTarget(ctx, input, admission.run);
    if (admission.run.context.packageId !== previous.context.packageId || admission.run.currentAttempt?.predecessorId !== predecessor) return yield* failure("Program attempt admission does not match its predecessor and fixed package");
    if (!admission.mayStart) return;
    const current = yield* readRun(ctx, input);
    if (current.context.packageId !== previous.context.packageId || current.currentAttempt?.id !== admission.run.currentAttempt.id) return yield* failure("Program attempt admission no longer matches its authoritative run");
    delete entry.loopError;
    yield* launch(ctx, input, current, entry);
  });
  const resumeLoop = Effect.fnUntraced(function* (input: WorkbenchProgramInput) {
    const ctx = yield* context(input);
    let entry = owned.get(key(input));
    if (entry === undefined) {
      entry = { running: false, cancelRequestedAt: null, lock: yield* Semaphore.make(1) };
      owned.set(key(input), entry);
    }
    const owner = entry;
    return yield* owner.lock.withPermits(1)(Effect.uninterruptible(Effect.gen(function* () {
      const run = yield* readRun(ctx, input);
      if (owner.running || owner.pendingObservation !== undefined || closing) return status(input, run);
      if (run.loopState?.status === "ready") yield* advance(ctx, input, run, owner);
      else if (run.loopState?.status === "stopped" && run.loopState.condition?.value === "true" && run.result?.outcome === "exited" && run.result.exitCode === 0 && run.result.cancelRequestedAt === null && run.result.timedOutAt === null && (yield* verifyTarget(ctx, input, run)).completeOnSuccess) yield* completeRun(ctx, input, run);
      return status(input, yield* readRun(ctx, input));
    })));
  });

  const start = Effect.fnUntraced(function* (input: WorkbenchProgramInput, hookId?: string) {
    const ctx = yield* context(input);
    let uncertain = false;
    let admitted = false;
    let hookMayDispatch = true;
    const invokeHook = Effect.fnUntraced(function* (operation: HostHookOperation, result?: { status: "blocked" | "unconfirmed"; detail: string }) {
      const response = yield* Effect.tryPromise({
        try: (signal) => requestHostHook(ctx.connection, ctx.host, operation, { hookId: hookId!, ...result }, signal),
        catch: (error) => failure(`Completion hook transport outcome is unconfirmed: ${error instanceof Error ? error.message : String(error)}`),
      }).pipe(Effect.interruptible, Effect.timeout("10 seconds"), Effect.mapError((error) => {
        uncertain = true;
        return failure(error.message);
      }));
      if (response.error) return yield* failure(`Completion hook operation rejected (${response.error.code}): ${response.error.message}`);
      return response.data;
    });
    const result = yield* Effect.gen(function* () {
      const previous = owned.get(key(input));
      if (hookId === undefined && previous !== undefined && !previous.running && previous.pendingObservation !== undefined) {
        yield* retryResult(ctx, input, previous);
        return status(input, yield* readRun(ctx, input));
      }
      const run = yield* hookId === undefined ? readRun(ctx, input) : Effect.gen(function* () {
        const raw = yield* invokeHook("host-read-completion-hook");
        const preparation = yield* Schema.decodeUnknownEffect(HookPreparation)(raw).pipe(Effect.mapError(() => {
          uncertain = true;
          return failure("Invalid completion hook preparation");
        }));
        const { hook, run } = preparation;
        const target = yield* verifyTarget(ctx, input, run);
        if (hook.id !== hookId || hook.project !== input.project || hook.targetRunId !== input.runId || hook.targetPackageId !== run.context.packageId || hook.hostConsumerUserId !== target.hostConsumerUserId ||
          (hook.admission !== null && (hook.admission.runId !== input.runId || hook.admission.packageId !== run.context.packageId))) {
          uncertain = true;
          return yield* failure("Completion hook does not match its fixed program preparation");
        }
        admitted = hook.admission !== null;
        if (hook.admission !== null) {
          const actual = yield* Schema.decodeUnknownEffect(HookAdmission)(run.dispatch.admission).pipe(Effect.mapError(() => {
            uncertain = true;
            return failure("Completion hook admission is missing from its program run");
          }));
          if (actual.id !== hook.admission.id || actual.runId !== hook.admission.runId || actual.packageId !== hook.admission.packageId) {
            uncertain = true;
            return yield* failure("Completion hook admission does not match its program run");
          }
        }
        hookMayDispatch = admitted || hook.state === "pending";
        if (!admitted && hook.state === "pending" && preparation.readinessError !== null) return yield* failure(`${preparation.readinessError.code}: ${preparation.readinessError.message}`);
        return run;
      });
      if (!hookMayDispatch) return status(input, run);
      const target = yield* verifyTarget(ctx, input, run);
      const directory = yield* fs.stat(target.cwd).pipe(Effect.mapError(() => failure("Authorized program working directory is unavailable")));
      if (directory.type !== "Directory") return yield* failure("Authorized program working directory is not a directory");
      return yield* Effect.uninterruptible(Effect.gen(function* () {
        if (closing) return yield* failure("Program host is shutting down");
        const raw = yield* hookId === undefined ? invoke(ctx, input, "host-authorize-program-run") : invokeHook("host-authorize-completion-hook");
        const admission = yield* Schema.decodeUnknownEffect(Admission)(raw).pipe(Effect.mapError(() => {
          uncertain = true;
          return failure("Program admission is unconfirmed; read before taking further action");
        }));
        yield* verifyTarget(ctx, input, admission.run);
        if (admission.run.context.packageId !== run.context.packageId) {
          uncertain = true;
          return yield* failure("Program admission does not match its fixed package");
        }
        if (!admission.mayStart) return status(input, admission.run);
        admitted = true;
        const entry: OwnedRun = { running: false, cancelRequestedAt: null, lock: yield* Semaphore.make(1) };
        owned.set(key(input), entry);
        const current = admission.run.loopState === undefined ? admission.run : yield* readRun(ctx, input);
        if (current.context.packageId !== admission.run.context.packageId || current.currentAttempt?.id !== admission.run.currentAttempt?.id) return yield* failure("Program admission no longer matches its authoritative run");
        yield* launch(ctx, input, current, entry);
        return status(input, closing ? yield* readRun(ctx, input) : current);
      }));
    }).pipe(Effect.result);
    if (result._tag === "Success") return result.success;
    if (hookId !== undefined) {
      const status = uncertain || admitted ? "unconfirmed" : "blocked";
      const reported = yield* invokeHook("host-result-completion-hook", { status, detail: result.failure.message.replaceAll("\0", "").slice(0, 3900) }).pipe(
        Effect.flatMap((raw) => Schema.decodeUnknownEffect(CompletionProgramHook)(raw)),
        Effect.mapError((error) => failure(`Completion hook status persistence is unconfirmed: ${error.message}`)),
      );
      if (reported.id !== hookId || reported.project !== input.project || reported.targetRunId !== input.runId || reported.dispatchStatus !== status) {
        return yield* failure("Completion hook status persistence is unconfirmed: mismatched receipt");
      }
    }
    return yield* result.failure;
  });
  const cancel = Effect.fnUntraced(function* (input: WorkbenchProgramInput) {
    const ctx = yield* context(input);
    const run = yield* readRun(ctx, input);
    if (run.loopState !== undefined) {
      const raw = yield* invoke(ctx, input, "host-stop-program-loop", { reason: "Host user requested cancellation; process tree termination is not verified" });
      const receipt = yield* Schema.decodeUnknownEffect(WorkbenchProgramLoopEvent)(raw).pipe(Effect.mapError(() => failure("Program loop stop persistence is unconfirmed: invalid receipt")));
      if (receipt.runId !== input.runId || receipt.kind !== "stop") return yield* failure("Program loop stop persistence is unconfirmed: mismatched receipt");
    }
    const entry = owned.get(key(input));
    if (entry === undefined) return status(input, run.loopState === undefined ? run : yield* readRun(ctx, input));
    if (run.loopState !== undefined) entry.cancelRequestedAt ??= yield* now;
    yield* entry.lock.withPermits(1)(Effect.uninterruptible(Effect.gen(function* () {
      if (!entry.running || entry.fiber === undefined) return;
      entry.cancelRequestedAt ??= yield* now;
      const observation: WorkbenchProgramObservation = { outcome: "cancel_requested", exitCode: null, observedAt: entry.cancelRequestedAt, startedAt: null, finishedAt: null, timedOutAt: null, cancelRequestedAt: entry.cancelRequestedAt, summary: "Cancellation requested; process tree termination is not verified" };
      const saved = yield* record(ctx, input, observation, entry.attemptId).pipe(Effect.result);
      if (saved._tag === "Failure") entry.resultWriteError = saved.failure.message;
      yield* Fiber.interrupt(entry.fiber).pipe(Effect.forkIn(scope));
      if (saved._tag === "Failure") return yield* saved.failure;
    })));
    return status(input, yield* readRun(ctx, input));
  });
  const complete = Effect.fnUntraced(function* (input: WorkbenchProgramInput) {
    const ctx = yield* context(input);
    const run = yield* readRun(ctx, input);
    const prior = owned.get(key(input));
    if (prior !== undefined) yield* retryResult(ctx, input, prior);
    yield* completeRun(ctx, input, run);
    const entry = owned.get(key(input));
    if (entry !== undefined) {
      delete entry.completionError;
      if (!entry.running && entry.pendingObservation === undefined && entry.resultWriteError === undefined) owned.delete(key(input));
    }
    return status(input, yield* readRun(ctx, input));
  });
  return WorkbenchProgramRuns.of({ start, startFromHook: (input, hookId) => start(input, hookId), cancel, read, complete, resumeLoop });
});

export const layer = Layer.effect(WorkbenchProgramRuns, make);
