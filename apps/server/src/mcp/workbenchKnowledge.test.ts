import {
  EnvironmentId, MessageId, ProjectId, ProviderInstanceId, ThreadId,
  type OrchestrationSearchThreadsInput, type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Tool } from "effect/unstable/ai";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import { WorkbenchKnowledgeHandlersLive, WorkbenchKnowledgeToolkit } from "./workbenchKnowledge.ts";

const invocation: McpInvocationScope = {
  environmentId: EnvironmentId.make("native-environment"),
  threadId: ThreadId.make("native-thread"),
  providerSessionId: "native-session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(),
  issuedAt: 1,
};
const projectId = ProjectId.make("native-project");
// Only project identity and archive state are consumed from the native shell.
const thread = { projectId, archivedAt: null } as OrchestrationThreadShell;

it.effect("reads the exact source message using authenticated project scope and explicit continuation", () => Effect.gen(function* () {
  const source = { projectId, threadId: ThreadId.make("source-thread"), messageId: MessageId.make("source-message"),
    source: "assistant" as const, text: "Original text", offset: 0, nextOffset: 6000,
    createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z" };
  const snapshots = Layer.mock(ProjectionSnapshotQuery)({
    getThreadShellById: () => Effect.succeed(Option.some(thread)),
    readProjectConversationMessage: (input) => {
      expect(input).toEqual({ projectId, threadId: source.threadId, messageId: source.messageId, offset: 0, maxCharacters: 6000 });
      return Effect.succeed(Option.some(source));
    },
  });
  const built = yield* WorkbenchKnowledgeToolkit.pipe(Effect.provide(WorkbenchKnowledgeHandlersLive.pipe(Layer.provide(snapshots))));
  const results = yield* built.handle("workbench_read_conversation_message", { threadId: source.threadId, messageId: source.messageId, projectId: "forged" } as never).pipe(
    Stream.unwrap, Stream.runCollect, Effect.provideService(McpInvocationContext, invocation),
  );
  expect(results.at(-1)?.result).toEqual(source);
}));

it.effect("derives conversation scope from authentication and ignores model identity", () => Effect.gen(function* () {
  const requests: OrchestrationSearchThreadsInput[] = [];
  const matches = [{
    threadId: ThreadId.make("source-thread"), projectId, source: "user" as const,
    snippet: "Original source excerpt", messageCreatedAt: "2026-09-23T00:00:00.000Z",
  }];
  const snapshots = Layer.mock(ProjectionSnapshotQuery)({
    getThreadShellById: (id) => {
      expect(id).toBe(invocation.threadId);
      return Effect.succeed(Option.some(thread));
    },
    searchThreads: (input) => {
      requests.push(input);
      return Effect.succeed({ matches });
    },
  });
  const built = yield* WorkbenchKnowledgeToolkit.pipe(
    Effect.provide(WorkbenchKnowledgeHandlersLive.pipe(Layer.provide(snapshots))),
  );
  const call = (payload: unknown) => built.handle("workbench_search_conversations", payload as never).pipe(
    Stream.unwrap, Stream.runCollect, Effect.provideService(McpInvocationContext, invocation),
  );
  const result = yield* call({ query: "source" });
  expect(requests).toEqual([{ projectId, query: "source", includeArchived: true, limit: 20 }]);
  expect(result.at(-1)?.result).toEqual({
    scope: "t3-project-conversations", projectId, matches, limit: 20,
    includeArchived: true, oneMatchPerThread: true,
  });
  yield* call({ query: "source", includeArchived: false, limit: 1 });
  expect(requests[1]).toEqual({ projectId, query: "source", includeArchived: false, limit: 1 });
  for (const field of ["projectId", "threadId", "environmentId", "providerSessionId", "unknown"]) {
    yield* call({ query: "source", [field]: "forged" });
    expect(requests.at(-1)).toEqual({ projectId, query: "source", includeArchived: true, limit: 20 });
  }
  expect(requests).toHaveLength(7);
  const tool = WorkbenchKnowledgeToolkit.tools.workbench_search_conversations;
  expect(Object.keys(Tool.getJsonSchema(tool).properties ?? {})).toEqual(["query", "includeArchived", "limit"]);
  expect(Context.get(tool.annotations, Tool.Readonly)).toBe(true);
  expect(Context.get(tool.annotations, Tool.Destructive)).toBe(false);
  expect(Context.get(tool.annotations, Tool.Idempotent)).toBe(true);
  expect(Context.get(tool.annotations, Tool.OpenWorld)).toBe(false);
}));

it.effect("fails explicitly for missing or archived invocation and failed search", () => Effect.gen(function* () {
  for (const value of [null, { ...thread, archivedAt: "2026-09-23T00:00:00.000Z" }, thread]) {
    const snapshots = Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: () => Effect.succeed(Option.fromNullishOr(value)),
      searchThreads: () => Effect.fail(new PersistenceSqlError({ operation: "search fixture", cause: "unavailable" })),
    });
    const built = yield* WorkbenchKnowledgeToolkit.pipe(
      Effect.provide(WorkbenchKnowledgeHandlersLive.pipe(Layer.provide(snapshots))),
    );
    const failure = yield* built.handle("workbench_search_conversations", { query: "source" }).pipe(
      Stream.unwrap, Stream.runCollect, Effect.provideService(McpInvocationContext, invocation), Effect.flip,
    );
    expect(failure.message).toBe(value === thread
      ? "Conversation search failed"
      : "Conversation search requires an active invoking thread");
  }
}));
