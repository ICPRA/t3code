import { EnvironmentId, ProjectId, ProviderInstanceId, ProviderDriverKind, ThreadId, type OrchestrationThreadShell, type OrchestrationProjectShell, type ServerProvider } from "@t3tools/contracts";
import { afterEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Tool } from "effect/unstable/ai";
import * as MailClient from "@project-workbench/mail/client";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import { PrepareNodeRun, PrepareNodeRunInput, prepareNodeRun, DispatchPreparedRun, dispatchPreparedRun, executePreparedRun } from "./workbenchDispatch.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../orchestration/Services/ThreadDeletionReactor.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { ProjectCloneTracker } from "../project/ProjectCloneTracker.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { decodeDispatchTarget } from "../../../web/src/components/workbench/WorkbenchDispatch.logic.ts";

const invocation: McpInvocationScope = {
  environmentId: EnvironmentId.make("native-env"), threadId: ThreadId.make("parent"),
  providerSessionId: "session", providerInstanceId: ProviderInstanceId.make("codex"), capabilities: new Set(), issuedAt: 1,
};
const parent = { id: invocation.threadId, projectId: ProjectId.make("project"), runtimeMode: "full-access", archivedAt: null } as OrchestrationThreadShell;
const project = { id: parent.projectId, workspaceRoot: "C:/project" } as OrchestrationProjectShell;
const config = { executable: "fixture-only.exe", config: "fixture-only.yaml", token: "fixture", projects: { project: "spec-project" } };
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("chosen"), driver: ProviderDriverKind.make("claudeCode"), enabled: true, installed: true,
  version: "fixture", status: "ready", availability: "available", auth: { status: "authenticated" }, checkedAt: "2026-09-25T00:00:00.000Z",
  skills: [], slashCommands: [], models: [{ slug: "model", name: "Model", isCustom: false, capabilities: { optionDescriptors: [
    { id: "effort", type: "select", label: "Effort", options: [{ id: "high", label: "High", isDefault: true }, { id: "ultrathink", label: "Ultrathink" }], promptInjectedValues: ["ultrathink"] },
  ] } }],
};
const input = Schema.decodeUnknownSync(PrepareNodeRunInput)({ taskSlug: "task", requestKey: "original-key", title: "Scoped work",
  modelSelection: { instanceId: "chosen", model: "model", options: [{ id: "effort", value: "high" }] },
  assignmentRole: "executor", workPurpose: "investigation", workspace: { kind: "shared" },
});
const readHead = vi.fn<GitWorkflowService["Service"]["readHead"]>();
const listRefs = vi.fn<GitWorkflowService["Service"]["listRefs"]>();
const run = (value = input, selectedProvider = provider, currentParent: OrchestrationThreadShell | null = parent) => prepareNodeRun(config, value).pipe(
  Effect.provideService(McpInvocationContext, invocation),
  Effect.provide(Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({ getThreadShellById: () => Effect.succeed(Option.fromNullishOr(currentParent)), getProjectShellById: () => Effect.succeed(Option.some(project)) }),
    Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([selectedProvider]) }),
    Layer.mock(GitWorkflowService)({ readHead, listRefs }),
  )),
);
const stored = (target: unknown) => ({ project: "spec-project", context: { runId: "run", taskSlug: "task", packageId: "package", createdAt: "now",
  body: { workspace: (target as { workspace: string }).workspace, dispatch_target: target, task_slug: "task",
    bundle: { Version: 2, Spec: { Slug: "task", Role: "work", Intent: "Original bundle intent" }, Decisions: [], Dependencies: [] } } },
  dispatch: { admission: null, resolution: null, cancellation: null, stopConfirmation: null } });
function preparation() {
  let original: ReturnType<typeof stored> | undefined;
  const request = vi.spyOn(MailClient, "requestManagerDispatch").mockImplementation(async (_connection, _invocation, operation, payload) => {
    if (operation === "pm-read-preparation") return original ? { data: original } : { error: { code: "not_found" } };
    expect(operation).toBe("pm-prepare-run");
    original = stored(payload.dispatch_target);
    return { data: { binding_id: "run", generation: 1, replayed: false } };
  });
  readHead.mockReturnValue(Effect.succeed({ isRepo: true, commitSha: "a".repeat(40) }));
  return request;
}
afterEach(() => { readHead.mockReset(); listRefs.mockReset(); vi.restoreAllMocks(); });

