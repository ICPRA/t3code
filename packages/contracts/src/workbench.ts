import * as Schema from "effect/Schema";
import { EnvironmentId, NonNegativeInt, ProjectId } from "./baseSchemas.ts";

export const ConsultedRecord = Schema.Struct({
  specgraphProject: Schema.NonEmptyString,
  nativeProjectId: ProjectId,
  environmentId: EnvironmentId,
  kind: Schema.Literals(["spec", "decision", "change"]),
  id: Schema.NonEmptyString,
  slug: Schema.NonEmptyString,
  version: NonNegativeInt,
  sourceRefs: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type ConsultedRecord = typeof ConsultedRecord.Type;
