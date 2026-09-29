import { useSyncExternalStore } from "react";

// App-wide in-memory navigation position tracking. TanStack Router's history
// entries carry a unique `__TSR_key`, so revisiting an entry (back/forward)
// is distinguishable from a fresh push without inspecting the URL.
// The browser history itself performs the actual traversal; this module only
// mirrors the position so UI can offer enabled back/forward controls.

type Entry = { key: string; href: string };
const MAX_ENTRIES = 100;

let stack: Entry[] = [];
let index = -1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function trackAppNavigation(key: string | undefined, href: string) {
  if (!key) return;
  if (stack[index]?.key === key) return;
  if (index > 0 && stack[index - 1]?.key === key) {
    index -= 1;
  } else if (index < stack.length - 1 && stack[index + 1]?.key === key) {
    index += 1;
  } else {
    stack = stack.slice(0, index + 1);
    stack.push({ key, href });
    if (stack.length > MAX_ENTRIES) stack = stack.slice(-MAX_ENTRIES);
    index = stack.length - 1;
  }
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return `${index}:${stack.length}`;
}

export function getAppNavState(): { canGoBack: boolean; canGoForward: boolean } {
  return { canGoBack: index > 0, canGoForward: index < stack.length - 1 };
}

export function useAppNavHistory(): { canGoBack: boolean; canGoForward: boolean } {
  useSyncExternalStore(subscribe, getSnapshot);
  return getAppNavState();
}

export function resetAppNavHistory() {
  stack = [];
  index = -1;
  emit();
}
