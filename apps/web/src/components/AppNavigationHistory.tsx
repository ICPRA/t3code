import { useEffect } from "react";
import { useLocation, useRouter } from "@tanstack/react-router";
import { trackAppNavigation } from "../appNavHistory";

// Mounts once in the root route: mirrors every navigation into the app nav
// tracker and binds Alt+Left / Alt+Right to history back/forward, the way
// browsers do. Typing contexts (inputs, textareas, contenteditable, the
// terminal) keep their own Alt+Arrow behavior.
export function AppNavigationHistory() {
  const router = useRouter();
  const locationKey = useLocation({ select: (location) => location.state.__TSR_key });
  const locationHref = useLocation({ select: (location) => location.href });

  useEffect(() => {
    trackAppNavigation(locationKey, locationHref);
  }, [locationKey, locationHref]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          target.closest(".xterm") !== null)
      ) {
        return;
      }
      event.preventDefault();
      if (event.key === "ArrowLeft") {
        router.history.back();
      } else {
        router.history.forward();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  return null;
}
