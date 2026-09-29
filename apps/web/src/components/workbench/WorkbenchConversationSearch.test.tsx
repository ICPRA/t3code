import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

const mocks = vi.hoisted(() => ({ search: vi.fn(), query: vi.fn() }));
vi.mock("~/state/orchestration", () => ({ orchestrationEnvironment: { threadSearch: mocks.search } }));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: mocks.query }));
vi.mock("~/state/queries", () => ({ useDebouncedValue: (value: string) => value }));
vi.mock("~/state/entities", () => ({ useThreadShells: () => [] }));
vi.mock("~/i18n/i18n", () => ({ useI18n: () => ({ language: "en" }) }));
import { WorkbenchConversationSearch } from "./WorkbenchConversationSearch";

it("passes project and archive scope before searching and displays failures distinctly", async () => {
  mocks.query.mockReturnValue({ data: null, error: "Search unavailable", isPending: false });
  const project = { id: "project", environmentId: "local" } as EnvironmentProject;
  const onIncludeArchivedChange = vi.fn();
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<WorkbenchConversationSearch project={project} query="decision" includeArchived={true} onIncludeArchivedChange={onIncludeArchivedChange} />); });
    expect(mocks.search).toHaveBeenLastCalledWith({ environmentId: "local", input: { projectId: "project", query: "decision", includeArchived: true, limit: 50 } });
    expect(renderer.root.findByProps({ role: "alert" }).children).toEqual(["Search unavailable"]);
    await act(async () => renderer.root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: false } }));
    expect(onIncludeArchivedChange).toHaveBeenCalledWith(false);
    await act(async () => renderer.update(<WorkbenchConversationSearch project={project} query="decision" includeArchived={false} onIncludeArchivedChange={onIncludeArchivedChange} />));
    expect(mocks.search).toHaveBeenLastCalledWith({ environmentId: "local", input: { projectId: "project", query: "decision", includeArchived: false, limit: 50 } });
  } finally { await act(async () => renderer?.unmount()); }
});
