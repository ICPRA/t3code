import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ search: vi.fn(), file: vi.fn(), conversation: vi.fn() }));
vi.mock("~/state/entities", () => ({ useProjects: () => [
  { id: "native", environmentId: "local", title: "Native project", workspaceRoot: "C:/repo" },
  { id: "other", environmentId: "remote", title: "Other project", workspaceRoot: "D:/other" },
] }));
vi.mock("~/state/queries", () => ({ useProjectContentSearch: mocks.search }));
vi.mock("~/components/files/projectFilesQueryState", () => ({ useProjectFileQuery: mocks.file }));
vi.mock("~/i18n/i18n", () => ({ useI18n: () => ({ language: "en" }) }));
vi.mock("./WorkbenchConversationSearch", () => ({ WorkbenchConversationSearch: (props: unknown) => { mocks.conversation(props); return null; } }));
import { WorkbenchRepositorySearch } from "./WorkbenchRepositorySearch";

afterEach(() => vi.clearAllMocks());

it("searches only the explicitly selected native workspace and reads the matched file", async () => {
  mocks.search.mockReturnValue({ matches: [{ path: "src/cache.ts", lineNumber: 2, lineContent: "cache", matchRanges: [] }], hasQuery: true, isPending: false, truncated: false, error: null });
  mocks.file.mockReturnValue({ data: { contents: "first\ncache", truncated: false }, error: null, isPending: false, refresh: vi.fn() });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<WorkbenchRepositorySearch query="cache" question="" specgraphProject="sg" />); });
    expect(mocks.search).not.toHaveBeenCalled();
    await act(async () => renderer.root.findByType("select").props.onChange({ target: { value: "local:native" } }));
    expect(mocks.search).toHaveBeenLastCalledWith({ environmentId: "local", cwd: "C:/repo", query: "cache", caseSensitive: false, wholeWord: false, useRegex: false });
    expect(mocks.conversation).toHaveBeenLastCalledWith(expect.objectContaining({ query: "cache", project: expect.objectContaining({ id: "native" }) }));
    await act(async () => renderer.root.findAllByType("button").find((button) => button.children.join("") === "src/cache.ts:2")!.props.onClick());
    expect(mocks.file).toHaveBeenLastCalledWith("local", "C:/repo", "src/cache.ts");
    expect(renderer.root.findAllByType("pre").length).toBe(2);
    await act(async () => renderer.root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }));
    await act(async () => (mocks.conversation.mock.lastCall![0] as { onIncludeArchivedChange: (value: boolean) => void }).onIncludeArchivedChange(false));
    await act(async () => renderer.root.findByType("select").props.onChange({ target: { value: "remote:other" } }));
    expect(mocks.search).toHaveBeenLastCalledWith({ environmentId: "remote", cwd: "D:/other", query: "cache", caseSensitive: true, wholeWord: false, useRegex: false });
    expect(renderer.root.findAllByType("pre")).toHaveLength(1);
    await act(async () => renderer.update(<WorkbenchRepositorySearch query="new term" question="" specgraphProject="sg" />));
    expect(mocks.search).toHaveBeenLastCalledWith({ environmentId: "remote", cwd: "D:/other", query: "new term", caseSensitive: true, wholeWord: false, useRegex: false });
    expect(mocks.conversation).toHaveBeenLastCalledWith(expect.objectContaining({ query: "new term", includeArchived: false, project: expect.objectContaining({ id: "other" }) }));
    expect(renderer.root.findAllByType("pre")).toHaveLength(1);
    mocks.search.mockReturnValue({ matches: [], hasQuery: true, isPending: false, truncated: true, error: null });
    await act(async () => renderer.update(<WorkbenchRepositorySearch query="new term" question="" specgraphProject="sg" />));
    expect(renderer.root.findAllByType("p").some((entry) => entry.children.join("").includes("Native search limit reached"))).toBe(true);
    mocks.search.mockReturnValue({ matches: [], hasQuery: true, isPending: false, truncated: false, error: "File search unavailable" });
    await act(async () => renderer.update(<WorkbenchRepositorySearch query="new term" question="" specgraphProject="sg" />));
    expect(renderer.root.findByProps({ role: "alert" }).children).toEqual(["File search unavailable"]);
  } finally { await act(async () => renderer?.unmount()); }
});

