import { CommandId, EnvironmentId, IsoDateTime, MessageId, ModelSelection, ProjectId, RuntimeMode, ThreadId, WorkbenchRawPreparationHandoff } from "@t3tools/contracts";
import type { CreateThreadInput, StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import { ASSIGNMENT_ROLES, WORK_PURPOSES, buildRunPrompt, RUN_PROMPT_FORMAT, type WorkPurpose, type RecordedRunContext } from "@project-workbench/ui/dispatch";
import { applyClaudePromptEffortPrefix } from "@t3tools/shared/model";
import * as Schema from "effect/Schema";

export { ASSIGNMENT_ROLES, ROLE_GUIDANCE, WORK_PURPOSES, PURPOSE_GUIDANCE, RETRIEVAL_GUIDANCE, RUN_PROMPT_FORMAT } from "@project-workbench/ui/dispatch";

const ReferenceString = Schema.NonEmptyString.check(Schema.isPattern(/\S/));
const QASource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("specgraph"), specSlug: ReferenceString, field: ReferenceString, changeId: ReferenceString }),
  Schema.Struct({ kind: Schema.Literal("git"), environmentId: ReferenceString, repositoryRoot: ReferenceString, commitSha: ReferenceString, path: ReferenceString, entry: Schema.optionalKey(Schema.String) }),
]);
export const QABasis = Schema.Struct({
  requirementDecisionIds: Schema.Array(ReferenceString), designDecisionIds: Schema.Array(ReferenceString),
  designSources: Schema.Array(QASource), testPlanSources: Schema.Array(QASource),
  applicability: ReferenceString.check(Schema.isMaxLength(4000)),
});
export type QABasis = typeof QABasis.Type;

export function qaBasisReady(purpose: WorkPurpose | "", basis: QABasis | undefined): boolean {
  if (purpose !== "design" && purpose !== "test_design" && purpose !== "implementation" && purpose !== "test_execution") return true;
  if (!basis?.applicability.trim()) return false;
  if (purpose !== "test_execution" && !basis.requirementDecisionIds.some((id) => id.trim())) return false;
  if (purpose === "implementation" && !basis.designDecisionIds.some((id) => id.trim())) return false;
  const sources = purpose === "test_design" ? basis.designSources : purpose === "design" ? null : basis.testPlanSources;
  return sources === null || (sources.length > 0 && sources.every((source) => source.kind === "specgraph"
    ? !!source.specSlug.trim() && !!source.field.trim() && !!source.changeId.trim()
    : !!source.environmentId.trim() && !!source.repositoryRoot.trim() && !!source.commitSha.trim() && !!source.path.trim()));
}

// Persist the complete native identity before the first remote mutation.
export const DispatchTarget = Schema.Struct({
  version: Schema.Literal(1),
  promptFormatVersion: Schema.Literal(RUN_PROMPT_FORMAT),
  environmentId: EnvironmentId,
  projectId: ProjectId,
  workspace: Schema.NonEmptyString,
  projectWorkspaceRoot: Schema.optionalKey(Schema.NonEmptyString),
  gitBaseline: Schema.optionalKey(Schema.Struct({ isRepo: Schema.Boolean, commitSha: Schema.NullOr(Schema.NonEmptyString) })),
  threadId: ThreadId,
  createCommandId: CommandId,
  startCommandId: CommandId,
  messageId: MessageId,
  createdAt: IsoDateTime,
  title: Schema.NonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: Schema.Literal("default"),
  branch: Schema.NullOr(Schema.NonEmptyString),
  worktreePath: Schema.NullOr(Schema.NonEmptyString),
  promptInjectedEffort: Schema.NullOr(Schema.String),
  promptPrefix: Schema.Literals(["", "Ultrathink:\n"]),
  assignmentRole: Schema.optionalKey(Schema.Literals(ASSIGNMENT_ROLES)),
  roleGuidance: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(4000))),
  workPurpose: Schema.optionalKey(Schema.Literals(WORK_PURPOSES)),
  purposeGuidance: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(4000))),
  qaBasis: Schema.optionalKey(QABasis),
  retrievalGuidance: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4000))),
});
export type DispatchTarget = typeof DispatchTarget.Type;
const decodeTarget = Schema.decodeUnknownSync(DispatchTarget);
export function decodeDispatchTarget(input: unknown): DispatchTarget {
  const target = decodeTarget(input);
  if ((target.assignmentRole === undefined) !== (target.roleGuidance === undefined) || (target.roleGuidance !== undefined && !target.roleGuidance.trim())) {
    throw new Error("Recorded assignment role and guidance must be provided together");
  }
  if ((target.workPurpose === undefined) !== (target.purposeGuidance === undefined) || (target.purposeGuidance !== undefined && !target.purposeGuidance.trim())) {
    throw new Error("Recorded work purpose and guidance must be provided together");
  }
  if (target.worktreePath === null ? target.branch !== null : !target.projectWorkspaceRoot || target.workspace !== target.worktreePath) {
    throw new Error("Recorded workspace and worktree identity disagree");
  }
  return target;
}

