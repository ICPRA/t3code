import { IsoDateTime, MessageId, OrchestrationSearchThreadsInput, OrchestrationSearchThreadsResult, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { McpInvocationContext } from "./McpInvocationContext.ts";

export class WorkbenchKnowledgeError extends Schema.TaggedError<WorkbenchKnowledgeError>()(
  "WorkbenchKnowledgeError",
  { message: Schema.String },
) {}

const SearchConversations = Tool.make("workbench_search_conversations", {
  description:
    "Search user messages and canonical assistant outputs in this authenticated thread's native project. Includes archived conversations by default. Returns one matching excerpt per thread, not full conversations or files. The project is derived from the authenticated thread, never supplied by the model.",
  parameters: Schema.Struct({
    query: OrchestrationSearchThreadsInput.fields.query,
    includeArchived: Schema.optionalKey(Schema.Boolean),
    limit: OrchestrationSearchThreadsInput.fields.limit,
  }),
  success: Schema.Struct({
    scope: Schema.Literal("t3-project-conversations"),
    projectId: ProjectId,
    matches: OrchestrationSearchThreadsResult.fields.matches,
    limit: Schema.Int,
    includeArchived: Schema.Boolean,
    oneMatchPerThread: Schema.Literal(true),
  }),
  failure: WorkbenchKnowledgeError,
  dependencies: [McpInvocationContext],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ReadConversationMessage = Tool.make("workbench_read_conversation_message", {
  description: "Read original saved user/final assistant text from the same native project as the authenticated invoking thread. Use the exact threadId and messageId returned by workbench_search_conversations, never infer identity from timestamps. Reads one message in Unicode-character chunks; continue using nextOffset until null. Archived sources are allowed, deleted/streaming/reasoning/tool messages are excluded. updatedAt identifies the current source, not a frozen historical snapshot.",
  parameters: Schema.Struct({
    threadId: ThreadId, messageId: MessageId,
    offset: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))),
    maxCharacters: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12000 }))),
  }),
  success: Schema.Struct({
    projectId: ProjectId, threadId: ThreadId, messageId: MessageId,
    source: Schema.Literals(["user", "assistant"]), createdAt: IsoDateTime, updatedAt: IsoDateTime,
    text: Schema.String, offset: Schema.Int, nextOffset: Schema.NullOr(Schema.Int),
  }),
  failure: WorkbenchKnowledgeError,
  dependencies: [McpInvocationContext],
}).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true).annotate(Tool.OpenWorld, false);

export const WorkbenchKnowledgeToolkit = Toolkit.make(SearchConversations, ReadConversationMessage);

export const WorkbenchKnowledgeHandlersLive = WorkbenchKnowledgeToolkit.toLayer(
  Effect.gen(function* () {
    const snapshots = yield* ProjectionSnapshotQuery;
    const invokingProject = Effect.gen(function* () {
      const invocation = yield* McpInvocationContext;
      const thread = yield* snapshots.getThreadShellById(invocation.threadId).pipe(
        Effect.mapError(() => new WorkbenchKnowledgeError({ message: "Conversation search thread lookup failed" })),
      );
      if (Option.isNone(thread) || thread.value.archivedAt !== null) {
        return yield* new WorkbenchKnowledgeError({ message: "Conversation search requires an active invoking thread" });
      }
      return thread.value.projectId;
    });
    return WorkbenchKnowledgeToolkit.of({
      workbench_search_conversations: Effect.fn("workbench_search_conversations")(function* (input) {
        const projectId = yield* invokingProject;
        const limit = input.limit ?? 20;
        const includeArchived = input.includeArchived ?? true;
        const result = yield* snapshots.searchThreads({ projectId, query: input.query, includeArchived, limit }).pipe(
          Effect.mapError(() => new WorkbenchKnowledgeError({ message: "Conversation search failed" })),
        );
        return {
          scope: "t3-project-conversations" as const,
          projectId,
          matches: result.matches,
          limit,
          includeArchived,
          oneMatchPerThread: true as const,
        };
      }),
      workbench_read_conversation_message: Effect.fn("workbench_read_conversation_message")(function* (input) {
        const projectId = yield* invokingProject;
        const result = yield* snapshots.readProjectConversationMessage({
          projectId, threadId: input.threadId, messageId: input.messageId,
          offset: input.offset ?? 0, maxCharacters: input.maxCharacters ?? 6000,
        }).pipe(Effect.mapError(() => new WorkbenchKnowledgeError({ message: "Conversation source read failed" })));
        if (Option.isNone(result)) return yield* new WorkbenchKnowledgeError({ message: "Source message is unavailable in this project" });
        return result.value;
      }),
    });
  }),
);

export const WorkbenchKnowledgeRegistrationLive = McpServer.toolkit(WorkbenchKnowledgeToolkit).pipe(
  Layer.provide(WorkbenchKnowledgeHandlersLive),
);
