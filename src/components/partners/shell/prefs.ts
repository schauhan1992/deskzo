"use client";

import { useSyncExternalStore } from "react";

/**
 * The partner portal's per-viewer preferences, in this browser's localStorage and never sent anywhere: the
 * collapsed sidebar and which nav groups are folded. Read through `useSyncExternalStore` with a
 * server snapshot, as the CMS's and the console's are (src/components/console/kit/prefs.ts, where the
 * reasoning is written out): the server renders the default, the browser what is stored, and React
 * reconciles the two without a hydration error. The portal lives on its own host, so these keys are its
 * own even where the names look alike.
 */
const SIDEBAR_KEY = "wroffy-partners-sidebar-collapsed";
const GROUPS_KEY = "wroffy-partners-nav-closed";

function makeStore<T>(key: string, parse: (raw: string | null) => T, serverValue: T) {
  let lastRaw: string | null | undefined;
  let lastValue: T = serverValue;
  return {
    subscribe(onChange: () => void) {
      window.addEventListener("storage", onChange);
      window.addEventListener(key, onChange);
      return () => {
        window.removeEventListener("storage", onChange);
        window.removeEventListener(key, onChange);
      };
    },
    get(): T {
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(key);
      } catch {
        return serverValue;
      }
      if (raw !== lastRaw) {
        lastRaw = raw;
        lastValue = parse(raw);
      }
      return lastValue;
    },
    server: () => serverValue,
    write(value: string) {
      try {
        localStorage.setItem(key, value);
      } catch {
        // Private windows and blocked site data: the choice holds for this page only.
      }
      window.dispatchEvent(new Event(key));
    },
  };
}

const NONE: string[] = [];

const sidebarStore = makeStore(SIDEBAR_KEY, (raw) => raw === "true", false);
const closedStore = makeStore<string[]>(
  GROUPS_KEY,
  (raw) => {
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(parsed)) return NONE;
      const groups = parsed.filter((g): g is string => typeof g === "string" && g.length > 0 && g.length <= 32).slice(0, 20);
      return groups.length ? groups : NONE;
    } catch {
      return NONE;
    }
  },
  NONE,
);

const setCollapsed = (v: boolean) => sidebarStore.write(String(v === true));
const setClosed = (v: string[]) => closedStore.write(JSON.stringify([...new Set(v)].slice(0, 20)));

export function usePartnerSidebarCollapsed(): [boolean, (v: boolean) => void] {
  return [useSyncExternalStore(sidebarStore.subscribe, sidebarStore.get, sidebarStore.server), setCollapsed];
}

/** The nav groups folded away in this browser (every group is open until somebody folds one). */
export function usePartnerClosedNavGroups(): [string[], (v: string[]) => void] {
  return [useSyncExternalStore(closedStore.subscribe, closedStore.get, closedStore.server), setClosed];
}
