"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

type Theme = "light" | "dark" | "system";

const OPTIONS: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

const STORAGE_KEY = "theme";
/** `storage` only fires in *other* tabs, so this tab tells itself. */
const CHANGED = "wroffy:theme-changed";

function apply(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * Which button looks pressed.
 *
 * ## Why this is a store rather than `useState`
 *
 * The chosen theme lives in `localStorage`, which exists only in the browser. Seeding `useState`
 * from it means the first client render disagrees with the server's — the server has no way to know
 * somebody picked Dark — and React reports that as a hydration mismatch. It was doing exactly that:
 * `aria-pressed={true}` against `aria-pressed="false"` on two of these buttons, with an error
 * overlay on every dashboard load in development.
 *
 * `suppressHydrationWarning` was on the wrapping element and did nothing for it, because that flag
 * covers the element's own attributes and text, never its descendants'. The buttons are the
 * descendants.
 *
 * `useSyncExternalStore` is built for precisely this: `getServerSnapshot` is used on the server and
 * for the hydrating render, so the two agree by construction, and React then re-renders from the
 * real value. The same approach the sidebar uses for its collapsed state, for the same reason.
 *
 * The theme itself is applied before paint by the inline script in the root layout, so none of this
 * affects what the page looks like — only which of the three buttons is highlighted.
 */
export function ThemeToggle({ defaultTheme }: { defaultTheme: string }) {
  const fallback = ((defaultTheme as Theme) || "system") satisfies Theme;

  const getSnapshot = useCallback((): Theme => {
    try {
      return (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? fallback;
    } catch {
      // Private mode, or site data blocked. The organisation's default is the honest answer.
      return fallback;
    }
  }, [fallback]);

  const getServerSnapshot = useCallback((): Theme => fallback, [fallback]);

  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Following the OS only means anything if we react when the OS changes.
  useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  function choose(next: Theme) {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore — the choice just won't persist
    }
    apply(next);
    // The store is the source of truth now, so telling it is what re-renders the buttons.
    window.dispatchEvent(new Event(CHANGED));
  }

  return (
    <div className="flex items-center gap-0.5 rounded-base border border-line bg-surface-sunken p-0.5">
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          onClick={() => choose(value)}
          title={label}
          aria-label={`${label} theme`}
          aria-pressed={theme === value}
          className={cn(
            "grid h-7 w-7 place-items-center rounded-[6px] transition-colors duration-150",
            theme === value ? "bg-surface text-text shadow-sm" : "text-subtle hover:text-text",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}
