import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, type WorkbenchProgramRun, type WorkbenchProgramStatus } from "@t3tools/contracts";
import { WORK_PURPOSES } from "@project-workbench/ui/dispatch";
import type { WorkbenchRun } from "./workbenchModel";
import { parseProgramArgs, PROGRAM_STORAGE_KEY, readProgramReceipt, type ProgramCommand } from "./WorkbenchProgram.logic";

const mocks = vi.hoisted(() => ({ start: vi.fn(), cancel: vi.fn(), read: vi.fn(), complete: vi.fn(), request: vi.fn(), available: true }));
vi.mock("~/i18n/i18n", () => ({ useI18n: () => ({ language: "en" }) }));
vi.mock("~/state/entities", () => ({ useProjects: () => mocks.available ? [{ id: "native", environmentId: "local", title: "Native project", workspaceRoot: "C:/project" }] : [] }));
vi.mock("~/state/workbenchProgram", () => ({ workbenchProgramEnvironment: { workbenchProgramStartCommand: "start", workbenchProgramCancelCommand: "cancel", workbenchProgramReadCommand: "read", workbenchProgramCompleteCommand: "complete" } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: (command: keyof typeof mocks) => mocks[command] }));
import { WorkbenchProgram, WorkbenchProgramRunRow } from "./WorkbenchProgram";

let renderer: ReactTestRenderer | undefined;
let storage: Map<string, string>;
const command: ProgramCommand = { executable: "synthetic.exe", args: ["", "a b", "  "], cwd: "C:/project", environmentId: EnvironmentId.make("local"), nativeProjectId: ProjectId.make("native"), timeoutMs: 5000, workPurpose: "investigation", completeOnSuccess: false };
const metadata: WorkbenchRun = { id: "run", taskSlug: "task", packageId: "package", generation: 1, threadRef: "", executorKind: "program", environmentId: "local", nativeProjectId: "native", workspace: "C:/project", state: "prepared", createdAt: "now", updatedAt: "now" };
function program(target = command): WorkbenchProgramRun {
  const { completeOnSuccess, ...rest } = target;
  return { context: { runId: "run", taskSlug: "task", packageId: "package", createdAt: "now", body: { program_target: { ...rest, ...(completeOnSuccess ? { completeOnSuccess } : {}), authorizedByUserId: "human", hostConsumerUserId: "service" } } }, executorKind: "program", state: "prepared", dispatch: { admission: null, resolution: null, cancellation: null, stopConfirmation: null }, result: null, replayed: false };
}
function status(target = command): WorkbenchProgramStatus { return { run: program(target), running: false }; }
const loopCommand: ProgramCommand = { ...command, completeOnSuccess: true, loop: { kind: "innovative", termination: { kind: "judgment", judgment: { criterion: "Original acceptance criterion" } }, maxAttempts: 3, synchronousCompletionBasis: "Foreground output and fixed acceptance evidence" } };
function loopProgram(value?: "true" | "false" | "unknown", termination = "judgment"): WorkbenchProgramRun {
  const base = program(termination === "judgment" ? loopCommand : { ...loopCommand, loop: { ...loopCommand.loop!, termination: { kind: "exit_code", exitCode: { stopCode: 0, continueCodes: [1] } } } });
  return { ...base, state: "bound", dispatch: { ...base.dispatch, admission: { id: "admission" } }, currentAttempt: { id: "attempt-3", ordinal: 3, grantedAt: "now" },
    loopState: { status: value === "true" ? "stopped" : "needs_human", ...(value ? { condition: { value, judgmentId: "judgment" } } : {}) },
    result: { outcome: "exited", exitCode: 0, observedAt: "now", startedAt: "now", finishedAt: "now", timedOutAt: null, cancelRequestedAt: null, summary: "Synthetic evidence", reporterUserId: "service", recordedAt: "now" } };
}
const loopMetadata: WorkbenchRun = { ...metadata, programLoop: { kind: "innovative", maxAttempts: 3, status: "needs_human", attemptId: "attempt-3", attemptOrdinal: 3, authorizedByUserId: "human" } };
function button(label: string) { return renderer!.root.findAllByType("button").find((entry) => entry.children.includes(label))!; }
async function change(label: string, value: string | boolean) { await act(async () => renderer!.root.findByProps({ "aria-label": label }).props.onChange({ target: typeof value === "boolean" ? { checked: value } : { value } })); }
async function form(purpose = "investigation", taskSlug = "task") {
  await act(async () => { renderer = create(<WorkbenchProgram project="project" taskSlug={taskSlug} title="Task" onChanged={() => {}} operationRequest={mocks.request} />); });
  if (!storage.has(PROGRAM_STORAGE_KEY)) {
    await change("Program T3 project", "local:native"); await change("Program executable", command.executable); await change("Program arguments", JSON.stringify(command.args)); await change("Program timeout", "5000"); await change("Program work purpose", purpose);
  }
}
beforeEach(() => {
  for (const name of ["start", "cancel", "read", "complete"] as const) mocks[name].mockReset().mockResolvedValue({ _tag: "Success", value: status() });
  mocks.request.mockReset(); mocks.available = true;
  storage = new Map(); vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => { await act(async () => renderer?.unmount()); vi.unstubAllGlobals(); });

it("preserves JSON argument strings and rejects non-string arrays before a request", async () => {
  expect(parseProgramArgs('["", "a b", "  "]')).toEqual(command.args);
  expect(() => parseProgramArgs('[1]')).toThrow();
  await form(); await change("Program arguments", "[1]"); await change("Confirm program preparation", true);
  expect(button("Prepare program").props.disabled).toBe(true);
  expect(storage.size).toBe(0); expect(mocks.request).not.toHaveBeenCalled();
});

it("blocks new preparation and start under human ownership while keeping original read and cancellation", async () => {
  await act(async () => { renderer = create(<WorkbenchProgram project="project" taskSlug="task" title="Task" ownerHold onChanged={() => {}} operationRequest={mocks.request} />); });
  expect(button("Prepare program").props.disabled).toBe(true);
  await act(async () => button("Prepare program").props.onClick());
  expect(mocks.request).not.toHaveBeenCalled();
  await act(async () => renderer!.update(<WorkbenchProgramRunRow run={metadata} project="project" ownerHold onChanged={() => {}} initialRun={program()} />));
  expect(button("Start program").props.disabled).toBe(true);
  expect(button("Read / refresh program run").props.disabled).toBe(false);
  expect(button("Cancel unadmitted program preparation")).toBeDefined();
  await act(async () => button("Start program").props.onClick());
  expect(mocks.start).not.toHaveBeenCalled();
});

it("preserves loop policy through recovery and rejects changed policy or frozen authorization", () => {
  const run = loopProgram();
  const expected = { taskSlug: "task", environmentId: "local", nativeProjectId: "native", authorizedByUserId: "human" };
  expect(readProgramReceipt(run, expected, loopCommand).target.loop).toEqual(loopCommand.loop);
  expect(() => readProgramReceipt(run, expected, { ...loopCommand, loop: { ...loopCommand.loop!, maxAttempts: 4 } })).toThrow("differs");
  expect(() => readProgramReceipt(run, { ...expected, authorizedByUserId: "different" }, loopCommand)).toThrow("authorizer");
  expect(() => readProgramReceipt(run, { ...expected, hostConsumerUserId: "different-service" }, loopCommand)).toThrow("host consumer");
});

it("stops future iterations with the saved human channel while the native host is unavailable", async () => {
  mocks.available = false;
  mocks.request.mockResolvedValueOnce(Response.json({ id: "stop-event", runId: "run", kind: "stop", actorUserId: "human", reason: "Host offline; halt future admissions", recordedAt: "now" }));
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={loopMetadata} project="project" onChanged={() => {}} request={mocks.request} />); });
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  await change("Program loop stop reason", "Host offline; halt future admissions");
  expect(button("Stop future iterations").props.disabled).toBe(false);
  await act(async () => button("Stop future iterations").props.onClick());
  expect(mocks.request).toHaveBeenCalledWith("/workbench-api/loop/program-loops/stop", expect.objectContaining({ body: JSON.stringify({ runId: "run", reason: "Host offline; halt future admissions" }), headers: { "Content-Type": "application/json", "X-Specgraph-Project": "project" } }));
  expect(JSON.stringify(renderer!.toJSON())).toContain("not proof of immediate process stop or release of responsibility");
  expect(mocks.cancel).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
});

