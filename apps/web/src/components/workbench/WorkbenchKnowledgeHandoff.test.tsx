import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  open: vi.fn(), getDraft: vi.fn(), setPrompt: vi.fn(), search: vi.fn(), file: vi.fn(), toast: vi.fn(),
}));
vi.mock("~/state/entities", () => ({ useProjects: () => [
  { id: "native", environmentId: "local", title: "Native project", workspaceRoot: "C:/repo" },
  { id: "other", environmentId: "remote", title: "Other project", workspaceRoot: "D:/other" },
] }));
vi.mock("~/state/queries", () => ({ useProjectContentSearch: mocks.search }));
vi.mock("~/components/files/projectFilesQueryState", () => ({ useProjectFileQuery: mocks.file }));
vi.mock("~/i18n/i18n", () => ({ useI18n: () => ({ language: "en" }) }));
vi.mock("./WorkbenchConversationSearch", () => ({ WorkbenchConversationSearch: () => null }));
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => mocks.open }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: { getState: () => ({ getComposerDraft: mocks.getDraft, setPrompt: mocks.setPrompt }) },
  composerDraftHasUserContent: (draft: { prompt: string } | null) => Boolean(draft?.prompt.trim()),
}));
import { WorkbenchRepositorySearch } from "./WorkbenchRepositorySearch";

afterEach(() => vi.clearAllMocks());

it("only an explicit ask opens the selected native project and writes the returned draft", async () => {
  mocks.search.mockReturnValue({ matches: [], hasQuery: false, isPending: false, truncated: false, error: null });
  mocks.file.mockReturnValue({ data: null, error: null, isPending: false, refresh: vi.fn() });
  mocks.getDraft.mockReturnValue(null);
  let finish!: (value: { draftId: string }) => void;
  mocks.open.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<WorkbenchRepositorySearch query="old search" question="  Why did cache fail?  " specgraphProject="sg-project" />); });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
    const ask = () => renderer.root.findAllByType("button").find((button) => button.children.includes("Ask in conversation"))!;
    expect(ask().props.disabled).toBe(true);
    await act(async () => renderer.root.findByType("select").props.onChange({ target: { value: "remote:other" } }));
    expect(mocks.search).toHaveBeenLastCalledWith(expect.objectContaining({ query: "old search", cwd: "D:/other" }));
    await act(async () => { ask().props.onClick(); ask().props.onClick(); });
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith({ environmentId: "remote", projectId: "other" }, { envMode: "local", worktreePath: null, branch: null });
    expect(mocks.setPrompt).not.toHaveBeenCalled();
    await act(async () => finish({ draftId: "exact-draft" }));
    expect(mocks.getDraft).toHaveBeenCalledWith("exact-draft");
    expect(mocks.setPrompt).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: "Question added to conversation draft" }));
    expect(mocks.setPrompt.mock.calls[0]![0]).toBe("exact-draft");
    const prompt = mocks.setPrompt.mock.calls[0]![1] as string;
    expect(prompt).toContain("Why did cache fail?");
    expect(prompt).toContain("sg-project");
    expect(prompt).toContain("D:/other");
    expect(prompt).not.toContain("old search");
    expect(prompt).not.toContain("credential");
    expect(prompt).not.toContain("Original decision text");
  } finally { await act(async () => renderer?.unmount()); }
});

it("preserves composer content and reports a failed handoff without retrying", async () => {
  mocks.search.mockReturnValue({ matches: [], hasQuery: false, isPending: false, truncated: false, error: null });
  mocks.file.mockReturnValue({ data: null, error: null, isPending: false, refresh: vi.fn() });
  mocks.getDraft.mockReturnValue({ prompt: "My own draft" });
  mocks.open.mockResolvedValueOnce({ draftId: "invested" }).mockRejectedValueOnce(new Error("native navigation failed"));
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<WorkbenchRepositorySearch query="" question="question" specgraphProject="sg-project" />); });
    await act(async () => renderer.root.findByType("select").props.onChange({ target: { value: "local:native" } }));
    const ask = () => renderer.root.findAllByType("button").find((button) => button.children.includes("Ask in conversation"))!;
    await act(async () => ask().props.onClick());
    expect(mocks.setPrompt).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain("existing content");
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error", description: expect.stringContaining("existing content") }));
    await act(async () => ask().props.onClick());
    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain("native navigation failed");
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error", description: expect.stringContaining("native navigation failed") }));
    expect(mocks.setPrompt).not.toHaveBeenCalled();
  } finally { await act(async () => renderer?.unmount()); }
});