describe("native manager preparation", () => {
  it.effect("accepts configured custom entries already present in the native catalog", () => Effect.gen(function* () {
    const request = preparation();
    const custom = { ...provider, models: [{ ...provider.models[0]!, slug: "configured-custom", isCustom: true }] };
    yield* run({ ...input, modelSelection: { ...input.modelSelection, model: "configured-custom" } }, custom);
    expect(request.mock.calls[1]![3].dispatch_target).toMatchObject({ modelSelection: { instanceId: "chosen", model: "configured-custom", options: input.modelSelection.options } });
  }));
  it.effect("freezes actual scope and permissions once, replays only matching intent, never starts a model", () => Effect.gen(function* () {
    const request = preparation();
    const receipt = yield* run();
    expect(receipt).toMatchObject({ project: "spec-project", runId: "run", taskSlug: "task", packageId: "package", prepared: true, replayed: false });
    const target = request.mock.calls[1]![3].dispatch_target;
    expect(target).toMatchObject({ environmentId: invocation.environmentId, projectId: project.id, runtimeMode: parent.runtimeMode,
      workspace: project.workspaceRoot, projectWorkspaceRoot: project.workspaceRoot, branch: null, worktreePath: null, modelSelection: input.modelSelection });
    expect(request.mock.calls.map((call) => call[2])).toEqual(["pm-read-preparation", "pm-prepare-run", "pm-read-preparation"]);
    expect((yield* run())).toEqual({ ...receipt, replayed: true });
    expect((yield* run({ ...input, title: "Changed scope" }).pipe(Effect.flip))).toMatchObject({ message: expect.stringContaining("conflicts") });
    expect((yield* run(input, provider, { ...parent, runtimeMode: "approval-required" }).pipe(Effect.flip))).toMatchObject({ message: expect.stringContaining("conflicts") });
    expect(readHead).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter((call) => call[2] === "pm-prepare-run")).toHaveLength(1);
    expect(Object.keys(Tool.getJsonSchema(PrepareNodeRun).properties ?? {})).toEqual(["taskSlug", "requestKey", "title", "modelSelection", "assignmentRole", "workPurpose", "qaBasis", "workspace", "expectedCommitSha"]);
  }));
  it.effect("preserves non-Git and unborn shared checkouts and checks fixed commits", () => Effect.gen(function* () {
    const request = preparation();
    readHead.mockReturnValue(Effect.succeed({ isRepo: false, commitSha: null }));
    yield* run();
    expect(request.mock.calls[1]![3].dispatch_target).toMatchObject({ gitBaseline: { isRepo: false, commitSha: null } });
    request.mockRestore();
    const unborn = preparation();
    readHead.mockReturnValue(Effect.succeed({ isRepo: true, commitSha: null }));
    yield* run();
    expect(unborn.mock.calls[1]![3].dispatch_target).toMatchObject({ gitBaseline: { isRepo: true, commitSha: null } });
    unborn.mockRestore();
    const fixed = preparation();
    expect((yield* run({ ...input, expectedCommitSha: "b".repeat(40) }).pipe(Effect.flip))).toMatchObject({ message: expect.stringContaining("fixed commit") });
    expect(fixed).toHaveBeenCalledTimes(1);
  }));
  it.effect("resolves existing worktrees through every native page, never trusts arbitrary paths", () => Effect.gen(function* () {
    const request = preparation();
    listRefs.mockReturnValueOnce(Effect.succeed({ refs: [], isRepo: true, hasPrimaryRemote: false, nextCursor: 10, totalCount: 11 }))
      .mockReturnValueOnce(Effect.succeed({ refs: [{ name: "work", worktreePath: "C:/worktree", current: false, isDefault: false }], isRepo: true, hasPrimaryRemote: false, nextCursor: null, totalCount: 11 }));
    yield* run({ ...input, workspace: { kind: "worktree", path: "C:/worktree", branch: "work" } });
    expect(listRefs.mock.calls[1]![0]).toMatchObject({ cwd: project.workspaceRoot, cursor: 10 });
    expect(readHead).toHaveBeenCalledWith({ cwd: "C:/worktree" });
    expect(request.mock.calls[1]![3].dispatch_target).toMatchObject({ workspace: "C:/worktree", worktreePath: "C:/worktree", branch: "work" });
    request.mockRestore();
    const rejected = preparation();
    listRefs.mockReturnValueOnce(Effect.succeed({ refs: [], isRepo: true, hasPrimaryRemote: false, nextCursor: null, totalCount: 0 }));
    expect((yield* run({ ...input, workspace: { kind: "worktree", path: "C:/other-project", branch: "work" } }).pipe(Effect.flip))).toMatchObject({ message: expect.stringContaining("do not belong") });
    expect(rejected).toHaveBeenCalledTimes(1);
  }));
  it.effect("uses native prompt-injected effort helpers and does not collapse changed effort into replay", () => Effect.gen(function* () {
    const request = preparation();
    const effort = { ...input, modelSelection: { ...input.modelSelection, options: [{ id: "effort", value: "ultrathink" }] } };
    yield* run(effort);
    expect(request.mock.calls[1]![3].dispatch_target).toMatchObject({ promptInjectedEffort: "ultrathink", promptPrefix: "Ultrathink:\n",
      modelSelection: { options: [{ id: "effort", value: "high" }] } });
    expect((yield* run(effort)).replayed).toBe(true);
    expect((yield* run(input).pipe(Effect.flip))).toMatchObject({ message: expect.stringContaining("conflicts") });
  }));
  it.effect("rejects missing authority, unavailable exact models, unsupported options and missing QA", () => Effect.gen(function* () {
    const request = preparation();
    expect((yield* run(input, provider, null).pipe(Effect.flip))).toMatchObject({ message: expect.stringContaining("active parent") });
    expect(request).not.toHaveBeenCalled();
    expect((yield* run(input, { ...provider, enabled: false }).pipe(Effect.flip))).toMatchObject({ message: expect.stringContaining("exact provider") });
    expect((yield* run(input, { ...provider, models: [] }).pipe(Effect.flip))).toMatchObject({ message: expect.stringContaining("exact provider-reported model") });
    expect((yield* run({ ...input, modelSelection: { ...input.modelSelection, options: [{ id: "effort", value: "invented" }] } }).pipe(Effect.flip))).toMatchObject({ message: expect.stringContaining("unsupported") });
    expect((yield* run({ ...input, workPurpose: "implementation" }).pipe(Effect.flip))).toMatchObject({ message: expect.stringContaining("QA basis") });
    expect(request.mock.calls.every((call) => call[2] === "pm-read-preparation")).toBe(true);
    expect(readHead).not.toHaveBeenCalled();
  }));
  it.effect("retains requestKey after uncertain writes and surfaces concurrent conflicts without another attempt", () => Effect.gen(function* () {
    const request = preparation().mockResolvedValueOnce({ error: { code: "not_found" } }).mockRejectedValueOnce(new Error("sensitive transport detail"));
    expect((yield* run().pipe(Effect.flip))).toMatchObject({ message: expect.stringContaining(input.requestKey) });
    expect(request).toHaveBeenCalledTimes(2);
    request.mockRestore();
    const conflict = preparation().mockResolvedValueOnce({ error: { code: "not_found" } }).mockResolvedValueOnce({ error: { code: "conflict" } });
    expect((yield* run().pipe(Effect.flip))).toMatchObject({ message: expect.stringContaining("conflict") });
    expect(conflict).toHaveBeenCalledTimes(2);
  }));
});

