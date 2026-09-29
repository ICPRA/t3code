import { CommandId, EnvironmentId, ProjectId, ProviderInstanceId, ProviderDriverKind, ThreadId, type OrchestrationThreadShell, type OrchestrationProjectShell, type OrchestrationShellSnapshot, type ServerProvider } from "@t3tools/contracts";
import { afterEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as MailClient from "@project-workbench/mail/client";
import { DeliveryHook } from "@project-workbench/mail/tools";
import * as Schema from "effect/Schema";
import { consumeDeliveryHook, pollDeliveryHooks, type DeliveryHookPollState } from "./workbenchDeliveryHooks.ts";
import { ServerEnvironment } from "./environment/ServerEnvironment.ts";
import { GitWorkflowService } from "./git/GitWorkflowService.ts";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepository, type OrchestrationCommandReceipt } from "./persistence/Services/OrchestrationCommandReceipts.ts";
import { PersistenceSqlError } from "./persistence/Errors.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationCommandInvariantError } from "./orchestration/Errors.ts";
import { ThreadDeletionReactor } from "./orchestration/Services/ThreadDeletionReactor.ts";
import { ProjectCloneTracker } from "./project/ProjectCloneTracker.ts";
import { ServerRuntimeStartup } from "./serverRuntimeStartup.ts";
import { decodeDispatchTarget } from "../../web/src/components/workbench/WorkbenchDispatch.logic.ts";
import { WorkbenchProgramRuns } from "./workbenchProgramRuns.ts";

const scope = { environmentId: EnvironmentId.make("environment"), nativeProjectId: ProjectId.make("project") };
const config = { executable: "fixture.exe", config: "fixture.yaml", token: "fixture-token", projects: {} };
const now = "2026-09-27T00:00:00.000Z";
const project = { id: scope.nativeProjectId, workspaceRoot: "C:/fixture" } as OrchestrationProjectShell;
const parent = { id: ThreadId.make("manager-thread"), projectId: project.id, runtimeMode: "full-access", archivedAt: null } as OrchestrationThreadShell;
const provider: ServerProvider = { instanceId: ProviderInstanceId.make("chosen"), driver: ProviderDriverKind.make("codex"), enabled: true, installed: true,
  version: "fixture", status: "ready", availability: "available", auth: { status: "authenticated" }, checkedAt: now,
  skills: [], slashCommands: [], models: [{ slug: "model", name: "Model", isCustom: false, capabilities: null }] };
