import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ReviewAssignmentPanel } from "../../../../../../project-workbench/extensions/workbench-ui/src/ReviewAssignmentPanel";
import type { ReviewDecision, ReviewRequest, ReviewStatus, WorkbenchRun } from "../../../../../../project-workbench/extensions/workbench-ui/src/workbenchModel";

const runs: WorkbenchRun[] = [
  { id: "writer", taskSlug: "task", threadRef: "writer-thread" },
  { id: "same-session", taskSlug: "other", threadRef: "writer-thread" },
  { id: "reviewer", taskSlug: "different-task", threadRef: "independent-thread", assignmentRole: "implementer" },
  { id: "closed", taskSlug: "other", threadRef: "closed-thread", state: "closed" },
  { id: "unbound", taskSlug: "other", threadRef: "" },
].map((run) => ({ packageId: "package", generation: 1, environmentId: "environment", workspace: "workspace", state: "bound", createdAt: "date", updatedAt: "date", ...run }));
const source = { kind: "specgraph" as const, specSlug: "task", field: "intent", changeId: "original-change" };
const reviewRequest: ReviewRequest = { id: "requirements-request", taskSlug: "task", kind: "requirements", sources: [source], authorResponsibility: { kind: "agent", runId: "writer" }, completionRunId: null, requirementDecisionIds: [], reviewerRunId: "reviewer", responsibleUserId: "human-owner", maxReviewRounds: 3, createdBy: "human-owner", createdAt: "date", decidedAt: null, decisions: [] };
const status: ReviewStatus = { taskSlug: "task", reviews: [{ kind: "requirements", request: null, agentRejections: 3, maxReviewRounds: 3, humanHold: true, responsibleUserId: "human-owner" }, { kind: "design", request: null, agentRejections: 0, maxReviewRounds: 3, humanHold: false, responsibleUserId: "human-owner" }] };
let renderer: ReactTestRenderer;
afterEach(async () => { await act(async () => renderer?.unmount()); });