const originalTarget = () => decodeDispatchTarget({
  version: 1, promptFormatVersion: "vacpms-run-v2", environmentId: invocation.environmentId, projectId: project.id,
  projectWorkspaceRoot: project.workspaceRoot, workspace: project.workspaceRoot, branch: null, worktreePath: null,
  threadId: "original-child", createCommandId: "original-create", startCommandId: "original-start", messageId: "original-message",
  title: input.title, modelSelection: input.modelSelection, runtimeMode: parent.runtimeMode, interactionMode: "default",
  createdAt: "2026-09-25T00:00:00.000Z", gitBaseline: { isRepo: true, commitSha: "a".repeat(40) },
  assignmentRole: "executor", roleGuidance: "Recorded role\n", workPurpose: "investigation", purposeGuidance: "Recorded purpose\n",
  retrievalGuidance: "Recorded retrieval\n", promptInjectedEffort: null, promptPrefix: "",
});

function dispatchFixture(target = originalTarget()) {
  const steps: string[] = [];
  const state = { child: null as OrchestrationThreadShell | null, failCreate: false, failStart: false, afterAuthorize: () => {} };
  const original = { ...stored(target), dispatch: { admission: null as { id: string; actor: string } | null, resolution: null, cancellation: null as { actor: string; note: string; cancelledAt: string } | null, stopConfirmation: null } };
  const request = vi.spyOn(MailClient, "requestManagerDispatch").mockImplementation(async (_connection, _invocation, operation) => {
    steps.push(operation);
    if (operation === "pm-read-preparation") return { data: structuredClone(original) };
    if (operation === "pm-bind-run") return { data: { bound: true } };
    expect(operation).toBe("pm-authorize-run");
    original.dispatch.admission = { id: "admission", actor: "bound-manager" };
    state.afterAuthorize();
    return { data: { ...original.dispatch.admission, runId: "run", taskSlug: "task", packageId: "package", authorizedAt: "now", replayed: false } };
  });
  const engine = vi.fn<OrchestrationEngineService["Service"]["dispatch"]>((command) => Effect.gen(function* () {
    steps.push(command.type);
    if ((command.type === "thread.create" && state.failCreate) || (command.type === "thread.turn.start" && state.failStart)) {
      return yield* new OrchestrationCommandInvariantError({ commandType: command.type, detail: "fixture failure" });
    }
    if (command.type === "thread.create" && state.child === null) state.child = { ...parent, id: target.threadId,
      branch: target.branch, worktreePath: target.worktreePath, modelSelection: target.modelSelection, runtimeMode: target.runtimeMode, interactionMode: target.interactionMode };
    return { sequence: 10 };
  }));
  const clone = vi.fn<ProjectCloneTracker["Service"]["get"]>(() => Effect.sync(() => { steps.push("clone"); return null; }));
  const layers = Layer.mergeAll(
      Layer.mock(ProjectionSnapshotQuery)({ getThreadShellById: (id) => Effect.sync(() => Option.fromNullishOr(id === invocation.threadId ? parent : state.child)), getProjectShellById: () => Effect.succeed(Option.some(project)) }),
      Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
      Layer.mock(GitWorkflowService)({ readHead, listRefs }),
      Layer.mock(OrchestrationEngineService)({ dispatch: engine }),
      Layer.mock(ProjectCloneTracker)({ get: clone }),
      Layer.mock(ServerRuntimeStartup)({ enqueueCommand: (effect) => Effect.sync(() => { steps.push("enqueue"); }).pipe(Effect.andThen(effect)) }),
      Layer.mock(ThreadDeletionReactor)({ drainThrough: (sequence) => Effect.sync(() => { expect(sequence).toBe(10); steps.push("drain"); }) }),
  );
  const dispatch = () => dispatchPreparedRun(config, { runId: "run" }).pipe(
    Effect.provideService(McpInvocationContext, invocation),
    Effect.provide(layers),
  );
  return { target, original, state, steps, request, engine, clone, dispatch, layers };
}

