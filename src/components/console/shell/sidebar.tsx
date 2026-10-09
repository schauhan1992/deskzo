"use client";

import { useEffect, useId } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useOpenNavGroups } from "@/components/console/kit/prefs";
import { IconButton } from "@/components/ui/icon-button";
import { useModalA11y } from "@/components/ui/use-modal-a11y";
import { RailFlyout } from "@/components/ui/rail-flyout";
import { CONSOLE_PAGES, NAV_GROUPS, activePageKey, type ConsolePage, type ConsolePageKey, type NavGroup } from "@/lib/console-shared/nav";
import type { NavBadge, NavCounts, PlatformEnv } from "@/lib/console-shared/types";
import { cn } from "@/lib/utils";
import { NavIcon } from "./nav-icons";

const BADGE_TONE: Record<NavBadge["tone"], string> = {
  danger: "bg-danger-bg text-danger",
  warning: "bg-warning-bg text-warning",
  info: "bg-info-bg text-info",
  muted: "bg-surface-sunken text-muted",
};

const DOT_TONE: Record<NavBadge["tone"], string> = {
  danger: "bg-danger",
  warning: "bg-warning",
  info: "bg-info",
  muted: "bg-subtle",
};

/** A badge worth drawing: a dot, or a count above zero. */
const shown = (badge: NavBadge | undefined): badge is NavBadge => !!badge && (badge.count === null || badge.count > 0);

/**
 * A link's count or dot. Hidden from assistive tech: its words are already in the link's name
 * ("Provisioning, 2 failed setups"), so it is neither read twice nor a tab stop of its own. In the
 * rail there is no room for a number, so every badge is a dot on the icon's corner.
 */
function Badge({ badge, rail }: { badge: NavBadge; rail: boolean }) {
  if (rail || badge.count === null) {
    return (
      <span
        aria-hidden="true"
        className={cn("h-2 w-2 shrink-0 rounded-full", DOT_TONE[badge.tone], badge.pulse && "animate-pulse", rail ? "absolute top-1 right-2.5" : "ml-auto")}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn("ml-auto min-w-5 shrink-0 rounded-full px-1.5 text-center text-[11px] leading-5 font-semibold tabular-nums", BADGE_TONE[badge.tone])}
    >
      {badge.count > 99 ? "99+" : badge.count}
    </span>
  );
}

