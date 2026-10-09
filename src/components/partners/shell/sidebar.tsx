"use client";

import { useEffect, useId } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Handshake, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { useModalA11y } from "@/components/ui/use-modal-a11y";
import { RailFlyout } from "@/components/ui/rail-flyout";
import type { PlatformEnv } from "@/lib/console-shared/types";
import { PARTNER_NAV_GROUPS, PARTNER_PAGES, activePartnerPageKey, type PartnerNavGroup, type PartnerNavPage, type PartnerPageKey } from "@/lib/partners/nav";
import { cn } from "@/lib/utils";
import { PartnerNavIcon } from "./nav-icons";
import { usePartnerClosedNavGroups } from "./prefs";

function NavItem({ page, active, rail, onNavigate }: { page: PartnerNavPage; active: boolean; rail: boolean; onNavigate?: () => void }) {
  return (
    <Link
      href={page.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      aria-label={rail ? page.label : undefined}
      title={rail ? page.label : undefined}
      className={cn(
        "relative flex h-8 items-center gap-2.5 rounded-base px-2.5 text-[13px] font-medium transition-colors duration-150",
        rail && "justify-center px-0",
        active ? "bg-brand-subtle text-brand" : "text-muted hover:bg-surface-sunken hover:text-text",
      )}
    >
      {active && <span aria-hidden="true" className="absolute top-1/2 left-0 h-5 w-0.5 -translate-y-1/2 rounded-r bg-brand" />}
      <PartnerNavIcon name={page.icon} />
      {!rail && <span className="min-w-0 flex-1 truncate">{page.label}</span>}
    </Link>
  );
}

/**
 * The portal's name at the top of the sidebar, and the way home. The product's own name is not
 * written here: "Partner portal", and under it the public site's configured name.
 */
export function PartnerBrand({ rail, siteName, onNavigate }: { rail: boolean; siteName: string; onNavigate?: () => void }) {
  return (
    <Link href="/" onClick={onNavigate} aria-label={rail ? "Partner portal, Dashboard" : undefined} className="flex min-w-0 items-center gap-2.5 rounded-base">
      <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand text-brand-contrast shadow-sm">
        <Handshake className="h-4 w-4" />
      </span>
      {!rail && (
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-sm font-semibold text-text">Partner portal</span>
          <span className="block truncate text-[11px] text-subtle" title={siteName}>
            {siteName}
          </span>
        </span>
      )}
    </Link>
  );
}

/**
 * The portal's navigation: the registry's pages this user may open (their role, and whether their
 * partner is a distributor), in its groups — Sell, Money, Channel, Company. Three shapes of one list:
 * the full sidebar, the icon rail (per viewer, remembered) and, under `md`, a drawer.
 *
 * Group headings fold their group away, remembered per viewer; the group holding the page you are on
 * cannot be folded, so the sidebar always shows where you are. Folded groups are unmounted rather than
 * hidden, so their links leave the tab order too.
 */
export function PartnerSidebar({
  visibleKeys,
  env,
  siteName,
  collapsed,
  onToggleCollapsed,
  mobileOpen,
  onMobileClose,
}: {
  visibleKeys: PartnerPageKey[];
  env: PlatformEnv;
  siteName: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
}) {
  const pathname = usePathname() ?? "/";
  const activeKey = activePartnerPageKey(pathname);
  const [closedGroups, setClosedGroups] = usePartnerClosedNavGroups();
  const navId = useId();
  const { titleId, containerRef } = useModalA11y(mobileOpen, onMobileClose);

  // Widening past `md` with the drawer open would leave the page scroll-locked behind a drawer that is
  // no longer drawn. Closed from the media query's own callback, never the effect body.
  useEffect(() => {
    if (!mobileOpen) return;
    const wide = window.matchMedia("(min-width: 768px)");
    const onChange = () => {
      if (wide.matches) onMobileClose();
    };
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, [mobileOpen, onMobileClose]);

  const pages = PARTNER_PAGES.filter((page) => page.inNav && visibleKeys.includes(page.key));
  const sections = PARTNER_NAV_GROUPS.map((group) => ({ ...group, pages: pages.filter((page) => page.group === group.key) })).filter((s) => s.pages.length > 0);
  const activeGroup = pages.find((page) => page.key === activeKey)?.group ?? null;
  const isOpen = (group: PartnerNavGroup) => group === activeGroup || !closedGroups.includes(group);

  function toggleGroup(group: PartnerNavGroup) {
    setClosedGroups(closedGroups.includes(group) ? closedGroups.filter((g) => g !== group) : [...closedGroups, group]);
  }

  const footerText = `${env.label} · Partner portal`;

  function renderNav(rail: boolean, where: "side" | "drawer", onNavigate?: () => void) {
    return (
      <nav aria-label="Partner portal" className="flex-1 space-y-0.5 overflow-x-hidden overflow-y-auto px-2.5 py-3">
        {sections.map((section) => {
          const items = section.pages.map((page) => <NavItem key={page.key} page={page} active={page.key === activeKey} rail={rail} onNavigate={onNavigate} />);

          // In the rail, a group of several pages is one button that opens them, named, beside it
          // (src/components/ui/rail-flyout.tsx) rather than a run of unlabelled icons.
          if (rail && section.label && section.pages.length > 1) {
            return (
              <div key={section.key} className="mt-2 border-t border-line pt-2">
                <RailFlyout
                  label={section.label}
                  icon={<PartnerNavIcon name={section.pages[0]!.icon} />}
                  className="h-8"
                  onNavigate={onNavigate}
                  items={section.pages.map((page) => ({ key: page.key, href: page.href, label: page.label, icon: <PartnerNavIcon name={page.icon} />, active: page.key === activeKey }))}
                />
              </div>
            );
          }
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
          <PartnerBrand rail={collapsed} siteName={siteName} />
        </div>
        {renderNav(collapsed, "side")}
        <div className={cn("flex shrink-0 items-center gap-2 border-t border-line p-2", collapsed && "justify-center")}>
          {!collapsed && (
            <p title={footerText} className="min-w-0 flex-1 truncate px-2.5 text-[11px] text-subtle">
              {footerText}
            </p>
          )}
          <IconButton icon={collapsed ? PanelLeftOpen : PanelLeftClose} label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={onToggleCollapsed} />
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
              <PartnerBrand rail={false} siteName={siteName} onNavigate={onMobileClose} />
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
