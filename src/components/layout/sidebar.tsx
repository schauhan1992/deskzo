"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Menu, X, ChevronDown, LayoutDashboard, Search, PanelLeftClose, PanelLeftOpen, Headset } from "lucide-react";
import { MODULE_REGISTRY } from "@/lib/modules";
import { DASHBOARD_HREF, hasModuleNavigation, headedNavigation, navGroupIcon, navIcon, type VisibleNavSection } from "@/lib/navigation";
import { RailFlyout } from "@/components/ui/rail-flyout";
import { brandInitials, type Branding } from "@/lib/branding";
import { cn } from "@/lib/utils";
import { useWording } from "@/components/terms/wording-provider";
import { slot } from "@/lib/terms/dictionary";
import { openSupport } from "@/components/support/open-support";

/** Every module link, for working out which one is the most specific match for the current page. */
const NAV_HREFS = MODULE_REGISTRY.flatMap((m) => m.navItems.map((i) => i.href));

const COLLAPSED_STORAGE_KEY = "deskzo-sidebar-collapsed";

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

/** How long the pointer rests on a section before it opens — passing over one on the way to another opens nothing. */
const HOVER_OPEN_MS = 120;
/** How long a section the pointer opened stays open once the pointer has left it. */
const HOVER_CLOSE_MS = 250;

type NavIcon = typeof LayoutDashboard;

/** A top-level link: the dashboard, and in the icon rail a page standing on its own. */
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
  Icon: NavIcon;
  active: boolean;
  isCollapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      title={isCollapsed ? label : undefined}
      aria-label={isCollapsed ? label : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex h-9 items-center gap-2.5 rounded-base px-2.5 text-[13px] font-medium",
        "transition-colors duration-150",
        isCollapsed && "mx-auto w-9 justify-center px-0",
        active ? "bg-brand-subtle text-brand" : "text-muted hover:bg-surface-sunken hover:text-text",
      )}
    >
      {/* A brand-coloured rail reads as "you are here" without shouting. */}
      {active && <span aria-hidden="true" className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-brand" />}
      <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
      {!isCollapsed && <span className="truncate">{label}</span>}
    </Link>
  );
}

