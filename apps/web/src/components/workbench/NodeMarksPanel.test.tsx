import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { NodeMarksPanel } from "../../../../../../project-workbench/extensions/workbench-ui/src/NodeMarksPanel";
import type { NodeMark } from "@project-workbench/ui/model";

afterEach(() => vi.unstubAllGlobals());

it("requires explicit operator submits, preserves independent marks and reads actor/reason history pages", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const endpoint = "/workbench-api/node-marks/task";
  const old: NodeMark = { id: "old", taskSlug: "task", kind: "risk", value: "watch", reason: "Prior observation", actor: "operator-a", createdAt: "2026-09-24T10:00:00Z" };
  const older: NodeMark = { ...old, id: "older", kind: "critical", value: "cleared", actor: "operator-b", reason: "Prior critical assessment" };
  let signedIn = false;
  const writes: Record<string, unknown>[] = [];
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/workbench-api/api/auth/login") { signedIn = true; return Response.json({ identity: { subject: "operator" } }); }
    expect(new Headers(init?.headers).get("X-Specgraph-Project")).toBe("project");
    if (!signedIn) return Response.json({}, { status: 401 });
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)); writes.push(body);
      return Response.json({ id: `mark-${writes.length}`, taskSlug: "task", ...body, actor: "authenticated-operator", createdAt: "2026-09-24T11:00:00Z" });
    }
    return Response.json(url.includes("?cursor=")
      ? { items: [older], hasMore: false, nextCursor: "" }
      : { items: [old], hasMore: true, nextCursor: "older/page" });
  });
  const onChanged = vi.fn();
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<NodeMarksPanel project="project" slug="task" language="en" currentMarks={undefined} request={request} onChanged={onChanged} />); });
    expect(renderer.root.findAllByType("dd").map((entry) => entry.children.join(""))).toEqual(["Mark data unavailable", "Mark data unavailable"]);
    await act(async () => renderer.root.findByType("input").props.onChange({ target: { value: "operator-key" } }));
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(writes).toEqual([]);
    expect(renderer.root.findAllByType("form")).toHaveLength(2);
    const more = renderer.root.findAllByType("button").find((button) => button.children.includes("Load more"))!;
    await act(async () => more.props.onClick());
    expect(request).toHaveBeenLastCalledWith(`${endpoint}?cursor=older%2Fpage`, expect.anything());
    const history = renderer.root.findByType("ul");
    expect(history.findAllByType("li")).toHaveLength(2);
    expect(history.findAllByType("time").map((entry) => entry.children.join(""))).toEqual([old.createdAt, older.createdAt]);
    expect(history.findAllByType("p").map((entry) => entry.children.join(" ")).join(" ")).toContain("operator-b");
    expect(history.findAllByType("p").map((entry) => entry.children.join(" "))).toContain("Prior critical assessment");
    for (const [kind, value, reason] of [["Risk mark", "high", "Observed incident"], ["Critical mark", "marked", "Operator priority"], ["Risk mark", "cleared", "Risk addressed"]]) {
      const form = renderer.root.findByProps({ "aria-label": kind });
      await act(async () => form.findByType("select").props.onChange({ target: { value } }));
      await act(async () => form.findByType("textarea").props.onChange({ target: { value: `  ${reason}  ` } }));
      await act(async () => form.props.onSubmit({ preventDefault() {} }));
    }
    expect(writes).toEqual([
      { kind: "risk", value: "high", reason: "Observed incident" },
      { kind: "critical", value: "marked", reason: "Operator priority" },
      { kind: "risk", value: "cleared", reason: "Risk addressed" },
    ]);
    expect(onChanged).toHaveBeenCalledTimes(3);
    expect(renderer.root.findAllByProps({ role: "status" }).some((entry) => entry.children.includes("Mark recorded."))).toBe(true);
  } finally { await act(async () => renderer?.unmount()); }
});

it("does not retry an unknown mutation and refreshes history without another write", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let writes = 0;
  const request = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") { writes++; throw new Error("connection lost"); }
    return Response.json({ items: [], hasMore: false, nextCursor: "" });
  });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<NodeMarksPanel project="project" slug="task" language="en" currentMarks={[]} request={request} onChanged={() => {}} />); });
    const form = renderer.root.findByProps({ "aria-label": "Risk mark" });
    await act(async () => form.findByType("select").props.onChange({ target: { value: "watch" } }));
    await act(async () => form.findByType("textarea").props.onChange({ target: { value: "Needs investigation" } }));
    await act(async () => form.props.onSubmit({ preventDefault() {} }));
    expect(writes).toBe(1);
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain("Result unconfirmed");
    expect(form.findByType("button").props.disabled).toBe(true);
    await act(async () => form.props.onSubmit({ preventDefault() {} }));
    expect(writes).toBe(1);
    await act(async () => renderer.root.findAllByType("button").find((button) => button.children.includes("Refresh history"))!.props.onClick());
    expect(writes).toBe(1);
    expect(form.findByType("button").props.disabled).toBe(false);
  } finally { await act(async () => renderer?.unmount()); }
});