function NavItem({ page, active, badge, rail, onNavigate }: { page: ConsolePage; active: boolean; badge?: NavBadge; rail: boolean; onNavigate?: () => void }) {
  const name = badge ? `${page.label}, ${badge.label}` : page.label;
  return (
    <Link
      href={page.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      // In the rail the label is not on screen, so the name and the hover text carry it.
      aria-label={rail || badge ? name : undefined}
      title={rail ? name : undefined}
      className={cn(
        "relative flex h-8 items-center gap-2.5 rounded-base px-2.5 text-[13px] font-medium transition-colors duration-150",
        rail && "justify-center px-0",
        active ? "bg-brand-subtle text-brand" : "text-muted hover:bg-surface-sunken hover:text-text",
      )}
    >
      {/* A brand-coloured rail reads as "you are here" without shouting. */}
      {active && <span aria-hidden="true" className="absolute top-1/2 left-0 h-5 w-0.5 -translate-y-1/2 rounded-r bg-brand" />}
      <NavIcon name={page.icon} />
      {!rail && <span className="min-w-0 flex-1 truncate">{page.label}</span>}
      {badge && <Badge badge={badge} rail={rail} />}
    </Link>
  );
}

function Brand({ rail, onNavigate }: { rail: boolean; onNavigate?: () => void }) {
  return (
    <Link href="/" onClick={onNavigate} aria-label={rail ? "Deskzo console, Overview" : undefined} className="flex min-w-0 items-center gap-2.5 rounded-base">
      <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand text-[11px] font-bold text-brand-contrast">
        W
      </span>
      {!rail && <span className="truncate text-sm font-semibold text-text">Deskzo console</span>}
    </Link>
  );
}

/**
 * The console's navigation (spec §1.4): the registry's pages this role may open, in five groups, with
 * the badge counts the layout worked out. Three shapes of the same list — the full sidebar, the icon
 * rail (per viewer, remembered) and, under `md`, a drawer.
 *
 * Group headings collapse their group and are remembered per viewer; the group holding the page you
 * are on cannot be closed, so the sidebar always shows where you are. Closed groups are unmounted
 * rather than hidden, so their links are not in the tab order. Never `localStorage` during render:
 * the open groups come through `useOpenNavGroups` (a `useSyncExternalStore` read with a server
 * snapshot), as the collapsed rail does in the shell.
 */
export function Sidebar({
  visibleKeys,
  counts,
  env,
  schema,
  collapsed,
  onToggleCollapsed,
  mobileOpen,
  onMobileClose,
}: {
  visibleKeys: ConsolePageKey[];
  counts: NavCounts;
  env: PlatformEnv;
  schema: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
}) {
  const pathname = usePathname() ?? "/";
  const activeKey = activePageKey(pathname);
  const [openGroups, setOpenGroups] = useOpenNavGroups();
  const navId = useId();
  // Escape, the scroll lock, the focus trap and returning focus to the menu button — use-modal-a11y.ts.
  const { titleId, containerRef } = useModalA11y(mobileOpen, onMobileClose);

  // Widening the window past `md` while the drawer is open would leave the page scroll-locked behind
  // a drawer that is no longer drawn. Closed from the media query's own callback, never the effect body.
  useEffect(() => {
    if (!mobileOpen) return;
    const wide = window.matchMedia("(min-width: 768px)");
    const onChange = () => {
      if (wide.matches) onMobileClose();
    };
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, [mobileOpen, onMobileClose]);

  const pages = CONSOLE_PAGES.filter((page) => page.inNav && visibleKeys.includes(page.key));
  const sections = NAV_GROUPS.map((group) => ({ ...group, pages: pages.filter((page) => page.group === group.key) })).filter((s) => s.pages.length > 0);
  const activeGroup = pages.find((page) => page.key === activeKey)?.group ?? null;

  // Never set in this browser: everything open. Seventeen links fit on a screen, and somebody new to
  // the console should see all of it before choosing what to fold away.
  const isOpen = (group: NavGroup) => group === activeGroup || openGroups === null || openGroups.includes(group);

  function toggleGroup(group: NavGroup) {
    const base = openGroups ?? sections.map((s) => s.key);
    setOpenGroups(base.includes(group) ? base.filter((g) => g !== group) : [...base, group]);
  }

  const footerText = `${env.label} · schema ${schema}`;

  function renderNav(rail: boolean, where: "side" | "drawer", onNavigate?: () => void) {
    return (
      <nav aria-label="Console" className="flex-1 space-y-0.5 overflow-x-hidden overflow-y-auto px-2.5 py-3">
        {sections.map((section) => {
          const items = section.pages.map((page) => {
            const badge = page.badge ? counts.badges[page.badge] : undefined;
            return <NavItem key={page.key} page={page} active={page.key === activeKey} badge={shown(badge) ? badge : undefined} rail={rail} onNavigate={onNavigate} />;
          });

          // In the rail, a group of several pages is one button that opens them, named, beside it
          // (src/components/ui/rail-flyout.tsx) rather than a run of unlabelled icons.
          if (rail && section.label && section.pages.length > 1) {
            return (
              <div key={section.key} className="mt-2 border-t border-line pt-2">
                <RailFlyout
                  label={section.label}
                  icon={<NavIcon name={section.pages[0]!.icon} />}
                  className="h-8"
                  onNavigate={onNavigate}
                  items={section.pages.map((page) => {
                    const badge = page.badge ? counts.badges[page.badge] : undefined;
                    return {
                      key: page.key,
                      href: page.href,
                      label: page.label,
                      icon: <NavIcon name={page.icon} />,
                      active: page.key === activeKey,
                      badge: shown(badge) ? { text: badge.count === null ? "•" : badge.count > 99 ? "99+" : String(badge.count), label: badge.label } : undefined,
                    };
                  })}
                />
              </div>
            );
          }
          // Overview and Alerts have no heading; in the rail no group has one — a rule separates them.
          if (!section.label || rail) {
            return (
              <div key={section.key} className={cn("space-y-0.5", rail && section.label && "mt-2 border-t border-line pt-2")}>
                {items}
              </div>
            );
          }

          const open = isOpen(section.key);
          const locked = section.key === activeGroup;
          const panelId = `${navId}-${where}-${section.key}`;
          return (
            <div key={section.key}>
              <button
                type="button"
                onClick={() => toggleGroup(section.key)}
                disabled={locked}
                aria-expanded={open}
                aria-controls={open ? panelId : undefined}
                title={locked ? `${section.label} — the section you're in` : undefined}
                className={cn(
                  "mt-4 mb-1 flex w-full items-center justify-between rounded-base px-2.5 py-0.5 text-[10px] font-semibold tracking-[0.08em] text-subtle uppercase transition-colors",
                  locked ? "cursor-default" : "hover:text-muted",
                )}
              >
                <span className="truncate">{section.label}</span>
                {/* None on the section you are in: a chevron that does nothing is worse than none. */}
                {!locked && <ChevronRight aria-hidden="true" className={cn("h-3 w-3 shrink-0 transition-transform duration-150", open && "rotate-90")} />}
              </button>
              {open && (
                <div id={panelId} className="space-y-0.5">
                  {items}
                </div>
              )}
            </div>
          );
        })}
      </nav>
    );
  }

  return (
    <>
      <div
        className={cn(
          "hidden border-r border-line bg-surface md:sticky md:top-0 md:flex md:h-screen md:shrink-0 md:flex-col md:transition-[width] md:duration-200 md:ease-out",
          collapsed ? "md:w-16" : "md:w-[232px]",
        )}
      >
        <div className={cn("flex h-14 shrink-0 items-center border-b border-line px-4", collapsed && "justify-center px-2")}>
          <Brand rail={collapsed} />
        </div>
        {renderNav(collapsed, "side")}
        <div className={cn("flex shrink-0 items-center gap-2 border-t border-line p-2", collapsed && "justify-center")}>
          {!collapsed && (
            <p title={footerText} className="min-w-0 flex-1 truncate px-2.5 text-[11px] text-subtle">
              {footerText}
            </p>
          )}
          <IconButton
            icon={collapsed ? PanelLeftOpen : PanelLeftClose}
            label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={onToggleCollapsed}
          />
        </div>
      </div>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div aria-hidden="true" className="absolute inset-0 animate-fade-in bg-black/50" onClick={onMobileClose} />
          <div
            ref={containerRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="absolute inset-y-0 left-0 flex w-[272px] max-w-[85vw] animate-slide-in-left flex-col border-r border-line bg-surface shadow-lg"
          >
            <h2 id={titleId} className="sr-only">
              Navigation
            </h2>
            <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line px-4">
              <Brand rail={false} onNavigate={onMobileClose} />
              <IconButton icon={X} label="Close navigation" onClick={onMobileClose} />
            </div>
            {renderNav(false, "drawer", onMobileClose)}
            <p className="shrink-0 truncate border-t border-line px-4 py-2.5 text-[11px] text-subtle">{footerText}</p>
          </div>
        </div>
      )}
    </>
  );
}
