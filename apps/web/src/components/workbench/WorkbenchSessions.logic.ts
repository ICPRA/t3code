import { normalizeProjectPathForComparison } from "@t3tools/client-runtime/state/projects";
import type { OrchestrationThreadActivity, OrchestrationLatestTurn, OrchestrationCheckpointSummary } from "@t3tools/contracts";
import { ConsultedRecord, ProjectId, ThreadId, MessageId, IsoDateTime, TurnTokenUsage } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

type ThreadIdentity = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "projectId" | "worktreePath"
>;
type ProjectIdentity = Pick<EnvironmentProject, "id" | "environmentId" | "workspaceRoot">;

export function workbenchTurnUsage(activities: readonly OrchestrationThreadActivity[]) {
  const result = new Map<string, typeof TurnTokenUsage.Type>();
  for (const activity of activities) {
    if (activity.kind !== "provider.turn.token-usage" || !activity.turnId) continue;
    const usage = Schema.decodeUnknownOption(TurnTokenUsage)(activity.payload);
    if (Option.isSome(usage)) result.set(activity.turnId, usage.value);
  }
  return result;
}

export function elapsedTurnMinutes(turn: OrchestrationLatestTurn, now: number): number | null {
  if (!turn.startedAt || (!turn.completedAt && turn.state !== "running")) return null;
  return Math.max(0, Math.floor(((turn.completedAt ? Date.parse(turn.completedAt) : now) - Date.parse(turn.startedAt)) / 60000));
}

export function loadedWorkbenchUsage(turnIds: readonly string[], usage: ReturnType<typeof workbenchTurnUsage>) {
  let input = 0, output = 0, inputReportedTurns = 0, outputReportedTurns = 0, completeTurns = 0;
  for (const id of turnIds) {
    const value = usage.get(id);
    if (!value) continue;
    if (value.inputTokens !== undefined) { input += value.inputTokens; inputReportedTurns += 1; }
    if (value.outputTokens !== undefined) { output += value.outputTokens; outputReportedTurns += 1; }
    if (value.usageStatus === "complete") completeTurns += 1;
  }
  return { turns: turnIds.length, inputTokens: inputReportedTurns ? input : null, outputTokens: outputReportedTurns ? output : null,
    inputReportedTurns, outputReportedTurns, completeTurns };
}

const ConsultedSource = Schema.Struct({
  projectId: ProjectId, threadId: ThreadId, messageId: MessageId,
  source: Schema.Literals(["user", "assistant"]), updatedAt: IsoDateTime,
  offset: Schema.Int, nextOffset: Schema.NullOr(Schema.Int),
});

function workbenchTurnOwners(
  siblingRuns: readonly { id: string; dispatchMessageId?: string }[],
  activities: readonly OrchestrationThreadActivity[]) {
  const requests = new Map<string, Set<string>>();
  for (const run of siblingRuns) {
    if (!run.dispatchMessageId) continue;
    const owners = requests.get(run.dispatchMessageId) ?? new Set<string>();
    owners.add(run.id); requests.set(run.dispatchMessageId, owners);
  }
  const turns = new Map<string, Set<string>>();
  for (const activity of activities) {
    const payload = activity.payload;
    if (activity.kind !== "provider.turn.request-linked" || !activity.turnId || !payload || typeof payload !== "object" || !("messageId" in payload) || typeof payload.messageId !== "string") continue;
    const owners = turns.get(activity.turnId) ?? new Set<string>();
    for (const id of requests.get(payload.messageId) ?? []) owners.add(id);
    turns.set(activity.turnId, owners);
  }
  return turns;
}

// Callers supply runs resolved to the same native environment/thread, not titles or timestamps.
export function ownedWorkbenchTurnIds(runId: string,
  siblingRuns: readonly { id: string; dispatchMessageId?: string }[],
  activities: readonly OrchestrationThreadActivity[]) {
  return [...workbenchTurnOwners(siblingRuns, activities)].filter(([, owners]) => owners.size === 1 && owners.has(runId)).map(([turnId]) => turnId);
}

export function linkedWorkbenchCompactions(runId: string,
  siblingRuns: readonly { id: string; dispatchMessageId?: string }[],
  activities: readonly OrchestrationThreadActivity[]) {
  const turnIds = new Set(ownedWorkbenchTurnIds(runId, siblingRuns, activities));
  return activities.filter((activity) => activity.kind === "context-compaction" && activity.turnId !== null && turnIds.has(activity.turnId));
}

