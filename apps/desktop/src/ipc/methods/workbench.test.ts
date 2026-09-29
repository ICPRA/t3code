import { it, expect } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Transport from "../../../../../../project-workbench/extensions/workbench-desktop/read-node.mjs";
import * as MailConfiguration from "../../../../../../project-workbench/extensions/workbench-mail/config.mjs";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { makeWorkbenchReadMethod } from "./workbench.ts";

it.effect("accepts only the signed-in merge DTOs without a slug override", () => Effect.scoped(Effect.gen(function* () {
  const read = vi.spyOn(Transport, "readWorkbench").mockResolvedValue({ identity: { subject: "human" } });
  const command = vi.spyOn(Transport, "commandWorkbench").mockResolvedValue({ data: { id: "receipt" } });
  const path = yield* Path.Path;
  const layers = Layer.mergeAll(
    Layer.mock(ElectronWindow.ElectronWindow)({ main: Effect.succeed(Option.some({ webContents: { id: 1 } } as never)) }),
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, { homeDirectory: "fixture", path } as DesktopEnvironment.DesktopEnvironment["Service"]),
    FileSystem.layerNoop({ readFileString: () => Effect.succeed('{"executable":"specgraph.exe","config":"config.yaml"}') }),
  );
  const expected = { sources: [{ id: "a-id", slug: "a", version: 1, stage: "done", role: "work" },
    { id: "b-id", slug: "b", version: 2, stage: "review", role: "work" }], contexts: [], relations: [], lineage: [], ancestors: [] };
  const merge = { expected, target: { slug: "c", intent: "Combined", role: "work", priority: "p2", complexity: "medium" },
    relations: [], addedRelations: [], dispositions: [], reason: "Reviewed", idempotencyKey: "original" };
  const inputs = [
    { operation: "preview-node-merge", project: "project", body: { sourceSlugs: ["a", "b"], contextSlugs: [] } },
    { operation: "merge-nodes", project: "project", body: merge },
    { operation: "node-merge-history", project: "project", body: { taskSlug: "a", beforeId: "older" } },
    { operation: "node-merge-receipt", project: "project", body: { id: "receipt" } },
  ] as const;
  try {
    yield* Effect.gen(function* () {
      const methods = yield* makeWorkbenchReadMethod;
      const event = { sender: { id: 1 } };
      for (const input of inputs) expect(yield* methods.command.handler(input, event)).toMatchObject({ error: { code: "unauthorized" } });
      yield* methods.read.handler({ resource: "operator-identity", credential: "human-key" }, event);
      for (const input of inputs) {
        expect(Exit.isFailure(yield* methods.command.handler({ ...input, slug: "forged" }, event).pipe(Effect.exit))).toBe(true);
        expect(Exit.isFailure(yield* methods.command.handler({ ...input, body: { ...input.body, hostCredential: "forged" } }, event).pipe(Effect.exit))).toBe(true);
        expect(yield* methods.command.handler(input, event)).toEqual({ data: { id: "receipt" } });
        expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ ...input, credential: "human-key" }), expect.any(AbortSignal));
      }
      const cancel = { operation: "cancel-preparation" as const, project: "project", slug: "run", body: { packageId: "package", note: "Observed stopped",
        rawHandoff: { environmentId: "local", threadId: "thread", summary: { kind: "progress", eventId: "original-event" } } } };
      expect(Exit.isFailure(yield* methods.command.handler({ ...cancel, body: { ...cancel.body, actor: "forged" } }, event).pipe(Effect.exit))).toBe(true);
      expect(yield* methods.command.handler(cancel, event)).toEqual({ data: { id: "receipt" } });
      expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ ...cancel, credential: "human-key" }), expect.any(AbortSignal));
      expect(Exit.isFailure(yield* methods.command.handler({ ...inputs[1], body: { ...merge, expected: { ...expected, contexts: undefined } } }, event).pipe(Effect.exit))).toBe(true);
      expect(command).toHaveBeenCalledTimes(5);
    }).pipe(Effect.provide(layers));
  } finally { read.mockRestore(); command.mockRestore(); }
})).pipe(Effect.provide(Layer.merge(Path.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env: { VACPMS_HOME: "C:/fixture" } }))))));

