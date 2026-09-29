import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  CommandId,
  MessageId,
  ThreadId,
  type ModelSelection,
  type WorkbenchRawPreparationHandoff,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  ASSIGNMENT_ROLES,
  ROLE_GUIDANCE,
  WORK_PURPOSES,
  PURPOSE_GUIDANCE,
  RETRIEVAL_GUIDANCE,
  RUN_PROMPT_FORMAT,
  type AssignmentRole,
  type WorkPurpose,
  type RecordedRunContext,
} from "@project-workbench/ui/dispatch";
import { ReviewSourceFields } from "@project-workbench/ui/review-source-fields";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { getProviderOptionDescriptors, resolvePromptInjectedEffort } from "@t3tools/shared/model";
import {
  ArrowUpRight,
  LogIn,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Square,
  Trash2,
} from "lucide-react";
import { useI18n } from "~/i18n/i18n";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useProjects, useServerConfigs, useThreadShells } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { environmentShell } from "~/state/shell";
import { threadEnvironment } from "~/state/threads";
import { vcsEnvironment } from "~/state/vcs";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "~/state/use-atom-command";
import { getAppModelOptionsForInstance } from "~/modelSelection";
import { deriveProviderInstanceEntries, isProviderInstancePickerReady } from "~/providerInstances";
import { getProviderModelCapabilities } from "~/providerModels";
import { buildThreadRouteParams } from "~/threadRoutes";
import { randomUUID } from "~/lib/utils";
import { getComposerProviderState } from "../chat/composerProviderState";
import {
  decodeDispatchState,
  decodeDispatchTarget,
  dispatchRecordedRun,
  dispatchTargetMatchesProject,
  DISPATCH_STORAGE_KEY,
  freezePromptPrefix,
  qaBasisReady,
  readPendingDispatch,
  savePendingDispatch,
  type QABasis,
  type PendingDispatch as Pending,
  type DispatchState,
  type DispatchTarget,
} from "./WorkbenchDispatch.logic";
import {
  WorkbenchWorkspacePicker,
  type WorkbenchWorkspaceSelection,
} from "./WorkbenchWorkspacePicker";
import { saveWorkbenchReturn } from "./workbenchReturn";
import type {
  ProjectBinding,
  ReviewSource,
  WorkbenchRun,
  WorkbenchRequest,
} from "./workbenchModel";
import { validateProjectBinding } from "./workbenchModel";

type Props = {
  project: string;
  taskSlug: string;
  title: string;
  runs: readonly WorkbenchRun[];
  ownerHold?: boolean;
  binding?: ProjectBinding | null | undefined;
  onChanged: () => void;
  operationRequest?: WorkbenchRequest;
};
const EMPTY_QA_BASIS: QABasis = {
  requirementDecisionIds: [],
  designDecisionIds: [],
  designSources: [],
  testPlanSources: [],
  applicability: "",
};

class DispatchHTTPError extends Error {
  constructor(
    readonly status: number,
    readonly details: unknown,
  ) {
    super(
      `HTTP ${status}: ${details && typeof details === "object" && "error" in details ? String(details.error) : "request rejected"}`,
    );
  }
}

export function WorkbenchDispatch(props: Props) {
  return <DispatchSelection key={`${props.project}:${props.taskSlug}`} {...props} />;
}