it("assigns requirements without any code delivery, declaring authorship and excluding self or the same session", async () => {
  const assigned: ReviewStatus = { ...status, reviews: [{ ...status.reviews[0]!, maxReviewRounds: 4, request: { ...reviewRequest, maxReviewRounds: 4 } }, status.reviews[1]!] };
  const request = vi.fn().mockResolvedValueOnce(Response.json(status)).mockResolvedValueOnce(Response.json(assigned));
  const onChanged = vi.fn();
  await act(async () => { renderer = create(<ReviewAssignmentPanel project="project" slug="task" runs={runs} language="en" request={request} onChanged={onChanged} />); });
  expect(renderer.root.findByProps({ "aria-label": "Author kind" }).props.value).toBe("");
  expect(renderer.root.findByProps({ "aria-label": "Reviewer run" }).findAllByType("option").map((option) => option.props.value)).toEqual([""]);
  await act(async () => renderer.root.findByProps({ "aria-label": "Author kind" }).props.onChange({ target: { value: "agent" } }));
  expect(renderer.root.findByProps({ "aria-label": "Author run" }).findAllByType("option").map((option) => option.props.value)).toContain("closed");
  await act(async () => renderer.root.findByProps({ "aria-label": "Author run" }).props.onChange({ target: { value: "writer" } }));
  const reviewer = renderer.root.findByProps({ "aria-label": "Reviewer run" });
  expect(reviewer.findAllByType("option").map((option) => option.props.value)).toEqual(["", "reviewer"]);
  expect(reviewer.findAllByType("option")[1]!.children.join("")).toContain("different-task · implementer");
  await act(async () => reviewer.props.onChange({ target: { value: "reviewer" } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Source 1 field" }).props.onChange({ target: { value: "intent" } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Source 1 changeId" }).props.onChange({ target: { value: "original-change" } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Maximum rejection rounds" }).props.onChange({ target: { value: "4" } }));
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => renderer.root.findByProps({ "aria-label": "Assign source review" }).props.onSubmit({ preventDefault() {} }));
  expect(request).toHaveBeenLastCalledWith("/workbench-api/loop/specs/task/assign-review", expect.objectContaining({ body: JSON.stringify({ kind: "requirements", sources: [source], authorResponsibility: { kind: "agent", runId: "writer" }, requirementDecisionIds: [], reviewerRunId: "reviewer", maxReviewRounds: 4 }) }));
  expect(JSON.stringify(renderer.toJSON())).toContain("Awaiting human intervention");
  expect(renderer.root.findAllByType("p")[0]!.children.join("")).toBe("Agent rejection rounds: 3 / 4");
  expect(onChanged).toHaveBeenCalledOnce();
});

it("assigns design with exact Git and SpecGraph sources, a human author and explicit requirement decision references", async () => {
  const approved: ReviewDecision = { id: "requirement-approved", requestId: reviewRequest.id, verdict: "accepted", basis: "Scope approved", actorKind: "agent", actor: "reviewer", reviewerRunId: "reviewer", createdAt: "date" };
  const current = { ...status, reviews: [{ ...status.reviews[0]!, request: { ...reviewRequest, decisions: [approved], decidedAt: "date" } }, status.reviews[1]!] };
  const request = vi.fn().mockResolvedValueOnce(Response.json(current)).mockImplementationOnce(async (_url, init) => {
    const body = JSON.parse(init.body);
    return Response.json({ ...current, reviews: [current.reviews[0], { ...status.reviews[1], request: { ...reviewRequest, ...body, id: "design-request" } }] });
  });
  await act(async () => { renderer = create(<ReviewAssignmentPanel project="project" slug="task" runs={runs} language="en" request={request} onChanged={vi.fn()} />); });
  expect(JSON.stringify(renderer.toJSON())).toContain("requirement-approved");
  await act(async () => renderer.root.findByProps({ "aria-label": "Review kind" }).props.onChange({ target: { value: "design" } }));
  expect(renderer.root.findAllByType("p")[0]!.children.join("")).toBe("Agent rejection rounds: 0 / 3");
  await act(async () => renderer.root.findByProps({ "aria-label": "Source 1 kind" }).props.onChange({ target: { value: "git" } }));
  const git = { kind: "git", environmentId: "environment", repositoryRoot: "C:/repo", commitSha: "a".repeat(40), path: "DESIGN.md", entry: "Interfaces" };
  for (const [field, value] of Object.entries(git).filter(([key]) => key !== "kind")) {
    await act(async () => renderer.root.findByProps({ "aria-label": `Source 1 ${field}` }).props.onChange({ target: { value } }));
  }
  await act(async () => renderer.root.findByProps({ "aria-label": "Add source" }).props.onClick());
  await act(async () => renderer.root.findByProps({ "aria-label": "Source 2 field" }).props.onChange({ target: { value: "intent" } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Source 2 changeId" }).props.onChange({ target: { value: "original-change" } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Add source" }).props.onClick());
  await act(async () => renderer.root.findByProps({ "aria-label": "Remove source 3" }).props.onClick());
  await act(async () => renderer.root.findByProps({ "aria-label": "Author kind" }).props.onChange({ target: { value: "human" } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Author account ID" }).props.onChange({ target: { value: "human-writer" } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Reviewer run" }).props.onChange({ target: { value: "reviewer" } }));
  await act(async () => renderer.root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Other requirement approval IDs" }).props.onChange({ target: { value: "external-approval, requirement-approved" } }));
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => renderer.root.findByProps({ "aria-label": "Assign source review" }).props.onSubmit({ preventDefault() {} }));
  expect(JSON.parse(request.mock.calls[1]![1].body)).toEqual({ kind: "design", sources: [git, source], authorResponsibility: { kind: "human", userId: "human-writer" }, requirementDecisionIds: ["requirement-approved", "external-approval"], reviewerRunId: "reviewer", maxReviewRounds: 3 });
  expect(JSON.stringify(renderer.toJSON())).toContain("design-request");
  await act(async () => renderer.root.findByProps({ "aria-label": "Review kind" }).props.onChange({ target: { value: "requirements" } }));
  expect(JSON.stringify(renderer.toJSON())).toContain("requirement-approved");
  expect(JSON.stringify(renderer.toJSON())).not.toContain("design-request");
});

it("removes an overridden approval from choices and the assignment payload after refresh while retaining its history", async () => {
  const approved: ReviewDecision = { id: "old-approval", requestId: reviewRequest.id, verdict: "accepted", basis: "Initially approved", actorKind: "agent", actor: "reviewer", reviewerRunId: "reviewer", createdAt: "2026-09-24T10:00:00Z" };
  const rejected: ReviewDecision = { ...approved, id: "human-rejection", verdict: "rejected", basis: "Conflicting requirement", actorKind: "human", actor: "human-owner", reviewerRunId: null, createdAt: "2026-09-24T10:01:00Z" };
  const initial = { ...status, reviews: [{ ...status.reviews[0]!, request: { ...reviewRequest, decisions: [approved] } }, status.reviews[1]!] };
  const refreshed = { ...status, reviews: [{ ...status.reviews[0]!, request: { ...reviewRequest, decisions: [approved, rejected] } }, status.reviews[1]!] };
  const request = vi.fn().mockResolvedValueOnce(Response.json(initial)).mockResolvedValueOnce(Response.json(refreshed))
    .mockImplementationOnce(async (_url, init) => Response.json({ ...refreshed, reviews: [refreshed.reviews[0], { ...status.reviews[1], request: { ...reviewRequest, ...JSON.parse(init.body), id: "design-request" } }] }));
  await act(async () => { renderer = create(<ReviewAssignmentPanel project="project" slug="task" runs={runs} language="en" request={request} onChanged={vi.fn()} />); });
  await act(async () => renderer.root.findByProps({ "aria-label": "Review kind" }).props.onChange({ target: { value: "design" } }));
  await act(async () => renderer.root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Author kind" }).props.onChange({ target: { value: "human" } }));
  for (const [label, value] of [["Author account ID", "human-author"], ["Reviewer run", "reviewer"], ["Source 1 field", "intent"], ["Source 1 changeId", "original-change"]]) {
    await act(async () => renderer.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } }));
  }
  await act(async () => renderer.root.findAllByType("button").find((button) => button.children.includes("Refresh review status"))!.props.onClick());
  expect(renderer.root.findAllByProps({ type: "checkbox" })).toHaveLength(0);
  await act(async () => renderer.root.findByProps({ "aria-label": "Assign source review" }).props.onSubmit({ preventDefault() {} }));
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => renderer.root.findByProps({ "aria-label": "Other requirement approval IDs" }).props.onChange({ target: { value: "other-node-approval" } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Assign source review" }).props.onSubmit({ preventDefault() {} }));
  expect(JSON.parse(request.mock.calls[2]![1].body).requirementDecisionIds).toEqual(["other-node-approval"]);
  await act(async () => renderer.root.findByProps({ "aria-label": "Review kind" }).props.onChange({ target: { value: "requirements" } }));
  const history = renderer.root.findByProps({ "aria-label": "Review decisions" });
  expect(history.findAllByType("p").map((row) => row.children.join("")).join("\n")).toContain("old-approval");
  expect(history.findAllByType("p").map((row) => row.children.join("")).join("\n")).toContain("human-rejection");
});

it("retains a selected approval after reaffirmation without reviving approvals preceding a rejection", async () => {
  const approved: ReviewDecision = { id: "valid-approval", requestId: reviewRequest.id, verdict: "accepted", basis: "Approved", actorKind: "agent", actor: "reviewer", reviewerRunId: "reviewer", createdAt: "date" };
  const decisions: ReviewDecision[] = [{ ...approved, id: "revoked-approval" }, { ...approved, id: "rejection", verdict: "rejected" }, approved];
  const initial = { ...status, reviews: [{ ...status.reviews[0]!, request: { ...reviewRequest, decisions } }, status.reviews[1]!] };
  const refreshed = { ...status, reviews: [{ ...status.reviews[0]!, request: { ...reviewRequest, decisions: [...decisions, { ...approved, id: "reaffirmed-approval" }] } }, status.reviews[1]!] };
  const request = vi.fn().mockResolvedValueOnce(Response.json(initial)).mockResolvedValueOnce(Response.json(refreshed))
    .mockImplementationOnce(async (_url, init) => Response.json({ ...refreshed, reviews: [refreshed.reviews[0], { ...status.reviews[1], request: { ...reviewRequest, ...JSON.parse(init.body), id: "design-request" } }] }));
  await act(async () => { renderer = create(<ReviewAssignmentPanel project="project" slug="task" runs={runs} language="en" request={request} onChanged={vi.fn()} />); });
  await act(async () => renderer.root.findByProps({ "aria-label": "Review kind" }).props.onChange({ target: { value: "design" } }));
  expect(renderer.root.findAllByProps({ type: "checkbox" })).toHaveLength(1);
  await act(async () => renderer.root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Author kind" }).props.onChange({ target: { value: "human" } }));
  for (const [label, value] of [["Author account ID", "human-author"], ["Reviewer run", "reviewer"], ["Source 1 field", "intent"], ["Source 1 changeId", "original-change"]]) {
    await act(async () => renderer.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } }));
  }
  await act(async () => renderer.root.findAllByType("button").find((button) => button.children.includes("Refresh review status"))!.props.onClick());
  expect(renderer.root.findAllByProps({ type: "checkbox" }).map((checkbox) => checkbox.props.checked)).toEqual([true, false]);
  await act(async () => renderer.root.findByProps({ "aria-label": "Assign source review" }).props.onSubmit({ preventDefault() {} }));
  expect(JSON.parse(request.mock.calls[2]![1].body).requirementDecisionIds).toEqual(["valid-approval"]);
  await act(async () => renderer.root.findByProps({ "aria-label": "Review kind" }).props.onChange({ target: { value: "requirements" } }));
  expect(renderer.root.findByProps({ "aria-label": "Review decisions" }).findAllByType("li")).toHaveLength(4);
});