it.effect("forwards human node ownership and program stop through the saved operator identity", () => Effect.scoped(Effect.gen(function* () {
  const read = vi.spyOn(Transport, "readWorkbench").mockResolvedValue({ identity: { subject: "human" } });
  const command = vi.spyOn(Transport, "commandWorkbench").mockResolvedValue({ data: { id: "receipt" } });
  const path = yield* Path.Path;
  const layers = Layer.mergeAll(
    Layer.mock(ElectronWindow.ElectronWindow)({ main: Effect.succeed(Option.some({ webContents: { id: 1 } } as never)) }),
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, { homeDirectory: "fixture", path } as DesktopEnvironment.DesktopEnvironment["Service"]),
    FileSystem.layerNoop({ readFileString: () => Effect.succeed('{"executable":"specgraph.exe","config":"config.yaml"}') }),
  );
  try {
    yield* Effect.gen(function* () {
      const methods = yield* makeWorkbenchReadMethod;
      const event = { sender: { id: 1 } };
      const inputs = [
        { operation: "node-owner-read", project: "project", body: { taskSlug: "task" } },
        { operation: "node-owner-history", project: "project", body: { taskSlug: "task", cursor: "5" } },
        { operation: "node-owner-take-begin", project: "project", body: { taskSlug: "task", expectedVersion: 1, expectedOwnerUserId: null, idempotencyKey: "intent", reason: "Take" } },
        { operation: "node-owner-take-commit", project: "project", body: { operationId: "operation", expectedVersion: 1, handoffs: [], preparedHandoffs: [], claimHandoff: null } },
        { operation: "node-owner-take-cancel", project: "project", body: { operationId: "operation", reason: "Cancel" } },
        { operation: "node-owner-return", project: "project", body: { taskSlug: "task", expectedVersion: 2, expectedOwnerUserId: "human", idempotencyKey: "intent", reason: "Return" } },
        { operation: "confirm-program-run-stopped", project: "project", body: { runId: "program", admissionId: "admission", attemptId: "attempt", environmentId: "environment", nativeProjectId: "native", note: "Observed stopped" } },
      ] as const;
      for (const input of inputs) expect(yield* methods.command.handler(input, event)).toMatchObject({ error: { code: "unauthorized" } });
      expect(command).not.toHaveBeenCalled();
      yield* methods.read.handler({ resource: "operator-identity", credential: "human-key" }, event);
      for (const input of inputs) {
        expect(Exit.isFailure(yield* methods.command.handler({ ...input, slug: "override" }, event).pipe(Effect.exit))).toBe(true);
        expect(Exit.isFailure(yield* methods.command.handler({ ...input, body: { ...input.body, hostCredential: "forged" } }, event).pipe(Effect.exit))).toBe(true);
        expect(yield* methods.command.handler(input, event)).toEqual({ data: { id: "receipt" } });
        expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ ...input, credential: "human-key" }), expect.any(AbortSignal));
      }
      expect(Exit.isFailure(yield* methods.command.handler({ ...inputs[2], body: { ...inputs[2].body, expectedOwnerUserId: undefined } }, event).pipe(Effect.exit))).toBe(true);
      expect(Exit.isFailure(yield* methods.command.handler({ ...inputs[6], body: { ...inputs[6].body, attemptId: undefined } }, event).pipe(Effect.exit))).toBe(true);
      expect(command).toHaveBeenCalledTimes(7);
      yield* methods.read.handler({ resource: "operator-signout" }, event);
      expect(yield* methods.command.handler(inputs[0], event)).toMatchObject({ error: { code: "unauthorized" } });
    }).pipe(Effect.provide(layers));
  } finally { read.mockRestore(); command.mockRestore(); }
})).pipe(Effect.provide(Layer.merge(Path.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env: { VACPMS_HOME: "C:/fixture" } }))))));