export function linkedWorkbenchCheckpoints(runId: string,
  siblingRuns: readonly { id: string; dispatchMessageId?: string }[],
  activities: readonly OrchestrationThreadActivity[], checkpoints: readonly OrchestrationCheckpointSummary[]) {
  const owners = workbenchTurnOwners(siblingRuns, activities);
  return checkpoints.filter((checkpoint) => owners.get(checkpoint.turnId)?.size === 1 && owners.get(checkpoint.turnId)!.has(runId));
}

export function consultedWorkbenchSources(runId: string, projectId: string,
  siblingRuns: readonly { id: string; dispatchMessageId?: string }[],
  activities: readonly OrchestrationThreadActivity[]) {
  const turns = workbenchTurnOwners(siblingRuns, activities);
  const sources: Array<typeof ConsultedSource.Type & { eventId: string; turnId: string; readAt: string }> = [];
  let ambiguousCount = 0;
  for (const activity of activities) {
    const owners = activity.turnId ? turns.get(activity.turnId) : undefined;
    const payload = activity.payload;
    if (activity.kind !== "tool.completed" || !activity.turnId || !owners?.has(runId) || !payload || typeof payload !== "object" || !("consultedSource" in payload)) continue;
    const source = Schema.decodeUnknownOption(ConsultedSource)(payload.consultedSource);
    if (Option.isNone(source) || source.value.projectId !== projectId) continue;
    if (owners.size !== 1) { ambiguousCount += 1; continue; }
    sources.push({ ...source.value, eventId: activity.id, turnId: activity.turnId, readAt: activity.createdAt });
  }
  return { sources, ambiguousCount };
}

export function consultedWorkbenchRecords(runId: string, specgraphProject: string,
  thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId">,
  siblingRuns: readonly { id: string; dispatchMessageId?: string }[],
  activities: readonly OrchestrationThreadActivity[]) {
  const turns = workbenchTurnOwners(siblingRuns, activities);
  const records: Array<ConsultedRecord & { eventId: string; turnId: string; readAt: string }> = [];
  let ambiguousCount = 0;
  for (const activity of activities) {
    const payload = activity.payload;
    if (activity.kind !== "tool.completed" || !activity.turnId || !payload || typeof payload !== "object" || !("consultedRecord" in payload)) continue;
    const owners = turns.get(activity.turnId);
    if (!owners?.has(runId)) continue;
    const record = Schema.decodeUnknownOption(ConsultedRecord)(payload.consultedRecord);
    if (Option.isNone(record) || record.value.specgraphProject !== specgraphProject || record.value.nativeProjectId !== thread.projectId || record.value.environmentId !== thread.environmentId) continue;
    if (owners.size !== 1) { ambiguousCount += 1; continue; }
    records.push({ ...record.value, eventId: activity.id, turnId: activity.turnId, readAt: activity.createdAt });
  }
  return { records, ambiguousCount };
}

// Legacy bindings lack an environment id. Never resolve them by title or by
// decoding an undocumented string format; require one exact id + workspace.
export function matchWorkbenchRun<T extends ThreadIdentity>(
  run: { threadRef: string; workspace: string; environmentId?: string; executorKind?: "agent" | "program" },
  threads: readonly T[],
  projects: readonly ProjectIdentity[],
  snapshotsReady: boolean,
):
  | { kind: "matched"; thread: T }
  | { kind: "program" | "unbound" | "missing-workspace" | "unresolved" | "ambiguous" | "synchronizing" } {
  if (run.executorKind === "program") return { kind: "program" };
  if (!run.threadRef) return { kind: "unbound" };
  if (!run.workspace) return { kind: "missing-workspace" };
  if (!snapshotsReady) return { kind: "synchronizing" };
  const workspace = normalizeProjectPathForComparison(run.workspace);
  const matches = threads.filter((thread) => {
    if (thread.id !== run.threadRef) return false;
    if (run.environmentId && thread.environmentId !== run.environmentId) return false;
    const project = projects.find(
      (candidate) =>
        candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
    );
    if (!project) return false;
    return (
      normalizeProjectPathForComparison(thread.worktreePath ?? project.workspaceRoot) === workspace
    );
  });
  if (matches.length === 0) return { kind: "unresolved" };
  if (matches.length > 1) return { kind: "ambiguous" };
  return { kind: "matched", thread: matches[0]! };
}
