"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import {
  FAVOURITES_STORAGE_KEY,
  MENU_ENTRIES,
  SHORTCUTS_STORAGE_KEY,
  shortcutFor,
  typesText,
  type MenuKey,
  type Shortcut,
  type ShortcutCommand,
} from "@/lib/shortcuts/busy";
import type { VisibleNavSection } from "@/lib/navigation";
import { SIDE_RAIL_STORAGE_KEY, type SideRailTool } from "@/lib/side-rail";
import { pickAccounts, pickItems } from "@/actions/quick-pick";
import { pageHandlerFor, SHORTCUT_NOTICE_EVENT } from "@/components/shortcuts/use-shortcuts";
import { PickList, type PickEntry } from "@/components/shortcuts/pick-list";
import { CalculatorDialog } from "@/components/shortcuts/calculator-dialog";
import { ShortcutsList } from "@/components/shortcuts/shortcuts-list";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useWording } from "@/components/terms/wording-provider";
import { slot } from "@/lib/terms/dictionary";

/**
 * BUSY's shortcut keys, everywhere in the app (owner, 22 Oct 2026) — src/lib/shortcuts/busy.ts says what each
 * key is. One listener for the whole app: the open page's own keys first (a voucher's form saves on F2,
 * `useShortcuts`), then the global ones — a page, a menu, a picker, the calculator.
 *
 * A key only opens what the person's own menu has (the `navigation` the layout built for them). That is the
 * menu's courtesy, not the security: every page and action it leads to asks again on the server, as always.
 *
 * Left alone: plain typing in a field (F-keys and Alt/Ctrl combinations still work there — that's where F2
 * saves), any dialog that isn't ours, and everything when the person has switched BUSY's keys off ("?" turns
 * them back on).
 */

type Overlay =
  | { kind: "list" }
  | { kind: "calculator" }
  | { kind: "menu"; menu: MenuKey }
  | { kind: "picker"; picker: "account-ledger" | "item" | "item-ledger" }
  | { kind: "confirm"; command: "sign-out" | "lock" };

/** A string-set kept in localStorage, read the way React wants a browser-only value read (see sidebar.tsx). */
function storeOf<T>(key: string, parse: (raw: string | null) => T, server: T) {
  let lastRaw: string | null | undefined;
  let last = server;
  return {
    subscribe(change: () => void) {
      window.addEventListener("storage", change);
      window.addEventListener(key, change);
      return () => {
        window.removeEventListener("storage", change);
        window.removeEventListener(key, change);
      };
    },
    get(): T {
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(key);
      } catch {
        return server;
      }
      if (raw !== lastRaw) {
        lastRaw = raw;
        last = parse(raw);
      }
      return last;
    },
    server: () => server,
    write(value: string | null) {
      try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch {
        // Not remembered in a private window; the choice still holds for this page.
      }
      window.dispatchEvent(new Event(key));
    },
  };
}

const enabledStore = storeOf(SHORTCUTS_STORAGE_KEY, (raw) => raw !== "off", true);
const NO_FAVOURITES: string[] = [];
const favouritesStore = storeOf<string[]>(
  FAVOURITES_STORAGE_KEY,
  (raw) => {
    try {
      const list = JSON.parse(raw ?? "[]");
      return Array.isArray(list) ? list.filter((h): h is string => typeof h === "string" && h.startsWith("/")).slice(0, 50) : NO_FAVOURITES;
    } catch {
      return NO_FAVOURITES;
    }
  },
  NO_FAVOURITES,
);

/** Opens one of the tools down the right-hand edge, as its own button does. */
function openRailTool(tool: SideRailTool) {
  try {
    localStorage.setItem(SIDE_RAIL_STORAGE_KEY, tool);
  } catch {
    // The rail reads the event as well.
  }
  window.dispatchEvent(new Event(SIDE_RAIL_STORAGE_KEY));
}

const MENU_TITLES: Record<MenuKey, string> = {
  main: "Main menu",
  masters: "New master",
  administration: "Administration",
  transactions: "Transactions",
  display: "Display — reports",
  printing: "Printing",
  help: "Help",
  favourites: "Favourites",
};

/** The links of the display menu that aren't in a Reports part — books and returns people read like reports. */
const ALSO_REPORTS = ["/accounting/cash-book", "/accounting/gst", "/accounting/tds", "/receivables", "/payables", "/accounting/books"];

