import { afterEach, expect, it, vi } from "vite-plus/test";
import { requestWorkbench } from "./WorkbenchTransport";

afterEach(() => vi.unstubAllGlobals());

it("routes node merge preview, atomic write, receipt and lineage history through the local bridge", async () => {
  const expected = {
    sources: [
      { id: "id-a", slug: "a", version: 2, stage: "done", role: "work" },
      { id: "id-b", slug: "b", version: 3, stage: "review", role: "work" },
    ],
    contexts: [],
    relations: [],
    lineage: [],
    ancestors: [],
  };
  const body = {
    expected,
    target: {
      slug: "c",
      intent: "Combined goal",
      role: "work",
      priority: "p2",
      complexity: "medium",
    },
    relations: [],
    addedRelations: [],
    dispositions: [],
    reason: "Reviewed sources",
    idempotencyKey: "merge-key",
  };
  const receipt = {
    id: "receipt",
    idempotencyKey: "merge-key",
    request: body,
    actorUserId: "human",
    sources: [
      { id: "id-a", slug: "a", beforeVersion: 2, afterVersion: 3 },
      { id: "id-b", slug: "b", beforeVersion: 3, afterVersion: 4 },
    ],
    target: { id: "id-c", slug: "c" },
    insertedRelations: [],
    deletedRelations: [],
    dispositionIds: [],
    createdAt: "2026-09-29T00:00:00Z",
    replayed: false,
  };
  const commandWorkbench = vi
    .fn()
    .mockResolvedValueOnce({ data: expected })
    .mockResolvedValueOnce({ data: receipt })
    .mockResolvedValueOnce({ data: receipt })
    .mockResolvedValueOnce({ data: { items: [receipt], hasMore: false, nextCursor: "" } });
  vi.stubGlobal("window", { desktopBridge: { readWorkbench: vi.fn(), commandWorkbench } });
  const init = { method: "POST", headers: { "X-Specgraph-Project": "project" } };
  expect(
    await (
      await requestWorkbench("/workbench-api/loop/node-merges/preview", {
        ...init,
        body: JSON.stringify({ sourceSlugs: ["a", "b"], contextSlugs: [] }),
      })
    ).json(),
  ).toEqual(expected);
  expect(commandWorkbench).toHaveBeenLastCalledWith({
    operation: "preview-node-merge",
    project: "project",
    body: { sourceSlugs: ["a", "b"], contextSlugs: [] },
  });
  expect(
    await (
      await requestWorkbench("/workbench-api/loop/node-merges", {
        ...init,
        body: JSON.stringify(body),
      })
    ).json(),
  ).toEqual(receipt);
  expect(commandWorkbench).toHaveBeenLastCalledWith({
    operation: "merge-nodes",
    project: "project",
    body,
  });
  expect(
    await (
      await requestWorkbench("/workbench-api/loop/node-merges/receipt", {
        ...init,
        body: JSON.stringify({ id: "receipt" }),
      })
    ).json(),
  ).toEqual(receipt);
  expect(
    await (
      await requestWorkbench("/workbench-api/loop/node-merges/history", {
        ...init,
        body: JSON.stringify({ taskSlug: "a", beforeId: "older" }),
      })
    ).json(),
  ).toEqual({ items: [receipt], hasMore: false, nextCursor: "" });
  expect(commandWorkbench).toHaveBeenLastCalledWith({
    operation: "node-merge-history",
    project: "project",
    body: { taskSlug: "a", beforeId: "older" },
  });
  const rejected = await requestWorkbench("/workbench-api/loop/node-merges", {
    ...init,
    body: JSON.stringify({ ...body, hostCredential: "forged" }),
  });
  expect(rejected.status).toBe(400);
  expect(commandWorkbench).toHaveBeenCalledTimes(4);
});

