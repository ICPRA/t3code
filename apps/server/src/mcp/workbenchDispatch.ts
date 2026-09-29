import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { requestManagerDispatch, type ManagerDispatchOperation } from "@project-workbench/mail/client";
import type { MailConfig } from "@project-workbench/mail/config";
import { MailToolError } from "@project-workbench/mail/tools";
import { ModelSelection, OrchestrationCommand, isProviderAvailable, type EnvironmentId, type OrchestrationThreadShell, type OrchestrationProjectShell } from "@t3tools/contracts";
import { buildExplicitProviderOptionSelectionsFromDescriptors, getProviderOptionDescriptors, resolvePromptInjectedEffort } from "@t3tools/shared/model";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Tool } from "effect/unstable/ai";
import { ASSIGNMENT_ROLES, ROLE_GUIDANCE, WORK_PURPOSES, PURPOSE_GUIDANCE, RETRIEVAL_GUIDANCE, RUN_PROMPT_FORMAT, QABasis, decodeDispatchTarget, decodeDispatchState, freezePromptPrefix, nativeDispatchInputs, qaBasisReady, type DispatchTarget } from "../../../web/src/components/workbench/WorkbenchDispatch.logic.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { McpInvocationContext } from "./McpInvocationContext.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../orchestration/Services/ThreadDeletionReactor.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { ProjectCloneTracker, rejectCommandsDuringClone } from "../project/ProjectCloneTracker.ts";
import { canonicalizeClientCommandTimestamps } from "../orchestration/Normalizer.ts";

const Text = Schema.NonEmptyString.check(Schema.isPattern(/\S/));
export const PrepareNodeRunInput = Schema.Struct({
  taskSlug: Text,
  requestKey: Text.check(Schema.isMaxLength(200)),
  title: Text.check(Schema.isMaxLength(160)),
  modelSelection: ModelSelection,
  assignmentRole: Schema.Literals(ASSIGNMENT_ROLES),
  workPurpose: Schema.Literals(WORK_PURPOSES),
  qaBasis: Schema.optionalKey(QABasis),
  workspace: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("shared") }),
    Schema.Struct({ kind: Schema.Literal("worktree"), path: Text, branch: Text }),
  ]),
  expectedCommitSha: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/))),
});

export const PrepareNodeRun = Tool.make("workbench_prepare_node_run", {
  description: "Prepare an eligible node run for the bound manager's own native project. First read workbench_read_node_owner for current human owner and pending handoff; neither mail ownership nor a human return authorizes restarting an old run. Returns a recorded preparation, not current startup authorization, and never creates or starts a native thread. Replay preserves the original baseline; eventual start must revalidate through original authorization and native checks, including human ownership. Keep requestKey stable for the same intent, including after uncertainty; changed arguments conflict. Select the exact provider instance and native catalog model/options, including configured custom entries present in that snapshot; device-local hidden/order preferences are not consulted. Workspace must explicitly be the shared checkout or an existing native worktree. Runtime permissions inherit the actual calling thread. No provider fallback, refresh, authentication, installation or budget control occurs.",
  parameters: PrepareNodeRunInput,
  success: Schema.Struct({ project: Text, runId: Text, taskSlug: Text, packageId: Text, threadId: Text, prepared: Schema.Literal(true), replayed: Schema.Boolean }),
  failure: MailToolError,
}).annotate(Tool.Readonly, false).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true).annotate(Tool.OpenWorld, false);

const Preparation = Schema.Struct({
  project: Text,
  context: Schema.Struct({ runId: Text, taskSlug: Text, packageId: Text, body: Schema.Record(Schema.String, Schema.Unknown), createdAt: Text }),
  dispatch: Schema.Unknown,
});
const Prepared = Schema.Struct({ binding_id: Text, generation: Schema.Literal(1), replayed: Schema.Boolean });