it.each(["true", "false", "unknown"] as const)("keeps completion gated by loop condition %s while allowing explicit correction", async (value) => {
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={loopMetadata} project="project" onChanged={() => {}} initialRun={loopProgram(value)} request={mocks.request} />); });
  expect(!!button("Retry node completion under the original agreement (no restart)")).toBe(value === "true");
  expect(!!button("Record current attempt judgment")).toBe(true);
  expect(JSON.stringify(renderer!.toJSON())).toContain("judgment");
});

it("hides completion after a durable human stop even when the original condition is true", async () => {
  const base = loopProgram("true");
  const current: WorkbenchProgramRun = { ...base, loopState: { ...base.loopState!, stop: { id: "stop-event", runId: "run", kind: "stop", actorUserId: "human", reason: "Stop future completion", recordedAt: "now" } } };
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={loopMetadata} project="project" onChanged={() => {}} initialRun={current} request={mocks.request} />); });
  expect(button("Retry node completion under the original agreement (no restart)")).toBeUndefined();
  expect(button("Record current attempt judgment")).toBeDefined();
  expect(JSON.stringify(renderer!.toJSON())).toContain("future iterations remain stopped");
  expect(mocks.complete).not.toHaveBeenCalled();
});

it.each(["true", "false"] as const)("permits supplementing recorded unknown with %s only after explicitly refreshing original history", async (value) => {
  const current = loopProgram();
  const event = { id: "judgment", runId: "run", attemptId: "attempt-3", kind: "condition", value: "unknown", actorUserId: "human", reason: "Original evidence insufficient", recordedAt: "now" };
  mocks.request.mockResolvedValueOnce(Response.json(event));
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={loopMetadata} project="project" onChanged={() => {}} initialRun={current} request={mocks.request} />); });
  await change("Program loop judgment basis", event.reason);
  await act(async () => button("Record current attempt judgment").props.onClick());
  expect(button("Record current attempt judgment").props.disabled).toBe(true);
  expect(mocks.request).toHaveBeenCalledTimes(1);
  const unknown = loopProgram("unknown");
  mocks.request.mockResolvedValueOnce(Response.json({ run: unknown })).mockResolvedValueOnce(Response.json({ history: { attempts: [current.currentAttempt], events: [event], nextAttemptCursor: "", nextEventCursor: "" } }));
  await act(async () => button("Read original loop and history").props.onClick());
  expect(button("Record current attempt judgment").props.disabled).toBe(false);
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("Recorded judgment cannot be rewritten");
  expect(mocks.request).toHaveBeenCalledTimes(3);
  await change("Program loop judgment", value); await change("Program loop judgment basis", "Supplementary original evidence");
  const decisive = { ...event, id: "decisive-judgment", predecessorId: "judgment", value, reason: "Supplementary original evidence" };
  mocks.request.mockResolvedValueOnce(Response.json(decisive));
  await act(async () => button("Record current attempt judgment").props.onClick());
  expect(JSON.parse(mocks.request.mock.calls[3]![1].body)).toEqual({ runId: "run", attemptId: "attempt-3", expectedJudgmentId: "judgment", value, basis: decisive.reason });
  expect(button("Record current attempt judgment").props.disabled).toBe(true);
  const confirmedBase = loopProgram(value);
  const confirmed: WorkbenchProgramRun = { ...confirmedBase, loopState: { ...confirmedBase.loopState!, condition: { value, judgmentId: decisive.id } } };
  mocks.request.mockResolvedValueOnce(Response.json({ run: confirmed })).mockResolvedValueOnce(Response.json({ history: { attempts: [current.currentAttempt], events: [event, decisive], nextAttemptCursor: "", nextEventCursor: "" } }));
  await act(async () => button("Read original loop and history").props.onClick());
  expect(button("Record current attempt judgment")).toBeDefined();
  expect(JSON.stringify(renderer!.toJSON())).toContain("decisive-judgment");
  expect(mocks.request).toHaveBeenCalledTimes(6); expect(mocks.start).not.toHaveBeenCalled();
});

