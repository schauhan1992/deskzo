"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { consoleNavCounts } from "@/actions/platform/console-shell";
import { NoticeProvider } from "@/components/console/kit/notice";
import { useDensity, useSidebarCollapsed } from "@/components/console/kit/prefs";
import { CONSOLE_PAGES, type ConsolePageKey } from "@/lib/console-shared/nav";
import type { ConsoleRole, NavCounts, PlatformEnv } from "@/lib/console-shared/types";
import { cn } from "@/lib/utils";
import { CommandPalette } from "./command-palette";
import { IdleWarning, announceSessionEnded } from "./idle-warning";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";

/** The sidebar's badges are asked for again this often while the tab is visible. */
const POLL_MS = 60_000;
/**
 * …and only while somebody is at the console. Every read goes through `requireStaff`, which refreshes
 * the session's last-seen time, so a poll that ran regardless would keep an unattended tab signed in
 * for ever and the 30-minute idle limit would never arrive. Two minutes of quiet and the poll stops;
 * the next key or click starts it again.
 */
const ACTIVE_WINDOW_MS = 2 * POLL_MS;
/** `g` then a letter, within this long. */
const G_WINDOW_MS = 1_500;

/** Where a keystroke is text, not a shortcut. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

/** A widget that takes letters itself — a menu's type-ahead, a listbox. */
const OWNS_LETTERS = '[role="menu"], [role="menubar"], [role="listbox"], [role="combobox"], [role="grid"]';

/**
 * The console's frame (spec §1.4, §1.15): sidebar, top bar, the idle warning, the page, and the
 * overlays every page shares — the command palette and the shortcut sheet — with the one keyboard
 * listener that opens them.
 *
 * The server layout computes everything here from the session (role, badge counts, environment,
 * schema) and passes it as plain props. Layouts are not re-run on client navigation, so the counts are
 * refreshed two ways: fresh props on every `router.refresh()` (every console action does one), and a
 * poll of `consoleNavCounts()` every minute while the tab is visible and in use. Whichever answer is
 * newer is shown.
 */
