import { requestHostDeliveryHook, requestHostHook, type HostDeliveryHookOperation, type MailConnection } from "@project-workbench/mail/client";
import { loadMailConfig, type MailConfig } from "@project-workbench/mail/config";
import { DeliveryHook, MailToolError } from "@project-workbench/mail/tools";
import { CommandId, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { decodeDispatchTarget, type DispatchTarget } from "../../web/src/components/workbench/WorkbenchDispatch.logic.ts";
import { ServerEnvironment } from "./environment/ServerEnvironment.ts";
import { executePreparedRun } from "./mcp/workbenchDispatch.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepository } from "./persistence/Services/OrchestrationCommandReceipts.ts";
import { forkParked } from "./serverActivation.ts";
import { ServerRuntimeStartup } from "./serverRuntimeStartup.ts";
import { CompletionProgramHook, WorkbenchProgramRuns } from "./workbenchProgramRuns.ts";

const Text = Schema.NonEmptyString;
const HostHooks = Schema.Struct({
  hooks: Schema.Array(Schema.Union([
    Schema.Struct({ kind: Schema.Literal("delivery_test"), deliveryTest: DeliveryHook }),
    Schema.Struct({ kind: Schema.Literal("completion_program"), completionProgram: CompletionProgramHook }),
    Schema.Struct({ kind: Schema.Literal("program_loop"), programLoop: Schema.Struct({ runId: Text, project: Text }) }),
  ])),
  nextCursor: Schema.String,
});
const HostHook = Schema.Struct({
  hook: DeliveryHook,
  context: Schema.Struct({ runId: Text, taskSlug: Text, packageId: Text, body: Schema.Record(Schema.String, Schema.Unknown), createdAt: Text }),
  dispatch: Schema.Struct({ admission: Schema.Unknown, resolution: Schema.Unknown, cancellation: Schema.Unknown, stopConfirmation: Schema.Unknown }),
  parent: Schema.NullOr(Schema.Struct({ runId: Text, environmentId: EnvironmentId, threadId: ThreadId, projectId: ProjectId })),
  readinessError: Schema.NullOr(Schema.Struct({ code: Text, message: Text })),
});
type HostScope = { readonly environmentId: EnvironmentId; readonly nativeProjectId: ProjectId };
type DispatchResult = "commandAccepted" | "rejected" | "unconfirmed" | "blocked";

export const consumeDeliveryHook = (connection: MailConnection, scope: HostScope, hook: typeof DeliveryHook.Type) => Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery;
  const receipts = yield* OrchestrationCommandReceiptRepository;
  let original: typeof HostHook.Type | undefined;
  let target: DispatchTarget | undefined;
  let targetVerified = false;
  let startMayHaveBeenSubmitted = false;
  let uncertain = false;
  const invoke = (operation: HostDeliveryHookOperation, payload: Readonly<Record<string, unknown>>) => Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) => requestHostDeliveryHook(connection, scope, operation, payload, signal),
      catch: () => { uncertain = true; return new MailToolError({ message: "Delivery hook transport outcome is unconfirmed" }); },
    });
    if (response.error) return yield* new MailToolError({ message: `Delivery hook operation rejected (${response.error.code})` });
    return response.data;
  });
  const read = (operation: "host-read-delivery-hook" | "host-bind-delivery-hook" | "host-authorize-delivery-hook" = "host-read-delivery-hook") => Effect.gen(function* () {
    const raw = yield* invoke(operation, { hookId: hook.id });
    const record = yield* Schema.decodeUnknownEffect(HostHook)(raw).pipe(Effect.mapError(() => {
      uncertain = true;
      return new MailToolError({ message: "Invalid delivery hook host response" });
    }));
    if (record.hook.id !== hook.id || record.hook.project !== hook.project || record.context.runId !== hook.targetRunId ||
      record.context.packageId !== hook.targetPackageId || record.hook.configuredByRunId !== hook.configuredByRunId ||
      record.hook.hostConsumerUserId !== hook.hostConsumerUserId ||
      (record.parent === null ? hook.configuredByRunId !== null : record.parent.runId !== hook.configuredByRunId ||
        record.parent.environmentId !== scope.environmentId || record.parent.projectId !== scope.nativeProjectId)) {
      uncertain = true;
      return yield* new MailToolError({ message: "Delivery hook host identity mismatch" });
    }
    return record;
  });
  const recordResult = (status: DispatchResult, detail: string, phase?: "create" | "start") => Effect.gen(function* () {
    const raw = yield* invoke("host-result-delivery-hook", { hookId: hook.id, status, detail, ...(phase === undefined ? {} : { phase }) });
    const receipt = yield* Schema.decodeUnknownEffect(DeliveryHook)(raw).pipe(Effect.mapError(() => new MailToolError({ message: "Delivery hook result persistence is unconfirmed" })));
    if (receipt.id !== hook.id || receipt.dispatchStatus !== status || (phase !== undefined && receipt.dispatchPhase !== phase)) return yield* new MailToolError({ message: "Delivery hook result receipt mismatch; persistence is unconfirmed" });
  });
  const nativeReceipt = () => Effect.gen(function* () {
    if (target === undefined || !targetVerified) return undefined;
    for (const commandId of [target.startCommandId, target.createCommandId]) {
      const receipt = yield* receipts.getByCommandId({ commandId: CommandId.make(commandId) }).pipe(Effect.mapError(() => {
        uncertain = true;
        return new MailToolError({ message: "Delivery hook native receipt lookup failed" });
      }));
      if (Option.isNone(receipt)) continue;
      if (receipt.value.aggregateKind !== "thread" || receipt.value.aggregateId !== target.threadId) {
        uncertain = true;
        return yield* new MailToolError({ message: "Delivery hook native receipt identity mismatch" });
      }
      if (receipt.value.status === "rejected") return { status: "rejected", phase: commandId === target.startCommandId ? "start" : "create" } as const;
      if (commandId === target.startCommandId) return { status: "commandAccepted", phase: "start" } as const;
    }
    return undefined;
  });
  const ready = (record: typeof HostHook.Type) => record.readinessError === null
    ? Effect.void : Effect.fail(new MailToolError({ message: record.readinessError.message }));

  const outcome = yield* Effect.gen(function* () {
    original = yield* read();
    target = yield* Effect.try({ try: () => decodeDispatchTarget(original!.context.body.dispatch_target), catch: () => {
      uncertain = true;
      return new MailToolError({ message: "Invalid fixed delivery hook target" });
    } });
    if (target.environmentId !== scope.environmentId || target.projectId !== scope.nativeProjectId ||
      target.workPurpose !== "test_execution" || target.gitBaseline?.commitSha?.toLowerCase() !== hook.commitSha.toLowerCase()) {
      return yield* new MailToolError({ message: "Delivery hook does not match its fixed test target" });
    }
    targetVerified = true;
    const existing = yield* nativeReceipt();
    if (existing) return { ...existing, detail: "Original native command receipt reconciled" };
    if (original.hook.state !== "pending") return undefined;
    yield* ready(original);
    yield* executePreparedRun({
      runId: hook.targetRunId, configuredProject: hook.project,
      readPreparation: () => read().pipe(Effect.tap(ready), Effect.map((record) => ({ project: record.hook.project, context: record.context, dispatch: record.dispatch }))),
      bindRun: () => read("host-bind-delivery-hook").pipe(Effect.tap(ready), Effect.as({ bound: true })),
      authorizeRun: () => read("host-authorize-delivery-hook").pipe(Effect.tap(ready), Effect.map((record) => record.dispatch.admission)),
      readNativeContext: () => Effect.gen(function* () {
        const project = yield* snapshots.getProjectShellById(scope.nativeProjectId).pipe(Effect.mapError(() => new MailToolError({ message: "Delivery hook project lookup failed" })));
        if (Option.isNone(project)) return yield* new MailToolError({ message: "Delivery hook requires its original native project" });
        if (original!.parent === null) return { environmentId: scope.environmentId, runtimeMode: target!.runtimeMode, project: project.value };
        const parent = yield* snapshots.getThreadShellById(original!.parent.threadId).pipe(Effect.mapError(() => new MailToolError({ message: "Delivery hook parent lookup failed" })));
        if (Option.isNone(parent) || parent.value.archivedAt !== null || parent.value.projectId !== scope.nativeProjectId) {
          return yield* new MailToolError({ message: "Delivery hook requires its original active parent project" });
        }
        return { environmentId: scope.environmentId, runtimeMode: parent.value.runtimeMode, project: project.value };
      }),
      beforeStartDispatch: () => { startMayHaveBeenSubmitted = true; },
    });
    return { status: "commandAccepted", phase: "start", detail: "Original start command accepted" } as const;
  }).pipe(Effect.result);
  if (outcome._tag === "Success") {
    if (outcome.success !== undefined) yield* recordResult(outcome.success.status, outcome.success.detail, outcome.success.phase);
    return;
  }
  const observed = yield* nativeReceipt().pipe(Effect.result);
  const receipt = observed._tag === "Success" ? observed.success : undefined;
  const status = receipt?.status ?? (uncertain || startMayHaveBeenSubmitted || !targetVerified ? "unconfirmed" : "blocked");
  yield* recordResult(status, outcome.failure.message, receipt?.phase);
});