const target = decodeDispatchTarget({ version: 1, promptFormatVersion: "vacpms-run-v2", environmentId: scope.environmentId, projectId: project.id,
  projectWorkspaceRoot: project.workspaceRoot, workspace: project.workspaceRoot, branch: null, worktreePath: null,
  threadId: "child", createCommandId: "create", startCommandId: "start", messageId: "message", title: "Fixed tests",
  modelSelection: { instanceId: "chosen", model: "model" }, runtimeMode: "full-access", interactionMode: "default", createdAt: now,
  gitBaseline: { isRepo: true, commitSha: "a".repeat(40) }, assignmentRole: "executor", roleGuidance: "Recorded role\n",
  workPurpose: "test_execution", purposeGuidance: "Recorded purpose\n", retrievalGuidance: "Recorded retrieval\n", promptInjectedEffort: null, promptPrefix: "",
  qaBasis: { requirementDecisionIds: [], designDecisionIds: [], designSources: [], testPlanSources: [{ kind: "git", environmentId: scope.environmentId, repositoryRoot: project.workspaceRoot, commitSha: "a".repeat(40), path: "plan.md" }], applicability: "Assigned tests" },
});
function fixture(state: "pending" | "unconfirmed" = "pending", human = false) {
  const hook = Schema.decodeUnknownSync(DeliveryHook)({ id: "hook", project: "spec-project", sourceRunId: "implementation", targetRunId: "test", targetPackageId: "package",
    commitSha: "a".repeat(40), configuredByRunId: human ? null : "manager", configuredByUserId: "user", hostConsumerUserId: "service-user", createdAt: now, deliveryId: "delivery", triggeredAt: now,
    cancelledAt: null, cancelledByRunId: null, cancelledByUserId: null, cancellationReason: null,
    retriedAt: null, retriedByRunId: null, retriedByUserId: null,
    dispatchStatus: state === "unconfirmed" ? state : null, dispatchPhase: null, dispatchDetail: null, dispatchRecordedAt: null, state });
  const data = { hook, context: { runId: "test", taskSlug: "tests", packageId: "package", createdAt: now, body: { workspace: target.workspace, dispatch_target: target,
    task_slug: "tests", bundle: { Version: 2, Spec: { Slug: "tests", Role: "work", Intent: "Test exact delivery" }, Decisions: [], Dependencies: [] } } },
    dispatch: { admission: null as unknown, cancellation: null, resolution: null, stopConfirmation: null },
    parent: human ? null : { runId: "manager", threadId: parent.id, environmentId: scope.environmentId, projectId: project.id },
    readinessError: null as null | { code: string; message: string } };
  const receipts = new Map<string, OrchestrationCommandReceipt>();
  const receipt = (commandId: string, status: "accepted" | "rejected") => ({ commandId: CommandId.make(commandId), aggregateKind: "thread" as const,
    aggregateId: target.threadId, acceptedAt: now, resultSequence: 1, status, error: status === "rejected" ? "Native rejection" : null });
  const request = vi.spyOn(MailClient, "requestHostDeliveryHook").mockImplementation(async (_connection, _scope, operation, payload) => {
    if (operation === "host-list-delivery-hooks") return { data: { hooks: [data.hook], nextCursor: "next-page" } };
    if (operation === "host-authorize-delivery-hook") data.dispatch.admission = { id: "admission", runId: "test", taskSlug: "tests", packageId: "package", actor: "user", authorizedAt: now, replayed: false };
    if (operation === "host-result-delivery-hook") return { data: { ...data.hook, state: payload.status, dispatchStatus: payload.status, dispatchPhase: payload.phase ?? null, dispatchDetail: payload.detail, dispatchRecordedAt: now } };
    return { data: structuredClone(data) };
  });
  const hookRequest = vi.spyOn(MailClient, "requestHostHook").mockImplementation(async () => ({ data: { hooks: [{ kind: "delivery_test", deliveryTest: data.hook }], nextCursor: "next-page" } }));
  const programStart = vi.fn<WorkbenchProgramRuns["Service"]["startFromHook"]>(() => Effect.succeed({
    run: { context: { runId: "program", taskSlug: "program-task", packageId: "program-package", body: {}, createdAt: now }, executorKind: "program", state: "prepared", dispatch: { admission: null, resolution: null, cancellation: null, stopConfirmation: null }, result: null, replayed: false }, running: false,
  }));
  const programResume = vi.fn<WorkbenchProgramRuns["Service"]["resumeLoop"]>(() => Effect.succeed({
    run: { context: { runId: "loop", taskSlug: "loop-task", packageId: "loop-package", body: {}, createdAt: now }, executorKind: "program", state: "waiting", dispatch: { admission: null, resolution: null, cancellation: null, stopConfirmation: null }, result: null, replayed: false }, running: false,
  }));
  let child: OrchestrationThreadShell | null = null;
  const native = { reject: null as null | "create" | "start", ambiguousStart: false };
  const engine = vi.fn<OrchestrationEngineService["Service"]["dispatch"]>((command) => Effect.gen(function* () {
    const phase = command.type === "thread.create" ? "create" : "start";
    if (native.ambiguousStart && phase === "start") return yield* new OrchestrationCommandInvariantError({ commandType: command.type, detail: "No receipt" });
    receipts.set(command.commandId, receipt(command.commandId, native.reject === phase ? "rejected" : "accepted"));
    if (native.reject === phase) return yield* new OrchestrationCommandInvariantError({ commandType: command.type, detail: "Native rejection" });
    if (phase === "create") child = { ...parent, id: target.threadId, branch: null, worktreePath: null, modelSelection: target.modelSelection, interactionMode: target.interactionMode };
    return { sequence: 1 };
  }));
  const lookup = vi.fn<OrchestrationCommandReceiptRepository["Service"]["getByCommandId"]>(({ commandId }) => Effect.sync(() => Option.fromNullishOr(receipts.get(commandId))));
  const readHead = vi.fn<GitWorkflowService["Service"]["readHead"]>(() => Effect.succeed({ isRepo: true, commitSha: "a".repeat(40) }));
  const snapshot = { snapshotSequence: 0, projects: [project], threads: [], updatedAt: now } satisfies OrchestrationShellSnapshot;
  const threadLookup = vi.fn<ProjectionSnapshotQuery["Service"]["getThreadShellById"]>((id) => Effect.sync(() => Option.fromNullishOr(id === parent.id ? parent : child)));
  const layers = Layer.mergeAll(
    Layer.mock(WorkbenchProgramRuns)({ startFromHook: programStart, resumeLoop: programResume }),
    Layer.mock(ProjectionSnapshotQuery)({ getThreadShellById: threadLookup,
      getProjectShellById: () => Effect.succeed(Option.some(project)), getShellSnapshot: () => Effect.succeed(snapshot) }),
    Layer.mock(OrchestrationCommandReceiptRepository)({ getByCommandId: lookup }),
    Layer.mock(OrchestrationEngineService)({ dispatch: engine }),
    Layer.mock(GitWorkflowService)({ readHead }), Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
    Layer.mock(ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(ServerRuntimeStartup)({ enqueueCommand: (effect) => effect }),
    Layer.mock(ThreadDeletionReactor)({ drainThrough: () => Effect.void }),
    Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(scope.environmentId) }),
  );
  return { data, request, hookRequest, programStart, programResume, native, engine, receipts, receipt, lookup, readHead, layers, snapshot, threadLookup,
    run: () => consumeDeliveryHook(config, scope, data.hook).pipe(Effect.provide(layers)) };
}
afterEach(() => vi.restoreAllMocks());

