import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { KnowledgeSearch } from "../../../../../../project-workbench/extensions/workbench-ui/src/KnowledgeSearch";

it("reads an original result and discloses a changed source version", async () => {
  const request = vi.fn().mockResolvedValueOnce(Response.json({ query: "cache", scope: "specgraph-records", hasMore: false,
    items: [{ kind: "decision", id: "dec-1", slug: "cache-policy", title: "Cache policy", status: "accepted", version: 1, excerpt: "cache", updatedAt: "2026-09-23" }] }))
    .mockResolvedValueOnce(Response.json({ kind: "decision", id: "dec-1", slug: "cache-policy", version: 2, record: { Status: "superseded", Body: "Original decision text" } }));
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<KnowledgeSearch project="project" language="en" request={request} onOpenNode={vi.fn()} />); });
    await act(async () => renderer.root.findByType("input").props.onChange({ target: { value: "cache" } }));
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    await act(async () => renderer.root.findAllByType("button").find((button) => button.children.includes("Read source"))!.props.onClick());
    expect(request).toHaveBeenLastCalledWith("/workbench-api/knowledge/decision/cache-policy", expect.objectContaining({ headers: { "X-Specgraph-Project": "project" } }));
    expect(renderer.root.findByType("pre").children.join("")).toContain("Original decision text");
    expect(renderer.root.findAllByProps({ role: "status" }).some((node) => node.children.join("").includes("Source changed"))).toBe(true);
  } finally { await act(async () => renderer?.unmount()); }
});

it("submits one trimmed query to independent sources and retains it while editing", async () => {
  const request = vi.fn().mockResolvedValue(Response.json({ query: "cache", scope: "specgraph-records", hasMore: true, items: [] }));
  const native = vi.fn((query: string) => <p>Native query: {query}</p>);
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<KnowledgeSearch project="project" language="en" request={request} onOpenNode={vi.fn()} renderRepositorySearch={native} />); });
    expect(native).toHaveBeenLastCalledWith("", "project", "");
    await act(async () => renderer.root.findByType("input").props.onChange({ target: { value: "  cache  " } }));
    expect(native).toHaveBeenLastCalledWith("", "project", "  cache  ");
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(request).toHaveBeenCalledWith("/workbench-api/knowledge-search?q=cache", expect.any(Object));
    expect(native).toHaveBeenLastCalledWith("cache", "project", "  cache  ");
    expect(renderer.root.findAllByProps({ role: "status" }).some((node) => node.children.join("").includes("+"))).toBe(true);
    await act(async () => renderer.root.findByType("input").props.onChange({ target: { value: "different" } }));
    expect(native).toHaveBeenLastCalledWith("cache", "project", "different");
  } finally { await act(async () => renderer?.unmount()); }
});

it("keeps native search available when SpecGraph fails or is unavailable", async () => {
  const request = vi.fn().mockResolvedValue(Response.json({}, { status: 503 }));
  const native = vi.fn((query: string) => <p>Native query: {query}</p>);
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<KnowledgeSearch project="project" language="en" request={request} onOpenNode={vi.fn()} renderRepositorySearch={native} />); });
    await act(async () => renderer.root.findByType("input").props.onChange({ target: { value: "cache" } }));
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain("503");
    expect(native).toHaveBeenLastCalledWith("cache", "project", "cache");
    await act(async () => renderer.update(<KnowledgeSearch project="project" language="en" onOpenNode={vi.fn()} renderRepositorySearch={native} />));
    expect(renderer.root.findAllByProps({ role: "status" }).some((node) => node.children.join("").includes("unavailable"))).toBe(true);
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(native).toHaveBeenLastCalledWith("cache", "project", "cache");
  } finally { await act(async () => renderer?.unmount()); }
});

it("keeps the submitted query and native results visible through SpecGraph sign-in", async () => {
  const request = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ ok: true }))
    .mockResolvedValueOnce(Response.json({ query: "cache", scope: "specgraph-records", hasMore: false, items: [] }));
  const native = vi.fn((query: string) => <p>Native query: {query}</p>);
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<KnowledgeSearch project="project" language="en" request={request} onOpenNode={vi.fn()} renderRepositorySearch={native} />); });
    await act(async () => renderer.root.findByType("input").props.onChange({ target: { value: "cache" } }));
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(native).toHaveBeenLastCalledWith("cache", "project", "cache");
    expect(renderer.root.findAllByProps({ role: "status" }).some((node) => node.children.join("").includes("requires sign-in"))).toBe(true);
    expect(renderer.root.findAllByType("input")[0]!.props.value).toBe("cache");
    await act(async () => renderer.root.findAllByType("input")[0]!.props.onChange({ target: { value: "new query" } }));
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(native).toHaveBeenLastCalledWith("new query", "project", "new query");
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => renderer.root.findAllByType("input")[1]!.props.onChange({ target: { value: "credential" } }));
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(request).toHaveBeenNthCalledWith(2, "/workbench-api/api/auth/login", expect.objectContaining({ method: "POST" }));
    expect(request).toHaveBeenLastCalledWith("/workbench-api/knowledge-search?q=new%20query", expect.any(Object));
    expect(native).toHaveBeenLastCalledWith("new query", "project", "new query");
  } finally { await act(async () => renderer?.unmount()); }
});
