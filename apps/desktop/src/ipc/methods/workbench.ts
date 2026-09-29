import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as Config from "effect/Config";
import {
  commandWorkbench,
  readWorkbench,
} from "../../../../../../project-workbench/extensions/workbench-desktop/read-node.mjs";
import { setupMail } from "../../../../../../project-workbench/extensions/workbench-desktop/setup-mail.mjs";
import { loadMailConfig } from "../../../../../../project-workbench/extensions/workbench-mail/config.mjs";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import {
  WorkbenchBeginNodeOwnershipTake,
  WorkbenchCancelNodeOwnershipTake,
  WorkbenchCandidateLoopPolicy,
  WorkbenchCommitNodeOwnershipTake,
  WorkbenchConfirmProgramRunStopped,
  WorkbenchProgramLoopPolicy,
  WorkbenchReturnNodeOwnership,
  WorkbenchMergeRequest,
  WorkbenchCancelPreparation,
} from "@t3tools/contracts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { makeIpcMethod, type DesktopIpcInvokeEvent } from "../DesktopIpc.ts";

class WorkbenchReadError extends Schema.TaggedError<WorkbenchReadError>()("WorkbenchReadError", {
  message: Schema.String,
}) {}

const ensureMainWindow = Effect.fn("desktop.ipc.workbench.sender")(function* (
  event: DesktopIpcInvokeEvent | undefined,
) {
  const main = yield* (yield* ElectronWindow.ElectronWindow).main;
  if (!event || Option.isNone(main) || main.value.webContents.id !== event.sender.id) {
    return yield* new WorkbenchReadError({ message: "Workbench request rejected" });
  }
});

const readRuntime = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const configuredHome = yield* Config.String("VACPMS_HOME").pipe(Config.option);
  const home = Option.getOrElse(configuredHome, () =>
    environment.path.join(environment.homeDirectory, "project-workbench"),
  );
  const raw = yield* fileSystem.readFileString(environment.path.join(home, "desktop-runtime.json"));
  const settings = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({ executable: Schema.NonEmptyString, config: Schema.NonEmptyString }),
    ),
  )(raw);
  return {
    executable: environment.path.resolve(home, settings.executable),
    config: environment.path.resolve(home, settings.config),
  };
});

