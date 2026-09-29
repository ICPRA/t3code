import { describe, expect, it, vi } from "vite-plus/test";
import { decodeDispatchTarget, dispatchRecordedRun, dispatchTargetMatchesProject, freezePromptPrefix, nativeDispatchInputs, qaBasisReady, readPendingDispatch, savePendingDispatch, type QABasis } from "./WorkbenchDispatch.logic";
import * as sharedModel from "@t3tools/shared/model";
import { ASSIGNMENT_ROLES, ROLE_GUIDANCE, QA_GUIDANCE, WORK_PURPOSES, PURPOSE_GUIDANCE } from "@project-workbench/ui/dispatch";

const target = decodeDispatchTarget({
  version: 1, promptFormatVersion: "vacpms-run-v2", environmentId: "local", projectId: "project", workspace: "C:\\project",
  threadId: "thread", createCommandId: "create", startCommandId: "start", messageId: "message", createdAt: "2026-09-21T00:00:00.000Z",
  title: "Task", modelSelection: { instanceId: "codex", model: "exact-model", options: [{ id: "reasoningEffort", value: "high" }] },
  runtimeMode: "approval-required", interactionMode: "default", branch: null, worktreePath: null, promptInjectedEffort: null, promptPrefix: "",
});
const context = {
  runId: "run", taskSlug: "task", packageId: "package", createdAt: target.createdAt,
  body: { task_slug: "task", workspace: target.workspace, dispatch_target: target,
    bundle: { Version: 2, Spec: { Slug: "task", Role: "work", Intent: "Implement task" }, Decisions: [], Dependencies: null },
  },
};
const qaBasis: QABasis = {
  requirementDecisionIds: ["req-decision-1", "req-decision-2"], designDecisionIds: ["design-decision-1"],
  designSources: [{ kind: "specgraph", specSlug: "design", field: "shape", changeId: "design-change-1" }],
  testPlanSources: [{ kind: "git", environmentId: "local", repositoryRoot: "C:/project", commitSha: "a".repeat(40), path: "QA-TEST-PLAN.md", entry: "Q3" }],
  applicability: "Shared requirements and test cases for this child node.",
};

