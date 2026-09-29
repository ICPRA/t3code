import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { AbandonNodePanel } from "../../../../../../project-workbench/extensions/workbench-ui/src/AbandonNodePanel";

it("requires explicit abandonment after login and never treats an active-execution refusal as success", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const request = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ identity: { subject: "operator" } }))
    .mockResolvedValueOnce(Response.json({ error: "Execution has not stopped" }, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ slug: "task", stage: "abandoned", version: 4 }));
  const onChanged = vi.fn(); const onOpenSessions = vi.fn();
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<AbandonNodePanel project="project" slug="task" language="en" request={request} onChanged={onChanged} onOpenSessions={onOpenSessions} />); });
    expect(request).not.toHaveBeenCalled();
    await act(async () => renderer.root.findByType("button").props.onClick());
    expect(request).not.toHaveBeenCalled();
    await act(async () => renderer.root.findByType("textarea").props.onChange({ target: { value: "  Superseded plan  " } }));
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(request).toHaveBeenLastCalledWith("/workbench-api/loop/specs/task/abandon", expect.objectContaining({ method: "POST", body: JSON.stringify({ reason: "Superseded plan" }) }));
    await act(async () => renderer.root.findByType("input").props.onChange({ target: { value: "operator-key" } }));
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith("/workbench-api/api/auth/login", expect.anything());
    expect(onChanged).not.toHaveBeenCalled();
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain("Node not abandoned");
    expect(onChanged).not.toHaveBeenCalled();
    await act(async () => renderer.root.findAllByType("button").find((button) => button.children.includes("View original sessions"))!.props.onClick());
    expect(onOpenSessions).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(3);
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(onChanged).toHaveBeenCalledOnce();
    expect(renderer.root.findByProps({ role: "status" }).children).toEqual(["Node abandoned."]);
    expect(request.mock.calls.filter(([url]) => String(url).includes("stop"))).toHaveLength(0);
  } finally { await act(async () => renderer?.unmount()); vi.unstubAllGlobals(); }
});