it("does not expose human judgment for mechanical exit-code facts or absent attempt results", async () => {
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={loopMetadata} project="project" onChanged={() => {}} initialRun={loopProgram(undefined, "exit_code")} />); });
  expect(button("Record current attempt judgment")).toBeUndefined();
  await act(async () => renderer!.update(<WorkbenchProgramRunRow run={{ ...loopMetadata, id: "another" }} project="project" onChanged={() => {}} initialRun={{ ...loopProgram(), result: null }} />));
  expect(button("Record current attempt judgment")).toBeUndefined();
});

it("submits the exact current attempt without forged actor and reconciles a lost judgment receipt through core history", async () => {
  const current = loopProgram();
  mocks.request.mockRejectedValueOnce(new Error("Receipt lost"));
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={loopMetadata} project="project" onChanged={() => {}} initialRun={current} request={mocks.request} />); });
  await change("Program loop judgment", "unknown"); await change("Program loop judgment basis", "Insufficient original evidence");
  await act(async () => button("Record current attempt judgment").props.onClick());
  expect(JSON.parse(mocks.request.mock.calls[0]![1].body)).toEqual({ runId: "run", attemptId: "attempt-3", expectedJudgmentId: null, value: "unknown", basis: "Insufficient original evidence" });
  expect(JSON.stringify(renderer!.toJSON())).toContain("Human operation outcome unconfirmed");
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("Attempt judgment recorded");
  expect(button("Record current attempt judgment").props.disabled).toBe(true);
  mocks.request.mockResolvedValueOnce(Response.json({ run: loopProgram("unknown") })).mockResolvedValueOnce(Response.json({ history: { attempts: [current.currentAttempt], events: [{ id: "judgment", runId: "run", attemptId: "attempt-3", kind: "condition", value: "unknown", actorUserId: "human", reason: "Insufficient original evidence", recordedAt: "now" }], nextAttemptCursor: "", nextEventCursor: "" } }));
  await act(async () => button("Read original loop and history").props.onClick());
  expect(button("Record current attempt judgment").props.disabled).toBe(false);
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("Recorded judgment cannot be rewritten");
  expect(mocks.request).toHaveBeenCalledTimes(3); expect(mocks.start).not.toHaveBeenCalled();
});

it.each(["x".repeat(4001), "\u4e2d".repeat(1334), "invalid\0basis"])("rejects an invalid judgment basis locally without freezing an unsent request", async (basis) => {
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={loopMetadata} project="project" onChanged={() => {}} initialRun={loopProgram("true")} request={mocks.request} />); });
  await change("Program loop judgment basis", basis);
  await act(async () => button("Record current attempt judgment").props.onClick());
  expect(mocks.request).not.toHaveBeenCalled();
  expect(JSON.stringify(renderer!.toJSON())).toContain("4000 UTF-8 bytes");
  await change("Program loop judgment basis", "Corrected evidence");
  expect(button("Record current attempt judgment").props.disabled).toBe(false);
});

it("appends a correction against the observed latest judgment rather than overwriting it", async () => {
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={loopMetadata} project="project" onChanged={() => {}} initialRun={loopProgram("true")} request={mocks.request} />); });
  await change("Program loop judgment", "false"); await change("Program loop judgment basis", "New evidence disproves the prior result");
  mocks.request.mockResolvedValueOnce(Response.json({ id: "judgment-2", runId: "run", attemptId: "attempt-3", kind: "condition", value: "false", predecessorId: "judgment", actorUserId: "human", reason: "New evidence disproves the prior result", recordedAt: "later" }));
  await act(async () => button("Record current attempt judgment").props.onClick());
  expect(JSON.parse(mocks.request.mock.calls[0]![1].body)).toEqual({ runId: "run", attemptId: "attempt-3", expectedJudgmentId: "judgment", value: "false", basis: "New evidence disproves the prior result" });
  expect(mocks.start).not.toHaveBeenCalled();
});

it("freezes an uncertain correction and explicitly retries its original CAS request after a complete read", async () => {
  const current = loopProgram("true");
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={loopMetadata} project="project" onChanged={() => {}} initialRun={current} request={mocks.request} />); });
  await change("Program loop judgment", "false"); await change("Program loop judgment basis", "Correction after review");
  mocks.request.mockRejectedValueOnce(new Error("receipt lost"));
  await act(async () => button("Record current attempt judgment").props.onClick());
  const originalRequest = JSON.parse(mocks.request.mock.calls[0]![1].body);
  mocks.request.mockResolvedValueOnce(Response.json({ run: current })).mockResolvedValueOnce(Response.json({ history: { attempts: [current.currentAttempt], events: [{ id: "judgment", runId: "run", attemptId: "attempt-3", kind: "condition", value: "true", actorUserId: "human", reason: "Earlier basis", recordedAt: "now" }], nextAttemptCursor: "", nextEventCursor: "" } }));
  await act(async () => button("Read original loop and history").props.onClick());
  expect(button("Record current attempt judgment").props.disabled).toBe(true);
  expect(button("Explicitly retry original judgment")).toBeDefined();
  expect(mocks.request).toHaveBeenCalledTimes(3);
  mocks.request.mockResolvedValueOnce(Response.json({ id: "judgment-2", runId: "run", attemptId: "attempt-3", kind: "condition", value: "false", predecessorId: "judgment", actorUserId: "human", reason: "Correction after review", recordedAt: "later" }));
  await act(async () => button("Explicitly retry original judgment").props.onClick());
  expect(JSON.parse(mocks.request.mock.calls[3]![1].body)).toEqual(originalRequest);
});

