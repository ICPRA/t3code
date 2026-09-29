import { EnvironmentId, ProjectId, WorkbenchProgramInput, WorkbenchProgramStatus, type OrchestrationProjectShell, type WorkbenchProgramObservation, type WorkbenchProgramRun } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as MailClient from "@project-workbench/mail/client";
import * as MailConfig from "@project-workbench/mail/config";
import { ServerEnvironment } from "./environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProcessRunner, type ProcessRunOutput } from "./processRunner.ts";
import { make } from "./workbenchProgramRuns.ts";

const input = { project: "spec", nativeProjectId: ProjectId.make("native"), runId: "run" };
const environmentId = EnvironmentId.make("environment");
const output = { stdout: "observed stdout", stderr: "", code: 0, timedOut: false, stdoutTruncated: false, stderrTruncated: false, stdoutInvalidUtf8: false, stderrInvalidUtf8: false } as ProcessRunOutput;
const fixture = Effect.gen(function* () {
  const execution = yield* Deferred.make<ProcessRunOutput>();
  const interrupted = yield* Deferred.make<void>();
  const resultAttempt = Promise.withResolvers<void>();
  const config = { executable: "never-executed.exe", config: "fixture.yaml", token: "service", projects: {} as Record<string, string> };
  vi.spyOn(MailConfig, "loadMailConfig").mockReturnValue(config);
  const target = { executable: "never-executed.exe", args: ["literal"], cwd: "C:/authorized-external-directory", environmentId, nativeProjectId: input.nativeProjectId, timeoutMs: 1000, workPurpose: "coordination", completeOnSuccess: true, authorizedByUserId: "human", hostConsumerUserId: "service" };
  const data: WorkbenchProgramRun = { context: { runId: input.runId, taskSlug: "task", packageId: "package", body: { program_target: target }, createdAt: "2026-09-27T00:00:00Z" }, executorKind: "program", state: "prepared", dispatch: { admission: null, resolution: null, cancellation: null, stopConfirmation: null }, result: null, replayed: false };
  const state = { admitted: false, failWrite: false, failComplete: false, absentProject: false, invalidReceiptTime: false, hookActive: false, sourceChanged: false, cancelBeforeAdmission: false, loseHookAdmission: false };
  const hook = { id: "hook", project: input.project, targetRunId: input.runId, targetPackageId: "package", hostConsumerUserId: "service", state: "pending", dispatchStatus: null as null | "blocked" | "unconfirmed", admission: null as null | { id: string; runId: string; packageId: string } };
  const observations: WorkbenchProgramObservation[] = [];
  const request = vi.spyOn(MailClient, "requestHostProgramRun").mockImplementation(async (_connection, scope, operation, payload) => {
    expect(scope).toEqual({ environmentId, nativeProjectId: input.nativeProjectId });
    if (operation === "host-read-program-run") return { data: structuredClone(data) };
    if (operation === "host-authorize-program-run") {
      if (state.hookActive) return { error: { code: "program_hook_required", message: "Use the fixed completion hook" } };
      const mayStart = !state.admitted;
      state.admitted = true;
      return { data: { run: structuredClone(data), mayStart } };
    }
    if (operation === "host-result-program-run") {
      const observation = payload.observation as WorkbenchProgramObservation;
      observations.push(observation);
      resultAttempt.resolve();
      if (state.failWrite) return { error: { code: "write_failed", message: "Result write rejected" } };
      const result = { ...observation, observedAt: observation.observedAt.replace(/\.000Z$/, "Z").replace(/(\.\d*[1-9])0+Z$/, "$1Z"), reporterUserId: "service", recordedAt: observation.observedAt };
      Object.assign(data, { result, state: observation.outcome });
      return { data: state.invalidReceiptTime ? { ...result, observedAt: "invalid-time" } : result };
    }
    if (state.failComplete) return { error: { code: "blocked", message: "Input changed" } };
    Object.assign(data, { state: "completed" });
    return { data: { runId: input.runId, completed: "task" } };
  });
  const hookRequest = vi.spyOn(MailClient, "requestHostHook").mockImplementation(async (_connection, scope, operation, payload) => {
    expect(scope).toEqual({ environmentId, nativeProjectId: input.nativeProjectId });
    if (operation === "host-read-completion-hook") return { data: { hook: structuredClone(hook), run: structuredClone(data), readinessError: state.sourceChanged ? { code: "conflict", message: "source_changed" } : null } };
    if (operation === "host-authorize-completion-hook") {
      if (state.admitted) return { data: { run: structuredClone(data), mayStart: false } };
      if (state.cancelBeforeAdmission) {
        hook.state = "cancelled";
        return { error: { code: "conflict", message: "Hook was cancelled" } };
      }
      if (state.sourceChanged) return { error: { code: "conflict", message: "source_changed" } };
      const mayStart = !state.admitted;
      state.admitted = true;
      hook.admission = { id: "hook-admission", runId: input.runId, packageId: "package" };
      Object.assign(data.dispatch, { admission: hook.admission });
      hook.state = "admitted";
      if (state.loseHookAdmission) throw new Error("Admission response lost");
      return { data: { run: structuredClone(data), mayStart } };
    }
    hook.dispatchStatus = payload.status as "blocked" | "unconfirmed";
    if (hook.admission === null && hook.state !== "cancelled") hook.state = hook.dispatchStatus;
    return { data: structuredClone(hook) };
  });
  const run = vi.fn<ProcessRunner["Service"]["run"]>(() => Deferred.await(execution).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))));
  const layers = Layer.mergeAll(
    Layer.mock(ProcessRunner)({ run }),
    Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(environmentId) }),
    Layer.mock(ProjectionSnapshotQuery)({ getProjectShellById: () => Effect.sync(() => state.absentProject ? Option.none() : Option.some({ id: input.nativeProjectId, workspaceRoot: "C:/different-native-project-root" } as OrchestrationProjectShell)) }),
    FileSystem.layerNoop({ stat: () => Effect.succeed({ type: "Directory" } as FileSystem.File.Info) }),
  );
  return { execution, interrupted, resultAttempt, config, target, data, hook, state, observations, request, hookRequest, run, make: make.pipe(Effect.provide(layers)) };
});
afterEach(() => vi.restoreAllMocks());

