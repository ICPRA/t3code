import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { MergePanel } from "../../../../../../project-workbench/extensions/workbench-ui/src/MergePanel";

const preview = { sources: [{ id: "a-id", slug: "a", version: 2, stage: "done", role: "work" },
  { id: "b-id", slug: "b", version: 3, stage: "review", role: "work" }], contexts: [],
  relations: [{ fromSlug: "a", toSlug: "outside", type: "BLOCKS", changeId: "edge-1" }], lineage: [], ancestors: [] };
const specs = [{ slug: "a", title: "A", stage: "done", role: "work" as const }, { slug: "b", title: "B", stage: "review", role: "work" as const },
  { slug: "p", title: "Prerequisite", stage: "approved", role: "work" as const }];
let renderer: ReactTestRenderer | undefined;
let storage: Map<string, string>;
const content = (node: ReactTestInstance | string = renderer!.root): string => typeof node === "string" ? node : node.children.map(content).join("");
const button = (label: string) => renderer!.root.findAllByType("button").find((node) => content(node) === label)!;
const label = (prefix: string) => renderer!.root.findAllByType("label").find((node) => content(node).startsWith(prefix))!;
async function input(prefix: string, value: string) {
  const field = label(prefix).findAll((node) => node.type === "input" || node.type === "textarea")[0]!;
  await act(async () => field.props.onChange({ target: { value } }));
}
async function mount(request: (url: string, init?: RequestInit) => Promise<Response>, anchor = "a") {
  await act(async () => { renderer = create(<MergePanel project="project" anchor={anchor} specs={specs} language="en" request={request} onChanged={() => {}} />); });
  await act(async () => button("Node merge and lineage").props.onClick());
}
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => { await act(async () => renderer?.unmount()); vi.unstubAllGlobals(); });

it("keeps an incomplete local proposal without creating C and requires a fresh preview after restore", async () => {
  const request = vi.fn(async () => { throw new Error("No request expected"); });
  await mount(request);
  await input("Identifier", "c"); await input("Goal", "Combined goal");
  await act(async () => button("Save local proposal").props.onClick());
  expect(storage.has("workbench.node-merge-proposal.v1")).toBe(true);
  expect(request).not.toHaveBeenCalled();
  await act(async () => renderer?.unmount());
  await mount(request);
  await act(async () => button("Restore").props.onClick());
  expect(content()).toContain("Proposal restored; reread sources and relations");
  expect(button("Commit formal merge once").props.disabled).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

it("submits only a reviewed complete baseline and reconciles a lost receipt without a second write", async () => {
  let original: Record<string, unknown> | null = null;
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/preview")) return Response.json(preview);
    if (url.endsWith("/wb/specs/a")) return Response.json({ spec: { slug: "a", version: 2, intent: "A" } });
    if (url.endsWith("/wb/specs/b")) return Response.json({ spec: { slug: "b", version: 3, intent: "B" } });
    if (url.endsWith("/history")) return Response.json({ items: original ? [{ id: "receipt", idempotencyKey: original.idempotencyKey }] : [], hasMore: false, nextCursor: "" });
    if (url.endsWith("/receipt")) return Response.json({ id: "receipt", idempotencyKey: original!.idempotencyKey, request: original,
      actorUserId: "human", target: { slug: "c" }, sources: [], createdAt: "now" });
    if (url.endsWith("/node-merges")) { original = JSON.parse(String(init?.body)); throw new Error("receipt lost"); }
    throw new Error(url);
  });
  await mount(request);
  const b = label("b · B").findByType("input");
  await act(async () => b.props.onChange({ target: { checked: true } }));
  await act(async () => button("Read source and relation baseline").props.onClick());
  expect(button("Commit formal merge once").props.disabled).toBe(true);
  await input("Identifier", "c"); await input("Goal", "Combined goal"); await input("Merge reason", "Reviewed sources");
  const choice = renderer!.root.findByProps({ "aria-label": "Relation decision 0" });
  await act(async () => choice.props.onChange({ target: { value: "retain" } }));
  const confirm = label("I reviewed current sources").findByType("input");
  await act(async () => confirm.props.onChange({ target: { checked: true } }));
  expect(button("Commit formal merge once").props.disabled).toBe(false);
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(original).toMatchObject({ target: { slug: "c" }, relations: [{ action: "retain", before: preview.relations[0] }] });
  expect(storage.has("workbench.pending-node-merge.v1")).toBe(true);
  await act(async () => renderer?.unmount());
  await mount(request, "b");
  expect(button("Commit formal merge once").props.disabled).toBe(true);
  await act(async () => button("Read original receipt/history").props.onClick());
  expect(storage.has("workbench.pending-node-merge.v1")).toBe(false);
  expect(content()).toContain("Original merge observed");
  expect(request.mock.calls.filter(([url]) => url.endsWith("/node-merges"))).toHaveLength(1);
});

it("requires a new preview for an external spec endpoint before confirmation", async () => {
  const previews: Array<Record<string, unknown>> = [];
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/preview")) {
      const body = JSON.parse(String(init?.body)); previews.push(body);
      return Response.json({ ...preview, contexts: body.contextSlugs?.includes("p") ? [{ id: "p-id", slug: "p", version: 4, stage: "approved", role: "work" }] : [] });
    }
    if (url.includes("/wb/specs/")) {
      const slug = url.split("/").at(-1)!;
      return Response.json({ spec: { slug, version: slug === "a" ? 2 : slug === "b" ? 3 : 4, intent: slug } });
    }
    throw new Error(url);
  });
  await mount(request);
  await act(async () => label("b · B").findByType("input").props.onChange({ target: { checked: true } }));
  await act(async () => button("Read source and relation baseline").props.onClick());
  await input("Identifier", "c");
  await act(async () => button("Add relation").props.onClick());
  await act(async () => renderer!.root.findByProps({ "aria-label": "Added 0 fromSlug" }).props.onChange({ target: { value: "p" } }));
  await act(async () => renderer!.root.findByProps({ "aria-label": "Added 0 toSlug" }).props.onChange({ target: { value: "c" } }));
  expect(content()).toContain("External endpoints changed");
  await act(async () => button("Read source and relation baseline").props.onClick());
  expect(previews.at(-1)).toEqual({ sourceSlugs: ["a", "b"], contextSlugs: ["p"] });
  expect(content()).not.toContain("External endpoints changed");
  expect(content()).toContain("p · v4");
});
