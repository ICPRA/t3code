import { useEffect, useRef, useState } from "react";
import { EnvironmentId, ProjectId, WorkbenchProgramStatus, WorkbenchProgramLoopHistory, WorkbenchProgramLoopEvent, type WorkbenchProgramRun } from "@t3tools/contracts";
import { WORK_PURPOSES, type WorkPurpose } from "@project-workbench/ui/dispatch";
import { ReviewSourceFields } from "@project-workbench/ui/review-source-fields";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { Check, LogIn, Play, Plus, RefreshCw, ShieldCheck, Square, Trash2 } from "lucide-react";
import { useI18n } from "~/i18n/i18n";
import { useProjects } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { workbenchProgramEnvironment } from "~/state/workbenchProgram";
import { randomUUID } from "~/lib/utils";
import { qaBasisReady, type QABasis } from "./WorkbenchDispatch.logic";
import { decodeProgramCommand, parseProgramArgs, programCanComplete, readPendingProgram, readProgramReceipt, PROGRAM_STORAGE_KEY, type ProgramCommand, type PendingProgram } from "./WorkbenchProgram.logic";
import type { ReviewSource, WorkbenchRequest, WorkbenchRun } from "./workbenchModel";

const EMPTY_BASIS: QABasis = { requirementDecisionIds: [], designDecisionIds: [], designSources: [], testPlanSources: [], applicability: "" };
const decodeProgramStatus = Schema.decodeUnknownSync(WorkbenchProgramStatus);
const decodeLoopHistory = Schema.decodeUnknownSync(WorkbenchProgramLoopHistory);
const decodeLoopEvent = Schema.decodeUnknownSync(WorkbenchProgramLoopEvent);
const decodeLoopCodes = Schema.decodeUnknownSync(Schema.Array(Schema.Int));
type Props = { project: string; taskSlug: string; title: string; ownerHold?: boolean; onChanged: () => void; operationRequest?: WorkbenchRequest };
class ProgramHTTPError extends Error {
  constructor(readonly status: number, readonly details: unknown) { super(`HTTP ${status}: ${JSON.stringify(details)}`); }
}

export function WorkbenchProgram(props: Props) {
  return <ProgramForm key={`${props.project}:${props.taskSlug}`} {...props} />;
}