it.effect("requires explicit human completion-hook confirmation and injects only the matching local service identity", () => Effect.scoped(Effect.gen(function* () {
  const hook = { id: "hook", sourceRole: "summary", targetRunId: "program", targetPackageId: "original-package", state: "armed" };
  const read = vi.spyOn(Transport, "readWorkbench").mockResolvedValue({ hook });
  const command = vi.spyOn(Transport, "commandWorkbench").mockResolvedValue({ data: hook });
  const mailConfig = vi.spyOn(MailConfiguration, "loadMailConfig");
  const path = yield* Path.Path;
  const layers = Layer.mergeAll(
    Layer.mock(ElectronWindow.ElectronWindow)({ main: Effect.succeed(Option.some({ webContents: { id: 1 } } as never)) }),
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, { homeDirectory: "fixture", path } as DesktopEnvironment.DesktopEnvironment["Service"]),
    FileSystem.layerNoop({ readFileString: () => Effect.succeed('{"executable":"specgraph.exe","config":"config.yaml"}') }),
  );
  try {
    yield* Effect.gen(function* () {
      const methods = yield* makeWorkbenchReadMethod;
      const event = { sender: { id: 1 } };
      const arm = { operation: "arm-completion-hook", project: "project", body: { sourceTaskSlug: "source", sourceSpecId: "original-spec",
        targetRunId: "program", targetPackageId: "original-package", idempotencyKey: "human-intent", confirmTrigger: true } };
      const cancel = { operation: "cancel-completion-hook", project: "project", body: { hookId: "hook", reason: "Human changed plan" } };
      const retry = { operation: "retry-completion-hook", project: "project", body: { hookId: "hook" } };
      const readHook = { resource: "completion-hook", project: "project", slug: "hook" };
      expect(Exit.isFailure(yield* methods.read.handler(readHook, event).pipe(Effect.exit))).toBe(true);
      for (const input of [arm, cancel, retry]) expect(yield* methods.command.handler(input, event)).toMatchObject({ error: { code: "unauthorized" } });
      expect(read).not.toHaveBeenCalled();
      expect(command).not.toHaveBeenCalled();
      expect(mailConfig).not.toHaveBeenCalled();
      yield* methods.read.handler({ resource: "operator-identity", credential: "human-key" }, event);
      const runtime = read.mock.calls.at(-1)![0];
      mailConfig.mockReturnValue({ executable: runtime.executable, config: runtime.config, token: "service-key", projects: {} });
      expect(yield* methods.read.handler(readHook, event)).toEqual({ hook });
      expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ ...readHook, credential: "human-key" }), expect.any(AbortSignal));
      expect(Exit.isFailure(yield* methods.read.handler({ ...readHook, credential: "forged" }, event).pipe(Effect.exit))).toBe(true);
      expect(Exit.isFailure(yield* methods.read.handler(readHook, { sender: { id: 2 } }).pipe(Effect.exit))).toBe(true);
      for (const input of [arm, cancel, retry]) {
        expect(Exit.isFailure(yield* methods.command.handler(input, { sender: { id: 2 } }).pipe(Effect.exit))).toBe(true);
        expect(Exit.isFailure(yield* methods.command.handler({ ...input, slug: "override" }, event).pipe(Effect.exit))).toBe(true);
        for (const field of ["actor", "hostCredential", "command", "environmentId", "sourceRole", "programAdmissionId"]) {
          expect(Exit.isFailure(yield* methods.command.handler({ ...input, body: { ...input.body, [field]: "forged" } }, event).pipe(Effect.exit))).toBe(true);
        }
      }
      for (const confirmTrigger of [false, undefined]) {
        expect(Exit.isFailure(yield* methods.command.handler({ ...arm, body: { ...arm.body, confirmTrigger } }, event).pipe(Effect.exit))).toBe(true);
      }
      for (const fact of [{ kind: "delivery", id: "wrong-kind" }, { kind: "execution", id: "" }, { kind: "summary", id: "real-id", actor: "forged" }]) {
        expect(Exit.isFailure(yield* methods.command.handler({ ...arm, body: { ...arm.body, fact } }, event).pipe(Effect.exit))).toBe(true);
      }
      expect(command).not.toHaveBeenCalled();
      expect(mailConfig).not.toHaveBeenCalled();
      for (const input of [cancel, retry]) {
        expect(yield* methods.command.handler(input, event)).toEqual({ data: hook });
        expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ ...input, credential: "human-key" }), expect.any(AbortSignal));
      }
      expect(mailConfig).not.toHaveBeenCalled();
      for (const fact of [undefined, { kind: "execution", id: "original-execution" }, { kind: "manual", id: "original-manual" }, { kind: "summary", id: "original-acceptance" }]) {
        const input = { ...arm, body: { ...arm.body, ...(fact === undefined ? {} : { fact }) } };
        expect(yield* methods.command.handler(input, event)).toEqual({ data: hook });
        expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ ...input, credential: "human-key",
          body: { ...input.body, hostCredential: "service-key" }, executable: runtime.executable, config: runtime.config }), expect.any(AbortSignal));
      }
      expect(command).toHaveBeenCalledTimes(6);
      expect(mailConfig).toHaveBeenCalledTimes(4);
      for (const service of [undefined,
        { executable: "C:/foreign/specgraph.exe", config: runtime.config, token: "service-key", projects: {} },
        { executable: runtime.executable, config: "C:/foreign/config.yaml", token: "service-key", projects: {} }]) {
        mailConfig.mockReturnValueOnce(service);
        expect(Exit.isFailure(yield* methods.command.handler(arm, event).pipe(Effect.exit))).toBe(true);
      }
      expect(command).toHaveBeenCalledTimes(6);
      const denied = { error: { code: "forbidden", message: "A human manager must authorize this fixed program preparation" } };
      command.mockResolvedValueOnce(denied);
      expect(yield* methods.command.handler(arm, event)).toEqual(denied);
      yield* methods.read.handler({ resource: "operator-signout" }, event);
      expect(Exit.isFailure(yield* methods.read.handler(readHook, event).pipe(Effect.exit))).toBe(true);
      for (const input of [arm, cancel, retry]) expect(yield* methods.command.handler(input, event)).toMatchObject({ error: { code: "unauthorized" } });
      expect(command).toHaveBeenCalledTimes(7);
    }).pipe(Effect.provide(layers));
  } finally {
    read.mockRestore(); command.mockRestore(); mailConfig.mockRestore();
  }
})).pipe(Effect.provide(Layer.merge(Path.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env: { VACPMS_HOME: "C:/fixture", T3_WORKBENCH_MAIL_CONFIG: "C:/fixture/workbench-mail.json" } }))))));