it("reconciles a lost correction by its predecessor without claiming a different successor", async () => {
  const current = loopProgram("true");
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={loopMetadata} project="project" onChanged={() => {}} initialRun={current} request={mocks.request} />); });
  await change("Program loop judgment", "false"); await change("Program loop judgment basis", "Corrected evidence");
  mocks.request.mockRejectedValueOnce(new Error("receipt lost"));
  await act(async () => button("Record current attempt judgment").props.onClick());
  const corrected: WorkbenchProgramRun = { ...current, loopState: { ...current.loopState!, condition: { value: "false", judgmentId: "judgment-2" } } };
  const oldEvent = { id: "judgment", runId: "run", attemptId: "attempt-3", kind: "condition", value: "true", actorUserId: "human", reason: "Earlier basis", recordedAt: "now" };
  const newEvent = { ...oldEvent, id: "judgment-2", predecessorId: "judgment", value: "false", reason: "Corrected evidence", recordedAt: "later" };
  mocks.request.mockResolvedValueOnce(Response.json({ run: corrected })).mockResolvedValueOnce(Response.json({ history: { attempts: [current.currentAttempt], events: [oldEvent, newEvent], nextAttemptCursor: "", nextEventCursor: "" } }));
  await act(async () => button("Read original loop and history").props.onClick());
  expect(button("Record current attempt judgment").props.disabled).toBe(false);
  expect(button("Explicitly retry original judgment")).toBeUndefined();
  expect(JSON.stringify(renderer!.toJSON())).toContain("Matching judgment observed");
  expect(JSON.stringify(renderer!.toJSON())).toContain("judgment-2");
});

it("keeps a conflicting successor frozen instead of retargeting an uncertain correction", async () => {
  const current = loopProgram("true");
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={loopMetadata} project="project" onChanged={() => {}} initialRun={current} request={mocks.request} />); });
  await change("Program loop judgment", "false"); await change("Program loop judgment basis", "My correction");
  mocks.request.mockRejectedValueOnce(new Error("receipt lost"));
  await act(async () => button("Record current attempt judgment").props.onClick());
  const changed: WorkbenchProgramRun = { ...current, loopState: { ...current.loopState!, condition: { value: "unknown", judgmentId: "other-judgment" } } };
  mocks.request.mockResolvedValueOnce(Response.json({ run: changed })).mockResolvedValueOnce(Response.json({ history: { attempts: [current.currentAttempt], events: [{ id: "other-judgment", runId: "run", attemptId: "attempt-3", kind: "condition", value: "unknown", predecessorId: "judgment", actorUserId: "human", reason: "Other decision", recordedAt: "later" }], nextAttemptCursor: "", nextEventCursor: "" } }));
  await act(async () => button("Read original loop and history").props.onClick());
  expect(button("Record current attempt judgment").props.disabled).toBe(true);
  expect(button("Explicitly retry original judgment")).toBeUndefined();
  expect(JSON.stringify(renderer!.toJSON())).toContain("A different judgment was recorded for the same predecessor");
});

it("shows completed consumption separately from a later current judgment", async () => {
  const base = loopProgram("true");
  const completion = { eventId: "completion-event", attemptId: "attempt-3", judgmentId: "judgment-1" };
  const current: WorkbenchProgramRun = { ...base, state: "completed", completion, loopState: { status: "completed", condition: { value: "false", judgmentId: "judgment-2" }, completion } };
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={loopMetadata} project="project" onChanged={() => {}} initialRun={current} request={mocks.request} />); });
  expect(JSON.stringify(renderer!.toJSON())).toContain("judgment-2");
  expect(JSON.stringify(renderer!.toJSON())).toContain("judgment-1");
  expect(JSON.stringify(renderer!.toJSON())).toContain("completion-event");
  expect(button("Record current attempt judgment")).toBeDefined();
  expect(button("Retry node completion under the original agreement (no restart)")).toBeUndefined();
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("Attempts exhausted; human judgment required");
});

it.each(["completed", "stopped"] as const)("appends a %s-run correction without changing its original outcome", async (mode) => {
  const base = loopProgram("true");
  const completion = { eventId: "completion-event", attemptId: "attempt-3", judgmentId: "judgment-1" };
  const stop = { id: "stop-event", runId: "run", kind: "stop" as const, actorUserId: "human", reason: "Stop future attempts", recordedAt: "now" };
  const originalFacts = mode === "completed" ? { completion } : { stop };
  const current: WorkbenchProgramRun = { ...base, state: mode === "completed" ? "completed" : "bound", ...(mode === "completed" ? { completion } : {}),
    loopState: { status: mode, condition: { value: "true", judgmentId: "judgment-1" }, ...originalFacts } };
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={loopMetadata} project="project" onChanged={() => {}} initialRun={current} request={mocks.request} />); });
  expect(JSON.stringify(renderer!.toJSON())).toContain(mode === "completed" ? "does not undo completion or start another attempt" : "future iterations remain stopped");
  await change("Program loop judgment", "false"); await change("Program loop judgment basis", "Later evidence corrected the condition");
  const correction = { id: "judgment-2", runId: "run", attemptId: "attempt-3", kind: "condition", value: "false", predecessorId: "judgment-1", actorUserId: "human", reason: "Later evidence corrected the condition", recordedAt: "later" };
  mocks.request.mockResolvedValueOnce(Response.json(correction));
  await act(async () => button("Record current attempt judgment").props.onClick());
  expect(JSON.parse(mocks.request.mock.calls[0]![1].body)).toEqual({ runId: "run", attemptId: "attempt-3", expectedJudgmentId: "judgment-1", value: "false", basis: correction.reason });
  const corrected: WorkbenchProgramRun = { ...current, loopState: { status: mode, condition: { value: "false", judgmentId: "judgment-2" }, ...originalFacts } };
  mocks.request.mockResolvedValueOnce(Response.json({ run: corrected })).mockResolvedValueOnce(Response.json({ history: { attempts: [current.currentAttempt], events: [correction], nextAttemptCursor: "", nextEventCursor: "" } }));
  await act(async () => button("Read original loop and history").props.onClick());
  const shown = JSON.stringify(renderer!.toJSON());
  expect(shown).toContain("judgment-2"); expect(shown).toContain("judgment-1"); expect(shown).toContain(mode === "completed" ? "completion-event" : "future iterations remain stopped");
  expect(shown).not.toContain("Attempts exhausted; human judgment required");
  expect(button("Retry node completion under the original agreement (no restart)")).toBeUndefined();
  expect(mocks.start).not.toHaveBeenCalled();
});