const loopFixture = Effect.gen(function* () {
  const f = yield* fixture;
  const executions = [yield* Deferred.make<ProcessRunOutput>(), yield* Deferred.make<ProcessRunOutput>(), yield* Deferred.make<ProcessRunOutput>()];
  const recorded = executions.map(() => Promise.withResolvers<void>());
  const granted = new Map<string, WorkbenchProgramRun>();
  const records: { attemptId: string; observation: WorkbenchProgramObservation }[] = [];
  const loop = { values: ["false", "true"] as Array<"true" | "false" | "unknown">, loseNext: false, stopCode: 0 };
  Object.assign(f.data, { loopState: { status: "prepared" } });
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (...args) => {
    const operation = args[2];
    const payload = args[3];
    if (operation === "host-authorize-program-run" && !f.state.admitted) {
      Object.assign(f.data, { currentAttempt: { id: "attempt-1", ordinal: 1, grantedAt: "2026-09-27T00:00:00Z" }, loopState: { status: "admitted" } });
    }
    if (operation === "host-authorize-next-program-attempt") {
      const previous = payload.expectedPreviousAttemptId as string;
      const prior = granted.get(previous);
      if (prior !== undefined) return { data: { run: structuredClone(prior), mayStart: false } };
      if (f.data.loopState?.status !== "ready") return { error: { code: "blocked", message: "Loop is not ready" } };
      expect(previous).toBe(f.data.currentAttempt?.id);
      const ordinal = f.data.currentAttempt!.ordinal + 1;
      Object.assign(f.data, { currentAttempt: { id: `attempt-${ordinal}`, ordinal, predecessorId: previous, grantedAt: "2026-09-27T00:00:00Z" }, loopState: { status: "admitted" }, result: null });
      granted.set(previous, structuredClone(f.data));
      if (loop.loseNext) throw new Error("Next admission response lost");
      return { data: { run: structuredClone(f.data), mayStart: true } };
    }
    if (operation === "host-stop-program-loop") {
      Object.assign(f.data, { loopState: { status: "cancelled" } });
      return { data: { id: "loop-stop", runId: input.runId, kind: "stop", actorUserId: "service", reason: payload.reason, recordedAt: "2026-09-27T00:00:00Z" } };
    }
    if (operation === "host-result-program-attempt") {
      const attemptId = payload.attemptId as string;
      const observation = payload.observation as WorkbenchProgramObservation;
      records.push({ attemptId, observation });
      const index = Number(attemptId.split("-")[1]) - 1;
      if (f.state.failWrite) {
        recorded[index]!.resolve();
        return { error: { code: "write_failed", message: "Result write rejected" } };
      }
      const result = { ...observation, reporterUserId: "service", recordedAt: observation.observedAt };
      if (attemptId === f.data.currentAttempt?.id) {
        Object.assign(f.data, { result, state: observation.outcome });
        if (f.data.loopState?.status !== "cancelled") {
          const value = loop.values[index] ?? "unknown";
          const normal = observation.outcome === "exited" && observation.cancelRequestedAt === null;
          Object.assign(f.data, { loopState: { status: !normal || value === "unknown" ? "waiting" : value === "true" ? "stopped" : "ready", condition: { value } } });
        }
      }
      recorded[index]!.resolve();
      return { data: { runId: input.runId, attemptId, result } };
    }
    return original(...args);
  });
  f.run.mockImplementation(() => {
    const index = f.run.mock.calls.length - 1;
    return Deferred.await(executions[index]!).pipe(Effect.onInterrupt(() => Deferred.succeed(f.interrupted, undefined)));
  });
  return { ...f, executions, recorded, records, loop, granted };
});