describe("host delivery hook consumption with mocked native owners", () => {
  it.effect("consumes a human-authorized fixed target without fabricating or reading a PM parent", () => Effect.gen(function* () {
    const f = fixture("pending", true);
    yield* f.run();
    expect(f.data.parent).toBeNull();
    expect(f.data.hook.configuredByRunId).toBeNull();
    expect(f.data.hook.hostConsumerUserId).toBe("service-user");
    expect(f.threadLookup.mock.calls.map(([id]) => id)).toEqual([target.threadId, target.threadId]);
    expect(f.engine.mock.calls.map(([command]) => command.commandId)).toEqual(["create", "start"]);
    expect(f.engine.mock.calls[0]![0]).toMatchObject({ runtimeMode: target.runtimeMode });
    expect(f.request.mock.calls.at(-1)![3]).toMatchObject({ status: "commandAccepted", phase: "start" });
  }));
  it.effect("uses the recorded grant and original native IDs without MCP identity", () => Effect.gen(function* () {
    const f = fixture();
    yield* f.run();
    expect(f.engine.mock.calls.map(([command]) => command.commandId)).toEqual(["create", "start"]);
    expect(f.request.mock.calls.every(([, context]) => context === scope)).toBe(true);
    expect(f.request.mock.calls.find(([, , operation]) => operation === "host-bind-delivery-hook")![3]).toEqual({ hookId: "hook" });
    expect(f.request.mock.calls.at(-1)![3]).toMatchObject({ hookId: "hook", status: "commandAccepted", phase: "start" });
    expect(f.readHead).toHaveBeenCalledWith({ cwd: target.workspace });
  }));
  it.effect("reconciles accepted history even after the configuring PM retires", () => Effect.gen(function* () {
    const f = fixture("unconfirmed");
    f.data.readinessError = { code: "forbidden", message: "Manager retired" };
    f.receipts.set("start", f.receipt("start", "accepted"));
    yield* f.run();
    expect(f.engine).not.toHaveBeenCalled();
    expect(f.request.mock.calls.at(-1)![3]).toMatchObject({ status: "commandAccepted", phase: "start" });
  }));
  it.effect("does not redispatch an unconfirmed hook without a native receipt", () => Effect.gen(function* () {
    const f = fixture("unconfirmed");
    yield* f.run();
    expect(f.engine).not.toHaveBeenCalled();
    expect(f.request.mock.calls.map(([, , operation]) => operation)).toEqual(["host-read-delivery-hook"]);
  }));
  it.effect("records readiness or fixed-HEAD guards as blocked without starting a model", () => Effect.gen(function* () {
    const f = fixture();
    f.data.readinessError = { code: "forbidden", message: "Manager retired" };
    yield* f.run();
    expect(f.engine).not.toHaveBeenCalled();
    expect(f.request.mock.calls.at(-1)![3]).toMatchObject({ status: "blocked" });
    f.data.readinessError = null;
    f.readHead.mockReturnValue(Effect.succeed({ isRepo: true, commitSha: "b".repeat(40) }));
    yield* f.run();
    expect(f.engine.mock.calls.map(([command]) => command.type)).toEqual(["thread.create"]);
    expect(f.request.mock.calls.at(-1)![3]).toMatchObject({ status: "blocked" });
  }));
  it.effect("keeps native rejection phases distinct from actual start uncertainty", () => Effect.gen(function* () {
    for (const phase of ["create", "start"] as const) {
      const f = fixture(); f.native.reject = phase;
      yield* f.run();
      expect(f.request.mock.calls.at(-1)![3]).toMatchObject({ status: "rejected", phase });
      f.request.mockRestore();
    }
    const f = fixture(); f.native.ambiguousStart = true;
    yield* f.run();
    expect(f.request.mock.calls.at(-1)![3]).toMatchObject({ status: "unconfirmed" });
  }));
  it.effect("does not start after receipt lookup failure or mismatched native identity", () => Effect.gen(function* () {
    const f = fixture();
    f.lookup.mockReturnValue(Effect.fail(new PersistenceSqlError({ operation: "fixture receipt read" })));
    yield* f.run();
    expect(f.request.mock.calls.at(-1)![3]).toMatchObject({ status: "unconfirmed" });
    expect(f.engine).not.toHaveBeenCalled();
    f.lookup.mockImplementation(({ commandId }) => Effect.succeed(Option.fromNullishOr(f.receipts.get(commandId))));
    f.receipts.set("start", { ...f.receipt("start", "accepted"), aggregateId: ThreadId.make("wrong-thread") });
    yield* f.run();
    expect(f.engine).not.toHaveBeenCalled();
    expect(f.request.mock.calls.at(-1)![3]).toMatchObject({ status: "unconfirmed" });
  }));
  it.effect("surfaces failed result persistence rather than claiming accepted success", () => Effect.gen(function* () {
    const f = fixture("unconfirmed");
    f.receipts.set("start", f.receipt("start", "accepted"));
    f.request.mockImplementation(async (_connection, _scope, operation) => {
      if (operation === "host-result-delivery-hook") throw new Error("private transport cause");
      return { data: structuredClone(f.data) };
    });
    expect((yield* f.run().pipe(Effect.flip)).message).toContain("unconfirmed");
    expect(f.engine).not.toHaveBeenCalled();
  }));
  it.effect("polls real host identity and reports persistent polling errors only on transitions", () => Effect.gen(function* () {
    const f = fixture("unconfirmed"); const state: DeliveryHookPollState = { nextProject: 0, error: undefined, projects: new Map() };
    const messages: string[] = [];
    const logger = Logger.make(({ message }) => { messages.push(String(message)); });
    const layers = Layer.merge(f.layers, Logger.layer([logger], { mergeWithExisting: false }));
    const successfulRequest = f.hookRequest.getMockImplementation()!;
    f.hookRequest.mockResolvedValue({ error: { code: "not_found", message: "Project not found" } });
    yield* pollDeliveryHooks(config, state).pipe(Effect.provide(layers));
    yield* pollDeliveryHooks(config, state).pipe(Effect.provide(layers));
    expect(messages.filter((message) => message.includes("Delivery hook polling failed"))).toHaveLength(1);
    expect(state.projects.get(project.id)!.error).toContain("not_found");
    f.hookRequest.mockImplementation(successfulRequest);
    yield* pollDeliveryHooks(config, state).pipe(Effect.provide(layers));
    expect(f.hookRequest.mock.calls[0]).toEqual([{ ...config, project: undefined }, scope, "host-list-hooks", { limit: 20, cursor: "" }, expect.any(AbortSignal)]);
    expect(state.projects.get(project.id)!.cursor).toBe("next-page");
    expect(state.projects.get(project.id)!.error).toBeUndefined();
    expect(messages.filter((message) => message.includes("Delivery hook polling recovered"))).toHaveLength(1);
    expect(f.engine).not.toHaveBeenCalled();
  }));
  it.effect("shares the twenty-hook budget across a four-project round-robin pass", () => Effect.gen(function* () {
    const f = fixture("unconfirmed"); const state: DeliveryHookPollState = { nextProject: 0, error: undefined, projects: new Map() };
    for (let index = 1; index < 5; index++) f.snapshot.projects.push({ ...project, id: ProjectId.make(`project-${index}`) });
    const programHook = { id: "program-hook", project: "spec-project", sourceTaskSlug: "source", sourceSpecId: "source-id", sourceRole: "work", targetRunId: "program", targetPackageId: "program-package", configuredByUserId: "human", hostConsumerUserId: "service-user", createdAt: now, fact: { kind: "execution", id: "source-fact" }, triggeredAt: now, cancelledAt: null, cancelledByUserId: null, cancellationReason: null, state: "pending", dispatchStatus: null, dispatchDetail: null, dispatchRecordedAt: null, retriedAt: null, retriedByUserId: null, admission: null };
    f.hookRequest.mockImplementation(async (_connection, context) => ({ data: { hooks: context.nativeProjectId === project.id
      ? Array.from({ length: 20 }, (_, index) => index % 3 === 0
        ? { kind: "delivery_test", deliveryTest: { ...f.data.hook, id: `hook-${index}` } }
        : index % 3 === 1 ? { kind: "completion_program", completionProgram: { ...programHook, id: `hook-${index}` } }
          : { kind: "program_loop", programLoop: { project: "loop-spec-project", runId: `loop-${index}` } }) : [], nextCursor: "" } }));
    f.request.mockImplementation(async (_connection, _context, _operation, payload) => {
      return { data: { ...f.data, hook: { ...f.data.hook, id: payload.hookId } } };
    });
    yield* pollDeliveryHooks(config, state).pipe(Effect.provide(f.layers));
    expect(f.hookRequest.mock.calls).toHaveLength(1);
    expect(f.request.mock.calls.filter(([, , operation]) => operation === "host-read-delivery-hook")).toHaveLength(7);
    expect(f.programStart).toHaveBeenCalledTimes(7);
    expect(f.programResume).toHaveBeenCalledTimes(6);
    expect(f.programResume.mock.calls[0]).toEqual([{ project: "loop-spec-project", nativeProjectId: project.id, runId: "loop-2" }]);
    expect(f.programStart.mock.calls[0]).toEqual([{ project: "spec-project", nativeProjectId: project.id, runId: "program" }, "hook-1"]);
    expect(state.nextProject).toBe(1);
    yield* pollDeliveryHooks(config, state).pipe(Effect.provide(f.layers));
    expect(f.hookRequest.mock.calls.map(([, context]) => context.nativeProjectId))
      .toEqual(["project", "project-1", "project-2", "project-3", "project-4"]);
    expect(state.nextProject).toBe(0);
    expect(f.engine).not.toHaveBeenCalled();
  }));
});