const dispatchContext = (config: MailConfig) => Effect.gen(function* () {
  const invocation = yield* McpInvocationContext;
  const snapshots = yield* ProjectionSnapshotQuery;
  const parent = yield* snapshots.getThreadShellById(invocation.threadId).pipe(
    Effect.mapError(() => new MailToolError({ message: "Dispatch parent lookup failed" })),
  );
  if (Option.isNone(parent) || parent.value.archivedAt !== null) return yield* new MailToolError({ message: "Dispatch requires an active parent thread" });
  const nativeProject = yield* snapshots.getProjectShellById(parent.value.projectId).pipe(
    Effect.mapError(() => new MailToolError({ message: "Dispatch project lookup failed" })),
  );
  if (Option.isNone(nativeProject)) return yield* new MailToolError({ message: "Dispatch native project is unavailable" });
  const project = nativeProject.value;
  const configuredProject = Object.hasOwn(config.projects, project.id) ? config.projects[project.id] : undefined;
  const connection = { ...config, project: configuredProject };
  return { invocation, snapshots, parent: parent.value, project, configuredProject, connection };
});

const nativeModelSelection = (selection: ModelSelection, recordedEffort?: string | null) => Effect.gen(function* () {
  const registry = yield* ProviderRegistry;
  const providers = yield* registry.getProviders;
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  if (!provider || !provider.enabled || provider.status !== "ready" || !isProviderAvailable(provider)) return yield* new MailToolError({ message: "The exact provider instance is unavailable; no substitute selected" });
  const model = provider.models.find((entry) => entry.slug === selection.model);
  if (!model) return yield* new MailToolError({ message: "The exact provider-reported model is unavailable; no substitute selected" });
  const selections = selection.options;
  const descriptors = model.capabilities ? getProviderOptionDescriptors({ caps: model.capabilities }) : [];
  if (new Set(selections?.map((option) => option.id)).size !== (selections?.length ?? 0) || selections?.some((option) => !descriptors.some((descriptor) =>
    descriptor.id === option.id && (descriptor.type === "boolean" ? typeof option.value === "boolean" : descriptor.options.some((choice) => choice.id === option.value))))) {
    return yield* new MailToolError({ message: "Selected model options are unsupported or duplicated; unknown capabilities remain unknown" });
  }
  const injectedEfforts = model.capabilities ? (selections ?? []).flatMap((option) => {
    const descriptor = descriptors.find((entry) => entry.id === option.id)!;
    const effort = typeof option.value === "string" ? resolvePromptInjectedEffort({ optionDescriptors: [descriptor] }, option.value) : null;
    return effort ? [effort] : [];
  }) : [];
  if (injectedEfforts.length > 1) return yield* new MailToolError({ message: "Multiple prompt-injected options are not supported by the dispatch format" });
  if (recordedEffort && (!model.capabilities || resolvePromptInjectedEffort(model.capabilities, recordedEffort) !== recordedEffort)) return yield* new MailToolError({ message: "Original prompt-injected effort is unavailable" });
  const promptInjectedEffort = recordedEffort === undefined ? injectedEfforts[0] ?? null : recordedEffort;
  const options = model.capabilities ? buildExplicitProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({ caps: model.capabilities, selections }), selections,
  ) : undefined;
  const modelSelection = { instanceId: selection.instanceId, model: selection.model, ...(options ? { options } : {}) };
  return { modelSelection, promptInjectedEffort };
});

const nativeWorkspace = (workspaceRoot: string, selection: typeof PrepareNodeRunInput.Type.workspace) => Effect.gen(function* () {
  const git = yield* GitWorkflowService;
  let workspace = workspaceRoot;
  let branch: string | null = null;
  let worktreePath: string | null = null;
  if (selection.kind === "worktree") {
    const selected = selection;
    let cursor: number | undefined;
    do {
      const refs = yield* git.listRefs({ cwd: workspaceRoot, refKind: "local", refresh: true, ...(cursor === undefined ? {} : { cursor }) }).pipe(
        Effect.mapError(() => new MailToolError({ message: "Native worktree lookup failed" })),
      );
      const found = refs.refs.find((ref) => ref.name === selected.branch && ref.worktreePath !== null &&
        normalizeProjectPathForComparison(ref.worktreePath) === normalizeProjectPathForComparison(selected.path) &&
        normalizeProjectPathForComparison(ref.worktreePath) !== normalizeProjectPathForComparison(workspaceRoot));
      if (found) { workspace = found.worktreePath!; worktreePath = found.worktreePath; branch = found.name; break; }
      cursor = refs.nextCursor ?? undefined;
    } while (cursor !== undefined);
    if (worktreePath === null) return yield* new MailToolError({ message: "Selected worktree and branch do not belong to the actual native project" });
  }
  return { workspace, branch, worktreePath };
});