describe("serial program loop consumer with simulated ProcessRunner", () => {
  it.effect("does not run a prepared loop from polling, continues a zero result and completes only a later true stop", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* loopFixture;
    const service = yield* f.make;
    yield* service.resumeLoop(input);
    expect(f.run).not.toHaveBeenCalled();
    yield* service.start(input);
    yield* Deferred.succeed(f.executions[0]!, output);
    yield* Effect.promise(() => f.recorded[0]!.promise);
    expect((yield* service.read(input)).run.currentAttempt?.id).toBe("attempt-2");
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls.some((call) => call[2] === "host-complete-program-run")).toBe(false);
    yield* Deferred.succeed(f.executions[1]!, output);
    yield* Effect.promise(() => f.recorded[1]!.promise);
    expect((yield* service.read(input)).run.state).toBe("completed");
    expect(f.records.map((record) => record.attemptId)).toEqual(["attempt-1", "attempt-2"]);
    yield* service.start(input);
    expect(f.run).toHaveBeenCalledTimes(2);
  })));

  it.effect("does not pretend a nonzero true stop is successful completion", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* loopFixture;
    f.loop.values = ["true"];
    const service = yield* f.make;
    yield* service.start(input);
    yield* Deferred.succeed(f.executions[0]!, { ...output, code: 7 } as ProcessRunOutput);
    yield* Effect.promise(() => f.recorded[0]!.promise);
    expect((yield* service.read(input)).run.loopState?.status).toBe("stopped");
    yield* service.resumeLoop(input);
    expect(f.request.mock.calls.some((call) => call[2] === "host-complete-program-run")).toBe(false);
    expect(f.run).toHaveBeenCalledTimes(1);
  })));

  it.effect("persists cancellation without an owner while waiting and never continues after a late false judgment", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* loopFixture;
    const service = yield* f.make;
    Object.assign(f.data, { currentAttempt: { id: "attempt-1", ordinal: 1, grantedAt: "2026-09-27T00:00:00Z" }, loopState: { status: "waiting" } });
    expect((yield* service.cancel(input)).run.loopState?.status).toBe("cancelled");
    Object.assign(f.data.loopState!, { condition: { value: "false" } });
    yield* service.resumeLoop(input);
    expect(f.request.mock.calls.filter((call) => call[2] === "host-stop-program-loop")).toHaveLength(1);
    expect(f.run).not.toHaveBeenCalled();
  })));

  it.effect("reconciles concurrent ready consumers to one successor launch", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* loopFixture;
    const service = yield* f.make;
    Object.assign(f.data, { currentAttempt: { id: "attempt-1", ordinal: 1, grantedAt: "2026-09-27T00:00:00Z" }, loopState: { status: "ready", condition: { value: "false" } } });
    yield* Effect.all([service.resumeLoop(input), service.resumeLoop(input)], { concurrency: "unbounded" });
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls.filter((call) => call[2] === "host-authorize-next-program-attempt")).toHaveLength(1);
  })));

  it.effect("never relaunches after a lost successor grant response or a first-admission replay", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* loopFixture;
    const service = yield* f.make;
    f.state.admitted = true;
    Object.assign(f.data, { currentAttempt: { id: "attempt-1", ordinal: 1, grantedAt: "2026-09-27T00:00:00Z" }, loopState: { status: "ready", condition: { value: "false" } } });
    f.loop.loseNext = true;
    expect((yield* service.resumeLoop(input).pipe(Effect.result))._tag).toBe("Failure");
    yield* service.resumeLoop(input);
    yield* service.start(input);
    expect(f.data.currentAttempt?.id).toBe("attempt-2");
    expect(f.run).not.toHaveBeenCalled();
  })));

  it.effect("retains failed observations with their old attempt identity, not the latest attempt", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* loopFixture;
    const service = yield* f.make;
    f.state.failWrite = true;
    yield* service.start(input);
    yield* Deferred.succeed(f.executions[0]!, output);
    yield* Effect.promise(() => f.recorded[0]!.promise);
    expect((yield* service.read(input)).resultWriteError).toContain("write_failed");
    Object.assign(f.data, { currentAttempt: { id: "attempt-2", ordinal: 2, predecessorId: "attempt-1", grantedAt: "2026-09-27T00:00:00Z" }, loopState: { status: "admitted" }, result: null });
    f.state.failWrite = false;
    yield* service.start(input);
    expect(f.records.map((record) => record.attemptId)).toEqual(["attempt-1", "attempt-1"]);
    expect(f.records[1]!.observation).toEqual(f.records[0]!.observation);
    expect(f.data.result).toBeNull();
    expect(f.run).toHaveBeenCalledTimes(1);
  })));

  it.effect("persists loop stop before handling a concurrent in-flight next grant", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* loopFixture;
    const service = yield* f.make;
    Object.assign(f.data, { currentAttempt: { id: "attempt-1", ordinal: 1, grantedAt: "2026-09-27T00:00:00Z" }, loopState: { status: "ready", condition: { value: "false" } } });
    const entered = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[2] === "host-authorize-next-program-attempt") { entered.resolve(); await release.promise; }
      if (args[2] === "host-stop-program-loop") stopped.resolve();
      return result;
    });
    const resuming = yield* service.resumeLoop(input).pipe(Effect.forkChild);
    yield* Effect.promise(() => entered.promise);
    const cancelling = yield* service.cancel(input).pipe(Effect.forkChild);
    yield* Effect.promise(() => stopped.promise);
    release.resolve();
    yield* Fiber.join(resuming);
    expect((yield* Fiber.join(cancelling)).run.loopState?.status).toBe("cancelled");
    expect(f.run).not.toHaveBeenCalled();
    expect(f.records[0]?.attemptId).toBe("attempt-2");
    expect(f.records[0]?.observation.summary).toContain("no physical start");
  })));

  it.effect("does not launch a consumed successor when closing happens after async grant", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* loopFixture;
    Object.assign(f.data, { currentAttempt: { id: "attempt-1", ordinal: 1, grantedAt: "2026-09-27T00:00:00Z" }, loopState: { status: "ready", condition: { value: "false" } } });
    const scope = yield* Scope.make();
    const service = yield* f.make.pipe(Scope.provide(scope));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[2] === "host-authorize-next-program-attempt") { entered.resolve(); await release.promise; }
      return result;
    });
    const resuming = yield* service.resumeLoop(input).pipe(Effect.forkChild);
    yield* Effect.promise(() => entered.promise);
    yield* Scope.close(scope, Exit.void);
    release.resolve();
    yield* Fiber.join(resuming);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.records[0]?.attemptId).toBe("attempt-2");
    expect(f.records[0]?.observation.outcome).toBe("unconfirmed");
  })));

  it.effect("rejects a result receipt for a different attempt and retries only the original observation", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* loopFixture;
    const service = yield* f.make;
    const original = f.request.getMockImplementation()!;
    let mismatch = true;
    f.request.mockImplementation(async (...args) => {
      const response = await original(...args);
      if (args[2] === "host-result-program-attempt" && mismatch) return { data: { ...(response.data as Record<string, unknown>), attemptId: "different-attempt" } };
      return response;
    });
    yield* service.start(input);
    yield* Deferred.succeed(f.executions[0]!, output);
    yield* Effect.promise(() => f.recorded[0]!.promise);
    expect((yield* service.read(input)).resultWriteError).toContain("mismatched identity");
    expect(f.run).toHaveBeenCalledTimes(1);
    mismatch = false;
    yield* service.start(input);
    expect(f.records.map((record) => record.attemptId)).toEqual(["attempt-1", "attempt-1"]);
    expect(f.records[1]!.observation).toEqual(f.records[0]!.observation);
    expect(f.run).toHaveBeenCalledTimes(1);
  })));

  it.effect("recovers a stopped successful loop after restart without launching a process", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* loopFixture;
    const service = yield* f.make;
    Object.assign(f.data, { currentAttempt: { id: "attempt-1", ordinal: 1, grantedAt: "2026-09-27T00:00:00Z" }, loopState: { status: "stopped", condition: { value: "true" } }, result: { outcome: "exited", exitCode: 0, observedAt: "2026-09-27T00:00:00Z", startedAt: null, finishedAt: "2026-09-27T00:00:00Z", timedOutAt: null, cancelRequestedAt: null, summary: "Finished this round", reporterUserId: "service", recordedAt: "2026-09-27T00:00:00Z" } });
    expect((yield* service.resumeLoop(input)).run.state).toBe("completed");
    expect(f.run).not.toHaveBeenCalled();
    expect(f.request.mock.calls.filter((call) => call[2] === "host-complete-program-run")).toHaveLength(1);
  })));

  it.effect("does not claim a persisted stop or interrupt an active runner when stop receipt is unknown", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* loopFixture;
    const service = yield* f.make;
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      if (args[2] === "host-stop-program-loop") throw new Error("Stop transport outcome unknown");
      return original(...args);
    });
    yield* service.start(input);
    expect((yield* service.cancel(input).pipe(Effect.result))._tag).toBe("Failure");
    expect((yield* service.read(input)).running).toBe(true);
    expect(f.data.loopState?.status).toBe("admitted");
    expect(yield* Deferred.isDone(f.interrupted)).toBe(false);
  })));
});