it.effect("uses the saved operator for summary reads and the original human command channel", () => Effect.scoped(Effect.gen(function* () {
  const read = vi.spyOn(Transport, "readWorkbench").mockResolvedValue({ summary: { goalSlug: "goal", accepted: false } });
  const command = vi.spyOn(Transport, "commandWorkbench").mockResolvedValue({ data: { id: "original-record" } });
  const mailConfig = vi.spyOn(MailConfiguration, "loadMailConfig");
  const path = yield* Path.Path;
  const layers = Layer.mergeAll(
    Layer.mock(ElectronWindow.ElectronWindow)({ main: Effect.succeed(Option.some({ webContents: { id: 1 } } as never)) }),
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, { homeDirectory: "fixture", path } as DesktopEnvironment.DesktopEnvironment["Service"]),
    FileSystem.layerNoop({ readFileString: () => Effect.succeed('{"executable":"specgraph.exe","config":"config.yaml"}') }),
  );
  try {
    yield* Effect.gen(function* () {
      const methods = yield* makeWorkbenchReadMethod;
      const event = { sender: { id: 1 } };
      for (const resource of ["summary", "summary-history"] as const) {
        expect(Exit.isFailure(yield* methods.read.handler({ resource, project: "project", slug: "goal" }, event).pipe(Effect.exit))).toBe(true);
      }
      const operations = [
        { operation: "record-summary-disposition", project: "project", body: { goalSlug: "goal", affectedSlug: "work", disposition: "needs_review",
          reviewDecisionId: "", beforeSources: [], afterSources: [], reason: "Changed source", idempotencyKey: "disposition" } },
        { operation: "accept-summary", project: "project", body: { goalSlug: "goal", basis: "Actual evidence", evidenceSources: [], goalsSatisfied: true,
          idempotencyKey: "accept", expectedReferences: { nodes: [], relations: [], dispositionIds: [], decisionSources: [] }, impactReview: [] } },
        { operation: "revoke-summary-acceptance", project: "project", body: { acceptanceId: "original-acceptance", reason: "Changed source" } },
      ];
      for (const input of operations) expect(yield* methods.command.handler(input, event)).toMatchObject({ error: { code: "unauthorized" } });
      expect(read).not.toHaveBeenCalled();
      expect(command).not.toHaveBeenCalled();
      yield* methods.read.handler({ resource: "operator-identity", credential: "saved-human-key" }, event);
      for (const resource of ["summary", "summary-history"] as const) {
        const input = { resource, project: "project", slug: "goal", ...(resource === "summary-history" ? { query: "acceptances", cursor: "before-id" } : {}) };
        yield* methods.read.handler(input, event);
        expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ ...input, credential: "saved-human-key" }), expect.any(AbortSignal));
        expect(Exit.isFailure(yield* methods.read.handler({ ...input, credential: "forged" }, event).pipe(Effect.exit))).toBe(true);
        expect(Exit.isFailure(yield* methods.read.handler(input, { sender: { id: 2 } }).pipe(Effect.exit))).toBe(true);
      }
      for (const input of operations) {
        yield* methods.command.handler(input, event);
        expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ ...input, credential: "saved-human-key" }), expect.any(AbortSignal));
        expect(Exit.isFailure(yield* methods.command.handler(input, { sender: { id: 2 } }).pipe(Effect.exit))).toBe(true);
      }
      expect(command).toHaveBeenCalledTimes(3);
      expect(mailConfig).not.toHaveBeenCalled();
      command.mockResolvedValueOnce({ error: { code: "conflict", message: "Original references changed" } });
      expect(yield* methods.command.handler(operations[1], event)).toEqual({ error: { code: "conflict", message: "Original references changed" } });
      yield* methods.read.handler({ resource: "operator-signout" }, event);
      expect(Exit.isFailure(yield* methods.read.handler({ resource: "summary", project: "project", slug: "goal" }, event).pipe(Effect.exit))).toBe(true);
      expect(yield* methods.command.handler(operations[1], event)).toMatchObject({ error: { code: "unauthorized" } });
      expect(command).toHaveBeenCalledTimes(4);
    }).pipe(Effect.provide(layers));
  } finally {
    read.mockRestore(); command.mockRestore(); mailConfig.mockRestore();
  }
})).pipe(Effect.provide(Layer.merge(Path.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env: { VACPMS_HOME: "C:/fixture" } }))))));

