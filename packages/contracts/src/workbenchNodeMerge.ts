import * as Schema from "effect/Schema";

const text = Schema.NonEmptyString;
const source = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("specgraph"), specSlug: text, field: text, changeId: text }),
  Schema.Struct({ kind: Schema.Literal("git"), environmentId: text, repositoryRoot: text,
    commitSha: text, path: text, entry: Schema.optional(text) }),
]);

export const WorkbenchMergeRelation = Schema.Struct({ fromSlug: text, toSlug: text, type: text, changeId: Schema.String });
export type WorkbenchMergeRelation = typeof WorkbenchMergeRelation.Type;

export const WorkbenchMergeSummaryReferences = Schema.Struct({
  nodes: Schema.Array(Schema.Struct({ id: text, slug: text, role: Schema.Literals(["work", "summary"]),
    sourceRefs: Schema.Record(Schema.String, Schema.String), completionGeneration: Schema.optional(Schema.Int),
    lifecycleChangeId: Schema.String })),
  relations: Schema.Array(Schema.Struct({ ...WorkbenchMergeRelation.fields, present: Schema.Boolean })),
  dispositionIds: Schema.Array(Schema.String),
  decisionSources: Schema.Array(Schema.Struct({ id: text, slug: text,
    sourceRefs: Schema.Record(Schema.String, Schema.String) })),
});

const specRef = Schema.Struct({ id: text, slug: text, version: Schema.Int, stage: text,
  role: Schema.Literals(["work", "summary"]) });
export const WorkbenchMergePreview = Schema.Struct({
  sources: Schema.Array(specRef), contexts: Schema.Array(specRef),
  relations: Schema.Array(WorkbenchMergeRelation), lineage: Schema.Array(WorkbenchMergeRelation),
  ancestors: Schema.Array(Schema.Struct({ goalSlug: text, references: WorkbenchMergeSummaryReferences })),
});
export type WorkbenchMergePreview = typeof WorkbenchMergePreview.Type;

const sparkOutput = Schema.Struct({ seed: Schema.optional(Schema.String), signal: Schema.optional(Schema.String),
  questions: Schema.optional(Schema.Array(Schema.String)), scope_sniff: Schema.optional(Schema.String),
  kill_test: Schema.optional(Schema.String) });
const shapeOutput = Schema.Struct({ scope_in: Schema.optional(Schema.Array(Schema.String)),
  scope_out: Schema.optional(Schema.Array(Schema.String)),
  approaches: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String), tradeoffs: Schema.optional(Schema.Array(Schema.String)) }))),
  chosen_approach: Schema.optional(Schema.String), risks: Schema.optional(Schema.Array(Schema.String)),
  success_must: Schema.optional(Schema.Array(Schema.String)), success_should: Schema.optional(Schema.Array(Schema.String)),
  success_wont: Schema.optional(Schema.Array(Schema.String)),
  decisions: Schema.optional(Schema.Array(Schema.Struct({ slug: text, title: text,
    decision: text, rationale: text }))) });
const specifyOutput = Schema.Struct({
  interfaces: Schema.optional(Schema.Array(Schema.Struct({ name: text, body: text }))),
  verify_criteria: Schema.optional(Schema.Array(Schema.Struct({ category: text, description: text }))),
  invariants: Schema.optional(Schema.Array(Schema.String)),
  touches: Schema.optional(Schema.Array(Schema.Struct({ path: text, purpose: text, change_type: text }))),
});
const target = Schema.Struct({ slug: text, intent: text, role: Schema.Literals(["work", "summary"]),
  priority: Schema.Literals(["p0", "p1", "p2", "p3"]), complexity: Schema.Literals(["low", "medium", "high"]),
  notes: Schema.optional(Schema.String), sparkOutput: Schema.optional(sparkOutput),
  shapeOutput: Schema.optional(shapeOutput), specifyOutput: Schema.optional(specifyOutput) });
const disposition = Schema.Struct({ goalSlug: text, affectedSlug: text,
  disposition: Schema.Literals(["retain", "adjust", "replace", "withdraw", "needs_review"]),
  replacementSlug: Schema.optional(Schema.String), reviewDecisionId: Schema.String,
  beforeSources: Schema.Array(source), afterSources: Schema.Array(source), reason: text, idempotencyKey: text });

export const WorkbenchMergeRequest = Schema.Struct({
  expected: WorkbenchMergePreview, target,
  relations: Schema.Array(Schema.Struct({ before: WorkbenchMergeRelation,
    action: Schema.Literals(["retain", "remove", "rewire"]), replacements: Schema.optional(Schema.Array(WorkbenchMergeRelation)) })),
  addedRelations: Schema.Array(WorkbenchMergeRelation), dispositions: Schema.Array(disposition),
  reason: text, idempotencyKey: text,
});
export type WorkbenchMergeRequest = typeof WorkbenchMergeRequest.Type;

export const WorkbenchMergeReceipt = Schema.Struct({
  id: text, idempotencyKey: text, request: WorkbenchMergeRequest,
  actorUserId: text, actorRunId: Schema.optional(text),
  sources: Schema.Array(Schema.Struct({ id: text, slug: text, beforeVersion: Schema.Int, afterVersion: Schema.Int })),
  target: Schema.Struct({ id: text, slug: text }),
  insertedRelations: Schema.Array(WorkbenchMergeRelation), deletedRelations: Schema.Array(WorkbenchMergeRelation),
  dispositionIds: Schema.Array(text), createdAt: text, replayed: Schema.Boolean,
});
export type WorkbenchMergeReceipt = typeof WorkbenchMergeReceipt.Type;

export const WorkbenchMergeHistory = Schema.Struct({
  items: Schema.Array(WorkbenchMergeReceipt), hasMore: Schema.Boolean, nextCursor: Schema.String,
});
export type WorkbenchMergeHistory = typeof WorkbenchMergeHistory.Type;
