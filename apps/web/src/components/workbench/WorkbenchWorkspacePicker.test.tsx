import { act, type ButtonHTMLAttributes, type InputHTMLAttributes } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import * as Cause from "effect/Cause";

const mocks = vi.hoisted(() => ({ create: vi.fn(), refresh: vi.fn(), loadNext: vi.fn(), queries: vi.fn() }));
vi.mock("~/state/vcs", () => ({ vcsEnvironment: { createWorktree: "native-create" } }));
vi.mock("~/i18n/i18n", () => ({ useI18n: () => ({ language: "en" }) }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.create }));
vi.mock("~/state/queries", () => ({ usePaginatedBranches: (target: unknown) => mocks.queries(target) }));
vi.mock("~/components/ui/button", () => ({ Button: ({ variant: _variant, size: _size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }));
vi.mock("~/components/ui/input", () => ({ Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} /> }));

import { WorkbenchWorkspacePicker } from "./WorkbenchWorkspacePicker";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => { await act(async () => renderer?.unmount()); vi.unstubAllGlobals(); });

it.each([40, 64])("creates from an explicit %s-character commit without a loaded branch or branch-base metadata", async (length) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const project = { id: "project", environmentId: "environment", workspaceRoot: "C:\\Repo" } as EnvironmentProject;
  const onChange = vi.fn();
  mocks.create.mockReset().mockResolvedValue({ _tag: "Success", value: { worktree: { path: "C:\\testing", refName: "test-version" } } });
  mocks.refresh.mockReset(); mocks.loadNext.mockReset();
  mocks.queries.mockReset().mockReturnValue({ refs: [{ name: "main", worktreePath: "C:\\Repo" }], data: { isRepo: true, nextCursor: null }, error: null, refresh: mocks.refresh, loadNext: mocks.loadNext });
  await act(async () => { renderer = create(<WorkbenchWorkspacePicker nativeProject={project} value={null} disabled={false} onChange={onChange} />); });
  await act(async () => renderer!.root.findByProps({ "aria-label": "Base ref" }).props.onChange({ target: { value: "main" } }));
  await act(async () => renderer!.root.findAllByType("input").find((input) => input.props["aria-label"] === "New branch")!.props.onChange({ target: { value: "test-version" } }));
  const commitInput = () => renderer!.root.findAllByType("input").find((input) => input.props["aria-label"] === "Exact commit SHA")!;
  const createButton = () => renderer!.root.findAllByType("button").find((button) => button.children.includes("Create isolated worktree"))!;
  for (const value of ["abc123", "g".repeat(length), "a".repeat(41)]) {
    await act(async () => commitInput().props.onChange({ target: { value } }));
    expect(createButton().props.disabled).toBe(true);
    await act(async () => createButton().props.onClick());
    expect(mocks.create).not.toHaveBeenCalled();
  }
  const commit = "a".repeat(length);
  mocks.queries.mockReturnValue({ refs: [], data: { isRepo: true, nextCursor: null }, error: null, refresh: mocks.refresh, loadNext: mocks.loadNext });
  await act(async () => commitInput().props.onChange({ target: { value: commit } }));
  expect(createButton().props.disabled).toBe(false);
  expect(renderer!.root.findByProps({ "aria-label": "Base ref" }).props.disabled).toBe(true);
  await act(async () => createButton().props.onClick());
  expect(mocks.create).toHaveBeenCalledExactlyOnceWith({ environmentId: "environment", input: { cwd: "C:\\Repo", refName: commit, newRefName: "test-version", path: null } });
  expect(onChange).toHaveBeenLastCalledWith({ workspace: "C:\\testing", branch: "test-version", worktreePath: "C:\\testing", expectedCommitSha: commit });
});

