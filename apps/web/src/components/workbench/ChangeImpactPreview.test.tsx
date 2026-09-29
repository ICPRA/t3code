import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ChangeImpactPreview } from "../../../../../../project-workbench/extensions/workbench-ui/src/ChangeImpactPreview";

let renderer: ReactTestRenderer | undefined;
const fetcher = vi.fn();
beforeEach(() => { fetcher.mockReset(); vi.stubGlobal("fetch", fetcher); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => { await act(async () => renderer?.unmount()); vi.unstubAllGlobals(); });

it("reads real structural candidates and shared goals without changing nodes", async () => {
  fetcher.mockResolvedValueOnce(Response.json({ specSlug: "a", scope: { sources: [], relations: [], decisions: [] }, relations: [{ from: "b", to: "shared", type: "COMPOSES" }], nodes: [
    { id: "a", slug: "a", intent: "Goal A", stage: "approved", role: "summary", version: 2, scopeRevision: "3", parentSlugs: [] },
    { id: "shared", slug: "shared", intent: "Shared work", stage: "in_progress", role: "work", version: 4, scopeRevision: "5", parentSlugs: ["a", "b"] },
  ] }));
  const select = vi.fn();
  await act(async () => { renderer = create(<ChangeImpactPreview project="p" slug="a" language="en" onSelect={select} />); });
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => renderer!.root.findAllByType("button")[0]!.props.onClick());
  expect(fetcher).toHaveBeenCalledWith("/workbench-api/loop/specs/a/change-preview", expect.objectContaining({ headers: { "X-Specgraph-Project": "p" }, cache: "no-store" }));
  expect(fetcher.mock.calls[0]![1].method).toBeUndefined();
  expect(JSON.stringify(renderer!.toJSON())).toContain("not withdrawal decisions");
  expect(JSON.stringify(renderer!.toJSON())).toContain("a, b");
  await act(async () => renderer!.root.findAllByType("button").find((button) => button.children.includes("Shared work"))!.props.onClick());
  expect(select).toHaveBeenCalledWith("shared");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls.every((call) => call[1].method === undefined)).toBe(true);
});

it("does not turn a denied or mismatched response into an empty successful preview", async () => {
  fetcher.mockResolvedValueOnce(Response.json({}, { status: 403 })).mockResolvedValueOnce(Response.json({ specSlug: "other", nodes: [], relations: [], scope: {} }));
  await act(async () => { renderer = create(<ChangeImpactPreview project="p" slug="a" language="en" onSelect={() => {}} />); });
  await act(async () => renderer!.root.findByType("button").props.onClick());
  expect(JSON.stringify(renderer!.toJSON())).toContain("cannot read these sources");
  await act(async () => renderer!.root.findByType("button").props.onClick());
  expect(JSON.stringify(renderer!.toJSON())).toContain("Invalid change preview response");
  expect(renderer!.root.findAllByType("ul")).toHaveLength(0);
});

it("uses the injected local reader without a network request", async () => {
  const request = vi.fn(async () => Response.json({ specSlug: "a", scope: { sources: [], relations: [], decisions: [] }, relations: [], nodes: [
    { id: "a", slug: "a", intent: "Goal A", stage: "approved", role: "summary", version: 2, scopeRevision: "3", parentSlugs: [] },
  ] }));
  await act(async () => { renderer = create(<ChangeImpactPreview project="p" slug="a" language="en" request={request} onSelect={() => {}} />); });
  await act(async () => renderer!.root.findByType("button").props.onClick());
  expect(request).toHaveBeenCalledWith("/workbench-api/loop/specs/a/change-preview", expect.objectContaining({ headers: { "X-Specgraph-Project": "p" } }));
  expect(fetcher).not.toHaveBeenCalled();
});
