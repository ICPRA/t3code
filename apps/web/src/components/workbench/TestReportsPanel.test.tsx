import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { TestReportsPanel } from "../../../../../../project-workbench/extensions/workbench-ui/src/TestReportsPanel";
import type { ReviewSource, TestReport, WorkbenchRun } from "../../../../../../project-workbench/extensions/workbench-ui/src/workbenchModel";

const commitSha = "a".repeat(40);
const plan: ReviewSource = { kind: "specgraph", specSlug: "test-plan", field: "specify", changeId: "plan-change" };
const gitPlan: ReviewSource = { kind: "git", environmentId: "environment", repositoryRoot: "C:/repo", commitSha: "b".repeat(40), path: "TEST-PLAN.md", entry: "Boundary cases" };
const delivery = { id: "delivery", runBindingId: "writer", snapshot: { git: { head: { isRepo: true, commitSha } } } };
const context = { runId: "writer", body: { dispatch_target: { workPurpose: "implementation", gitBaseline: { isRepo: true, commitSha: "old-base" }, qaBasis: { testPlanSources: [plan, gitPlan] } } } };
const report: TestReport = { id: "report", deliveryId: "delivery", testRunId: null, commitSha, planSources: [plan], status: "passed", command: "test-command", exitCode: null, summary: "Synthetic test fixture", outputRefs: ["test-output.txt"], reporter: "human-operator", createdAt: "date" };
const runs: WorkbenchRun[] = [
  { id: "writer", taskSlug: "implementation", workPurpose: "implementation", gitBaseline: { isRepo: true, commitSha: "old-base" } },
  { id: "tester", taskSlug: "test-task", workPurpose: "test_execution", gitBaseline: { isRepo: true, commitSha } },
  { id: "other-implementation", taskSlug: "other", workPurpose: "implementation" },
  { id: "wrong-commit", taskSlug: "other", workPurpose: "test_execution", gitBaseline: { isRepo: true, commitSha: "different" } },
  { id: "unknown-purpose", taskSlug: "other" },
].map((run) => ({ packageId: "package", generation: 1, environmentId: "environment", threadRef: "thread", workspace: "C:/repo", state: "bound", createdAt: "date", updatedAt: "date", ...run }));
let renderer: ReactTestRenderer;
afterEach(async () => { await act(async () => renderer?.unmount()); });

it("records explicit manual testing of fixed commit and selected plans, keeping unknown exit null and requiring no model run", async () => {
  const onChanged = vi.fn();
  let saved = false;
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { saved = true; return Response.json(report); }
    if (url.endsWith("/delivery")) return Response.json(delivery);
    if (url.endsWith("/writer/context")) return Response.json(context);
    if (url.endsWith("/tests")) return Response.json({ deliveryId: "delivery", reports: saved ? [report] : [], hasMore: false, nextCursor: null });
    throw new Error(`Unexpected request ${url}`);
  });
  await act(async () => { renderer = create(<TestReportsPanel project="project" deliveryId="delivery" runs={[]} language="en" request={request} onChanged={onChanged} />); });
  expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  expect(renderer.root.findByProps({ "aria-label": "Testing mode" }).props.value).toBe("");
  expect(renderer.root.findByProps({ "aria-label": "Test result" }).props.value).toBe("");
  expect(JSON.stringify(renderer.toJSON())).toContain(commitSha);
  await act(async () => renderer.root.findByProps({ "aria-label": "Testing mode" }).props.onChange({ target: { value: "manual" } }));
  expect(renderer.root.findAllByProps({ type: "checkbox" })).toHaveLength(2);
  await act(async () => renderer.root.findByProps({ "aria-label": "Test plan 1" }).props.onChange({ target: { checked: true } }));
  for (const [label, value] of [["Test result", "passed"], ["Test command", "test-command"], ["Test summary", "Synthetic test fixture"], ["Test output references", "test-output.txt"]]) {
    await act(async () => renderer.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } }));
  }
  expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  await act(async () => renderer.root.findByProps({ "aria-label": "Record test report" }).props.onSubmit({ preventDefault() {} }));
  const writes = request.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(writes).toHaveLength(1);
  expect(writes[0]![0]).toBe("/workbench-api/loop/deliveries/delivery/tests");
  expect(JSON.parse(String(writes[0]![1]!.body))).toEqual({ deliveryId: "delivery", commitSha, planSources: [plan], status: "passed", command: "test-command", exitCode: null, summary: "Synthetic test fixture", outputRefs: ["test-output.txt"] });
  expect(JSON.stringify(renderer.toJSON())).toContain("Exit code");
  expect(JSON.stringify(renderer.toJSON())).toContain("Unknown");
  expect(JSON.stringify(renderer.toJSON())).toContain("Manual testing (no run association)");
  expect(onChanged).toHaveBeenCalledOnce();
  expect(request.mock.calls.some(([url]) => url.includes("/complete") || url.includes("/accept") || url.includes("/start"))).toBe(false);
});