describe("recorded native dispatch", () => {
  it("preserves every recorded QA basis reference through storage and actual native handoff", () => {
    const assigned = decodeDispatchTarget({ ...target, workPurpose: "implementation", purposeGuidance: PURPOSE_GUIDANCE.implementation, qaBasis });
    let raw: string | null = null;
    const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
    const plan = { project: "workbench", taskSlug: "task", key: "request", target: assigned };
    savePendingDispatch(storage, plan);
    const recovered = readPendingDispatch(storage)!;
    expect(recovered.target.qaBasis).toEqual(qaBasis);
    const storedContext = { ...context, body: { ...context.body, dispatch_target: assigned } };
    const first = nativeDispatchInputs("workbench", storedContext, recovered.target);
    expect(first.start.message.text).toContain('"req-decision-2"');
    expect(first.start.message.text).toContain('"design-change-1"');
    expect(first.start.message.text).toContain('"QA-TEST-PLAN.md"');
    expect(first.start.message.text).toContain(qaBasis.applicability);
    expect(nativeDispatchInputs("workbench", JSON.parse(JSON.stringify(storedContext)), recovered.target)).toEqual(first);
    expect(() => savePendingDispatch(storage, { ...plan, target: { ...assigned, qaBasis: { ...qaBasis, applicability: "Changed scope" } } })).toThrow("unresolved");
    expect(target.qaBasis).toBeUndefined();
  });

  it("requires purpose-specific basis without recursively requiring implementation prerequisites", () => {
    const empty = { requirementDecisionIds: [], designDecisionIds: [], designSources: [], testPlanSources: [], applicability: "" };
    for (const purpose of ["design", "test_design", "implementation", "test_execution"] as const) {
      expect(qaBasisReady(purpose, undefined)).toBe(false);
      expect(qaBasisReady(purpose, qaBasis)).toBe(true);
      expect(qaBasisReady(purpose, { ...qaBasis, applicability: " " })).toBe(false);
    }
    for (const purpose of ["requirements", "requirements_review", "design_review", "investigation", "coordination", "knowledge"] as const) expect(qaBasisReady(purpose, undefined)).toBe(true);
    expect(qaBasisReady("design", { ...empty, requirementDecisionIds: ["req-decision-1"], applicability: "Design scope" })).toBe(true);
    expect(qaBasisReady("test_design", { ...qaBasis, designDecisionIds: [], testPlanSources: [] })).toBe(true);
    expect(qaBasisReady("test_design", { ...qaBasis, designSources: [] })).toBe(false);
    expect(qaBasisReady("test_execution", { ...qaBasis, requirementDecisionIds: [], designDecisionIds: [], designSources: [] })).toBe(true);
    for (const missing of ["requirementDecisionIds", "designDecisionIds", "testPlanSources"] as const) expect(qaBasisReady("implementation", { ...qaBasis, [missing]: [] })).toBe(false);
    expect(qaBasisReady("test_execution", { ...qaBasis, testPlanSources: [{ kind: "specgraph", specSlug: "plan", field: "specify", changeId: " " }] })).toBe(false);
    expect(() => decodeDispatchTarget({ ...target, qaBasis: { ...qaBasis, applicability: " " } })).toThrow();
    expect(() => decodeDispatchTarget({ ...target, qaBasis: { ...qaBasis, designSources: [{ kind: "specgraph", specSlug: "design", field: "shape" }] } })).toThrow();
  });

  it("delivers each explicitly assigned purpose independently of executor responsibility", () => {
    for (const workPurpose of WORK_PURPOSES) {
      const assigned = decodeDispatchTarget({ ...target, assignmentRole: "executor", roleGuidance: ROLE_GUIDANCE.executor, workPurpose, purposeGuidance: PURPOSE_GUIDANCE[workPurpose] });
      const first = nativeDispatchInputs("workbench", context, assigned);
      expect(first.start.message.text.startsWith(PURPOSE_GUIDANCE[workPurpose] + ROLE_GUIDANCE.executor)).toBe(true);
      expect(first.start.message.text).toContain(`Work purpose: ${workPurpose}.`);
      if (workPurpose === "implementation") {
        expect(first.start.message.text).toContain("workbench_submit_own_delivery with its summary");
        expect(first.start.message.text).toContain("workbench_read_candidate_loop");
        expect(first.start.message.text).toContain("explicit expectedAttemptId");
        expect(first.start.message.text).toContain("workbench_next_own_candidate with the exact predecessor");
        expect(first.start.message.text).toContain("condition_met is not task completion");
      }
      if (workPurpose === "coordination") {
        expect(first.start.message.text).toContain("workbench_arm_delivery_hook");
        expect(first.start.message.text).toContain("Do not also dispatch that run immediately");
        expect(first.start.message.text).toContain("workbench_read_summary first");
        expect(first.start.message.text).toContain("echo current references and impactReview on workbench_accept_summary");
        expect(first.start.message.text).toContain("Root acceptance is not intermediate S approval");
        expect(first.start.message.text).toContain("old acceptance is not automatically reusable");
      }
      if (workPurpose === "implementation" || workPurpose === "test_execution") {
        expect(first.start.message.text).toContain("workbench_record_test_result");
        expect(first.start.message.text).toContain("workbench_read_test_results");
        expect(first.start.message.text).toContain("Keep unknown exitCode null");
        expect(first.start.message.text).toContain("Do not wait for the implementation node to be completed");
        expect(first.start.message.text).toContain("Recording a report does not complete the node");
      }
      expect(nativeDispatchInputs("workbench", context, decodeDispatchTarget(JSON.parse(JSON.stringify(assigned))))).toEqual(first);
    }
    expect(PURPOSE_GUIDANCE.test_design).toContain("before implementation");
    expect(PURPOSE_GUIDANCE.test_design).toContain("input conditions, expected outcomes");
    expect(PURPOSE_GUIDANCE.test_design).toContain("Do not copy observed code outputs");
    expect(PURPOSE_GUIDANCE.test_execution).toContain("actual delivered version");
    expect(PURPOSE_GUIDANCE.test_execution).toContain("passed, failed, not run and environment-blocked");
    expect(PURPOSE_GUIDANCE.test_execution).toContain("product defects, test-case errors and environment failures");
    expect(PURPOSE_GUIDANCE.test_execution).toContain("recorded gitBaseline commit");
    expect(PURPOSE_GUIDANCE.test_execution).toContain("Do not edit the tested code or switch revisions");
    expect(PURPOSE_GUIDANCE.test_execution).toContain("retest the new commit");
    expect(PURPOSE_GUIDANCE.test_execution).toContain("original output references");
    expect(PURPOSE_GUIDANCE.coordination).toContain("workbench_read_node_owner(taskSlug)");
    expect(PURPOSE_GUIDANCE.coordination).toContain("Mail handoff is not node return");
  });

  it("keeps stored purpose guidance frozen and leaves historical missing purpose unknown", () => {
    const saved = decodeDispatchTarget({ ...target, workPurpose: "test_design", purposeGuidance: "Previously recorded test design instructions.\n\n" });
    let raw: string | null = null;
    const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
    const plan = { project: "workbench", taskSlug: "task", key: "request", target: saved };
    savePendingDispatch(storage, plan);
    const recovered = readPendingDispatch(storage)!;
    const replay = nativeDispatchInputs("workbench", context, recovered.target).start.message.text;
    expect(replay.startsWith(saved.purposeGuidance!)).toBe(true);
    expect(replay).not.toContain(PURPOSE_GUIDANCE.test_design);
    expect(() => savePendingDispatch(storage, { ...plan, target: { ...saved, workPurpose: "implementation", purposeGuidance: PURPOSE_GUIDANCE.implementation } })).toThrow("unresolved");
    expect(target.workPurpose).toBeUndefined();
    expect(target.purposeGuidance).toBeUndefined();
    expect(nativeDispatchInputs("workbench", context, target).start.message.text).not.toContain("Work purpose:");
  });

  it("rejects incomplete, invalid or blank purpose pairs at the saved target boundary", () => {
    for (const fields of [
      { workPurpose: "implementation" }, { purposeGuidance: "Recorded instructions" },
      { workPurpose: "unknown", purposeGuidance: "Recorded instructions" },
      { workPurpose: "design", purposeGuidance: "" }, { workPurpose: "design", purposeGuidance: " \n " },
      { workPurpose: "design", purposeGuidance: "x".repeat(4001) },
    ]) expect(() => decodeDispatchTarget({ ...target, ...fields })).toThrow();
  });

  it("delivers the pre-implementation QA instructions to every assigned role, without claiming workflow compliance", () => {
    expect(QA_GUIDANCE).toContain("review requirements when proposed");
    expect(QA_GUIDANCE).toContain("review the design proposal before code implementation");
    expect(QA_GUIDANCE).toContain("expected outcomes and coverage from the requirements and design");
    expect(QA_GUIDANCE).toContain("not from the implementation's observed behavior");
    for (const assignmentRole of ASSIGNMENT_ROLES) {
      const assigned = decodeDispatchTarget({ ...target, assignmentRole, roleGuidance: ROLE_GUIDANCE[assignmentRole] });
      const input = nativeDispatchInputs("project", context, assigned);
      expect(input.start.message.text).toContain(QA_GUIDANCE);
      expect(input.start.message.text).toContain("workbench_complete_own_run with no arguments");
      if (assignmentRole === "executor") {
        expect(input.start.message.text).toContain("workbench_record_own_node_event");
        expect(input.start.message.text).toContain("workbench_read_node_events");
        expect(input.start.message.text).toContain("ordinary candidate iterations and tool calls are not automatically retries");
        expect(input.start.message.text).toContain("recording them never grants permission to mutate Git");
      }
      for (const boundary of ["existing completion checks, not new approval", "unconfirmed outcome: inspect task state, no blind retry",
        "workbench_read_review_request with decisionId", "read fixed originals", "never use decision ID as requestId or latest approval",
        "no extra permissions, permanent/sole ownership or automatic role agents", "via workspace tools if present; follow originals",
        "Absence is a knowledge gap", "workbench_mail_context", "workbench_mail_inbox/workbench_mail_owned_threads",
        "relevant full threads", "workbench_mail_directory/next_cursor", "not presence or sole ownership",
        "Never guess recipient IDs", "Before retiring, list workbench_mail_owned_threads then workbench_mail_handoff",
        "Summaries/recommendations are not formal decisions"]) expect(input.start.message.text).toContain(boundary);
      if (assignmentRole === "manager") {
        expect(input.start.message.text).toContain("workbench_subdivide_node");
        expect(input.start.message.text).toContain("workbench_read_dependency_state");
        expect(input.start.message.text).toContain("workbench_list_dispatch_models");
        expect(input.start.message.text).toContain("workbench_prepare_node_run");
        expect(input.start.message.text).toContain("workbench_dispatch_prepared_run");
        expect(input.start.message.text).toContain("workbench_mail_owned_threads");
        expect(input.start.message.text).toContain("workbench_mail_handoff");
        expect(input.start.message.text).toContain("workbench_mail_retired_threads");
        expect(input.start.message.text).toContain("workbench_mail_takeover");
        expect(input.start.message.text).toContain("not content approval or permission to start models");
        expect(input.start.message.text).toContain("workbench_read_summary first");
        expect(input.start.message.text).toContain("echo current references and impactReview on workbench_accept_summary");
        expect(input.start.message.text).toContain("workbench_record_summary_disposition/workbench_revoke_summary_acceptance");
        expect(input.start.message.text).toContain("Root acceptance is not intermediate S approval");
        expect(input.start.message.text).toContain("old acceptance is not automatically reusable");
        for (const guidance of ["read current node/original basis and workbench_read_node_mark_history first",
          "workbench_set_node_mark only if facts are unequivocally clear AND change necessary",
          "Any uncertainty: human first, retain marks", "never override unclear/conflicting human basis",
          "confidence/confirmed are not proof", "expectedMarkId: latest same-kind ID, empty only if none",
          "Conflict: reread history, no automatic retry", "Unknown write is not absence; reconcile history first"]) {
          expect(input.start.message.text).toContain(guidance);
        }
        expect(ROLE_GUIDANCE.manager.length).toBeLessThanOrEqual(4000);
      }
      expect(input.start.message.text).toContain("not that your process stopped");
      expect(input.start.message.text).not.toContain("use workbench_assign_review with the real delivery");
    }
  });
  it("preserves an isolated native workspace and rejects a conflicting prepared path", () => {
    const isolated = decodeDispatchTarget({ ...target, workspace: "C:/worktrees/task", worktreePath: "C:/worktrees/task", branch: "task", projectWorkspaceRoot: "C:\\project" });
    const project = { id: "project", environmentId: "local", workspaceRoot: "C:\\project" };
    expect(dispatchTargetMatchesProject(isolated, project)).toBe(true);
    expect(dispatchTargetMatchesProject(isolated, { ...project, workspaceRoot: "C:/other" })).toBe(false);
    expect(() => nativeDispatchInputs("workbench", context, isolated)).toThrow("Prepared workspace");
    expect(nativeDispatchInputs("workbench", { ...context, body: { ...context.body, workspace: isolated.workspace } }, isolated).create).toMatchObject({ branch: "task", worktreePath: "C:/worktrees/task" });
  });
  it("reuses distinct stable command IDs and identical model/runtime on every replay", () => {
    const first = nativeDispatchInputs("workbench", context, target);
    const replay = nativeDispatchInputs("workbench", JSON.parse(JSON.stringify(context)), decodeDispatchTarget(JSON.parse(JSON.stringify(target))));
    expect(replay).toEqual(first);
    expect(first.create.commandId).toBe("create");
    expect(first.start.commandId).toBe("start");
    expect(first.start.message.messageId).toBe("message");
    expect(first.start.modelSelection).toEqual(first.create.modelSelection);
    expect(first.start.runtimeMode).toBe(first.create.runtimeMode);
    expect(first.start.message.text).not.toContain("dispatch_target");
  });

  it("creates, binds, authorizes, then starts the original command", async () => {
    const order: string[] = [];
    await dispatchRecordedRun({ project: "workbench", context, target, checkCurrent: () => {},
      create: async () => { order.push("create"); }, bind: async () => { order.push("bind"); },
      authorize: async () => { order.push("authorize"); }, start: async () => { order.push("start"); },
    });
    expect(order).toEqual(["create", "bind", "authorize", "start"]);
  });

  it("delivers the stored retrieval guidance without rewriting older dispatches", () => {
    const guided = decodeDispatchTarget({ ...target, retrievalGuidance: "Inspect prior project decisions.\n\n" });
    const first = nativeDispatchInputs("workbench", context, guided);
    expect(first.start.message.text).toContain("Inspect prior project decisions.");
    expect(nativeDispatchInputs("workbench", context, decodeDispatchTarget(JSON.parse(JSON.stringify(guided))))).toEqual(first);
    expect(nativeDispatchInputs("workbench", context, target).start.message.text).not.toContain("Inspect prior project decisions.");
  });

  it("sends each assigned role and reuses its recorded guidance before retrieval", () => {
    for (const assignmentRole of ASSIGNMENT_ROLES) {
      const assigned = decodeDispatchTarget({ ...target, assignmentRole, roleGuidance: ROLE_GUIDANCE[assignmentRole], retrievalGuidance: "Saved retrieval instructions.\n\n" });
      const first = nativeDispatchInputs("workbench", context, assigned);
      expect(first.start.message.text.startsWith(ROLE_GUIDANCE[assignmentRole] + assigned.retrievalGuidance)).toBe(true);
      expect(first.start.message.text).toContain(`Assignment role: ${assignmentRole}.`);
      expect(nativeDispatchInputs("workbench", context, decodeDispatchTarget(JSON.parse(JSON.stringify(assigned))))).toEqual(first);
    }
    const saved = decodeDispatchTarget({ ...target, assignmentRole: "knowledge", roleGuidance: "Previously recorded knowledge responsibilities.\n\n" });
    const replay = nativeDispatchInputs("workbench", context, saved).start.message.text;
    expect(replay.startsWith(saved.roleGuidance!)).toBe(true);
    expect(replay).not.toContain(ROLE_GUIDANCE.knowledge);
    expect(target.assignmentRole).toBeUndefined();
    expect(target.roleGuidance).toBeUndefined();
    expect(nativeDispatchInputs("workbench", context, target).start.message.text).not.toContain("Assignment role:");
  });

  it("rejects incomplete or invalid recorded role assignments", () => {
    for (const fields of [
      { assignmentRole: "knowledge" }, { roleGuidance: "Recorded instructions" },
      { assignmentRole: "unknown", roleGuidance: "Recorded instructions" },
      { assignmentRole: "manager", roleGuidance: "" }, { assignmentRole: "manager", roleGuidance: " \n " },
      { assignmentRole: "reviewer", roleGuidance: "x".repeat(4001) },
    ]) expect(() => decodeDispatchTarget({ ...target, ...fields })).toThrow();
  });

  it("never sends a start after authorization fails", async () => {
    const start = vi.fn();
    await expect(dispatchRecordedRun({ project: "workbench", context, target, checkCurrent: () => {},
      create: async () => {}, bind: async () => {}, authorize: async () => { throw new Error("scope changed"); }, start,
    })).rejects.toThrow("scope changed");
    expect(start).not.toHaveBeenCalled();
  });

  it("suppresses late continuation when the selected scope changes during create", async () => {
    let cancelled = false;
    const bind = vi.fn(); const start = vi.fn();
    await expect(dispatchRecordedRun({ project: "workbench", context, target,
      checkCurrent: () => { if (cancelled) throw new Error("scope changed"); },
      create: async () => { cancelled = true; }, bind, authorize: async () => {}, start,
    })).rejects.toThrow("scope changed");
    expect(bind).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });

  it("retains the same payload after an unknown start outcome and reauthorizes retry", async () => {
    const start = vi.fn().mockRejectedValueOnce(new Error("connection lost")).mockResolvedValueOnce(undefined);
    const authorize = vi.fn(async () => {});
    const input = { project: "workbench", context, target, checkCurrent: () => {}, create: async () => {}, bind: async () => {}, authorize, start };
    await expect(dispatchRecordedRun(input)).rejects.toThrow("connection lost");
    await dispatchRecordedRun(input);
    expect(start.mock.calls[0]).toEqual(start.mock.calls[1]); expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("rejects unknown prompt versions instead of producing a new payload", () => {
    expect(() => decodeDispatchTarget({ ...target, promptFormatVersion: "future" })).toThrow();
    expect(() => decodeDispatchTarget({ ...target, worktreePath: "C:/other-checkout" })).toThrow();
    expect(() => decodeDispatchTarget({ ...target, branch: "other-branch" })).toThrow();
  });

  it("canonicalizes a JSONB-style reordered target before recovery comparison", () => {
    const reversed: Record<string, unknown> = Object.fromEntries(Object.entries(target).toReversed());
    reversed.modelSelection = Object.fromEntries(Object.entries(target.modelSelection).toReversed());
    expect(JSON.stringify(decodeDispatchTarget(reversed))).toBe(JSON.stringify(target));
  });

  it("freezes native prefix semantics and does not consult the helper on replay", () => {
    const prefixed = { ...target, promptInjectedEffort: "ultrathink", promptPrefix: freezePromptPrefix("ultrathink") };
    const first = nativeDispatchInputs("workbench", context, prefixed);
    const changed = vi.spyOn(sharedModel, "applyClaudePromptEffortPrefix").mockReturnValue("different upstream behavior");
    try {
      expect(nativeDispatchInputs("workbench", context, prefixed)).toEqual(first);
      expect(changed).not.toHaveBeenCalled();
      expect(() => freezePromptPrefix("ultrathink")).toThrow("transformation changed");
    } finally { changed.mockRestore(); }
  });

  it("preserves the single recovery slot and refuses another request", () => {
    let raw: string | null = null;
    const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
    const plan = { project: "workbench", taskSlug: "task", key: "request", target };
    savePendingDispatch(storage, plan);
    expect(() => savePendingDispatch(storage, { ...plan, taskSlug: "other" })).toThrow("unresolved");
    expect(readPendingDispatch(storage)).toEqual(plan);
    savePendingDispatch(storage, { ...plan, runId: "run" });
    expect(readPendingDispatch(storage)?.runId).toBe("run");
  });

  it("propagates storage failures and enforces a finite byte limit", () => {
    const plan = { project: "workbench", taskSlug: "task", key: "request", target };
    expect(() => savePendingDispatch({ getItem: () => null, setItem: () => { throw new Error("quota"); } }, plan)).toThrow("quota");
    const setItem = vi.fn();
    expect(() => savePendingDispatch({ getItem: () => null, setItem }, { ...plan, target: { ...target, title: "x".repeat(32769) } })).toThrow("32 KiB");
    expect(setItem).not.toHaveBeenCalled();
  });
});
