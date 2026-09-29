import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { SummaryPanel } from "../../../../../../project-workbench/extensions/workbench-ui/src/SummaryPanel";

const references = { nodes: [{ id: "root-id", slug: "root", role: "summary", sourceRefs: { intent: "change-root" }, lifecycleChangeId: "life-root" }], relations: [], dispositionIds: [], decisionSources: [] };
const base = { goalSlug: "root", acceptable: false, accepted: false,
  blockers: [{ slug: "child", code: "work_not_done" }], obligations: [{ slug: "root", role: "summary", stage: "approved", disposition: "retain", effective: true, pendingReview: false },
    { slug: "child", role: "work", stage: "in_progress", disposition: "retain", effective: true, pendingReview: false }],
  latestAcceptance: null, dispositions: [], references, changedSources: [], scopeChanged: false, reviewCandidates: [] };
let renderer: ReactTestRenderer | undefined;
function content(node: ReactTestInstance | string = renderer!.root): string { return typeof node === "string" ? node : node.children.map(content).join(""); }
function button(label: string) { return renderer!.root.findAllByType("button").find((entry) => content(entry) === label)!; }
async function mount(request: (url: string, init?: RequestInit) => Promise<Response>) { await act(async () => { renderer = create(<SummaryPanel project="project" goalSlug="root" language="en" request={request} onChanged={() => {}} />); }); }
async function read() { await act(async () => button("Read current summary and history").props.onClick()); }
const emptyHistory = (kind: string) => ({ history: { goalSlug: "root", kind, [kind]: [], hasMore: false, nextCursor: "" } });
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => { await act(async () => renderer?.unmount()); vi.unstubAllGlobals(); });

it("reads the exact root and keeps unfinished obligations from being accepted", async () => {
  let fail = false;
  const request = vi.fn(async (url: string) => fail ? Response.json({ code: "forbidden" }, { status: 403 })
    : Response.json(url.includes("history") ? emptyHistory(new URLSearchParams(url.split("?")[1]).get("kind")!) : { summary: base }));
  await mount(request); await read();
  expect(content()).toContain("child · in_progress · retain · effective obligation");
  expect(content()).toContain("work_not_done");
  expect(button("Accept current summary").props.disabled).toBe(true);
  expect(request.mock.calls.every(([url]) => url.includes("/summaries/root"))).toBe(true);
  fail = true; await read();
  expect(content()).toContain("Original summary read failed");
  expect(renderer!.root.findAllByProps({ "aria-label": "Accept summary" })).toHaveLength(0);
});

it("freezes an uncertain disposition on its original key and reconciles from history without another write", async () => {
  let posted: Record<string, unknown> | null = null;
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posted = JSON.parse(String(init.body)); throw new Error("receipt lost"); }
    if (url.includes("history")) {
      const kind = new URLSearchParams(url.split("?")[1]).get("kind")!;
      return Response.json(kind === "dispositions" && posted ? { history: { goalSlug: "root", kind, dispositions: [{ ...posted, id: "disposition-1", actorKind: "human", actorUserId: "operator", createdAt: "now" }], hasMore: false, nextCursor: "" } } : emptyHistory(kind));
    }
    return Response.json({ summary: base });
  });
  await mount(request); await read();
  await act(async () => renderer!.root.findByProps({ "aria-label": "Summary affected node" }).props.onChange({ target: { value: "child" } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Summary disposition reason" }).props.onChange({ target: { value: "Needs source review" } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Record summary disposition" }).props.onSubmit({ preventDefault() {} }));
  expect(posted).toMatchObject({ goalSlug: "root", affectedSlug: "child", disposition: "needs_review", reason: "Needs source review" });
  expect(posted).toHaveProperty("idempotencyKey");
  expect(content()).toContain("Original request remains frozen");
  await read();
  expect(content()).toContain("Matching original record observed; actual recorder: operator");
  expect(content()).not.toContain("Original request remains frozen");
  expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("does not treat a truncated history without its cursor as a complete read", async () => {
  const request = vi.fn(async (url: string) => {
    if (!url.includes("history")) return Response.json({ summary: base });
    const kind = new URLSearchParams(url.split("?")[1]).get("kind")!;
    return Response.json({ history: { goalSlug: "root", kind, [kind]: [], hasMore: true, nextCursor: "" } });
  });
  await mount(request); await read();
  expect(content()).toContain("Summary history scope or response mismatch");
  expect(renderer!.root.findAllByProps({ "aria-label": "Accept summary" })).toHaveLength(0);
});