it.each(["accepted", "rejected"] as const)("records an explicit human %s source decision with basis, not a delivery acceptance", async (verdict) => {
  const current = { ...status, reviews: [{ ...status.reviews[0]!, request: reviewRequest }, status.reviews[1]!] };
  const decision: ReviewDecision = { id: "human-decision", requestId: reviewRequest.id, verdict, basis: "Human assessment", actorKind: "human", actor: "human-owner", reviewerRunId: null, createdAt: "date" };
  const decided = { ...current, reviews: [{ ...current.reviews[0]!, humanHold: false, request: { ...reviewRequest, decisions: [decision], decidedAt: "date" } }, current.reviews[1]!] };
  const request = vi.fn().mockResolvedValueOnce(Response.json(current)).mockResolvedValueOnce(Response.json({ recorded: true, decision, status: decided }));
  await act(async () => { renderer = create(<ReviewAssignmentPanel project="project" slug="task" runs={runs} language="en" request={request} onChanged={vi.fn()} />); });
  await act(async () => renderer.root.findByProps({ "aria-label": "Human source decision" }).props.onSubmit({ preventDefault() {} }));
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => renderer.root.findByProps({ "aria-label": "Human verdict" }).props.onChange({ target: { value: verdict } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Review basis" }).props.onChange({ target: { value: "Human assessment" } }));
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => renderer.root.findByProps({ "aria-label": "Human source decision" }).props.onSubmit({ preventDefault() {} }));
  expect(request).toHaveBeenLastCalledWith("/workbench-api/loop/specs/task/review-source", expect.objectContaining({ body: JSON.stringify({ requestId: reviewRequest.id, verdict, basis: "Human assessment" }) }));
  expect(JSON.stringify(renderer.toJSON())).toContain("Human assessment");
  expect(JSON.stringify(renderer.toJSON())).toContain("Review decisions (not test results)");
  expect(request.mock.calls.some(([url]) => url.includes("deliveries") || url.includes("complete"))).toBe(false);
});

it("reads recorded source identity and exact original change only on request, leaving unknown references unknown", async () => {
  const request = vi.fn().mockResolvedValueOnce(Response.json(status))
    .mockResolvedValueOnce(Response.json({ kind: "spec", slug: "task", sourceRefs: { intent: "original-change" } }))
    .mockResolvedValueOnce(Response.json({ kind: "change", slug: "task", id: "original-change", record: { field: "intent", new_value: "Original requirement" } }))
    .mockResolvedValueOnce(Response.json({ kind: "spec", slug: "task", sourceRefs: {} }));
  await act(async () => { renderer = create(<ReviewAssignmentPanel project="project" slug="task" runs={runs} language="en" request={request} onChanged={vi.fn()} />); });
  await act(async () => renderer.root.findByProps({ "aria-label": "Source 1 field" }).props.onChange({ target: { value: "intent" } }));
  const useCurrent = () => renderer.root.findAllByType("button").find((button) => button.children.includes("Use recorded current source"))!;
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => useCurrent().props.onClick());
  expect(renderer.root.findByProps({ "aria-label": "Source 1 changeId" }).props.value).toBe("original-change");
  await act(async () => renderer.root.findAllByType("button").find((button) => button.children.includes("Read original change"))!.props.onClick());
  expect(JSON.stringify(renderer.toJSON())).toContain("Original requirement");
  await act(async () => renderer.root.findByProps({ "aria-label": "Source 1 changeId" }).props.onChange({ target: { value: "" } }));
  await act(async () => useCurrent().props.onClick());
  expect(renderer.root.findByProps({ "aria-label": "Source 1 changeId" }).props.value).toBe("");
  expect(JSON.stringify(renderer.toJSON())).toContain("No recorded source change ID for this field");
  expect(request.mock.calls.map(([url]) => url)).toEqual(["/workbench-api/loop/specs/task/review-status", "/workbench-api/knowledge/spec/task", "/workbench-api/knowledge/change/original-change", "/workbench-api/knowledge/spec/task"]);
});