function DispatchSelection(props: Props) {
  const projects = useProjects();
  const { language } = useI18n();
  const zh = language === "zh";
  const [recovery, setRecovery] = useState(() => {
    try {
      return { pending: readPendingDispatch(localStorage), error: "" };
    } catch {
      return {
        pending: null,
        error: "Dispatch recovery record cannot be read. No new dispatch was created.",
      };
    }
  });
  const pending = recovery.pending;
  const ownPending =
    pending?.project === props.project && pending.taskSlug === props.taskSlug ? pending : null;
  const [selection, setSelection] = useState(
    ownPending ? `${ownPending.target.environmentId}:${ownPending.target.projectId}` : "",
  );
  const binding = props.binding ?? null;
  const boundKey = binding ? `${binding.environmentId}:${binding.nativeProjectId}` : null;
  const effectiveSelection = boundKey ?? selection;
  const selected = projects.find(
    (entry) => `${entry.environmentId}:${entry.id}` === effectiveSelection,
  );
  const boundProject = binding
    ? projects.find(
        (entry) =>
          entry.environmentId === binding.environmentId && entry.id === binding.nativeProjectId,
      )
    : undefined;
  const bindingDrift =
    binding &&
    (!boundProject ||
      (binding.workspaceRoot !== null && binding.workspaceRoot !== boundProject.workspaceRoot))
      ? zh
        ? "绑定的工作区已变化或不存在；解除绑定后才能重新派发"
        : "The bound workspace has changed or no longer exists; unbind the project before dispatching again"
      : null;
  const [unbindReason, setUnbindReason] = useState("");
  const [unbindBusy, setUnbindBusy] = useState(false);
  const [bindingError, setBindingError] = useState("");
  async function unbind() {
    if (unbindBusy || !unbindReason.trim()) return;
    const request = props.operationRequest ?? fetch;
    setUnbindBusy(true);
    setBindingError("");
    try {
      const response = await request(
        `/workbench-api/project-binding/${encodeURIComponent(props.taskSlug)}/revoke`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Specgraph-Project": props.project },
          body: JSON.stringify({ reason: unbindReason.trim() }),
        },
      );
      if (!response.ok) {
        const details: unknown = await response.json().catch(() => null);
        throw new Error(
          details && typeof details === "object" && "error" in details
            ? String(details.error)
            : `HTTP ${response.status}`,
        );
      }
      setUnbindReason("");
      props.onChanged();
    } catch (cause) {
      setBindingError(String(cause));
    } finally {
      setUnbindBusy(false);
    }
  }
  return (
    <section className="space-y-3 border-t py-4" data-i18n-skip>
      <h3 className="text-sm font-semibold">{zh ? "执行与分派" : "Execution and dispatch"}</h3>
      {binding ? (
        <div className="space-y-2">
          <p className="break-all">
            {zh ? "项目绑定" : "Project binding"}:{" "}
            {`${binding.environmentId} · ${binding.nativeProjectId} · ${binding.workspaceRoot ?? (zh ? "未记录" : "unrecorded")} · ${binding.actor} · ${binding.createdAt}`}
          </p>
          {!ownPending ? (
            <div className="space-y-2">
              <input
                aria-label={zh ? "解除绑定原因" : "Unbind reason"}
                className="w-full rounded border bg-background p-2"
                maxLength={4000}
                value={unbindReason}
                disabled={unbindBusy}
                onChange={(event) => setUnbindReason(event.target.value)}
              />
              <button
                type="button"
                className="wb-button"
                disabled={unbindBusy || !unbindReason.trim()}
                onClick={() => void unbind()}
              >
                {zh ? "解除项目绑定" : "Unbind project"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {bindingDrift ? <p role="alert">{bindingDrift}</p> : null}
      {bindingError ? (
        <p role="alert" className="break-words text-destructive">
          {bindingError}
        </p>
      ) : null}
      {recovery.error || (pending && !ownPending) ? (
        <p role="alert">
          {recovery.error ||
            `${zh ? "先恢复未确认请求" : "Resolve the pending request first"}: ${pending?.project} / ${pending?.taskSlug}`}
        </p>
      ) : (
        <>
          <label className="block text-sm">
            {zh ? "T3 项目" : "T3 project"}
            <select
              className="mt-1 block w-full rounded border bg-background p-2"
              value={effectiveSelection}
              disabled={!!ownPending || !!binding}
              onChange={(event) => setSelection(event.target.value)}
            >
              <option value="">{zh ? "选择项目" : "Select project"}</option>
              {projects.map((entry) => (
                <option
                  key={`${entry.environmentId}:${entry.id}`}
                  value={`${entry.environmentId}:${entry.id}`}
                >
                  {entry.title} · {entry.environmentId} · {entry.workspaceRoot}
                </option>
              ))}
            </select>
          </label>
          {binding && boundProject ? (
            <p>
              {zh
                ? "已绑定该项目；解除绑定后才能改派其他项目。"
                : "Bound to this project; unbind before dispatching to another project."}
            </p>
          ) : null}
          {selected ? (
            <DispatchForm
              key={effectiveSelection}
              {...props}
              nativeProject={selected}
              bindingDrift={bindingDrift}
              recovered={ownPending}
              onRecoveryCleared={() => setRecovery({ pending: null, error: "" })}
            />
          ) : ownPending ? (
            <p role="alert">
              {zh
                ? "原 T3 项目不可用；未改用其他项目。"
                : "The recorded T3 project is unavailable; no substitute selected."}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function DispatchForm({
  project,
  taskSlug,
  title,
  runs,
  ownerHold = false,
  binding,
  bindingDrift = null,
  onChanged,
  nativeProject,
  recovered,
  onRecoveryCleared,
  operationRequest = fetch,
}: Props & {
  nativeProject: EnvironmentProject;
  bindingDrift: string | null;
  recovered: Pending | null;
  onRecoveryCleared: () => void;
}) {
  const { language } = useI18n();
  const text = (zh: string, en: string) => (language === "zh" ? zh : en);
  const settings = useEnvironmentSettings(nativeProject.environmentId);
  const configs = useServerConfigs();
  const threads = useThreadShells();
  const config = configs.get(nativeProject.environmentId);
  const shell = useAtomValue(environmentShell.stateValueAtom(nativeProject.environmentId));
  const { presentationById } = useEnvironments();
  const connected =
    presentationById.get(nativeProject.environmentId)?.connection.phase === "connected" &&
    shell.status === "live";
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const stopSession = useAtomCommand(threadEnvironment.stopSession, { reportFailure: false });
  const readHead = useAtomCommand(vcsEnvironment.readHead, { reportFailure: false });
  const taskRuns = runs.filter(
    (run) => run.taskSlug === taskSlug && run.executorKind !== "program",
  );
  const [runId, setRunId] = useState(
    recovered ? (recovered.runId ?? "") : taskRuns.length === 1 ? taskRuns[0]!.id : "",
  );
  const [pending, setPending] = useState<Pending | null>(recovered);
  const [context, setContext] = useState<RecordedRunContext | null>(null);
  const [recordedTarget, setRecordedTarget] = useState<DispatchTarget | null>(null);
  const [dispatchState, setDispatchState] = useState<DispatchState | null>(null);
  const [newAttempt, setNewAttempt] = useState(false);
  const [workspaceSelection, setWorkspaceSelection] = useState<WorkbenchWorkspaceSelection | null>(
    recovered ? recovered.target : null,
  );
  const [assignmentRole, setAssignmentRole] = useState<AssignmentRole>("executor");
  const [workPurpose, setWorkPurpose] = useState<WorkPurpose | "">("");
  const [requirementIds, setRequirementIds] = useState("");
  const [designIds, setDesignIds] = useState("");
  const [qaDraft, setQaDraft] = useState<QABasis>(EMPTY_QA_BASIS);
  const [reviewed, setReviewed] = useState(false);
  useEffect(() => {
    setReviewed(false);
  }, [ownerHold]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");
  const [bindingWarning, setBindingWarning] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [key, setKey] = useState("");
  const [note, setNote] = useState(recovered?.abortNote ?? "");
  const [stopNote, setStopNote] = useState("");
  const [rawSummaryKind, setRawSummaryKind] = useState<"" | "progress" | "human_substitute">("");
  const [rawEventId, setRawEventId] = useState("");
  const [rawStatement, setRawStatement] = useState("");
  const [rawSources, setRawSources] = useState("");
  const [rawMissing, setRawMissing] = useState("");
  const [rawStopped, setRawStopped] = useState(false);
  const [resolutionKind, setResolutionKind] = useState<"stopped_writing" | "isolated_workspace">(
    "stopped_writing",
  );
  const scope = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const target = pending?.target ?? recordedTarget;
  const displayedPurpose = target ? (target.workPurpose ?? "") : runId ? "" : workPurpose;
  const needsQABasis = ["design", "test_design", "implementation", "test_execution"].includes(
    displayedPurpose,
  );
  const qaBasis: QABasis = {
    ...qaDraft,
    requirementDecisionIds: requirementIds.split(/[\s,]+/).filter(Boolean),
    designDecisionIds: designIds.split(/[\s,]+/).filter(Boolean),
  };
  const displayedBasis = target ? target.qaBasis : runId ? undefined : qaBasis;
  const formFrozen = busy || ownerHold || !!pending || !!recordedTarget || !!runId;
  const resolved = resolveProjectSettings(settings, nativeProject.id, nativeProject);
  const selection =
    pending?.target.modelSelection ??
    recordedTarget?.modelSelection ??
    resolved.overrides.defaultModelSelection ??
    resolved.settings.defaultModelSelection;
  const provider = deriveProviderInstanceEntries(config?.providers ?? []).find(
    (entry) => entry.instanceId === selection?.instanceId,
  );
  function selectionError(model: ModelSelection | null | undefined, effort: string | null) {
    if (!config || !connected)
      return text("T3 环境尚未实时同步。", "T3 environment is not synchronized and connected.");
    const entry = deriveProviderInstanceEntries(config.providers).find(
      (entry) => entry.instanceId === model?.instanceId,
    );
    if (!model || !entry || !isProviderInstancePickerReady(entry))
      return text(
        "原提供方不可用；未选择替代项。",
        "The exact provider is unavailable; no substitute selected.",
      );
    if (
      !getAppModelOptionsForInstance(settings, entry).some(
        (candidate) => candidate.slug === model.model && !candidate.isUnavailable,
      )
    )
      return text(
        "原模型不可用；未选择替代模型。",
        "The exact model is unavailable; no substitute selected.",
      );
    const capabilities = getProviderModelCapabilities(
      entry.models,
      model.model,
      entry.driverKind,
      settings.planModeEnabled,
    );
    const options = getProviderOptionDescriptors({ caps: capabilities });
    if (
      model.options?.some(
        (option) =>
          !options.some(
            (descriptor) =>
              descriptor.id === option.id &&
              (descriptor.type === "boolean"
                ? typeof option.value === "boolean"
                : descriptor.options.some((value) => value.id === option.value)),
          ),
      )
    )
      return text(
        "已选模型选项不受当前模型支持。",
        "A selected model option is unsupported by the current model.",
      );
    if (effort && resolvePromptInjectedEffort(capabilities, effort) !== effort)
      return text(
        "原提示词思考强度已不可用。",
        "The recorded prompt-injected effort is unavailable.",
      );
    return "";
  }
  const caps =
    provider && selection
      ? getProviderModelCapabilities(
          provider.models,
          selection.model,
          provider.driverKind,
          settings.planModeEnabled,
        )
      : null;
  const composer =
    provider && selection
      ? getComposerProviderState({
          provider: provider.driverKind,
          model: selection.model,
          models: provider.models,
          modelOptions: selection.options,
          planModeEnabled: settings.planModeEnabled,
        })
      : null;
  const dispatchOptions = pending
    ? pending.target.modelSelection.options
    : recordedTarget
      ? recordedTarget.modelSelection.options
      : composer?.modelOptionsForDispatch;
  const injectedEffort = pending
    ? pending.target.promptInjectedEffort
    : recordedTarget
      ? recordedTarget.promptInjectedEffort
      : caps && composer
        ? resolvePromptInjectedEffort(caps, composer.promptEffort)
        : null;
  const unavailable =
    bindingDrift ||
    selectionError(selection, injectedEffort) ||
    (!workspaceSelection ? text("请选择执行工作区。", "Select an execution workspace.") : null) ||
    (target && !target.workPurpose
      ? text(
          "原准备未记录工作目的，不能启动；需要新的准备。",
          "The original preparation has no recorded work purpose and cannot start; a new preparation is required.",
        )
      : null) ||
    (target?.workPurpose && !qaBasisReady(target.workPurpose, target.qaBasis)
      ? text(
          "原准备缺少适用前置依据，不能启动；需要新的准备。",
          "The original preparation lacks applicable QA basis and cannot start; a new preparation is required.",
        )
      : null) ||
    (!target && !runId && !workPurpose
      ? text("请选择本次工作目的。", "Select a work purpose.")
      : null) ||
    (!target && !runId && !qaBasisReady(workPurpose, qaBasis)
      ? text(
          "请填写适用的批准决定 ID、固定来源和本次适用范围。",
          "Provide the applicable approval decision IDs, fixed sources and applicability.",
        )
      : null);
  const reviewIdentity = JSON.stringify([
    selection,
    dispatchOptions,
    injectedEffort,
    pending?.target.runtimeMode ??
      recordedTarget?.runtimeMode ??
      resolved.settings.defaultRuntimeMode,
  ]);
  useEffect(() => {
    setReviewed(false);
  }, [reviewIdentity]);
  const latest = useRef({ selectionError, nativeProject });
  latest.current = { selectionError, nativeProject };

  async function request<T>(path: string, controller: AbortController, body?: unknown): Promise<T> {
    const response = await operationRequest(`/workbench-api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "X-Specgraph-Project": project },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    });
    controller.signal.throwIfAborted();
    if (response.status === 401) {
      setNeedsLogin(true);
      throw new Error(text("请登录后恢复原请求。", "Sign in to resume the original request."));
    }
    if (!response.ok)
      throw new DispatchHTTPError(response.status, await response.json().catch(() => null));
    return (await response.json()) as T;
  }
  async function load(id: string, controller: AbortController) {
    const stored = await request<RecordedRunContext>(
      `/loop/runs/${encodeURIComponent(id)}/context`,
      controller,
    );
    if (stored.runId !== id || stored.taskSlug !== taskSlug || !stored.packageId)
      throw new Error("Run context identity mismatch");
    const target = decodeDispatchTarget(
      (stored.body as { dispatch_target?: unknown }).dispatch_target,
    );
    if (!dispatchTargetMatchesProject(target, nativeProject))
      throw new Error("Recorded native project or workspace does not match selection");
    if (pending && JSON.stringify(target) !== JSON.stringify(pending.target))
      throw new Error("Recorded dispatch target differs from recovery plan");
    const saved = readPendingDispatch(localStorage);
    if (
      saved?.project === project &&
      saved.taskSlug === taskSlug &&
      saved.runId === id &&
      JSON.stringify(saved.target) !== JSON.stringify(target)
    )
      throw new Error("Recorded dispatch target differs from persisted recovery plan");
    controller.signal.throwIfAborted();
    setContext(stored);
    setRecordedTarget(target);
    setWorkspaceSelection(target);
    if (
      saved?.project === project &&
      saved.taskSlug === taskSlug &&
      JSON.stringify(saved.target) === JSON.stringify(target)
    ) {
      localStorage.removeItem(DISPATCH_STORAGE_KEY);
      setPending(null);
      onRecoveryCleared();
      onChanged();
    }
    const state = decodeDispatchState(
      await request(`/loop/runs/${encodeURIComponent(id)}/dispatch`, controller),
    );
    controller.signal.throwIfAborted();
    setContext(stored);
    setRecordedTarget(target);
    setDispatchState(state);
    return { context: stored, target, state };
  }
  async function useCurrentSource(
    group: "designSources" | "testPlanSources",
    index: number,
    source: Extract<ReviewSource, { kind: "specgraph" }>,
  ) {
    const controller = scope.current;
    if (!controller || formFrozen) return;
    setBusy(true);
    setReviewed(false);
    setError("");
    try {
      const body = await request<{
        kind: string;
        slug: string;
        sourceRefs?: Record<string, string>;
      }>(`/knowledge/spec/${encodeURIComponent(source.specSlug)}`, controller);
      if (body.kind !== "spec" || body.slug !== source.specSlug)
        throw new Error("Invalid source response");
      const changeId = body.sourceRefs?.[source.field];
      if (typeof changeId !== "string" || !changeId)
        throw new Error(
          text("该字段没有已记录的来源变更 ID", "No recorded source change ID for this field"),
        );
      setQaDraft((current) => ({
        ...current,
        [group]: current[group].map((row, i) => (i === index ? { ...source, changeId } : row)),
      }));
    } catch (cause) {
      if (!controller.signal.aborted) setError(String(cause));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    setContext(null);
    setRecordedTarget(null);
    setDispatchState(null);
    setReviewed(false);
    if (runId)
      void load(runId, controller).catch((cause) => {
        if (!controller.signal.aborted) setError(String(cause));
      });
    return () => controller.abort();
  }, [runId, project, taskSlug]);

  async function submit() {
    const controller = scope.current;
    if (
      !controller ||
      inFlight.current ||
      ownerHold ||
      !reviewed ||
      unavailable ||
      pending?.abortNote ||
      (!runId && !context && taskRuns.length > 0 && !pending && !newAttempt)
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setReceipt("");
    try {
      let plan = pending;
      let id = runId || context?.runId || pending?.runId || "";
      if (!id) {
        if (!plan) {
          if (!selection || !provider || !caps || !composer || !workspaceSelection)
            throw new Error("Model or workspace selection unavailable");
          if (!workPurpose) throw new Error("Work purpose must be selected");
          const baseline = await readHead({
            environmentId: nativeProject.environmentId,
            input: { cwd: workspaceSelection.workspace },
          });
          controller.signal.throwIfAborted();
          if (baseline._tag !== "Success") throw squashAtomCommandFailure(baseline);
          if (
            workspaceSelection.expectedCommitSha &&
            baseline.value.commitSha?.toLowerCase() !==
              workspaceSelection.expectedCommitSha.toLowerCase()
          ) {
            throw new Error(
              text(
                "所选工作树不在指定提交；请重新选择或从指定提交创建测试工作树。预期：",
                "The selected worktree is not at the requested commit. Select or create a testing worktree at that commit. Expected: ",
              ) +
                workspaceSelection.expectedCommitSha +
                text("；实际：", "; actual: ") +
                (baseline.value.commitSha ?? text("没有 Git 提交", "no Git commit")),
            );
          }
          const modelSelection: ModelSelection = {
            instanceId: selection.instanceId,
            model: selection.model,
            ...(composer.modelOptionsForDispatch
              ? { options: composer.modelOptionsForDispatch }
              : {}),
          };
          plan = {
            project,
            taskSlug,
            key: randomUUID(),
            target: {
              version: 1,
              promptFormatVersion: RUN_PROMPT_FORMAT,
              environmentId: nativeProject.environmentId,
              projectId: nativeProject.id,
              workspace: workspaceSelection.workspace,
              projectWorkspaceRoot: nativeProject.workspaceRoot,
              gitBaseline: baseline.value,
              threadId: ThreadId.make(randomUUID()),
              createCommandId: CommandId.make(randomUUID()),
              startCommandId: CommandId.make(randomUUID()),
              messageId: MessageId.make(randomUUID()),
              createdAt: new Date().toISOString(),
              title: title.slice(0, 160),
              modelSelection,
              runtimeMode: resolved.settings.defaultRuntimeMode,
              interactionMode: "default",
              branch: workspaceSelection.branch,
              worktreePath: workspaceSelection.worktreePath,
              promptInjectedEffort: resolvePromptInjectedEffort(caps, composer.promptEffort),
              promptPrefix: freezePromptPrefix(
                resolvePromptInjectedEffort(caps, composer.promptEffort),
              ),
              assignmentRole,
              roleGuidance: ROLE_GUIDANCE[assignmentRole],
              workPurpose,
              purposeGuidance: PURPOSE_GUIDANCE[workPurpose],
              ...(needsQABasis ? { qaBasis } : {}),
              retrievalGuidance: RETRIEVAL_GUIDANCE,
            },
          };
          savePendingDispatch(localStorage, plan);
          setPending(plan);
        }
        const prepared = await request<{ binding_id: string }>("/loop/runs", controller, {
          task_slug: taskSlug,
          workspace: plan.target.workspace,
          idempotency_key: plan.key,
          dispatch_target: plan.target,
        });
        if (typeof prepared.binding_id !== "string" || !prepared.binding_id)
          throw new Error("Invalid preparation receipt");
        id = prepared.binding_id;
        plan = { ...plan, runId: id };
        savePendingDispatch(localStorage, plan);
        setPending(plan);
        // Do not change runId here: its effect would cancel this in-flight chain.
      }
      const stored = await load(id, controller);
      if (stored.state.resolution || stored.state.cancellation || stored.state.stopConfirmation)
        throw new Error(
          "Dispatch already resolved, cancelled or confirmed stopped; this attempt cannot be resumed",
        );
      const checkCurrent = () => {
        controller.signal.throwIfAborted();
        if (!dispatchTargetMatchesProject(stored.target, latest.current.nativeProject))
          throw new Error("Recorded native project changed");
        const issue = latest.current.selectionError(
          stored.target.modelSelection,
          stored.target.promptInjectedEffort,
        );
        if (issue) throw new Error(issue);
      };
      await dispatchRecordedRun({
        project,
        context: stored.context,
        target: stored.target,
        checkCurrent,
        create: async (input) => {
          const result = await createThread({ environmentId: stored.target.environmentId, input });
          if (result._tag !== "Success")
            throw new Error(
              "Native create outcome unconfirmed. Resume with the original command identity.",
            );
        },
        bind: async () => {
          await request(`/loop/runs/${encodeURIComponent(id)}/bind`, controller, {
            thread_ref: stored.target.threadId,
            environment_id: stored.target.environmentId,
          });
        },
        authorize: async () => {
          await request(`/loop/runs/${encodeURIComponent(id)}/dispatch/authorize`, controller, {
            packageId: stored.context.packageId,
            target: stored.target,
          });
          const state = decodeDispatchState(
            await request(`/loop/runs/${encodeURIComponent(id)}/dispatch`, controller),
          );
          setDispatchState(state);
          if (state.resolution || state.cancellation || state.stopConfirmation)
            throw new Error(
              "Dispatch resolved, cancelled or confirmed stopped before native start",
            );
        },
        start: async (input) => {
          const result = await startTurn({ environmentId: stored.target.environmentId, input });
          if (result._tag !== "Success")
            throw new Error(
              "Native start outcome unconfirmed. Resume with the original command identity.",
            );
        },
      });
      setPending(null);
      setRunId(id);
      setReceipt(
        text(
          "T3 已接受命令；不代表模型已经开始执行。",
          "T3 accepted the command; this does not prove the model has started.",
        ),
      );
      if (binding === null) {
        // First confirmed dispatch establishes the project binding. A binding
        // failure never masks the completed dispatch; it is only reported.
        try {
          const recorded = await request<unknown>(
            `/project-binding/${encodeURIComponent(taskSlug)}`,
            controller,
            {
              environmentId: stored.target.environmentId,
              nativeProjectId: stored.target.projectId,
              workspaceRoot: stored.target.projectWorkspaceRoot ?? nativeProject.workspaceRoot,
              reason: `${text("首次人工审核派发", "First human-reviewed dispatch")}: ${taskSlug}`,
            },
          );
          validateProjectBinding(recorded, project);
        } catch (bindCause) {
          if (!controller.signal.aborted)
            setBindingWarning(
              text(
                "派发成功，项目绑定未记录：",
                "Dispatch succeeded; the project binding was not recorded: ",
              ) + String(bindCause),
            );
        }
      }
      onChanged();
    } catch (cause) {
      if (!controller.signal.aborted) setError(String(cause));
    } finally {
      if (!controller.signal.aborted) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  async function login() {
    const controller = scope.current;
    if (!controller || busy) return;
    setBusy(true);
    setError("");
    try {
      await request("/api/auth/login", controller, { key });
      setNeedsLogin(false);
      if (runId) await load(runId, controller);
    } catch (cause) {
      if (!controller.signal.aborted) setError(String(cause));
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        setKey("");
      }
    }
  }
  async function resolve() {
    const controller = scope.current;
    if (!controller || busy || !context || !dispatchState?.admission || !note.trim()) return;
    setBusy(true);
    setError("");
    try {
      await request(
        `/loop/runs/${encodeURIComponent(context.runId)}/dispatch/resolve`,
        controller,
        { admissionId: dispatchState.admission.id, kind: resolutionKind, note: note.trim() },
      );
      await load(context.runId, controller);
      onChanged();
    } catch (cause) {
      if (!controller.signal.aborted) setError(String(cause));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function abortPendingPreparation() {
    const controller = scope.current;
    if (!controller || busy || !pending || context || !note.trim()) return;
    const original = { ...pending, abortNote: pending.abortNote ?? note.trim() };
    setBusy(true);
    setReviewed(false);
    setError("");
    try {
      savePendingDispatch(localStorage, original);
      setPending(original);
      const result = await request<{
        idempotencyKey: string;
        runId: string | null;
        replayed: boolean;
      }>("/loop/preparations/abort", controller, {
        taskSlug,
        workspace: original.target.workspace,
        idempotencyKey: original.key,
        target: original.target,
        note: original.abortNote,
      });
      controller.signal.throwIfAborted();
      if (
        result.idempotencyKey !== original.key ||
        typeof result.replayed !== "boolean" ||
        (result.runId !== null && (typeof result.runId !== "string" || !result.runId))
      )
        throw new Error("Invalid preparation abort receipt");
      setReceipt(
        text(
          "原准备请求已封存；不是宿主停止证明。",
          "Original preparation fenced; this is not host-stop evidence.",
        ),
      );
      if (result.runId) {
        await load(result.runId, controller);
        setRunId(result.runId);
      } else {
        const saved = readPendingDispatch(localStorage);
        if (saved?.project === project && saved.taskSlug === taskSlug && saved.key === original.key)
          localStorage.removeItem(DISPATCH_STORAGE_KEY);
        setPending(null);
        onRecoveryCleared();
        setNewAttempt(true);
      }
      onChanged();
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(String(cause));
        const details = cause instanceof DispatchHTTPError ? cause.details : null;
        if (
          cause instanceof DispatchHTTPError &&
          cause.status === 428 &&
          details &&
          typeof details === "object" &&
          "idempotencyKey" in details &&
          details.idempotencyKey === original.key &&
          "runId" in details &&
          typeof details.runId === "string" &&
          details.runId
        ) {
          try {
            await load(details.runId, controller);
            setRunId(details.runId);
            onChanged();
          } catch (readError) {
            if (!controller.signal.aborted) setError(String(readError));
          }
        }
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function cancelPreparation() {
    const controller = scope.current;
    if (
      !controller ||
      busy ||
      !context ||
      !dispatchState ||
      dispatchState.admission ||
      dispatchState.cancellation ||
      !note.trim()
    )
      return;
    const rawBound = taskRuns.some((run) => run.id === context.runId && run.state === "bound");
    const lines = (value: string) =>
      value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const summary =
      rawSummaryKind === "progress" && rawEventId.trim()
        ? { kind: "progress" as const, eventId: rawEventId.trim() }
        : rawSummaryKind === "human_substitute" &&
            rawStatement.trim() &&
            lines(rawSources).length &&
            lines(rawMissing).length
          ? {
              kind: "human_substitute" as const,
              humanSubstitute: {
                statement: rawStatement.trim(),
                sourceRefs: lines(rawSources),
                missingInfo: lines(rawMissing),
              },
            }
          : null;
    if (rawBound && (!target || !rawStopped || !summary)) return;
    const rawHandoff: WorkbenchRawPreparationHandoff | undefined = rawBound
      ? { environmentId: target!.environmentId, threadId: target!.threadId, summary: summary! }
      : undefined;
    setBusy(true);
    setReviewed(false);
    setError("");
    try {
      const receipt = await request<{ recorded: boolean }>(
        `/loop/runs/${encodeURIComponent(context.runId)}/dispatch/cancel-preparation`,
        controller,
        { packageId: context.packageId, note: note.trim(), ...(rawHandoff ? { rawHandoff } : {}) },
      );
      if (receipt.recorded !== true)
        throw new Error("Invalid original preparation cancellation receipt");
      const observed = await load(context.runId, controller);
      if (
        !observed.state.cancellation ||
        observed.state.cancellation.note !== note.trim() ||
        (rawHandoff &&
          JSON.stringify(observed.state.cancellation.rawHandoff) !== JSON.stringify(rawHandoff))
      )
        throw new Error("Original cancellation evidence was not observed");
      onChanged();
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          text(
            "原取消结果未确认；请刷新原执行核对：",
            "Original cancellation outcome unconfirmed; refresh the original run: ",
          ) + String(cause),
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const nativeThread =
    target &&
    threads.find(
      (thread) =>
        thread.environmentId === target.environmentId &&
        thread.id === target.threadId &&
        thread.projectId === target.projectId,
    );
  const liveStopped =
    connected &&
    nativeThread?.session?.status === "stopped" &&
    nativeThread.session.activeTurnId === null;
  async function requestStop() {
    const controller = scope.current;
    if (
      !controller ||
      inFlight.current ||
      busy ||
      !target ||
      !nativeThread ||
      !connected ||
      !dispatchState?.admission ||
      dispatchState.stopConfirmation
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setReceipt("");
    try {
      const result = await stopSession({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      controller.signal.throwIfAborted();
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      setReceipt(
        text(
          "停止命令已受理；不代表会话已停止，请等待实时会话状态。",
          "Stop command accepted; this does not prove the session stopped. Wait for live session status.",
        ),
      );
    } catch (cause) {
      if (!controller.signal.aborted) setError(String(cause));
    } finally {
      if (!controller.signal.aborted) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  async function confirmStopped() {
    const controller = scope.current;
    if (
      !controller ||
      inFlight.current ||
      busy ||
      !context ||
      !target ||
      !dispatchState?.admission ||
      dispatchState.stopConfirmation ||
      !liveStopped ||
      !stopNote.trim() ||
      stopNote.trim().length > 4000
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setReceipt("");
    try {
      await request(
        `/loop/runs/${encodeURIComponent(context.runId)}/dispatch/confirm-stopped`,
        controller,
        {
          admissionId: dispatchState.admission.id,
          environmentId: target.environmentId,
          threadId: target.threadId,
          note: stopNote.trim(),
        },
      );
      const stored = await load(context.runId, controller);
      if (!stored.state.stopConfirmation)
        throw new Error("Stop confirmation was not returned by the run record");
      setReceipt(
        text(
          "人工停止确认已记录；不是独立宿主证明，也未使节点失效。",
          "Operator stop confirmation recorded; not independent host proof, and the node has not been abandoned.",
        ),
      );
      onChanged();
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          text(
            "停止确认结果未确认；请刷新执行记录核对：",
            "Stop confirmation outcome unconfirmed; refresh the run record to check: ",
          ) + String(cause),
        );
    } finally {
      if (!controller.signal.aborted) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <div className="space-y-3 text-sm">
      {taskRuns.length > 0 ? (
        <label className="block">
          {text("恢复原执行", "Resume recorded run")}
          <select
            className="ml-2 max-w-full rounded border bg-background p-1"
            disabled={busy || !!pending}
            value={runId || context?.runId || ""}
            onChange={(event) => {
              setRunId(event.target.value);
              setNewAttempt(false);
              setError("");
              setReceipt("");
            }}
          >
            <option value="">{text("选择原执行", "Select recorded run")}</option>
            {taskRuns.map((run) => (
              <option key={run.id} value={run.id}>
                {run.id} · {run.state}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <p className="break-all">
        {selection
          ? `${selection.instanceId} / ${selection.model}`
          : text("未配置默认模型", "No default model configured")}{" "}
        · {target?.runtimeMode ?? resolved.settings.defaultRuntimeMode}
      </p>
      <p className="break-all">
        {text("模型选项", "Model options")}:{" "}
        {dispatchOptions?.length
          ? JSON.stringify(dispatchOptions)
          : text("未指定；使用原生默认值", "Unspecified; native defaults")}
        {injectedEffort ? ` · ${injectedEffort}` : ""}
      </p>
      <WorkbenchWorkspacePicker
        nativeProject={nativeProject}
        value={workspaceSelection}
        disabled={busy || !!pending || !!recordedTarget || !!runId}
        onChange={(value) => {
          setWorkspaceSelection(value);
          setReviewed(false);
        }}
      />
      <label className="block">
        {text("本次派单职责", "Dispatch responsibility")}
        <select
          aria-label={text("本次派单职责", "Dispatch responsibility")}
          className="mt-1 block w-full rounded border bg-background p-2"
          value={target ? (target.assignmentRole ?? "") : runId ? "" : assignmentRole}
          disabled={busy || !!pending || !!recordedTarget || !!runId}
          onChange={(event) => {
            setAssignmentRole(event.target.value as AssignmentRole);
            setReviewed(false);
          }}
        >
          {(target && target.assignmentRole === undefined) || (!target && runId) ? (
            <option value="">{text("未记录职责", "No recorded responsibility")}</option>
          ) : null}
          {ASSIGNMENT_ROLES.map((role) => (
            <option key={role} value={role}>
              {
                {
                  manager: text("项目管理", "Manager"),
                  knowledge: text("知识维护", "Knowledge maintainer"),
                  executor: text("设计与执行", "Design and execution"),
                  reviewer: text("证据审核", "Reviewer"),
                }[role]
              }
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        {text("本次工作目的", "Work purpose")}
        <select
          aria-label={text("本次工作目的", "Work purpose")}
          className="mt-1 block w-full rounded border bg-background p-2"
          value={displayedPurpose}
          disabled={busy || !!pending || !!recordedTarget || !!runId}
          onChange={(event) => {
            setWorkPurpose(event.target.value as WorkPurpose | "");
            setRequirementIds("");
            setDesignIds("");
            setQaDraft(EMPTY_QA_BASIS);
            setReviewed(false);
          }}
        >
          <option value="">
            {target || runId
              ? text("未知（未记录工作目的）", "Unknown (no recorded work purpose)")
              : text("选择工作目的", "Select work purpose")}
          </option>
          {WORK_PURPOSES.map((purpose) => (
            <option key={purpose} value={purpose}>
              {
                {
                  requirements: text("需求编写", "Requirements"),
                  requirements_review: text("需求审核", "Requirements review"),
                  design: text("设计", "Design"),
                  design_review: text("设计审核", "Design review"),
                  test_design: text("测试设计", "Test design"),
                  implementation: text("代码实现", "Implementation"),
                  test_execution: text("测试执行", "Test execution"),
                  investigation: text("调查研究", "Investigation"),
                  coordination: text("组织协调", "Coordination"),
                  knowledge: text("知识维护", "Knowledge maintenance"),
                }[purpose]
              }
            </option>
          ))}
        </select>
      </label>
      {(needsQABasis || target?.qaBasis) && (
        <fieldset
          disabled={formFrozen}
          className="min-w-0 space-y-2 border-t pt-3"
          aria-label={text("工作包前置依据", "QA basis")}
        >
          <legend>{text("工作包前置依据", "QA basis")}</legend>
          {!displayedBasis ? (
            <p>{text("未记录前置依据", "No recorded QA basis")}</p>
          ) : (
            <>
              {(displayedPurpose !== "test_execution" ||
                displayedBasis.requirementDecisionIds.length > 0) && (
                <label className="block">
                  {text(
                    "需求批准决定 ID（非请求 ID）",
                    "Requirement approval decision IDs (not request IDs)",
                  )}
                  <input
                    aria-label="Requirement approval decision IDs"
                    className="block w-full rounded border bg-background p-2"
                    disabled={formFrozen}
                    value={
                      target ? displayedBasis.requirementDecisionIds.join(", ") : requirementIds
                    }
                    onChange={(event) => {
                      setRequirementIds(event.target.value);
                      setReviewed(false);
                    }}
                  />
                </label>
              )}
              {(displayedPurpose === "implementation" ||
                displayedBasis.designDecisionIds.length > 0) && (
                <label className="block">
                  {text(
                    "设计批准决定 ID（非请求 ID）",
                    "Design approval decision IDs (not request IDs)",
                  )}
                  <input
                    aria-label="Design approval decision IDs"
                    className="block w-full rounded border bg-background p-2"
                    disabled={formFrozen}
                    value={target ? displayedBasis.designDecisionIds.join(", ") : designIds}
                    onChange={(event) => {
                      setDesignIds(event.target.value);
                      setReviewed(false);
                    }}
                  />
                </label>
              )}
              {(["designSources", "testPlanSources"] as const)
                .filter(
                  (group) =>
                    displayedBasis[group].length > 0 ||
                    (group === "designSources"
                      ? displayedPurpose === "test_design"
                      : displayedPurpose === "implementation" ||
                        displayedPurpose === "test_execution"),
                )
                .map((group) => {
                  const label =
                    group === "designSources"
                      ? text("设计来源", "Design sources")
                      : text("测试计划来源", "Test plan sources");
                  return (
                    <fieldset key={group} className="min-w-0 space-y-2" aria-label={label}>
                      <legend>{label}</legend>
                      {displayedBasis[group].map((source, index) => (
                        <div key={index} className="space-y-1 border-b py-2">
                          <ReviewSourceFields
                            source={source}
                            slug={taskSlug}
                            labelPrefix={`${group} ${index + 1}`}
                            language={language}
                            disabled={formFrozen}
                            onChange={(value) => {
                              setQaDraft((current) => ({
                                ...current,
                                [group]: current[group].map((row, i) =>
                                  i === index ? value : row,
                                ),
                              }));
                              setReviewed(false);
                            }}
                          />
                          {source.kind === "specgraph" && (
                            <button
                              type="button"
                              className="wb-button"
                              disabled={
                                formFrozen || !source.specSlug.trim() || !source.field.trim()
                              }
                              onClick={() => void useCurrentSource(group, index, source)}
                            >
                              <RefreshCw size={14} />
                              {text("采用当前已记录来源", "Use recorded current source")}
                            </button>
                          )}
                          <button
                            type="button"
                            className="wb-button"
                            disabled={formFrozen}
                            aria-label={`${text("删除", "Remove")} ${label} ${index + 1}`}
                            onClick={() => {
                              setQaDraft((current) => ({
                                ...current,
                                [group]: current[group].filter((_, i) => i !== index),
                              }));
                              setReviewed(false);
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="wb-button"
                        disabled={formFrozen}
                        aria-label={`${text("添加", "Add")} ${label}`}
                        onClick={() => {
                          setQaDraft((current) => ({
                            ...current,
                            [group]: [
                              ...current[group],
                              { kind: "specgraph", specSlug: taskSlug, field: "", changeId: "" },
                            ],
                          }));
                          setReviewed(false);
                        }}
                      >
                        <Plus size={14} />
                      </button>
                    </fieldset>
                  );
                })}
              <label className="block">
                {text("本次适用范围", "Applicability to this work")}
                <textarea
                  aria-label="QA applicability"
                  className="block w-full rounded border bg-background p-2"
                  disabled={formFrozen}
                  maxLength={4000}
                  value={displayedBasis.applicability}
                  onChange={(event) => {
                    setQaDraft((current) => ({ ...current, applicability: event.target.value }));
                    setReviewed(false);
                  }}
                />
              </label>
            </>
          )}
        </fieldset>
      )}
      {unavailable ? <p role="alert">{unavailable}</p> : null}
      {error ? (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      ) : null}
      {receipt ? <p role="status">{receipt}</p> : null}
      {bindingWarning ? <p role="alert">{bindingWarning}</p> : null}
      {context ? (
        <button
          type="button"
          className="wb-button"
          disabled={busy}
          onClick={async () => {
            const controller = scope.current;
            if (!controller) return;
            setBusy(true);
            setError("");
            try {
              await load(context.runId, controller);
            } catch (cause) {
              if (!controller.signal.aborted) setError(String(cause));
            } finally {
              if (!controller.signal.aborted) setBusy(false);
            }
          }}
        >
          <RefreshCw size={14} />
          {text("刷新执行记录", "Refresh run record")}
        </button>
      ) : null}
      {needsLogin ? (
        <div className="flex flex-wrap gap-2">
          <input
            aria-label={text("访问密钥", "Access key")}
            type="password"
            value={key}
            autoComplete="off"
            onChange={(event) => setKey(event.target.value)}
          />
          <button
            type="button"
            className="wb-button"
            disabled={busy || !key}
            onClick={() => void login()}
          >
            <LogIn size={14} />
            {text("登录", "Sign in")}
          </button>
        </div>
      ) : null}
      {ownerHold && (
        <p role="status">
          {text(
            "该节点有人工负责人或待接手；不可新建或继续派发。原执行读取、停止及释放仍可操作。",
            "This node has a human owner or pending takeover; no new or resumed dispatch. Original run read, stop and release remain available.",
          )}
        </p>
      )}
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={reviewed}
          disabled={busy || ownerHold}
          onChange={(event) => setReviewed(event.target.checked)}
        />
        <span>
          {text(
            "确认以上项目、现有目录、模型及权限设置，并派发当前任务。",
            "Confirm the project, existing checkout, model and permission settings for this task.",
          )}
        </span>
      </label>
      <button
        type="button"
        className="wb-button"
        disabled={
          busy ||
          ownerHold ||
          !reviewed ||
          !!unavailable ||
          !!pending?.abortNote ||
          (!runId && !context && taskRuns.length > 0 && !pending && !newAttempt) ||
          (runId !== "" && !context) ||
          !!dispatchState?.resolution ||
          !!dispatchState?.cancellation ||
          !!dispatchState?.stopConfirmation
        }
        onClick={() => void submit()}
      >
        {pending || runId || context ? <RefreshCw size={14} /> : <Play size={14} />}
        {pending || runId || context
          ? text("恢复原派发", "Resume original dispatch")
          : text("创建并派发", "Create and dispatch")}
      </button>
      {pending && !context ? (
        <div className="space-y-2 border-t pt-3">
          <input
            aria-label={text("封存原请求原因", "Original request abort reason")}
            maxLength={4000}
            value={note}
            disabled={busy || !!pending.abortNote}
            onChange={(event) => setNote(event.target.value)}
          />
          <button
            type="button"
            className="wb-button"
            disabled={busy || !note.trim()}
            onClick={() => void abortPendingPreparation()}
          >
            <ShieldCheck size={14} />
            {text("封存原准备请求", "Fence original preparation")}
          </button>
        </div>
      ) : null}
      {dispatchState?.resolution ||
      dispatchState?.cancellation ||
      dispatchState?.stopConfirmation ? (
        <button
          type="button"
          className="wb-button"
          disabled={busy || ownerHold}
          onClick={() => {
            setNewAttempt(true);
            setRunId("");
            setContext(null);
            setRecordedTarget(null);
            setDispatchState(null);
            setAssignmentRole("executor");
            setWorkPurpose("");
            setRequirementIds("");
            setDesignIds("");
            setQaDraft(EMPTY_QA_BASIS);
            setReviewed(false);
            setReceipt("");
            setError("");
          }}
        >
          <Play size={14} />
          {text("审核新的执行尝试", "Review a new attempt")}
        </button>
      ) : null}
      {dispatchState?.cancellation ? (
        <div className="space-y-1">
          <p>
            {text(
              "准备已取消（不表示宿主停止）",
              "Preparation cancelled (not a host-stop assertion)",
            )}{" "}
            · {dispatchState.cancellation.actor} · {dispatchState.cancellation.note}
          </p>
          {dispatchState.cancellation.rawHandoff && (
            <pre className="overflow-auto whitespace-pre-wrap break-words text-xs">
              {JSON.stringify(dispatchState.cancellation.rawHandoff, null, 2)}
            </pre>
          )}
        </div>
      ) : null}
      {context && dispatchState && !dispatchState.admission && !dispatchState.cancellation ? (
        <div className="space-y-2 border-t pt-3">
          {taskRuns.some((run) => run.id === context.runId && run.state === "bound") && (
            <fieldset className="space-y-2" disabled={busy}>
              <legend>{text("原raw绑定交接", "Original raw binding handoff")}</legend>
              <p className="break-all">
                {target?.environmentId} / {target?.threadId}
              </p>
              <label>
                {text("原事实或人工补述", "Original fact or human substitute")}
                <select
                  aria-label="Raw handoff summary kind"
                  value={rawSummaryKind}
                  onChange={(event) =>
                    setRawSummaryKind(event.target.value as typeof rawSummaryKind)
                  }
                >
                  <option value="">-</option>
                  <option value="progress">{text("原进展事件", "Original progress event")}</option>
                  <option value="human_substitute">{text("人工补述", "Human substitute")}</option>
                </select>
              </label>
              {rawSummaryKind === "progress" && (
                <label>
                  {text("原进展事件 ID", "Original progress event ID")}
                  <input
                    aria-label="Raw handoff progress event ID"
                    className="block w-full"
                    value={rawEventId}
                    onChange={(event) => setRawEventId(event.target.value)}
                  />
                </label>
              )}
              {rawSummaryKind === "human_substitute" && (
                <>
                  <label>
                    {text("人工补述", "Human statement")}
                    <textarea
                      aria-label="Raw handoff statement"
                      className="block w-full"
                      value={rawStatement}
                      onChange={(event) => setRawStatement(event.target.value)}
                    />
                  </label>
                  <label>
                    {text("依据来源，每行一条", "Source references, one per line")}
                    <textarea
                      aria-label="Raw handoff source references"
                      className="block w-full"
                      value={rawSources}
                      onChange={(event) => setRawSources(event.target.value)}
                    />
                  </label>
                  <label>
                    {text("缺失信息，每行一条", "Missing information, one per line")}
                    <textarea
                      aria-label="Raw handoff missing information"
                      className="block w-full"
                      value={rawMissing}
                      onChange={(event) => setRawMissing(event.target.value)}
                    />
                  </label>
                </>
              )}
              <label className="flex items-start gap-2">
                <input
                  aria-label="Confirm original raw stopped"
                  type="checkbox"
                  checked={rawStopped}
                  onChange={(event) => setRawStopped(event.target.checked)}
                />
                {text("我已核实原raw执行停止", "I verified the original raw execution stopped")}
              </label>
            </fieldset>
          )}
          <input
            aria-label={
              taskRuns.some((run) => run.id === context.runId && run.state === "bound")
                ? text("原raw停止说明", "Original raw stop explanation")
                : text("取消准备原因", "Preparation cancellation reason")
            }
            maxLength={4000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <button
            type="button"
            className="wb-button"
            disabled={
              busy ||
              !note.trim() ||
              (taskRuns.some((run) => run.id === context.runId && run.state === "bound") &&
                (!rawStopped ||
                  (rawSummaryKind === "progress" && !rawEventId.trim()) ||
                  (rawSummaryKind === "human_substitute" &&
                    (!rawStatement.trim() || !rawSources.trim() || !rawMissing.trim())) ||
                  !rawSummaryKind))
            }
            onClick={() => void cancelPreparation()}
          >
            <ShieldCheck size={14} />
            {text("取消未获准的准备", "Cancel unadmitted preparation")}
          </button>
        </div>
      ) : null}
      {target ? (
        <Link
          className="inline-flex items-center gap-1"
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams({
            environmentId: target.environmentId,
            threadId: target.threadId,
          })}
          onClick={saveWorkbenchReturn}
        >
          <ArrowUpRight size={14} />
          {text("查看 T3 原会话", "Open original T3 session")}
        </Link>
      ) : null}
      {dispatchState?.admission && target && (
        <section
          className="space-y-2 border-t pt-3"
          aria-label={text("停止原执行", "Stop original execution")}
        >
          {dispatchState.stopConfirmation ? (
            <p className="break-words">
              {text("人工停止确认", "Operator stop confirmation")} ·{" "}
              {dispatchState.stopConfirmation.actor} · {dispatchState.stopConfirmation.confirmedAt}{" "}
              · {dispatchState.stopConfirmation.note}
            </p>
          ) : (
            <>
              <p>
                {text("原会话实时状态", "Original session live status")}:{" "}
                {connected
                  ? (nativeThread?.session?.status ?? text("未知", "Unknown"))
                  : text("未实时连接，不能确认停止", "Not live; cannot confirm stopped")}
              </p>
              <button
                type="button"
                className="wb-button"
                disabled={busy || !connected || !nativeThread}
                onClick={() => void requestStop()}
              >
                <Square size={14} />
                {text("请求停止原会话", "Request original session stop")}
              </button>
              <label>
                {text("停止确认依据", "Stop confirmation note")}
                <textarea
                  className="block w-full rounded border bg-background p-2"
                  maxLength={4000}
                  value={stopNote}
                  disabled={busy}
                  onChange={(event) => setStopNote(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="wb-button"
                disabled={busy || !liveStopped || !stopNote.trim()}
                onClick={() => void confirmStopped()}
              >
                <ShieldCheck size={14} />
                {text("记录停止确认", "Record stop confirmation")}
              </button>
            </>
          )}
        </section>
      )}
      {dispatchState?.admission ? (
        <div className="space-y-2 border-t pt-3">
          <p>
            {text("准入记录（不代表模型启动）", "Admission record (not model-start evidence)")}:{" "}
            {dispatchState.admission.id} · {dispatchState.admission.actor}
          </p>
          {dispatchState.resolution ? (
            <p className="break-words">
              {dispatchState.resolution.kind} · {dispatchState.resolution.actor} ·{" "}
              {dispatchState.resolution.note}
            </p>
          ) : (
            <>
              <label className="block">
                {text(
                  "人工确认写入状态（不是宿主证明）",
                  "Human assertion of writing state (not host proof)",
                )}
                <select
                  className="ml-2 rounded border bg-background p-1"
                  value={resolutionKind}
                  onChange={(event) =>
                    setResolutionKind(event.target.value as typeof resolutionKind)
                  }
                >
                  <option value="stopped_writing">{text("已停止写入", "Stopped writing")}</option>
                  <option value="isolated_workspace">
                    {text("已隔离工作区", "Workspace isolated")}
                  </option>
                </select>
              </label>
              <input
                className="w-full rounded border bg-background p-2"
                aria-label={text("确认依据", "Assertion evidence")}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <button
                type="button"
                className="wb-button"
                disabled={busy || !note.trim()}
                onClick={() => void resolve()}
              >
                <ShieldCheck size={14} />
                {text("记录人工确认", "Record human assertion")}
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