export function ConsoleShell({
  staff,
  env,
  visibleKeys,
  counts,
  schema,
  children,
}: {
  staff: { name: string; email: string; role: ConsoleRole };
  env: PlatformEnv;
  visibleKeys: ConsolePageKey[];
  counts: NavCounts;
  schema: string;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const [density] = useDensity();
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [polled, setPolled] = useState<NavCounts | null>(null);

  // A new page closes whatever was open over the last one (the drawer after a tap on a link, the
  // palette after Back). Adjusted during render, so the old overlay never paints over the new page.
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setMobileNavOpen(false);
    setPaletteOpen(false);
    setShortcutsOpen(false);
  }

  // ISO strings of the same shape compare as the instants they name.
  const live = polled && polled.asOf > counts.asOf ? polled : counts;
  const alertsBadge = live.badges.alerts;
  const alertsTone = alertsBadge?.tone === "danger" || alertsBadge?.tone === "warning" ? alertsBadge.tone : "info";

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);
  const openMobileNav = useCallback(() => setMobileNavOpen(true), []);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
  const toggleCollapsed = useCallback(() => setCollapsed(!collapsed), [collapsed, setCollapsed]);

  // ─── The badge poll ────────────────────────────────────────────────────────────────────────────
  const lastActive = useRef(0);
  useEffect(() => {
    lastActive.current = Date.now();
    const mark = () => {
      lastActive.current = Date.now();
    };
    let inFlight = false;
    /** Refused once: the session is over, and asking again every minute would only be refused again. */
    let ended = false;
    const timer = window.setInterval(() => {
      if (ended || inFlight || document.visibilityState !== "visible") return;
      if (Date.now() - lastActive.current > ACTIVE_WINDOW_MS) return;
      inFlight = true;
      consoleNavCounts()
        .then(
          (result) => {
            if (result.ok) {
              setPolled(result.data);
              return;
            }
            // Refused: signed out elsewhere, switched off, or timed out. The idle banner says so.
            ended = true;
            announceSessionEnded();
          },
          // The network, not the session — the next minute asks again.
          () => {},
        )
        .finally(() => {
          inFlight = false;
        });
    }, POLL_MS);
    window.addEventListener("pointerdown", mark, true);
    window.addEventListener("keydown", mark, true);
    window.addEventListener("wheel", mark, { passive: true });
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pointerdown", mark, true);
      window.removeEventListener("keydown", mark, true);
      window.removeEventListener("wheel", mark);
    };
  }, []);

  // ─── The keyboard ──────────────────────────────────────────────────────────────────────────────
  /** What the one listener needs to know, kept current without re-adding it on every render. */
  const shortcutState = useRef({ paletteOpen, shortcutsOpen, mobileNavOpen, visibleKeys });
  useEffect(() => {
    shortcutState.current = { paletteOpen, shortcutsOpen, mobileNavOpen, visibleKeys };
  });
  /** When `g` was pressed, or 0. */
  const gPressedAt = useRef(0);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || e.repeat) return;
      const state = shortcutState.current;
      const ours = state.paletteOpen || state.shortcutsOpen || state.mobileNavOpen;
      // A page's own dialog (a confirmation) is open: the keyboard is its, not the shell's.
      const otherModal = !ours && document.querySelector('[aria-modal="true"]') !== null;

      // Ctrl/⌘ K works from anywhere, a text field included — and closes the palette again.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        if (otherModal) return;
        e.preventDefault();
        gPressedAt.current = 0;
        setShortcutsOpen(false);
        setMobileNavOpen(false);
        setPaletteOpen((open) => !open);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (ours || otherModal || isTyping(e.target)) return;
      if (e.target instanceof Element && e.target.closest(OWNS_LETTERS)) return;

      const pressedAt = gPressedAt.current;
      gPressedAt.current = 0;
      if (pressedAt && Date.now() - pressedAt <= G_WINDOW_MS) {
        // Role-filtered: "g b" does nothing for somebody who cannot open Billing.
        const page = CONSOLE_PAGES.find((p) => p.shortcut === e.key && state.visibleKeys.includes(p.key));
        if (page) {
          e.preventDefault();
          router.push(page.href);
        }
        return;
      }

      switch (e.key) {
        case "g":
          gPressedAt.current = Date.now();
          return;
        case "/":
          e.preventDefault();
          setPaletteOpen(true);
          return;
        case "?":
          e.preventDefault();
          setShortcutsOpen(true);
          return;
        case "f": {
          // The list's own search box (kit SearchField), when this page has one on screen.
          const field = Array.from(document.querySelectorAll<HTMLElement>("[data-console-search]")).find((el) => el.getClientRects().length > 0);
          if (!field) return;
          e.preventDefault();
          field.focus();
          if (field instanceof HTMLInputElement) field.select();
          return;
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  return (
    <div data-density={density} className="flex min-h-screen bg-bg">
      <a
        href="#console-main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-40 focus:rounded-base focus:border focus:border-line focus:bg-surface-raised focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-text focus:shadow-lg"
      >
        Skip to content
      </a>
      {/* Outside production, a line of colour along the very top: nobody should mistake staging for the real thing. */}
      {env.key !== "production" && (
        <div aria-hidden="true" className={cn("pointer-events-none fixed inset-x-0 top-0 z-30 h-0.5 w-full", env.key === "staging" ? "bg-warning" : "bg-info")} />
      )}

      <Sidebar
        visibleKeys={visibleKeys}
        counts={live}
        env={env}
        schema={schema}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        mobileOpen={mobileNavOpen}
        onMobileClose={closeMobileNav}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          staff={staff}
          env={env}
          alertsOpen={live.alertsOpen}
          alertsTone={alertsTone}
          onOpenPalette={openPalette}
          onOpenShortcuts={openShortcuts}
          onOpenMobileNav={openMobileNav}
        />
        <IdleWarning />
        <NoticeProvider resetKey={pathname}>
          <main id="console-main" tabIndex={-1} className="mx-auto w-full max-w-[1440px] flex-1 animate-fade-rise px-4 py-6 outline-none md:px-6 md:py-8">
            {children}
          </main>
        </NoticeProvider>
      </div>

      <CommandPalette open={paletteOpen} onClose={closePalette} role={staff.role} visibleKeys={visibleKeys} />
      <ShortcutsDialog open={shortcutsOpen} onClose={closeShortcuts} visibleKeys={visibleKeys} />
    </div>
  );
}
