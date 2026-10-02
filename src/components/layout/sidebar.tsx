"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Menu, X, ChevronRight, LayoutDashboard, BarChart3, Search, Settings as SettingsIcon, UserCog, PanelLeftClose, PanelLeftOpen, ScrollText, ShieldCheck, FileSpreadsheet, Headset } from "lucide-react";
import { MODULE_REGISTRY, navGroupRank , navPermissionKeys } from "@/lib/modules";
import { brandInitials, type Branding } from "@/lib/branding";
import { cn } from "@/lib/utils";
import { useWording } from "@/components/terms/wording-provider";
import { slot } from "@/lib/terms/dictionary";
import { openSupport } from "@/components/support/open-support";

/** Every module link, for working out which one is the most specific match for the current page. */
const NAV_HREFS = MODULE_REGISTRY.flatMap((m) => m.navItems.map((i) => i.href));

const COLLAPSED_STORAGE_KEY = "deskzo-sidebar-collapsed";
const OPEN_GROUPS_STORAGE_KEY = "deskzo-sidebar-open-groups";

/**
 * localStorage, read the way React wants a browser-only value read.
 *
 * Reading it in a `useState` initializer is the obvious thing and it is what this file used to do.
 * It is wrong: the initializer runs on the server, where it returns the default, and again during
 * hydration on the client, where it returns the stored value — so the two renders disagree about
 * which sections are open and React throws the tree away. `suppressHydrationWarning` on the
 * <aside> did not cover it, because that silences only the element it is on, never its children.
 *
 * `useSyncExternalStore` exists for exactly this. The server snapshot is the default, the client
 * snapshot is what is stored, and React reconciles the difference itself instead of treating it as
 * a bug. The same approach is already used for the portalled popovers in anchored-popover.tsx.
 *
 * The parsed value is cached against the raw string because a snapshot has to be referentially
 * stable — returning a fresh array on every call makes React re-render without end.
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
        // Private windows and blocked site data. The preference is lost, the sidebar is not.
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

const collapsedStore = makeStore(COLLAPSED_STORAGE_KEY, (raw) => raw === "true", false);

/**
 * Which sections were left open, or `null` when this browser has never said.
 *
 * `null` is distinct from "none open" on purpose: somebody who has collapsed every section should
 * get every section collapsed back, while somebody arriving for the first time should not be shown
 * a sidebar that is nothing but headings.
 */
const openGroupsStore = makeStore<string[] | null>(
  OPEN_GROUPS_STORAGE_KEY,
  (raw) => {
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : null;
    } catch {
      // A corrupt value is the same as never having said — better a sensible default than a crash
      // in the one component every page renders.
      return null;
    }
  },
  null,
);
function BrandMark({ branding, collapsed }: { branding: Branding; collapsed: boolean }) {
  if (branding.logoDataUrl) {
    return (
      <Image
        src={branding.logoDataUrl}
        alt={branding.appName}
        width={collapsed ? 28 : 112}
        height={28}
        unoptimized
        className={cn("object-contain", collapsed ? "h-7 w-7" : "h-7 w-auto max-w-[130px]")}
      />
    );
  }
  return (
    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand text-[11px] font-bold text-brand-contrast">
      {brandInitials(branding)}
    </span>
  );
}

