import { afterEach, expect, it, vi } from "vite-plus/test";
import { clearWorkbenchReturn, readWorkbenchReturn, saveWorkbenchReturn } from "./workbenchReturn";

function stubBrowser(pathname: string, search = "") {
  const store = new Map<string, string>();
  vi.stubGlobal("window", { location: { pathname, search } });
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  return store;
}

afterEach(() => vi.unstubAllGlobals());

it("records the exact workbench view including search params", () => {
  stubBrowser("/workbench", "?tab=sessions&selected=node-a");
  saveWorkbenchReturn();
  expect(readWorkbenchReturn()).toBe("/workbench?tab=sessions&selected=node-a");
});

it("never records a non-workbench location", () => {
  stubBrowser("/local/thread-1");
  saveWorkbenchReturn();
  expect(readWorkbenchReturn()).toBeNull();
});

it("rejects a stored href that does not point at the workbench", () => {
  const store = stubBrowser("/workbench");
  store.set("workbench.returnHref", "/settings");
  expect(readWorkbenchReturn()).toBeNull();
});

it("clears the recorded return after use", () => {
  stubBrowser("/workbench", "?tab=overview");
  saveWorkbenchReturn();
  clearWorkbenchReturn();
  expect(readWorkbenchReturn()).toBeNull();
});

it("tolerates unavailable storage", () => {
  vi.stubGlobal("window", { location: { pathname: "/workbench", search: "" } });
  vi.stubGlobal("sessionStorage", {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  });
  expect(() => saveWorkbenchReturn()).not.toThrow();
  expect(readWorkbenchReturn()).toBeNull();
  expect(() => clearWorkbenchReturn()).not.toThrow();
});