function ProgramForm({ project, taskSlug, ownerHold = false, onChanged, operationRequest = fetch }: Props) {
  const { language } = useI18n();
  const text = (zh: string, en: string) => language === "zh" ? zh : en;
  const projects = useProjects();
  const [recovery, setRecovery] = useState(() => {
    try { return { pending: readPendingProgram(localStorage), error: "" }; }
    catch { return { pending: null, error: "Program recovery record cannot be read. No new request was created." }; }
  });
  const pending = recovery.pending;
  const own = pending?.project === project && pending.taskSlug === taskSlug ? pending : null;
  const [selection, setSelection] = useState(own ? `${own.command.environmentId}:${own.command.nativeProjectId}` : "");
  const native = projects.find((entry) => `${entry.environmentId}:${entry.id}` === selection);
  const [executable, setExecutable] = useState(own?.command.executable ?? "");
  const [args, setArgs] = useState(JSON.stringify(own?.command.args ?? []));
  const [cwd, setCwd] = useState(own?.command.cwd ?? "");
  const [timeout, setTimeout] = useState(String(own?.command.timeoutMs ?? 60000));
  const [purpose, setPurpose] = useState<WorkPurpose | "">(own?.command.workPurpose ?? "");
  const [basis, setBasis] = useState<QABasis>(own?.command.qaBasis ?? EMPTY_BASIS);
  const [complete, setComplete] = useState(own?.command.completeOnSuccess ?? false);
  const [loopKind, setLoopKind] = useState<"" | "mechanical" | "innovative">(own?.command.loop?.kind ?? "");
  const [terminationKind, setTerminationKind] = useState<"exit_code" | "judgment">(own?.command.loop?.termination.kind ?? "exit_code");
  const [stopCode, setStopCode] = useState(String(own?.command.loop?.termination.exitCode?.stopCode ?? 0));
  const [continueCodes, setContinueCodes] = useState(JSON.stringify(own?.command.loop?.termination.exitCode?.continueCodes ?? []));
  const [criterion, setCriterion] = useState(own?.command.loop?.termination.judgment?.criterion ?? "");
  const [maxAttempts, setMaxAttempts] = useState(String(own?.command.loop?.maxAttempts ?? ""));
  const [synchronousBasis, setSynchronousBasis] = useState(own?.command.loop?.synchronousCompletionBasis ?? "");
  const [confirmedIdentity, setConfirmedIdentity] = useState<string | null>(null);
  useEffect(() => { setConfirmedIdentity(null); }, [ownerHold]);
  const [prepared, setPrepared] = useState<WorkbenchProgramRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [credential, setCredential] = useState("");
  const scope = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  useEffect(() => { const controller = new AbortController(); scope.current = controller; return () => controller.abort(); }, []);
  const reviewIdentity = JSON.stringify([selection, executable, args, cwd, timeout, purpose, basis, complete,
    loopKind, terminationKind, stopCode, continueCodes, criterion, maxAttempts, synchronousBasis]);
  const confirmed = confirmedIdentity === reviewIdentity;
  const frozen = busy || ownerHold || !!own;
  const needsBasis = ["design", "test_design", "implementation", "test_execution"].includes(purpose);
  let command: ProgramCommand | null = null;
  let invalid = "";
  try {
    let loop: ProgramCommand["loop"];
    if (loopKind) {
      const basisText = synchronousBasis.trim();
      if (!basisText || new TextEncoder().encode(synchronousBasis).length > 4000 || synchronousBasis.includes("\0")) throw new Error("Invalid synchronous completion basis");
      const max = maxAttempts.trim() ? Number(maxAttempts) : undefined;
      if ((loopKind === "innovative" && max === undefined) || (max !== undefined && (!Number.isSafeInteger(max) || max <= 0))) throw new Error("Invalid maximum attempts");
      let termination: NonNullable<ProgramCommand["loop"]>["termination"];
      if (terminationKind === "exit_code") {
        const stop = Number(stopCode);
        const codes = decodeLoopCodes(JSON.parse(continueCodes));
        if (!stopCode.trim() || !Number.isInteger(stop) || stop < -2147483648 || stop > 4294967295 ||
          codes.some((code) => code < -2147483648 || code > 4294967295) || new Set([stop, ...codes]).size !== codes.length + 1) throw new Error("Invalid exit codes");
        termination = { kind: "exit_code", exitCode: { stopCode: stop, continueCodes: codes } };
      } else {
        if (!criterion.trim() || new TextEncoder().encode(criterion).length > 4000 || criterion.includes("\0")) throw new Error("Invalid judgment criterion");
        termination = { kind: "judgment", judgment: { criterion: criterion.trim() } };
      }
      loop = { kind: loopKind, termination, ...(max === undefined ? {} : { maxAttempts: max }), synchronousCompletionBasis: basisText };
    }
    if (native && purpose) command = decodeProgramCommand({ executable: executable.trim(), args: parseProgramArgs(args), cwd: cwd.trim(),
      environmentId: native.environmentId, nativeProjectId: native.id, timeoutMs: Number(timeout), workPurpose: purpose,
      completeOnSuccess: complete, ...(needsBasis ? { qaBasis: basis } : {}), ...(loop ? { loop } : {}) });
    else invalid = text("请选择真实 T3 项目和工作目的。", "Select a real T3 project and work purpose.");
  } catch { invalid = text("请填写有效的命令、JSON 参数及循环设置。", "Provide a valid command, JSON arguments and loop settings."); }
  if (command && !qaBasisReady(command.workPurpose, command.qaBasis)) invalid = text("请填写适用的批准决定、固定来源和适用范围。", "Provide applicable approval decisions, fixed sources and applicability.");

  async function request(path: string, body?: unknown) {
    const controller = scope.current!;
    const response = await operationRequest(`/workbench-api${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "X-Specgraph-Project": project }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]), cache: "no-store" });
    controller.signal.throwIfAborted();
    if (response.status === 401) setNeedsLogin(true);
    if (!response.ok) throw new ProgramHTTPError(response.status, await response.json());
    return response.json() as Promise<unknown>;
  }
  async function prepare() {
    if (inFlight.current || busy || ownerHold || !confirmed || !native || (!own && (invalid || !command)) || own?.runId) return;
    inFlight.current = true; setBusy(true); setError("");
    let plan = own;
    const uncertainBefore = !!own && !own.rejected;
    try {
      if (!plan) {
        if (readPendingProgram(localStorage)) throw new Error("Resolve the original program request first");
        plan = { project, taskSlug, key: randomUUID(), command: command! };
        localStorage.setItem(PROGRAM_STORAGE_KEY, JSON.stringify(plan));
        setRecovery({ pending: plan, error: "" });
      }
      if (plan.rejected) {
        const { rejected: _rejected, ...original } = plan;
        plan = original;
        localStorage.setItem(PROGRAM_STORAGE_KEY, JSON.stringify(plan));
        setRecovery({ pending: plan, error: "" });
      }
      const result = readProgramReceipt(await request("/loop/program-runs", { taskSlug, idempotencyKey: plan.key, command: plan.command }),
        { taskSlug, environmentId: plan.command.environmentId, nativeProjectId: plan.command.nativeProjectId }, plan.command);
      const saved: PendingProgram = { ...plan, runId: result.run.context.runId, packageId: result.run.context.packageId };
      localStorage.setItem(PROGRAM_STORAGE_KEY, JSON.stringify(saved));
      setRecovery({ pending: saved, error: "" }); setPrepared(result.run); setConfirmedIdentity(null); onChanged();
    } catch (cause) {
      if (!scope.current!.signal.aborted) {
        if (plan && !uncertainBefore && cause instanceof ProgramHTTPError && [400, 401, 403, 404, 409, 428].includes(cause.status) &&
          !(cause.details && typeof cause.details === "object" && "runId" in cause.details)) {
          const rejected = { ...plan, rejected: true as const };
          localStorage.setItem(PROGRAM_STORAGE_KEY, JSON.stringify(rejected)); setRecovery({ pending: rejected, error: "" });
        }
        setError(String(cause));
      }
    }
    finally { inFlight.current = false; if (!scope.current!.signal.aborted) setBusy(false); }
  }
  async function login() {
    if (inFlight.current || !credential) return;
    inFlight.current = true; setBusy(true); setError("");
    try { await request("/api/auth/login", { key: credential }); setCredential(""); setNeedsLogin(false); }
    catch (cause) { if (!scope.current!.signal.aborted) setError(String(cause)); }
    finally { inFlight.current = false; if (!scope.current!.signal.aborted) setBusy(false); }
  }
  async function pinSource(group: "designSources" | "testPlanSources", index: number, source: Extract<ReviewSource, { kind: "specgraph" }>) {
    if (busy || frozen) return;
    setBusy(true); setError(""); setConfirmedIdentity(null);
    try {
      const result = await request(`/knowledge/spec/${encodeURIComponent(source.specSlug)}`) as { kind: string; slug: string; sourceRefs?: Record<string, string> };
      if (result.kind !== "spec" || result.slug !== source.specSlug) throw new Error("Invalid source response");
      const changeId = result.sourceRefs?.[source.field];
      if (typeof changeId !== "string" || !changeId.trim()) throw new Error("No recorded source change ID for this field");
      setBasis((current) => ({ ...current, [group]: current[group].map((row, i) => i === index ? { ...source, changeId } : row) }));
    } catch (cause) { if (!scope.current!.signal.aborted) setError(String(cause)); }
    finally { if (!scope.current!.signal.aborted) setBusy(false); }
  }
  const row: WorkbenchRun | null = own?.runId ? { id: own.runId, taskSlug, packageId: prepared?.context.packageId ?? own.packageId ?? "", generation: 0,
    executorKind: "program", environmentId: own.command.environmentId, nativeProjectId: own.command.nativeProjectId, threadRef: "",
    workspace: own.command.cwd, workPurpose: own.command.workPurpose, state: prepared?.state ?? "unknown", createdAt: prepared?.context.createdAt ?? "", updatedAt: "" } : null;
  return <section className="space-y-3 border-t py-4 text-sm" data-i18n-skip>
    <h3 className="text-sm font-semibold">{text("程序执行", "Program execution")}</h3>
    {recovery.error || (pending && !own) ? <p role="alert">{recovery.error || `${text("先恢复原程序请求", "Resolve the original program request first")}: ${pending?.project} / ${pending?.taskSlug}`}</p> : <>
      <fieldset disabled={frozen} className="min-w-0 space-y-3">
        <label className="block">{text("T3 项目", "T3 project")}<select aria-label="Program T3 project" className="mt-1 block w-full rounded border bg-background p-2" value={selection} onChange={(event) => {
          setSelection(event.target.value); const entry = projects.find((candidate) => `${candidate.environmentId}:${candidate.id}` === event.target.value); setCwd(entry?.workspaceRoot ?? "");
        }}><option value="">{text("选择项目", "Select project")}</option>{projects.map((entry) => <option key={`${entry.environmentId}:${entry.id}`} value={`${entry.environmentId}:${entry.id}`}>{entry.title} · {entry.environmentId} · {entry.workspaceRoot}</option>)}</select></label>
        <label className="block">{text("可执行文件", "Executable")}<input aria-label="Program executable" className="block w-full rounded border bg-background p-2" value={executable} onChange={(event) => setExecutable(event.target.value)} /></label>
        <label className="block">{text("参数（JSON 字符串数组）", "Arguments (JSON string array)")}<textarea aria-label="Program arguments" className="block w-full rounded border bg-background p-2 font-mono" value={args} onChange={(event) => setArgs(event.target.value)} /></label>
        <label className="block">{text("工作目录（非沙箱）", "Working directory (not a sandbox)")}<input aria-label="Program cwd" className="block w-full rounded border bg-background p-2" value={cwd} onChange={(event) => setCwd(event.target.value)} /></label>
        <label className="block">{text("超时（毫秒）", "Timeout (milliseconds)")}<input aria-label="Program timeout" type="number" min={1} step={1} className="block w-full rounded border bg-background p-2" value={timeout} onChange={(event) => setTimeout(event.target.value)} /></label>
        <label className="block">{text("工作目的", "Work purpose")}<select aria-label="Program work purpose" className="block w-full rounded border bg-background p-2" value={purpose} onChange={(event) => {
          setPurpose(event.target.value as WorkPurpose | ""); setBasis(EMPTY_BASIS); setComplete(false);
        }}><option value="">{text("选择工作目的", "Select work purpose")}</option>{WORK_PURPOSES.map((value) => <option key={value} value={value}>{({
          requirements: text("需求编写", "Requirements"), requirements_review: text("需求审核", "Requirements review"), design: text("设计", "Design"), design_review: text("设计审核", "Design review"),
          test_design: text("测试设计", "Test design"), implementation: text("代码实现", "Implementation"), test_execution: text("测试执行", "Test execution"), investigation: text("调查研究", "Investigation"), coordination: text("组织协调", "Coordination"), knowledge: text("知识维护", "Knowledge maintenance"),
        })[value]}</option>)}</select></label>
        {needsBasis ? <fieldset className="min-w-0 space-y-2 border-t pt-3" aria-label="Program QA basis"><legend>{text("工作包前置依据", "QA basis")}</legend>
          {purpose !== "test_execution" ? <label className="block">{text("需求批准决定 ID（非请求 ID）", "Requirement approval decision IDs (not request IDs)")}<input aria-label="Program requirement decision IDs" className="block w-full rounded border bg-background p-2" value={basis.requirementDecisionIds.join(", ")} onChange={(event) => setBasis({ ...basis, requirementDecisionIds: event.target.value.split(/[\s,]+/).filter(Boolean) })} /></label> : null}
          {purpose === "implementation" ? <label className="block">{text("设计批准决定 ID（非请求 ID）", "Design approval decision IDs (not request IDs)")}<input aria-label="Program design decision IDs" className="block w-full rounded border bg-background p-2" value={basis.designDecisionIds.join(", ")} onChange={(event) => setBasis({ ...basis, designDecisionIds: event.target.value.split(/[\s,]+/).filter(Boolean) })} /></label> : null}
          {(["designSources", "testPlanSources"] as const).filter((group) => group === "designSources" ? purpose === "test_design" : purpose === "implementation" || purpose === "test_execution").map((group) => <fieldset key={group} className="min-w-0 space-y-2"><legend>{group === "designSources" ? text("设计来源", "Design sources") : text("测试计划来源", "Test plan sources")}</legend>
            {basis[group].map((source, index) => <div key={index} className="space-y-1 border-b py-2">
              <ReviewSourceFields source={source} slug={taskSlug} language={language} labelPrefix={`program ${group} ${index + 1}`} disabled={frozen} onChange={(value) => setBasis({ ...basis, [group]: basis[group].map((row, i) => i === index ? value : row) })} />
              {source.kind === "specgraph" ? <button type="button" className="wb-button" disabled={!source.specSlug.trim() || !source.field.trim()} onClick={() => void pinSource(group, index, source)}><RefreshCw size={14} />{text("采用当前已记录来源", "Use recorded current source")}</button> : null}
              <button type="button" className="wb-button" aria-label={`Remove program ${group} ${index + 1}`} onClick={() => setBasis({ ...basis, [group]: basis[group].filter((_, i) => i !== index) })}><Trash2 size={14} /></button>
            </div>)}
            <button type="button" className="wb-button" aria-label={`Add program ${group}`} onClick={() => setBasis({ ...basis, [group]: [...basis[group], { kind: "specgraph", specSlug: taskSlug, field: "", changeId: "" }] })}><Plus size={14} /></button>
          </fieldset>)}
          <label className="block">{text("本次适用范围", "Applicability")}<textarea aria-label="Program QA applicability" className="block w-full rounded border bg-background p-2" maxLength={4000} value={basis.applicability} onChange={(event) => setBasis({ ...basis, applicability: event.target.value })} /></label>
        </fieldset> : null}
        <label className="flex items-start gap-2"><input aria-label="Program complete on success" type="checkbox" disabled={!programCanComplete(purpose)} checked={complete} onChange={(event) => setComplete(event.target.checked)} /><span>{text("约定正常退出 0 后经原完成检查结束本节点", "Agree to complete this node after a normal exit 0 and the existing completion checks")}</span></label>
        <fieldset className="min-w-0 space-y-2 border-t pt-3" aria-label="Program loop settings"><legend>{text("程序循环", "Program loop")}</legend>
          <label className="block">{text("执行模式", "Execution mode")}<select aria-label="Program loop mode" className="block w-full rounded border bg-background p-2" value={loopKind} onChange={(event) => setLoopKind(event.target.value as typeof loopKind)}>
            <option value="">{text("单次", "Single run")}</option><option value="mechanical">{text("机械循环", "Mechanical loop")}</option><option value="innovative">{text("创新循环", "Innovative loop")}</option>
          </select></label>
          {loopKind ? <>
            <label className="block">{text("终止条件", "Termination condition")}<select aria-label="Program loop termination" className="block w-full rounded border bg-background p-2" value={terminationKind} onChange={(event) => setTerminationKind(event.target.value as typeof terminationKind)}>
              <option value="exit_code">{text("退出码", "Exit code")}</option><option value="judgment">{text("语义判断（人工或授权 PM）", "Judgment (human or authorized PM)")}</option>
            </select></label>
            {terminationKind === "exit_code" ? <>
              <label className="block">{text("停止退出码", "Stop exit code")}<input aria-label="Program loop stop code" type="number" min={-2147483648} max={4294967295} step={1} className="block w-full rounded border bg-background p-2" value={stopCode} onChange={(event) => setStopCode(event.target.value)} /></label>
              <label className="block">{text("继续退出码（JSON 整数数组；其他退出码为未知）", "Continue exit codes (JSON integer array; other codes are unknown)")}<textarea aria-label="Program loop continue codes" className="block w-full rounded border bg-background p-2 font-mono" value={continueCodes} onChange={(event) => setContinueCodes(event.target.value)} /></label>
            </> : <label className="block">{text("满意结果标准", "Satisfactory result criterion")}<textarea aria-label="Program loop criterion" maxLength={4000} className="block w-full rounded border bg-background p-2" value={criterion} onChange={(event) => setCriterion(event.target.value)} /></label>}
            <label className="block">{loopKind === "innovative" ? text("最大尝试次数", "Maximum attempts") : text("最大尝试次数（可选）", "Maximum attempts (optional)")}<input aria-label="Program loop max attempts" type="number" min={1} step={1} className="block w-full rounded border bg-background p-2" value={maxAttempts} onChange={(event) => setMaxAttempts(event.target.value)} /></label>
            <label className="block">{text("同步完成依据（授权记录，非机器证明）", "Synchronous completion basis (authorization record, not machine proof)")}<textarea aria-label="Program loop synchronous completion basis" maxLength={4000} className="block w-full rounded border bg-background p-2" value={synchronousBasis} onChange={(event) => setSynchronousBasis(event.target.value)} /></label>
          </> : null}
        </fieldset>
      </fieldset>
      {purpose && !programCanComplete(purpose) ? <p>{text("此目的仅登记程序结果；无程序成果完成路径，不能替代来源审核或代码 QA。", "This purpose records program results only; no program completion path. Source review and code QA are not replaced.")}</p> : null}
      {invalid && !own ? <p role="status">{invalid}</p> : null}
      {own && !native ? <p role="alert">{text("原 T3 项目不可用；未选择其他项目。", "The original T3 project is unavailable; no substitute selected.")}</p> : null}
      {error ? <p role="alert" className="break-words text-destructive">{error}</p> : null}
      {needsLogin ? <div className="flex flex-wrap gap-2"><input aria-label="Program access key" type="password" autoComplete="off" value={credential} onChange={(event) => setCredential(event.target.value)} /><button type="button" className="wb-button" disabled={busy || !credential} onClick={() => void login()}><LogIn size={14} />{text("登录", "Sign in")}</button></div> : null}
      {!own?.runId ? <>
        {ownerHold && <p role="status">{text("该节点有人工负责人或待接手；不可准备或启动新程序，原程序读取、取消仍可操作。", "This node has a human owner or pending takeover; no new program preparation or start. Original program read and cancellation remain available.")}</p>}
        <label className="flex items-start gap-2"><input aria-label="Confirm program preparation" type="checkbox" checked={confirmed} disabled={busy || ownerHold} onChange={(event) => setConfirmedIdentity(event.target.checked ? reviewIdentity : null)} /><span>{text("确认以上固定命令、参数、目录、目的及循环设置；此操作仅准备，不启动。", "Confirm the fixed command, arguments, directory, purpose and loop settings. Prepare only, without starting.")}</span></label>
        <button type="button" className="wb-button" disabled={busy || ownerHold || !confirmed || !native || (!own && !!invalid)} onClick={() => void prepare()}><ShieldCheck size={14} />{own ? text("恢复原程序准备", "Resume original program preparation") : text("准备程序", "Prepare program")}</button>
        {own?.rejected ? <button type="button" className="wb-button" disabled={busy} onClick={() => { localStorage.removeItem(PROGRAM_STORAGE_KEY); setRecovery({ pending: null, error: "" }); setConfirmedIdentity(null); setError(""); }}><RefreshCw size={14} />{text("修改已明确拒绝的准备", "Revise rejected preparation")}</button> : null}
      </> : <>
        <p role="status">{text("准备已确认，尚未因此启动", "Preparation confirmed; this does not start the program")}: {own.runId}</p>
        {row ? <WorkbenchProgramRunRow key={own.runId} run={row} project={project} onChanged={onChanged} request={operationRequest} ownerHold={ownerHold} {...(prepared ? { initialRun: prepared } : {})} /> : null}
        <button type="button" className="wb-button" onClick={() => { localStorage.removeItem(PROGRAM_STORAGE_KEY); setRecovery({ pending: null, error: "" }); setPrepared(null); setConfirmedIdentity(null); }}><Check size={14} />{text("关闭已确认准备（记录保留）", "Close confirmed preparation (run retained)")}</button>
      </>}
    </>}
  </section>;
}

type RowProps = { run: WorkbenchRun; project: string; ownerHold?: boolean; onChanged: () => void; request?: WorkbenchRequest; initialRun?: WorkbenchProgramRun };
export function WorkbenchProgramRunRow(props: RowProps) {
  return <ProgramRunRow key={`${props.project}:${props.run.id}`} {...props} />;
}

function ProgramRunRow({ run, project, ownerHold = false, onChanged, request = fetch, initialRun }: RowProps) {
  const { language } = useI18n();
  const text = (zh: string, en: string) => language === "zh" ? zh : en;
  const projects = useProjects();
  const native = projects.find((entry) => entry.environmentId === run.environmentId && entry.id === run.nativeProjectId);
  const start = useAtomCommand(workbenchProgramEnvironment.workbenchProgramStartCommand, { reportFailure: false });
  const cancel = useAtomCommand(workbenchProgramEnvironment.workbenchProgramCancelCommand, { reportFailure: false });
  const read = useAtomCommand(workbenchProgramEnvironment.workbenchProgramReadCommand, { reportFailure: false });
  const complete = useAtomCommand(workbenchProgramEnvironment.workbenchProgramCompleteCommand, { reportFailure: false });
  const [status, setStatus] = useState<(Omit<WorkbenchProgramStatus, "running"> & { running?: boolean }) | null>(initialRun ? { run: initialRun } : null);
  const [core, setCore] = useState<WorkbenchProgramRun | null>(initialRun ?? null);
  const [history, setHistory] = useState<typeof WorkbenchProgramLoopHistory.Type | null>(null);
  const [loopValue, setLoopValue] = useState<"true" | "false" | "unknown">("unknown");
  const [loopBasis, setLoopBasis] = useState("");
  const [stopReason, setStopReason] = useState("");
  const [loopUnconfirmed, setLoopUnconfirmed] = useState(false);
  const [pendingJudgment, setPendingJudgment] = useState<{ runId: string; attemptId: string; expectedJudgmentId: string | null; value: "true" | "false" | "unknown"; basis: string; receiptId?: string } | null>(null);
  const [retryJudgment, setRetryJudgment] = useState(false);
  const [loopMessage, setLoopMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [startUnknown, setStartUnknown] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => { setConfirmed(false); }, [ownerHold]);
  const [note, setNote] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [credential, setCredential] = useState("");
  const [preparationCancelled, setPreparationCancelled] = useState(false);
  const scope = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  useEffect(() => { const controller = new AbortController(); scope.current = controller; return () => controller.abort(); }, []);
  let target: ProgramCommand | null = null;
  let scopeError = "";
  if (!native || run.executorKind !== "program") scopeError = text("原程序环境或 T3 项目缺失；未猜测其他项目。", "The original program environment or T3 project is missing; no substitute guessed.");
  else if (status) {
    try { target = readProgramReceipt(status.run, { runId: run.id, taskSlug: run.taskSlug, environmentId: native.environmentId, nativeProjectId: native.id }).target; }
    catch (cause) { scopeError = String(cause); }
  }
  const canRetryResult = !!status?.resultWriteError && status.running === false && !!status.run.dispatch.admission;
  async function operate(action: "read" | "start" | "cancel" | "complete", retryResult = false) {
    if (inFlight.current || busy || !native || scopeError || (action === "start" && (retryResult ? !canRetryResult : ownerHold || !confirmed || startUnknown || !status || !!status.run.dispatch.admission))) return;
    inFlight.current = true; setBusy(true); setError(""); setConfirmed(false);
    try {
      const result = await ({ read, start, cancel, complete })[action]({ environmentId: EnvironmentId.make(native.environmentId), input: { project, nativeProjectId: ProjectId.make(native.id), runId: run.id } });
      scope.current!.signal.throwIfAborted();
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      const next = decodeProgramStatus(result.value);
      readProgramReceipt(next.run, { runId: run.id, taskSlug: run.taskSlug, environmentId: native.environmentId, nativeProjectId: native.id,
        authorizedByUserId: run.programLoop?.authorizedByUserId ?? (core ? String((core.context.body.program_target as Record<string, unknown>).authorizedByUserId) : undefined),
        hostConsumerUserId: core ? String((core.context.body.program_target as Record<string, unknown>).hostConsumerUserId) : undefined }, target ?? undefined);
      setStatus(next); setCore(next.run); setStartUnknown(false); onChanged();
    } catch (cause) {
      if (!scope.current!.signal.aborted) {
        if (action === "start" && !retryResult) setStartUnknown(true);
        setError(`${text("操作结果未确认；请读取原记录核对", "Operation outcome unconfirmed; read the original record to reconcile")}: ${String(cause)}`);
      }
    } finally { inFlight.current = false; if (!scope.current!.signal.aborted) setBusy(false); }
  }
  async function humanRequest(path: string, body: unknown) {
    const controller = scope.current!;
    const response = await request(`/workbench-api${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Specgraph-Project": project }, body: JSON.stringify(body),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
    controller.signal.throwIfAborted();
    if (response.status === 401) { setNeedsLogin(true); throw new Error("Sign in to resume the original request"); }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(await response.json())}`);
    return response.json() as Promise<unknown>;
  }
  async function readLoop(more = false) {
    if (inFlight.current || busy) return;
    inFlight.current = true; setBusy(true); setError("");
    if (pendingJudgment) setRetryJudgment(false);
    try {
      const get = async (suffix: string) => {
        const response = await request(`/workbench-api/loop/program-runs/${encodeURIComponent(run.id)}/loop${suffix}`, { headers: { "X-Specgraph-Project": project }, cache: "no-store",
          signal: AbortSignal.any([scope.current!.signal, AbortSignal.timeout(15000)]) });
        scope.current!.signal.throwIfAborted();
        if (response.status === 401) setNeedsLogin(true);
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(await response.json())}`);
        return response.json();
      };
      const receipt = await get("") as { run: unknown };
      const checked = readProgramReceipt(receipt.run, { runId: run.id, taskSlug: run.taskSlug, environmentId: run.environmentId ?? "", nativeProjectId: run.nativeProjectId ?? "",
        authorizedByUserId: run.programLoop?.authorizedByUserId ?? (core ? String((core.context.body.program_target as Record<string, unknown>).authorizedByUserId) : undefined),
        hostConsumerUserId: core ? String((core.context.body.program_target as Record<string, unknown>).hostConsumerUserId) : undefined }, core ? decodeProgramCommand(core.context.body.program_target) : undefined);
      if (!checked.target.loop) throw new Error("The original run has no loop policy");
      const cursors = new URLSearchParams({ attemptCursor: more ? history!.nextAttemptCursor : "", eventCursor: more ? history!.nextEventCursor : "" });
      const page = await get(`/history?${cursors}`) as { history: unknown };
      const next = decodeLoopHistory(page.history);
      if (next.events.some((event) => event.runId !== run.id)) throw new Error("Program loop history scope mismatch");
      setCore(checked.run);
      const combined = more && history ? { ...next,
        nextAttemptCursor: history.nextAttemptCursor ? next.nextAttemptCursor : "", nextEventCursor: history.nextEventCursor ? next.nextEventCursor : "",
        attempts: history.nextAttemptCursor ? [...history.attempts, ...next.attempts] : history.attempts,
        events: history.nextEventCursor ? [...history.events, ...next.events] : history.events } : next;
      setHistory(combined);
      if (pendingJudgment) {
        const successor = combined.events.find((event) => event.kind === "condition" && event.attemptId === pendingJudgment.attemptId &&
          (event.predecessorId ?? null) === pendingJudgment.expectedJudgmentId);
        if (successor) {
          if (successor.value !== pendingJudgment.value || successor.reason !== pendingJudgment.basis ||
            (pendingJudgment.receiptId && successor.id !== pendingJudgment.receiptId)) {
            setError(text("同一前驱已记录不同判断；原请求保持冻结。", "A different judgment was recorded for the same predecessor; the original request remains frozen."));
          } else {
            setPendingJudgment(null); setRetryJudgment(false); setLoopUnconfirmed(false);
            setLoopMessage(text("已观察到对应判断；历史记录显示实际记录者。", "Matching judgment observed; history shows the actual recorder."));
          }
        } else if (!combined.nextEventCursor) {
          if (!pendingJudgment.receiptId && checked.run.currentAttempt?.id === pendingJudgment.attemptId &&
            (checked.run.loopState?.condition?.judgmentId ?? null) === pendingJudgment.expectedJudgmentId) {
            setRetryJudgment(true);
            setError(text("尚无匹配判断；仅可明确重试原请求。", "No matching judgment yet; only the original request may be explicitly retried."));
          } else setError(text("原判断结果与当前记录冲突；保持冻结。", "Original judgment conflicts with the current record; controls remain frozen."));
        }
      } else if (!combined.nextAttemptCursor && !combined.nextEventCursor) setLoopUnconfirmed(false);
    } catch (cause) { if (!scope.current!.signal.aborted) setError(String(cause)); }
    finally { inFlight.current = false; if (!scope.current!.signal.aborted) setBusy(false); }
  }
  async function controlLoop(action: "decision" | "stop", retryOriginal = false) {
    if (inFlight.current || busy || (loopUnconfirmed && !retryOriginal) || (action === "decision" ?
      retryOriginal ? !pendingJudgment || !retryJudgment : !canJudge || !loopBasis.trim()
      : !hasLoop || !stopReason.trim() || !!core?.loopState?.stop)) return;
    const judgment = action === "decision" ? retryOriginal ? pendingJudgment! : { runId: run.id, attemptId: core!.currentAttempt!.id,
      expectedJudgmentId: core?.loopState?.condition?.judgmentId ?? null, value: loopValue, basis: loopBasis.trim() } : null;
    const submittedReason = judgment?.basis ?? stopReason.trim();
    if (new TextEncoder().encode(submittedReason).length > 4000 || submittedReason.includes("\0")) {
      setError(text("依据或原因不能超过4000个UTF-8字节，也不能包含空字符。", "Basis or reason must not exceed 4000 UTF-8 bytes or contain a null character."));
      return;
    }
    inFlight.current = true; setBusy(true); setError(""); setLoopMessage("");
    try {
      const event = decodeLoopEvent(await humanRequest(`/loop/program-loops/${action}`, action === "decision"
        ? judgment : { runId: run.id, reason: stopReason.trim() }));
      if (event.runId !== run.id || event.kind !== (action === "decision" ? "condition" : "stop") ||
        (action === "decision" && (event.attemptId !== judgment!.attemptId || event.value !== judgment!.value || event.reason !== judgment!.basis ||
          (event.predecessorId ?? null) !== judgment!.expectedJudgmentId ||
          event.actorUserId !== String((stored!.context.body.program_target as Record<string, unknown>).authorizedByUserId))) ||
        (action === "stop" && event.reason !== stopReason.trim())) throw new Error("Program loop control receipt mismatch");
      if (judgment) { setPendingJudgment({ ...judgment, receiptId: event.id }); setRetryJudgment(false); }
      setLoopMessage(action === "stop" ? text("已记录停止后续迭代（不是进程立即停止或责任释放证明）", "Future iterations stopped (not proof of immediate process stop or release of responsibility)") : text("已记录本次判断；请读取原循环核对", "Attempt judgment recorded; read the original loop to reconcile"));
      setLoopUnconfirmed(true); onChanged();
    } catch (cause) {
      if (!scope.current!.signal.aborted) { if (judgment) { setPendingJudgment(judgment); setRetryJudgment(false); }
        setLoopUnconfirmed(true); setError(`${text("人工操作结果未确认；先读取原循环及历史，不自动重试", "Human operation outcome unconfirmed; read the original loop and history before any retry")}: ${String(cause)}`); }
    } finally { inFlight.current = false; if (!scope.current!.signal.aborted) setBusy(false); }
  }
  async function cancelPreparation() {
    const packageId = status?.run.context.packageId || run.packageId;
    if (inFlight.current || busy || !packageId || status?.run.dispatch.admission || !note.trim()) return;
    inFlight.current = true; setBusy(true); setError("");
    let accepted = false;
    try { await humanRequest(`/loop/runs/${encodeURIComponent(run.id)}/dispatch/cancel-preparation`, { packageId, note: note.trim() }); accepted = true; setPreparationCancelled(true); onChanged(); }
    catch (cause) { if (!scope.current!.signal.aborted) setError(String(cause)); }
    finally { inFlight.current = false; if (!scope.current!.signal.aborted) setBusy(false); }
    if (accepted && !scope.current!.signal.aborted && native && !scopeError) await operate("read");
  }
  async function login() {
    if (inFlight.current || busy || !credential) return;
    inFlight.current = true; setBusy(true); setError("");
    try { await humanRequest("/api/auth/login", { key: credential }); setCredential(""); setNeedsLogin(false); }
    catch (cause) { if (!scope.current!.signal.aborted) setError(String(cause)); }
    finally { inFlight.current = false; if (!scope.current!.signal.aborted) setBusy(false); }
  }
  const stored = core ?? status?.run;
  const loopTarget = stored ? decodeProgramCommand(stored.context.body.program_target) : null;
  const hasLoop = !!run.programLoop || !!loopTarget?.loop;
  const canJudge = loopTarget?.loop?.termination.kind === "judgment" && !!stored?.currentAttempt && !!stored.result;
  const result = stored?.result;
  const canCancelPreparation = !preparationCancelled && (stored?.state ?? run.state) === "prepared" && !!(stored?.context.packageId || run.packageId) && !stored?.dispatch.admission && !stored?.dispatch.cancellation;
  const canStart = !!stored && canCancelPreparation && !startUnknown;
  const canComplete = !!target?.completeOnSuccess && programCanComplete(target.workPurpose) && (!target.loop || stored?.loopState?.condition?.value === "true") && !stored?.loopState?.stop && result?.outcome === "exited" && result.exitCode === 0 && !result.timedOutAt && !result.cancelRequestedAt && stored?.state !== "completed";
  const outcome = result ? result.outcome === "exited" ? result.exitCode === null ? text("退出码未确认", "Exit code unconfirmed") : result.exitCode === 0 ? text("退出码 0（不是测试通过证明）", "Exit code 0 (not proof of tests passing)") : `${text("非零退出", "Non-zero exit")}: ${result.exitCode}` : ({ timed_out: text("超时", "Timed out"), cancel_requested: text("已请求取消", "Cancellation requested"), unconfirmed: text("结果未确认", "Unconfirmed result") })[result.outcome] : text("尚无已登记结果", "No recorded result");
  return <div className="min-w-0 space-y-2 border-t py-3 text-sm" data-i18n-skip>
    <p className="break-all">{text("程序记录", "Program run")}: {run.id} · {run.taskSlug}</p>
    <p>{text("数据库执行状态", "Database run state")}: {preparationCancelled ? "preparation_cancelled" : stored?.state ?? run.state}</p>
    {preparationCancelled ? <p role="status">{text("准备已取消（不是宿主停止证明）", "Preparation cancelled (not host-stop evidence)")}</p> : null}
    {status ? <>
      <p>{text("此宿主执行器状态", "This host runner state")}: {status.running === undefined ? text("未读取", "Not read") : status.running ? text("运行中", "Running") : text("无活跃执行器（不证明进程树停止）", "No active runner (not proof the process tree stopped)")}</p>
      {target ? <dl className="space-y-1 break-all"><dt>{text("固定命令", "Fixed command")}</dt><dd className="font-mono">{target.executable} {JSON.stringify(target.args)}</dd><dt>{text("工作目录 / 超时 / 目的", "Directory / timeout / purpose")}</dt><dd>{target.cwd} · {target.timeoutMs} ms · {target.workPurpose} · {target.environmentId} / {target.nativeProjectId}</dd></dl> : null}
      <p>{outcome}</p>
      {result?.summary ? <p className="whitespace-pre-wrap break-words">{result.summary}</p> : null}
      {result?.timedOutAt ? <p>{text("超时请求时间（不是进程树停止证明）", "Timeout requested (not proof the process tree stopped)")}: {result.timedOutAt}</p> : null}
      {result?.cancelRequestedAt ? <p>{text("取消请求时间（不是进程树停止证明）", "Cancellation requested (not proof the process tree stopped)")}: {result.cancelRequestedAt}</p> : null}
      {status.resultWriteError ? <p role="alert">{text("结果登记失败", "Result write failed")}: {status.resultWriteError}</p> : null}
      {status.completionError ? <p role="alert">{text("节点完成失败（退出结果保留）", "Node completion failed (exit result retained)")}: {status.completionError}</p> : null}
      {status.loopError ? <p role="alert">{text("循环推进失败（已记录事实保留）", "Loop advancement failed (recorded facts retained)")}: {status.loopError}</p> : null}
      {target && !programCanComplete(target.workPurpose) ? <p>{text("仅登记结果；此目的没有程序完成路径。", "Record-only; this purpose has no program completion path.")}</p> : null}
    </> : null}
    {scopeError ? <p role="alert" className="break-words text-destructive">{scopeError}</p> : null}
    {error ? <p role="alert" className="break-words text-destructive">{error}</p> : null}
    {hasLoop ? <section className="space-y-2 border-t pt-2" aria-label="Program loop control">
      <p>{text("循环状态", "Loop state")}: {stored?.loopState?.status ?? run.programLoop?.status} · {text("已准入次数", "Admitted attempts")}: {stored?.currentAttempt?.ordinal ?? run.programLoop?.attemptOrdinal ?? 0} / {loopTarget?.loop?.maxAttempts ?? run.programLoop?.maxAttempts ?? text("未设上限", "Unbounded")}</p>
      <p>{text("原授权人", "Original authorizer")}: {stored ? String((stored.context.body.program_target as Record<string, unknown>).authorizedByUserId) : run.programLoop?.authorizedByUserId}</p>
      {(stored?.loopState?.status ?? run.programLoop?.status) === "needs_human" ? <p>{text("次数耗尽，需要人工判断", "Attempts exhausted; human judgment required")}</p> : null}
      <button type="button" className="wb-button" disabled={busy} onClick={() => void readLoop()}><RefreshCw size={14} />{text("读取原循环及历史", "Read original loop and history")}</button>
      {loopTarget?.loop ? <>
        <p className="break-all font-mono">{loopTarget.executable} {JSON.stringify(loopTarget.args)} · {loopTarget.cwd} · {loopTarget.timeoutMs} ms · {loopTarget.workPurpose}</p>
        {loopTarget.qaBasis ? <p className="whitespace-pre-wrap break-words">{text("固定工作依据", "Fixed QA basis")}: {JSON.stringify(loopTarget.qaBasis)}</p> : null}
        <p>{text("终止条件", "Termination condition")}: {loopTarget.loop.termination.kind === "judgment" ? loopTarget.loop.termination.judgment?.criterion : JSON.stringify(loopTarget.loop.termination.exitCode)}</p>
        <p className="whitespace-pre-wrap break-words">{text("同步完成依据", "Synchronous completion basis")}: {loopTarget.loop.synchronousCompletionBasis}</p>
        <p>{text("当前准入记录", "Current attempt")}: {stored?.currentAttempt?.id ?? text("无", "None")} · {text("条件值", "Condition value")}: {stored?.loopState?.condition?.value ?? text("未判断", "Not judged")}</p>
        {loopTarget.loop.termination.kind === "judgment" && <p>{text("当前最新判断", "Latest judgment")}: {stored?.loopState?.condition?.judgmentId ?? text("未记录", "Not recorded")} · {text("纠正追加新判断，不改写原记录", "Corrections append a new judgment; original records remain")}</p>}
        {(stored?.completion ?? stored?.loopState?.completion) && <p>{text("原完成消费依据", "Original completion consumed")}: {(stored?.completion ?? stored?.loopState?.completion)!.eventId} · {text("准入记录", "Attempt")}: {(stored?.completion ?? stored?.loopState?.completion)!.attemptId ?? text("未记录", "Not recorded")} · {text("判断", "Judgment")}: {(stored?.completion ?? stored?.loopState?.completion)!.judgmentId ?? text("未记录", "Not recorded")}</p>}
      </> : null}
      {history ? <div aria-label="Program loop history" className="space-y-1 break-words">
        {history.attempts.map((attempt) => <p key={attempt.id}>{attempt.ordinal} · {attempt.id} · {attempt.grantedAt} · {text("消费前轮判断", "Consumed prior judgment")}: {attempt.consumedJudgmentId ?? text("未记录", "Not recorded")} · {attempt.result ? JSON.stringify(attempt.result) : text("尚无结果", "No result")}</p>)}
        {history.events.map((event) => <p key={event.id}>{event.id} · {event.attemptId} · {event.kind} · {event.value} · {text("前一判断", "Previous judgment")}: {event.predecessorId ?? text("无", "None")} · {event.actorUserId} · {event.recordedAt} · {event.reason}</p>)}
        {history.nextAttemptCursor || history.nextEventCursor ? <button type="button" className="wb-button" disabled={busy} onClick={() => void readLoop(true)}><Plus size={14} />{text("读取更多循环历史", "Read more loop history")}</button> : null}
      </div> : null}
      {canJudge ? <>
        <p>{text("依据当前所见最新判断提交；若期间已有新判断，原请求会冲突而非覆盖。", "Submit against the latest judgment shown above; concurrent changes conflict rather than overwrite it.")}</p>
        {(stored?.state === "completed" || stored?.loopState?.status === "completed") && <p>{text("完成后更正仅追加判断事实，不撤销原完成，也不启动新迭代。", "A correction after completion only appends a judgment fact; it does not undo completion or start another attempt.")}</p>}
        {stored?.loopState?.stop && <p>{text("停止后更正仅追加判断事实，不恢复后续迭代。", "A correction after a stop only appends a judgment fact; future iterations remain stopped.")}</p>}
        <label className="block">{text("本次判断", "Attempt judgment")}<select aria-label="Program loop judgment" value={loopValue} disabled={busy || loopUnconfirmed} onChange={(event) => setLoopValue(event.target.value as typeof loopValue)} className="block rounded border bg-background p-2"><option value="unknown">unknown</option><option value="false">false</option><option value="true">true</option></select></label>
        <label className="block">{text("判断依据", "Judgment basis")}<textarea aria-label="Program loop judgment basis" value={loopBasis} disabled={busy || loopUnconfirmed} onChange={(event) => setLoopBasis(event.target.value)} className="block w-full rounded border bg-background p-2" /></label>
        <button type="button" className="wb-button" disabled={busy || loopUnconfirmed || !loopBasis.trim()} onClick={() => void controlLoop("decision")}><Check size={14} />{text("提交当前准入记录的判断", "Record current attempt judgment")}</button>
      </> : null}
      {pendingJudgment && retryJudgment ? <button type="button" className="wb-button" disabled={busy} onClick={() => void controlLoop("decision", true)}><RefreshCw size={14} />{text("明确重试原判断", "Explicitly retry original judgment")}</button> : null}
      {!stored?.loopState?.stop ? <>
        <label className="block">{text("停止后续迭代原因", "Reason to stop future iterations")}<textarea aria-label="Program loop stop reason" value={stopReason} disabled={busy || loopUnconfirmed} onChange={(event) => setStopReason(event.target.value)} className="block w-full rounded border bg-background p-2" /></label>
        <button type="button" className="wb-button" disabled={busy || loopUnconfirmed || !stopReason.trim()} onClick={() => void controlLoop("stop")}><Square size={14} />{text("停止后续迭代", "Stop future iterations")}</button>
      </> : null}
      {loopMessage ? <p role="status">{loopMessage}</p> : null}
      {loopUnconfirmed ? <p>{text("继续操作前，先读取原循环及历史核对。", "Read the original loop and history before another operation.")}</p> : null}
    </section> : null}
    <button type="button" className="wb-button" disabled={busy || !!scopeError} onClick={() => void operate("read")}><RefreshCw size={14} />{text("读取 / 刷新程序记录", "Read / refresh program run")}</button>
    {canRetryResult ? <button type="button" className="wb-button" disabled={busy || !!scopeError} onClick={() => void operate("start", true)}><RefreshCw size={14} />{text("重试结果登记（不重新执行）", "Retry result recording (no re-execution)")}</button> : null}
    {canStart ? <>
      {ownerHold && <p role="status">{text("该节点有人工负责人或待接手，原程序不能启动。", "This node has a human owner or pending takeover; the original program cannot be started.")}</p>}
      <label className="flex items-start gap-2"><input aria-label="Confirm program start" type="checkbox" disabled={busy || ownerHold || !!scopeError} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>{text("明确启动以上已授权固定命令", "Explicitly start the authorized fixed command")}</span></label>
      <button type="button" className="wb-button" disabled={busy || ownerHold || !confirmed || !!scopeError} onClick={() => void operate("start")}><Play size={14} />{text("启动程序", "Start program")}</button>
    </> : null}
    {canCancelPreparation ? <>
      <label className="block">{text("取消准备原因", "Preparation cancellation reason")}<input aria-label="Program preparation cancellation reason" className="block w-full rounded border bg-background p-2" maxLength={4000} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} /></label>
      <button type="button" className="wb-button" disabled={busy || !note.trim()} onClick={() => void cancelPreparation()}><ShieldCheck size={14} />{text("取消未准入程序准备", "Cancel unadmitted program preparation")}</button>
    </> : null}
    {status?.running ? <button type="button" className="wb-button" disabled={busy || !!scopeError} onClick={() => void operate("cancel")}><Square size={14} />{text("请求取消程序（不证明进程树停止）", "Request program cancellation (not proof the process tree stopped)")}</button> : null}
    {canComplete ? <button type="button" className="wb-button" disabled={busy || !!scopeError} onClick={() => void operate("complete")}><Check size={14} />{text("按原约定重试节点完成（不重启程序）", "Retry node completion under the original agreement (no restart)")}</button> : null}
    {needsLogin ? <div className="flex flex-wrap gap-2"><input aria-label="Program cancellation access key" type="password" autoComplete="off" value={credential} onChange={(event) => setCredential(event.target.value)} /><button type="button" className="wb-button" disabled={busy || !credential} onClick={() => void login()}><LogIn size={14} />{text("登录", "Sign in")}</button></div> : null}
  </div>;
}