it("does not record a pass without a command and output reference or with a nonzero exit code", async () => {
  const request = vi.fn(async (url: string) => Response.json(url.endsWith("/delivery") ? delivery : url.endsWith("/context") ? context : { deliveryId: "delivery", reports: [], hasMore: false, nextCursor: null }));
  await act(async () => { renderer = create(<TestReportsPanel project="project" deliveryId="delivery" runs={[]} language="en" request={request} onChanged={vi.fn()} />); });
  await act(async () => renderer.root.findByProps({ "aria-label": "Testing mode" }).props.onChange({ target: { value: "manual" } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Test plan 1" }).props.onChange({ target: { checked: true } }));
  for (const [label, value] of [["Test result", "passed"], ["Test summary", "Claimed pass"]]) {
    await act(async () => renderer.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } }));
  }
  const before = request.mock.calls.length;
  await act(async () => renderer.root.findByProps({ "aria-label": "Record test report" }).props.onSubmit({ preventDefault() {} }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Test command" }).props.onChange({ target: { value: "test-command" } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Record test report" }).props.onSubmit({ preventDefault() {} }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Test output references" }).props.onChange({ target: { value: "test-output.txt" } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Test exit code" }).props.onChange({ target: { value: "1" } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Record test report" }).props.onSubmit({ preventDefault() {} }));
  expect(request).toHaveBeenCalledTimes(before);
  expect(JSON.stringify(renderer.toJSON())).toContain("A nonzero exit code cannot be recorded as passed");
});

it.each(["failed", "not_run", "environment_blocked"] as const)("records %s without inventing successful exit or output", async (status) => {
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ ...report, status, command: "", outputRefs: [], summary: "Actual state" });
    return Response.json(url.endsWith("/delivery") ? delivery : url.endsWith("/context") ? context : { deliveryId: "delivery", reports: [], hasMore: false, nextCursor: null });
  });
  await act(async () => { renderer = create(<TestReportsPanel project="project" deliveryId="delivery" runs={[]} language="en" request={request} onChanged={vi.fn()} />); });
  await act(async () => renderer.root.findByProps({ "aria-label": "Testing mode" }).props.onChange({ target: { value: "manual" } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Test plan 1" }).props.onChange({ target: { checked: true } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Test result" }).props.onChange({ target: { value: status } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Test summary" }).props.onChange({ target: { value: "Actual state" } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Record test report" }).props.onSubmit({ preventDefault() {} }));
  expect(JSON.parse(String(request.mock.calls.find(([, init]) => init?.method === "POST")![1]!.body))).toMatchObject({ status, exitCode: null, outputRefs: [], command: "" });
});