export const prepareNodeRun = (config: MailConfig, input: typeof PrepareNodeRunInput.Type) => Effect.gen(function* () {
  const { invocation, parent, project, configuredProject, connection } = yield* dispatchContext(config);
  const recovery = ` Preserve requestKey ${input.requestKey} and read/resume the original preparation; do not create a new attempt automatically.`;
  const invoke = (operation: ManagerDispatchOperation, payload: Readonly<Record<string, unknown>>) => Effect.tryPromise({
    try: (signal) => requestManagerDispatch(connection, invocation, operation, payload, signal),
    catch: () => new MailToolError({ message: "Dispatch transport outcome is unconfirmed." + recovery }),
  });
  // Read the original owner before generating any native identities or mutating preparation.
  const original = yield* invoke("pm-read-preparation", { idempotency_key: input.requestKey });
  if (original.error && original.error.code !== "not_found") return yield* new MailToolError({ message: `Preparation lookup rejected (${original.error.code}).` + recovery });
  if (!qaBasisReady(input.workPurpose, input.qaBasis)) return yield* new MailToolError({ message: "Applicable QA basis is required for this work purpose" });
  const { modelSelection, promptInjectedEffort } = yield* nativeModelSelection(input.modelSelection);
  const { workspace, branch, worktreePath } = yield* nativeWorkspace(project.workspaceRoot, input.workspace);
  const semanticTarget = {
    environmentId: invocation.environmentId, projectId: project.id, projectWorkspaceRoot: project.workspaceRoot,
    workspace, branch, worktreePath, title: input.title, modelSelection, runtimeMode: parent.runtimeMode,
    assignmentRole: input.assignmentRole, workPurpose: input.workPurpose,
    ...(input.qaBasis === undefined ? {} : { qaBasis: input.qaBasis }),
    promptInjectedEffort,
  };
  const readReceipt = (raw: unknown, replayed: boolean, expected?: DispatchTarget) => Effect.gen(function* () {
    const stored = yield* Schema.decodeUnknownEffect(Preparation)(raw).pipe(
      Effect.mapError(() => new MailToolError({ message: "Invalid original preparation." + recovery })),
    );
    return yield* Effect.try({ try: () => {
      const target = decodeDispatchTarget(stored.context.body.dispatch_target);
      const state = decodeDispatchState(stored.dispatch);
      if (state.cancellation || state.resolution || state.stopConfirmation) throw new Error("Original preparation has been closed");
      if (stored.context.taskSlug !== input.taskSlug || stored.context.body.workspace !== target.workspace ||
        (configuredProject !== undefined && stored.project !== configuredProject) ||
        !isDeepStrictEqual(target.qaBasis, input.qaBasis) ||
        Object.entries(semanticTarget).some(([key, value]) => !isDeepStrictEqual(target[key as keyof DispatchTarget], value)) ||
        (input.expectedCommitSha !== undefined && target.gitBaseline?.commitSha?.toLowerCase() !== input.expectedCommitSha.toLowerCase()) ||
        (expected !== undefined && !isDeepStrictEqual(target, expected))) throw new Error("Preparation conflicts with the requested native identity or semantic arguments");
      return { project: stored.project, runId: stored.context.runId, taskSlug: stored.context.taskSlug, packageId: stored.context.packageId, threadId: target.threadId, prepared: true as const, replayed };
    },
      catch: (cause) => new MailToolError({ message: (cause instanceof Error ? cause.message : "Invalid original preparation") + "." + recovery }),
    });
  });
  if (!original.error) return yield* readReceipt(original.data, true);

  const git = yield* GitWorkflowService;
  const baseline = yield* git.readHead({ cwd: workspace }).pipe(Effect.mapError(() => new MailToolError({ message: "Git baseline read failed; nothing prepared" })));
  if (input.expectedCommitSha !== undefined && baseline.commitSha?.toLowerCase() !== input.expectedCommitSha.toLowerCase()) return yield* new MailToolError({ message: "Selected workspace is not at the requested fixed commit; nothing prepared" });
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const target = yield* Effect.try({
    try: () => decodeDispatchTarget({
      ...semanticTarget, version: 1, promptFormatVersion: RUN_PROMPT_FORMAT, gitBaseline: baseline,
      threadId: randomUUID(), createCommandId: randomUUID(), startCommandId: randomUUID(), messageId: randomUUID(),
      createdAt, interactionMode: "default", promptPrefix: freezePromptPrefix(promptInjectedEffort),
      roleGuidance: ROLE_GUIDANCE[input.assignmentRole], purposeGuidance: PURPOSE_GUIDANCE[input.workPurpose], retrievalGuidance: RETRIEVAL_GUIDANCE,
    }),
    catch: () => new MailToolError({ message: "Native dispatch target could not be frozen; nothing prepared" }),
  });
  const prepared = yield* invoke("pm-prepare-run", { task_slug: input.taskSlug, workspace, idempotency_key: input.requestKey, dispatch_target: target });
  if (prepared.error) return yield* new MailToolError({ message: `Preparation rejected (${prepared.error.code}); no replacement attempt created.` + recovery });
  const receipt = yield* Schema.decodeUnknownEffect(Prepared)(prepared.data).pipe(
    Effect.mapError(() => new MailToolError({ message: "Invalid preparation receipt; outcome unconfirmed." + recovery })),
  );
  const read = yield* invoke("pm-read-preparation", { idempotency_key: input.requestKey });
  if (read.error) return yield* new MailToolError({ message: `Original preparation read failed (${read.error.code}); outcome unconfirmed.` + recovery });
  const result = yield* readReceipt(read.data, receipt.replayed, target);
  if (result.runId !== receipt.binding_id) return yield* new MailToolError({ message: "Preparation receipt identity mismatch; outcome unconfirmed." + recovery });
  return result;
});

