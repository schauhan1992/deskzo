"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { NoticeProvider } from "@/components/console/kit/notice";
import type { PlatformEnv } from "@/lib/console-shared/types";
import { CMS_PAGES, type CmsPageKey } from "@/lib/cms/nav";
import type { CmsCaps, CmsRole } from "@/lib/cms/types";
import { cn } from "@/lib/utils";
import { useCmsSidebarCollapsed } from "./prefs";
import { CmsShortcutsDialog } from "./shortcuts-dialog";
import { CmsSidebar, type CmsNavBadges } from "./sidebar";
import { CmsTopBar } from "./top-bar";

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
 * The website CMS's frame, on cms.<domain> only (src/proxy.ts rewrites there into
 * src/app/platform-cms and refuses the folder anywhere else): sidebar, top bar, the page, and the
 * one keyboard listener — `g` then a letter to go to a page, `?` for the list.
 *
 * The server layout works out everything shown here from the session — who is signed in, the pages
 * their role may open, what they may do, the Leads count, which installation this is and where the
 * public site lives — and passes it as plain props. Each page checks the session itself as well:
 * the App Router keeps this layout across navigations without running it again.
 *
 * The page's outcome notices ("Settings published.") come from the console's `NoticeProvider`, so
 * the console kit's `PageHeader`, `ActionButton` and dialogs work here unchanged.
 */
export function CmsShell({
  me,
  env,
  caps,
  visibleKeys,
  badges,
  site,
  children,
}: {
  me: { id: string; name: string; email: string; role: CmsRole };
  env: PlatformEnv;
  caps: CmsCaps;
  visibleKeys: CmsPageKey[];
  badges: CmsNavBadges;
  site: { url: string; host: string; name: string };
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const [collapsed, setCollapsed] = useCmsSidebarCollapsed();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // A new page closes whatever was open over the last one — adjusted during render, so the old
  // overlay never paints over the new page.
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setMobileNavOpen(false);
    setShortcutsOpen(false);
  }

  const openMobileNav = useCallback(() => setMobileNavOpen(true), []);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);
  const toggleCollapsed = useCallback(() => setCollapsed(!collapsed), [collapsed, setCollapsed]);

  /** What the one listener needs, kept current without re-adding it on every render. */
  const state = useRef({ shortcutsOpen, mobileNavOpen, visibleKeys });
  useEffect(() => {
    state.current = { shortcutsOpen, mobileNavOpen, visibleKeys };
  });
  const gPressedAt = useRef(0);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || e.repeat) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const current = state.current;
      if (current.shortcutsOpen || current.mobileNavOpen) return;
      // A page's own dialog is open: the keyboard is its.
      if (document.querySelector('[aria-modal="true"]')) return;
      if (isTyping(e.target)) return;
      if (e.target instanceof Element && e.target.closest(OWNS_LETTERS)) return;

      const pressedAt = gPressedAt.current;
      gPressedAt.current = 0;
      if (pressedAt && Date.now() - pressedAt <= G_WINDOW_MS) {
        const page = CMS_PAGES.find((p) => p.shortcut === e.key && current.visibleKeys.includes(p.key));
        if (page) {
          e.preventDefault();
          router.push(page.href);
        }
        return;
      }
      if (e.key === "g") {
        gPressedAt.current = Date.now();
      } else if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  return (
    <div className="flex min-h-screen bg-bg">
      <a
        href="#cms-main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-40 focus:rounded-base focus:border focus:border-line focus:bg-surface-raised focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-text focus:shadow-lg"
      >
        Skip to content
      </a>
      {/* Outside production, a line of colour along the very top: nobody should mistake staging for the real site. */}
      {env.key !== "production" && (
        <div aria-hidden="true" className={cn("pointer-events-none fixed inset-x-0 top-0 z-30 h-0.5 w-full", env.key === "staging" ? "bg-warning" : "bg-info")} />
      )}

      <CmsSidebar
        visibleKeys={visibleKeys}
        badges={badges}
        env={env}
        siteName={site.name}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        mobileOpen={mobileNavOpen}
        onMobileClose={closeMobileNav}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <CmsTopBar me={me} env={env} caps={caps} site={site} onOpenMobileNav={openMobileNav} onOpenShortcuts={openShortcuts} />
        <NoticeProvider resetKey={pathname}>
          <main id="cms-main" tabIndex={-1} className="mx-auto w-full max-w-[1440px] flex-1 animate-fade-rise px-4 py-6 outline-none md:px-6 md:py-8">
            {children}
          </main>
        </NoticeProvider>
      </div>

      <CmsShortcutsDialog open={shortcutsOpen} onClose={closeShortcuts} visibleKeys={visibleKeys} />
    </div>
  );
}