it("labels legacy completion without a recorded judgment basis rather than guessing from the latest", async () => {
  const base = loopProgram("true");
  const current: WorkbenchProgramRun = { ...base, state: "completed", completion: { eventId: "legacy-completion" }, loopState: { status: "completed", condition: { value: "false", judgmentId: "later-judgment" }, completion: { eventId: "legacy-completion" } } };
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={loopMetadata} project="project" onChanged={() => {}} initialRun={current} request={mocks.request} />); });
  expect(JSON.stringify(renderer!.toJSON())).toContain("Original completion consumed");
  expect(JSON.stringify(renderer!.toJSON())).toContain("Not recorded");
  expect(JSON.stringify(renderer!.toJSON())).toContain("later-judgment");
});

it("shows each next attempt's consumed judgment separately from the current judgment", async () => {
  const current = loopProgram("false");
  mocks.request.mockResolvedValueOnce(Response.json({ run: current })).mockResolvedValueOnce(Response.json({ history: {
    attempts: [{ id: "attempt-2", ordinal: 2, grantedAt: "before", consumedJudgmentId: "judgment-1" }, current.currentAttempt],
    events: [], nextAttemptCursor: "", nextEventCursor: "" } }));
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={loopMetadata} project="project" onChanged={() => {}} initialRun={current} request={mocks.request} />); });
  await act(async () => button("Read original loop and history").props.onClick());
  const body = JSON.stringify(renderer!.toJSON());
  expect(body).toContain("judgment-1");
  expect(body).toContain("Not recorded");
  expect(JSON.stringify(renderer!.toJSON())).toContain("Latest judgment");
});

it.each(["attempts", "events"] as const)("exhausts unequal %s history without reopening the finished stream or duplicating records", async (longStream) => {
  const current = loopProgram();
  const attempts = Array.from({ length: longStream === "attempts" ? 51 : 1 }, (_, index) => ({ id: `history-attempt-${index + 1}`, ordinal: index + 1, grantedAt: "now" }));
  const events = Array.from({ length: longStream === "events" ? 51 : 1 }, (_, index) => ({ id: `history-event-${index + 1}`, runId: "run", kind: "condition", actorUserId: "human", reason: "Original evidence", recordedAt: "now" }));
  mocks.request.mockImplementation(async (url: string) => {
    if (!url.includes("/history?")) return Response.json({ run: current });
    const next = url.includes("attemptCursor=50") || url.includes("eventCursor=history-event-50");
    return Response.json({ history: {
      attempts: longStream === "attempts" && next ? attempts.slice(50) : attempts.slice(0, 50),
      events: longStream === "events" && next ? events.slice(50) : events.slice(0, 50),
      nextAttemptCursor: longStream === "attempts" && !next ? "50" : "", nextEventCursor: longStream === "events" && !next ? "history-event-50" : "" } });
  });
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={loopMetadata} project="project" onChanged={() => {}} request={mocks.request} />); });
  await act(async () => button("Read original loop and history").props.onClick());
  await act(async () => button("Read more loop history").props.onClick());
  const history = renderer!.root.findByProps({ "aria-label": "Program loop history" });
  expect(history.findAllByType("p")).toHaveLength(52);
  expect(button("Read more loop history")).toBeUndefined();
  expect(mocks.request).toHaveBeenCalledTimes(4);
});

it("prepares a confirmed fixed command without starting and accepts omitted false in the receipt", async () => {
  mocks.request.mockResolvedValue(Response.json(program())); await form();
  expect(storage.size).toBe(0);
  await change("Confirm program preparation", true); await act(async () => button("Prepare program").props.onClick());
  expect(JSON.parse(mocks.request.mock.calls[0]![1].body)).toMatchObject({ taskSlug: "task", command });
  expect(JSON.parse(mocks.request.mock.calls[0]![1].body).command).not.toHaveProperty("loop");
  expect(JSON.parse(storage.get(PROGRAM_STORAGE_KEY)!)).toMatchObject({ runId: "run", command });
  expect(mocks.start).not.toHaveBeenCalled();
  expect(button("Start program").props.disabled).toBe(true);
  await change("Confirm program start", true); await act(async () => button("Start program").props.onClick());
  expect(mocks.start).toHaveBeenCalledExactlyOnceWith({ environmentId: "local", input: { project: "project", nativeProjectId: "native", runId: "run" } });
});

it("prepares a mechanical exit-code loop without a required attempt limit", async () => {
  await form();
  await change("Program loop mode", "mechanical");
  await change("Program loop stop code", "7");
  await change("Program loop continue codes", "[0, 1]");
  await change("Program loop synchronous completion basis", "The command returns after this invocation's writes finish");
  const loop: NonNullable<ProgramCommand["loop"]> = { kind: "mechanical", termination: { kind: "exit_code", exitCode: { stopCode: 7, continueCodes: [0, 1] } }, synchronousCompletionBasis: "The command returns after this invocation's writes finish" };
  mocks.request.mockResolvedValueOnce(Response.json(program({ ...command, loop })));
  await change("Confirm program preparation", true);
  await act(async () => button("Prepare program").props.onClick());
  expect(JSON.parse(mocks.request.mock.calls[0]![1].body).command).toEqual({ ...command, loop });
  expect(mocks.start).not.toHaveBeenCalled();
});

