"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Light or dark — the two choices a person makes. Until they make one, the page follows the
 * organisation's default, and where that default is "system", the computer's own setting (the root
 * layout's before-paint script applies it; the effect below keeps following it). Whichever of the two
 * is showing is the button that looks pressed. A stored "system" from before there was no such button
 * counts as no choice.
 */
export type ThemeChoice = "light" | "dark";

export const THEME_CHOICES: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

const STORAGE_KEY = "theme";
/** `storage` only fires in *other* tabs, so this tab tells itself. */
const CHANGED = "wroffy:theme-changed";
const DARK_QUERY = "(prefers-color-scheme: dark)";

const isChoice = (value: unknown): value is ThemeChoice => value === "light" || value === "dark";

function stored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private mode, or site data blocked: nothing was remembered.
    return null;
  }
}

function subscribe(onChange: () => void) {
  const media = window.matchMedia(DARK_QUERY);
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  media.addEventListener("change", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
    media.removeEventListener("change", onChange);
  };
}

/** Choose light or dark: remembered, applied at once, and told to every toggle and menu on the page. */
export function chooseTheme(next: ThemeChoice) {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // ignore — the choice holds for this page and is simply not remembered
  }
  document.documentElement.classList.toggle("dark", next === "dark");
  window.dispatchEvent(new Event(CHANGED));
}

/**
 * Which theme is showing: the person's choice, else the default, else the computer's setting. Null
 * only on the server and while hydrating when the default is "system", because only the browser
 * knows the computer's setting.
 *
 * ## Why this is a store rather than `useState`
 *
 * The choice lives in `localStorage`, which exists only in the browser. Seeding `useState` from it
 * makes the first client render disagree with the server's, which React reports as a hydration
 * mismatch (`aria-pressed` differing on the buttons). `useSyncExternalStore` uses the server
 * snapshot for the server and the hydrating render, so the two agree by construction, then
 * re-renders from the real value.
 */
export function useThemeChoice(defaultTheme: string): ThemeChoice | null {
  const fallback = isChoice(defaultTheme) ? defaultTheme : null;

  const getSnapshot = useCallback((): ThemeChoice | null => {
    const chosen = stored();
    if (isChoice(chosen)) return chosen;
    return fallback ?? (window.matchMedia(DARK_QUERY).matches ? "dark" : "light");
  }, [fallback]);
  const getServerSnapshot = useCallback((): ThemeChoice | null => fallback, [fallback]);
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Until somebody chooses, a "system" default follows the computer when it switches.
  useEffect(() => {
    if (fallback) return;
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => {
      if (!isChoice(stored())) document.documentElement.classList.toggle("dark", media.matches);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [fallback]);

  return theme;
}

export function ThemeToggle({ defaultTheme }: { defaultTheme: string }) {
  const theme = useThemeChoice(defaultTheme);
  return (
    <div className="flex items-center gap-0.5 rounded-base border border-line bg-surface-sunken p-0.5">
      {THEME_CHOICES.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          onClick={() => chooseTheme(value)}
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
