import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { RunHarness } from "@project-workbench/ui/run-harness";
import { PURPOSE_GUIDANCE, RETRIEVAL_GUIDANCE, ROLE_GUIDANCE, type RecordedRunContext } from "@project-workbench/ui/dispatch";
import type { WorkbenchRun } from "./workbenchModel";

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => vi.unstubAllGlobals());

const run: WorkbenchRun = { id: "run/original", taskSlug: "task", packageId: "package", generation: 1,
  threadRef: "", workspace: "current/workspace", state: "prepared", createdAt: "2026-09-27", updatedAt: "2026-09-27" };
const context: RecordedRunContext = { runId: run.id, taskSlug: run.taskSlug, packageId: run.packageId, createdAt: "2026-09-25T10:00:00Z",
  body: { workspace: "saved/workspace", dispatch_target: { purposeGuidance: "Original purpose instruction", roleGuidance: "Original role instruction",
    retrievalGuidance: "Original retrieval instruction", promptFormatVersion: "original-format", workPurpose: "implementation", assignmentRole: "executor",
    createdAt: "2026-09-25T09:59:00Z", qaBasis: { designSources: [{ path: "saved-design.md", commitSha: "original-commit" }], testPlanSources: [{ changeId: "original-plan" }] } },
    scope_context: { sources: [{ slug: "saved-parent", revision: 3 }] } } };
const content = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(content).join("");

it("loads only on expansion and displays saved instructions and references, never current templates", async () => {
  const request = vi.fn().mockResolvedValue(Response.json(context));
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<RunHarness project="project" run={run} language="en" request={request} />); });
    expect(request).not.toHaveBeenCalled();
    await act(async () => renderer.root.findByType("details").props.onToggle({ currentTarget: { open: true } }));
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("/workbench-api/loop/runs/run%2Foriginal/context");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("X-Specgraph-Project")).toBe("project");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const displayed = content(renderer.root);
    for (const original of ["Original purpose instruction", "Original role instruction", "Original retrieval instruction", "original-format",
      "saved/workspace", "2026-09-25T10:00:00Z", "package", "saved-design.md", "original-commit", "original-plan", "saved-parent"]) expect(displayed).toContain(original);
    for (const current of [PURPOSE_GUIDANCE.implementation, ROLE_GUIDANCE.executor, RETRIEVAL_GUIDANCE, "current/workspace"]) expect(displayed).not.toContain(current);
    expect(displayed).toContain("not proof that the model received or followed it");
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
  } finally { await act(async () => renderer?.unmount()); }
});

it.each([{}, { dispatch_target: ["Historical target format"] }])("keeps missing historical fields unrecorded and unknown target shapes visible: %j", async (body) => {
  const request = vi.fn().mockResolvedValue(Response.json({ ...context, body }));
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<RunHarness project="project" run={run} language="en" request={request} />); });
    await act(async () => renderer.root.findByType("details").props.onToggle({ currentTarget: { open: true } }));
    expect(renderer.root.findAllByType("pre").slice(0, 5).map(content)).toEqual(Array(5).fill("Not recorded"));
    expect(content(renderer.root)).not.toContain("current/workspace");
    expect(content(renderer.root)).not.toContain(PURPOSE_GUIDANCE.implementation);
    if ("dispatch_target" in body) expect(content(renderer.root)).toContain("Historical target format");
  } finally { await act(async () => renderer?.unmount()); }
});

it.each([
  { status: 200, body: { ...context, runId: "another-run" }, message: "identity mismatch" },
  { status: 200, body: { ...context, taskSlug: "another-task" }, message: "identity mismatch" },
  { status: 200, body: { ...context, packageId: "another-package" }, message: "identity mismatch" },
  { status: 200, body: { ...context, body: [] }, message: "format or run identity mismatch" },
  { status: 401, body: {}, message: "Sign in through the existing workbench UI" },
  { status: 500, body: {}, message: "500" },
])("fails clearly for invalid context or HTTP status $status: $message", async ({ status, body, message }) => {
  const request = vi.fn().mockResolvedValue(Response.json(body, { status }));
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<RunHarness project="project" run={run} language="en" request={request} />); });
    await act(async () => renderer.root.findByType("details").props.onToggle({ currentTarget: { open: true } }));
    expect(content(renderer.root.findByProps({ role: "alert" }))).toContain(message);
    expect(content(renderer.root)).not.toContain("Original purpose instruction");
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
    expect(request).toHaveBeenCalledOnce();
  } finally { await act(async () => renderer?.unmount()); }
});

it("cancels collapsed and changed project scopes and ignores their late responses", async () => {
  let finishCollapsed!: (response: Response) => void;
  let finishOldProject!: (response: Response) => void;
  const request = vi.fn()
    .mockReturnValueOnce(new Promise<Response>((resolve) => { finishCollapsed = resolve; }))
    .mockReturnValueOnce(new Promise<Response>((resolve) => { finishOldProject = resolve; }))
    .mockResolvedValueOnce(Response.json({ ...context, body: { dispatch_target: { purposeGuidance: "New project record" } } }));
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<RunHarness project="project" run={run} language="en" request={request} />); });
    await act(async () => renderer.root.findByType("details").props.onToggle({ currentTarget: { open: true } }));
    expect(content(renderer.root)).toContain("Loading preparation record");
    await act(async () => renderer.root.findByType("details").props.onToggle({ currentTarget: { open: false } }));
    expect(request.mock.calls[0]![1].signal.aborted).toBe(true);
    await act(async () => { finishCollapsed(Response.json(context)); });
    expect(content(renderer.root)).not.toContain("Original purpose instruction");
    await act(async () => renderer.root.findByType("details").props.onToggle({ currentTarget: { open: true } }));
    await act(async () => renderer.update(<RunHarness project="other-project" run={run} language="en" request={request} />));
    expect(request.mock.calls[1]![1].signal.aborted).toBe(true);
    await act(async () => { finishOldProject(Response.json(context)); });
    expect(content(renderer.root)).not.toContain("Original purpose instruction");
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => renderer.root.findByType("details").props.onToggle({ currentTarget: { open: true } }));
    expect(content(renderer.root)).toContain("New project record");
    expect(new Headers(request.mock.calls[2]![1].headers).get("X-Specgraph-Project")).toBe("other-project");
    expect(request).toHaveBeenCalledTimes(3);
  } finally { await act(async () => renderer?.unmount()); }
});