export const DispatchPreparedRun = Tool.make("workbench_dispatch_prepared_run", {
  description: "Dispatch the original prepared run in the bound manager's own native project. Read workbench_read_node_owner first and respect any current human owner or pending take; a mail handoff is not node ownership return. Go's original authorization is the final gate. Creates its recorded native thread, binds and authorizes the original package, then submits its original start command. This can start a provider with tools. A human return does not restart an old run; provider availability is not budget approval. The receipt means command accepted, not running or completed. After any uncertain outcome keep the same runId; never create a replacement run or new command IDs automatically.",
  parameters: Schema.Struct({ runId: Text }),
  success: Schema.Struct({ project: Text, runId: Text, taskSlug: Text, threadId: Text, commandAccepted: Schema.Literal(true) }),
  failure: MailToolError,
}).annotate(Tool.Readonly, false).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true).annotate(Tool.OpenWorld, true);

const BoundRun = Schema.Struct({ bound: Schema.Literal(true) });
const AuthorizedRun = Schema.Struct({ id: Text, runId: Text, taskSlug: Text, packageId: Text, actor: Text, authorizedAt: Text, replayed: Schema.Boolean });

export const dispatchPreparedRun = (config: MailConfig, input: { readonly runId: string }) => Effect.gen(function* () {
  const initial = yield* dispatchContext(config);
  const recovery = ` Resume only original runId ${input.runId} with its recorded command IDs; do not create a replacement attempt.`;
  const invoke = (operation: ManagerDispatchOperation, payload: Readonly<Record<string, unknown>>) => Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: (signal) => requestManagerDispatch(initial.connection, initial.invocation, operation, payload, signal),
      catch: () => new MailToolError({ message: "Dispatch transport outcome is unconfirmed." + recovery }),
    });
    if (result.error) return yield* new MailToolError({ message: `Original run operation rejected (${result.error.code}).` + recovery });
    return result.data;
  });
  return yield* executePreparedRun({
    runId: input.runId,
    configuredProject: initial.configuredProject,
    readPreparation: () => invoke("pm-read-preparation", { runId: input.runId }),
    bindRun: (threadId, environmentId) => invoke("pm-bind-run", { runId: input.runId, thread_ref: threadId, environment_id: environmentId }),
    authorizeRun: (packageId, target) => invoke("pm-authorize-run", { runId: input.runId, packageId, target }),
    readNativeContext: () => dispatchContext(config).pipe(Effect.map(({ invocation, parent, project }) => ({ environmentId: invocation.environmentId, runtimeMode: parent.runtimeMode, project }))),
  });
});

