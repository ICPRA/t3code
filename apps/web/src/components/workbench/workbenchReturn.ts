const KEY = "workbench.returnHref";

// Records the exact workbench view (path + search: project, tab, selected
// node, run) before jumping to a native T3 thread, so the thread view can
// offer a way back. sessionStorage keeps it across reloads but not tabs.
export function saveWorkbenchReturn() {
  try {
    if (!window.location.pathname.endsWith("/workbench")) return;
    sessionStorage.setItem(KEY, window.location.pathname + window.location.search);
  } catch {
    // Storage unavailable; the back affordance simply never appears.
  }
}

export function readWorkbenchReturn(): string | null {
  try {
    const href = sessionStorage.getItem(KEY);
    return href !== null && href.includes("/workbench") ? href : null;
  } catch {
    return null;
  }
}

export function clearWorkbenchReturn() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Storage unavailable; nothing to clear.
  }
}
