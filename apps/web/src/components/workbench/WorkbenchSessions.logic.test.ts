import { CheckpointRef, EnvironmentId, ProjectId, ThreadId, TurnId, EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { consultedWorkbenchRecords, consultedWorkbenchSources, elapsedTurnMinutes, loadedWorkbenchUsage, linkedWorkbenchCheckpoints, linkedWorkbenchCompactions, ownedWorkbenchTurnIds, matchWorkbenchRun, workbenchTurnUsage } from "./WorkbenchSessions.logic";

const envA = EnvironmentId.make("local-a");
const envB = EnvironmentId.make("local-b");
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("thread");
const thread = { id: threadId, environmentId: envA, projectId, worktreePath: null };
const project = { id: projectId, environmentId: envA, workspaceRoot: "C:\\work\\app" };
const run = { threadRef: "thread", workspace: "c:/work/app/" };

describe("workbench session identity", () => {
  it("keeps program execution separate from agent session matching", () => {
    expect(matchWorkbenchRun({ ...run, executorKind: "program", threadRef: "" }, [], [], false)).toEqual({ kind: "program" });
    expect(matchWorkbenchRun({ ...run, executorKind: "program" }, [thread], [project], true)).toEqual({ kind: "program" });
  });
  it("summarizes only loaded owned turns and keeps missing usage distinct from reported zero", () => {
    const complete = { usageStatus: "complete", usageScope: "main_agent", hasSubagents: false, inputTokens: 10, outputTokens: 3 };
    const activity: OrchestrationThreadActivity = { id: EventId.make("usage"), kind: "provider.turn.token-usage", tone: "info", summary: "Usage", turnId: TurnId.make("one"), createdAt: "2026-09-24T00:00:00Z", payload: complete };
    const usages = workbenchTurnUsage([activity, { ...activity, payload: { ...complete, inputTokens: 12 } },
      { ...activity, turnId: TurnId.make("two"), payload: { usageStatus: "partial", usageScope: "main_agent", hasSubagents: false, inputTokens: 0 } },
      { ...activity, turnId: TurnId.make("someone-else") }]);
    expect(loadedWorkbenchUsage(["one", "two", "missing"], usages)).toEqual({ turns: 3, inputTokens: 12, outputTokens: 3, inputReportedTurns: 2, outputReportedTurns: 1, completeTurns: 1 });
    expect(loadedWorkbenchUsage(["two"], usages)).toEqual({ turns: 1, inputTokens: 0, outputTokens: null, inputReportedTurns: 1, outputReportedTurns: 0, completeTurns: 0 });
    expect(loadedWorkbenchUsage(["missing"], usages)).toEqual({ turns: 1, inputTokens: null, outputTokens: null, inputReportedTurns: 0, outputReportedTurns: 0, completeTurns: 0 });
  });
  it("attributes source fragments through exact dispatch turns and refuses ambiguous run ownership", () => {
    const linked: OrchestrationThreadActivity = { id: EventId.make("link"), kind: "provider.turn.request-linked", tone: "info", summary: "Linked", turnId: TurnId.make("turn-a"), createdAt: "2026-09-23T00:00:00Z", payload: { messageId: "request-a" } };
    const read = { ...linked, id: EventId.make("read"), kind: "tool.completed", payload: { consultedSource: { projectId: "project", threadId: "source", messageId: "original", source: "assistant", updatedAt: "2026-09-23T00:00:00Z", offset: 0, nextOffset: 6000 } } };
    const siblings = [{ id: "run-a", dispatchMessageId: "request-a" }, { id: "run-b", dispatchMessageId: "request-b" }];
    const events = [linked, { ...linked, id: EventId.make("link-b"), turnId: TurnId.make("turn-b"), payload: { messageId: "request-b" } }, read];
    expect(consultedWorkbenchSources("run-a", "project", siblings, events).sources[0]?.messageId).toBe("original");
    expect(consultedWorkbenchSources("run-b", "project", siblings, events).sources).toEqual([]);
    expect(consultedWorkbenchSources("run-a", "other-project", siblings, events).sources).toEqual([]);
    expect(consultedWorkbenchSources("run-a", "project", siblings, [read]).sources).toEqual([]);
    expect(consultedWorkbenchSources("run-a", "project", [...siblings, { id: "duplicate", dispatchMessageId: "request-a" }], events)).toEqual({ sources: [], ambiguousCount: 1 });
    const checkpoint = { turnId: TurnId.make("turn-a"), checkpointTurnCount: 1, checkpointRef: CheckpointRef.make("native-checkpoint"), status: "ready" as const,
      files: [{ path: "src/existing.ts", kind: "modified", additions: 2, deletions: 1 }], assistantMessageId: null, completedAt: "2026-09-23T00:00:00Z" };
    expect(linkedWorkbenchCheckpoints("run-a", siblings, events, [checkpoint])).toEqual([checkpoint]);
    expect(linkedWorkbenchCheckpoints("run-b", siblings, events, [checkpoint])).toEqual([]);
    expect(linkedWorkbenchCheckpoints("run-a", [...siblings, { id: "duplicate", dispatchMessageId: "request-a" }], events, [checkpoint])).toEqual([]);
  });
  it("attributes knowledge receipts only to one run with matching native and SpecGraph scope", () => {
    const linked: OrchestrationThreadActivity = { id: EventId.make("link-record"), kind: "provider.turn.request-linked", tone: "info", summary: "Linked", turnId: TurnId.make("turn-a"), createdAt: "2026-09-23T00:00:00Z", payload: { messageId: "request-a" } };
    const metadata = { specgraphProject: "sg-project", nativeProjectId: "project", environmentId: "local-a", kind: "spec", id: "spec-id", slug: "spec-slug", version: 3, sourceRefs: { intent: "intent-ref" } };
    const read: OrchestrationThreadActivity = { ...linked, id: EventId.make("read-record"), kind: "tool.completed", payload: { consultedRecord: metadata } };
    const siblings = [{ id: "run-a", dispatchMessageId: "request-a" }, { id: "run-b", dispatchMessageId: "request-b" }];
    const activities = [linked, read];
    const result = consultedWorkbenchRecords("run-a", "sg-project", thread, siblings, activities);
    expect(result.records).toEqual([{ ...metadata, eventId: "read-record", turnId: "turn-a", readAt: linked.createdAt }]);
    expect(consultedWorkbenchRecords("run-b", "sg-project", thread, siblings, activities).records).toEqual([]);
    expect(consultedWorkbenchRecords("run-a", "other-sg", thread, siblings, activities).records).toEqual([]);
    expect(consultedWorkbenchRecords("run-a", "sg-project", { ...thread, environmentId: envB }, siblings, activities).records).toEqual([]);
    expect(consultedWorkbenchRecords("run-a", "sg-project", { ...thread, projectId: ProjectId.make("other-native") }, siblings, activities).records).toEqual([]);
    expect(consultedWorkbenchRecords("run-a", "sg-project", thread, siblings, [read]).records).toEqual([]);
    expect(consultedWorkbenchRecords("run-a", "sg-project", thread, [...siblings, { id: "duplicate", dispatchMessageId: "request-a" }], activities)).toEqual({ records: [], ambiguousCount: 1 });
    expect(consultedWorkbenchRecords("run-a", "sg-project", thread, siblings, [...activities,
      { ...linked, id: EventId.make("conflicting-link"), payload: { messageId: "request-b" } },
    ])).toEqual({ records: [], ambiguousCount: 1 });
    expect(consultedWorkbenchRecords("run-a", "sg-project", thread, siblings, [linked, { ...read, payload: { consultedRecord: { ...metadata, version: 3, record: "not metadata" } } }]).records[0]).not.toHaveProperty("record");
  });
  it("attributes compaction records and usage turns only to one proven run owner", () => {
    const linked: OrchestrationThreadActivity = { id: EventId.make("linked"), tone: "info", kind: "provider.turn.request-linked", summary: "Linked", payload: { messageId: "request-a" }, turnId: TurnId.make("turn-a"), createdAt: "2026-09-23T00:00:00Z" };
    const compacted = { ...linked, id: EventId.make("compacted"), kind: "context-compaction", payload: { state: "compacted" } };
    const activities = [linked, compacted, { ...compacted, id: EventId.make("unscoped"), turnId: null }, { ...compacted, id: EventId.make("other"), turnId: TurnId.make("other-turn") }, { ...compacted, id: EventId.make("usage"), kind: "context-window.updated" }];
    const runs = [{ id: "run-a", dispatchMessageId: "request-a" }, { id: "run-b", dispatchMessageId: "request-b" }];
    expect(ownedWorkbenchTurnIds("run-a", runs, activities)).toEqual(["turn-a"]);
    expect(linkedWorkbenchCompactions("run-a", runs, activities)).toEqual([compacted]);
    expect(linkedWorkbenchCompactions("run-b", runs, activities)).toEqual([]);
    const ambiguous = [...runs, { id: "duplicate", dispatchMessageId: "request-a" }];
    expect(ownedWorkbenchTurnIds("run-a", ambiguous, activities)).toEqual([]);
    expect(linkedWorkbenchCompactions("run-a", ambiguous, activities)).toEqual([]);
  });
  it("uses start to now or completion for elapsed minutes without inventing missing starts", () => {
    const turn = { turnId: TurnId.make("t"), state: "running" as const, requestedAt: "2026-09-23T00:00:00Z", startedAt: "2026-09-23T00:01:00Z", completedAt: null, assistantMessageId: null };
    expect(elapsedTurnMinutes(turn, Date.parse("2026-09-23T00:04:00Z"))).toBe(3);
    expect(elapsedTurnMinutes({ ...turn, state: "completed", completedAt: "2026-09-23T00:03:00Z" }, Date.now())).toBe(2);
    expect(elapsedTurnMinutes({ ...turn, startedAt: null }, Date.now())).toBeNull();
  });
  it("links only explicit request events and deduplicates observed turn identities", () => {
    const activity: OrchestrationThreadActivity = { id: EventId.make("e"), tone: "info", kind: "provider.turn.request-linked", summary: "Linked", payload: { messageId: "request-a" }, turnId: TurnId.make("turn-a"), createdAt: "2026-09-22T00:00:00Z" };
    expect(ownedWorkbenchTurnIds("run", [{ id: "run", dispatchMessageId: "request-a" }], [activity, activity, { ...activity, payload: { messageId: "other" }, turnId: TurnId.make("other") }, { ...activity, kind: "other" }, { ...activity, payload: null }, { ...activity, turnId: null }])).toEqual(["turn-a"]);
    expect(ownedWorkbenchTurnIds("run", [{ id: "run", dispatchMessageId: "unrecorded" }], [activity])).toEqual([]);
    const tokens = { usageStatus: "complete", usageScope: "main_agent", hasSubagents: false, inputTokens: 120, outputTokens: 30, cachedInputTokens: 40, reasoningTokens: 10 };
    const recorded = { ...activity, kind: "provider.turn.token-usage", payload: tokens };
    expect([...workbenchTurnUsage([recorded, recorded])]).toEqual([["turn-a", tokens]]);
    expect(workbenchTurnUsage([activity]).size).toBe(0);
  });
  it("uses the recorded environment without guessing from a thread-reference string", () => {
    const other = { ...thread, environmentId: envB };
    const projects = [project, { ...project, environmentId: envB }];
    expect(matchWorkbenchRun({ ...run, environmentId: envA }, [thread, other], projects, true)).toEqual({ kind: "matched", thread });
    expect(matchWorkbenchRun({ ...run, environmentId: envB }, [thread, other], projects, true)).toEqual({ kind: "matched", thread: other });
    expect(matchWorkbenchRun({ ...run, environmentId: "missing" }, [thread, other], projects, true).kind).toBe("unresolved");
    expect(matchWorkbenchRun({ ...run, environmentId: envA, workspace: "C:/wrong" }, [thread], projects, true).kind).toBe("unresolved");
  });
  it("matches an exact thread and Windows workspace, without using its binding state", () => {
    expect(matchWorkbenchRun(run, [thread], [project], true)).toEqual({ kind: "matched", thread });
  });

  it("does not confuse same project ids across environments or mismatched worktrees", () => {
    expect(matchWorkbenchRun(run, [thread], [{ ...project, environmentId: envB }], true).kind).toBe(
      "unresolved",
    );
    expect(
      matchWorkbenchRun(run, [{ ...thread, worktreePath: "C:\\other" }], [project], true).kind,
    ).toBe("unresolved");
    expect(
      matchWorkbenchRun(
        run,
        [{ ...thread, worktreePath: "c:/work/app" }],
        [{ ...project, workspaceRoot: "C:\\other" }],
        true,
      ).kind,
    ).toBe("matched");
  });

  it("refuses ambiguous, unbound and undocumented references", () => {
    expect(
      matchWorkbenchRun(
        run,
        [thread, { ...thread, environmentId: envB }],
        [project, { ...project, environmentId: envB }],
        true,
      ).kind,
    ).toBe("ambiguous");
    expect(matchWorkbenchRun({ ...run, threadRef: "" }, [thread], [project], true).kind).toBe(
      "unbound",
    );
    expect(matchWorkbenchRun({ ...run, workspace: "" }, [thread], [project], true).kind).toBe(
      "missing-workspace",
    );
    expect(
      matchWorkbenchRun({ ...run, threadRef: "local-a:thread" }, [thread], [project], true).kind,
    ).toBe("unresolved");
  });

  it("does not prove a unique legacy link from an incomplete environment set", () => {
    expect(matchWorkbenchRun(run, [thread], [project], false).kind).toBe("synchronizing");
  });
});
