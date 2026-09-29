import type { WorkbenchRequest } from "@project-workbench/ui/model";
import {
  WorkbenchBeginNodeOwnershipTake,
  WorkbenchCancelNodeOwnershipTake,
  WorkbenchCommitNodeOwnershipTake,
  WorkbenchConfirmProgramRunStopped,
  WorkbenchNodeOwnershipOperation,
  WorkbenchNodeOwnershipPage,
  WorkbenchNodeOwnershipState,
  WorkbenchReturnNodeOwnership,
  WorkbenchMergePreview,
  WorkbenchMergeRequest,
  WorkbenchMergeReceipt,
  WorkbenchMergeHistory,
  WorkbenchCancelPreparation,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const errorStatus: Record<string, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  project_binding_mismatch: 409,
  already_exists: 409,
  invalid_argument: 400,
  invalid_request: 400,
  failed_precondition: 428,
  schema_mismatch: 428,
};

// Existing forms keep their request/receipt contract; no network fetch occurs here.
export const requestWorkbench: WorkbenchRequest = async (url, init) => {
  init?.signal?.throwIfAborted();
  const bridge = window.desktopBridge;
  if (!bridge?.readWorkbench) throw new Error("Local workbench bridge is unavailable");
  const method = init?.method ?? "GET";
  const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
  const project = new Headers(init?.headers).get("X-Specgraph-Project");
  const read = async (input: Parameters<NonNullable<typeof bridge.readWorkbench>>[0]) => {
    try {
      const data = await bridge.readWorkbench!(input);
      init?.signal?.throwIfAborted();
      return Response.json(data);
    } catch (cause) {
      init?.signal?.throwIfAborted();
      const code = String(cause).match(
        /\b(unauthorized|forbidden|not_found|invalid_request|schema_mismatch):/,
      )?.[1];
      if (!code) throw cause;
      return Response.json({ code, error: String(cause) }, { status: errorStatus[code]! });
    }
  };
  if (url === "/workbench-api/api/auth/whoami" && method === "GET")
    return read({ resource: "operator-identity" });
  if (url === "/workbench-api/api/auth/login" && method === "POST")
    return read({ resource: "operator-identity", credential: body.key });
  if (url === "/workbench-api/api/auth/logout" && method === "POST")
    return read({ resource: "operator-signout" });
  if (!project) throw new Error("Workbench project is required");
  const mergeRead = url.match(/^\/workbench-api\/loop\/node-merges\/(preview|history|receipt)$/);
  const mergeWrite = url === "/workbench-api/loop/node-merges";
  if (mergeRead || mergeWrite) {
    if (method !== "POST" || !bridge.commandWorkbench)
      throw new Error("Invalid node merge operation");
    const operation = mergeWrite
      ? "merge-nodes"
      : mergeRead![1] === "preview"
        ? "preview-node-merge"
        : mergeRead![1] === "history"
          ? "node-merge-history"
          : "node-merge-receipt";
    const schema = mergeWrite
      ? WorkbenchMergeRequest
      : mergeRead![1] === "preview"
        ? Schema.Struct({
            sourceSlugs: Schema.Array(Schema.NonEmptyString),
            contextSlugs: Schema.optional(Schema.Array(Schema.NonEmptyString)),
          })
        : mergeRead![1] === "history"
          ? Schema.Struct({
              taskSlug: Schema.NonEmptyString,
              beforeId: Schema.optional(Schema.NonEmptyString),
            })
          : Schema.Struct({ id: Schema.NonEmptyString });
    let input: typeof body;
    try {
      input = Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(body);
    } catch (cause) {
      return Response.json({ code: "invalid_request", error: String(cause) }, { status: 400 });
    }
    const result = await bridge.commandWorkbench({ operation, project, body: input });
    init?.signal?.throwIfAborted();
    if (result.error)
      return Response.json(
        { code: result.error.code, error: result.error.message },
        { status: errorStatus[result.error.code] ?? 500 },
      );
    if (result.data === undefined) throw new Error("Node merge response is missing");
    return Response.json(
      Schema.decodeUnknownSync(
        mergeWrite || mergeRead![1] === "receipt"
          ? WorkbenchMergeReceipt
          : mergeRead![1] === "preview"
            ? WorkbenchMergePreview
            : WorkbenchMergeHistory,
      )(result.data),
    );
  }
  const nodeOwner = url.match(
    /^\/workbench-api\/loop\/node-ownership\/([^/?]+)(\/history)?(?:\?(.*))?$/,
  );
  const nodeOwnerAction = url.match(
    /^\/workbench-api\/loop\/node-ownership\/(take-begin|take-commit|take-cancel|return)$/,
  );
  const programStop = url.match(/^\/workbench-api\/loop\/program-runs\/([^/?]+)\/confirm-stopped$/);
  if (nodeOwnerAction && method !== "POST")
    throw new Error("Operation is not enabled on local IPC");
  if (nodeOwner && method === "GET") {
    const params = new URLSearchParams(nodeOwner[3]);
    if (
      (!nodeOwner[2] && nodeOwner[3] !== undefined) ||
      [...params.keys()].some((key) => key !== "cursor") ||
      params.getAll("cursor").length > 1
    )
      throw new Error("Invalid node ownership history selector");
  }
  if (programStop && method === "POST" && body?.runId !== decodeURIComponent(programStop[1]!))
    throw new Error("Invalid program stop target");
  const ownershipSchema =
    nodeOwner && method === "GET"
      ? nodeOwner[2]
        ? WorkbenchNodeOwnershipPage
        : WorkbenchNodeOwnershipState
      : nodeOwnerAction && method === "POST"
        ? WorkbenchNodeOwnershipOperation
        : undefined;
  const ownershipBody =
    nodeOwner && method === "GET"
      ? {
          taskSlug: decodeURIComponent(nodeOwner[1]!),
          ...(nodeOwner[2]
            ? { cursor: new URLSearchParams(nodeOwner[3]).get("cursor") ?? "" }
            : {}),
        }
      : nodeOwnerAction && method === "POST"
        ? Schema.decodeUnknownSync(
            nodeOwnerAction[1] === "take-begin"
              ? WorkbenchBeginNodeOwnershipTake
              : nodeOwnerAction[1] === "take-commit"
                ? WorkbenchCommitNodeOwnershipTake
                : nodeOwnerAction[1] === "take-cancel"
                  ? WorkbenchCancelNodeOwnershipTake
                  : WorkbenchReturnNodeOwnership,
            { onExcessProperty: "error" },
          )(body)
        : programStop && method === "POST"
          ? Schema.decodeUnknownSync(WorkbenchConfirmProgramRunStopped, {
              onExcessProperty: "error",
            })(body)
          : undefined;
  const completionHook = url.match(/^\/workbench-api\/loop\/completion-hooks\/([^/?]+)$/);
  if (
    completionHook &&
    method === "GET" &&
    !["arm", "cancel", "retry"].includes(completionHook[1]!)
  )
    return read({
      resource: "completion-hook",
      project,
      slug: decodeURIComponent(completionHook[1]!),
    });
  const summary = url.match(/^\/workbench-api\/loop\/summaries\/([^/?]+)(?:\/history\?(.*))?$/);
  if (summary && method === "GET") {
    const params = new URLSearchParams(summary[2]);
    const history = summary[2] !== undefined;
    if (
      history &&
      (!["dispositions", "acceptances"].includes(params.get("kind") ?? "") ||
        [...params.keys()].some((key) => key !== "kind" && key !== "cursor"))
    )
      throw new Error("Invalid summary history selector");
    return read({
      resource: history ? "summary-history" : "summary",
      project,
      slug: decodeURIComponent(summary[1]!),
      ...(history ? { query: params.get("kind")!, cursor: params.get("cursor") ?? "" } : {}),
    });
  }
  const candidateLoop = url.match(
    /^\/workbench-api\/loop\/candidate-loops\/([^/?]+)(?:\/(stop|abandon))?$/,
  );
  const candidateSatisfaction = url.match(
    /^\/workbench-api\/loop\/candidate-loops\/([^/?]+)\/(satisfaction|intervention)$/,
  );
  const candidateHistory = url.match(
    /^\/workbench-api\/loop\/candidate-loops\/([^/?]+)\/satisfaction-history\?(.*)$/,
  );
  if (candidateHistory && method === "GET") {
    const params = new URLSearchParams(candidateHistory[2]);
    if (
      !params.get("attemptId") ||
      [...params.keys()].some(
        (key) => !["attemptId", "judgmentCursor", "interventionCursor"].includes(key),
      )
    )
      throw new Error("Invalid candidate satisfaction history selector");
    if (!bridge.commandWorkbench) throw new Error("Local workbench command bridge is unavailable");
    const result = await bridge.commandWorkbench({
      operation: "candidate-satisfaction-history",
      project,
      body: {
        runId: decodeURIComponent(candidateHistory[1]!),
        attemptId: params.get("attemptId")!,
        ...(params.has("judgmentCursor") ? { judgmentCursor: params.get("judgmentCursor") } : {}),
        ...(params.has("interventionCursor")
          ? { interventionCursor: params.get("interventionCursor") }
          : {}),
      },
    });
    init?.signal?.throwIfAborted();
    if (result.error)
      return Response.json(
        { code: result.error.code, error: result.error.message },
        { status: errorStatus[result.error.code] ?? 500 },
      );
    if (result.data === undefined) throw new Error("Candidate history response is missing");
    return Response.json(result.data);
  }
  const candidateArm = url === "/workbench-api/loop/candidate-loops/arm" && method === "POST";
  const candidateRunId = candidateLoop ? decodeURIComponent(candidateLoop[1]!) : undefined;
  const candidateRead = !!candidateLoop && !candidateLoop[2] && method === "GET";
  if (
    candidateLoop &&
    !candidateRead &&
    !candidateArm &&
    (method !== "POST" || !candidateLoop[2] || body?.runId !== candidateRunId)
  )
    throw new Error("Invalid candidate loop operation");
  if (
    candidateSatisfaction &&
    (method !== "POST" || body?.runId !== decodeURIComponent(candidateSatisfaction[1]!))
  )
    throw new Error("Invalid candidate satisfaction operation");
  const programLoop = url.match(
    /^\/workbench-api\/loop\/program-runs\/([^/?]+)\/loop(\/history)?(?:\?(.*))?$/,
  );
  if (programLoop && method === "GET") {
    const params = new URLSearchParams(programLoop[3]);
    if (
      params.has("cursor") ||
      (!programLoop[2] && params.size > 0) ||
      [...params.keys()].some((key) => !["attemptCursor", "eventCursor"].includes(key))
    )
      throw new Error("Invalid program loop read cursors");
    return read({
      resource: programLoop[2] ? "program-loop-history" : "program-loop",
      project,
      slug: decodeURIComponent(programLoop[1]!),
      ...(programLoop[2]
        ? {
            attemptCursor: params.get("attemptCursor") ?? "",
            eventCursor: params.get("eventCursor") ?? "",
          }
        : {}),
    });
  }
  const spec = url.match(/^\/workbench-api\/wb\/specs\/([^/]+)$/);
  if (spec && method === "GET")
    return read({ resource: "spec", project, slug: decodeURIComponent(spec[1]!) });
  const changePreview = url.match(/^\/workbench-api\/loop\/specs\/([^/]+)\/change-preview$/);
  if (changePreview && method === "GET")
    return read({
      resource: "change-preview",
      project,
      slug: decodeURIComponent(changePreview[1]!),
    });
  const reviewStatus = url.match(/^\/workbench-api\/loop\/specs\/([^/]+)\/review-status$/);
  if (reviewStatus && method === "GET")
    return read({ resource: "review-status", project, slug: decodeURIComponent(reviewStatus[1]!) });
  const knowledge = url.match(/^\/workbench-api\/knowledge\/(spec|decision|change)\/([^/]+)$/);
  if (knowledge && method === "GET")
    return read({
      resource: `knowledge-${knowledge[1]}` as
        | "knowledge-spec"
        | "knowledge-decision"
        | "knowledge-change",
      project,
      slug: decodeURIComponent(knowledge[2]!),
    });
  if (url.startsWith("/workbench-api/knowledge-search?") && method === "GET")
    return read({
      resource: "knowledge-search",
      project,
      query: new URLSearchParams(url.split("?")[1]).get("q") ?? "",
    });
  const nodeMarks = url.match(/^\/workbench-api\/node-marks\/([^/?]+)(?:\?(.*))?$/);
  if (nodeMarks && method === "GET")
    return read({
      resource: "node-mark-history",
      project,
      slug: decodeURIComponent(nodeMarks[1]!),
      cursor: new URLSearchParams(nodeMarks[2]).get("cursor") ?? "",
    });
  const nodeEvents = url.match(/^\/workbench-api\/node-events\/([^/?]+)(?:\?(.*))?$/);
  if (nodeEvents && method === "GET")
    return read({
      resource: "node-events",
      project,
      slug: decodeURIComponent(nodeEvents[1]!),
      cursor: new URLSearchParams(nodeEvents[2]).get("cursor") ?? "",
    });
  const projectBinding = url.match(/^\/workbench-api\/project-binding\/([^/?]+)(\/revoke)?$/);
  const delivery = url.match(/^\/workbench-api\/loop\/deliveries\/([^/]+)(\/accept)?$/);
  const tests = url.match(/^\/workbench-api\/loop\/deliveries\/([^/?]+)\/tests(?:\?(.*))?$/);
  if (tests && method === "GET")
    return read({
      resource: "test-reports",
      project,
      slug: decodeURIComponent(tests[1]!),
      cursor: new URLSearchParams(tests[2]).get("cursor") ?? "",
    });
  if (delivery && !delivery[2] && method === "GET")
    return read({ resource: "delivery", project, slug: decodeURIComponent(delivery[1]!) });
  const run = url.match(/^\/workbench-api\/loop\/runs\/([^/]+)\/(context|dispatch)$/);
  if (run && method === "GET")
    return read({
      resource: run[2] === "context" ? "run-context" : "run-dispatch",
      project,
      slug: decodeURIComponent(run[1]!),
    });
  const match = url.match(
    /^\/workbench-api\/loop\/specs\/(.+)\/(dependencies(?:\/remove)?|manual-complete|approve|subdivide|abandon|assign-review|review-source)$/,
  );
  const runAction = url.match(
    /^\/workbench-api\/loop\/runs\/([^/]+)\/(bind|complete|dispatch\/(?:authorize|resolve|confirm-stopped|cancel-preparation))$/,
  );
  const slug = tests
    ? decodeURIComponent(tests[1]!)
    : nodeEvents
      ? decodeURIComponent(nodeEvents[1]!)
      : nodeMarks
        ? decodeURIComponent(nodeMarks[1]!)
        : projectBinding
          ? decodeURIComponent(projectBinding[1]!)
          : match
            ? decodeURIComponent(match[1]!)
            : runAction
              ? decodeURIComponent(runAction[1]!)
              : delivery
                ? decodeURIComponent(delivery[1]!)
                : undefined;
  if (match?.[2] === "dependencies" && method === "GET")
    return read({ resource: "dependencies", project, slug: slug! });
  const operation = candidateRead
    ? "candidate-loop-read"
    : nodeOwner && method === "GET"
      ? nodeOwner[2]
        ? "node-owner-history"
        : "node-owner-read"
      : nodeOwnerAction && method === "POST"
        ? (`node-owner-${nodeOwnerAction[1]}` as
            | "node-owner-take-begin"
            | "node-owner-take-commit"
            | "node-owner-take-cancel"
            | "node-owner-return")
        : programStop && method === "POST"
          ? "confirm-program-run-stopped"
          : candidateArm
            ? "candidate-loop-arm"
            : candidateSatisfaction?.[2] === "satisfaction"
              ? "candidate-satisfaction-record"
              : candidateSatisfaction?.[2] === "intervention"
                ? "candidate-intervention-resolve"
                : url === "/workbench-api/loop/completion-hooks/arm"
                  ? "arm-completion-hook"
                  : url === "/workbench-api/loop/completion-hooks/cancel"
                    ? "cancel-completion-hook"
                    : url === "/workbench-api/loop/completion-hooks/retry"
                      ? "retry-completion-hook"
                      : url === "/workbench-api/loop/summaries/disposition"
                        ? "record-summary-disposition"
                        : url === "/workbench-api/loop/summaries/accept"
                          ? "accept-summary"
                          : url === "/workbench-api/loop/summaries/revoke"
                            ? "revoke-summary-acceptance"
                            : candidateLoop?.[2] === "stop"
                              ? "candidate-loop-stop"
                              : candidateLoop?.[2] === "abandon"
                                ? "candidate-loop-abandon"
                                : url === "/workbench-api/loop/program-loops/decision"
                                  ? "record-program-loop-decision"
                                  : url === "/workbench-api/loop/program-loops/stop"
                                    ? "stop-program-loop"
                                    : url === "/workbench-api/specgraph.v1.SpecService/CreateSpec"
                                      ? "create-node"
                                      : tests
                                        ? "record-test-result"
                                        : nodeMarks
                                          ? "set-node-mark"
                                          : nodeEvents
                                            ? "record-node-event"
                                            : projectBinding?.[2] === "/revoke"
                                              ? "unbind-project"
                                              : projectBinding
                                                ? "bind-project"
                                                : url === "/workbench-api/loop/deliveries"
                                                  ? "submit-delivery"
                                                  : delivery?.[2] === "/accept"
                                                    ? "review-delivery"
                                                    : url === "/workbench-api/loop/runs"
                                                      ? "prepare-run"
                                                      : url === "/workbench-api/loop/program-runs"
                                                        ? "prepare-program-run"
                                                        : url ===
                                                            "/workbench-api/loop/preparations/abort"
                                                          ? "abort-preparation"
                                                          : runAction?.[2] === "bind"
                                                            ? "bind-run"
                                                            : runAction?.[2] === "complete"
                                                              ? "complete-run"
                                                              : runAction?.[2] ===
                                                                  "dispatch/authorize"
                                                                ? "authorize-run"
                                                                : runAction?.[2] ===
                                                                    "dispatch/resolve"
                                                                  ? "resolve-run"
                                                                  : runAction?.[2] ===
                                                                      "dispatch/confirm-stopped"
                                                                    ? "confirm-run-stopped"
                                                                    : runAction?.[2] ===
                                                                        "dispatch/cancel-preparation"
                                                                      ? "cancel-preparation"
                                                                      : url ===
                                                                          "/workbench-api/wb/mail/setup"
                                                                        ? "mail-setup"
                                                                        : url ===
                                                                            "/workbench-api/wb/mail/takeover"
                                                                          ? "takeover-mail"
                                                                          : url ===
                                                                              "/workbench-api/wb/delivery-hooks/arm"
                                                                            ? "arm-delivery-hook"
                                                                            : url ===
                                                                                "/workbench-api/wb/delivery-hooks/cancel"
                                                                              ? "cancel-delivery-hook"
                                                                              : url ===
                                                                                  "/workbench-api/wb/delivery-hooks/retry"
                                                                                ? "retry-delivery-hook"
                                                                                : match?.[2] ===
                                                                                    "dependencies"
                                                                                  ? "add-dependency"
                                                                                  : match?.[2] ===
                                                                                      "dependencies/remove"
                                                                                    ? "remove-dependency"
                                                                                    : match?.[2] ===
                                                                                        "approve"
                                                                                      ? "approve-node"
                                                                                      : match?.[2] ===
                                                                                          "subdivide"
                                                                                        ? "subdivide-node"
                                                                                        : match?.[2] ===
                                                                                            "abandon"
                                                                                          ? "abandon-node"
                                                                                          : match?.[2] ===
                                                                                              "assign-review"
                                                                                            ? "assign-review"
                                                                                            : match?.[2] ===
                                                                                                "review-source"
                                                                                              ? "review-source"
                                                                                              : match?.[2] ===
                                                                                                  "manual-complete"
                                                                                                ? "manual-complete"
                                                                                                : null;
  if ((method !== "POST" && !candidateRead && !(nodeOwner && method === "GET")) || !operation)
    throw new Error("Operation is not enabled on local IPC");
  if (!bridge.commandWorkbench) throw new Error("Local workbench command bridge is unavailable");
  let commandBody = ownershipBody ?? (candidateRead ? { runId: candidateRunId } : body);
  if (operation === "cancel-preparation") {
    try {
      commandBody = Schema.decodeUnknownSync(WorkbenchCancelPreparation, {
        onExcessProperty: "error",
      })(body);
    } catch (cause) {
      return Response.json({ code: "invalid_request", error: String(cause) }, { status: 400 });
    }
  }
  const result = await bridge.commandWorkbench({
    operation,
    project,
    ...(slug ? { slug } : {}),
    body: commandBody,
  });
  init?.signal?.throwIfAborted();
  if (result.error)
    return Response.json(
      {
        ...(result.data !== null && typeof result.data === "object" ? result.data : {}),
        code: result.error.code,
        error: result.error.message,
      },
      { status: errorStatus[result.error.code] ?? 500 },
    );
  if (result.data === undefined) throw new Error("Command response is missing its receipt");
  return Response.json(
    ownershipSchema ? Schema.decodeUnknownSync(ownershipSchema)(result.data) : result.data,
  );
};