export const makeWorkbenchReadMethod = Effect.gen(function* () {
  let mailboxSetup: ReturnType<typeof setupMail> | undefined;
  const operatorCredential = yield* Ref.make<string | undefined>(undefined);
  yield* Effect.addFinalizer(() => Ref.set(operatorCredential, undefined));
  const read = makeIpcMethod({
    channel: "vacpms:read-node",
    payload: Schema.Struct({
      resource: Schema.Literals([
        "program-loop",
        "program-loop-history",
        "completion-hook",
        "summary-history",
        "summary",
        "projects",
        "current-view",
        "spec",
        "mail-identity",
        "mail-threads",
        "mail-thread",
        "mail-directory",
        "mail-owner-history",
        "mail-signout",
        "operator-identity",
        "operator-signout",
        "dependencies",
        "run-context",
        "run-dispatch",
        "delivery",
        "knowledge-search",
        "knowledge-spec",
        "knowledge-decision",
        "knowledge-change",
        "node-mark-history",
        "node-events",
        "change-preview",
        "test-reports",
        "review-status",
      ]),
      project: Schema.optional(Schema.NonEmptyString),
      slug: Schema.optional(Schema.NonEmptyString),
      credential: Schema.optional(Schema.NonEmptyString),
      taskSlug: Schema.optional(Schema.NonEmptyString),
      includeDescendants: Schema.optional(Schema.Boolean),
      threadId: Schema.optional(Schema.NonEmptyString),
      state: Schema.optional(Schema.String),
      limit: Schema.optional(Schema.Number),
      cursor: Schema.optional(Schema.String),
      attemptCursor: Schema.optional(Schema.String),
      eventCursor: Schema.optional(Schema.String),
      query: Schema.optional(Schema.NonEmptyString),
    }),
    result: Schema.Unknown,
    handler: Effect.fn("desktop.ipc.workbench.readNode")(function* (input, event) {
      yield* ensureMainWindow(event);
      if (input.resource === "program-loop" || input.resource === "program-loop-history") {
        if (
          !input.project ||
          !input.slug ||
          input.cursor !== undefined ||
          input.credential !== undefined ||
          (input.resource === "program-loop" &&
            (input.attemptCursor !== undefined || input.eventCursor !== undefined))
        ) {
          return yield* new WorkbenchReadError({
            message:
              "invalid_request: program loop reads require project/run and only history accepts dual cursors",
          });
        }
      } else if (input.attemptCursor !== undefined || input.eventCursor !== undefined) {
        return yield* new WorkbenchReadError({
          message: "invalid_request: dual cursors are only for program loop history",
        });
      }
      if (input.resource === "mail-signout" || input.resource === "operator-signout") {
        yield* Ref.set(operatorCredential, undefined);
        return { signedOut: true };
      }
      const savedCredential = yield* Ref.get(operatorCredential);
      const savedMailIdentity =
        input.resource.startsWith("program-loop") ||
        input.resource === "completion-hook" ||
        input.resource === "summary-history" ||
        input.resource === "summary" ||
        input.resource === "mail-directory" ||
        input.resource === "mail-owner-history";
      if (savedMailIdentity && input.credential !== undefined) {
        return yield* new WorkbenchReadError({
          message: "invalid_request: use the signed-in operator identity",
        });
      }
      const needsIdentity =
        input.resource.startsWith("program-loop") ||
        input.resource === "completion-hook" ||
        input.resource === "summary-history" ||
        input.resource === "summary" ||
        input.resource.startsWith("mail-") ||
        input.resource.startsWith("run-") ||
        input.resource.startsWith("knowledge-") ||
        input.resource === "review-status" ||
        input.resource === "change-preview" ||
        input.resource === "node-mark-history" ||
        input.resource === "node-events" ||
        input.resource === "operator-identity" ||
        input.resource === "dependencies" ||
        input.resource === "delivery" ||
        input.resource === "test-reports";
      const credential = needsIdentity ? (input.credential ?? savedCredential) : undefined;
      if (needsIdentity && !credential) {
        return yield* new WorkbenchReadError({
          message: "unauthorized: sign in to use this operation",
        });
      }
      const { executable, config } = yield* readRuntime;
      const resource = input.resource;
      const result = yield* Effect.tryPromise({
        try: (signal) =>
          readWorkbench({ ...input, resource, credential, executable, config }, signal),
        catch: (cause) =>
          new WorkbenchReadError({
            message: cause instanceof Error ? cause.message : "Local workbench read failed",
          }),
      });
      if ((resource === "mail-identity" || resource === "operator-identity") && input.credential)
        yield* Ref.set(operatorCredential, input.credential);
      return result;
    }),
  });
  const command = makeIpcMethod({
    channel: "vacpms:command",
    payload: Schema.Struct({
      operation: Schema.Literals([
        "preview-node-merge",
        "merge-nodes",
        "node-merge-history",
        "node-merge-receipt",
        "node-owner-read",
        "node-owner-history",
        "node-owner-take-begin",
        "node-owner-take-commit",
        "node-owner-take-cancel",
        "node-owner-return",
        "confirm-program-run-stopped",
        "candidate-loop-read",
        "candidate-loop-arm",
        "candidate-loop-stop",
        "candidate-loop-abandon",
        "candidate-satisfaction-record",
        "candidate-intervention-resolve",
        "candidate-satisfaction-history",
        "record-program-loop-decision",
        "stop-program-loop",
        "arm-completion-hook",
        "cancel-completion-hook",
        "retry-completion-hook",
        "record-summary-disposition",
        "accept-summary",
        "revoke-summary-acceptance",
        "prepare-program-run",
        "arm-delivery-hook",
        "cancel-delivery-hook",
        "retry-delivery-hook",
        "takeover-mail",
        "create-node",
        "approve-node",
        "subdivide-node",
        "review-delivery",
        "assign-review",
        "review-source",
        "record-test-result",
        "submit-delivery",
        "set-node-mark",
        "record-node-event",
        "bind-project",
        "unbind-project",
        "add-dependency",
        "remove-dependency",
        "manual-complete",
        "mail-setup",
        "prepare-run",
        "bind-run",
        "complete-run",
        "authorize-run",
        "resolve-run",
        "confirm-run-stopped",
        "abandon-node",
        "cancel-preparation",
        "abort-preparation",
      ]),
      project: Schema.NonEmptyString,
      slug: Schema.optional(Schema.NonEmptyString),
      body: Schema.Unknown,
    }),
    result: Schema.Unknown,
    handler: Effect.fn("desktop.ipc.workbench.command")(function* (input, event) {
      yield* ensureMainWindow(event);
      const credential = yield* Ref.get(operatorCredential);
      if (!credential)
        return {
          error: { code: "unauthorized", message: "Sign in before submitting an operation" },
        };
      const runtime = yield* readRuntime;
      if (input.operation === "mail-setup") {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        return yield* Effect.tryPromise({
          try: () => {
            mailboxSetup ??= setupMail({ home: environment.baseDir, runtime, credential }).finally(
              () => {
                mailboxSetup = undefined;
              },
            );
            return mailboxSetup.then((data) => ({ data }));
          },
          catch: (cause) =>
            new WorkbenchReadError({
              message: cause instanceof Error ? cause.message : "Mailbox setup failed",
            }),
        });
      }
      const operation = input.operation;
      let body = input.body;
      if (
        operation === "preview-node-merge" ||
        operation === "merge-nodes" ||
        operation === "node-merge-history" ||
        operation === "node-merge-receipt"
      ) {
        if (input.slug !== undefined)
          return yield* new WorkbenchReadError({
            message: "invalid_request: node merge operations do not accept a slug override",
          });
        const schema =
          operation === "preview-node-merge"
            ? Schema.Struct({
                sourceSlugs: Schema.Array(Schema.NonEmptyString),
                contextSlugs: Schema.optional(Schema.Array(Schema.NonEmptyString)),
              })
            : operation === "merge-nodes"
              ? WorkbenchMergeRequest
              : operation === "node-merge-history"
                ? Schema.Struct({
                    taskSlug: Schema.NonEmptyString,
                    beforeId: Schema.optional(Schema.NonEmptyString),
                  })
                : Schema.Struct({ id: Schema.NonEmptyString });
        body = yield* Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(body).pipe(
          Effect.mapError(
            () => new WorkbenchReadError({ message: "invalid_request: invalid node merge fields" }),
          ),
        );
      }
      if (operation === "cancel-preparation") {
        if (!input.slug)
          return yield* new WorkbenchReadError({
            message: "invalid_request: original run is required",
          });
        body = yield* Schema.decodeUnknownEffect(WorkbenchCancelPreparation, {
          onExcessProperty: "error",
        })(body).pipe(
          Effect.mapError(
            () =>
              new WorkbenchReadError({
                message: "invalid_request: invalid preparation cancellation fields",
              }),
          ),
        );
      }
      if (
        operation === "node-owner-read" ||
        operation === "node-owner-history" ||
        operation === "node-owner-take-begin" ||
        operation === "node-owner-take-commit" ||
        operation === "node-owner-take-cancel" ||
        operation === "node-owner-return" ||
        operation === "confirm-program-run-stopped"
      ) {
        if (input.slug !== undefined)
          return yield* new WorkbenchReadError({
            message: "invalid_request: node ownership operations do not accept a slug override",
          });
        const schema =
          operation === "node-owner-read"
            ? Schema.Struct({ taskSlug: Schema.NonEmptyString })
            : operation === "node-owner-history"
              ? Schema.Struct({ taskSlug: Schema.NonEmptyString, cursor: Schema.String })
              : operation === "node-owner-take-begin"
                ? WorkbenchBeginNodeOwnershipTake
                : operation === "node-owner-take-commit"
                  ? WorkbenchCommitNodeOwnershipTake
                  : operation === "node-owner-take-cancel"
                    ? WorkbenchCancelNodeOwnershipTake
                    : operation === "node-owner-return"
                      ? WorkbenchReturnNodeOwnership
                      : WorkbenchConfirmProgramRunStopped;
        body = yield* Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(body).pipe(
          Effect.mapError(
            () =>
              new WorkbenchReadError({
                message: "invalid_request: invalid node ownership command fields",
              }),
          ),
        );
      }
      if (operation === "bind-project" || operation === "unbind-project") {
        if (!input.slug)
          return yield* new WorkbenchReadError({
            message: "invalid_request: project binding operations require the node slug",
          });
        const schema =
          operation === "bind-project"
            ? Schema.Struct({
                environmentId: Schema.Trim.check(Schema.isMinLength(1)),
                nativeProjectId: Schema.Trim.check(Schema.isMinLength(1)),
                workspaceRoot: Schema.optional(Schema.String),
                reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
              })
            : Schema.Struct({
                reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
              });
        body = yield* Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(body).pipe(
          Effect.mapError(
            () =>
              new WorkbenchReadError({
                message: "invalid_request: invalid project binding fields",
              }),
          ),
        );
      }
      if (operation === "candidate-loop-arm") {
        if (input.slug !== undefined)
          return yield* new WorkbenchReadError({
            message: "invalid_request: candidate loop arm does not accept a slug override",
          });
        body = yield* Schema.decodeUnknownEffect(WorkbenchCandidateLoopPolicy, {
          onExcessProperty: "error",
        })(body).pipe(
          Effect.mapError(
            () =>
              new WorkbenchReadError({ message: "invalid_request: invalid candidate loop policy" }),
          ),
        );
      }
      if (
        operation === "candidate-satisfaction-record" ||
        operation === "candidate-intervention-resolve" ||
        operation === "candidate-satisfaction-history"
      ) {
        if (input.slug !== undefined)
          return yield* new WorkbenchReadError({
            message:
              "invalid_request: candidate satisfaction operations do not accept a slug override",
          });
        const schema =
          operation === "candidate-satisfaction-record"
            ? Schema.Struct({
                runId: Schema.NonEmptyString,
                attemptId: Schema.NonEmptyString,
                expectedJudgmentId: Schema.NullOr(Schema.NonEmptyString),
                value: Schema.Literals(["true", "false", "unknown"]),
                reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
              })
            : operation === "candidate-intervention-resolve"
              ? Schema.Struct({
                  runId: Schema.NonEmptyString,
                  attemptId: Schema.NonEmptyString,
                  interventionId: Schema.NonEmptyString,
                  expectedJudgmentId: Schema.NonEmptyString,
                  expectedReportIds: Schema.Array(Schema.NonEmptyString),
                  reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
                })
              : Schema.Struct({
                  runId: Schema.NonEmptyString,
                  attemptId: Schema.NonEmptyString,
                  judgmentCursor: Schema.optional(Schema.String),
                  interventionCursor: Schema.optional(Schema.String),
                });
        body = yield* Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(body).pipe(
          Effect.mapError(
            () =>
              new WorkbenchReadError({
                message: "invalid_request: invalid candidate satisfaction fields",
              }),
          ),
        );
      }
      if (
        operation === "candidate-loop-read" ||
        operation === "candidate-loop-stop" ||
        operation === "candidate-loop-abandon"
      ) {
        if (input.slug !== undefined)
          return yield* new WorkbenchReadError({
            message: "invalid_request: candidate loop commands do not accept a slug override",
          });
        const schema =
          operation === "candidate-loop-read"
            ? Schema.Struct({ runId: Schema.NonEmptyString })
            : Schema.Struct({
                runId: Schema.NonEmptyString,
                reason: Schema.Trim.check(Schema.isMinLength(1)),
              });
        body = yield* Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(body).pipe(
          Effect.mapError(
            () =>
              new WorkbenchReadError({ message: "invalid_request: invalid candidate loop fields" }),
          ),
        );
      }
      if (operation === "record-program-loop-decision" || operation === "stop-program-loop") {
        if (input.slug !== undefined)
          return yield* new WorkbenchReadError({
            message: "invalid_request: program loop commands do not accept a slug override",
          });
        const schema =
          operation === "record-program-loop-decision"
            ? Schema.Struct({
                runId: Schema.NonEmptyString,
                attemptId: Schema.NonEmptyString,
                expectedJudgmentId: Schema.NullOr(Schema.NonEmptyString),
                value: Schema.Literals(["true", "false", "unknown"]),
                basis: Schema.Trim.check(Schema.isMinLength(1)),
              })
            : Schema.Struct({
                runId: Schema.NonEmptyString,
                reason: Schema.Trim.check(Schema.isMinLength(1)),
              });
        body = yield* Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(body).pipe(
          Effect.mapError(
            () =>
              new WorkbenchReadError({
                message: "invalid_request: invalid program loop command fields",
              }),
          ),
        );
      }
      if (
        operation === "prepare-program-run" ||
        operation === "arm-delivery-hook" ||
        operation === "cancel-delivery-hook" ||
        operation === "retry-delivery-hook" ||
        operation === "arm-completion-hook" ||
        operation === "cancel-completion-hook" ||
        operation === "retry-completion-hook"
      ) {
        const program = operation === "prepare-program-run";
        const completionHook =
          operation === "arm-completion-hook" ||
          operation === "cancel-completion-hook" ||
          operation === "retry-completion-hook";
        if (input.slug !== undefined)
          return yield* new WorkbenchReadError({
            message: `invalid_request: ${program ? "program preparation" : completionHook ? "completion hooks" : "delivery hooks"} do not accept a slug override`,
          });
        const schema = program
          ? Schema.Struct({
              taskSlug: Schema.NonEmptyString,
              idempotencyKey: Schema.NonEmptyString,
              command: Schema.Struct({
                executable: Schema.NonEmptyString,
                args: Schema.Array(Schema.String),
                cwd: Schema.NonEmptyString,
                environmentId: Schema.NonEmptyString,
                nativeProjectId: Schema.NonEmptyString,
                timeoutMs: Schema.Number,
                workPurpose: Schema.NonEmptyString,
                qaBasis: Schema.optional(Schema.Unknown),
                completeOnSuccess: Schema.optional(Schema.Boolean),
                loop: Schema.optional(WorkbenchProgramLoopPolicy),
              }),
            })
          : operation === "arm-completion-hook"
            ? Schema.Struct({
                sourceTaskSlug: Schema.NonEmptyString,
                sourceSpecId: Schema.NonEmptyString,
                targetRunId: Schema.NonEmptyString,
                targetPackageId: Schema.NonEmptyString,
                idempotencyKey: Schema.NonEmptyString,
                confirmTrigger: Schema.Literal(true),
                fact: Schema.optional(
                  Schema.Struct({
                    kind: Schema.Literals(["execution", "manual", "summary"]),
                    id: Schema.NonEmptyString,
                  }),
                ),
              })
            : operation === "arm-delivery-hook"
              ? Schema.Struct({
                  sourceRunId: Schema.NonEmptyString,
                  targetRunId: Schema.NonEmptyString,
                  commitSha: Schema.NonEmptyString,
                  idempotencyKey: Schema.NonEmptyString,
                  deliveryId: Schema.optional(Schema.NonEmptyString),
                })
              : operation === "cancel-delivery-hook" || operation === "cancel-completion-hook"
                ? Schema.Struct({ hookId: Schema.NonEmptyString, reason: Schema.NonEmptyString })
                : Schema.Struct({ hookId: Schema.NonEmptyString });
        const request = yield* Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(
          body,
        ).pipe(
          Effect.mapError(
            () =>
              new WorkbenchReadError({
                message: `invalid_request: invalid ${program ? "program preparation" : completionHook ? "completion hook" : "delivery hook"} command fields`,
              }),
          ),
        );
        body = request;
        if (program || operation === "arm-delivery-hook" || operation === "arm-completion-hook") {
          const configuredPath = yield* Config.String("T3_WORKBENCH_MAIL_CONFIG").pipe(
            Config.option,
          );
          const service = yield* Effect.try({
            try: () => loadMailConfig(Option.getOrUndefined(configuredPath)),
            catch: () =>
              new WorkbenchReadError({
                message: `Local ${program ? "program" : completionHook ? "completion hook" : "delivery hook"} service configuration is unavailable`,
              }),
          });
          if (
            service === undefined ||
            !("executable" in service) ||
            normalizeProjectPathForComparison(service.executable) !==
              normalizeProjectPathForComparison(runtime.executable) ||
            normalizeProjectPathForComparison(service.config) !==
              normalizeProjectPathForComparison(runtime.config)
          ) {
            return yield* new WorkbenchReadError({
              message: `${program ? "Program" : completionHook ? "Completion hook" : "Delivery hook"} service must use the configured local workbench runtime`,
            });
          }
          body = { ...request, hostCredential: service.token };
        }
      }
      return yield* Effect.tryPromise({
        try: (signal) =>
          commandWorkbench({ ...input, operation, body, ...runtime, credential }, signal),
        catch: (cause) =>
          new WorkbenchReadError({
            message: cause instanceof Error ? cause.message : "Local command outcome unconfirmed",
          }),
      });
    }),
  });
  return { read, command };
});