describe("native prepared run dispatch with mocked owners", () => {
  it.effect("runs the common segment through supplied authority without an MCP invocation", () => Effect.gen(function* () {
    const fixture = dispatchFixture();
    const readPreparation = vi.fn(() => Effect.sync(() => structuredClone(fixture.original)));
    const readNativeContext = vi.fn(() => Effect.succeed({ environmentId: invocation.environmentId, runtimeMode: parent.runtimeMode, project }));
    const beforeStartDispatch = vi.fn(() => { expect(fixture.steps.at(-1)).toBe("enqueue"); });
    const bindRun = vi.fn((threadId: string, environmentId: EnvironmentId) => Effect.sync(() => {
      expect(threadId).toBe(fixture.target.threadId);
      expect(environmentId).toBe(fixture.target.environmentId);
      return { bound: true };
    }));
    const authorizeRun = vi.fn((packageId: string, target: ReturnType<typeof originalTarget>) => Effect.sync(() => {
      expect(packageId).toBe("package");
      expect(target).toEqual(fixture.target);
      fixture.original.dispatch.admission = { id: "admission", actor: "recorded-authority" };
      return { ...fixture.original.dispatch.admission, runId: "run", taskSlug: "task", packageId, authorizedAt: "now", replayed: false };
    }));
    expect(yield* executePreparedRun({ runId: "run", configuredProject: "spec-project", readPreparation, bindRun, authorizeRun, readNativeContext, beforeStartDispatch }).pipe(Effect.provide(fixture.layers)))
      .toEqual({ project: "spec-project", runId: "run", taskSlug: "task", threadId: fixture.target.threadId, commandAccepted: true });
    expect(readPreparation).toHaveBeenCalledTimes(2);
    expect(readNativeContext).toHaveBeenCalledTimes(2);
    expect(bindRun).toHaveBeenCalledTimes(1);
    expect(authorizeRun).toHaveBeenCalledTimes(1);
    expect(beforeStartDispatch).toHaveBeenCalledTimes(1);
    expect(fixture.engine.mock.calls.map(([command]) => command.commandId)).toEqual(["original-create", "original-start"]);
    expect(fixture.request).not.toHaveBeenCalled();
  }));
  it.effect("runs the original create-bind-authorize-start chain and preserves the recorded prompt bundle", () => Effect.gen(function* () {
    const fixture = dispatchFixture();
    expect(yield* fixture.dispatch()).toEqual({ project: "spec-project", runId: "run", taskSlug: "task", threadId: fixture.target.threadId, commandAccepted: true });
    expect(fixture.steps).toEqual(["pm-read-preparation", "clone", "enqueue", "thread.create", "drain", "pm-bind-run", "pm-authorize-run", "pm-read-preparation", "clone", "enqueue", "thread.turn.start"]);
    const create = fixture.engine.mock.calls[0]![0];
    const start = fixture.engine.mock.calls[1]![0];
    expect(create).toMatchObject({ commandId: fixture.target.createCommandId, createdAt: fixture.target.createdAt, threadId: fixture.target.threadId });
    expect(start).toMatchObject({ commandId: fixture.target.startCommandId, createdAt: fixture.target.createdAt, message: { messageId: fixture.target.messageId, text: expect.stringContaining("Original bundle intent") } });
    expect(start).not.toHaveProperty("bootstrap");
    expect(fixture.engine.mock.calls.every((call) => call.length === 1)).toBe(true);
    expect(Object.keys(Tool.getJsonSchema(DispatchPreparedRun).properties ?? {})).toEqual(["runId"]);
    expect(readHead).not.toHaveBeenCalled();
  }));
  it.effect("rejects closed, malformed and mismatched originals before native creation", () => Effect.gen(function* () {
    const closed = dispatchFixture();
    closed.original.dispatch.cancellation = { actor: "operator", note: "cancelled", cancelledAt: "now" };
    expect((yield* closed.dispatch().pipe(Effect.flip)).message).toContain("closed");
    expect(closed.engine).not.toHaveBeenCalled();
    closed.request.mockRestore();
    const malformed = dispatchFixture();
    malformed.original.context.body.bundle.Version = 1;
    expect((yield* malformed.dispatch().pipe(Effect.flip)).message).toContain("prompt cannot be reconstructed");
    expect(malformed.engine).not.toHaveBeenCalled();
    malformed.request.mockRestore();
    const mismatch = dispatchFixture({ ...originalTarget(), environmentId: EnvironmentId.make("foreign") });
    expect((yield* mismatch.dispatch().pipe(Effect.flip)).message).toContain("parent project");
    expect(mismatch.engine).not.toHaveBeenCalled();
  }));
  it.effect("does not overwrite child model or interaction changes or start a deleted child after authorization", () => Effect.gen(function* () {
    for (const changed of ["model", "mode", "deleted"]) {
      const fixture = dispatchFixture();
      fixture.state.afterAuthorize = () => { fixture.state.child = changed === "deleted" ? null : changed === "mode"
        ? { ...fixture.state.child!, interactionMode: "plan" }
        : { ...fixture.state.child!, modelSelection: { ...fixture.target.modelSelection, model: "manually-changed" } }; };
      expect((yield* fixture.dispatch().pipe(Effect.flip)).message).toContain(changed === "deleted" ? "unavailable or deleted" : "child identity");
      expect(fixture.engine).toHaveBeenCalledTimes(1);
      fixture.request.mockRestore();
    }
  }));
  it.effect("reuses original native IDs and timestamps after an ambiguous start without preparing another run", () => Effect.gen(function* () {
    const fixture = dispatchFixture();
    fixture.state.failStart = true;
    const error = yield* fixture.dispatch().pipe(Effect.flip);
    expect(error.message).toContain("thread.turn.start outcome is unconfirmed");
    expect(error.message).toContain("runId run");
    fixture.state.failStart = false;
    expect((yield* fixture.dispatch()).commandAccepted).toBe(true);
    expect(fixture.engine.mock.calls.map((call) => call[0].commandId)).toEqual(["original-create", "original-start", "original-create", "original-start"]);
    expect(fixture.engine.mock.calls[1]![0]).toEqual(fixture.engine.mock.calls[3]![0]);
    expect(fixture.request.mock.calls.some((call) => call[2] === "pm-prepare-run")).toBe(false);
  }));
  it.effect("stops the chain after failed native create, binding or authorization receipts", () => Effect.gen(function* () {
    const create = dispatchFixture();
    create.state.failCreate = true;
    expect((yield* create.dispatch().pipe(Effect.flip)).message).toContain("thread.create outcome");
    expect(create.request).toHaveBeenCalledTimes(1);
    create.request.mockRestore();
    const bind = dispatchFixture();
    bind.request.mockResolvedValueOnce({ data: structuredClone(bind.original) }).mockResolvedValueOnce({ data: { bound: false } });
    expect((yield* bind.dispatch().pipe(Effect.flip)).message).toContain("binding receipt");
    expect(bind.request).toHaveBeenCalledTimes(2);
    expect(bind.engine).toHaveBeenCalledTimes(1);
    bind.request.mockRestore();
    const authorize = dispatchFixture();
    authorize.request.mockResolvedValueOnce({ data: structuredClone(authorize.original) }).mockResolvedValueOnce({ data: { bound: true } }).mockResolvedValueOnce({ error: { code: "conflict" } });
    expect((yield* authorize.dispatch().pipe(Effect.flip)).message).toContain("conflict");
    expect(authorize.request).toHaveBeenCalledTimes(3);
    expect(authorize.engine).toHaveBeenCalledTimes(1);
  }));
  it.effect("requires test execution HEAD to remain at the saved fixed commit before start", () => Effect.gen(function* () {
    const target = { ...originalTarget(), workPurpose: "test_execution" as const, qaBasis: { requirementDecisionIds: [], designDecisionIds: [], designSources: [],
      testPlanSources: [{ kind: "git" as const, environmentId: "native-env", repositoryRoot: "C:/project", commitSha: "a".repeat(40), path: "test-plan.md" }], applicability: "Assigned tests" } };
    const fixture = dispatchFixture(target);
    readHead.mockReturnValueOnce(Effect.succeed({ isRepo: true, commitSha: "b".repeat(40) }));
    expect((yield* fixture.dispatch().pipe(Effect.flip)).message).toContain("recorded fixed commit");
    expect(fixture.engine).toHaveBeenCalledTimes(1);
    readHead.mockReturnValueOnce(Effect.succeed({ isRepo: true, commitSha: "a".repeat(40) }));
    expect((yield* fixture.dispatch()).commandAccepted).toBe(true);
    expect(fixture.engine.mock.calls.at(-1)![0]).toMatchObject({ type: "thread.turn.start" });
  }));
});