export function Sidebar({
  enabledKeys,
  canViewPerformance,
  /** Permission keys this viewer holds, for nav items that name one. */
  permissions = [],
  branding,
  country = "IN",
  support = false,
}: {
  enabledKeys: string[];
  canViewPerformance: boolean;
  permissions?: string[];
  branding: Branding;
  /** The workspace's, for links that only exist in some countries (the e-way bill register). */
  country?: string;
  /**
   * Whether to offer "Contact Support" at the foot of the menu, below xl (the tool rail has it from xl) —
   * the layout's answer from `supportLauncherState()`. The dialog itself is the layout's
   * (src/components/support/support-launcher.tsx).
   */
  support?: boolean;
}) {
  const pathname = usePathname();
  const wording = useWording();
  const [mobileOpen, setMobileOpen] = useState(false);
  /**
   * Deliberately not persisted, unlike the collapse state and the open sections.
   *
   * A filter is about the next thirty seconds. Coming back tomorrow to a menu still showing three
   * of its forty pages, with no memory of having typed anything, reads as a broken app.
   */
  const [search, setSearch] = useState("");
  const collapsed = useSyncExternalStore(collapsedStore.subscribe, collapsedStore.get, collapsedStore.server);

  function toggleCollapsed() {
    collapsedStore.write(String(!collapsed));
  }

  const groups = new Map<string, typeof MODULE_REGISTRY>();
  for (const mod of MODULE_REGISTRY) {
    if (!enabledKeys.includes(mod.key)) continue;
    // A module this person may not see is not offered — the page would only tell them so.
    if (mod.viewPermission && !permissions.includes(mod.viewPermission)) continue;
    const list = groups.get(mod.navGroup) ?? [];
    list.push(mod);
    groups.set(mod.navGroup, list);
  }

  const matches = (href: string) => pathname === href || pathname?.startsWith(`${href}/`);
  /**
   * The most specific link wins. `/items` is a prefix of `/items/brands`, and `/people` of
   * `/people/payroll`, so a plain prefix test lit both — two "you are here" marks, one of them wrong.
   */
  const isActive = (href: string) =>
    !!matches(href) && !NAV_HREFS.some((other) => other.length > href.length && other.startsWith(`${href}/`) && matches(other));

  const openGroups = useSyncExternalStore(openGroupsStore.subscribe, openGroupsStore.get, openGroupsStore.server);

  function toggleGroup(group: string) {
    // `null` means nothing stored yet, and what is on screen in that case is the active section
    // alone — so the first click has to start from that, not from an empty set, or collapsing the
    // section you are in would silently reopen it.
    const base = openGroups ?? (activeGroup ? [activeGroup] : []);
    const next = base.includes(group) ? base.filter((g) => g !== group) : [...base, group];
    openGroupsStore.write(JSON.stringify(next));
  }

  function NavLink({
    href,
    label,
    Icon,
    active,
    isCollapsed,
    onNavigate,
  }: {
    href: string;
    label: string;
    Icon: typeof LayoutDashboard;
    active: boolean;
    isCollapsed: boolean;
    onNavigate?: () => void;
  }) {
    return (
      <Link
        href={href}
        onClick={onNavigate}
        title={isCollapsed ? label : undefined}
        aria-current={active ? "page" : undefined}
        className={cn(
          "group relative flex items-center gap-2.5 rounded-base px-2.5 py-2 text-[13px] font-medium",
          "transition-colors duration-150",
          isCollapsed && "justify-center",
          active ? "bg-brand-subtle text-brand" : "text-muted hover:bg-surface-sunken hover:text-text",
        )}
      >
        {/* A brand-coloured rail reads as "you are here" without shouting. */}
        {active && <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-brand" />}
        <Icon className="h-4 w-4 shrink-0" />
        {!isCollapsed && <span className="truncate">{label}</span>}
      </Link>
    );
  }

  // `canonical` is the app's own label: a renamed page is still found by its old name.
  const sections: { group: string; items: { href: string; label: string; canonical?: string; Icon: typeof LayoutDashboard }[] }[] = [
    // Explicit order rather than the order the registry happens to declare them in.
    // See NAV_GROUP_ORDER in src/lib/modules.ts.
    ...Array.from(groups.entries())
      .sort(([a], [b]) => navGroupRank(a) - navGroupRank(b))
      .map(([group, mods]) => ({
        group,
        items: mods
          .flatMap((m) => m.navItems)
          // An array means any one of them will do — the same rule the settings catalogue uses.
          .filter((i) => {
            if (i.countries && !i.countries.includes(country)) return false;
            const keys = navPermissionKeys(i);
            return keys.length === 0 || keys.some((k) => permissions.includes(k));
          })
          .map((i) => ({ href: i.href, label: i.term ? slot(wording, i.label, i.term.key, i.term.template) : i.label, canonical: i.label, Icon: i.icon })),
      })),
    {
      group: "Reports",
      items: [
        ...(canViewPerformance ? [{ href: "/performance", label: "Performance", Icon: BarChart3 }] : []),
        // No permission gate: everybody can see their own activity, and should. A log that is
        // secret from the people in it is surveillance; one they can check is also the fastest
        // way somebody notices a sign-in that was not them. The action narrows the rows.
        { href: "/activity", label: "Activity log", Icon: ScrollText },
      ],
    },
    {
      // Each administration link is gated on the key its own page requires, not on a blanket
      // "is an admin" flag. The two must agree: a link whose page then refuses you is the
      // invitation-to-a-locked-door problem, and gating the group as a whole would hide Staff &
      // roles from an auditor who holds permissions.view and nothing else.
      group: "Administration",
      items: [
        ...(permissions.includes("settings.manage")
          ? [{ href: "/settings", label: "Settings", Icon: SettingsIcon }]
          : []),
        ...(permissions.includes("permissions.view")
          ? [{ href: "/settings/access", label: "Staff & roles", Icon: UserCog }]
          : []),
        ...(permissions.includes("security.manage")
          ? [{ href: "/settings/security", label: "Security & DLP", Icon: ShieldCheck }]
          : []),
        // Any export permission opens it. Deliberately not gated on being an admin: an accountant
        // who exports statements is not an administrator, and hiding it from them defeats the point.
        ...(permissions.some((k) => k.startsWith("data."))
          ? [{ href: "/settings/data", label: "Import & export", Icon: FileSpreadsheet }]
          : []),
      ],
    },
  ];

  const visibleSections = sections.filter((section) => section.items.length > 0);

  /**
   * The section holding the page you are on.
   *
   * Settings is matched exactly for the same reason its link is: `/settings` is a prefix of
   * `/settings/access` and `/settings/data`, so a `startsWith` test would put you in Administration
   * whichever of them you were looking at — which is true, but it would also claim `/settings` was
   * active while you were on Import & export.
   */
  const activeGroup =
    visibleSections.find((section) =>
      section.items.some((i) => (i.href === "/settings" ? pathname === i.href : isActive(i.href))),
    )?.group ?? null;

  /**
   * Whether a section is expanded.
   *
   * Two rules, and the second is the one worth stating. Sections remember how you left them. But the
   * section containing the current page is always open, so the sidebar can never be in a state where
   * nothing on it tells you where you are — which is the failure mode of every accordion nav that
   * lets you close everything and then lands you on a page by redirect.
   */
  const isGroupOpen = (group: string) =>
    group === activeGroup || (openGroups === null ? false : openGroups.includes(group));

  /**
   * "Contact Support", at the foot of the menu: the platform's help desk, not a page of this workspace.
   * From xl the tool rail on the right has it as an icon, so the rail's copy of the menu hides it there.
   */
  function supportButton(isCollapsed: boolean, beforeOpen?: () => void, className?: string) {
    return (
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={isCollapsed ? "Contact support" : undefined}
        title={isCollapsed ? "Contact support" : undefined}
        onClick={() => {
          beforeOpen?.();
          openSupport();
        }}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-base px-2.5 py-2 text-[13px] font-medium text-brand",
          "transition-colors hover:bg-brand/10",
          isCollapsed && "justify-center",
          className,
        )}
      >
        <Headset aria-hidden="true" className="h-4 w-4 shrink-0" />
        {!isCollapsed && "Contact Support"}
      </button>
    );
  }

  function renderNav(isCollapsed: boolean, onNavigate?: () => void) {
    /**
     * Typing filters; an empty box changes nothing.
     *
     * Forty-odd destinations behind eleven collapsible headings is a lot of opening and closing to
     * reach a page whose name you already know — and worse for anybody who arrived from a link and
     * does not know which heading it lives under. Matching on the section name as well as the item
     * means "hr" finds the whole People group, which is how people actually search a menu.
     *
     * Not offered in the icon rail: there is nowhere to put a box, and nothing to read if there
     * were. The rail is for people who already know where things are.
     */
    const query = search.trim().toLowerCase();
    const matching = query
      ? visibleSections
          .map(({ group, items }) => ({
            group,
            items: items.filter(
              (i) => i.label.toLowerCase().includes(query) || (i.canonical ?? "").toLowerCase().includes(query) || group.toLowerCase().includes(query),
            ),
          }))
          .filter((section) => section.items.length > 0)
      : visibleSections;

    return (
      <nav className="flex-1 space-y-1 overflow-y-auto overflow-x-hidden px-2.5 py-4">
        {!isCollapsed && (
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                // Escape clears rather than closing anything — there is no popup to close, and a
                // filtered menu you cannot reset is worse than no filter.
                if (e.key === "Escape" && search) {
                  e.preventDefault();
                  setSearch("");
                }
              }}
              placeholder="Find a page…"
              aria-label="Find a page in the menu"
              className="h-8 w-full rounded-base border border-line bg-surface-sunken pl-8 pr-2 text-[13px] text-text placeholder:text-subtle focus-visible:border-brand"
            />
          </div>
        )}

        {/* Hidden while filtering: it is not a search result, and leaving it pinned above an empty
            list reads as "Dashboard is the only match". */}
        {!query && (
          <NavLink
            href="/dashboard"
            label="Dashboard"
            Icon={LayoutDashboard}
            active={pathname === "/dashboard"}
            isCollapsed={isCollapsed}
            onNavigate={onNavigate}
          />
        )}

        {/* A group whose every item was filtered out by permission renders as a bare heading over
            nothing, which reads as a broken menu rather than as an absent one — hence
            `visibleSections`, which drops them before anything here sees them. */}
        {query && matching.length === 0 && (
          <p className="px-2.5 py-6 text-center text-xs text-subtle">
            Nothing here matches &ldquo;{search.trim()}&rdquo;.
          </p>
        )}

        {matching.map(({ group, items }) => {
          // In the icon rail there are no labels to put a chevron beside and no room to, so the
          // sections stay open and a rule separates them. Collapsing a rail of icons would hide
          // them behind a control that is itself unlabelled.
          if (isCollapsed) {
            return (
              <div key={group}>
                <div className="mx-2 mb-1.5 border-t border-line" />
                <div className="space-y-0.5">
                  {items.map((item) => (
                    <NavLink
                      key={item.href}
                      href={item.href}
                      label={item.label}
                      Icon={item.Icon}
                      active={item.href === "/settings" ? pathname === item.href : isActive(item.href)}
                      isCollapsed
                      onNavigate={onNavigate}
                    />
                  ))}
                </div>
              </div>
            );
          }

          // Open while filtering, whatever the stored state: a section that hid its own matches
          // would make the search look broken.
          const open = query ? true : isGroupOpen(group);
          const panelId = `nav-${group.replace(/\W+/g, "-").toLowerCase()}`;
          // The one section you cannot close is the one you are in — see isGroupOpen.
          const locked = group === activeGroup;

          return (
            <div key={group}>
              <button
                type="button"
                onClick={() => toggleGroup(group)}
                disabled={locked}
                aria-expanded={open}
                aria-controls={panelId}
                title={locked ? `${group} — the section you're in` : undefined}
                className={cn(
                  "flex w-full items-center gap-1 rounded-base px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] transition-colors",
                  locked ? "cursor-default text-muted" : "text-subtle hover:bg-surface-sunken hover:text-muted",
                )}
              >
                <span className="truncate">{group}</span>
                {/* Not rendered for the locked section: a chevron that does nothing is worse than
                    no chevron, and the count of closed sections is what the eye is scanning. */}
                {!locked && (
                  <ChevronRight
                    className={cn("ml-auto h-3 w-3 shrink-0 transition-transform duration-150", open && "rotate-90")}
                  />
                )}
              </button>

              {/* Unmounted rather than hidden. A closed section that is still in the DOM leaves
                  forty invisible links in the tab order, which turns one keyboard traversal of this
                  nav into a tour of every page in the app. */}
              {open && (
                <div id={panelId} className="mb-1 mt-0.5 space-y-0.5">
                  {items.map((item) => (
                    <NavLink
                      key={item.href}
                      href={item.href}
                      label={item.label}
                      Icon={item.Icon}
                      active={item.href === "/settings" ? pathname === item.href : isActive(item.href)}
                      isCollapsed={false}
                      onNavigate={onNavigate}
                    />
                  ))}
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
      <button
        type="button"
        aria-label="Open menu"
        onClick={() => setMobileOpen(true)}
        className="fixed left-3 top-3 z-30 rounded-base border border-line bg-surface p-2 text-muted shadow-sm transition-colors hover:text-text md:hidden"
      >
        <Menu className="h-4 w-4" />
      </button>

      <aside
        suppressHydrationWarning
        className={cn(
          "hidden md:sticky md:top-0 md:flex md:h-screen md:shrink-0 md:flex-col md:border-r md:border-line md:bg-surface",
          "md:transition-[width] md:duration-200 md:ease-out",
          collapsed ? "md:w-[68px]" : "md:w-[228px]",
        )}
      >
        <div className={cn("flex h-14 items-center gap-2.5 border-b border-line px-4", collapsed && "justify-center px-2")}>
          <BrandMark branding={branding} collapsed={collapsed} />
          {!collapsed && !branding.logoDataUrl && (
            <span className="truncate text-sm font-semibold text-text">{branding.appName}</span>
          )}
        </div>
        {renderNav(collapsed)}
        <div className="space-y-0.5 border-t border-line p-2">
          {support && supportButton(collapsed, undefined, "xl:hidden")}
          <button
            type="button"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={toggleCollapsed}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-base px-2.5 py-2 text-[13px] font-medium text-subtle",
              "transition-colors hover:bg-surface-sunken hover:text-text",
              collapsed && "justify-center",
            )}
          >
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            {!collapsed && "Collapse"}
          </button>
        </div>
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 animate-fade-in bg-black/50" onClick={() => setMobileOpen(false)} />
          <aside className="absolute left-0 top-0 flex h-full w-[264px] animate-slide-in-left flex-col border-r border-line bg-surface shadow-lg">
            <div className="flex h-14 items-center justify-between gap-2 border-b border-line px-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <BrandMark branding={branding} collapsed={false} />
                {!branding.logoDataUrl && (
                  <span className="truncate text-sm font-semibold text-text">{branding.appName}</span>
                )}
              </div>
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setMobileOpen(false)}
                className="rounded-base p-1.5 text-subtle transition-colors hover:bg-surface-sunken hover:text-text"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {renderNav(false, () => setMobileOpen(false))}
            {/* The drawer closes first, so the dialog opens over the page rather than over the menu. */}
            {support && <div className="border-t border-line p-2">{supportButton(false, () => setMobileOpen(false))}</div>}
          </aside>
        </div>
      )}
    </>
  );
}