it("signs in and reloads status without automatically assigning or deciding", async () => {
  const request = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ authenticated: true })).mockResolvedValueOnce(Response.json(status));
  await act(async () => { renderer = create(<ReviewAssignmentPanel project="project" slug="task" runs={runs} language="en" request={request} onChanged={vi.fn()} />); });
  await act(async () => renderer.root.findByType("input").props.onChange({ target: { value: "credential" } }));
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(request.mock.calls.map(([url]) => url)).toEqual(["/workbench-api/loop/specs/task/review-status", "/workbench-api/api/auth/login", "/workbench-api/loop/specs/task/review-status"]);
});

it.each(["requirements", "design"] as const)("explicitly maps only a known %s authoring run, clearing scope when the author or kind changes", async (kind) => {
  const authoringRuns = runs.map((run) => run.id === "writer" ? { ...run, taskSlug: "writing-task", state: "closed", workPurpose: kind } : run.id === "closed" ? { ...run, workPurpose: "implementation" } : run);
  const request = vi.fn().mockResolvedValueOnce(Response.json(status)).mockImplementationOnce(async (_url, init) => {
    const body = JSON.parse(init.body);
    return Response.json({ ...status, reviews: status.reviews.map((review) => review.kind === kind ? { ...review, request: { ...reviewRequest, ...body } } : review) });
  });
  await act(async () => { renderer = create(<ReviewAssignmentPanel project="project" slug="task" runs={authoringRuns} language="en" request={request} onChanged={vi.fn()} />); });
  await act(async () => renderer.root.findByProps({ "aria-label": "Review kind" }).props.onChange({ target: { value: kind } }));
  expect(renderer.root.findAllByProps({ "aria-label": "Complete authoring node after approval" })).toHaveLength(0);
  await act(async () => renderer.root.findByProps({ "aria-label": "Author kind" }).props.onChange({ target: { value: "agent" } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Author run" }).props.onChange({ target: { value: "writer" } }));
  expect(renderer.root.findByProps({ "aria-label": "Complete authoring node after approval" }).props.checked).toBe(false);
  await act(async () => renderer.root.findByProps({ "aria-label": "Complete authoring node after approval" }).props.onChange({ target: { checked: true } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Review kind" }).props.onChange({ target: { value: kind === "design" ? "requirements" : "design" } }));
  expect(renderer.root.findAllByProps({ "aria-label": "Complete authoring node after approval" })).toHaveLength(0);
  await act(async () => renderer.root.findByProps({ "aria-label": "Review kind" }).props.onChange({ target: { value: kind } }));
  expect(renderer.root.findByProps({ "aria-label": "Complete authoring node after approval" }).props.checked).toBe(false);
  await act(async () => renderer.root.findByProps({ "aria-label": "Complete authoring node after approval" }).props.onChange({ target: { checked: true } }));
  for (const runId of ["closed", "reviewer"]) {
    await act(async () => renderer.root.findByProps({ "aria-label": "Author run" }).props.onChange({ target: { value: runId } }));
    expect(renderer.root.findAllByProps({ "aria-label": "Complete authoring node after approval" })).toHaveLength(0);
  }
  await act(async () => renderer.root.findByProps({ "aria-label": "Author run" }).props.onChange({ target: { value: "writer" } }));
  expect(renderer.root.findByProps({ "aria-label": "Complete authoring node after approval" }).props.checked).toBe(false);
  await act(async () => renderer.root.findByProps({ "aria-label": "Complete authoring node after approval" }).props.onChange({ target: { checked: true } }));
  for (const [label, value] of [["Reviewer run", "reviewer"], ["Source 1 field", "intent"], ["Source 1 changeId", "original-change"]]) {
    await act(async () => renderer.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } }));
  }
  if (kind === "design") await act(async () => renderer.root.findByProps({ "aria-label": "Other requirement approval IDs" }).props.onChange({ target: { value: "requirements-approved" } }));
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => renderer.root.findByProps({ "aria-label": "Assign source review" }).props.onSubmit({ preventDefault() {} }));
  expect(JSON.parse(request.mock.calls[1]![1].body)).toMatchObject({ kind, completionRunId: "writer", sources: [source], authorResponsibility: { kind: "agent", runId: "writer" } });
  expect(JSON.stringify(renderer.toJSON())).toContain("writing-task");
  expect(JSON.stringify(renderer.toJSON())).toContain("Authoring node awaiting review.");
});

it.each(["writing-task", "wrong-target"])("keeps approval on closure failure and explicitly retries only completion, checking returned target %s", async (completed) => {
  const mapped = { ...reviewRequest, completionRunId: "writer" };
  const current = { ...status, reviews: [{ ...status.reviews[0]!, request: mapped }, status.reviews[1]!] };
  const decision: ReviewDecision = { id: "approved", requestId: mapped.id, verdict: "accepted", basis: "Complete requirements", actorKind: "human", actor: "human-owner", reviewerRunId: null, createdAt: "date" };
  const accepted = { ...current, reviews: [{ ...current.reviews[0]!, request: { ...mapped, decisions: [decision], decidedAt: "date" } }, current.reviews[1]!] };
  const authoringRuns = runs.map((run) => run.id === "writer" ? { ...run, taskSlug: "writing-task", state: "closed", workPurpose: "requirements" } : run);
  const request = vi.fn().mockResolvedValueOnce(Response.json(current))
    .mockResolvedValueOnce(Response.json({ recorded: true, decision, status: accepted, authoringCompletion: { runId: "writer", taskSlug: "writing-task", status: "failed", message: "Human hold remains" } }))
    .mockResolvedValueOnce(Response.json({ completed }));
  const onOpenNode = vi.fn();
  await act(async () => { renderer = create(<ReviewAssignmentPanel project="project" slug="task" runs={authoringRuns} language="en" request={request} onChanged={vi.fn()} onOpenNode={onOpenNode} />); });
  await act(async () => renderer.root.findAllByType("button").find((button) => button.children.includes("writing-task"))!.props.onClick());
  expect(onOpenNode).toHaveBeenCalledWith("writing-task");
  await act(async () => renderer.root.findByProps({ "aria-label": "Human verdict" }).props.onChange({ target: { value: "accepted" } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Review basis" }).props.onChange({ target: { value: "Complete requirements" } }));
  await act(async () => renderer.root.findByProps({ "aria-label": "Human source decision" }).props.onSubmit({ preventDefault() {} }));
  expect(JSON.stringify(renderer.toJSON())).toContain("Approval retained; authoring node not completed: ");
  expect(JSON.stringify(renderer.toJSON())).toContain("Human hold remains");
  expect(renderer.root.findByProps({ "aria-label": "Review decisions" }).findAllByType("p")[0]!.children.join("")).toContain("Approved");
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => renderer.root.findAllByType("button").find((button) => button.children.includes("Retry authoring completion"))!.props.onClick());
  expect(request).toHaveBeenLastCalledWith("/workbench-api/loop/runs/writer/complete", expect.objectContaining({ method: "POST", body: "{}" }));
  expect(request.mock.calls.filter(([url]) => url.endsWith("/review-source"))).toHaveLength(1);
  if (completed === "writing-task") {
    expect(JSON.stringify(renderer.toJSON())).toContain("Authoring node completed.");
    expect(renderer.root.findAllByType("button").some((button) => button.children.includes("Retry authoring completion"))).toBe(false);
  } else {
    expect(JSON.stringify(renderer.toJSON())).toContain("Authoring completion target mismatch");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Authoring node completed.");
    expect(renderer.root.findAllByType("button").find((button) => button.children.includes("Retry authoring completion"))!.props.disabled).toBe(true);
  }
});

it("does not offer completion retry for a mapped run already completed", async () => {
  const approved: ReviewDecision = { id: "approved", requestId: reviewRequest.id, verdict: "accepted", basis: "Complete requirements", actorKind: "human", actor: "human-owner", reviewerRunId: null, createdAt: "date" };
  const current = { ...status, reviews: [{ ...status.reviews[0]!, request: { ...reviewRequest, completionRunId: "writer", decisions: [approved] } }, status.reviews[1]!] };
  const request = vi.fn().mockResolvedValueOnce(Response.json(current));
  await act(async () => { renderer = create(<ReviewAssignmentPanel project="project" slug="task" runs={runs.map((run) => run.id === "writer" ? { ...run, state: "completed" } : run)} language="en" request={request} onChanged={vi.fn()} />); });
  expect(JSON.stringify(renderer.toJSON())).toContain("Authoring node completed.");
  expect(renderer.root.findAllByType("button").some((button) => button.children.includes("Retry authoring completion"))).toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
});
