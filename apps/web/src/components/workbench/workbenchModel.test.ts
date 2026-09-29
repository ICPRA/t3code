import { describe, expect, it } from "vite-plus/test";
import {
  dependencyDirection,
  evidenceResult,
  latestAcceptance,
  taskRejectionCounts,
  taskRecords,
  specColumns,
  workProgress,
  validateWorkbenchSearch,
  validateDeliveryHooks,
  validateDeliveryHookReceipt,
  type DeliveryTestHook,
  type CurrentView,
} from "./workbenchModel";

describe("workbench facts", () => {
  it("preserves unavailable hook data and rejects malformed supplied records instead of normalizing them to empty", () => {
    const hook: DeliveryTestHook = { id: "hook", project: "one", sourceRunId: "source", sourceTaskSlug: "implementation", targetRunId: "target", targetTaskSlug: "tests", targetPackageId: "package", commitSha: "fixed-commit", configuredByRunId: "pm-run", configuredByUserId: "pm-user", hostConsumerUserId: "host-service", createdAt: "now",
      deliveryId: null, triggeredAt: null, cancelledAt: null, cancelledByRunId: null, cancelledByUserId: null, cancellationReason: null,
      dispatchStatus: null, dispatchPhase: null, dispatchDetail: null, dispatchRecordedAt: null, retriedAt: null, retriedByRunId: null, retriedByUserId: null, state: "armed" };
    expect(() => validateDeliveryHooks(undefined, "one")).not.toThrow();
    expect(() => validateDeliveryHooks([], "one")).not.toThrow();
    expect(() => validateDeliveryHooks([hook], "one")).not.toThrow();
    expect(() => validateDeliveryHooks([{ ...hook, configuredByRunId: null }], "one")).not.toThrow();
    const receipt = { ...hook, sourceTaskSlug: undefined, targetTaskSlug: undefined, configuredByRunId: null };
    expect(() => validateDeliveryHookReceipt(receipt, "one")).not.toThrow();
    expect(() => validateDeliveryHooks([receipt], "one")).toThrow("Invalid delivery hooks");
    for (const supplied of [null, {}, [null], [hook, hook], [{ ...hook, project: "foreign" }], [{ ...hook, state: "passed" }], [{ ...hook, targetTaskSlug: undefined }], [{ ...hook, dispatchStatus: "passed" }], [{ ...hook, configuredByRunId: "" }], [{ ...hook, configuredByUserId: "" }], [{ ...hook, hostConsumerUserId: "" }]]) {
      expect(() => validateDeliveryHooks(supplied, "one")).toThrow("Invalid delivery hooks");
    }
  });

  it("counts recorded completion without counting summaries or withdrawn work as unfinished tasks", () => {
    const spec = (slug: string, stage: string, role: "work" | "summary" = "work") => ({ slug, title: slug, stage, role, priority: "p2" });
    expect(workProgress([
      spec("parent", "done", "summary"), spec("done", "done"), spec("review", "review"),
      spec("active", "in_progress"), spec("cut", "abandoned"), spec("old", "superseded"),
    ])).toEqual({ current: 3, completed: 1, withdrawn: 2, summaries: 1 });
    expect(workProgress([])).toEqual({ current: 0, completed: 0, withdrawn: 0, summaries: 0 });
  });
  it("retains historical rejection counts after acceptance without inferring failed retries", () => {
    const run = (id: string, taskSlug: string) => ({ id, taskSlug, packageId: "p", generation: 1, threadRef: "t", workspace: "w", state: "completed", createdAt: "", updatedAt: "" });
    const counts = taskRejectionCounts({
      runs: [run("a", "task-a"), run("b", "task-b")],
      deliveries: [{ id: "da", runBindingId: "a", submittedBy: "u", submittedAt: "" }, { id: "db", runBindingId: "b", submittedBy: "u", submittedAt: "" }],
      acceptances: [
        { id: "1", deliveryId: "da", verdict: "rejected", approver: "u", createdAt: "" },
        { id: "2", deliveryId: "da", verdict: "rejected", approver: "u", createdAt: "" },
        { id: "3", deliveryId: "da", verdict: "accepted", approver: "u", createdAt: "" },
        { id: "4", deliveryId: "db", verdict: "accepted", approver: "u", createdAt: "" },
      ],
    });
    expect([...counts]).toEqual([["task-a", 2]]);
  });
  it("separates explicit summary nodes from done work without rewriting historical stages", () => {
    const parent: CurrentView["specs"][number] = { slug: "parent", title: "Parent", stage: "done", priority: "p2", role: "summary" };
    const work: CurrentView["specs"][number] = { slug: "work", title: "Work", stage: "done", priority: "p2", role: "work" };
    expect(specColumns([parent, work])).toEqual([["summary", [parent]], ["done", [work]]]);
    expect(parent.stage).toBe("done");
  });
  it("groups every spec by its recorded business stage without changing or hiding it", () => {
    const specs = [
      { slug: "closed", title: "Closed", stage: "done", priority: "p1" },
      { slug: "new", title: "New", stage: "spark", priority: "p2" },
      { slug: "active", title: "Active", stage: "in_progress", priority: "p1" },
      { slug: "review", title: "Review", stage: "review", priority: "p1" },
      { slug: "future", title: "Future", stage: "future-stage", priority: "p2" },
      { slug: "new-2", title: "New 2", stage: "spark", priority: "p2" },
    ];
    const before = specs.slice();
    const columns = specColumns(specs);
    expect(columns.map(([stage]) => stage)).toEqual([
      "spark",
      "in_progress",
      "review",
      "done",
      "future-stage",
    ]);
    expect(columns[0]?.[1].map((spec) => spec.slug)).toEqual(["new", "new-2"]);
    expect(columns.flatMap(([, group]) => group).length).toBe(specs.length);
    expect(specs).toEqual(before);
    expect(specColumns([])).toEqual([]);
  });
  it("normalizes dependency directions without treating other edges as blockers", () => {
    expect(dependencyDirection({ from: "a", to: "b", type: "BLOCKS" })).toEqual({
      prerequisite: "a",
      dependent: "b",
    });
    expect(dependencyDirection({ from: "a", to: "b", type: "DEPENDS_ON" })).toEqual({
      prerequisite: "b",
      dependent: "a",
    });
    expect(dependencyDirection({ from: "a", to: "missing", type: "RELATES_TO" })).toBeNull();
  });

  it("keeps unknown evidence distinct from a successful command", () => {
    expect(evidenceResult(null)).toBe("unknown");
    expect(evidenceResult(0)).toBe("command-succeeded");
    expect(evidenceResult(1)).toBe("command-failed");
  });

  it("does not let an older acceptance hide a later rejection", () => {
    const records = [
      {
        id: "z",
        deliveryId: "d",
        verdict: "accepted",
        approver: "reviewer",
        createdAt: "2026-09-19T01:00:00.123100Z",
      },
      {
        id: "a",
        deliveryId: "d",
        verdict: "rejected",
        approver: "reviewer",
        createdAt: "2026-09-19T01:00:00.123900Z",
      },
    ];
    expect(latestAcceptance(records, "d")?.verdict).toBe("rejected");
    expect(latestAcceptance(records, "missing")).toBeUndefined();
    expect(
      latestAcceptance(
        records.map((record) => ({ ...record, createdAt: records[0]!.createdAt })),
        "d",
      )?.verdict,
    ).toBe("rejected");
  });

  it("filters linked records without inferring runtime status from an authoring stage", () => {
    const data: CurrentView = {
      project: "p",
      generatedAt: "2026-09-19T00:00:00Z",
      specs: [
        { slug: "a", title: "A", stage: "approved", priority: "P1" },
        { slug: "b", title: "B", stage: "done", priority: "P2" },
      ],
      decisions: [],
      graph: { nodes: [], edges: [] },
      runs: [
        {
          id: "r",
          taskSlug: "a",
          packageId: "pkg",
          generation: 1,
          threadRef: "thread",
          workspace: "workspace",
          state: "bound",
          createdAt: "2026-09-19T00:00:00Z",
          updatedAt: "2026-09-19T00:00:00Z",
        },
      ],
      deliveries: [
        { id: "d", runBindingId: "r", submittedBy: "agent", submittedAt: "2026-09-19T00:00:00Z" },
      ],
      evidence: [
        {
          id: "e",
          deliveryId: "d",
          kind: "command",
          command: "test",
          exitCode: null,
          verifier: "agent",
          createdAt: "2026-09-19T00:00:00Z",
        },
      ],
      acceptances: [],
      capabilities: { independentVerification: false, discussionAuthorization: false },
    };
    expect(taskRecords(data, "a").runs[0]?.state).toBe("bound");
    expect(taskRecords(data, "a").evidence.map((entry) => entry.id)).toEqual(["e"]);
    expect(taskRecords(data, "b")).toEqual({ runs: [], deliveries: [], evidence: [] });
    expect(taskRecords(data, null).deliveries).toEqual(data.deliveries);
  });

  it("keeps task selection scoped to a valid project search and rejects malformed tabs", () => {
    expect(
      validateWorkbenchSearch({ project: "p", tab: "tasks", selected: "s", layout: "board" }),
    ).toEqual({
      project: "p",
      tab: "tasks",
      selected: "s",
      layout: "board",
    });
    expect(validateWorkbenchSearch({ project: 12, selected: "s", tab: "tasks" })).toEqual({});
    expect(validateWorkbenchSearch({ selected: "s" })).toEqual({});
    expect(validateWorkbenchSearch({ project: "p", tab: ["tasks"], selected: {} })).toEqual({
      project: "p",
    });
    expect(validateWorkbenchSearch({ project: "p", tab: "bogus" })).toEqual({ project: "p" });
    expect(validateWorkbenchSearch({ project: "p", layout: "table" })).toEqual({
      project: "p",
      layout: "table",
    });
    expect(validateWorkbenchSearch({ project: "p", layout: ["table"] })).toEqual({ project: "p" });
    expect(validateWorkbenchSearch({ project: "p", tab: "sessions", selected: "task", runId: "exact-run" })).toEqual({ project: "p", tab: "sessions", selected: "task", runId: "exact-run" });
    expect(validateWorkbenchSearch({ project: "p", tab: "pending", selected: "task", runId: "exact-run" })).toEqual({ project: "p", tab: "pending", selected: "task" });
  });
});