/** A page inside a section, indented under it on the section's guide line. */
function SubLink({ href, label, active, onNavigate }: { href: string; label: string; active: boolean; onNavigate?: () => void }) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex h-8 items-center rounded-base px-2.5 text-[13px] transition-colors duration-150",
        active ? "bg-brand-subtle font-medium text-brand" : "text-muted hover:bg-surface-sunken hover:text-text",
      )}
    >
      {/* Drawn over the guide line, level with the page you are on. */}
      {active && <span aria-hidden="true" className="absolute -left-[9px] top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand" />}
      <span className="truncate">{label}</span>
    </Link>
  );
}

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
  navigation,
  branding,
  support = false,
  drawerExtras,
}: {
  /**
   * The menu, already decided on the server for whoever the request acts as —
   * `buildNavigation` (src/lib/navigation.ts) over the layout's access context. Nothing is filtered
   * here: this draws what it is given, so it can't show a module the server would refuse, and there
   * is no moment after sign-in when it shows more than that.
   */
  navigation: VisibleNavSection[];
  branding: Branding;
  /** Controls the header has no room for on a phone (the theme), shown at the foot of the menu drawer. */
  drawerExtras?: React.ReactNode;
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
   * Deliberately not persisted, unlike the collapse state.
   *
   * A filter is about the next thirty seconds. Coming back tomorrow to a menu still showing three
   * of its forty pages, with no memory of having typed anything, reads as a broken app.
   */
  const [search, setSearch] = useState("");
  const collapsed = useSyncExternalStore(collapsedStore.subscribe, collapsedStore.get, collapsedStore.server);

  /**
   * The section the pointer opened, and the one opened from the keyboard or by a tap — see `aim`.
   * Neither is remembered: which section is open follows the pointer and the page, not last week.
   */
  const [hoverGroup, setHoverGroup] = useState<string | null>(null);
  const [pickedGroup, setPickedGroup] = useState<string | null>(null);
  /** Where the pointer is heading and the timer that takes it there, until it arrives. */
  const intent = useRef<{ target: string | null; timer: number } | null>(null);
  /** The pointer behind the click about to arrive on a section's row — none for a keyboard's Enter. */
  const pressedWith = useRef<string | null>(null);

  // A new page closes what the pointer or the keyboard opened; the section holding it is open anyway.
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setHoverGroup(null);
    setPickedGroup(null);
  }

  useEffect(
    () => () => {
      if (intent.current) window.clearTimeout(intent.current.timer);
    },
    [],
  );

  function toggleCollapsed() {
    collapsedStore.write(String(!collapsed));
  }

  const matches = (href: string) => pathname === href || pathname?.startsWith(`${href}/`);
  /**
   * The most specific link wins. `/items` is a prefix of `/items/brands`, and `/people` of
   * `/people/payroll`, so a plain prefix test lit both — two "you are here" marks, one of them wrong.
   */
  const isActive = (href: string) =>
    !!matches(href) && !NAV_HREFS.some((other) => other.length > href.length && other.startsWith(`${href}/`) && matches(other));

  /**
   * Point the open section at `target` (null: none) once the pointer has stayed there a moment.
   *
   * Driven by the pointer *moving* over a section, never by it merely being over one. Opening a
   * section closes the one before it, and when that one was above, everything below moves up under a
   * pointer that hasn't moved — enter and leave events fire for whatever slid beneath it, and a menu
   * that obeyed them would open the next section, shift again, and run down the list on its own.
   * Movement is the person; a layout shift is not, so nothing changes until they move again.
   */
  function aim(target: string | null) {
    if (intent.current?.target === target) return;
    if (intent.current) window.clearTimeout(intent.current.timer);
    intent.current = null;
    if (target === hoverGroup) return;
    const timer = window.setTimeout(
      () => {
        intent.current = null;
        setHoverGroup(target);
        // One section open at a time, besides the one you are in: the pointer moving on to another
        // closes what a click or a key opened.
        if (target !== null) setPickedGroup(null);
      },
      target === null ? HOVER_CLOSE_MS : HOVER_OPEN_MS,
    );
    intent.current = { target, timer };
  }

  /** Close a section opened by hand, keyboard or pointer (the one you are in stays open regardless). */
  function closeGroup(group: string) {
    if (intent.current) window.clearTimeout(intent.current.timer);
    intent.current = null;
    if (hoverGroup === group) setHoverGroup(null);
    if (pickedGroup === group) setPickedGroup(null);
  }

  // `canonical` is the app's own label: a renamed page is still found by its old name. A group with
  // nothing in it was dropped by `buildNavigation` — a bare heading over nothing reads as broken.
  const visibleSections: { group: string; Icon: NavIcon; items: { href: string; label: string; canonical?: string; exact?: boolean; Icon: NavIcon }[] }[] =
    navigation.map(({ group, items }) => ({
      group,
      Icon: navGroupIcon(group, items[0]?.href),
      items: items.map((i) => ({
        href: i.href,
        label: i.term ? slot(wording, i.label, i.term.key, i.term.template) : i.label,
        canonical: i.label,
        exact: i.exact,
        Icon: navIcon(i.href),
      })),
    }));
  /** Nothing to open but the dashboard and the app's own pages — said, rather than shown as a bare menu. */
  const noModules = !hasModuleNavigation(navigation);

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
      section.items.some((i) => (i.exact ? pathname === i.href : isActive(i.href))),
    )?.group ?? null;

  /**
   * Whether a section's pages are showing.
   *
   * The section holding the current page is always open, so nothing on the sidebar can ever leave you
   * without a mark of where you are. Besides it, one section at a time: the one the pointer rests on
   * (`aim`), or else the one opened from the keyboard or by a tap, which have no hover.
   */
  const isGroupOpen = (group: string) => group === activeGroup || group === hoverGroup || group === pickedGroup;

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
          "flex h-9 w-full items-center gap-2.5 rounded-base px-2.5 text-[13px] font-medium text-brand",
          "transition-colors hover:bg-brand/10",
          isCollapsed && "justify-center px-0",
          className,
        )}
      >
        <Headset aria-hidden="true" className="h-4 w-4 shrink-0" />
        {!isCollapsed && "Contact Support"}
      </button>
    );
  }

  function renderNav(isCollapsed: boolean, where: "side" | "drawer", onNavigate?: () => void) {
    /**
     * Typing filters; an empty box changes nothing.
     *
     * Forty-odd destinations behind a dozen sections is a lot of opening and closing to reach a page
     * whose name you already know — and worse for anybody who arrived from a link and does not know
     * which section it lives under. Matching on the section name as well as the item means "hr"
     * finds the whole People group, which is how people actually search a menu.
     *
     * Not offered in the icon rail: there is nowhere to put a box, and nothing to read if there
     * were. The rail is for people who already know where things are.
     */
    const query = search.trim().toLowerCase();
    const matching = query
      ? visibleSections
          .map((section) => ({
            ...section,
            items: section.items.filter(
              (i) => i.label.toLowerCase().includes(query) || (i.canonical ?? "").toLowerCase().includes(query) || section.group.toLowerCase().includes(query),
            ),
          }))
          .filter((section) => section.items.length > 0)
      : visibleSections;

    return (
      <nav
        aria-label="Main"
        // The rail scrolls without a scrollbar: one drawn over a column of icons sits on top of them.
        className={cn("flex-1 space-y-0.5 overflow-y-auto overflow-x-hidden py-3", isCollapsed ? "px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : "px-2.5")}
        // Hover opens sections in the full sidebar only — the rail's groups open beside it on their own
        // (src/components/ui/rail-flyout.tsx). A finger has no hover: a tap on a section's row opens it.
        onPointerMove={
          isCollapsed
            ? undefined
            : (e) => {
                if (e.pointerType === "touch") return;
                const over = (e.target as Element).closest("[data-nav-group]");
                aim(over?.getAttribute("data-nav-group") ?? null);
              }
        }
        onPointerLeave={isCollapsed ? undefined : (e) => e.pointerType !== "touch" && aim(null)}
      >
        {!isCollapsed && (
          <div className="relative mb-2">
            <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
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
            href={DASHBOARD_HREF}
            label="Dashboard"
            Icon={LayoutDashboard}
            active={pathname === DASHBOARD_HREF}
            isCollapsed={isCollapsed}
            onNavigate={onNavigate}
          />
        )}

        {/* Signed in to nothing yet: a role with every section unticked, or a plan of the core alone
            switched off. Said once, under the dashboard, instead of a menu of headings with no
            modules — the dashboard and the app's own pages still work. */}
        {noModules && !query && !isCollapsed && (
          <div role="note" className="mx-0.5 my-2 rounded-base border border-dashed border-line px-3 py-3 text-xs text-muted">
            <p className="font-medium text-text">No modules assigned</p>
            <p className="mt-1">Please contact your administrator to request access.</p>
          </div>
        )}

        {query && matching.length === 0 && (
          <p className="px-2.5 py-6 text-center text-xs text-subtle">
            Nothing here matches &ldquo;{search.trim()}&rdquo;.
          </p>
        )}

        {headedNavigation(matching).map(({ heading, sections }, at) => (
          <div
            key={heading ?? "top"}
            role={heading ? "group" : undefined}
            aria-label={heading ?? undefined}
            className={cn("space-y-0.5", isCollapsed ? at > 0 && "mt-2 border-t border-line pt-2" : heading && "pt-3")}
          >
            {/* The heading over its sections — in the rail, the rule above them says the same. */}
            {heading && !isCollapsed && (
              <p aria-hidden="true" className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-subtle">
                {heading}
              </p>
            )}
            {sections.map(({ group, Icon, items }) => {
              // In the icon rail each section is its icon, and its pages open, named, beside the rail on
              // hover (src/components/ui/rail-flyout.tsx) — a column of forty unlabelled icons, several
              // alike, was the rail's whole problem.
              if (isCollapsed) {
                return (
                  <RailFlyout
                    key={group}
                    label={group}
                    icon={<Icon aria-hidden="true" className="h-4 w-4 shrink-0" />}
                    className="mx-auto h-9 w-9"
                    // From the icon's edge past the rail's own, so the panel opens just clear of the rail.
                    offset={24}
                    onNavigate={onNavigate}
                    // Names alone beside the rail, as under a section in the full sidebar.
                    items={items.map((item) => ({
                      key: item.href,
                      href: item.href,
                      label: item.label,
                      active: item.exact ? pathname === item.href : isActive(item.href),
                    }))}
                  />
                );
              }

              // Open while filtering, whatever else: a section that hid its own matches would make the
              // search look broken.
              const open = query ? true : isGroupOpen(group);
              const current = group === activeGroup;
              const panelId = `nav-${where}-${group.replace(/\W+/g, "-").toLowerCase()}`;

              return (
                <div
                  key={group}
                  data-nav-group={group}
                  onKeyDown={(e) => {
                    // Escape folds a section opened by hand back up, and leaves focus on its row.
                    if (e.key === "Escape" && open && !current && !query) {
                      e.preventDefault();
                      closeGroup(group);
                      e.currentTarget.querySelector<HTMLButtonElement>("button")?.focus();
                    }
                  }}
                >
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={open ? panelId : undefined}
                    onPointerDown={(e) => {
                      pressedWith.current = e.pointerType;
                    }}
                    onClick={() => {
                      const pointer = pressedWith.current;
                      pressedWith.current = null;
                      if (query) return;
                      if (pointer === "mouse" || pointer === "pen") {
                        // The pointer is on it: open now rather than after the hover's moment. Hover owns
                        // closing, so a click that lands just as a section opened can't shut it again.
                        if (intent.current) window.clearTimeout(intent.current.timer);
                        intent.current = null;
                        setHoverGroup(group);
                        setPickedGroup(null);
                        return;
                      }
                      // The keyboard, or a finger: no hover to open it, so the press opens and closes.
                      if (current) return;
                      if (open) closeGroup(group);
                      else {
                        setPickedGroup(group);
                        setHoverGroup(null);
                      }
                    }}
                    className={cn(
                      "flex h-9 w-full items-center gap-2.5 rounded-base px-2.5 text-left text-[13px] transition-colors duration-150",
                      // The section you are in reads as chosen: heavier, in full colour.
                      current ? "font-semibold text-text" : "font-medium text-muted hover:bg-surface-sunken hover:text-text",
                      open && !current && "bg-surface-sunken text-text",
                    )}
                  >
                    <Icon aria-hidden="true" className={cn("h-4 w-4 shrink-0", current && "text-brand")} />
                    <span className="min-w-0 flex-1 truncate">{group}</span>
                    <ChevronDown
                      aria-hidden="true"
                      className={cn("h-3.5 w-3.5 shrink-0 text-subtle transition-transform duration-150", open && "rotate-180")}
                    />
                  </button>

                  {/* Unmounted rather than hidden. A closed section that is still in the DOM leaves
                      forty invisible links in the tab order, which turns one keyboard traversal of this
                      nav into a tour of every page in the app. */}
                  {open && (
                    <div id={panelId} role="group" aria-label={group} className="mb-1 ml-[17px] mt-0.5 space-y-0.5 border-l border-line pl-2">
                      {items.map((item) => (
                        <SubLink
                          key={item.href}
                          href={item.href}
                          label={item.label}
                          active={item.exact ? pathname === item.href : isActive(item.href)}
                          onNavigate={onNavigate}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
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
          // Nothing inside spills while the width eases: the rail's panels are portalled to the body, not clipped here.
          "md:overflow-hidden md:whitespace-nowrap md:transition-[width] md:duration-200 md:ease-out",
          collapsed ? "md:w-[68px]" : "md:w-[240px]",
        )}
      >
        {/* The brand, and beside it — beneath it in the rail — the control that folds the sidebar to
            icons and back. Kept apart from the menu, so it is never mistaken for a page; the page you
            are on and the section holding it stay marked whichever way it goes. */}
        <div className={cn("flex shrink-0 border-b border-line", collapsed ? "flex-col items-center gap-2 px-2 py-3" : "h-14 items-center gap-2.5 pl-4 pr-2")}>
          <BrandMark branding={branding} collapsed={collapsed} />
          {!collapsed && !branding.logoDataUrl && (
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text">{branding.appName}</span>
          )}
          {!collapsed && branding.logoDataUrl && <span className="flex-1" />}
          <button
            type="button"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={toggleCollapsed}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-base border border-line text-subtle transition-colors hover:bg-surface-sunken hover:text-text"
          >
            {collapsed ? <PanelLeftOpen aria-hidden="true" className="h-4 w-4" /> : <PanelLeftClose aria-hidden="true" className="h-4 w-4" />}
          </button>
        </div>
        {renderNav(collapsed, "side")}
        {support && <div className="border-t border-line p-2 xl:hidden">{supportButton(collapsed)}</div>}
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
            {renderNav(false, "drawer", () => setMobileOpen(false))}
            {/* The drawer closes first, so the dialog opens over the page rather than over the menu. */}
            {support && <div className="border-t border-line p-2">{supportButton(false, () => setMobileOpen(false))}</div>}
            {drawerExtras && <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2 text-xs text-muted sm:hidden">Theme {drawerExtras}</div>}
          </aside>
        </div>
      )}
    </>
  );
}