export function ShortcutsProvider({ navigation }: { navigation: VisibleNavSection[] }) {
  const router = useRouter();
  const wording = useWording();
  const enabled = useSyncExternalStore(enabledStore.subscribe, enabledStore.get, enabledStore.server);
  const favourites = useSyncExternalStore(favouritesStore.subscribe, favouritesStore.get, favouritesStore.server);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);

  // The person's own links, by address, with the name the sidebar gives them.
  const links = useMemo(
    () =>
      navigation.flatMap((section) =>
        section.items.map((item) => ({
          href: item.href,
          label: item.term ? slot(wording, item.label, item.term.key, item.term.template) : item.label,
          group: section.group,
          section: item.section ?? null,
        })),
      ),
    [navigation, wording],
  );
  const has = useCallback((href: string) => links.some((l) => l.href === href), [links]);

  const say = useCallback((text: string) => setNotice({ id: Date.now(), text }), []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2800);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const onNotice = (event: Event) => event instanceof CustomEvent && typeof event.detail === "string" && say(event.detail);
    window.addEventListener(SHORTCUT_NOTICE_EVENT, onNotice);
    return () => window.removeEventListener(SHORTCUT_NOTICE_EVENT, onNotice);
  }, [say]);

  const runCommand = useCallback(
    (command: ShortcutCommand, label: string) => {
      switch (command) {
        case "help-panel":
          return openRailTool("help");
        case "notes-panel":
          return has("/notes") ? openRailTool("notes") : say(`${label} — Sticky notes aren't open to you.`);
        case "shortcuts":
          return setOverlay({ kind: "list" });
        case "calculator":
          return setOverlay({ kind: "calculator" });
        case "print":
          return window.print();
        case "sign-out":
        case "lock":
          return setOverlay({ kind: "confirm", command });
        case "pick-account-ledger":
          return has("/accounting/trial-balance") ? setOverlay({ kind: "picker", picker: "account-ledger" }) : say(`${label} — the books' reports aren't open to you.`);
        case "pick-item":
          return has("/items") ? setOverlay({ kind: "picker", picker: "item" }) : say(`${label} — Items aren't open to you.`);
        case "pick-item-ledger":
          return has("/items/stock-reports") ? setOverlay({ kind: "picker", picker: "item-ledger" }) : say(`${label} — stock reports aren't open to you.`);
        case "focus-menu-search":
          return document.querySelector<HTMLInputElement>('input[aria-label="Find a page in the menu"]')?.focus();
        default:
          if (command.startsWith("menu:")) return setOverlay({ kind: "menu", menu: command.slice(5) as MenuKey });
      }
    },
    [has, say],
  );

  const run = useCallback(
    (s: Shortcut) => {
      if (s.target.kind === "command") return runCommand(s.target.command, s.label);
      if (s.target.kind !== "go") return;
      const needs = Array.isArray(s.target.needs) ? (s.target.needs as string[]) : [s.target.needs as string];
      const reachable = needs.find(has);
      if (!reachable) return say(`${s.label} — not open to you.`);
      router.push(reachable === needs[0] ? s.target.href : reachable);
    },
    [has, router, runCommand, say],
  );

  // Read by the listener without re-subscribing it on every render.
  const live = useRef({ enabled, overlay, run });
  useEffect(() => {
    live.current = { enabled, overlay, run };
  });

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.repeat || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      const isList = !typing && event.key === "?" && !event.ctrlKey && !event.altKey && !event.metaKey;
      const { enabled, overlay, run } = live.current;
      // Our own list, menu or calculator handles its own keys; somebody else's dialog, likewise.
      if (overlay || document.querySelector('[aria-modal="true"]')) return;
      if (isList) {
        event.preventDefault();
        setOverlay({ kind: "list" });
        return;
      }
      if (!enabled || (typing && typesText(event))) return;
      const page = pageHandlerFor(event);
      if (page) {
        event.preventDefault();
        event.stopPropagation();
        page();
        return;
      }
      const found = shortcutFor(event, "global");
      if (!found) return;
      event.preventDefault();
      event.stopPropagation();
      run(found);
    }
    // Capture: ahead of any field's own handling, and of the browser's (F1 help, F3 find, Ctrl+D bookmark).
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const close = useCallback(() => setOverlay(null), []);
  const go = useCallback(
    (entry: PickEntry) => {
      setOverlay(null);
      if (entry.run) entry.run();
      else if (entry.href) router.push(entry.href);
    },
    [router],
  );
  const toggleFavourite = useCallback((href: string) => {
    const current = favouritesStore.get();
    favouritesStore.write(JSON.stringify(current.includes(href) ? current.filter((h) => h !== href) : [...current, href]));
  }, []);

  const menuEntries = useCallback(
    (menu: MenuKey): PickEntry[] => {
      const where = (l: (typeof links)[number]) => [l.group, l.section].filter(Boolean).join(" › ");
      const asEntry = (l: (typeof links)[number]): PickEntry => ({ key: l.href, label: l.label, hint: where(l), href: l.href });
      switch (menu) {
        case "main":
          return links.map(asEntry);
        case "display":
          return links.filter((l) => l.section === "Reports" || l.group === "Reports" || ALSO_REPORTS.includes(l.href)).map(asEntry);
        case "administration":
          return links.filter((l) => l.group === "Administration" || l.section === "Settings" || l.href === "/settings/data").map(asEntry);
        case "favourites":
          return favourites.map((href) => links.find((l) => l.href === href)).filter((l): l is (typeof links)[number] => !!l).map(asEntry);
        case "help":
          return [
            { key: "help", label: "Help for this page", hint: "F1", run: () => openRailTool("help") },
            { key: "shortcuts", label: "Keyboard shortcuts", hint: "?", run: () => setOverlay({ kind: "list" }) },
            { key: "updates", label: "What's new", run: () => openRailTool("updates") },
            { key: "videos", label: "Video walkthroughs", run: () => openRailTool("videos") },
          ];
        default:
          return MENU_ENTRIES[menu].filter((e) => has(e.needs)).map((e) => ({ key: e.href, label: e.label, hint: e.hint, href: e.href }));
      }
    },
    [favourites, has, links],
  );

  const searchAccounts = useCallback(
    async (term: string): Promise<PickEntry[]> =>
      (await pickAccounts(term)).map((a) => ({ key: a.id, label: a.name, hint: `${a.code}${a.active ? "" : " · closed"}`, href: `/accounting/ledger/${a.id}` })),
    [],
  );
  const searchItems = useCallback(
    async (term: string): Promise<PickEntry[]> =>
      (await pickItems(term)).map((i) => ({ key: i.id, label: i.name, hint: `${i.sku}${i.active ? "" : " · inactive"}`, href: `/items/${i.id}` })),
    [],
  );
  const searchStockItems = useCallback(
    async (term: string): Promise<PickEntry[]> =>
      (await pickItems(term, { stockOnly: true })).map((i) => ({ key: i.id, label: i.name, hint: i.sku, href: `/items/stock-reports?report=ledger&item=${i.id}` })),
    [],
  );

  return (
    <>
      {overlay?.kind === "list" && (
        <ShortcutsList open onClose={close} enabled={enabled} onEnabled={(on) => enabledStore.write(on ? null : "off")} />
      )}
      {overlay?.kind === "calculator" && <CalculatorDialog open onClose={close} />}
      {overlay?.kind === "menu" && (
        <PickList
          key={overlay.menu}
          open
          title={MENU_TITLES[overlay.menu]}
          placeholder="Type to find…"
          entries={menuEntries(overlay.menu)}
          emptyText={overlay.menu === "favourites" ? "Nothing starred yet — star a page in the main menu (Ctrl + Alt + M)." : "Nothing here is open to you."}
          favourites={new Set(favourites)}
          onToggleFavourite={toggleFavourite}
          onChoose={go}
          onClose={close}
        />
      )}
      {overlay?.kind === "picker" && (
        <PickList
          key={overlay.picker}
          open
          title={overlay.picker === "account-ledger" ? "Account ledger" : overlay.picker === "item" ? "Item summary" : "Stock ledger"}
          placeholder={overlay.picker === "account-ledger" ? "Account name or code…" : "Item name or SKU…"}
          search={overlay.picker === "account-ledger" ? searchAccounts : overlay.picker === "item" ? searchItems : searchStockItems}
          emptyText="Nothing matches."
          onChoose={go}
          onClose={close}
        />
      )}
      {overlay?.kind === "confirm" && (
        <Dialog open onClose={close} title={overlay.command === "lock" ? "Lock Deskzo" : "Switch user"}>
          <p className="text-sm text-muted">
            {overlay.command === "lock"
              ? "Signs you out now, so nothing is left open on this screen. Anything not yet saved on this page is lost."
              : "Signs you out, so somebody else can sign in. Anything not yet saved on this page is lost."}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close}>
              Stay signed in
            </Button>
            <Button
              type="button"
              autoFocus
              onClick={() => {
                setOverlay(null);
                document.querySelector<HTMLFormElement>("form#deskzo-sign-out")?.requestSubmit();
              }}
            >
              Sign out
            </Button>
          </div>
        </Dialog>
      )}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-6 z-[70] flex justify-center px-4">
        {notice && (
          <p key={notice.id} className="animate-fade-rise rounded-base bg-text px-3 py-2 text-sm text-surface shadow-lg">
            {notice.text}
          </p>
        )}
      </div>
    </>
  );
}
