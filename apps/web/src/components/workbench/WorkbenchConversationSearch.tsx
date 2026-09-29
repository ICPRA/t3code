import { Link } from "@tanstack/react-router";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useI18n } from "~/i18n/i18n";
import { useThreadShells } from "~/state/entities";
import { useDebouncedValue } from "~/state/queries";
import { useEnvironmentQuery } from "~/state/query";
import { orchestrationEnvironment } from "~/state/orchestration";
import { buildThreadRouteParams } from "~/threadRoutes";

export function WorkbenchConversationSearch({ project, query, includeArchived, onIncludeArchivedChange }: {
  project: EnvironmentProject; query: string; includeArchived: boolean; onIncludeArchivedChange: (value: boolean) => void;
}) {
  const { language } = useI18n();
  const text = (zh: string, en: string) => language === "zh" ? zh : en;
  const settled = useDebouncedValue(query.trim(), 200);
  const eligible = query.trim().length >= 2;
  const debouncing = query.trim() !== settled;
  const result = useEnvironmentQuery(eligible && !debouncing ? orchestrationEnvironment.threadSearch({
    environmentId: project.environmentId, input: { projectId: project.id, query: settled, includeArchived, limit: 50 },
  }) : null);
  const threads = useThreadShells();
  return <section className="space-y-3 border-t py-4">
    <h2>{text("T3 工作区对话", "T3 workspace conversations")}</h2>
    <p className="text-xs">{text("T3已保存的用户/助手消息，每对话一条匹配；不含工具输出或CLI独有记录。", "Saved T3 user/assistant messages; one match per conversation. Excludes tool output and CLI-only records.")}</p>
    <label><input type="checkbox" checked={includeArchived} onChange={(event) => onIncludeArchivedChange(event.target.checked)} /> {text("包含已归档对话", "Include archived conversations")}</label>
    {eligible && (result.error ? <p role="alert">{result.error}</p> : debouncing || result.isPending ? <p role="status">{text("检索中", "Searching")}</p> : result.data && <>
      <p role="status">{result.data.matches.length} {text("个对话（最多50个）", "conversations (up to 50)")}</p>
      {!result.data.matches.length && <p>{text("当前范围未匹配。", "No matches in this scope.")}</p>}
      <ul className="max-h-96 overflow-auto">{result.data.matches.map((match) => {
        const thread = threads.find((entry) => entry.environmentId === project.environmentId && entry.id === match.threadId);
        return <li key={match.threadId} className="space-y-1 border-b py-2">
          <Link className="break-words underline" to="/$environmentId/$threadId" params={buildThreadRouteParams({ environmentId: project.environmentId, threadId: match.threadId })}>{thread?.title ?? match.threadId}</Link>
          <p className="whitespace-pre-wrap break-words">{match.snippet}</p>
          <p className="text-xs">{match.source} · {match.messageCreatedAt ?? text("时间未记录", "Time unavailable")}</p>
        </li>;
      })}</ul>
    </>)}
  </section>;
}
