import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import type { WorkbenchRun } from "./workbenchModel";

const mocks = vi.hoisted(() => ({ head: vi.fn() }));
vi.mock("~/state/vcs", () => ({ vcsEnvironment: { readHead: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.head }));
vi.mock("~/i18n/i18n", () => ({ useI18n: () => ({ language: "en" }) }));
import { WorkbenchDeliverySubmission } from "./WorkbenchDeliverySubmission";

it("captures actual HEAD against the saved baseline without accepting or completing the run", async () => {
  const run: WorkbenchRun = { id: "run", taskSlug: "task", packageId: "package", generation: 1, threadRef: "thread", workspace: "C:/worktrees/task", state: "bound", createdAt: "2026-09-23", updatedAt: "2026-09-23", gitBaseline: { isRepo: true, commitSha: "start" } };
  mocks.head.mockResolvedValue({ _tag: "Success", value: { isRepo: true, commitSha: "end" } });
  const request = vi.fn().mockResolvedValue(Response.json({ delivery_id: "delivery" }));
  const onChanged = vi.fn();
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<WorkbenchDeliverySubmission project="project" environmentId={EnvironmentId.make("local")} run={run} onChanged={onChanged} request={request} />); });
    await act(async () => renderer.root.findByType("button").props.onClick());
    await act(async () => renderer.root.findByType("textarea").props.onChange({ target: { value: "Implemented work" } }));
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(mocks.head).toHaveBeenCalledWith({ environmentId: "local", input: { cwd: run.workspace } });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toBe("/workbench-api/loop/deliveries");
    expect(JSON.parse(request.mock.calls[0]![1].body)).toEqual({ run_binding_id: "run", snapshot: { summary: "Implemented work", git: { workspace: run.workspace, baseline: run.gitBaseline, head: { isRepo: true, commitSha: "end" }, uncommittedContentIncluded: false } } });
    expect(onChanged).toHaveBeenCalledOnce();
  } finally { await act(async () => renderer?.unmount()); }
});
