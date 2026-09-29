import { useEffect, useRef, useState, type FormEvent } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ClipboardCheck, RefreshCw } from "lucide-react";
import { useI18n } from "~/i18n/i18n";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import type { WorkbenchRequest, WorkbenchRun } from "./workbenchModel";

export function WorkbenchDeliverySubmission({ project, environmentId, run, onChanged, request = fetch }: {
  project: string; environmentId: EnvironmentId; run: WorkbenchRun; onChanged: () => void; request?: WorkbenchRequest;
}) {
  const { language } = useI18n();
  const text = (zh: string, en: string) => language === "zh" ? zh : en;
  const readHead = useAtomCommand(vcsEnvironment.readHead, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [receipt, setReceipt] = useState("");
  const inFlight = useRef(false);
  const scope = useRef<AbortController | null>(null);
  useEffect(() => { const controller = new AbortController(); scope.current = controller; return () => controller.abort(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const controller = scope.current;
    if (!controller || inFlight.current || uncertain || receipt || !summary.trim()) return;
    inFlight.current = true; setBusy(true); setError("");
    let sent = false;
    try {
      if (needsLogin) {
        const login = await request("/workbench-api/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }), signal: controller.signal });
        if (!login.ok) throw new Error(text("登录失败：", "Sign-in failed: ") + login.status);
        controller.signal.throwIfAborted(); setNeedsLogin(false);
      }
      const head = await readHead({ environmentId, input: { cwd: run.workspace } });
      controller.signal.throwIfAborted();
      if (head._tag !== "Success") throw squashAtomCommandFailure(head);
      sent = true;
      const response = await request("/workbench-api/loop/deliveries", { method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-Specgraph-Project": project },
        body: JSON.stringify({ run_binding_id: run.id, snapshot: { summary: summary.trim(), git: {
          workspace: run.workspace, baseline: run.gitBaseline ?? null, head: head.value, uncommittedContentIncluded: false,
        } } }),
      });
      controller.signal.throwIfAborted();
      if (!response.ok) {
        if (response.status === 401) setNeedsLogin(true);
        if (response.status >= 500) setUncertain(true);
        const body = await response.json();
        setError(body.error || text("交付未记录：", "Delivery not recorded: ") + response.status); return;
      }
      const body = await response.json();
      if (typeof body.delivery_id !== "string" || !body.delivery_id) throw new Error("Invalid delivery receipt");
      setReceipt(body.delivery_id); onChanged();
    } catch (cause) {
      if (!controller.signal.aborted) { setUncertain(sent); setError((sent ? text("结果未确认，请先查看交付列表。", "Result unconfirmed; inspect deliveries before retrying. ") : "") + String(cause)); }
    } finally { inFlight.current = false; if (!controller.signal.aborted) { setKey(""); setBusy(false); } }
  }

  if (!open) return <button className="wb-button" type="button" onClick={() => { if (receipt) { setReceipt(""); setSummary(""); } setOpen(true); }}><ClipboardCheck size={14} />{text("记录交付", "Record delivery")}</button>;
  return <form className="space-y-2 border-t py-3" aria-label={text("记录交付", "Record delivery")} onSubmit={(event) => void submit(event)}>
    <label>{text("交付说明", "Delivery summary")}<textarea className="block w-full rounded border bg-background p-2" required maxLength={4000} value={summary} disabled={busy || uncertain || !!receipt} onChange={(event) => setSummary(event.target.value)} /></label>
    <p className="text-xs">{text("Git引用只包含已提交版本，不保存未提交文件内容；交付记录不等于验收通过。", "Git references cover committed versions only, not uncommitted file content. Recording delivery is not acceptance.")}</p>
    {needsLogin && <label>{text("SpecGraph 操作凭据", "SpecGraph operator credential")}<input type="password" autoComplete="off" required value={key} disabled={busy} onChange={(event) => setKey(event.target.value)} /></label>}
    {error && <p role="alert">{error}</p>}
    {receipt ? <p role="status" className="break-all">{text("已记录", "Recorded")}: {receipt}</p> : uncertain
      ? <button className="wb-button" type="button" onClick={onChanged}><RefreshCw size={14} />{text("刷新交付记录", "Refresh deliveries")}</button>
      : <button className="wb-button" type="submit" disabled={busy || !summary.trim()}><ClipboardCheck size={14} />{text("提交交付记录", "Submit delivery record")}</button>}
    <button className="wb-button" type="button" disabled={busy} onClick={() => setOpen(false)}>{text("关闭", "Close")}</button>
  </form>;
}
