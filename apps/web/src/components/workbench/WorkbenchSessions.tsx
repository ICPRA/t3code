import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, CircleAlert, GitBranch, GitCompareArrows } from "lucide-react";

import { useI18n } from "~/i18n/i18n";
import { useNowMinute } from "~/hooks/useNowMinute";
import {
  useAllEnvironmentProjectSnapshotsReady,
  useProjects,
  useThreadShells,
  useThreadDetail,
} from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { environmentShell } from "~/state/shell";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useRightPanelStore } from "~/rightPanelStore";
import { useDiffPanelStore } from "~/diffPanelStore";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "../Sidebar.logic";
import {
  consultedWorkbenchRecords,
  consultedWorkbenchSources,
  elapsedTurnMinutes,
  loadedWorkbenchUsage,
  linkedWorkbenchCheckpoints,
  linkedWorkbenchCompactions,
  ownedWorkbenchTurnIds,
  matchWorkbenchRun,
  workbenchTurnUsage,
} from "./WorkbenchSessions.logic";
import type { WorkbenchRequest, WorkbenchRun } from "./workbenchModel";
import { WorkbenchDeliverySubmission } from "./WorkbenchDeliverySubmission";
import { saveWorkbenchReturn } from "./workbenchReturn";
import { WorkbenchProgramRunRow } from "./WorkbenchProgram";
import { RunHarness } from "@project-workbench/ui/run-harness";

const statusLabels: Record<SidebarThreadStatus, readonly [string, string]> = {
  approval: ["等待审批", "Awaiting approval"],
  input: ["等待输入", "Awaiting input"],
  working: ["正在执行", "Working"],
  monitoring: ["正在监视", "Monitoring"],
  failed: ["运行失败", "Run failed"],
  ready: ["空闲", "Idle"],
};

const assignmentLabels: Record<string, readonly [string, string]> = {
  manager: ["项目管理", "Project management"],
  knowledge: ["知识维护", "Knowledge stewardship"],
  executor: ["设计与执行", "Design and execution"],
  reviewer: ["审核", "Review"],
};

