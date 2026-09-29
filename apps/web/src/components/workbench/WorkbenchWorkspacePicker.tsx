import { useRef, useState } from "react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { ChevronDown, GitBranchPlus, RefreshCw } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useI18n } from "~/i18n/i18n";
import { usePaginatedBranches } from "~/state/queries";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";

export type WorkbenchWorkspaceSelection = {
  workspace: string;
  branch: string | null;
  worktreePath: string | null;
  expectedCommitSha?: string;
};

type Props = {
  nativeProject: EnvironmentProject;
  value: WorkbenchWorkspaceSelection | null;
  disabled: boolean;
  onChange: (value: WorkbenchWorkspaceSelection | null) => void;
};

export function WorkbenchWorkspacePicker({ nativeProject, value, disabled, onChange }: Props) {
  const { language } = useI18n();
  const text = (zh: string, en: string) => language === "zh" ? zh : en;
  const [query, setQuery] = useState("");
  const [base, setBase] = useState("");
  const [commit, setCommit] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const refs = usePaginatedBranches({
    environmentId: nativeProject.environmentId,
    cwd: nativeProject.workspaceRoot,
    query,
  });
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree, { reportFailure: false });
  const rootPath = normalizeProjectPathForComparison(nativeProject.workspaceRoot);
  const gitReady = refs.data !== null && refs.data.isRepo && !refs.error;
  const worktrees = gitReady ? refs.refs.filter((ref) => ref.worktreePath !== null && normalizeProjectPathForComparison(ref.worktreePath) !== rootPath) : [];
  const selection = value === null ? "" : value.worktreePath === null
    ? "shared" : JSON.stringify([value.branch, value.worktreePath]);
  const missingSelection = value?.worktreePath !== null && value !== null &&
    !worktrees.some((ref) => JSON.stringify([ref.name, ref.worktreePath]) === selection);
  const sourceError = refs.error || (refs.data !== null && !refs.data.isRepo ? text("该项目不是 Git 仓库；仍可显式选择共享目录。", "The selected project is not a Git repository. The shared directory remains available.") : "");
  const unavailable = disabled || busy || !gitReady;
  const selectedCommit = commit.trim().toLowerCase();
  const validCommit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(selectedCommit);
  const canCreate = !unavailable && (selectedCommit ? validCommit : refs.refs.some((ref) => ref.name === base)) && branch.trim() !== "";

  async function createSelectedWorktree() {
    if (!canCreate || inFlight.current) return;
    inFlight.current = true;
    onChange(null);
    setBusy(true);
    setError("");
    try {
      const result = await createWorktree({
        environmentId: nativeProject.environmentId,
        input: { cwd: nativeProject.workspaceRoot, refName: selectedCommit || base, newRefName: branch.trim(), ...(selectedCommit ? {} : { baseRefName: base }), path: null },
      });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      const worktree = result.value.worktree;
      if (!worktree.path || !worktree.refName || normalizeProjectPathForComparison(worktree.path) === rootPath) {
        throw new Error(text("原生工作树创建未返回隔离路径和分支。请检查工作树列表后再重试。", "Native worktree creation did not return an isolated path and branch. Inspect the worktree list before retrying."));
      }
      onChange({ workspace: worktree.path, branch: worktree.refName, worktreePath: worktree.path, ...(selectedCommit ? { expectedCommitSha: selectedCommit } : {}) });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      refs.refresh();
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <div className="min-w-0 space-y-3">
    <label className="block text-sm">{text("执行工作区", "Execution workspace")}
      <select aria-label={text("执行工作区", "Execution workspace")} className="mt-1 block w-full min-w-0 rounded border bg-background p-2"
        value={selection} disabled={disabled || busy} onChange={(event) => {
          if (disabled || busy) return;
          setError("");
          if (event.target.value === "") { onChange(null); return; }
          if (event.target.value === "shared") {
            onChange({ workspace: nativeProject.workspaceRoot, branch: null, worktreePath: null });
            return;
          }
          const ref = worktrees.find((entry) => JSON.stringify([entry.name, entry.worktreePath]) === event.target.value);
          if (!ref?.worktreePath) {
            onChange(null);
            setError(text("所选工作树不可用。请刷新后选择现有工作区。", "The selected worktree is unavailable. Refresh and choose an existing workspace."));
            return;
          }
          onChange({ workspace: ref.worktreePath, branch: ref.name, worktreePath: ref.worktreePath });
        }}>
        <option value="">{text("选择工作区", "Select workspace")}</option>
        <option value="shared">{text("共享目录（非隔离）", "Shared checkout (not isolated)")}: {nativeProject.workspaceRoot}</option>
        {missingSelection ? <option value={selection} disabled>{text("已记录工作区", "Recorded workspace")}: {value.branch} - {value.workspace}</option> : null}
        {worktrees.map((ref) => <option key={ref.name} value={JSON.stringify([ref.name, ref.worktreePath])}>{ref.name} - {ref.worktreePath}</option>)}
      </select>
    </label>
    {value ? <p className="break-all text-xs text-muted-foreground">{value.workspace}{value.branch ? ` (${value.branch})` : ""}</p> : null}
    {!disabled ? <>
      <div className="flex min-w-0 items-center gap-2">
        <Input aria-label={text("筛选引用", "Filter refs")} placeholder={text("筛选引用", "Filter refs")} value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} />
        <Button type="button" variant="outline" size="icon" title={text("刷新工作树和引用", "Refresh worktrees and refs")} aria-label={text("刷新工作树和引用", "Refresh worktrees and refs")} disabled={busy} onClick={() => refs.refresh()}><RefreshCw /></Button>
        {refs.data?.nextCursor != null ? <Button type="button" variant="outline" disabled={busy || refs.isFetchingNextPage} onClick={() => refs.loadNext()}><ChevronDown />{text("更多引用", "More refs")}</Button> : null}
      </div>
      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        <label className="min-w-0 text-sm">{text("基准引用", "Base ref")}
          <select aria-label={text("基准引用", "Base ref")} className="mt-1 block w-full min-w-0 rounded border bg-background p-2" value={base} disabled={unavailable || !!selectedCommit} onChange={(event) => setBase(event.target.value)}>
            <option value="">{text("选择基准引用", "Select base ref")}</option>
            {base && !refs.refs.some((ref) => ref.name === base) ? <option value={base} disabled>{base} ({text("尚未加载此引用", "not in loaded refs")})</option> : null}
            {refs.refs.map((ref) => <option key={ref.name} value={ref.name}>{ref.name}</option>)}
          </select>
        </label>
        <label className="min-w-0 text-sm">{text("新分支", "New branch")}
          <Input aria-label={text("新分支", "New branch")} className="mt-1" value={branch} disabled={busy} onChange={(event) => setBranch(event.target.value)} />
        </label>
        <label className="min-w-0 text-sm">{text("固定提交 SHA（可选）", "Exact commit SHA (optional)")}
          <Input aria-label={text("固定提交 SHA", "Exact commit SHA")} className="mt-1" value={commit} disabled={busy} onChange={(event) => setCommit(event.target.value)} />
        </label>
      </div>
      {selectedCommit && !validCommit ? <p role="alert" className="text-sm text-destructive">{text("请输入完整的 40 或 64 位十六进制提交 SHA。", "Enter a full 40- or 64-character hexadecimal commit SHA.")}</p> : null}
      <Button type="button" variant="outline" disabled={!canCreate} onClick={createSelectedWorktree}><GitBranchPlus />{busy ? text("正在创建工作树...", "Creating worktree...") : text("创建隔离工作树", "Create isolated worktree")}</Button>
      <p className="text-xs text-muted-foreground">{text("不会运行初始化脚本或复制未提交更改。后续派发失败时，已创建工作树会保留。", "Setup scripts are not run and uncommitted changes are not copied. Created worktrees are retained if dispatch later fails.")}</p>
    </> : null}
    {refs.data === null && !refs.error && !disabled ? <p role="status" className="text-xs">{text("正在加载引用...", "Loading refs...")}</p> : null}
    {error || sourceError ? <p role="alert" className="break-words text-sm text-destructive">{error || sourceError}</p> : null}
  </div>;
}