it("requires innovative loop limit, criterion and synchronous basis", async () => {
  await form(); await change("Program loop mode", "innovative"); await change("Program loop termination", "judgment");
  await change("Confirm program preparation", true);
  expect(button("Prepare program").props.disabled).toBe(true);
  await change("Program loop max attempts", "3"); await change("Confirm program preparation", true);
  expect(button("Prepare program").props.disabled).toBe(true);
  await change("Program loop criterion", "Accepted evidence"); await change("Confirm program preparation", true);
  expect(button("Prepare program").props.disabled).toBe(true);
  await change("Program loop synchronous completion basis", "Writes finish before return");
  expect(renderer!.root.findByProps({ "aria-label": "Confirm program preparation" }).props.checked).toBe(false);
  await change("Confirm program preparation", true);
  expect(button("Prepare program").props.disabled).toBe(false);
});

it("withdraws preparation confirmation after loop policy edits", async () => {
  await form(); await change("Program loop mode", "mechanical");
  await change("Program loop stop code", "7"); await change("Program loop continue codes", "[0]");
  await change("Program loop synchronous completion basis", "Writes finish before return");
  for (const [field, value] of [["Program loop continue codes", "[1]"], ["Program loop stop code", "8"],
    ["Program loop max attempts", "2"], ["Program loop synchronous completion basis", "Result is flushed before return"],
    ["Program loop termination", "judgment"], ["Program loop criterion", "Accepted evidence"],
    ["Program loop mode", "innovative"]] as const) {
    await change("Confirm program preparation", true);
    await change(field, value);
    expect(renderer!.root.findByProps({ "aria-label": "Confirm program preparation" }).props.checked).toBe(false);
  }
  expect(mocks.request).not.toHaveBeenCalled();
});

it("rejects duplicate, overlapping and invalid loop exit codes before prepare", async () => {
  await form(); await change("Program loop mode", "mechanical"); await change("Program loop synchronous completion basis", "Writes finish before return");
  await change("Program loop stop code", "0");
  for (const codes of ["[0]", "[1, 1]", "[1.5]", "[4294967296]", "not JSON"]) {
    await change("Program loop continue codes", codes); await change("Confirm program preparation", true);
    expect(button("Prepare program").props.disabled).toBe(true);
  }
  await change("Program loop continue codes", "[]"); await change("Program loop stop code", "-2147483649"); await change("Confirm program preparation", true);
  expect(button("Prepare program").props.disabled).toBe(true);
  expect(mocks.request).not.toHaveBeenCalled();
});

it("restores the frozen original loop and key after an unknown prepare outcome", async () => {
  const pending = { project: "project", taskSlug: "task", key: "original-key", command: loopCommand };
  storage.set(PROGRAM_STORAGE_KEY, JSON.stringify(pending));
  mocks.request.mockRejectedValueOnce(new Error("response lost"));
  await form();
  expect(renderer!.root.findByProps({ "aria-label": "Program loop mode" }).props.value).toBe("innovative");
  expect(renderer!.root.findByProps({ "aria-label": "Program loop max attempts" }).props.value).toBe("3");
  expect(renderer!.root.findAllByType("fieldset")[0]!.props.disabled).toBe(true);
  await change("Confirm program preparation", true); await act(async () => button("Resume original program preparation").props.onClick());
  expect(JSON.parse(mocks.request.mock.calls[0]![1].body)).toEqual({ taskSlug: "task", idempotencyKey: "original-key", command: loopCommand });
  await act(async () => renderer!.unmount());
  mocks.request.mockResolvedValueOnce(Response.json(program(loopCommand)));
  await form(); await change("Confirm program preparation", true); await act(async () => button("Resume original program preparation").props.onClick());
  expect(JSON.parse(mocks.request.mock.calls[1]![1].body)).toEqual({ taskSlug: "task", idempotencyKey: "original-key", command: loopCommand });
  expect(JSON.parse(storage.get(PROGRAM_STORAGE_KEY)!).command.loop).toEqual(loopCommand.loop);
  expect(mocks.start).not.toHaveBeenCalled();
});

it("keeps the original prepare identity across login, response loss and node changes", async () => {
  mocks.request.mockResolvedValueOnce(Response.json({ error: "sign in" }, { status: 401 })); await form(); await change("Confirm program preparation", true);
  await act(async () => button("Prepare program").props.onClick());
  const original = JSON.parse(mocks.request.mock.calls[0]![1].body);
  await change("Program access key", "synthetic-key"); mocks.request.mockResolvedValueOnce(Response.json({ identity: {} })); await act(async () => button("Sign in").props.onClick());
  mocks.request.mockRejectedValueOnce(new Error("receipt lost")); await act(async () => button("Resume original program preparation").props.onClick());
  expect(JSON.parse(mocks.request.mock.calls[2]![1].body)).toEqual(original);
  await act(async () => renderer!.unmount()); await form("investigation", "other");
  expect(JSON.stringify(renderer!.toJSON())).toContain("Resolve the original program request first");
  expect(renderer!.root.findAllByProps({ "aria-label": "Program T3 project" })).toHaveLength(0);
  await act(async () => renderer!.unmount()); await form();
  mocks.request.mockResolvedValueOnce(Response.json(program())); await change("Confirm program preparation", true); await act(async () => button("Resume original program preparation").props.onClick());
  expect(JSON.parse(mocks.request.mock.calls[3]![1].body)).toEqual(original);
  expect(mocks.start).not.toHaveBeenCalled();
});

it.each(WORK_PURPOSES)("keeps purpose %s and permits automatic completion only for the seven ordinary purposes", async (purpose) => {
  await form(purpose);
  expect(renderer!.root.findByProps({ "aria-label": "Program work purpose" }).props.value).toBe(purpose);
  expect(renderer!.root.findByProps({ "aria-label": "Program complete on success" }).props.disabled).toBe(["requirements", "design", "implementation"].includes(purpose));
});

