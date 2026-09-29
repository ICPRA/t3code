import { useEffect, useRef, useState } from "react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { KNOWLEDGE_DIRECTORY_PATH } from "@project-workbench/ui/dispatch";
import { BookOpen, MessageCircleQuestionMark, RefreshCw, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useProjects } from "~/state/entities";
import { useProjectContentSearch } from "~/state/queries";
import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";
import { useI18n } from "~/i18n/i18n";
import { resolveMarkdownFileLinkMeta } from "~/markdown-links";
import { resolvePathLinkTarget } from "~/terminal-links";
import { toastManager } from "~/components/ui/toast";
import { composerDraftHasUserContent, useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { WorkbenchConversationSearch } from "./WorkbenchConversationSearch";

export function WorkbenchRepositorySearch({ query, specgraphProject, question }: { query: string; specgraphProject: string; question: string }) {
  const projects = useProjects();
  const { language } = useI18n();
  const newThread = useNewThreadHandler();
  const [selection, setSelection] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(true);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffError, setHandoffError] = useState("");
  const handoffInFlight = useRef(false);
  const selected = projects.find((project) => `${project.environmentId}:${project.id}` === selection);
  async function askInConversation() {
    if (handoffInFlight.current || !selected || !question.trim()) return;
    handoffInFlight.current = true;
    setHandoffBusy(true);
    setHandoffError("");
    try {
      const opened = await newThread(scopeProjectRef(selected.environmentId, selected.id), { envMode: "local", worktreePath: null, branch: null });
      if (!opened) throw new Error("The native conversation draft was not opened.");
      const store = useComposerDraftStore.getState();
      if (composerDraftHasUserContent(store.getComposerDraft(opened.draftId))) {
        throw new Error("The conversation draft has existing content; it was not overwritten.");
      }
      store.setPrompt(opened.draftId, `Question: ${question.trim()}\n\nScope: SpecGraph project ${specgraphProject}; selected T3 project ${selected.title} (environment ${selected.environmentId}, project ${selected.id}, workspace ${selected.workspaceRoot}). The mapping between these projects is unverified; verify it or state the mismatch.\n\nSearch project records, current workspace code/text and saved project conversations using workbench_search_knowledge. Check source status and truncation, follow relevant original records, files and messages, and cite the actual originals. Search hits are candidates, not answers. If a source is unavailable, say so; do not infer absence from no matches. Answer this question only; do not modify files or SpecGraph nodes or dispatch a business task.`);
      toastManager.add({ type: "success", title: language === "zh" ? "问题已填入对话草稿" : "Question added to conversation draft", description: language === "zh" ? "确认模型和权限后发送。" : "Review the model and permissions, then send." });
    } catch (cause) {
      setHandoffError(String(cause));
      toastManager.add({ type: "error", title: language === "zh" ? "无法准备对话提问" : "Could not prepare conversation question", description: String(cause) });
    } finally {
      handoffInFlight.current = false;
      setHandoffBusy(false);
    }
  }
  return <section className="space-y-3 border-t py-4" data-i18n-skip>
    <h2>{language === "zh" ? "T3 工作区来源" : "T3 workspace sources"}</h2>
    <label>{language === "zh" ? "T3 工作区" : "T3 workspace"}
      <select className="block w-full rounded border bg-background p-2" value={selection} onChange={(event) => { setSelection(event.target.value); setHandoffError(""); }}>
        <option value="">{language === "zh" ? "选择检索目录" : "Select search workspace"}</option>
        {projects.map((project) => <option key={`${project.environmentId}:${project.id}`} value={`${project.environmentId}:${project.id}`}>{project.title} · {project.workspaceRoot} · {project.environmentId}</option>)}
      </select>
    </label>
    <button type="button" className="wb-button inline-flex items-center gap-2" disabled={!selected || !question.trim() || handoffBusy} onClick={() => void askInConversation()}><MessageCircleQuestionMark size={14} />{language === "zh" ? "在对话中提问" : "Ask in conversation"}</button>
    {handoffError && <p role="alert">{handoffError}</p>}
    {!selected && <p role="status">{language === "zh" ? "T3 工作区来源未选择。" : "T3 workspace source not selected."}</p>}
    {selected && <div key={`${selection}:${query}`}><RepositoryContents project={selected} query={query} caseSensitive={caseSensitive} onCaseSensitiveChange={setCaseSensitive} />
      <WorkbenchConversationSearch project={selected} query={query} includeArchived={includeArchived} onIncludeArchivedChange={setIncludeArchived} /></div>}
  </section>;
}

