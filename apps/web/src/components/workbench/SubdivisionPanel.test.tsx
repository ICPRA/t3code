import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { SubdivisionPanel } from "../../../../../../project-workbench/extensions/workbench-ui/src/SubdivisionPanel";

let renderer: ReactTestRenderer | undefined;
const changed = vi.fn();
const request = vi.fn();
function content(node: ReactTestInstance | string = renderer!.root): string {
  return typeof node === "string" ? node : node.children.map(content).join("");
}
function button(label: string) {
  return renderer!.root.findAllByType("button").find((node) => content(node) === label)!;
}
async function mount() {
  await act(async () => { renderer = create(<SubdivisionPanel project="one" slug="parent" language="en" onChanged={changed} request={request} />); });
  await act(async () => button("Subdivide node").props.onClick());
}
async function fill() {
  for (const [label, value] of [["child-0-slug", "new-child"], ["child-0-intent", "Independent work"], ["subdivision-reason", "Separate responsibilities"]]) {
    await act(async () => renderer!.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } }));
  }
}
async function submit() { await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} })); }
beforeEach(() => {
  changed.mockReset(); request.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Must use injected transport"); }));
  request.mockImplementation(async (_url: string, options?: RequestInit) => options?.method === "POST"
    ? Response.json({ id: "split", parent: "parent", parentVersion: 8, childSlugs: ["new-child"] })
    : Response.json({ spec: { slug: "parent", version: 7 } }));
});
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined; vi.unstubAllGlobals(); });

it("creates children from parent version and authored fields without old review or handoff requests", async () => {
  await mount(); await fill(); await submit();
  expect(request).toHaveBeenCalledTimes(2);
  const [url, options] = request.mock.calls[1]!;
  expect(url).toBe("/workbench-api/loop/specs/parent/subdivide");
  expect(new Headers(options.headers).get("X-Specgraph-Project")).toBe("one");
  expect(JSON.parse(options.body)).toEqual({ expectedVersion: 7, reason: "Separate responsibilities", children: [{ slug: "new-child", intent: "Independent work", priority: "p2", complexity: "medium" }] });
  expect(changed).toHaveBeenCalledOnce();
  expect(renderer!.root.findAllByType("form")).toHaveLength(0);
});

it("does not rebase a rejected request until an explicit refresh", async () => {
  await mount(); await fill();
  request.mockResolvedValueOnce(Response.json({}, { status: 409 }));
  await submit();
  expect(content()).toContain("HTTP 409");
  expect(request).toHaveBeenCalledTimes(2);
  request.mockResolvedValueOnce(Response.json({ spec: { slug: "parent", version: 8 } }));
  await act(async () => button("Refresh").props.onClick());
  await submit();
  expect(JSON.parse(request.mock.calls[3]![1].body).expectedVersion).toBe(8);
});

it("does not automatically retry an uncertain write or report it as completed", async () => {
  await mount(); await fill();
  request.mockResolvedValueOnce(Response.json({}, { status: 503 }));
  await submit();
  expect(content()).toContain("Outcome unconfirmed");
  expect(button("Create children").props.disabled).toBe(true);
  await submit();
  expect(request).toHaveBeenCalledTimes(2);
  expect(changed).not.toHaveBeenCalled();
});

it("allows authentication after a denied initial read without automatically creating work", async () => {
  request.mockResolvedValueOnce(Response.json({}, { status: 401 }));
  await mount();
  expect(button("Create children").props.disabled).toBe(true);
  await act(async () => renderer!.root.findByProps({ type: "password" }).props.onChange({ target: { value: "operator-key" } }));
  await act(async () => button("Sign in").props.onClick());
  expect(request.mock.calls.map(([url]) => url)).toEqual(["/workbench-api/wb/specs/parent", "/workbench-api/api/auth/login", "/workbench-api/wb/specs/parent"]);
  expect(changed).not.toHaveBeenCalled();
  expect(button("Create children").props.disabled).toBe(false);
});

it("ignores late mutation responses after the form is unmounted", async () => {
  await mount(); await fill();
  let resolve!: (response: Response) => void;
  request.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
  await submit();
  const signal = request.mock.calls[1]![1].signal as AbortSignal;
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(Response.json({ id: "split", parent: "parent", childSlugs: ["new-child"] })));
  expect(changed).not.toHaveBeenCalled();
});
