import { useMemo, useRef, useState } from "react";
import { EnvironmentId, type VcsCompareCommitsResult } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { GitCompareArrows, ChevronDown } from "lucide-react";
import { useI18n } from "~/i18n/i18n";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { getRenderablePatch } from "~/lib/diffRendering";
import { StyledDiffCodeView } from "../diffs/StyledDiffCodeView";
import type { WorkbenchRun } from "./workbenchModel";

const Commit = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i));
const GitSnapshot = Schema.Struct({ git: Schema.Struct({ workspace: Schema.NonEmptyString,
  baseline: Schema.Struct({ isRepo: Schema.Literal(true), commitSha: Commit }),
  head: Schema.Struct({ isRepo: Schema.Literal(true), commitSha: Commit }),
}) });

export function WorkbenchDeliveryGit({ run, snapshot }: { run: WorkbenchRun; snapshot: unknown }) {
  const { language } = useI18n();
  const parsed = Schema.decodeUnknownOption(GitSnapshot)(snapshot);
  if (Option.isNone(parsed) || !run.environmentId) return <p>{language === "zh" ? "未记录可比较的Git双端引用或原环境身份。" : "Comparable Git references or original environment identity were not recorded."}</p>;
  const git = parsed.value.git;
  if (normalizeProjectPathForComparison(git.workspace) !== normalizeProjectPathForComparison(run.workspace)) return <p role="alert">{language === "zh" ? "交付目录与执行记录不一致，未读取其它目录。" : "Delivery workspace differs from its run; no substitute directory was read."}</p>;
  return <CommitRange key={JSON.stringify([run.environmentId, run.workspace, git.baseline.commitSha, git.head.commitSha])}
    environmentId={EnvironmentId.make(run.environmentId)} cwd={run.workspace} baseCommit={git.baseline.commitSha} headCommit={git.head.commitSha} />;
}

function CommitRange({ environmentId, cwd, baseCommit, headCommit }: { environmentId: EnvironmentId; cwd: string; baseCommit: string; headCommit: string }) {
  const { language } = useI18n();
  const text = (zh: string, en: string) => language === "zh" ? zh : en;
  const compare = useAtomCommand(vcsEnvironment.compareCommits, { reportFailure: false });
  const [result, setResult] = useState<VcsCompareCommitsResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const patch = useMemo(() => result ? getRenderablePatch(result.diff, `vacpms:${baseCommit}:${headCommit}`) : null, [result, baseCommit, headCommit]);
  const items = useMemo(() => patch?.kind === "files" ? patch.files.map((fileDiff, index) => ({ id: `${baseCommit}:${headCommit}:${index}`, type: "diff" as const, fileDiff, collapsed: false, version: 1 })) : [], [patch, baseCommit, headCommit]);
  async function load(offset = 0) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const response = await compare({ environmentId, input: { cwd, baseCommit, headCommit, offset, limit: 50 } });
      if (response._tag !== "Success") throw squashAtomCommandFailure(response);
      const value = response.value;
      if (value.baseCommit.toLowerCase() !== baseCommit.toLowerCase() || value.headCommit.toLowerCase() !== headCommit.toLowerCase()) throw new Error("Git comparison returned different commit identities");
      setResult((previous) => offset > 0 && previous ? { ...value, commits: [...previous.commits, ...value.commits] } : value);
    } catch (cause) { setError(String(cause)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <section className="space-y-2 border-t py-3">
    <h4>{text("固定Git版本范围", "Recorded Git range")}</h4>
    <p className="break-all text-xs">{baseCommit} → {headCommit}</p>
    <p className="text-xs">{text("不包含当前未提交修改；范围内提交不等于节点独占修改。", "Excludes current uncommitted changes; range membership does not prove exclusive node authorship.")}</p>
    {!result && <button type="button" className="wb-button" disabled={busy} onClick={() => void load()}><GitCompareArrows size={14} />{text("读取固定版本差异", "Read recorded diff")}</button>}
    {error && <p role="alert">{error}</p>}
    {result && <>
      {!result.baseIsAncestor && <p role="status">{text("起点不是终点祖先；以下仍比较登记的两个版本，未替换成共同祖先。", "Base is not an ancestor of head; comparison still uses the recorded versions, not their merge base.")}</p>}
      <ul className="max-h-64 overflow-auto">{result.commits.map((commit) => <li key={commit.commitSha} className="border-b py-2 break-words"><code>{commit.commitSha}</code><p>{commit.subject}</p><time>{commit.authoredAt}</time></li>)}</ul>
      {!result.commits.length && <p>{text("此Git可达范围没有提交；不等于需求已经满足。", "No commits in this Git reachability range; this is not a requirements verdict.")}</p>}
      {result.nextOffset !== null && <button className="wb-button" type="button" disabled={busy} onClick={() => void load(result.nextOffset!)}><ChevronDown size={14} />{text("更多提交", "More commits")}</button>}
      {result.diffTruncated && <p role="alert">{text("差异达到输出上限，以下内容不完整。", "Diff output limit reached; content below is incomplete.")}</p>}
      {patch?.kind === "files" && !result.diffTruncated ? <StyledDiffCodeView items={items} className="h-[480px] w-full" options={{ diffStyle: "unified" }} />
        : patch ? <><p>{patch.kind === "raw" ? patch.reason : text("截断补丁原文", "Truncated patch text")}</p><pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs">{result.diff}</pre></>
          : result.diffTruncated ? null : <p>{text("这两个Git版本之间没有文本差异。", "No textual diff between these Git versions.")}</p>}
    </>}
  </section>;
}