describe("server-owned program runs with simulated boundaries", () => {
  it.effect("keeps an admitted hook running after source changes and records only the original program result", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture;
    const service = yield* f.make;
    yield* service.startFromHook(input, "hook");
    f.state.sourceChanged = true;
    expect((yield* service.startFromHook(input, "hook")).running).toBe(true);
    expect(yield* Deferred.isDone(f.interrupted)).toBe(false);
    yield* Deferred.succeed(f.execution, output);
    yield* Effect.promise(() => f.resultAttempt.promise);
    const result = yield* service.read(input);
    expect(result.run.state).toBe("completed");
    expect(result.run.result?.exitCode).toBe(0);
    expect(f.observations).toHaveLength(1);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.hookRequest.mock.calls.some((call) => call[2] === "host-result-completion-hook")).toBe(false);
  })));

  it.effect("starts hooks through their admission only and shares the existing RPC cancellation owner", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture;
    const service = yield* f.make;
    f.state.hookActive = true;
    expect((yield* service.start(input).pipe(Effect.result))._tag).toBe("Failure");
    f.request.mockClear();
    expect((yield* service.startFromHook(input, "hook")).running).toBe(true);
    yield* service.startFromHook(input, "hook");
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.hookRequest.mock.calls.filter((call) => call[2] === "host-authorize-completion-hook")).toHaveLength(2);
    expect(f.request.mock.calls.some((call) => call[2] === "host-authorize-program-run")).toBe(false);
    yield* service.cancel(input);
    yield* Deferred.await(f.interrupted);
    expect((yield* service.read(input)).run.result?.outcome).toBe("cancel_requested");
    expect(f.hookRequest.mock.calls.some((call) => call[2] === "host-result-completion-hook")).toBe(false);
  })));

  it.effect("blocks withdrawn source facts without automatically retrying that hook", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture;
    const service = yield* f.make;
    f.state.sourceChanged = true;
    expect((yield* service.startFromHook(input, "hook").pipe(Effect.result))._tag).toBe("Failure");
    expect(f.hook.dispatchStatus).toBe("blocked");
    yield* service.startFromHook(input, "hook");
    expect(f.hookRequest.mock.calls.some((call) => call[2] === "host-authorize-completion-hook")).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
  })));

  it.effect("rechecks source revocation and cancellation at the hook admission boundary", () => Effect.scoped(Effect.gen(function* () {
    for (const change of ["source", "cancel"] as const) {
      const f = yield* fixture;
      const service = yield* f.make;
      const request = f.hookRequest.getMockImplementation()!;
      f.hookRequest.mockImplementation(async (...args) => {
        if (args[2] === "host-authorize-completion-hook") {
          if (change === "source") f.state.sourceChanged = true;
          else f.state.cancelBeforeAdmission = true;
        }
        return request(...args);
      });
      expect((yield* service.startFromHook(input, "hook").pipe(Effect.result))._tag).toBe("Failure");
      expect(f.run).not.toHaveBeenCalled();
      expect(f.hook.dispatchStatus).toBe("blocked");
      expect(f.request.mock.calls.some((call) => call[2] === "host-authorize-program-run")).toBe(false);
      vi.restoreAllMocks();
    }
  })));

  it.effect("does not execute after an unknown admission response or its replay", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture;
    const service = yield* f.make;
    f.state.loseHookAdmission = true;
    expect((yield* service.startFromHook(input, "hook").pipe(Effect.result))._tag).toBe("Failure");
    expect(f.hook.dispatchStatus).toBe("unconfirmed");
    f.state.loseHookAdmission = false;
    expect((yield* service.startFromHook(input, "hook")).running).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
  })));

  it.effect("does not claim another hook's admission for a cancelled historical hook", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture;
    const service = yield* f.make;
    f.hook.state = "cancelled";
    Object.assign(f.data.dispatch, { admission: { id: "other-hook-admission", runId: input.runId, packageId: "package" } });
    yield* service.startFromHook(input, "hook");
    expect(f.hookRequest.mock.calls.map((call) => call[2])).toEqual(["host-read-completion-hook"]);
    expect(f.run).not.toHaveBeenCalled();
    f.hook.admission = { id: "not-the-target-admission", runId: input.runId, packageId: "package" };
    expect((yield* service.startFromHook(input, "hook").pipe(Effect.result))._tag).toBe("Failure");
    expect(f.hookRequest.mock.calls.some((call) => call[2] === "host-authorize-completion-hook")).toBe(false);
  })));

  it.effect("does not spawn if the server closes during hook authorization", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const request = f.hookRequest.getMockImplementation()!;
    f.hookRequest.mockImplementation(async (...args) => {
      if (args[2] === "host-authorize-completion-hook") { entered.resolve(); await release.promise; }
      return request(...args);
    });
    const scope = yield* Scope.make();
    const service = yield* f.make.pipe(Scope.provide(scope));
    const starting = yield* service.startFromHook(input, "hook").pipe(Effect.forkChild);
    yield* Effect.promise(() => entered.promise);
    yield* Scope.close(scope, Exit.void);
    release.resolve();
    expect((yield* Fiber.join(starting)).run.result?.outcome).toBe("unconfirmed");
    expect(f.run).not.toHaveBeenCalled();
  })));

  it.effect("executes once without a config mapping, persists Go-normalized timestamps before explicit completion", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture;
    const service = yield* f.make;
    expect((yield* service.start(input)).running).toBe(true);
    yield* service.start(input);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.run.mock.calls[0]?.[0]).toMatchObject({ command: f.target.executable, cwd: f.target.cwd, args: f.target.args, maxOutputBytes: 4096 });
    yield* Deferred.succeed(f.execution, output);
    yield* Effect.promise(() => f.resultAttempt.promise);
    const result = yield* service.read(input);
    expect(result.run.result?.outcome).toBe("exited");
    expect(result.run.result?.startedAt).toBeNull();
    expect(result.run.state).toBe("completed");
    expect(result.resultWriteError).toBeUndefined();
    yield* service.start(input);
    expect(f.run).toHaveBeenCalledTimes(1);
  })));

  it.effect("rejects mapping conflicts, absent native projects and mismatched targets before admission", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture;
    const service = yield* f.make;
    f.config.projects.native = "other";
    expect((yield* service.start(input).pipe(Effect.result))._tag).toBe("Failure");
    delete f.config.projects.native;
    f.state.absentProject = true;
    expect((yield* service.start(input).pipe(Effect.result))._tag).toBe("Failure");
    f.state.absentProject = false;
    f.target.environmentId = EnvironmentId.make("other");
    expect((yield* service.start(input).pipe(Effect.result))._tag).toBe("Failure");
    expect(f.run).not.toHaveBeenCalled();
    expect(f.request.mock.calls.some((call) => call[2] === "host-authorize-program-run")).toBe(false);
  })));

  it.effect("retains failed result writes and retries the same observation without executing again", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture;
    const service = yield* f.make;
    f.state.failWrite = true;
    yield* service.start(input);
    yield* Deferred.succeed(f.execution, output);
    yield* Effect.promise(() => f.resultAttempt.promise);
    const failed = yield* service.read(input);
    expect(failed.resultWriteError).toContain("write_failed");
    expect(failed.run.result).toBeNull();
    expect(f.request.mock.calls.some((call) => call[2] === "host-complete-program-run")).toBe(false);
    f.state.failWrite = false;
    yield* service.start(input);
    expect(f.observations[1]).toEqual(f.observations[0]);
    expect((yield* service.complete(input)).run.state).toBe("completed");
    expect(f.run).toHaveBeenCalledTimes(1);
  })));

  it.effect("keeps real exit when completion fails and retries only completion", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture;
    const service = yield* f.make;
    f.state.failComplete = true;
    yield* service.start(input);
    yield* Deferred.succeed(f.execution, output);
    yield* Effect.promise(() => f.resultAttempt.promise);
    const failed = yield* service.read(input);
    expect(failed.completionError).toContain("Input changed");
    expect(failed.run.result?.exitCode).toBe(0);
    f.state.failComplete = false;
    expect((yield* service.complete(input)).completionError).toBeUndefined();
    expect(f.run).toHaveBeenCalledTimes(1);
  })));

  it.effect("reports malformed receipt timestamps without losing the observed result", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture;
    const service = yield* f.make;
    f.state.invalidReceiptTime = true;
    yield* service.start(input);
    yield* Deferred.succeed(f.execution, output);
    yield* Effect.promise(() => f.resultAttempt.promise);
    expect((yield* service.read(input)).resultWriteError).toContain("mismatched receipt");
    f.state.invalidReceiptTime = false;
    yield* service.start(input);
    expect(f.observations[1]).toEqual(f.observations[0]);
    expect(f.run).toHaveBeenCalledTimes(1);
  })));

  it.effect("cancels only owned work, persists cancellation before interrupt and never claims tree stopped", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture;
    const service = yield* f.make;
    yield* service.cancel(input);
    expect(f.observations).toHaveLength(0);
    yield* service.start(input);
    yield* service.cancel(input);
    yield* Deferred.await(f.interrupted);
    const result = yield* service.read(input);
    expect(result.run.result?.outcome).toBe("cancel_requested");
    expect(result.run.result?.exitCode).toBeNull();
    expect(result.run.result?.summary).toContain("not verified");
    expect(f.request.mock.calls.some((call) => call[2] === "host-complete-program-run")).toBe(false);
  })));

  it.effect("distinguishes nonzero and timeout observations without completion", () => Effect.scoped(Effect.gen(function* () {
    for (const result of [{ ...output, code: 3 }, { ...output, code: null, timedOut: true }]) {
      const f = yield* fixture;
      const service = yield* f.make;
      yield* service.start(input);
      yield* Deferred.succeed(f.execution, result as ProcessRunOutput);
      yield* Effect.promise(() => f.resultAttempt.promise);
      const status = yield* service.read(input);
      expect(status.run.result?.outcome).toBe(result.timedOut ? "timed_out" : "exited");
      expect(status.run.result?.exitCode).toBe(result.code);
      expect(f.request.mock.calls.some((call) => call[2] === "host-complete-program-run")).toBe(false);
      vi.restoreAllMocks();
    }
  })));

  it.effect("server scope interruption records unknown without inventing cancellation or restart", () => Effect.gen(function* () {
    const f = yield* fixture;
    const scope = yield* Scope.make();
    const service = yield* f.make.pipe(Scope.provide(scope));
    yield* service.start(input);
    yield* Scope.close(scope, Exit.void);
    expect(f.data.result?.outcome).toBe("unconfirmed");
    expect(f.data.result?.cancelRequestedAt).toBeNull();
    expect(f.run).toHaveBeenCalledTimes(1);
  }));

  it.effect("request scope closure does not cancel the server-owned program", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture;
    const service = yield* f.make;
    yield* Effect.scoped(service.start(input));
    expect((yield* service.read(input)).running).toBe(true);
    expect(yield* Deferred.isDone(f.interrupted)).toBe(false);
    yield* service.start(input);
    expect(f.run).toHaveBeenCalledTimes(1);
    yield* Deferred.succeed(f.execution, output);
    yield* Effect.promise(() => f.resultAttempt.promise);
    expect((yield* service.read(input)).run.result?.exitCode).toBe(0);
  })));

  it.effect("does not spawn if the server closes while admission is in flight", () => Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture;
    const admissionEntered = Promise.withResolvers<void>();
    const releaseAdmission = Promise.withResolvers<void>();
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      if (args[2] === "host-authorize-program-run") {
        admissionEntered.resolve();
        await releaseAdmission.promise;
      }
      return request(...args);
    });
    const scope = yield* Scope.make();
    const service = yield* f.make.pipe(Scope.provide(scope));
    const starting = yield* service.start(input).pipe(Effect.forkChild);
    yield* Effect.promise(() => admissionEntered.promise);
    yield* Scope.close(scope, Exit.void);
    releaseAdmission.resolve();
    const status = yield* Fiber.join(starting);
    expect(f.run).not.toHaveBeenCalled();
    expect(status.run.result?.outcome).toBe("unconfirmed");
  })));

  it("rejects command and credentials at the RPC boundary", () => {
    expect(() => Schema.decodeUnknownSync(WorkbenchProgramInput)({ ...input, command: "injected" })).toThrow();
    expect(() => Schema.decodeUnknownSync(WorkbenchProgramInput)({ ...input, credential: "injected" })).toThrow();
  });

  it.effect("round-trips request and status through the actual RPC JSON codecs", () => Effect.gen(function* () {
    const f = yield* fixture;
    const payloadCodec = Schema.toCodecJson(WorkbenchProgramInput);
    const encoded = yield* Schema.encodeEffect(payloadCodec)(input);
    expect(yield* Schema.decodeUnknownEffect(payloadCodec)(encoded)).toEqual(input);
    expect((yield* Schema.decodeUnknownEffect(payloadCodec)({ ...input, command: "injected" }).pipe(Effect.result))._tag).toBe("Failure");
    const responseCodec = Schema.toCodecJson(WorkbenchProgramStatus);
    const status = { run: f.data, running: false };
    const response = yield* Schema.encodeEffect(responseCodec)(status);
    expect(yield* Schema.decodeUnknownEffect(responseCodec)(response)).toEqual(status);
  }));
});
