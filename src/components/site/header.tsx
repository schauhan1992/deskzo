"use client";

import { useEffect, useId, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { ArrowRight, ChevronDown, Menu, X } from "lucide-react";
import type { NavItem, NavMenu, SiteLink } from "@/components/site/blocks/types";
import { isNavMenu } from "@/components/site/nav";
import { ButtonLink, Container, SiteAnchor } from "@/components/site/ui";
import { SiteLogo } from "@/components/site/logo";
import { cn } from "@/lib/utils";

/**
 * The public site's header: the name, the main items, "Sign in" and the call to action — which the
 * layout has already worked out ("Start free trial" or "Request an invitation").
 *
 * An item is a link or a menu. A menu is a disclosure: a button (`aria-expanded`, `aria-controls`)
 * that opens a panel of columns, each a title and its links with a line on what each is.
 *
 *   · It opens on a click, and on hover-intent (the pointer resting on it a moment — a mouse only,
 *     so a tap is a click). One is open at a time. Escape closes it and puts focus back on its
 *     button; so does a click anywhere else, following a link, or tabbing out of it. Tab moves
 *     through its links in order, because the panel follows its button in the page.
 *   · Every panel is in the server's HTML, hidden until opened: no script is needed to read the
 *     links, so crawlers see all of them.
 *
 * Below `lg` the items fold into a menu button, and each menu becomes an accordion (taps of 44 px).
 * The header's six-odd menus and two buttons need a wide screen side by side, hence `lg`.
 */

type Open = { index: number; pinned: boolean };

const HOVER_OPEN_MS = 120;
const HOVER_SWITCH_MS = 40;
const HOVER_CLOSE_MS = 200;
/** A menu with few columns keeps them together at the left of the page rather than spread across it. */
const PANEL_GRID_WIDTH: Record<number, string> = { 1: "max-w-xs", 2: "max-w-2xl", 3: "max-w-5xl", 4: "", 5: "" };
const PANEL_GRID: Record<number, string> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5" };

export function SiteHeader({ siteName, nav, signin, cta }: { siteName: string; nav: NavItem[]; signin: SiteLink; cta: SiteLink }) {
  const baseId = useId();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const triggers = useRef<(HTMLButtonElement | null)[]>([]);
  const items = useRef<(HTMLLIElement | null)[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openIndex = open?.index ?? null;

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clearTimer, []);

  // While a menu is open: Escape closes it (focus back on its button when it was inside), and so does a press anywhere outside the header's items.
  useEffect(() => {
    if (openIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const hadFocus = !!items.current[openIndex]?.contains(document.activeElement);
      setOpen(null);
      if (hadFocus) triggers.current[openIndex]?.focus();
    };
    const onPointer = (e: globalThis.PointerEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [openIndex]);

  const clickMenu = (index: number) => {
    clearTimer();
    // A click on a menu the pointer opened keeps it open; a second click closes it.
    setOpen((current) => (current?.index === index && current.pinned ? null : { index, pinned: true }));
  };
  const hoverIn = (index: number, e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    clearTimer();
    if (openIndex === index) return;
    timer.current = setTimeout(() => setOpen((current) => (current?.index === index ? current : { index, pinned: false })), openIndex === null ? HOVER_OPEN_MS : HOVER_SWITCH_MS);
  };
  const hoverOut = (index: number, e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    clearTimer();
    timer.current = setTimeout(() => setOpen((current) => (current && current.index === index && !current.pinned ? null : current)), HOVER_CLOSE_MS);
  };
  const closeOnLink = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("a")) setOpen(null);
  };

  return (
    <header
      className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur-md"
      onKeyDown={(e) => {
        if (e.key === "Escape" && mobileOpen) {
          setMobileOpen(false);
          toggle.current?.focus();
        }
      }}
    >
      <Container className="flex h-16 items-center gap-4">
        <SiteLogo name={siteName} />
        <nav ref={navRef} aria-label="Main" className="ml-2 hidden lg:block">
          <ul className="flex items-center gap-0.5">
            {nav.map((item, i) =>
              isNavMenu(item) ? (
                <li
                  key={`menu-${i}`}
                  ref={(el) => {
                    items.current[i] = el;
                  }}
                  // The full height of the header, so the pointer goes from the button into the panel below
                  // without leaving the item. Not positioned: the panel is placed against the header itself.
                  className="flex h-16 items-center"
                  onPointerEnter={(e) => hoverIn(i, e)}
                  onPointerLeave={(e) => hoverOut(i, e)}
                  onBlur={(e) => {
                    // Tabbing out of the menu closes it; a press on nothing focusable is the outside-press handler's.
                    const next = e.relatedTarget as Node | null;
                    if (next && !e.currentTarget.contains(next) && openIndex === i) setOpen(null);
                  }}
                >
                  <button
                    ref={(el) => {
                      triggers.current[i] = el;
                    }}
                    type="button"
                    aria-expanded={openIndex === i}
                    aria-controls={`${baseId}-panel-${i}`}
                    onClick={() => clickMenu(i)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md px-2.5 py-2 text-sm font-medium transition-colors hover:text-text",
                      openIndex === i ? "text-text" : "text-muted",
                    )}
                  >
                    {item.label}
                    <ChevronDown aria-hidden="true" className={cn("h-3.5 w-3.5 text-subtle transition-transform duration-150", openIndex === i && "rotate-180")} />
                  </button>
                  <div
                    id={`${baseId}-panel-${i}`}
                    hidden={openIndex !== i}
                    className="absolute inset-x-0 top-full z-50"
                    onClick={closeOnLink}
                  >
                    <MenuPanel menu={item} idPrefix={`${baseId}-panel-${i}`} />
                  </div>
                </li>
              ) : (
                <li key={`link-${i}`}>
                  <SiteAnchor href={item.href} className="rounded-md px-2.5 py-2 text-sm font-medium text-muted transition-colors hover:text-text">
                    {item.label}
                  </SiteAnchor>
                </li>
              ),
            )}
          </ul>
        </nav>
        <div className="ml-auto hidden items-center gap-2 lg:flex">
          <ButtonLink href={signin.href} label={signin.label} tone="ghost" />
          <ButtonLink href={cta.href} label={cta.label} />
        </div>
        <button
          ref={toggle}
          type="button"
          className="ml-auto grid h-11 w-11 place-items-center rounded-base text-muted transition-colors hover:bg-surface-sunken hover:text-text lg:hidden"
          aria-expanded={mobileOpen}
          aria-controls="site-menu"
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          onClick={() => setMobileOpen((o) => !o)}
        >
          {mobileOpen ? <X aria-hidden="true" className="h-5 w-5" /> : <Menu aria-hidden="true" className="h-5 w-5" />}
        </button>
      </Container>
      <div
        id="site-menu"
        hidden={!mobileOpen}
        className="max-h-[calc(100dvh-4rem)] overflow-y-auto overscroll-contain border-t border-line bg-bg lg:hidden"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a")) setMobileOpen(false);
        }}
      >
        <Container className="py-3">
          <nav aria-label="Main">
            <ul>
              {nav.map((item, i) =>
                isNavMenu(item) ? (
                  <li key={`menu-${i}`}>
                    <button
                      type="button"
                      aria-expanded={expanded === i}
                      aria-controls={`${baseId}-section-${i}`}
                      onClick={() => setExpanded((e) => (e === i ? null : i))}
                      className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-2 text-left text-base font-medium text-text hover:bg-surface-sunken"
                    >
                      {item.label}
                      <ChevronDown aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-subtle transition-transform duration-150", expanded === i && "rotate-180")} />
                    </button>
                    <div id={`${baseId}-section-${i}`} hidden={expanded !== i} className="pb-2">
                      {item.columns.map((column, c) => (
                        <div key={c}>
                          {column.title && (
                            <p id={`${baseId}-section-${i}-${c}`} className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-subtle">
                              {column.title}
                            </p>
                          )}
                          <ul aria-labelledby={column.title ? `${baseId}-section-${i}-${c}` : undefined}>
                            {column.items.map((link, j) => (
                              <li key={j}>
                                <SiteAnchor href={link.href} className="flex min-h-11 items-center rounded-md px-4 text-[15px] text-muted hover:bg-surface-sunken hover:text-text">
                                  {link.label}
                                </SiteAnchor>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                      {item.footer && (
                        <SiteAnchor href={item.footer.href} className="mt-1 flex min-h-11 items-center gap-1 rounded-md px-4 text-[15px] font-medium text-brand hover:bg-surface-sunken">
                          {item.footer.label}
                          <ArrowRight aria-hidden="true" className="h-4 w-4" />
                        </SiteAnchor>
                      )}
                    </div>
                  </li>
                ) : (
                  <li key={`link-${i}`}>
                    <SiteAnchor href={item.href} className="flex min-h-11 items-center rounded-md px-2 text-base font-medium text-text hover:bg-surface-sunken">
                      {item.label}
                    </SiteAnchor>
                  </li>
                ),
              )}
            </ul>
          </nav>
          <div className="mt-3 grid gap-2 border-t border-line pb-2 pt-4">
            <ButtonLink href={signin.href} label={signin.label} tone="secondary" size="lg" />
            <ButtonLink href={cta.href} label={cta.label} size="lg" />
          </div>
        </Container>
      </div>
    </header>
  );
}

/**
 * A menu's panel: the full width of the header, under it, with the page's own content width inside —
 * its columns side by side (a title, then each link and its line) and the link along its foot. Taller
 * than the screen, it scrolls on its own rather than the page behind it.
 */
function MenuPanel({ menu, idPrefix }: { menu: NavMenu; idPrefix: string }) {
  const cols = Math.min(Math.max(menu.columns.length, 1), 5);
  return (
    <div className="max-h-[calc(100dvh-4rem)] overflow-y-auto overscroll-contain border-b border-line bg-surface shadow-lg motion-safe:animate-fade-in">
      <Container className="py-8">
      <div className={cn("grid gap-x-10 gap-y-6", PANEL_GRID[cols], PANEL_GRID_WIDTH[cols])}>
        {menu.columns.map((column, c) => (
          <div key={c} className="min-w-0">
            {column.title && (
              <p id={`${idPrefix}-${c}`} className="px-2 text-xs font-semibold uppercase tracking-wide text-subtle">
                {column.title}
              </p>
            )}
            <ul aria-labelledby={column.title ? `${idPrefix}-${c}` : undefined} className={cn("space-y-0.5", column.title && "mt-2")}>
              {column.items.map((link, j) => (
                <li key={j}>
                  <SiteAnchor href={link.href} className="block rounded-lg px-2 py-2 transition-colors hover:bg-surface-sunken">
                    <span className="block text-sm font-medium text-text">{link.label}</span>
                    {link.description && <span className="mt-0.5 block text-[13px] leading-5 text-muted">{link.description}</span>}
                  </SiteAnchor>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {menu.footer && (
        <div className="mt-6 border-t border-line px-2 pt-5">
          <SiteAnchor href={menu.footer.href} className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">
            {menu.footer.label}
            <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
          </SiteAnchor>
        </div>
      )}
      </Container>
    </div>
  );
}
