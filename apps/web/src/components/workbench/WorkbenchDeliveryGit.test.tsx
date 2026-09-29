import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { WorkbenchRun } from "./workbenchModel";

const mocks = vi.hoisted(() => ({ compare: vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.compare }));
vi.mock("~/state/vcs", () => ({ vcsEnvironment: { compareCommits: {} } }));
vi.mock("~/i18n/i18n", () => ({ useI18n: () => ({ language: "en" }) }));
vi.mock("../diffs/StyledDiffCodeView", () => ({ StyledDiffCodeView: () => <div>Native diff renderer</div> }));
import { WorkbenchDeliveryGit } from "./WorkbenchDeliveryGit";
afterEach(() => vi.unstubAllGlobals());

it("queries recorded commit identities only on demand and refuses a substitute workspace", async () => {
  const baseCommit = "a".repeat(40), headCommit = "b".repeat(40);
  const run: WorkbenchRun = { id: "run", taskSlug: "task", packageId: "package", generation: 1, threadRef: "thread", environmentId: "local", workspace: "C:/repo", state: "bound", createdAt: "2026-09-23", updatedAt: "2026-09-23" };
  const git = { workspace: run.workspace, baseline: { isRepo: true, commitSha: baseCommit }, head: { isRepo: true, commitSha: headCommit } };
  const persist = vi.fn(() => { throw new Error("Diff must not be persisted"); });
  vi.stubGlobal("localStorage", { setItem: persist });
  mocks.compare.mockReset().mockResolvedValue({ _tag: "Success", value: { baseCommit, headCommit, baseIsAncestor: false, commits: [], nextOffset: null, diff: "", diffTruncated: false } });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<WorkbenchDeliveryGit run={run} snapshot={{ git }} />); });
    expect(mocks.compare).not.toHaveBeenCalled();
    await act(async () => renderer.root.findByType("button").props.onClick());
    expect(mocks.compare).toHaveBeenCalledWith({ environmentId: "local", input: { cwd: "C:/repo", baseCommit, headCommit, offset: 0, limit: 50 } });
    expect(JSON.stringify(renderer.toJSON())).toContain("not their merge base");
    expect(persist).not.toHaveBeenCalled();
    await act(async () => renderer.update(<WorkbenchDeliveryGit run={run} snapshot={{ git: { ...git, workspace: "C:/other" } }} />));
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain("no substitute directory");
    expect(mocks.compare).toHaveBeenCalledTimes(1);
  } finally { await act(async () => renderer?.unmount()); }
});
