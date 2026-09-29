import { describe, expect, it } from "vite-plus/test";
import { buildRunPrompt, RUN_PROMPT_FORMAT, type RecordedRunContext } from "@project-workbench/ui/dispatch";

const context: RecordedRunContext = {
  runId: "run", packageId: "package", taskSlug: "child", createdAt: "2026-09-21T00:00:00Z",
  body: {
    task_slug: "child", workspace: "C:/worktree", dispatch_target: { credential: "excluded-target" },
    bundle: { Version: 2, Spec: { ID: "spec-child", Slug: "child", Intent: "Implement child", Role: "work", Stage: "approved", SpecifyOutput: { invariants: ["Preserve history"] }, Notes: "excluded-notes", ConversationLogs: ["excluded-conversation"], ContentHash: "excluded-hash" }, Decisions: [], Dependencies: null },
    scope_context: { sources: [{ id: "parent-id", slug: "parent", revision: "2", contract: { intent: "Parent goal", shape: { scope_out: ["No unrelated work"] }, specify: {} } }], relations: [{ from: "parent", to: "child", type: "COMPOSES" }], decisions: [{ ID: "decision", Slug: "choice", Status: "proposed", Body: "Evaluate approach", ContentHash: "excluded-decision-hash" }] },
  },
};

describe("immutable dispatch prompt", () => {
  it("carries only fixed QA references and applicability from the saved context", () => {
    const qaBasis = {
      requirementDecisionIds: ["req-decision"], designDecisionIds: ["design-decision"],
      designSources: [{ kind: "specgraph", specSlug: "design", field: "shape", changeId: "change-1" }],
      testPlanSources: [{ kind: "git", environmentId: "local", repositoryRoot: "C:/repo", commitSha: "a".repeat(40), path: "tests.md", entry: "Q3" }],
      applicability: "Applies to child node and its shared requirements.",
    };
    const recorded = { ...context, body: { ...(context.body as object), dispatch_target: { qaBasis: { ...qaBasis, content: "excluded-copy", testPlanSources: qaBasis.testPlanSources.map((source) => ({ ...source, body: "excluded-body" })) } } } };
    const prompt = buildRunPrompt("project", recorded, RUN_PROMPT_FORMAT);
    const packet = JSON.parse(prompt.slice(prompt.indexOf("{\n")));
    expect(packet.qaBasis).toEqual(qaBasis);
    expect(prompt).not.toContain("excluded-");
    expect(buildRunPrompt("project", context, RUN_PROMPT_FORMAT)).not.toContain('"qaBasis"');
  });

  it("keeps task/source identities and statuses without copying chats, credentials or hashes", () => {
    const before = structuredClone(context);
    const prompt = buildRunPrompt("project", context, RUN_PROMPT_FORMAT);
    expect(prompt).toContain("Implement child");
    expect(prompt).toContain("Parent goal");
    expect(prompt).toContain('"Status": "proposed"');
    expect(prompt).not.toContain('"scopeReviewIds"');
    expect(prompt).toContain('"dependencies": []');
    expect(prompt).not.toContain("excluded-");
    expect(buildRunPrompt("project", context, RUN_PROMPT_FORMAT)).toBe(prompt);
    expect(context).toEqual(before);
  });

  it("rejects unsupported formats and inconsistent identities instead of rebuilding current data", () => {
    expect(() => buildRunPrompt("project", context, "future-format")).toThrow("Unsupported");
    expect(() => buildRunPrompt("project", { ...context, taskSlug: "other" }, RUN_PROMPT_FORMAT)).toThrow("mismatch");
    const summary = structuredClone(context) as RecordedRunContext & { body: { bundle: { Spec: { Role: string } } } };
    summary.body.bundle.Spec.Role = "summary";
    expect(() => buildRunPrompt("project", summary, RUN_PROMPT_FORMAT)).toThrow("mismatch");
  });
});