it.effect("prepares programs with saved human identity and runtime-matched host service only", () => Effect.scoped(Effect.gen(function* () {
  const read = vi.spyOn(Transport, "readWorkbench").mockResolvedValue({});
  const command = vi.spyOn(Transport, "commandWorkbench").mockResolvedValue({ data: { executorKind: "program", state: "prepared" } });
  const mailConfig = vi.spyOn(MailConfiguration, "loadMailConfig");
  const path = yield* Path.Path;
  const layers = Layer.mergeAll(
    Layer.mock(ElectronWindow.ElectronWindow)({ main: Effect.succeed(Option.some({ webContents: { id: 1 } } as never)) }),
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, { homeDirectory: "fixture", path } as DesktopEnvironment.DesktopEnvironment["Service"]),
    FileSystem.layerNoop({ readFileString: () => Effect.succeed('{"executable":"specgraph.exe","config":"config.yaml"}') }),
  );
  try {
    yield* Effect.gen(function* () {
      const methods = yield* makeWorkbenchReadMethod;
      const event = { sender: { id: 1 } };
      const prepare = { operation: "prepare-program-run", project: "project", body: { taskSlug: "task", idempotencyKey: "human-intent",
        command: { executable: "authorized.exe", args: ["original argument"], cwd: "C:/external-project", environmentId: "env",
          nativeProjectId: "native-project", timeoutMs: 5000, workPurpose: "investigation", completeOnSuccess: true } } };
      expect(yield* methods.command.handler(prepare, event)).toMatchObject({ error: { code: "unauthorized" } });
      expect(command).not.toHaveBeenCalled();
      expect(mailConfig).not.toHaveBeenCalled();
      yield* methods.read.handler({ resource: "operator-identity", credential: "human-key" }, event);
      const runtime = read.mock.calls.at(-1)![0];
      mailConfig.mockReturnValue({ executable: runtime.executable, config: runtime.config, token: "host-service-key", projects: {} });
      for (const field of ["hostCredential", "actor", "hostConsumerUserId", "scope"]) {
        expect(Exit.isFailure(yield* methods.command.handler({ ...prepare, body: { ...prepare.body, [field]: "forged" } }, event).pipe(Effect.exit))).toBe(true);
        expect(Exit.isFailure(yield* methods.command.handler({ ...prepare, body: { ...prepare.body, command: { ...prepare.body.command, [field]: "forged" } } }, event).pipe(Effect.exit))).toBe(true);
      }
      expect(Exit.isFailure(yield* methods.command.handler({ ...prepare, slug: "override" }, event).pipe(Effect.exit))).toBe(true);
      expect(Exit.isFailure(yield* methods.command.handler({ operation: prepare.operation, body: prepare.body }, event).pipe(Effect.exit))).toBe(true);
      expect(Exit.isFailure(yield* methods.command.handler(prepare, { sender: { id: 2 } }).pipe(Effect.exit))).toBe(true);
      expect(command).not.toHaveBeenCalled();
      expect(mailConfig).not.toHaveBeenCalled();
      const result = yield* methods.command.handler(prepare, event);
      expect(result).toEqual({ data: { executorKind: "program", state: "prepared" } });
      expect(command).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ...prepare, credential: "human-key",
        body: { ...prepare.body, hostCredential: "host-service-key" }, executable: runtime.executable, config: runtime.config }), expect.any(AbortSignal));
      const loop = { kind: "innovative", termination: { kind: "judgment", judgment: { criterion: "Original output satisfies the task" } },
        maxAttempts: 3, synchronousCompletionBasis: "Each process exit follows its final durable output write" };
      const loopPrepare = { ...prepare, body: { ...prepare.body, command: { ...prepare.body.command, loop } } };
      expect(yield* methods.command.handler(loopPrepare, event)).toEqual(result);
      expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ ...loopPrepare, credential: "human-key",
        body: { ...loopPrepare.body, hostCredential: "host-service-key" } }), expect.any(AbortSignal));
      for (const forgedLoop of [{ ...loop, actorUserId: "forged" }, { ...loop, termination: { ...loop.termination, command: "forged" } }]) {
        expect(Exit.isFailure(yield* methods.command.handler({ ...loopPrepare,
          body: { ...loopPrepare.body, command: { ...loopPrepare.body.command, loop: forgedLoop } } }, event).pipe(Effect.exit))).toBe(true);
      }
      mailConfig.mockReturnValueOnce(undefined);
      expect(Exit.isFailure(yield* methods.command.handler(prepare, event).pipe(Effect.exit))).toBe(true);
      mailConfig.mockReturnValueOnce({ executable: runtime.executable, config: "C:/different/config.yaml", token: "host-service-key", projects: {} });
      expect(Exit.isFailure(yield* methods.command.handler(prepare, event).pipe(Effect.exit))).toBe(true);
      mailConfig.mockReturnValueOnce({ executable: "C:/different/specgraph.exe", config: runtime.config, token: "host-service-key", projects: {} });
      expect(Exit.isFailure(yield* methods.command.handler(prepare, event).pipe(Effect.exit))).toBe(true);
      expect(command).toHaveBeenCalledTimes(2);
      const failure = { error: { code: "permission_denied", message: "Program preparation requires a human manager" } };
      command.mockResolvedValueOnce(failure);
      expect(yield* methods.command.handler(prepare, event)).toEqual(failure);
      expect(command).toHaveBeenCalledTimes(3);
      yield* methods.read.handler({ resource: "operator-signout" }, event);
      expect(yield* methods.command.handler(prepare, event)).toMatchObject({ error: { code: "unauthorized" } });
      expect(command).toHaveBeenCalledTimes(3);
    }).pipe(Effect.provide(layers));
  } finally {
    read.mockRestore();
    command.mockRestore();
    mailConfig.mockRestore();
  }
})).pipe(Effect.provide(Layer.merge(Path.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env: { VACPMS_HOME: "C:/fixture", T3_WORKBENCH_MAIL_CONFIG: "C:/fixture/workbench-mail.json" } }))))));