export function dispatchTargetMatchesProject(target: DispatchTarget, project: { id: string; environmentId: string; workspaceRoot: string }) {
  return target.environmentId === project.environmentId && target.projectId === project.id &&
    (target.projectWorkspaceRoot ?? target.workspace) === project.workspaceRoot &&
    (target.worktreePath === null ? target.workspace === project.workspaceRoot : target.workspace === target.worktreePath);
}

export function freezePromptPrefix(effort: string | null): "" | "Ultrathink:\n" {
  const rendered = applyClaudePromptEffortPrefix("VACPMS", effort);
  if (rendered === "VACPMS") return "";
  if (rendered === "Ultrathink:\nVACPMS") return "Ultrathink:\n";
  throw new Error("Native prompt transformation changed; this dispatch format requires review");
}

export type PendingDispatch = { project: string; taskSlug: string; key: string; target: DispatchTarget; runId?: string; abortNote?: string };
export const DISPATCH_STORAGE_KEY = "workbench.manual-dispatch.v1";
export function readPendingDispatch(storage: Pick<Storage, "getItem">): PendingDispatch | null {
  const raw = storage.getItem(DISPATCH_STORAGE_KEY);
  if (!raw) return null;
  const value = JSON.parse(raw) as PendingDispatch;
  if (value.abortNote !== undefined && (typeof value.abortNote !== "string" || !value.abortNote.trim() || value.abortNote.length > 4000)) throw new Error("Invalid pending abort intent");
  if (new TextEncoder().encode(raw).length > 32768 || typeof value.project !== "string" || typeof value.taskSlug !== "string" || typeof value.key !== "string" || (value.runId !== undefined && typeof value.runId !== "string")) throw new Error("Invalid dispatch recovery record");
  return { ...value, target: decodeDispatchTarget(value.target) };
}
export function savePendingDispatch(storage: Pick<Storage, "getItem" | "setItem">, value: PendingDispatch) {
  const current = readPendingDispatch(storage);
  if (current?.abortNote !== undefined && current.abortNote !== value.abortNote) throw new Error("Pending abort intent cannot change");
  if (current && (current.project !== value.project || current.taskSlug !== value.taskSlug || current.key !== value.key || JSON.stringify(current.target) !== JSON.stringify(value.target))) throw new Error("Another dispatch request is still unresolved");
  const raw = JSON.stringify(value);
  if (new TextEncoder().encode(raw).length > 32768) throw new Error("Dispatch recovery record exceeds 32 KiB");
  storage.setItem(DISPATCH_STORAGE_KEY, raw);
}

const DispatchState = Schema.Struct({
  admission: Schema.NullOr(Schema.Struct({ id: Schema.NonEmptyString, actor: Schema.NonEmptyString })),
  resolution: Schema.NullOr(Schema.Struct({ actor: Schema.NonEmptyString, kind: Schema.Literals(["stopped_writing", "isolated_workspace"]), note: Schema.String, releasedAt: Schema.String })),
  cancellation: Schema.NullOr(Schema.Struct({ actor: Schema.NonEmptyString, note: Schema.String, cancelledAt: Schema.String,
    rawHandoff: Schema.optional(WorkbenchRawPreparationHandoff) })),
  stopConfirmation: Schema.NullOr(Schema.Struct({ actor: Schema.NonEmptyString, note: Schema.String, confirmedAt: Schema.String })),
});
export type DispatchState = typeof DispatchState.Type;
export const decodeDispatchState = Schema.decodeUnknownSync(DispatchState);

export function nativeDispatchInputs(project: string, context: RecordedRunContext, target: DispatchTarget) {
  if (!context.body || typeof context.body !== "object" || !("workspace" in context.body) || context.body.workspace !== target.workspace) throw new Error("Prepared workspace differs from native dispatch target");
  const common = {
    threadId: target.threadId,
    modelSelection: target.modelSelection,
    runtimeMode: target.runtimeMode,
    interactionMode: target.interactionMode,
    createdAt: target.createdAt,
  };
  const create: CreateThreadInput = {
    ...common, commandId: target.createCommandId, projectId: target.projectId,
    title: target.title, branch: target.branch, worktreePath: target.worktreePath,
  };
  const start: StartThreadTurnInput = {
    ...common, commandId: target.startCommandId, titleSeed: target.title,
    message: { messageId: target.messageId, role: "user", attachments: [],
      text: target.promptPrefix + (target.purposeGuidance ?? "") + (target.roleGuidance ?? "") + (target.retrievalGuidance ?? "") + buildRunPrompt(project, context, target.promptFormatVersion).trim() },
  };
  return { create, start };
}

export async function dispatchRecordedRun(input: {
  project: string;
  context: RecordedRunContext;
  target: DispatchTarget;
  checkCurrent: () => void;
  create: (input: CreateThreadInput) => Promise<void>;
  bind: () => Promise<void>;
  authorize: () => Promise<void>;
  start: (input: StartThreadTurnInput) => Promise<void>;
}) {
  const commands = nativeDispatchInputs(input.project, input.context, input.target);
  input.checkCurrent();
  await input.create(commands.create);
  input.checkCurrent();
  await input.bind();
  input.checkCurrent();
  await input.authorize();
  input.checkCurrent();
  await input.start(commands.start);
  input.checkCurrent();
}
