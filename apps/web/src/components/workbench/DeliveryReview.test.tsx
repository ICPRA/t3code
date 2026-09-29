import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { DeliveryReview } from "../../../../../../project-workbench/extensions/workbench-ui/src/DeliveryReview";

it("loads the selected delivery before recording a human verdict with its basis", async () => {
  const request = vi.fn().mockResolvedValueOnce(Response.json({ id: "delivery", snapshot: { commit: "example-commit", summary: "Candidate changes" } }))
    .mockResolvedValueOnce(Response.json({ recorded: true, deliveryId: "delivery", verdict: "accepted" }));
  const onChanged = vi.fn();
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<DeliveryReview project="project" deliveryId="delivery" language="en" request={request} onChanged={onChanged} />); });
    expect(renderer.root.findByType("pre").children.join("")).toContain("example-commit");
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => renderer.root.findByType("select").props.onChange({ target: { value: "accepted" } }));
    await act(async () => renderer.root.findByType("textarea").props.onChange({ target: { value: "Reviewed requirements and actual diff" } }));
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(request).toHaveBeenLastCalledWith("/workbench-api/loop/deliveries/delivery/accept", expect.objectContaining({ body: JSON.stringify({ verdict: "accepted", basis: "Reviewed requirements and actual diff" }) }));
    expect(onChanged).toHaveBeenCalledOnce();
    expect(renderer.root.findByProps({ role: "status" }).children).toEqual(["Decision recorded."]);
  } finally { await act(async () => renderer?.unmount()); }
});

it("keeps an accepted human review distinct from failed workflow completion without retrying", async () => {
  const request = vi.fn().mockResolvedValueOnce(Response.json({ id: "delivery", snapshot: {} }))
    .mockResolvedValueOnce(Response.json({ recorded: true, deliveryId: "delivery", verdict: "accepted", completion: { status: "failed", code: "stage_conflict", message: "Node changed after review" } }));
  const onChanged = vi.fn();
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<DeliveryReview project="project" deliveryId="delivery" language="en" request={request} onChanged={onChanged} />); });
    await act(async () => renderer.root.findByType("select").props.onChange({ target: { value: "accepted" } }));
    await act(async () => renderer.root.findByType("textarea").props.onChange({ target: { value: "Reviewed actual changes" } }));
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(renderer.root.findByProps({ role: "status" }).children).toEqual(["Decision recorded."]);
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toBe("Decision saved, but workflow advancement failed: stage_conflict Node changed after review");
    expect(renderer.root.findAllByType("form")).toHaveLength(0);
    expect(request).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalledOnce();
  } finally { await act(async () => renderer?.unmount()); }
});