function RepositoryContents({ project, query, caseSensitive, onCaseSensitiveChange }: {
  project: EnvironmentProject; query: string; caseSensitive: boolean; onCaseSensitiveChange: (value: boolean) => void;
}) {
  const { language } = useI18n();
  const text = (zh: string, en: string) => language === "zh" ? zh : en;
  const [selection, setSelection] = useState<{ path: string; line: number } | null>(null);
  const [view, setView] = useState<"source" | "preview">("source");
  const search = useProjectContentSearch({ environmentId: project.environmentId, cwd: project.workspaceRoot, query, caseSensitive, wholeWord: false, useRegex: false });
  const file = useProjectFileQuery(project.environmentId, project.workspaceRoot, selection?.path ?? null);
  const selectedLine = useRef<HTMLSpanElement>(null);
  const isMarkdown = /\.(md|markdown)$/i.test(selection?.path ?? "");
  const lastSeparator = Math.max(selection?.path.lastIndexOf("/") ?? -1, selection?.path.lastIndexOf("\\") ?? -1);
  const baseDir = selection && lastSeparator >= 0
    ? resolvePathLinkTarget(selection.path.slice(0, lastSeparator), project.workspaceRoot) : project.workspaceRoot;
  useEffect(() => { selectedLine.current?.scrollIntoView({ block: "nearest" }); }, [file.data, selection, view]);
  return <div className="space-y-3">
    <p className="break-all text-xs">{project.workspaceRoot} · {text("所选 T3 工作区当前内容（非提交快照）；与 SpecGraph 项目的对应关系未经验证。", "Selected T3 workspace contents (not a commit snapshot); mapping to the SpecGraph project is unverified.")}</p>
    <button type="button" className="wb-button inline-flex items-center gap-2" onClick={() => { setSelection({ path: KNOWLEDGE_DIRECTORY_PATH, line: 1 }); setView("preview"); }}><BookOpen size={14} />{text("知识目录", "Knowledge directory")}</button>
    <h3>{text("工作区文件", "Workspace files")}</h3>
    <label><input type="checkbox" checked={caseSensitive} onChange={(event) => onCaseSensitiveChange(event.target.checked)} /> {text("区分大小写", "Case sensitive")}</label>
    {search.hasQuery && (search.error ? <p role="alert">{String(search.error)}</p> : search.isPending ? <p role="status">{text("检索中", "Searching")}</p> : <>
      <p role="status">{search.matches.length}{search.truncated ? "+" : ""} {text("处匹配", "matches")}</p>
      {!search.matches.length && <p>{text("所选工作区未返回匹配。", "No matches returned in the selected workspace.")}</p>}
      <ul className="max-h-96 overflow-auto">
        {search.matches.map((match) => <li key={`${match.path}:${match.lineNumber}`} className="border-b py-2">
          <button type="button" className="text-left underline break-all" onClick={() => { setSelection({ path: match.path, line: match.lineNumber }); setView("source"); }}>{match.path}:{match.lineNumber}</button>
          <pre className="whitespace-pre-wrap break-words text-xs">{match.lineContent}</pre>
        </li>)}
      </ul>
      {search.truncated && <p>{text("达到原生检索上限，结果不完整。", "Native search limit reached; results are incomplete.")}</p>}
    </>)}
    {selection && <section className="space-y-2">
      <header className="flex items-center gap-2"><h3 className="min-w-0 flex-1 break-all">{selection.path}:{selection.line}</h3>
        <button type="button" className="wb-button" title={text("刷新原文", "Refresh source")} aria-label={text("刷新原文", "Refresh source")} onClick={file.refresh}><RefreshCw size={14} /></button>
        <button type="button" className="wb-button" title={text("关闭原文", "Close source")} aria-label={text("关闭原文", "Close source")} onClick={() => setSelection(null)}><X size={14} /></button>
      </header>
      {isMarkdown && <div role="group" aria-label={text("文件视图", "File view")} className="inline-flex rounded border p-0.5">
        <button type="button" aria-pressed={view === "source"} aria-controls="knowledge-file-content" className={`px-3 py-1 text-sm ${view === "source" ? "bg-accent" : ""}`} onClick={() => setView("source")}>{text("原文", "Source")}</button>
        <button type="button" aria-pressed={view === "preview"} aria-controls="knowledge-file-content" className={`px-3 py-1 text-sm ${view === "preview" ? "bg-accent" : ""}`} onClick={() => setView("preview")}>{text("预览", "Preview")}</button>
      </div>}
      {file.error ? <p role="alert">{file.error}</p> : file.isPending ? <p role="status">{text("读取中", "Loading")}</p> : file.data && <>
        {file.data.truncated && <p role="status">{text("文件内容已截断。", "File content is truncated.")}</p>}
        <div id="knowledge-file-content" className="max-h-96 overflow-auto">
          {isMarkdown && view === "preview" ? <div className="space-y-3 break-words text-sm [&_a]:underline [&_h1]:text-lg [&_h2]:text-base [&_h3]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_pre]:overflow-auto [&_table]:w-full [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2 [&_ul]:list-disc">
            <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
              a: ({ href, children }) => {
                const target = resolveMarkdownFileLinkMeta(href, project.workspaceRoot, baseDir);
                const relativePath = target?.workspaceRelativePath;
                if (target) return relativePath == null
                  ? <span title={text("链接位于所选工作区之外", "Link is outside the selected workspace")}>{children}</span>
                  : <a href={href} onClick={(event) => { event.preventDefault(); setSelection({ path: relativePath, line: target.line ?? 1 }); if (target.line !== undefined) setView("source"); }}>{children}</a>;
                if (!href || href.startsWith("#")) return <span>{children}</span>;
                return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
              },
              img: ({ alt }) => <span>{alt}</span>,
            }}>{file.data.contents}</ReactMarkdown>
          </div> : <pre className="text-xs">{file.data.contents.split("\n").map((line, index) => <span key={index} ref={index + 1 === selection.line ? selectedLine : undefined} className={`block ${index + 1 === selection.line ? "bg-accent" : ""}`}><span className="mr-4 text-muted-foreground">{index + 1}</span>{line}</span>)}</pre>}
        </div>
      </>}
    </section>}
  </div>;
}
