"use client";

import { useSyncExternalStore } from "react";

/**
 * Per-viewer console preferences, kept in this browser's localStorage and never sent anywhere:
 * table density, the page to land on after signing in, the collapsed sidebar, which nav groups are
 * open, and the last few workspaces opened (the palette's "Recent"). The shell, the auth pages, My
 * account and the palette all read them through here, so each key is spelled once.
 */
export const PREF_KEYS = {
  density: "deskzo-console-density",
  landing: "deskzo-console-landing",
  sidebar: "deskzo-console-sidebar-collapsed",
  navGroups: "deskzo-console-nav-groups",
  recent: "deskzo-console-recent",
} as const;

type Density = "comfortable" | "compact";
type Landing = "overview" | "workspaces";
type RecentWorkspace = { slug: string; name: string };

const RECENT_MAX = 8;
const NAV_GROUPS_MAX = 50;

/**
 * localStorage, read the way React wants a browser-only value read — copied from
 * src/components/layout/sidebar.tsx, where the reasoning is written out in full.
 *
 * In short: a `useState` initializer reads the default on the server and the stored value during
 * hydration, and the two renders disagree. `useSyncExternalStore` takes a server snapshot (the
 * default) and a client snapshot (what is stored) and reconciles them itself. The parsed value is
 * cached against the raw string because a snapshot must be referentially stable — a fresh array on
 * every read re-renders without end.
 */
function makeStore<T>(key: string, parse: (raw: string | null) => T, serverValue: T) {
  let lastRaw: string | null | undefined;
  let lastValue: T = serverValue;
  return {
    subscribe(onChange: () => void) {
      // "storage" covers another tab; the custom event covers this one, which does not fire it.
      window.addEventListener("storage", onChange);
      window.addEventListener(key, onChange);
      return () => {
        window.removeEventListener("storage", onChange);
        window.removeEventListener(key, onChange);
      };
    },
    get(): T {
      let current: string | null = null;
      try {
        current = localStorage.getItem(key);
      } catch {
        // Private windows and blocked site data. The preference is lost, the console is not.
        return serverValue;
      }
      if (current !== lastRaw) {
        lastRaw = current;
        lastValue = parse(current);
      }
      return lastValue;
    },
    server: () => serverValue,
    write(value: string) {
      try {
        localStorage.setItem(key, value);
      } catch {
        // ignore — the preference just will not persist
      }
      window.dispatchEvent(new Event(key));
    },
  };
}

/** A stored JSON value, or `null` when it is missing or not JSON — a corrupt value is a default, not a crash. */
function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

const densityStore = makeStore<Density>(PREF_KEYS.density, (raw) => (raw === "compact" ? "compact" : "comfortable"), "comfortable");
const landingStore = makeStore<Landing>(PREF_KEYS.landing, (raw) => (raw === "workspaces" ? "workspaces" : "overview"), "overview");
const sidebarStore = makeStore(PREF_KEYS.sidebar, (raw) => raw === "true", false);

/**
 * Which nav groups were left open, or `null` when this browser has never said — distinct from "none
 * open", as in the workspace sidebar: somebody who closed every group gets them all closed back,
 * somebody arriving for the first time is not shown a sidebar of nothing but headings.
 */
const navGroupsStore = makeStore<string[] | null>(
  PREF_KEYS.navGroups,
  (raw) => {
    const parsed = parseJson(raw);
    if (!Array.isArray(parsed)) return null;
    return [...new Set(parsed.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 64))].slice(0, NAV_GROUPS_MAX);
  },
  null,
);

/** One empty list for the server and for "nothing stored", so the snapshot never changes identity. */
const NO_RECENT: RecentWorkspace[] = [];

function cleanRecent(value: unknown): RecentWorkspace[] {
  if (!Array.isArray(value)) return NO_RECENT;
  const seen = new Set<string>();
  const out: RecentWorkspace[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { slug, name } = entry as { slug?: unknown; name?: unknown };
    if (typeof slug !== "string" || typeof name !== "string") continue;
    const s = slug.trim().slice(0, 100);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push({ slug: s, name: name.trim().slice(0, 200) || s });
    if (out.length === RECENT_MAX) break;
  }
  return out.length > 0 ? out : NO_RECENT;
}

const recentStore = makeStore<RecentWorkspace[]>(PREF_KEYS.recent, (raw) => cleanRecent(parseJson(raw)), NO_RECENT);

// Setters live at module level, so the functions the hooks hand out never change identity.
const setDensity = (v: Density) => densityStore.write(v === "compact" ? "compact" : "comfortable");
const setLanding = (v: Landing) => landingStore.write(v === "workspaces" ? "workspaces" : "overview");
const setSidebarCollapsed = (v: boolean) => sidebarStore.write(String(v === true));
const setOpenNavGroups = (v: string[]) =>
  navGroupsStore.write(JSON.stringify([...new Set(v.filter((g) => typeof g === "string" && g.length > 0 && g.length <= 64))].slice(0, NAV_GROUPS_MAX)));

/** Table density, applied by the shell as `data-density` on its root. */
export function useDensity(): ["comfortable" | "compact", (v: "comfortable" | "compact") => void] {
  return [useSyncExternalStore(densityStore.subscribe, densityStore.get, densityStore.server), setDensity];
}

/** Where signing in lands: the Overview (default) or the workspace directory. */
export function useLandingPage(): ["overview" | "workspaces", (v: "overview" | "workspaces") => void] {
  return [useSyncExternalStore(landingStore.subscribe, landingStore.get, landingStore.server), setLanding];
}

export function useSidebarCollapsed(): [boolean, (v: boolean) => void] {
  return [useSyncExternalStore(sidebarStore.subscribe, sidebarStore.get, sidebarStore.server), setSidebarCollapsed];
}

/** The open nav groups, or `null` when never set (the sidebar then decides). */
export function useOpenNavGroups(): [string[] | null, (v: string[]) => void] {
  return [useSyncExternalStore(navGroupsStore.subscribe, navGroupsStore.get, navGroupsStore.server), setOpenNavGroups];
}

/** The last workspaces opened, most recent first, at most eight. Empty on the server. */
export function useRecentWorkspaces(): { slug: string; name: string }[] {
  return useSyncExternalStore(recentStore.subscribe, recentStore.get, recentStore.server);
}

/**
 * Puts a workspace at the top of Recent (at most eight, most recent first). For effects and event
 * handlers — never during render. A visit to the workspace already on top, under the same name,
 * writes nothing, so reloading a workspace page does not wake every listener.
 */
export function rememberWorkspace(slug: string, name: string): void {
  if (typeof window === "undefined") return;
  const s = String(slug ?? "").trim().slice(0, 100);
  if (!s) return;
  const n = String(name ?? "").trim().slice(0, 200) || s;
  const current = recentStore.get();
  if (current[0]?.slug === s && current[0].name === n) return;
  const next = [{ slug: s, name: n }, ...current.filter((w) => w.slug !== s)].slice(0, RECENT_MAX);
  recentStore.write(JSON.stringify(next));
}

/** The landing preference read once, for an event handler (after sign-in) rather than a render. */
export function readLandingPage(): "overview" | "workspaces" {
  if (typeof window === "undefined") return "overview";
  return landingStore.get();
}
