import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { NodeApproval } from "../../../../../../project-workbench/extensions/workbench-ui/src/NodeApproval";

it("submits the reviewed node version and basis, refreshes after approval, and surfaces stale review", async () => {
  const request = vi.fn().mockResolvedValue(Response.json({ approved: "task", version: 4 }));
  const onChanged = vi.fn();
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<NodeApproval project="project" slug="task" version={3} language="en" request={request} onChanged={onChanged} />); });
    await act(async () => renderer.root.findByType("button").props.onClick());
    await act(async () => renderer.root.findByType("textarea").props.onChange({ target: { value: "Reviewed existing scope" } }));
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(request).toHaveBeenCalledWith("/workbench-api/loop/specs/task/approve", expect.objectContaining({
      method: "POST", body: JSON.stringify({ expectedVersion: 3, basis: "Reviewed existing scope" }),
    }));
    expect(onChanged).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
    request.mockResolvedValue(Response.json({ error: "Node changed" }, { status: 409 }));
    await act(async () => { renderer = create(<NodeApproval project="project" slug="task" version={3} language="en" request={request} onChanged={onChanged} />); });
    await act(async () => renderer.root.findByType("button").props.onClick());
    await act(async () => renderer.root.findByType("textarea").props.onChange({ target: { value: "Old review" } }));
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(renderer.root.findByProps({ role: "alert" }).children).toEqual(["Node changed"]);
    expect(renderer.root.findByType("textarea").props.disabled).toBe(true);
    expect(onChanged).toHaveBeenCalledOnce();
  } finally {
    await act(async () => renderer?.unmount());
  }
});