it("selects explicit native paths and creates once with actual success or visible failure", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const project = { id: "project", environmentId: "environment", workspaceRoot: "C:\\Repo" } as EnvironmentProject;
  const onChange = vi.fn();
  const refs = [
    { name: "main", worktreePath: "c:/repo/", current: true, isDefault: true },
    { name: "existing", worktreePath: "C:\\worktree", current: false, isDefault: false },
  ];
  mocks.create.mockReset().mockImplementation(async () => {
    expect(onChange).toHaveBeenLastCalledWith(null);
    return { _tag: "Success", value: { worktree: { path: "C:\\created", refName: "actual-branch" } } };
  });
  mocks.refresh.mockReset(); mocks.loadNext.mockReset();
  mocks.queries.mockReset().mockReturnValue({ refs, data: { isRepo: true, nextCursor: 1 }, error: null, isPending: false, isFetchingNextPage: false, refresh: mocks.refresh, loadNext: mocks.loadNext });
  await act(async () => { renderer = create(<WorkbenchWorkspacePicker nativeProject={project} value={null} disabled={false} onChange={onChange} />); });
  expect(mocks.queries).toHaveBeenCalledWith({ environmentId: "environment", cwd: "C:\\Repo", query: "" });
  expect(onChange).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  const workspace = () => renderer!.root.findByProps({ "aria-label": "Execution workspace" });
  expect(workspace().props.value).toBe("");
  expect(workspace().findAllByType("option").map((option) => option.props.value)).toEqual(["", "shared", JSON.stringify(["existing", "C:\\worktree"])]);
  await act(async () => workspace().props.onChange({ target: { value: "shared" } }));
  expect(onChange).toHaveBeenLastCalledWith({ workspace: "C:\\Repo", branch: null, worktreePath: null });
  await act(async () => workspace().props.onChange({ target: { value: JSON.stringify(["existing", "C:\\worktree"]) } }));
  expect(onChange).toHaveBeenLastCalledWith({ workspace: "C:\\worktree", branch: "existing", worktreePath: "C:\\worktree" });
  await act(async () => renderer!.root.findByProps({ "aria-label": "Base ref" }).props.onChange({ target: { value: "main" } }));
  await act(async () => renderer!.root.findAllByType("input").find((input) => input.props["aria-label"] === "New branch")!.props.onChange({ target: { value: "requested-branch" } }));
  const createButton = () => renderer!.root.findAllByType("button").find((button) => button.children.includes("Create isolated worktree"))!;
  await act(async () => createButton().props.onClick());
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.create).toHaveBeenCalledWith({ environmentId: "environment", input: { cwd: "C:\\Repo", refName: "main", baseRefName: "main", newRefName: "requested-branch", path: null } });
  expect(onChange).toHaveBeenLastCalledWith({ workspace: "C:\\created", branch: "actual-branch", worktreePath: "C:\\created" });
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  onChange.mockClear();
  mocks.create.mockResolvedValue({ _tag: "Failure", cause: Cause.fail(new Error("Native creation failed")) });
  await act(async () => createButton().props.onClick());
  expect(mocks.create).toHaveBeenCalledTimes(2);
  expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(renderer!.toJSON())).toContain("Native creation failed");
  for (const gitState of [{ isRepo: false, error: null }, { isRepo: true, error: "Ref query failed" }]) {
    mocks.queries.mockReturnValue({ refs, data: { isRepo: gitState.isRepo, nextCursor: null }, error: gitState.error, isPending: false, refresh: mocks.refresh, loadNext: mocks.loadNext });
    await act(async () => renderer!.update(<WorkbenchWorkspacePicker nativeProject={project} value={null} disabled={false} onChange={onChange} />));
    expect(workspace().props.disabled).toBe(false);
    expect(workspace().findAllByType("option").map((option) => option.props.value)).toEqual(["", "shared"]);
    expect(createButton().props.disabled).toBe(true);
    await act(async () => workspace().props.onChange({ target: { value: "shared" } }));
    expect(onChange).toHaveBeenLastCalledWith({ workspace: "C:\\Repo", branch: null, worktreePath: null });
    expect(mocks.create).toHaveBeenCalledTimes(2);
  }
  mocks.queries.mockReturnValue({ refs: [], data: null, error: null, isPending: true, refresh: mocks.refresh, loadNext: mocks.loadNext });
  await act(async () => renderer!.update(<WorkbenchWorkspacePicker nativeProject={project} value={{ workspace: "C:\\saved", branch: "saved-branch", worktreePath: "C:\\saved" }} disabled onChange={onChange} />));
  expect(JSON.stringify(renderer!.toJSON())).toContain("C:\\\\saved");
  expect(JSON.stringify(renderer!.toJSON())).toContain("saved-branch");
  expect(mocks.create).toHaveBeenCalledTimes(2);
});