it("keeps raw handoff evidence on the original cancellation operation", async () => {
  const commandWorkbench = vi.fn().mockResolvedValue({ data: { recorded: true } });
  vi.stubGlobal("window", { desktopBridge: { readWorkbench: vi.fn(), commandWorkbench } });
  const body = {
    packageId: "package",
    note: "Observed stopped",
    rawHandoff: {
      environmentId: "local",
      threadId: "thread",
      summary: {
        kind: "human_substitute",
        humanSubstitute: {
          statement: "Recovered",
          sourceRefs: ["log"],
          missingInfo: ["final turn"],
        },
      },
    },
  };
  const init = { method: "POST", headers: { "X-Specgraph-Project": "project" } };
  expect(
    await (
      await requestWorkbench("/workbench-api/loop/runs/run/dispatch/cancel-preparation", {
        ...init,
        body: JSON.stringify(body),
      })
    ).json(),
  ).toEqual({ recorded: true });
  expect(commandWorkbench).toHaveBeenCalledWith({
    operation: "cancel-preparation",
    project: "project",
    slug: "run",
    body,
  });
  expect(
    (
      await requestWorkbench("/workbench-api/loop/runs/run/dispatch/cancel-preparation", {
        ...init,
        body: JSON.stringify({ ...body, rawHandoff: { ...body.rawHandoff, actor: "forged" } }),
      })
    ).status,
  ).toBe(400);
  expect(commandWorkbench).toHaveBeenCalledTimes(1);
});

it("routes human node ownership reads, writes and observed program stop as direct DTOs", async () => {
  const operation = {
    id: "operation",
    taskSlug: "parent/task",
    idempotencyKey: "intent",
    action: "take",
    status: "pending",
    beforeOwnerUserId: null,
    afterOwnerUserId: "human",
    fromVersion: 2,
    actorUserId: "human",
    reason: "Taking ownership",
    dispatches: [],
    preparations: [],
    handoffs: [],
    preparedHandoffs: [],
    frozenClaim: null,
    claimHandoff: null,
    createdAt: "2026-09-28T00:00:00Z",
  };
  const state = {
    taskSlug: "parent/task",
    version: 2,
    humanOwnerUserId: null,
    pending: operation,
    dispatchObservations: [],
    preparationObservations: [],
    currentClaim: null,
  };
  const page = {
    taskSlug: "parent/task",
    operations: [operation],
    hasMore: false,
    nextCursor: null,
  };
  const commandWorkbench = vi
    .fn()
    .mockResolvedValueOnce({ data: state })
    .mockResolvedValueOnce({ data: page });
  vi.stubGlobal("window", { desktopBridge: { readWorkbench: vi.fn(), commandWorkbench } });
  const init = { headers: { "X-Specgraph-Project": "project" } };
  expect(
    await (await requestWorkbench("/workbench-api/loop/node-ownership/parent%2Ftask", init)).json(),
  ).toEqual(state);
  expect(commandWorkbench).toHaveBeenLastCalledWith({
    operation: "node-owner-read",
    project: "project",
    body: { taskSlug: "parent/task" },
  });
  expect(
    await (
      await requestWorkbench(
        "/workbench-api/loop/node-ownership/parent%2Ftask/history?cursor=17",
        init,
      )
    ).json(),
  ).toEqual(page);
  expect(commandWorkbench).toHaveBeenLastCalledWith({
    operation: "node-owner-history",
    project: "project",
    body: { taskSlug: "parent/task", cursor: "17" },
  });
  const writes = [
    [
      "take-begin",
      {
        taskSlug: "parent/task",
        expectedVersion: 2,
        expectedOwnerUserId: null,
        idempotencyKey: "intent",
        reason: "Taking ownership",
      },
    ],
    [
      "take-commit",
      {
        operationId: "operation",
        expectedVersion: 2,
        handoffs: [],
        preparedHandoffs: [],
        claimHandoff: null,
      },
    ],
    ["take-cancel", { operationId: "operation", reason: "No longer taking" }],
    [
      "return",
      {
        taskSlug: "parent/task",
        expectedVersion: 3,
        expectedOwnerUserId: "human",
        idempotencyKey: "return",
        reason: "Returning ownership",
      },
    ],
  ] as const;
  for (const [action, body] of writes) {
    commandWorkbench.mockResolvedValueOnce({ data: operation });
    expect(
      await (
        await requestWorkbench(`/workbench-api/loop/node-ownership/${action}`, {
          ...init,
          method: "POST",
          body: JSON.stringify(body),
        })
      ).json(),
    ).toEqual(operation);
    expect(commandWorkbench).toHaveBeenLastCalledWith({
      operation: `node-owner-${action}`,
      project: "project",
      body,
    });
  }
  const stop = {
    runId: "run/one",
    admissionId: "admission",
    attemptId: "attempt",
    environmentId: "env",
    nativeProjectId: "native",
    note: "Observed stopped",
  };
  const dispatch = {
    admission: null,
    resolution: null,
    cancellation: null,
    stopConfirmation: { actor: "human", note: stop.note, confirmedAt: "2026-09-28T00:00:00Z" },
  };
  commandWorkbench.mockResolvedValueOnce({ data: dispatch });
  expect(
    await (
      await requestWorkbench("/workbench-api/loop/program-runs/run%2Fone/confirm-stopped", {
        ...init,
        method: "POST",
        body: JSON.stringify(stop),
      })
    ).json(),
  ).toEqual(dispatch);
  expect(commandWorkbench).toHaveBeenLastCalledWith({
    operation: "confirm-program-run-stopped",
    project: "project",
    body: stop,
  });
  await expect(
    requestWorkbench("/workbench-api/loop/node-ownership/parent%2Ftask?cursor=17", init),
  ).rejects.toThrow("history selector");
  await expect(
    requestWorkbench(
      "/workbench-api/loop/node-ownership/parent%2Ftask/history?cursor=1&cursor=2",
      init,
    ),
  ).rejects.toThrow("history selector");
  await expect(
    requestWorkbench("/workbench-api/loop/program-runs/run/confirm-stopped", {
      ...init,
      method: "POST",
      body: JSON.stringify(stop),
    }),
  ).rejects.toThrow("stop target");
  await expect(
    requestWorkbench("/workbench-api/loop/node-ownership/take-begin", {
      ...init,
      method: "POST",
      body: JSON.stringify({ ...writes[0][1], hostCredential: "forged" }),
    }),
  ).rejects.toThrow();
  expect(commandWorkbench).toHaveBeenCalledTimes(7);
});