it("accepts only explicit evidence and impact review against the exact read references", async () => {
  const ready = { ...base, acceptable: true, blockers: [], reviewCandidates: ["child"], obligations: base.obligations.map((item) => ({ ...item, stage: "done" })) };
  let posted: Record<string, unknown> | null = null;
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted = JSON.parse(String(init.body));
      const { nodes, relations, dispositionIds, decisionSources } = references;
      const evidenceSources = (posted!.evidenceSources as Array<Record<string, unknown>>).map(({ entry: _entry, ...source }) => source);
      return Response.json({ ...posted, evidenceSources, expectedReferences: { decisionSources, dispositionIds, relations, nodes }, id: "accept-1", actorKind: "human", actorUserId: "operator", createdAt: "now", revokedAt: null, revokedByUserId: null, revokedByRunId: null, revocationReason: null, current: true });
    }
    return Response.json(url.includes("history") ? emptyHistory(new URLSearchParams(url.split("?")[1]).get("kind")!) : { summary: ready });
  });
  await mount(request); await read();
  expect(button("Accept current summary").props.disabled).toBe(true);
  await act(async () => renderer!.root.findByProps({ "aria-label": "Summary acceptance basis" }).props.onChange({ target: { value: "Fixed delivery and source evidence" } }));
  const evidence = renderer!.root.findAllByType("fieldset").find((item) => content(item).includes("Evidence sources"))!;
  await act(async () => evidence.findAllByType("button").find((item) => content(item) === "Add source")!.props.onClick());
  await act(async () => renderer!.root.findByProps({ "aria-label": "Summary evidence source 1 kind" }).props.onChange({ target: { value: "git" } }));
  for (const [field, value] of [["environmentId", "local"], ["repositoryRoot", "C:/repo"], ["commitSha", "a".repeat(40)], ["path", "evidence.md"], ["entry", ""]] as const) {
    await act(async () => renderer!.root.findByProps({ "aria-label": `Summary evidence source 1 ${field}` }).props.onChange({ target: { value } }));
  }
  await act(async () => renderer!.root.findByProps({ "aria-label": "Summary impact basis child" }).props.onChange({ target: { value: "Child result remains applicable" } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Confirm summary goals satisfied" }).props.onChange({ target: { checked: true } }));
  expect(button("Accept current summary").props.disabled).toBe(false);
  await act(async () => renderer!.root.findByProps({ "aria-label": "Accept summary" }).props.onSubmit({ preventDefault() {} }));
  expect(posted).toMatchObject({ goalSlug: "root", goalsSatisfied: true, expectedReferences: references, impactReview: [{ slug: "child", basis: "Child result remains applicable" }] });
  expect(content()).toContain("Recorded; actual recorder: operator");
  expect(renderer!.root.findAllByProps({ "aria-label": "Accept summary" })).toHaveLength(0);
});

it("cancels revocation without writing and credits the actual human revoker of a PM acceptance", async () => {
  const acceptance = { id: "accept-1", goalSlug: "root", basis: "PM basis", evidenceSources: [{ kind: "specgraph", specSlug: "root", field: "intent", changeId: "change-root" }], goalsSatisfied: true,
    idempotencyKey: "original-key", expectedReferences: references, impactReview: [], actorKind: "agent", actorUserId: "pm-account", createdAt: "before",
    revokedAt: null, revokedByUserId: null, revokedByRunId: null, revocationReason: null, current: true };
  const ready = { ...base, acceptable: true, accepted: true, blockers: [], latestAcceptance: acceptance };
  const request = vi.fn(async (url: string, init?: RequestInit) => init?.method === "POST"
    ? Response.json({ ...acceptance, revokedAt: "now", revokedByUserId: "human-revoker", revokedByRunId: null, revocationReason: "Original acceptance no longer applies", current: false })
    : Response.json(url.includes("history") ? emptyHistory(new URLSearchParams(url.split("?")[1]).get("kind")!) : { summary: ready }));
  await mount(request); await read();
  await act(async () => renderer!.root.findByProps({ "aria-label": "Summary revocation reason" }).props.onChange({ target: { value: "Original acceptance no longer applies" } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Confirm summary revocation" }).props.onChange({ target: { checked: true } }));
  await act(async () => button("Cancel").props.onClick());
  expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  await act(async () => renderer!.root.findByProps({ "aria-label": "Confirm summary revocation" }).props.onChange({ target: { checked: true } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Revoke summary acceptance" }).props.onSubmit({ preventDefault() {} }));
  expect(JSON.parse(String(request.mock.calls.find(([, init]) => init?.method === "POST")![1]!.body))).toEqual({ acceptanceId: "accept-1", reason: "Original acceptance no longer applies" });
  expect(content()).toContain("Recorded; actual recorder: human-revoker");
  expect(content()).not.toContain("Recorded; actual recorder: pm-account");
});

it("re-reads an unrevoked original acceptance before explicitly retrying the same lost revoke request", async () => {
  const acceptance = { id: "accept-1", goalSlug: "root", basis: "PM basis", evidenceSources: [], goalsSatisfied: true, idempotencyKey: "pm-key",
    expectedReferences: references, impactReview: [], actorKind: "agent", actorUserId: "pm-account", createdAt: "before",
    revokedAt: null, revokedByUserId: null, revokedByRunId: null, revocationReason: null, current: true };
  const ready = { ...base, acceptable: true, accepted: true, blockers: [], latestAcceptance: acceptance };
  let attempts = 0;
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      attempts++;
      if (attempts === 1) throw new Error("receipt lost");
      return Response.json({ ...acceptance, revokedAt: "now", revokedByUserId: "human-revoker", revokedByRunId: null, revocationReason: "Withdraw current basis", current: false });
    }
    if (url.includes("history")) {
      const kind = new URLSearchParams(url.split("?")[1]).get("kind")!;
      return Response.json(kind === "acceptances" ? { history: { goalSlug: "root", kind, acceptances: [acceptance], hasMore: false, nextCursor: "" } } : emptyHistory(kind));
    }
    return Response.json({ summary: ready });
  });
  await mount(request); await read();
  await act(async () => renderer!.root.findByProps({ "aria-label": "Summary revocation reason" }).props.onChange({ target: { value: "Withdraw current basis" } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Confirm summary revocation" }).props.onChange({ target: { checked: true } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Revoke summary acceptance" }).props.onSubmit({ preventDefault() {} }));
  const original = JSON.parse(String(request.mock.calls.find(([, init]) => init?.method === "POST")![1]!.body));
  expect(content()).toContain("Original request remains frozen");
  await read();
  expect(button("Explicitly retry original request")).toBeDefined();
  expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  await act(async () => button("Explicitly retry original request").props.onClick());
  expect(JSON.parse(String(request.mock.calls.filter(([, init]) => init?.method === "POST")[1]![1]!.body))).toEqual(original);
  expect(content()).toContain("Recorded; actual recorder: human-revoker");
});

it("treats a definitive stale 409 as rejected and requires a new read and confirmation for new refs", async () => {
  const changed = { ...references, nodes: [{ ...references.nodes[0]!, sourceRefs: { intent: "change-new" } }] };
  const requests: Array<Record<string, unknown>> = [];
  let stale = false;
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      requests.push(body);
      if (!stale) { stale = true; return Response.json({ code: "conflict" }, { status: 409 }); }
      return Response.json({ ...body, id: "accept-new", actorKind: "human", actorUserId: "operator", createdAt: "now",
        revokedAt: null, revokedByUserId: null, revokedByRunId: null, revocationReason: null, current: true });
    }
    return Response.json(url.includes("history") ? emptyHistory(new URLSearchParams(url.split("?")[1]).get("kind")!)
      : { summary: { ...base, acceptable: true, blockers: [], reviewCandidates: [], references: stale ? changed : references } });
  });
  await mount(request); await read();
  await act(async () => renderer!.root.findByProps({ "aria-label": "Summary acceptance basis" }).props.onChange({ target: { value: "Reviewed fixed evidence" } }));
  const evidence = renderer!.root.findAllByType("fieldset").find((item) => content(item).includes("Evidence sources"))!;
  await act(async () => evidence.findAllByType("button").find((item) => content(item) === "Add source")!.props.onClick());
  await act(async () => renderer!.root.findByProps({ "aria-label": "Summary evidence source 1 field" }).props.onChange({ target: { value: "intent" } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Summary evidence source 1 changeId" }).props.onChange({ target: { value: "change-root" } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Confirm summary goals satisfied" }).props.onChange({ target: { checked: true } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Accept summary" }).props.onSubmit({ preventDefault() {} }));
  expect(content()).toContain("HTTP 409");
  expect(content()).not.toContain("Original request remains frozen");
  expect(renderer!.root.findAllByProps({ "aria-label": "Accept summary" })).toHaveLength(0);
  await read();
  expect(button("Accept current summary").props.disabled).toBe(true);
  expect(renderer!.root.findByProps({ "aria-label": "Confirm summary goals satisfied" }).props.checked).toBe(false);
  await act(async () => renderer!.root.findByProps({ "aria-label": "Confirm summary goals satisfied" }).props.onChange({ target: { checked: true } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Accept summary" }).props.onSubmit({ preventDefault() {} }));
  expect(requests).toHaveLength(2);
  expect(requests[0]!.expectedReferences).toEqual(references);
  expect(requests[1]!.expectedReferences).toEqual(changed);
  expect(requests[1]!.idempotencyKey).not.toBe(requests[0]!.idempotencyKey);
});