it.each(["writer", "tester"])("uses only matching frozen plans of selected %s without requiring implementation baseline to equal delivery head", async (testRunId) => {
  const assigned = testRunId === "writer" ? context : { runId: "tester", body: { dispatch_target: { workPurpose: "test_execution", gitBaseline: { isRepo: true, commitSha }, qaBasis: { testPlanSources: [plan, { ...plan, changeId: "unrelated-plan-version" }] } } } };
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ ...report, testRunId, status: "failed", command: "", outputRefs: [], summary: "Failure" });
    if (url.endsWith("/delivery")) return Response.json(delivery);
    if (url.endsWith("/writer/context")) return Response.json(context);
    if (url.endsWith("/tester/context")) return Response.json(assigned);
    return Response.json({ deliveryId: "delivery", reports: [], hasMore: false, nextCursor: null });
  });
  await act(async () => { renderer = create(<TestReportsPanel project="project" deliveryId="delivery" runs={runs} language="en" request={request} onChanged={vi.fn()} />); });
  await act(async () => renderer.root.findByProps({ "aria-label": "Testing mode" }).props.onChange({ target: { value: "run" } }));
  expect(renderer.root.findByProps({ "aria-label": "Test run" }).findAllByType("option").map((option) => option.props.value)).toEqual(["", "writer", "tester"]);
  await act(async () => renderer.root.findByProps({ "aria-label": "Test run" }).props.onChange({ target: { value: testRunId } }));
  expect(renderer.root.findAllByProps({ type: "checkbox" })).toHaveLength(testRunId === "writer" ? 2 : 1);
  await act(async () => renderer.root.findByProps({ "aria-label": "Test plan 1" }).props.onChange({ target: { checked: true } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Test result" }).props.onChange({ target: { value: "failed" } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Test summary" }).props.onChange({ target: { value: "Failure" } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Record test report" }).props.onSubmit({ preventDefault() {} }));
  expect(JSON.parse(String(request.mock.calls.find(([, init]) => init?.method === "POST")![1]!.body))).toMatchObject({ testRunId, commitSha, planSources: [plan], status: "failed" });
});

it("blocks a selected test execution when its original context commit contradicts projected run metadata", async () => {
  const request = vi.fn(async (url: string) => {
    if (url.endsWith("/delivery")) return Response.json(delivery);
    if (url.endsWith("/writer/context")) return Response.json(context);
    if (url.endsWith("/tester/context")) return Response.json({ runId: "tester", body: { dispatch_target: { workPurpose: "test_execution", gitBaseline: { isRepo: true, commitSha: "different" }, qaBasis: { testPlanSources: [plan] } } } });
    return Response.json({ deliveryId: "delivery", reports: [], hasMore: false, nextCursor: null });
  });
  await act(async () => { renderer = create(<TestReportsPanel project="project" deliveryId="delivery" runs={runs} language="en" request={request} onChanged={vi.fn()} />); });
  await act(async () => renderer.root.findByProps({ "aria-label": "Testing mode" }).props.onChange({ target: { value: "run" } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Test run" }).props.onChange({ target: { value: "tester" } }));
  expect(renderer.root.findAllByProps({ type: "checkbox" })).toHaveLength(0);
  expect(JSON.stringify(renderer.toJSON())).toContain("Test run purpose or fixed commit does not match the delivery");
  const before = request.mock.calls.length;
  await act(async () => renderer.root.findByProps({ "aria-label": "Record test report" }).props.onSubmit({ preventDefault() {} }));
  expect(request).toHaveBeenCalledTimes(before);
});

it("paginates report history independently of missing delivery data, displaying failure states, unknown exit and refs as text", async () => {
  const request = vi.fn(async (url: string) => {
    if (url.endsWith("/delivery")) return new Response(null, { status: 404 });
    if (url.includes("cursor=")) return Response.json({ deliveryId: "delivery", reports: [{ ...report, id: "older", status: "environment_blocked", outputRefs: ["https://untrusted.example/log"] }], hasMore: false, nextCursor: null });
    return Response.json({ deliveryId: "delivery", reports: [{ ...report, status: "failed", testRunId: "tester", reporter: "human-operator" }, { ...report, id: "not-run", status: "not_run" }], hasMore: true, nextCursor: "50 / older" });
  });
  const onOpenNode = vi.fn();
  await act(async () => { renderer = create(<TestReportsPanel project="project" deliveryId="delivery" runs={runs} language="en" request={request} onChanged={vi.fn()} onOpenNode={onOpenNode} />); });
  expect(JSON.stringify(renderer.toJSON())).toContain("Failed");
  expect(JSON.stringify(renderer.toJSON())).toContain("Not run");
  expect(JSON.stringify(renderer.toJSON())).toContain("Unknown");
  expect(JSON.stringify(renderer.toJSON())).toContain("human-operator");
  expect(JSON.stringify(renderer.toJSON())).toContain("tester");
  await act(async () => renderer.root.findAllByType("button").find((button) => button.children.includes("test-task"))!.props.onClick());
  expect(onOpenNode).toHaveBeenCalledWith("test-task");
  await act(async () => renderer.root.findByProps({ "aria-label": "Next test report page" }).props.onClick());
  expect(request).toHaveBeenLastCalledWith("/workbench-api/loop/deliveries/delivery/tests?cursor=50%20%2F%20older", expect.anything());
  expect(JSON.stringify(renderer.toJSON())).toContain("Environment blocked");
  expect(JSON.stringify(renderer.toJSON())).toContain("https://untrusted.example/log");
  expect(renderer.root.findAllByType("a")).toHaveLength(0);
  await act(async () => renderer.root.findByProps({ "aria-label": "Previous test report page" }).props.onClick());
  expect(request).toHaveBeenLastCalledWith("/workbench-api/loop/deliveries/delivery/tests", expect.anything());
});

it("keeps report registration separate from explicit implementation completion", async () => {
  let saved = false;
  const onChanged = vi.fn();
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/complete")) return Response.json({ completed: "implementation" });
    if (init?.method === "POST") { saved = true; return Response.json(report); }
    if (url.endsWith("/delivery")) return Response.json(delivery);
    if (url.endsWith("/context")) return Response.json(context);
    return Response.json({ deliveryId: "delivery", reports: saved ? [report] : [], hasMore: false, nextCursor: null });
  });
  await act(async () => { renderer = create(<TestReportsPanel project="project" deliveryId="delivery" runs={runs} language="en" request={request} onChanged={onChanged} />); });
  await act(async () => renderer.root.findByProps({ "aria-label": "Testing mode" }).props.onChange({ target: { value: "manual" } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Test plan 1" }).props.onChange({ target: { checked: true } }));
  for (const [label, value] of [["Test result", "passed"], ["Test command", "test-command"], ["Test summary", "Synthetic test fixture"], ["Test output references", "test-output.txt"]]) {
    await act(async () => renderer.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } }));
  }
  await act(async () => renderer.root.findByProps({ "aria-label": "Record test report" }).props.onSubmit({ preventDefault() {} }));
  expect(request.mock.calls.filter(([, init]) => init?.method === "POST").map(([url]) => url)).toEqual(["/workbench-api/loop/deliveries/delivery/tests"]);
  expect(JSON.stringify(renderer.toJSON())).not.toContain("Implementation task completed.");
  await act(async () => renderer.root.findAllByType("button").find((button) => button.children.includes("Complete task based on test results"))!.props.onClick());
  expect(request).toHaveBeenLastCalledWith("/workbench-api/loop/runs/writer/complete", expect.objectContaining({ method: "POST", body: "{}" }));
  expect(JSON.stringify(renderer.toJSON())).toContain("Implementation task completed.");
  expect(JSON.stringify(renderer.toJSON())).toContain("Synthetic test fixture");
  expect(onChanged).toHaveBeenCalledTimes(2);
});

it.each(["missing plan report", "failed plan report"])("preserves recorded reports when completion is rejected for %s", async (reason) => {
  const history = { ...report, status: reason === "failed plan report" ? "failed" : "passed" };
  const onChanged = vi.fn();
  const request = vi.fn(async (url: string) => {
    if (url.endsWith("/complete")) return Response.json({ error: reason }, { status: 409 });
    if (url.endsWith("/delivery")) return Response.json(delivery);
    if (url.endsWith("/context")) return Response.json(context);
    return Response.json({ deliveryId: "delivery", reports: [history], hasMore: false, nextCursor: null });
  });
  await act(async () => { renderer = create(<TestReportsPanel project="project" deliveryId="delivery" runs={runs} language="en" request={request} onChanged={onChanged} />); });
  await act(async () => renderer.root.findAllByType("button").find((button) => button.children.includes("Complete task based on test results"))!.props.onClick());
  expect(request).toHaveBeenLastCalledWith("/workbench-api/loop/runs/writer/complete", expect.objectContaining({ method: "POST", body: "{}" }));
  expect(JSON.stringify(renderer.toJSON())).toContain("Task not completed; test reports retained: ");
  expect(JSON.stringify(renderer.toJSON())).toContain(reason);
  expect(JSON.stringify(renderer.toJSON())).toContain("Synthetic test fixture");
  expect(JSON.stringify(renderer.toJSON())).not.toContain("Implementation task completed.");
  expect(onChanged).not.toHaveBeenCalled();
});

it("rejects a mismatched completion receipt without claiming completion or losing reports", async () => {
  const request = vi.fn(async (url: string) => Response.json(url.endsWith("/complete") ? { completed: "another-task" }
    : url.endsWith("/delivery") ? delivery : url.endsWith("/context") ? context : { deliveryId: "delivery", reports: [report], hasMore: false, nextCursor: null }));
  await act(async () => { renderer = create(<TestReportsPanel project="project" deliveryId="delivery" runs={runs} language="en" request={request} onChanged={vi.fn()} />); });
  await act(async () => renderer.root.findAllByType("button").find((button) => button.children.includes("Complete task based on test results"))!.props.onClick());
  expect(JSON.stringify(renderer.toJSON())).toContain("Implementation completion target mismatch");
  expect(JSON.stringify(renderer.toJSON())).toContain("Synthetic test fixture");
  expect(JSON.stringify(renderer.toJSON())).not.toContain("Implementation task completed.");
});