it.effect("forwards human program and candidate loop controls with saved operator identity", () => Effect.scoped(Effect.gen(function* () {
  const read = vi.spyOn(Transport, "readWorkbench").mockResolvedValue({});
  const command = vi.spyOn(Transport, "commandWorkbench").mockResolvedValue({ data: { id: "original-event" } });
  const mailConfig = vi.spyOn(MailConfiguration, "loadMailConfig");
  const path = yield* Path.Path;
  const layers = Layer.mergeAll(
    Layer.mock(ElectronWindow.ElectronWindow)({ main: Effect.succeed(Option.some({ webContents: { id: 1 } } as never)) }),
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, { homeDirectory: "fixture", path } as DesktopEnvironment.DesktopEnvironment["Service"]),
    FileSystem.layerNoop({ readFileString: () => Effect.succeed('{"executable":"specgraph.exe","config":"config.yaml"}') }),
  );
  try {
    yield* Effect.gen(function* () {
      const methods = yield* makeWorkbenchReadMethod;
      const event = { sender: { id: 1 } };
      const inputs = [
        { operation: "record-program-loop-decision", project: "project", body: { runId: "program", attemptId: "exact-attempt", expectedJudgmentId: null, value: "unknown", basis: "Original outputs insufficient" } },
        { operation: "stop-program-loop", project: "project", body: { runId: "program", reason: "Stop future attempts only" } },
        { operation: "candidate-loop-read", project: "project", body: { runId: "candidate" } },
        { operation: "candidate-loop-stop", project: "project", body: { runId: "candidate", reason: "Stop future candidates only" } },
        { operation: "candidate-loop-abandon", project: "project", body: { runId: "candidate", reason: "End this budget" } },
        { operation: "candidate-satisfaction-record", project: "project", body: { runId: "candidate", attemptId: "attempt", expectedJudgmentId: null, value: "false", reason: "Unsatisfactory candidate" } },
        { operation: "candidate-intervention-resolve", project: "project", body: { runId: "candidate", attemptId: "attempt", interventionId: "hold", expectedJudgmentId: "judgment", expectedReportIds: ["report"], reason: "Aligned facts reviewed" } },
        { operation: "candidate-satisfaction-history", project: "project", body: { runId: "candidate", attemptId: "attempt", judgmentCursor: "12" } },
      ];
      const arm = { operation: "candidate-loop-arm", project: "project", body: { runId: "candidate", maxAttempts: 3,
        planSources: [{ kind: "specgraph", specSlug: "task", field: "test_plan", changeId: "change" }], terminationKind: "satisfaction", satisfactionCriterion: "Fixed satisfactory outcome" } };
      for (const input of inputs) expect(yield* methods.command.handler(input, event)).toMatchObject({ error: { code: "unauthorized" } });
      expect(yield* methods.command.handler(arm, event)).toMatchObject({ error: { code: "unauthorized" } });
      expect(Exit.isFailure(yield* methods.read.handler({ resource: "program-loop", project: "project", slug: "program" }, event).pipe(Effect.exit))).toBe(true);
      expect(command).not.toHaveBeenCalled();
      yield* methods.read.handler({ resource: "operator-identity", credential: "human-key" }, event);
      for (const input of [{ resource: "program-loop", project: "project", slug: "program" },
        { resource: "program-loop-history", project: "project", slug: "program", attemptCursor: "50", eventCursor: "exact-event" }]) {
        expect(yield* methods.read.handler(input, event)).toEqual({});
        expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ ...input, credential: "human-key" }), expect.any(AbortSignal));
        expect(Exit.isFailure(yield* methods.read.handler({ ...input, credential: "forged" }, event).pipe(Effect.exit))).toBe(true);
        expect(Exit.isFailure(yield* methods.read.handler({ ...input, cursor: "old-cursor" }, event).pipe(Effect.exit))).toBe(true);
        expect(Exit.isFailure(yield* methods.read.handler({ ...input, project: undefined }, event).pipe(Effect.exit))).toBe(true);
        expect(Exit.isFailure(yield* methods.read.handler(input, { sender: { id: 2 } }).pipe(Effect.exit))).toBe(true);
      }
      expect(Exit.isFailure(yield* methods.read.handler({ resource: "program-loop", project: "project", slug: "program", attemptCursor: "50" }, event).pipe(Effect.exit))).toBe(true);
      expect(Exit.isFailure(yield* methods.read.handler({ resource: "spec", project: "project", slug: "task", eventCursor: "invalid" }, event).pipe(Effect.exit))).toBe(true);
      for (const input of inputs) {
        expect(Exit.isFailure(yield* methods.command.handler(input, { sender: { id: 2 } }).pipe(Effect.exit))).toBe(true);
        expect(Exit.isFailure(yield* methods.command.handler({ ...input, slug: "override" }, event).pipe(Effect.exit))).toBe(true);
        for (const field of ["actorUserId", "actorRunId", "hostCredential", "scope", "project", "command", "maxAttempts", "environmentId"]) {
          expect(Exit.isFailure(yield* methods.command.handler({ ...input, body: { ...input.body, [field]: "forged" } }, event).pipe(Effect.exit))).toBe(true);
        }
        expect(yield* methods.command.handler(input, event)).toEqual({ data: { id: "original-event" } });
        expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ ...input, credential: "human-key" }), expect.any(AbortSignal));
      }
      expect(Exit.isFailure(yield* methods.command.handler({ ...arm, body: { ...arm.body, satisfactionCriterion: undefined } }, event).pipe(Effect.exit))).toBe(true);
      expect(Exit.isFailure(yield* methods.command.handler({ ...arm, slug: "override" }, event).pipe(Effect.exit))).toBe(true);
      expect(Exit.isFailure(yield* methods.command.handler({ ...arm, body: { ...arm.body, hostCredential: "forged" } }, event).pipe(Effect.exit))).toBe(true);
      expect(yield* methods.command.handler(arm, event)).toEqual({ data: { id: "original-event" } });
      expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ ...arm, credential: "human-key" }), expect.any(AbortSignal));
      expect(Exit.isFailure(yield* methods.command.handler({ operation: "record-program-loop-decision", project: "project", body: { runId: "program", attemptId: "exact-attempt", value: "true", basis: "Missing CAS baseline" } }, event).pipe(Effect.exit))).toBe(true);
      expect(Exit.isFailure(yield* methods.command.handler({ operation: "candidate-satisfaction-record", project: "project", body: { runId: "candidate", attemptId: "attempt", value: "true", reason: "Missing CAS baseline" } }, event).pipe(Effect.exit))).toBe(true);
      expect(command).toHaveBeenCalledTimes(9);
      expect(mailConfig).not.toHaveBeenCalled();
      const conflict = { error: { code: "conflict", message: "Attempt judgment consumed" } };
      command.mockResolvedValueOnce(conflict);
      expect(yield* methods.command.handler(inputs[0], event)).toEqual(conflict);
      expect(command).toHaveBeenCalledTimes(10);
      yield* methods.read.handler({ resource: "operator-signout" }, event);
      expect(yield* methods.command.handler(inputs[1], event)).toMatchObject({ error: { code: "unauthorized" } });
      expect(command).toHaveBeenCalledTimes(10);
    }).pipe(Effect.provide(layers));
  } finally { read.mockRestore(); command.mockRestore(); mailConfig.mockRestore(); }
})).pipe(Effect.provide(Layer.merge(Path.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env: { VACPMS_HOME: "C:/fixture" } }))))));