export type DeliveryHookPollState = {
  nextProject: number;
  error: string | undefined;
  projects: Map<string, { cursor: string; error: string | undefined; hookErrors: Map<string, string>; unseenErrors: Set<string> }>;
};

const logPollingTransition = (previous: string | undefined, current: string | undefined, context: { projectId?: string; hookId?: string }) =>
  current === previous ? Effect.void : current === undefined
    ? Effect.logInfo("Delivery hook polling recovered", context)
    : Effect.logError("Delivery hook polling failed", { ...context, message: current });

export const pollDeliveryHooks = (config: MailConfig, state: DeliveryHookPollState) => Effect.gen(function* () {
  const result = yield* Effect.gen(function* () {
    const snapshots = yield* ProjectionSnapshotQuery;
    const programs = yield* WorkbenchProgramRuns;
    const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
    const snapshot = yield* snapshots.getShellSnapshot();
    for (const key of state.projects.keys()) if (!snapshot.projects.some((project) => project.id === key)) state.projects.delete(key);
    let remainingHooks = 20;
    // ponytail: four projects and twenty hooks per pass; larger projects wait for a later round.
    for (let visited = 0; visited < Math.min(4, snapshot.projects.length) && remainingHooks > 0; visited++) {
      const project = snapshot.projects[state.nextProject % snapshot.projects.length]!;
      state.nextProject = (state.nextProject + 1) % snapshot.projects.length;
      let projectState = state.projects.get(project.id);
      if (projectState === undefined) {
        projectState = { cursor: "", error: undefined, hookErrors: new Map(), unseenErrors: new Set() };
        state.projects.set(project.id, projectState);
      }
      const current = projectState;
      if (current.cursor === "") current.unseenErrors = new Set(current.hookErrors.keys());
      const connection = { ...config, project: Object.hasOwn(config.projects, project.id) ? config.projects[project.id] : undefined };
      const scope = { environmentId, nativeProjectId: project.id };
      const projectResult = yield* Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: (signal) => requestHostHook(connection, scope, "host-list-hooks", { limit: remainingHooks, cursor: current.cursor }, signal),
          catch: () => new MailToolError({ message: "Delivery hook listing failed" }),
        });
        if (response.error) return yield* new MailToolError({ message: `Delivery hook listing rejected (${response.error.code})` });
        const page = yield* Schema.decodeUnknownEffect(HostHooks)(response.data).pipe(Effect.mapError(() => new MailToolError({ message: "Invalid host hook listing" })));
        if (page.hooks.length > remainingHooks) return yield* new MailToolError({ message: "Delivery hook listing exceeds the requested batch" });
        for (const item of page.hooks) {
          const hookId = item.kind === "program_loop" ? `program_loop:${item.programLoop.runId}` : item.kind === "delivery_test" ? item.deliveryTest.id : item.completionProgram.id;
          remainingHooks--;
          current.unseenErrors.delete(hookId);
          const consumed = yield* item.kind === "delivery_test"
            ? consumeDeliveryHook(connection, scope, item.deliveryTest).pipe(Effect.result)
            : item.kind === "completion_program"
              ? programs.startFromHook({ project: item.completionProgram.project, nativeProjectId: project.id, runId: item.completionProgram.targetRunId }, item.completionProgram.id).pipe(Effect.asVoid, Effect.result)
              : programs.resumeLoop({ project: item.programLoop.project, nativeProjectId: project.id, runId: item.programLoop.runId }).pipe(Effect.asVoid, Effect.result);
          const error = consumed._tag === "Failure" ? consumed.failure.message : undefined;
          yield* logPollingTransition(current.hookErrors.get(hookId), error, { projectId: project.id, hookId });
          if (error === undefined) current.hookErrors.delete(hookId);
          else current.hookErrors.set(hookId, error);
        }
        current.cursor = page.nextCursor;
        if (page.nextCursor === "") {
          for (const hookId of current.unseenErrors) current.hookErrors.delete(hookId);
          current.unseenErrors.clear();
        }
      }).pipe(Effect.result);
      const error = projectResult._tag === "Failure" ? projectResult.failure.message : undefined;
      yield* logPollingTransition(current.error, error, { projectId: project.id });
      current.error = error;
    }
  }).pipe(Effect.result);
  const error = result._tag === "Failure" ? result.failure.message : undefined;
  yield* logPollingTransition(state.error, error, {});
  state.error = error;
});

export const startDeliveryHooks = Effect.gen(function* () {
  const config = loadMailConfig(process.env.T3_WORKBENCH_MAIL_CONFIG);
  if (config === undefined) return;
  if (!("executable" in config)) return yield* Effect.logWarning("Delivery hook host consumption is unavailable with legacy HTTP mail configuration; local transport is required");
  const startup = yield* ServerRuntimeStartup;
  const state: DeliveryHookPollState = { nextProject: 0, error: undefined, projects: new Map() };
  yield* forkParked(startup.awaitCommandReady.pipe(Effect.andThen(Effect.forever(
    pollDeliveryHooks(config, state).pipe(
      Effect.andThen(Effect.sleep("15 seconds")),
    ),
  ))));
});