it("opens the fixed knowledge directory, follows source links and exposes missing files without creating them", async () => {
  mocks.search.mockReturnValue({ matches: [], hasQuery: false, isPending: false, truncated: false, error: null });
  const directory = "# Knowledge\n\n[Cache](decisions/cache.md#L2)\n\n[Missing](missing.md)\n\n![Remote image](https://example.com/image.png)\n\n<script>not executable</script>";
  mocks.file.mockImplementation((_environmentId, _cwd, path) => ({
    data: path === "docs/knowledge/README.md" ? { contents: directory, truncated: false }
      : path === "docs/knowledge/decisions/cache.md" ? { contents: "# Cache\n\n[Contract](../contracts.md)", truncated: false }
      : path === "docs/knowledge/decisions/../contracts.md" ? { contents: "# Contract", truncated: false } : null,
    error: path === "docs/knowledge/missing.md" ? "File not found: docs/knowledge/missing.md" : null,
    isPending: false, refresh: vi.fn(),
  }));
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<WorkbenchRepositorySearch query="" question="" specgraphProject="sg" />); });
    expect(mocks.file).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType("button")).toHaveLength(1);
    expect(renderer.root.findByType("button").props.disabled).toBe(true);
    await act(async () => renderer.root.findByType("select").props.onChange({ target: { value: "local:native" } }));
    expect(renderer.root.findAllByType("button").find((button) => button.children.includes("Ask in conversation"))!.props.disabled).toBe(true);
    await act(async () => renderer.root.findAllByType("button").find((button) => button.children.includes("Knowledge directory"))!.props.onClick());
    expect(mocks.file).toHaveBeenLastCalledWith("local", "C:/repo", "docs/knowledge/README.md");
    expect(renderer.root.findByType("h1").children).toEqual(["Knowledge"]);
    expect(renderer.root.findAllByType("script")).toHaveLength(0);
    expect(renderer.root.findAllByType("img")).toHaveLength(0);
    await act(async () => renderer.root.findAllByType("button").find((button) => button.children.includes("Source"))!.props.onClick());
    expect(renderer.root.findByType("pre")).toBeDefined();
    await act(async () => renderer.root.findAllByType("button").find((button) => button.children.includes("Preview"))!.props.onClick());
    const preventDefault = vi.fn();
    await act(async () => renderer.root.findAllByType("a").find((link) => link.props.href === "decisions/cache.md#L2")!.props.onClick({ preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(mocks.file).toHaveBeenLastCalledWith("local", "C:/repo", "docs/knowledge/decisions/cache.md");
    expect(renderer.root.findAllByType("button").find((button) => button.children.includes("Source"))!.props["aria-pressed"]).toBe(true);
    await act(async () => renderer.root.findAllByType("button").find((button) => button.children.includes("Preview"))!.props.onClick());
    await act(async () => renderer.root.findAllByType("a").find((link) => link.props.href === "../contracts.md")!.props.onClick({ preventDefault }));
    expect(mocks.file).toHaveBeenLastCalledWith("local", "C:/repo", "docs/knowledge/decisions/../contracts.md");
    await act(async () => renderer.root.findAllByType("button").find((button) => button.children.includes("Knowledge directory"))!.props.onClick());
    await act(async () => renderer.root.findAllByType("a").find((link) => link.props.href === "missing.md")!.props.onClick({ preventDefault }));
    expect(renderer.root.findByProps({ role: "alert" }).children).toEqual(["File not found: docs/knowledge/missing.md"]);
    mocks.file.mockReturnValue({ data: null, error: "File not found: docs/knowledge/README.md", isPending: false, refresh: vi.fn() });
    await act(async () => renderer.root.findAllByType("button").find((button) => button.children.includes("Knowledge directory"))!.props.onClick());
    expect(renderer.root.findByProps({ role: "alert" }).children).toEqual(["File not found: docs/knowledge/README.md"]);
  } finally { await act(async () => renderer?.unmount()); }
});