function SessionRow({
  run,
  thread,
  siblingRuns,
  project,
  onChanged,
  request,
}: {
  run: WorkbenchRun;
  thread: EnvironmentThreadShell;
  siblingRuns: readonly WorkbenchRun[];
  project: string;
  onChanged: () => void;
  request?: WorkbenchRequest;
}) {
  const { language } = useI18n();
  const zh = language === "zh";
  const [inspectTurns, setInspectTurns] = useState(false);
  const detail = useThreadDetail(
    inspectTurns && run.dispatchMessageId ? scopeThreadRef(thread.environmentId, thread.id) : null,
  );
  const turnIds = ownedWorkbenchTurnIds(run.id, siblingRuns, detail?.activities ?? []);
  const compactions = linkedWorkbenchCompactions(run.id, siblingRuns, detail?.activities ?? []);
  const usage = workbenchTurnUsage(detail?.activities ?? []);
  const loadedUsage = loadedWorkbenchUsage(turnIds, usage);
  const consulted = consultedWorkbenchSources(
    run.id,
    thread.projectId,
    siblingRuns,
    detail?.activities ?? [],
  );
  const consultedRecords = consultedWorkbenchRecords(
    run.id,
    project,
    thread,
    siblingRuns,
    detail?.activities ?? [],
  );
  const checkpoints = linkedWorkbenchCheckpoints(
    run.id,
    siblingRuns,
    detail?.activities ?? [],
    detail?.checkpoints ?? [],
  );
  const nowMinute = useNowMinute();
  const elapsed =
    thread.latestTurn && turnIds.includes(thread.latestTurn.turnId)
      ? elapsedTurnMinutes(thread.latestTurn, Date.parse(`${nowMinute}:00Z`))
      : null;
  const shell = useAtomValue(environmentShell.stateValueAtom(thread.environmentId));
  const { presentationById } = useEnvironments();
  const environment = presentationById.get(thread.environmentId);
  const live = shell.status === "live" && environment?.connection.phase === "connected";
  const status = resolveSidebarThreadStatus(thread);
  const statusLabel = statusLabels[status][zh ? 0 : 1];
  return (
    <article className="grid min-w-0 gap-3 border-b py-4 md:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0 space-y-1">
        <Link
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams({
            environmentId: thread.environmentId,
            threadId: thread.id,
          })}
          onClick={saveWorkbenchReturn}
          className="inline-flex max-w-full items-start gap-1 break-words font-medium text-primary hover:underline"
        >
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{thread.title}</span>
          <ArrowUpRight className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        </Link>
        <div>
          <Link
            to="/$environmentId/$threadId"
            params={buildThreadRouteParams({
              environmentId: thread.environmentId,
              threadId: thread.id,
            })}
            onClick={() => {
              saveWorkbenchReturn();
              useRightPanelStore
                .getState()
                .open(scopeThreadRef(thread.environmentId, thread.id), "diff");
            }}
            className="wb-button"
          >
            <GitCompareArrows size={14} aria-hidden="true" />
            {zh ? "工作区改动" : "Workspace changes"}
          </Link>
        </div>
        <p className="break-all text-xs text-muted-foreground">
          {run.taskSlug} · {thread.modelSelection.model}
        </p>
        <p className="break-all text-xs text-muted-foreground">{run.workspace}</p>
        <p className="text-xs text-muted-foreground">
          {zh ? "派单职责" : "Assigned responsibility"}:{" "}
          {run.assignmentRole
            ? (assignmentLabels[run.assignmentRole]?.[zh ? 0 : 1] ?? run.assignmentRole)
            : zh
              ? "未记录"
              : "Not recorded"}
        </p>
        <WorkbenchDeliverySubmission
          project={project}
          run={run}
          environmentId={thread.environmentId}
          onChanged={onChanged}
          {...(request ? { request } : {})}
        />
        <RunHarness
          project={project}
          run={run}
          language={language}
          {...(request ? { request } : {})}
        />
        <details
          onToggle={(event) => setInspectTurns(event.currentTarget.open)}
          className="text-xs"
        >
          <summary>{zh ? "关联执行轮次" : "Linked execution turns"}</summary>
          {detail && turnIds.length > 0 && (
            <>
              <h4>{zh ? "已载入主Agent用量" : "Loaded main-agent usage"}</h4>
              <dl
                className="grid grid-cols-2 gap-x-4 gap-y-1 break-words"
                aria-label={zh ? "已载入主Agent用量" : "Loaded main-agent usage"}
              >
                <dt>{zh ? "已知输入token" : "Known input tokens"}</dt>
                <dd>
                  {loadedUsage.inputTokens ?? (zh ? "未提供" : "Not provided")} ·{" "}
                  {loadedUsage.inputReportedTurns}/{loadedUsage.turns}{" "}
                  {zh ? "轮有记录" : "turns reported"}
                </dd>
                <dt>{zh ? "已知输出token" : "Known output tokens"}</dt>
                <dd>
                  {loadedUsage.outputTokens ?? (zh ? "未提供" : "Not provided")} ·{" "}
                  {loadedUsage.outputReportedTurns}/{loadedUsage.turns}{" "}
                  {zh ? "轮有记录" : "turns reported"}
                </dd>
                <dt>{zh ? "完整用量报告" : "Complete usage reports"}</dt>
                <dd>
                  {loadedUsage.completeTurns}/{loadedUsage.turns}
                </dd>
              </dl>
            </>
          )}
          {!run.dispatchMessageId ? (
            <p>{zh ? "旧记录未保存派单消息身份" : "Dispatch message identity was not recorded"}</p>
          ) : !detail ? (
            <p>{zh ? "尚未取得会话详情" : "Session details not available yet"}</p>
          ) : turnIds.length === 0 ? (
            <p>
              {zh
                ? "当前会话记录中没有可唯一归属的轮次"
                : "No uniquely attributable turn in the current session records"}
            </p>
          ) : (
            <ul>
              {turnIds.map((id) => {
                const tokens = usage.get(id);
                return (
                  <li key={id} className="break-all">
                    {id}
                    <p>
                      {zh ? "主Agent token" : "Main-agent tokens"}:{" "}
                      {tokens
                        ? `${zh ? "输入" : "Input"} ${tokens.inputTokens ?? "?"} / ${zh ? "输出" : "Output"} ${tokens.outputTokens ?? "?"} (${tokens.usageStatus === "complete" ? (zh ? "完整" : "complete") : zh ? "部分或不可用" : "partial or unavailable"})`
                        : zh
                          ? "未提供"
                          : "Not provided"}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
          {elapsed !== null && (
            <p>
              {zh ? "最新关联轮次历时" : "Latest linked turn elapsed"}: {elapsed}{" "}
              {zh ? "分钟" : "min"}
            </p>
          )}
          <details>
            <summary>
              {zh ? "压缩通知记录" : "Compaction notifications"}:{" "}
              {compactions.length || (zh ? "未取得" : "Not available")}
            </summary>
            {compactions.map((activity) => (
              <p key={activity.id} className="break-all">
                {activity.createdAt} · {activity.turnId} · {activity.id}
              </p>
            ))}
            <p>
              {zh
                ? "仅列已载入且可唯一归属的原生通知，不代表完整压缩次数；没有通知也不代表从未压缩。"
                : "Loaded, uniquely attributed native notifications only, not a complete compaction count. Missing notifications do not establish no compaction."}
            </p>
          </details>
          <h4>{zh ? "关联轮次的文件差异" : "Files changed in linked turns"}</h4>
          {checkpoints.map((checkpoint) => (
            <div key={checkpoint.turnId} className="border-t py-2">
              <p className="break-all">
                {checkpoint.checkpointRef} · {checkpoint.status} · {checkpoint.completedAt}
              </p>
              {checkpoint.files.map((file) => (
                <p key={file.path} className="break-all">
                  {checkpoint.status === "ready" ? (
                    <Link
                      className="underline"
                      to="/$environmentId/$threadId"
                      params={buildThreadRouteParams({
                        environmentId: thread.environmentId,
                        threadId: thread.id,
                      })}
                      onClick={() => {
                        saveWorkbenchReturn();
                        const ref = scopeThreadRef(thread.environmentId, thread.id);
                        useDiffPanelStore.getState().selectTurn(ref, checkpoint.turnId, file.path);
                        useRightPanelStore.getState().open(ref, "diff");
                      }}
                    >
                      {file.path}
                    </Link>
                  ) : (
                    file.path
                  )}{" "}
                  · +{file.additions} / -{file.deletions}
                </p>
              ))}
            </div>
          ))}
          {!checkpoints.length && (
            <p>
              {zh
                ? "当前记录中没有可唯一关联的检查点。"
                : "No uniquely linked checkpoint in loaded records."}
            </p>
          )}
          {checkpoints.length > 0 && (
            <p>
              {zh
                ? "T3工作区检查点，不等于该节点独占修改或已合入Git提交。"
                : "T3 workspace checkpoints, not proof of exclusive node authorship or merged Git commits."}
            </p>
          )}
          <h4>{zh ? "自动关联的原文片段读取" : "Automatically linked source reads"}</h4>
          {consulted.sources.map((source) => (
            <div key={source.eventId} className="border-t py-2">
              <Link
                to="/$environmentId/$threadId"
                params={buildThreadRouteParams({
                  environmentId: thread.environmentId,
                  threadId: source.threadId,
                })}
                onClick={saveWorkbenchReturn}
                className="underline break-all"
              >
                {source.threadId} · {source.messageId}
              </Link>
              <p>
                {source.source} · {source.offset} → {source.nextOffset ?? (zh ? "末尾" : "end")} ·{" "}
                {source.updatedAt}
              </p>
              <p>
                {zh ? "返回片段时间" : "Read receipt time"}: {source.readAt}
              </p>
            </div>
          ))}
          {consulted.ambiguousCount > 0 && (
            <p>
              {zh
                ? "部分读取对应多个执行，未分配给节点。"
                : "Some reads map to multiple runs; node attribution is unresolved."}
            </p>
          )}
          {!consulted.sources.length && (
            <p>
              {zh
                ? "当前活动中未取得可唯一关联的来源，不代表没有读取。"
                : "No uniquely attributable source in loaded activities; this does not establish that no read occurred."}
            </p>
          )}
          {consulted.sources.length > 0 && (
            <p>
              {zh
                ? "仅证明工具返回了这些片段，不代表模型采纳、全文读完或审核通过。"
                : "These receipts establish returned fragments, not adoption, complete reading or approval."}
            </p>
          )}
          <h4>{zh ? "自动关联的知识记录读取" : "Automatically linked knowledge reads"}</h4>
          {consultedRecords.records.map((record) => (
            <div key={record.eventId} className="border-t py-2 break-all">
              <p>
                {record.kind} · {record.id} · {record.slug} · v{record.version}
              </p>
              {record.sourceRefs && (
                <p>
                  {zh ? "来源引用" : "Source references"}:{" "}
                  {Object.entries(record.sourceRefs)
                    .map(([key, value]) => `${key}: ${value}`)
                    .join(" · ")}
                </p>
              )}
              <p>
                {zh ? "返回时间" : "Read receipt time"}: {record.readAt}
              </p>
            </div>
          ))}
          {consultedRecords.ambiguousCount > 0 && (
            <p>
              {zh
                ? "部分知识读取对应多个执行，未分配给节点。"
                : "Some knowledge reads map to multiple runs; node attribution is unresolved."}
            </p>
          )}
          {!consultedRecords.records.length && (
            <p>
              {zh
                ? "当前活动中未取得可唯一关联的知识读取，不代表没有读取。"
                : "No uniquely attributable knowledge read in loaded activities; this does not establish that no read occurred."}
            </p>
          )}
          {consultedRecords.records.length > 0 && (
            <p>
              {zh
                ? "这是当时返回记录的版本证据，不是可重建的历史全文快照，也不代表模型采纳。"
                : "These are observed record versions, not reconstructable historical text snapshots or evidence of adoption."}
            </p>
          )}
        </details>
        <p className="text-xs text-muted-foreground">
          {zh ? "准备时规格版本" : "Spec version at preparation"}:{" "}
          {run.specVersion == null ? (zh ? "未记录" : "Not recorded") : `v${run.specVersion}`}
        </p>
        <p className="break-all text-xs text-muted-foreground">
          {zh ? "准备时Git基线" : "Git baseline at preparation"}:{" "}
          {run.gitBaseline?.isRepo === false
            ? zh
              ? "非Git目录"
              : "Not a Git repository"
            : run.gitBaseline?.isRepo === true
              ? (run.gitBaseline.commitSha ??
                (zh ? "未取得可解析的HEAD提交" : "No resolvable HEAD commit"))
              : zh
                ? "未记录"
                : "Not recorded"}
        </p>
        <p className="break-all text-xs text-muted-foreground">
          {environment?.entry.target.label ?? thread.environmentId} · {run.id} ·{" "}
          {zh ? "代次" : "Generation"} {run.generation}
        </p>
        {live && thread.planProgress ? (
          <p className="flex items-start gap-1 text-sm">
            <GitBranch className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span className="break-words [overflow-wrap:anywhere]">
              {thread.planProgress.completedSteps}/{thread.planProgress.totalSteps} ·{" "}
              {thread.planProgress.step}
            </span>
          </p>
        ) : null}
      </div>
      <div className="text-xs md:text-right">
        <p
          className={
            live && (status === "approval" || status === "input" || status === "failed")
              ? "text-amber-600 dark:text-amber-400"
              : "text-muted-foreground"
          }
        >
          {live
            ? statusLabel
            : `${zh ? "状态未同步；上次" : "Not synchronized; last"}: ${statusLabel}`}
        </p>
        <p className="mt-1 text-muted-foreground">
          {zh ? "业务绑定" : "Binding"}: {run.state}
        </p>
        {thread.archivedAt ? (
          <p className="mt-1 text-muted-foreground">{zh ? "已归档会话" : "Archived session"}</p>
        ) : null}
      </div>
    </article>
  );
}

export function WorkbenchSessions({
  runs,
  selectedTask,
  selectedRunId,
  project,
  onChanged,
  request,
  nodeOwners,
}: {
  runs: readonly WorkbenchRun[];
  selectedTask: string | null;
  selectedRunId?: string;
  project: string;
  onChanged: () => void;
  request?: WorkbenchRequest;
  nodeOwners?: Array<{
    taskSlug: string;
    humanOwnerUserId: string | null;
    pendingOperationId: string | null;
  }>;
}) {
  const { language } = useI18n();
  const zh = language === "zh";
  const projects = useProjects();
  const threads = useThreadShells();
  const snapshotsReady = useAllEnvironmentProjectSnapshotsReady();
  const visibleRuns = runs.filter(
    (run) =>
      (!selectedTask || run.taskSlug === selectedTask) &&
      (!selectedRunId || run.id === selectedRunId),
  );
  const associations = new Map(
    runs.map((run) => [run.id, matchWorkbenchRun(run, threads, projects, snapshotsReady)]),
  );
  const siblings = new Map<string, WorkbenchRun[]>();
  for (const run of runs) {
    const match = associations.get(run.id)!;
    if (match.kind !== "matched") continue;
    const key = `${match.thread.environmentId}:${match.thread.id}`;
    const group = siblings.get(key) ?? [];
    group.push(run);
    siblings.set(key, group);
  }
  return (
    <section className="min-w-0" data-i18n-skip>
      {!snapshotsReady && visibleRuns.some((run) => run.executorKind !== "program") ? (
        <p
          role="status"
          className="mb-3 flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {zh
            ? "部分 T3 环境尚未同步，会话关联可能不完整。"
            : "Some T3 environments are not synchronized; session links may be incomplete."}
        </p>
      ) : null}
      {visibleRuns.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">
          {zh ? "当前范围没有已登记的执行。" : "No registered runs in this scope."}
        </p>
      ) : (
        visibleRuns.map((run) => {
          const match = associations.get(run.id)!;
          if (match.kind === "program")
            return (
              <WorkbenchProgramRunRow
                key={run.id}
                run={run}
                project={project}
                onChanged={onChanged}
                ownerHold={
                  nodeOwners?.some(
                    (item) =>
                      item.taskSlug === run.taskSlug &&
                      (!!item.humanOwnerUserId || !!item.pendingOperationId),
                  ) ?? false
                }
                {...(request ? { request } : {})}
              />
            );
          if (match.kind === "matched")
            return (
              <SessionRow
                key={run.id}
                run={run}
                thread={match.thread}
                siblingRuns={siblings.get(`${match.thread.environmentId}:${match.thread.id}`)!}
                project={project}
                onChanged={onChanged}
                {...(request ? { request } : {})}
              />
            );
          const label = {
            unbound: zh ? "尚未绑定会话" : "Session not bound",
            "missing-workspace": zh
              ? "缺少工作目录，无法核对关联"
              : "Workspace missing; link unverified",
            unresolved: zh
              ? "无法核对会话引用与工作目录"
              : "Session reference and workspace not resolved",
            ambiguous: zh ? "多个环境匹配，关联有歧义" : "Ambiguous match across environments",
            synchronizing: zh
              ? "环境快照未齐，尚不能核实唯一关联"
              : "Environment snapshots incomplete; unique link unverified",
          }[match.kind];
          return (
            <article key={run.id} className="space-y-1 border-b py-4 text-sm">
              <p className="break-all font-medium">{run.taskSlug}</p>
              <RunHarness
                project={project}
                run={run}
                language={language}
                {...(request ? { request } : {})}
              />
              <p className="text-xs text-muted-foreground">
                {zh ? "派单职责" : "Assigned responsibility"}:{" "}
                {run.assignmentRole
                  ? (assignmentLabels[run.assignmentRole]?.[zh ? 0 : 1] ?? run.assignmentRole)
                  : zh
                    ? "未记录"
                    : "Not recorded"}
              </p>
              <p className="text-amber-600 dark:text-amber-400">{label}</p>
              <p className="break-all text-xs text-muted-foreground">
                {run.id} · {zh ? "业务绑定" : "Binding"}: {run.state}
              </p>
              <p className="text-xs text-muted-foreground">
                {zh ? "准备时规格版本" : "Spec version at preparation"}:{" "}
                {run.specVersion == null ? (zh ? "未记录" : "Not recorded") : `v${run.specVersion}`}
              </p>
              {run.threadRef ? (
                <p className="break-all text-xs text-muted-foreground">{run.threadRef}</p>
              ) : null}
              {run.workspace ? (
                <p className="break-all text-xs text-muted-foreground">{run.workspace}</p>
              ) : null}
            </article>
          );
        })
      )}
    </section>
  );
}