it("requires and freezes applicable QA sources instead of substituting coordination", async () => {
  await form("test_execution"); await change("Confirm program preparation", true);
  expect(button("Prepare program").props.disabled).toBe(true);
  await act(async () => renderer!.root.findByProps({ "aria-label": "Add program testPlanSources" }).props.onClick());
  await change("program testPlanSources 1 field", "specify"); await change("program testPlanSources 1 changeId", "change"); await change("Program QA applicability", "Agreed scope");
  expect(renderer!.root.findByProps({ "aria-label": "Confirm program preparation" }).props.checked).toBe(false);
  const qa = { requirementDecisionIds: [], designDecisionIds: [], designSources: [], testPlanSources: [{ kind: "specgraph" as const, specSlug: "task", field: "specify", changeId: "change" }], applicability: "Agreed scope" };
  mocks.request.mockResolvedValueOnce(Response.json(program({ ...command, workPurpose: "test_execution", qaBasis: qa })));
  await change("Confirm program preparation", true); await act(async () => button("Prepare program").props.onClick());
  expect(JSON.parse(mocks.request.mock.calls[0]![1].body).command).toMatchObject({ workPurpose: "test_execution", qaBasis: qa });
});

it("accepts omitted empty Git source entry without accepting changed QA provenance", () => {
  const qaBasis = { requirementDecisionIds: [], designDecisionIds: [], designSources: [], testPlanSources: [{ kind: "git" as const, environmentId: "local", repositoryRoot: "C:/project", commitSha: "a".repeat(40), path: "QA.md", entry: "" }], applicability: "Agreed scope" };
  const requested = { ...command, workPurpose: "test_execution" as const, qaBasis };
  const receipt = program({ ...requested, qaBasis: { ...qaBasis, testPlanSources: qaBasis.testPlanSources.map(({ entry: _entry, ...source }) => source) } });
  const bodyTarget = receipt.context.body.program_target as Record<string, unknown>;
  bodyTarget.qaBasis = { applicability: qaBasis.applicability, testPlanSources: [{ path: "QA.md", commitSha: "a".repeat(40), repositoryRoot: "C:/project", environmentId: "local", kind: "git" }], designSources: [], designDecisionIds: [], requirementDecisionIds: [] };
  expect(readProgramReceipt(receipt, { taskSlug: "task", environmentId: "local", nativeProjectId: "native" }, requested).run.context.runId).toBe("run");
  expect(() => readProgramReceipt(receipt, { taskSlug: "task", environmentId: "local", nativeProjectId: "native" }, { ...requested, qaBasis: { ...qaBasis, applicability: "Different scope" } })).toThrow("differs");
});

it("allows revising a first definitive rejection but preserves an earlier unknown request", async () => {
  mocks.request.mockResolvedValueOnce(Response.json({ code: "invalid_argument", error: "absolute executable required" }, { status: 400 }));
  await form(); await change("Confirm program preparation", true); await act(async () => button("Prepare program").props.onClick());
  expect(button("Revise rejected preparation")).toBeDefined();
  await act(async () => button("Revise rejected preparation").props.onClick());
  expect(storage.has(PROGRAM_STORAGE_KEY)).toBe(false);
  await change("Program executable", "C:/bin/accepted.exe"); mocks.request.mockRejectedValueOnce(new Error("response lost"));
  await change("Confirm program preparation", true); await act(async () => button("Prepare program").props.onClick());
  const original = storage.get(PROGRAM_STORAGE_KEY);
  expect(button("Revise rejected preparation")).toBeUndefined();
  mocks.request.mockResolvedValueOnce(Response.json({ code: "unauthorized" }, { status: 401 }));
  await act(async () => button("Resume original program preparation").props.onClick());
  expect(storage.get(PROGRAM_STORAGE_KEY)).toBe(original); expect(button("Revise rejected preparation")).toBeUndefined();
});

it("does not read on list render, guesses no project, and rejects mismatched receipts", async () => {
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={metadata} project="project" onChanged={() => {}} />); });
  expect(mocks.read).not.toHaveBeenCalled();
  mocks.read.mockResolvedValueOnce({ _tag: "Success", value: status({ ...command, nativeProjectId: ProjectId.make("wrong") }) });
  await act(async () => button("Read / refresh program run").props.onClick());
  expect(JSON.stringify(renderer!.toJSON())).toContain("Program run scope mismatch");
  expect(button("Start program")).toBeUndefined();
  mocks.available = false; await act(async () => renderer!.update(<WorkbenchProgramRunRow run={{ ...metadata, id: "other" }} project="project" onChanged={() => {}} />));
  expect(button("Read / refresh program run").props.disabled).toBe(true);
  expect(mocks.start).not.toHaveBeenCalled();
  expect(() => readProgramReceipt(program(), { taskSlug: "other", environmentId: "local", nativeProjectId: "native" })).toThrow("scope mismatch");
});

it("reconciles an unknown start by reading without automatically starting again", async () => {
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={metadata} project="project" onChanged={() => {}} initialRun={program()} />); });
  mocks.start.mockRejectedValueOnce(new Error("connection lost")); await change("Confirm program start", true); await act(async () => button("Start program").props.onClick());
  expect(JSON.stringify(renderer!.toJSON())).toContain("Operation outcome unconfirmed");
  expect(button("Start program")).toBeUndefined();
  const base = status(); const admitted = { ...base, running: true, run: { ...base.run, dispatch: { ...base.run.dispatch, admission: { id: "admission" } } } };
  mocks.read.mockResolvedValueOnce({ _tag: "Success", value: admitted }); await act(async () => button("Read / refresh program run").props.onClick());
  expect(mocks.start).toHaveBeenCalledTimes(1);
  expect(button("Request program cancellation (not proof the process tree stopped)")).toBeDefined();
  expect(mocks.cancel).not.toHaveBeenCalled();
});