// Callers supply their real authorization path; the shared native chain never creates an MCP identity.
export const executePreparedRun = <R>(input: {
  readonly runId: string;
  readonly configuredProject: string | undefined;
  readonly readPreparation: () => Effect.Effect<unknown, MailToolError, R>;
  readonly bindRun: (threadId: string, environmentId: EnvironmentId) => Effect.Effect<unknown, MailToolError, R>;
  readonly authorizeRun: (packageId: string, target: DispatchTarget) => Effect.Effect<unknown, MailToolError, R>;
  readonly readNativeContext: () => Effect.Effect<{ readonly environmentId: EnvironmentId; readonly runtimeMode: OrchestrationThreadShell["runtimeMode"]; readonly project: OrchestrationProjectShell }, MailToolError, R>;
  readonly beforeStartDispatch?: () => void;
}) => Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery;
  const recovery = ` Resume only original runId ${input.runId} with its recorded command IDs; do not create a replacement attempt.`;
  const read = () => input.readPreparation().pipe(Effect.flatMap((raw) =>
    Schema.decodeUnknownEffect(Preparation)(raw).pipe(Effect.mapError(() => new MailToolError({ message: "Invalid original run context." + recovery })))));
  const original = yield* read();
  const target = yield* Effect.try({ try: () => decodeDispatchTarget(original.context.body.dispatch_target), catch: () => new MailToolError({ message: "Invalid original dispatch target." + recovery }) });
  const checkRecord = (record: typeof Preparation.Type) => Effect.try({ try: () => {
    const state = decodeDispatchState(record.dispatch);
    if (record.context.runId !== input.runId || record.context.body.workspace !== target.workspace ||
      !isDeepStrictEqual(record.context, original.context) || record.project !== original.project ||
      (input.configuredProject !== undefined && record.project !== input.configuredProject)) throw new Error("Original run identity changed");
    if (state.cancellation || state.resolution || state.stopConfirmation) throw new Error("Original preparation is closed");
    if (!target.workPurpose || !target.assignmentRole || !qaBasisReady(target.workPurpose, target.qaBasis)) throw new Error("Original assignment or QA basis is missing");
    if (target.promptPrefix !== freezePromptPrefix(target.promptInjectedEffort)) throw new Error("Original prompt transformation is inconsistent");
    return state;
  }, catch: (cause) => new MailToolError({ message: (cause instanceof Error ? cause.message : "Invalid original preparation") + "." + recovery }) });
  yield* checkRecord(original);
  const checkNative = (requireChild: boolean) => Effect.gen(function* () {
    const current = yield* input.readNativeContext();
    if (target.environmentId !== current.environmentId || target.projectId !== current.project.id ||
      target.projectWorkspaceRoot !== current.project.workspaceRoot || target.runtimeMode !== current.runtimeMode) {
      return yield* new MailToolError({ message: "Original parent project, workspace root or runtime permissions changed." });
    }
    const workspace = yield* nativeWorkspace(current.project.workspaceRoot, target.worktreePath === null ? { kind: "shared" } : { kind: "worktree", path: target.worktreePath, branch: target.branch! });
    if (workspace.workspace !== target.workspace || workspace.branch !== target.branch || workspace.worktreePath !== target.worktreePath) return yield* new MailToolError({ message: "Original workspace identity changed." });
    const model = yield* nativeModelSelection(target.modelSelection, target.promptInjectedEffort);
    if (!isDeepStrictEqual(model.modelSelection, target.modelSelection)) return yield* new MailToolError({ message: "Original model options changed." });
    const child = yield* snapshots.getThreadShellById(target.threadId).pipe(Effect.mapError(() => new MailToolError({ message: "Original child lookup failed." })));
    if (Option.isNone(child)) {
      if (requireChild) return yield* new MailToolError({ message: "Original child is unavailable or deleted." });
    } else if (child.value.archivedAt !== null || child.value.projectId !== target.projectId || child.value.branch !== target.branch ||
      child.value.worktreePath !== target.worktreePath || child.value.runtimeMode !== target.runtimeMode || child.value.interactionMode !== target.interactionMode || !isDeepStrictEqual(child.value.modelSelection, target.modelSelection)) {
      return yield* new MailToolError({ message: "Original child identity, model, interaction mode or permissions changed." });
    }
  }).pipe(Effect.mapError((cause) => new MailToolError({ message: cause.message + recovery })));
  yield* checkNative(false);
  const commands = yield* Effect.try({ try: () => nativeDispatchInputs(original.project, original.context, target), catch: () => new MailToolError({ message: "Original run prompt cannot be reconstructed." + recovery }) });
  const create = yield* Schema.decodeUnknownEffect(OrchestrationCommand)(canonicalizeClientCommandTimestamps({ ...commands.create, type: "thread.create", commandId: target.createCommandId, createdAt: target.createdAt }, target.createdAt)).pipe(Effect.mapError(() => new MailToolError({ message: "Invalid original create command." + recovery })));
  const start = yield* Schema.decodeUnknownEffect(OrchestrationCommand)(canonicalizeClientCommandTimestamps({ ...commands.start, type: "thread.turn.start", commandId: target.startCommandId, createdAt: target.createdAt }, target.createdAt)).pipe(Effect.mapError(() => new MailToolError({ message: "Invalid original start command." + recovery })));
  const engine = yield* OrchestrationEngineService;
  const startup = yield* ServerRuntimeStartup;
  const deletions = yield* ThreadDeletionReactor;
  const clones = yield* ProjectCloneTracker;
  // Frozen commands have no uploads or bootstrap; preserve their original timestamps and IDs.
  const dispatch = (command: OrchestrationCommand) => Effect.gen(function* () {
    yield* rejectCommandsDuringClone(clones, create).pipe(Effect.mapError((cause) => new MailToolError({ message: cause.message + recovery })));
    return yield* startup.enqueueCommand(Effect.suspend(() => {
      if (command.type === "thread.turn.start") input.beforeStartDispatch?.();
      return engine.dispatch(command);
    }).pipe(
      Effect.tap(({ sequence }) => command.type === "thread.create" ? deletions.drainThrough(sequence) : Effect.void),
    )).pipe(Effect.mapError(() => new MailToolError({ message: `Native ${command.type} outcome is unconfirmed.` + recovery })));
  });
  yield* dispatch(create);
  const bound = yield* input.bindRun(target.threadId, target.environmentId);
  yield* Schema.decodeUnknownEffect(BoundRun)(bound).pipe(Effect.mapError(() => new MailToolError({ message: "Invalid binding receipt; outcome unconfirmed." + recovery })));
  const authorization = yield* input.authorizeRun(original.context.packageId, target);
  const receipt = yield* Schema.decodeUnknownEffect(AuthorizedRun)(authorization).pipe(Effect.mapError(() => new MailToolError({ message: "Invalid authorization receipt; outcome unconfirmed." + recovery })));
  if (receipt.runId !== input.runId || receipt.taskSlug !== original.context.taskSlug || receipt.packageId !== original.context.packageId) return yield* new MailToolError({ message: "Authorization identity mismatch." + recovery });
  const authorized = yield* read();
  const state = yield* checkRecord(authorized);
  if (state.admission?.id !== receipt.id || state.admission.actor !== receipt.actor) return yield* new MailToolError({ message: "Original run admission receipt does not match authorization." + recovery });
  yield* checkNative(true);
  if (target.workPurpose === "test_execution") {
    const git = yield* GitWorkflowService;
    const head = yield* git.readHead({ cwd: target.workspace }).pipe(Effect.mapError(() => new MailToolError({ message: "Test commit could not be verified." + recovery })));
    if (!target.gitBaseline?.commitSha || head.commitSha?.toLowerCase() !== target.gitBaseline.commitSha.toLowerCase()) return yield* new MailToolError({ message: "Test workspace moved from the recorded fixed commit; no checkout or baseline replacement performed." + recovery });
  }
  yield* dispatch(start);
  return { project: original.project, runId: input.runId, taskSlug: original.context.taskSlug, threadId: target.threadId, commandAccepted: true as const };
});