it("maps human loop reads and controls without native host or HTTP and rejects old cursors", async () => {
  const readWorkbench = vi.fn().mockResolvedValue({ run: {} });
  const commandWorkbench = vi.fn().mockResolvedValue({ data: { id: "event" } });
  vi.stubGlobal("window", { desktopBridge: { readWorkbench, commandWorkbench } });
  const init = { headers: { "X-Specgraph-Project": "project" } };
  await requestWorkbench("/workbench-api/loop/program-runs/run%2Fone/loop", init);
  expect(readWorkbench).toHaveBeenLastCalledWith({
    resource: "program-loop",
    project: "project",
    slug: "run/one",
  });
  await requestWorkbench(
    "/workbench-api/loop/program-runs/run/loop/history?attemptCursor=50&eventCursor=event-one",
    init,
  );
  expect(readWorkbench).toHaveBeenLastCalledWith({
    resource: "program-loop-history",
    project: "project",
    slug: "run",
    attemptCursor: "50",
    eventCursor: "event-one",
  });
  for (const suffix of [
    "?cursor=50",
    "/history?cursor=50",
    "?attemptCursor=50",
    "/history?offset=50",
  ])
    await expect(
      requestWorkbench(`/workbench-api/loop/program-runs/run/loop${suffix}`, init),
    ).rejects.toThrow("cursors");
  for (const [action, operation, body] of [
    [
      "decision",
      "record-program-loop-decision",
      {
        runId: "run",
        attemptId: "exact",
        expectedJudgmentId: null,
        value: "unknown",
        basis: "Insufficient evidence",
      },
    ],
    ["stop", "stop-program-loop", { runId: "run", reason: "Human halt" }],
  ] as const) {
    await requestWorkbench(`/workbench-api/loop/program-loops/${action}`, {
      ...init,
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(commandWorkbench).toHaveBeenLastCalledWith({ operation, project: "project", body });
  }
});

it("routes exact candidate loop human read, stop and abandonment without host identity", async () => {
  const commandWorkbench = vi.fn().mockResolvedValue({ data: { runId: "original" } });
  vi.stubGlobal("window", { desktopBridge: { readWorkbench: vi.fn(), commandWorkbench } });
  const init = { headers: { "X-Specgraph-Project": "project" } };
  await requestWorkbench("/workbench-api/loop/candidate-loops/original", init);
  expect(commandWorkbench).toHaveBeenLastCalledWith({
    operation: "candidate-loop-read",
    project: "project",
    body: { runId: "original" },
  });
  const arm = {
    runId: "original",
    maxAttempts: 3,
    planSources: [{ kind: "specgraph", specSlug: "task", field: "test_plan", changeId: "change" }],
    terminationKind: "satisfaction",
    satisfactionCriterion: "Fixed criterion",
  };
  await requestWorkbench("/workbench-api/loop/candidate-loops/arm", {
    ...init,
    method: "POST",
    body: JSON.stringify(arm),
  });
  expect(commandWorkbench).toHaveBeenLastCalledWith({
    operation: "candidate-loop-arm",
    project: "project",
    body: arm,
  });
  for (const action of ["stop", "abandon"] as const) {
    const body = { runId: "original", reason: "Human decision" };
    await requestWorkbench(`/workbench-api/loop/candidate-loops/original/${action}`, {
      ...init,
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(commandWorkbench).toHaveBeenLastCalledWith({
      operation: `candidate-loop-${action}`,
      project: "project",
      body,
    });
  }
  await expect(
    requestWorkbench("/workbench-api/loop/candidate-loops/original/abandon", {
      ...init,
      method: "POST",
      body: JSON.stringify({ runId: "other", reason: "Wrong target" }),
    }),
  ).rejects.toThrow("Invalid candidate loop");
});

it("routes exact human satisfaction CAS, intervention resolution and bounded history", async () => {
  const commandWorkbench = vi
    .fn()
    .mockResolvedValue({ data: { runId: "original", attemptId: "attempt" } });
  vi.stubGlobal("window", { desktopBridge: { readWorkbench: vi.fn(), commandWorkbench } });
  const init = { headers: { "X-Specgraph-Project": "project" } };
  await requestWorkbench(
    "/workbench-api/loop/candidate-loops/original/satisfaction-history?attemptId=attempt&judgmentCursor=12&interventionCursor=4",
    init,
  );
  expect(commandWorkbench).toHaveBeenLastCalledWith({
    operation: "candidate-satisfaction-history",
    project: "project",
    body: {
      runId: "original",
      attemptId: "attempt",
      judgmentCursor: "12",
      interventionCursor: "4",
    },
  });
  for (const [path, operation, body] of [
    [
      "satisfaction",
      "candidate-satisfaction-record",
      {
        runId: "original",
        attemptId: "attempt",
        expectedJudgmentId: null,
        value: "unknown",
        reason: "Original facts incomplete",
      },
    ],
    [
      "intervention",
      "candidate-intervention-resolve",
      {
        runId: "original",
        attemptId: "attempt",
        interventionId: "hold",
        expectedJudgmentId: "judgment",
        expectedReportIds: ["report"],
        reason: "Aligned facts reviewed",
      },
    ],
  ] as const) {
    await requestWorkbench(`/workbench-api/loop/candidate-loops/original/${path}`, {
      ...init,
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(commandWorkbench).toHaveBeenLastCalledWith({ operation, project: "project", body });
  }
  await expect(
    requestWorkbench(
      "/workbench-api/loop/candidate-loops/original/satisfaction-history?judgmentCursor=12",
      init,
    ),
  ).rejects.toThrow("history selector");
  await expect(
    requestWorkbench("/workbench-api/loop/candidate-loops/original/satisfaction", {
      ...init,
      method: "POST",
      body: JSON.stringify({ runId: "other" }),
    }),
  ).rejects.toThrow("Invalid candidate satisfaction operation");
});

it("routes human summary reads and named writes through the existing operator bridge", async () => {
  const readWorkbench = vi.fn().mockResolvedValue({ summary: { goalSlug: "root" } });
  const commandWorkbench = vi.fn().mockResolvedValue({ data: { goalSlug: "root", id: "record" } });
  vi.stubGlobal("window", { desktopBridge: { readWorkbench, commandWorkbench } });
  const init = { headers: { "X-Specgraph-Project": "project" } };
  await requestWorkbench("/workbench-api/loop/summaries/root", init);
  expect(readWorkbench).toHaveBeenLastCalledWith({
    resource: "summary",
    project: "project",
    slug: "root",
  });
  await requestWorkbench(
    "/workbench-api/loop/summaries/root/history?kind=acceptances&cursor=42",
    init,
  );
  expect(readWorkbench).toHaveBeenLastCalledWith({
    resource: "summary-history",
    project: "project",
    slug: "root",
    query: "acceptances",
    cursor: "42",
  });
  for (const [path, operation] of [
    ["disposition", "record-summary-disposition"],
    ["accept", "accept-summary"],
    ["revoke", "revoke-summary-acceptance"],
  ] as const) {
    const body = { goalSlug: "root", idempotencyKey: "fixed" };
    await requestWorkbench(`/workbench-api/loop/summaries/${path}`, {
      ...init,
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(commandWorkbench).toHaveBeenLastCalledWith({ operation, project: "project", body });
  }
  await expect(
    requestWorkbench("/workbench-api/loop/summaries/root/history?kind=unknown", init),
  ).rejects.toThrow("Invalid summary history selector");
  await expect(
    requestWorkbench("/workbench-api/loop/summaries/root/history?", init),
  ).rejects.toThrow("Invalid summary history selector");
});

it("routes human completion-hook detail and fixed arm/cancel/retry commands without host identity in the form", async () => {
  const readWorkbench = vi.fn().mockResolvedValue({ hook: { id: "hook-original" } });
  const commandWorkbench = vi.fn().mockResolvedValue({ data: { id: "hook-original" } });
  vi.stubGlobal("window", { desktopBridge: { readWorkbench, commandWorkbench } });
  const init = { headers: { "X-Specgraph-Project": "project" } };
  await requestWorkbench("/workbench-api/loop/completion-hooks/hook-original", init);
  expect(readWorkbench).toHaveBeenLastCalledWith({
    resource: "completion-hook",
    project: "project",
    slug: "hook-original",
  });
  for (const [action, operation, body] of [
    [
      "arm",
      "arm-completion-hook",
      {
        sourceTaskSlug: "source",
        sourceSpecId: "spec-id",
        targetRunId: "program",
        targetPackageId: "package",
        idempotencyKey: "fixed",
        confirmTrigger: true,
      },
    ],
    [
      "cancel",
      "cancel-completion-hook",
      { hookId: "hook-original", reason: "No longer applicable" },
    ],
    ["retry", "retry-completion-hook", { hookId: "hook-original" }],
  ] as const) {
    await requestWorkbench(`/workbench-api/loop/completion-hooks/${action}`, {
      ...init,
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(commandWorkbench).toHaveBeenLastCalledWith({ operation, project: "project", body });
  }
});

it("routes local form operations through IPC and rejects unsupported operations without HTTP", async () => {
  const readWorkbench = vi.fn().mockResolvedValue({ identity: { subject: "operator" } });
  const commandWorkbench = vi.fn().mockResolvedValue({ data: { recorded: true } });
  const network = vi.fn();
  vi.stubGlobal("window", { desktopBridge: { readWorkbench, commandWorkbench } });
  vi.stubGlobal("fetch", network);
  const login = await requestWorkbench("/workbench-api/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ key: "synthetic-credential" }),
  });
  expect(login.status).toBe(200);
  expect(readWorkbench).toHaveBeenCalledWith({
    resource: "operator-identity",
    credential: "synthetic-credential",
  });
  for (const [url, operation, slug] of [
    ["/workbench-api/specgraph.v1.SpecService/CreateSpec", "create-node", undefined],
    ["/workbench-api/loop/specs/task/dependencies", "add-dependency", "task"],
    ["/workbench-api/loop/specs/task/dependencies/remove", "remove-dependency", "task"],
    ["/workbench-api/loop/specs/task/manual-complete", "manual-complete", "task"],
    ["/workbench-api/loop/specs/task/approve", "approve-node", "task"],
    ["/workbench-api/loop/specs/parent%2Fnested/subdivide", "subdivide-node", "parent/nested"],
    ["/workbench-api/loop/specs/task/abandon", "abandon-node", "task"],
    ["/workbench-api/loop/specs/task/assign-review", "assign-review", "task"],
    ["/workbench-api/loop/specs/task/review-source", "review-source", "task"],
    ["/workbench-api/loop/deliveries/delivery/accept", "review-delivery", "delivery"],
    ["/workbench-api/loop/deliveries/delivery/tests", "record-test-result", "delivery"],
    ["/workbench-api/node-marks/parent%2Fnested", "set-node-mark", "parent/nested"],
    ["/workbench-api/node-events/parent%2Fnested", "record-node-event", "parent/nested"],
    ["/workbench-api/loop/deliveries", "submit-delivery", undefined],
    ["/workbench-api/loop/runs", "prepare-run", undefined],
    ["/workbench-api/loop/program-runs", "prepare-program-run", undefined],
    ["/workbench-api/loop/runs/run/bind", "bind-run", "run"],
    ["/workbench-api/loop/runs/run/complete", "complete-run", "run"],
    ["/workbench-api/loop/runs/run/dispatch/authorize", "authorize-run", "run"],
    ["/workbench-api/loop/runs/run/dispatch/resolve", "resolve-run", "run"],
    ["/workbench-api/loop/runs/run/dispatch/confirm-stopped", "confirm-run-stopped", "run"],
    ["/workbench-api/loop/runs/run/dispatch/cancel-preparation", "cancel-preparation", "run"],
    ["/workbench-api/loop/preparations/abort", "abort-preparation", undefined],
  ] as const) {
    const body =
      operation === "cancel-preparation"
        ? { packageId: "package", note: "Explicit submission" }
        : { note: "Explicit submission" };
    const result = await requestWorkbench(url, {
      method: "POST",
      headers: { "X-Specgraph-Project": "project" },
      body: JSON.stringify(body),
    });
    expect(await result.json()).toEqual({ recorded: true });
    expect(commandWorkbench).toHaveBeenLastCalledWith({
      operation,
      project: "project",
      ...(slug ? { slug } : {}),
      body,
    });
  }
  const takeover = {
    mail_thread_id: "thread",
    recipient_run_id: "recipient",
    body: "Continue this work",
    idempotency_key: "takeover-key",
  };
  commandWorkbench.mockResolvedValueOnce({
    data: { thread: { id: "thread" }, event: { id: "takeover-event" } },
  });
  const takeoverReceipt = await requestWorkbench("/workbench-api/wb/mail/takeover", {
    method: "POST",
    headers: { "X-Specgraph-Project": "project" },
    body: JSON.stringify(takeover),
  });
  expect(commandWorkbench).toHaveBeenLastCalledWith({
    operation: "takeover-mail",
    project: "project",
    body: takeover,
  });
  expect(await takeoverReceipt.json()).toEqual({
    thread: { id: "thread" },
    event: { id: "takeover-event" },
  });
  await expect(
    requestWorkbench("/workbench-api/wb/mail/takeover", {
      headers: { "X-Specgraph-Project": "project" },
    }),
  ).rejects.toThrow("not enabled");
  for (const [action, operation, body] of [
    [
      "arm",
      "arm-delivery-hook",
      {
        sourceRunId: "implementation",
        targetRunId: "prepared-test",
        commitSha: "a".repeat(40),
        idempotencyKey: "human-intent",
        deliveryId: "delivery",
      },
    ],
    ["cancel", "cancel-delivery-hook", { hookId: "hook", reason: "Plan changed" }],
    ["retry", "retry-delivery-hook", { hookId: "hook" }],
  ] as const) {
    commandWorkbench.mockResolvedValueOnce({
      data: { id: "hook", configuredByRunId: null, hostConsumerUserId: "service-user" },
    });
    const result = await requestWorkbench(`/workbench-api/wb/delivery-hooks/${action}`, {
      method: "POST",
      headers: { "X-Specgraph-Project": "project" },
      body: JSON.stringify(body),
    });
    expect(commandWorkbench).toHaveBeenLastCalledWith({ operation, project: "project", body });
    expect(await result.json()).toEqual({
      id: "hook",
      configuredByRunId: null,
      hostConsumerUserId: "service-user",
    });
  }
  for (const [suffix, resource] of [
    ["context", "run-context"],
    ["dispatch", "run-dispatch"],
  ]) {
    await requestWorkbench(`/workbench-api/loop/runs/run/${suffix}`, {
      headers: { "X-Specgraph-Project": "project" },
    });
    expect(readWorkbench).toHaveBeenLastCalledWith({ resource, project: "project", slug: "run" });
  }
  await requestWorkbench("/workbench-api/loop/deliveries/delivery", {
    headers: { "X-Specgraph-Project": "project" },
  });
  expect(readWorkbench).toHaveBeenLastCalledWith({
    resource: "delivery",
    project: "project",
    slug: "delivery",
  });
  await requestWorkbench("/workbench-api/loop/deliveries/delivery/tests?cursor=12", {
    headers: { "X-Specgraph-Project": "project" },
  });
  expect(readWorkbench).toHaveBeenLastCalledWith({
    resource: "test-reports",
    project: "project",
    slug: "delivery",
    cursor: "12",
  });
  await requestWorkbench("/workbench-api/node-marks/parent%2Fnested?cursor=42", {
    headers: { "X-Specgraph-Project": "project" },
  });
  expect(readWorkbench).toHaveBeenLastCalledWith({
    resource: "node-mark-history",
    project: "project",
    slug: "parent/nested",
    cursor: "42",
  });
  await requestWorkbench("/workbench-api/node-events/parent%2Fnested?cursor=43", {
    headers: { "X-Specgraph-Project": "project" },
  });
  expect(readWorkbench).toHaveBeenLastCalledWith({
    resource: "node-events",
    project: "project",
    slug: "parent/nested",
    cursor: "43",
  });
  await requestWorkbench("/workbench-api/wb/specs/parent%2Fnested", {
    headers: { "X-Specgraph-Project": "project" },
  });
  expect(readWorkbench).toHaveBeenLastCalledWith({
    resource: "spec",
    project: "project",
    slug: "parent/nested",
  });
  await requestWorkbench("/workbench-api/loop/specs/parent%2Fnested/change-preview", {
    headers: { "X-Specgraph-Project": "project" },
  });
  expect(readWorkbench).toHaveBeenLastCalledWith({
    resource: "change-preview",
    project: "project",
    slug: "parent/nested",
  });
  await requestWorkbench("/workbench-api/loop/specs/parent%2Fnested/review-status", {
    headers: { "X-Specgraph-Project": "project" },
  });
  expect(readWorkbench).toHaveBeenLastCalledWith({
    resource: "review-status",
    project: "project",
    slug: "parent/nested",
  });
  await requestWorkbench("/workbench-api/knowledge-search?q=%E5%86%B3%E5%AE%9A%25_", {
    headers: { "X-Specgraph-Project": "project" },
  });
  expect(readWorkbench).toHaveBeenLastCalledWith({
    resource: "knowledge-search",
    project: "project",
    query: "决定%_",
  });
  for (const kind of ["spec", "decision", "change"]) {
    await requestWorkbench(`/workbench-api/knowledge/${kind}/original%2Fid`, {
      headers: { "X-Specgraph-Project": "project" },
    });
    expect(readWorkbench).toHaveBeenLastCalledWith({
      resource: `knowledge-${kind}`,
      project: "project",
      slug: "original/id",
    });
  }
  commandWorkbench.mockResolvedValueOnce({
    data: { runId: "admitted-run" },
    error: { code: "failed_precondition", message: "Already admitted" },
  });
  const abort = await requestWorkbench("/workbench-api/loop/preparations/abort", {
    method: "POST",
    headers: { "X-Specgraph-Project": "project" },
    body: "{}",
  });
  expect(abort.status).toBe(428);
  expect((await abort.json()).runId).toBe("admitted-run");
  commandWorkbench.mockResolvedValueOnce({ error: { code: "forbidden", message: "Not allowed" } });
  expect(
    (
      await requestWorkbench("/workbench-api/loop/specs/task/manual-complete", {
        method: "POST",
        headers: { "X-Specgraph-Project": "project" },
        body: "{}",
      })
    ).status,
  ).toBe(403);
  await expect(
    requestWorkbench("/workbench-api/loop/specs/task/dependencies/purge", {
      method: "POST",
      headers: { "X-Specgraph-Project": "project" },
      body: "{}",
    }),
  ).rejects.toThrow("not enabled");
  expect(network).not.toHaveBeenCalled();
});

it("routes project binding writes through the local bridge with the node slug", async () => {
  const record = {
    id: "9",
    projectSlug: "project",
    environmentId: "local",
    nativeProjectId: "native",
    workspaceRoot: "C:\\project",
    reason: "First human-reviewed dispatch: task",
    actor: "operator",
    createdAt: "2026-09-29T00:00:00Z",
    revokedAt: null,
  };
  const commandWorkbench = vi
    .fn()
    .mockResolvedValueOnce({ data: record })
    .mockResolvedValueOnce({ data: { ...record, revokedAt: "2026-09-29T01:00:00Z" } })
    .mockResolvedValueOnce({
      error: {
        code: "project_binding_mismatch",
        message: "dispatch target does not match the active project binding",
      },
    });
  vi.stubGlobal("window", { desktopBridge: { readWorkbench: vi.fn(), commandWorkbench } });
  const init = { method: "POST", headers: { "X-Specgraph-Project": "project" } };
  const bind = {
    environmentId: "local",
    nativeProjectId: "native",
    workspaceRoot: "C:\\project",
    reason: "First human-reviewed dispatch: task",
  };
  expect(
    await (
      await requestWorkbench("/workbench-api/project-binding/task", {
        ...init,
        body: JSON.stringify(bind),
      })
    ).json(),
  ).toEqual(record);
  expect(commandWorkbench).toHaveBeenLastCalledWith({
    operation: "bind-project",
    project: "project",
    slug: "task",
    body: bind,
  });
  await requestWorkbench("/workbench-api/project-binding/parent%2Fnested/revoke", {
    ...init,
    body: JSON.stringify({ reason: "Rebinding after host move" }),
  });
  expect(commandWorkbench).toHaveBeenLastCalledWith({
    operation: "unbind-project",
    project: "project",
    slug: "parent/nested",
    body: { reason: "Rebinding after host move" },
  });
  const rejected = await requestWorkbench("/workbench-api/project-binding/task", {
    ...init,
    body: JSON.stringify(bind),
  });
  expect(rejected.status).toBe(409);
  expect((await rejected.json()).code).toBe("project_binding_mismatch");
  await expect(
    requestWorkbench("/workbench-api/project-binding/task", {
      headers: { "X-Specgraph-Project": "project" },
    }),
  ).rejects.toThrow("not enabled");
  await expect(
    requestWorkbench("/workbench-api/project-binding", { ...init, body: "{}" }),
  ).rejects.toThrow("not enabled");
  expect(commandWorkbench).toHaveBeenCalledTimes(3);
});