it.effect("keeps protected reads and mail takeover behind the saved operator identity and main window", () => Effect.scoped(Effect.gen(function* () {
  const read = vi.spyOn(Transport, "readWorkbench").mockResolvedValue({});
  const command = vi.spyOn(Transport, "commandWorkbench").mockResolvedValue({ data: { thread: {}, event: {} } });
  const mailConfig = vi.spyOn(MailConfiguration, "loadMailConfig");
  const path = yield* Path.Path;
  const layers = Layer.mergeAll(
    Layer.mock(ElectronWindow.ElectronWindow)({ main: Effect.succeed(Option.some({ webContents: { id: 1 } } as never)) }),
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, { homeDirectory: "fixture", path } as DesktopEnvironment.DesktopEnvironment["Service"]),
    FileSystem.layerNoop({ readFileString: () => Effect.succeed('{"executable":"specgraph.exe","config":"config.yaml"}') }),
  );
  try {
    yield* Effect.gen(function* () {
      const methods = yield* makeWorkbenchReadMethod;
      const event = { sender: { id: 1 } };
      const takeover = { operation: "takeover-mail" as const, project: "project", body: { mail_thread_id: "thread", recipient_run_id: "recipient", body: "Continue this work", idempotency_key: "takeover-key" } };
      const arm = { operation: "arm-delivery-hook" as const, project: "project", body: { sourceRunId: "implementation", targetRunId: "prepared-test", commitSha: "a".repeat(40), idempotencyKey: "human-intent", deliveryId: "delivery" } };
      const hooks = [arm, { operation: "cancel-delivery-hook" as const, project: "project", body: { hookId: "hook", reason: "Plan changed" } },
        { operation: "retry-delivery-hook" as const, project: "project", body: { hookId: "hook" } }];
      for (const resource of ["test-reports", "node-events", "mail-directory", "mail-owner-history"] as const) {
        const beforeLogin = yield* methods.read.handler({ resource, project: "project", slug: "target" }, event).pipe(Effect.exit);
        expect(Exit.isFailure(beforeLogin)).toBe(true);
        if (Exit.isFailure(beforeLogin)) expect(Cause.pretty(beforeLogin.cause)).toContain("unauthorized");
      }
      expect(read).not.toHaveBeenCalled();
      expect(yield* methods.command.handler(takeover, event)).toEqual({ error: { code: "unauthorized", message: "Sign in before submitting an operation" } });
      for (const hook of hooks) expect(yield* methods.command.handler(hook, event)).toMatchObject({ error: { code: "unauthorized" } });
      expect(command).not.toHaveBeenCalled();
      expect(mailConfig).not.toHaveBeenCalled();
      yield* methods.read.handler({ resource: "operator-identity", credential: "fixture-key" }, event);
      yield* methods.read.handler({ resource: "mail-threads", project: "project", taskSlug: "parent", includeDescendants: true }, event);
      expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ resource: "mail-threads", project: "project", taskSlug: "parent", includeDescendants: true, credential: "fixture-key" }), expect.any(AbortSignal));
      yield* methods.read.handler({ resource: "test-reports", project: "project", slug: "target" }, event);
      expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ resource: "test-reports", credential: "fixture-key" }), expect.any(AbortSignal));
      yield* methods.read.handler({ resource: "node-events", project: "project", slug: "target" }, event);
      expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ resource: "node-events", credential: "fixture-key" }), expect.any(AbortSignal));
      for (const resource of ["mail-directory", "mail-owner-history"] as const) {
        const input = { resource, project: "project", threadId: "thread", limit: 50, cursor: "cursor" };
        yield* methods.read.handler(input, event);
        expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ ...input, credential: "fixture-key" }), expect.any(AbortSignal));
        const calls = read.mock.calls.length;
        const override = yield* methods.read.handler({ ...input, credential: "renderer-key" }, event).pipe(Effect.exit);
        expect(Exit.isFailure(override)).toBe(true);
        if (Exit.isFailure(override)) expect(Cause.pretty(override.cause)).toContain("use the signed-in operator identity");
        const wrongWindow = yield* methods.read.handler(input, { sender: { id: 2 } }).pipe(Effect.exit);
        expect(Exit.isFailure(wrongWindow)).toBe(true);
        if (Exit.isFailure(wrongWindow)) expect(Cause.pretty(wrongWindow.cause)).toContain("Workbench request rejected");
        expect(read).toHaveBeenCalledTimes(calls);
      }
      yield* methods.command.handler(takeover, event);
      expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ ...takeover, credential: "fixture-key" }), expect.any(AbortSignal));
      const wrongWindow = yield* methods.command.handler(takeover, { sender: { id: 2 } }).pipe(Effect.exit);
      expect(Exit.isFailure(wrongWindow)).toBe(true);
      if (Exit.isFailure(wrongWindow)) expect(Cause.pretty(wrongWindow.cause)).toContain("Workbench request rejected");
      expect(command).toHaveBeenCalledTimes(1);
      const runtime = read.mock.calls.at(-1)![0];
      mailConfig.mockReturnValue({ executable: runtime.executable, config: runtime.config, token: "fixture-service-key", projects: {} });
      for (const field of ["hostCredential", "actor", "hostConsumerUserId", "configuredByUserId", "scope"]) {
        const rejected = yield* methods.command.handler({ ...arm, body: { ...arm.body, [field]: "forged" } }, event).pipe(Effect.exit);
        expect(Exit.isFailure(rejected)).toBe(true);
        if (Exit.isFailure(rejected)) expect(Cause.pretty(rejected.cause)).toContain("invalid delivery hook command fields");
      }
      for (const hook of hooks) {
        const rejected = yield* methods.command.handler(hook, { sender: { id: 2 } }).pipe(Effect.exit);
        expect(Exit.isFailure(rejected)).toBe(true);
      }
      expect(command).toHaveBeenCalledTimes(1);
      expect(mailConfig).not.toHaveBeenCalled();
      for (const hook of hooks) {
        yield* methods.command.handler(hook, event);
        expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ ...hook, credential: "fixture-key",
          body: hook.operation === "arm-delivery-hook" ? { ...hook.body, hostCredential: "fixture-service-key" } : hook.body }), expect.any(AbortSignal));
      }
      expect(mailConfig).toHaveBeenCalledExactlyOnceWith("C:/fixture/workbench-mail.json");
      mailConfig.mockReturnValueOnce(undefined);
      expect(Exit.isFailure(yield* methods.command.handler(arm, event).pipe(Effect.exit))).toBe(true);
      mailConfig.mockReturnValueOnce({ executable: "C:/different/specgraph.exe", config: runtime.config, token: "fixture-service-key", projects: {} });
      expect(Exit.isFailure(yield* methods.command.handler(arm, event).pipe(Effect.exit))).toBe(true);
      expect(command).toHaveBeenCalledTimes(4);
      yield* methods.read.handler({ resource: "operator-signout" }, event);
      for (const resource of ["test-reports", "mail-directory", "mail-owner-history"] as const) {
        const denied = yield* methods.read.handler({ resource, project: "project", slug: "target" }, event).pipe(Effect.exit);
        expect(Exit.isFailure(denied)).toBe(true);
        if (Exit.isFailure(denied)) expect(Cause.pretty(denied.cause)).toContain("unauthorized");
      }
      expect(yield* methods.command.handler(takeover, event)).toEqual({ error: { code: "unauthorized", message: "Sign in before submitting an operation" } });
      for (const hook of hooks) expect(yield* methods.command.handler(hook, event)).toMatchObject({ error: { code: "unauthorized" } });
      expect(command).toHaveBeenCalledTimes(4);
    }).pipe(Effect.provide(layers));
  } finally {
    read.mockRestore();
    command.mockRestore();
    mailConfig.mockRestore();
  }
})).pipe(Effect.provide(Layer.merge(Path.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env: { VACPMS_HOME: "C:/fixture", T3_WORKBENCH_MAIL_CONFIG: "C:/fixture/workbench-mail.json" } }))))));
