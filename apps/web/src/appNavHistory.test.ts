import { beforeEach, expect, it } from "vite-plus/test";
import { getAppNavState, resetAppNavHistory, trackAppNavigation } from "./appNavHistory";

beforeEach(() => resetAppNavHistory());

it("tracks a linear push sequence", () => {
  trackAppNavigation("k1", "/workbench");
  trackAppNavigation("k2", "/local/thread-1");
  expect(getAppNavState()).toEqual({ canGoBack: true, canGoForward: false });
});

it("moving back re-enables forward without losing entries", () => {
  trackAppNavigation("k1", "/workbench");
  trackAppNavigation("k2", "/local/thread-1");
  trackAppNavigation("k1", "/workbench");
  expect(getAppNavState()).toEqual({ canGoBack: false, canGoForward: true });
  trackAppNavigation("k2", "/local/thread-1");
  expect(getAppNavState()).toEqual({ canGoBack: true, canGoForward: false });
});

it("supports multiple consecutive back steps", () => {
  trackAppNavigation("k1", "/workbench");
  trackAppNavigation("k2", "/local/thread-1");
  trackAppNavigation("k3", "/local/thread-2");
  trackAppNavigation("k2", "/local/thread-1");
  expect(getAppNavState()).toEqual({ canGoBack: true, canGoForward: true });
  trackAppNavigation("k1", "/workbench");
  expect(getAppNavState()).toEqual({ canGoBack: false, canGoForward: true });
});

it("a fresh push after going back truncates the forward entries", () => {
  trackAppNavigation("k1", "/workbench");
  trackAppNavigation("k2", "/local/thread-1");
  trackAppNavigation("k1", "/workbench");
  trackAppNavigation("k9", "/local/thread-9");
  expect(getAppNavState()).toEqual({ canGoBack: true, canGoForward: false });
});

it("ignores re-renders of the current entry and missing keys", () => {
  trackAppNavigation("k1", "/workbench");
  trackAppNavigation("k1", "/workbench");
  trackAppNavigation(undefined, "/local/thread-1");
  expect(getAppNavState()).toEqual({ canGoBack: false, canGoForward: false });
});

it("caps the stack and keeps the newest entries", () => {
  for (let i = 0; i < 120; i += 1) trackAppNavigation(`k${i}`, `/local/thread-${i}`);
  trackAppNavigation("k119", "/local/thread-119");
  trackAppNavigation("k118", "/local/thread-118");
  expect(getAppNavState()).toEqual({ canGoBack: true, canGoForward: true });
});