it("cancels never-admitted preparation through the human request and separately refreshes", async () => {
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={metadata} project="project" onChanged={() => {}} request={mocks.request} initialRun={program()} />); });
  await change("Program preparation cancellation reason", "No longer needed"); mocks.request.mockResolvedValueOnce(Response.json({}));
  const base = status(); const cancelled = { ...base, run: { ...base.run, state: "preparation_cancelled", dispatch: { ...base.run.dispatch, cancellation: { note: "No longer needed" } } } };
  mocks.read.mockResolvedValueOnce({ _tag: "Success", value: cancelled });
  await act(async () => button("Cancel unadmitted program preparation").props.onClick());
  expect(mocks.request).toHaveBeenCalledWith("/workbench-api/loop/runs/run/dispatch/cancel-preparation", expect.objectContaining({ method: "POST", body: JSON.stringify({ packageId: "package", note: "No longer needed" }) }));
  expect(mocks.cancel).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
  expect(JSON.stringify(renderer!.toJSON())).toContain("preparation_cancelled");
});

it("allows human preparation cancellation when the original host project is unavailable", async () => {
  mocks.available = false; mocks.request.mockResolvedValueOnce(Response.json({}));
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={metadata} project="project" onChanged={() => {}} request={mocks.request} />); });
  expect(button("Read / refresh program run").props.disabled).toBe(true);
  await change("Program preparation cancellation reason", "Host offline");
  expect(button("Cancel unadmitted program preparation").props.disabled).toBe(false);
  await act(async () => button("Cancel unadmitted program preparation").props.onClick());
  expect(JSON.stringify(renderer!.toJSON())).toContain("Preparation cancelled (not host-stop evidence)"); expect(mocks.read).not.toHaveBeenCalled();
});

it("explicitly resubmits the host pending result without claiming a new physical start", async () => {
  const base = status(); const pending = { ...base, resultWriteError: "write failed", run: { ...base.run, dispatch: { ...base.run.dispatch, admission: { id: "admission" } } } };
  mocks.read.mockResolvedValueOnce({ _tag: "Success", value: pending }); mocks.start.mockResolvedValueOnce({ _tag: "Success", value: pending });
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={metadata} project="project" onChanged={() => {}} />); }); await act(async () => button("Read / refresh program run").props.onClick());
  expect(button("Start program")).toBeUndefined(); expect(mocks.start).not.toHaveBeenCalled();
  await act(async () => button("Retry result recording (no re-execution)").props.onClick()); expect(mocks.start).toHaveBeenCalledTimes(1);
});

it("does not treat a late exit 0 after cancellation or timeout as eligible completion", async () => {
  const base = status({ ...command, completeOnSuccess: true }); const current = { ...base, run: { ...base.run, dispatch: { ...base.run.dispatch, admission: { id: "admission" } },
    result: { outcome: "exited" as const, exitCode: 0, observedAt: "now", startedAt: "now", finishedAt: "now", timedOutAt: "earlier", cancelRequestedAt: "earlier", summary: null, reporterUserId: "service", recordedAt: "now" } } };
  mocks.read.mockResolvedValueOnce({ _tag: "Success", value: current });
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={metadata} project="project" onChanged={() => {}} />); }); await act(async () => button("Read / refresh program run").props.onClick());
  const output = JSON.stringify(renderer!.toJSON()); expect(output).toContain("Exit code 0 (not proof of tests passing)"); expect(output).toContain("Timeout requested"); expect(output).toContain("Cancellation requested");
  expect(button("Retry node completion under the original agreement (no restart)")).toBeUndefined(); expect(mocks.complete).not.toHaveBeenCalled();
});

it.each([7, null])("shows exit code %s without claiming success or permitting completion", async (exitCode) => {
  const base = status({ ...command, completeOnSuccess: true }); const current = { ...base, run: { ...base.run, dispatch: { ...base.run.dispatch, admission: { id: "admission" } },
    result: { outcome: "exited" as const, exitCode, observedAt: "now", startedAt: "now", finishedAt: "now", timedOutAt: null, cancelRequestedAt: null, summary: null, reporterUserId: "service", recordedAt: "now" } } };
  mocks.read.mockResolvedValueOnce({ _tag: "Success", value: current });
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={metadata} project="project" onChanged={() => {}} />); }); await act(async () => button("Read / refresh program run").props.onClick());
  expect(JSON.stringify(renderer!.toJSON())).toContain(exitCode === null ? "Exit code unconfirmed" : "Non-zero exit");
  expect(button("Retry node completion under the original agreement (no restart)")).toBeUndefined(); expect(mocks.complete).not.toHaveBeenCalled();
});

it.each(["exited", "timed_out", "cancel_requested", "unconfirmed"] as const)("separates result %s, database state, host runner and result/completion failures", async (outcome) => {
  const base = status({ ...command, completeOnSuccess: true }); const current = { ...base, resultWriteError: "write failed", completionError: "manual hold", run: { ...base.run, state: "bound", dispatch: { ...base.run.dispatch, admission: { id: "admission" } },
    result: { outcome, exitCode: outcome === "exited" ? 0 : null, observedAt: "now", startedAt: "now", finishedAt: "now", timedOutAt: outcome === "timed_out" ? "now" : null, cancelRequestedAt: outcome === "cancel_requested" ? "now" : null, summary: "Synthetic observation", reporterUserId: "service", recordedAt: "now" } } };
  mocks.read.mockResolvedValueOnce({ _tag: "Success", value: current });
  await act(async () => { renderer = create(<WorkbenchProgramRunRow run={metadata} project="project" onChanged={() => {}} />); }); await act(async () => button("Read / refresh program run").props.onClick());
  const output = JSON.stringify(renderer!.toJSON()); expect(output).toContain("bound"); expect(output).toContain("No active runner (not proof the process tree stopped)"); expect(output).toContain("write failed"); expect(output).toContain("manual hold");
  expect(!!button("Retry node completion under the original agreement (no restart)")).toBe(outcome === "exited");
  if (outcome === "exited") { mocks.complete.mockResolvedValueOnce({ _tag: "Success", value: current }); await act(async () => button("Retry node completion under the original agreement (no restart)").props.onClick()); expect(mocks.complete).toHaveBeenCalledTimes(1); }
  expect(mocks.start).not.toHaveBeenCalled();
});
