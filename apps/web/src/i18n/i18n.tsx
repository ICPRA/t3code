// Fork-local i18n: English -> Simplified Chinese via exact-match DOM text
// replacement. Chosen over a full string-extraction framework to keep the
// upstream diff tiny (one mount point in __root.tsx); untranslated strings
// surface as English and can be added to zhDictionary.ts incrementally.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ZH_DICTIONARY } from "./zhDictionary";

export type WorkbenchLanguage = "en" | "zh";

const STORAGE_KEY = "t3-workbench-language";

function readInitialLanguage(): WorkbenchLanguage {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "zh") return stored;
  } catch {
    // localStorage unavailable; fall through to the fork default.
  }
  // Fork default: Simplified Chinese (Electron's navigator.language follows the
  // app locale, not the OS, so auto-detect is unreliable there).
  return "zh";
}

type I18nContextValue = {
  language: WorkbenchLanguage;
  setLanguage: (language: WorkbenchLanguage) => void;
  /** Translate a literal (used by fork-owned components). */
  t: (english: string) => string;
};

const I18nContext = createContext<I18nContextValue>({
  language: "en",
  setLanguage: () => undefined,
  t: (english) => english,
});

export function useI18n() {
  return useContext(I18nContext);
}

const ORIGINAL_ATTRIBUTE = "data-i18n-original";
const SKIP_ATTRIBUTE = "data-i18n-skip";

function translateTextNode(node: CharacterData, toZh: boolean) {
  const original = node.data;
  const trimmed = original.trim();
  if (trimmed.length === 0) return;
  if (toZh) {
    // Exact match first, then "Label (variable)" / "Label: variable" shapes.
    const composite = trimmed.match(/^([A-Za-z][A-Za-z ]+?)(\s*[(:][^A-Za-z].*)$/);
    const key = ZH_DICTIONARY[trimmed] !== undefined ? trimmed : (composite?.[1]?.trim() ?? trimmed);
    const suffix = ZH_DICTIONARY[trimmed] !== undefined ? "" : (composite?.[2] ?? "");
    const translated = ZH_DICTIONARY[key];
    if (translated === undefined) return;
    const withSuffix = `${translated}${suffix}`;
    if (original === withSuffix) return;
    const leading = original.slice(0, original.indexOf(trimmed[0]!));
    const trailing = original.slice(original.lastIndexOf(trimmed[trimmed.length - 1]!) + 1);
    node.data = `${leading}${withSuffix}${trailing}`;
    node.parentElement?.setAttribute(ORIGINAL_ATTRIBUTE, original);
  } else {
    const parent = node.parentElement;
    const stored = parent?.getAttribute?.(ORIGINAL_ATTRIBUTE);
    if (stored !== undefined && stored !== null && parent !== null && parent !== undefined) {
      node.data = stored;
      parent.removeAttribute(ORIGINAL_ATTRIBUTE);
    }
  }
}

function translateAttributes(root: ParentNode, toZh: boolean) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let element = walker.nextNode() as Element | null;
  while (element !== null) {
    if (element.hasAttribute(SKIP_ATTRIBUTE)) {
      element = walker.nextNode() as Element | null;
      continue;
    }
    for (const attribute of ["placeholder", "aria-label", "title"] as const) {
      const current = element.getAttribute(attribute);
      if (current === null) continue;
      const trimmed = current.trim();
      if (toZh) {
        const translated = ZH_DICTIONARY[trimmed];
        if (translated === undefined || translated === current) continue;
        element.setAttribute(`data-i18n-original-${attribute}`, current);
        element.setAttribute(attribute, translated);
      } else {
        const stored = element.getAttribute(`data-i18n-original-${attribute}`);
        if (stored !== null) {
          element.setAttribute(attribute, stored);
          element.removeAttribute(`data-i18n-original-${attribute}`);
        }
      }
    }
    element = walker.nextNode() as Element | null;
  }
}

function translateDocument(root: ParentNode, toZh: boolean) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (parent === null) return NodeFilter.FILTER_REJECT;
      if (parent.closest(`[${SKIP_ATTRIBUTE}]`) !== null) return NodeFilter.FILTER_REJECT;
      if (parent.closest("script,style") !== null) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: CharacterData[] = [];
  let node = walker.nextNode();
  while (node !== null) {
    nodes.push(node as CharacterData);
    node = walker.nextNode();
  }
  for (const textNode of nodes) translateTextNode(textNode, toZh);
  translateAttributes(root, toZh);
}

/** Mount once near the app root; wraps the tree in the i18n context and
 *  drives DOM translation of upstream-rendered chrome. */
export function DomTranslator({ children }: { children?: ReactNode }) {
  const [language, setLanguageState] = useState<WorkbenchLanguage>(readInitialLanguage);
  const scheduled = useRef(false);

  const setLanguage = useCallback((next: WorkbenchLanguage) => {
    setLanguageState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Persistence is best-effort.
    }
  }, []);

  useEffect(() => {
    const toZh = language === "zh";
    translateDocument(document.body, toZh);

    const observer = new MutationObserver((mutations) => {
      if (scheduled.current) return;
      let hasWork = false;
      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          hasWork = true;
          break;
        }
        for (const added of mutation.addedNodes) {
          if (added.nodeType === Node.TEXT_NODE || added.nodeType === Node.ELEMENT_NODE) {
            hasWork = true;
            break;
          }
        }
        if (hasWork) break;
      }
      if (!hasWork) return;
      scheduled.current = true;
      window.requestAnimationFrame(() => {
        scheduled.current = false;
        translateDocument(document.body, toZh);
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [language]);

  const value = useMemo<I18nContextValue>(
    () => ({
      language,
      setLanguage,
      t: (english) => (language === "zh" ? (ZH_DICTIONARY[english] ?? english) : english),
    }),
    [language, setLanguage],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function LanguageSwitcher(): ReactNode {
  const { language, setLanguage } = useI18n();
  return (
    <div className="flex items-center gap-2" data-i18n-skip>
      <span className="text-sm text-muted-foreground">语言 / Language</span>
      <div className="flex overflow-hidden rounded-md border">
        <button
          type="button"
          onClick={() => setLanguage("zh")}
          className={`px-3 py-1 text-sm ${language === "zh" ? "bg-accent font-medium" : "hover:bg-accent/50"}`}
        >
          简体中文
        </button>
        <button
          type="button"
          onClick={() => setLanguage("en")}
          className={`px-3 py-1 text-sm ${language === "en" ? "bg-accent font-medium" : "hover:bg-accent/50"}`}
        >
          English
        </button>
      </div>
    </div>
  );
}
