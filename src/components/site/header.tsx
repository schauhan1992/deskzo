"use client";

import { useEffect, useId, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { ArrowRight, ChevronDown, Menu, X } from "lucide-react";
import type { NavItem, NavMenu, NavMenuItem, SiteLink } from "@/components/site/blocks/types";
import { isNavMenu } from "@/components/site/nav";
import { ButtonLink, Container, SiteAnchor } from "@/components/site/ui";
import { SiteLogo } from "@/components/site/logo";
import { NAV_ICONS, navIconKey } from "@/components/site/nav-icons";
import { ProductIcon } from "@/components/brand/product-icon";
import { productByPath, type Product } from "@/lib/products";
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
 *   · While one is open the page under it is dimmed, and the panel ends in a bar: the menu's own
 *     link ("See every module") and the call to action.
 *
 * A link to a product's page carries the product's icon (src/lib/brand/product-icons.ts), in the
 * panel and the accordion alike — found by its address, so the menus' content needn't name it. A
 * menu of products is laid out as one (owner, 24 Oct 2026: "improve the mega menu"): Deskzo One as
 * a feature card with every product's icon in it, the products in two even stacks, the add-ons in a
 * side panel (`productShape`).
 *
 * Below `lg` the items fold into a menu button, and each menu becomes an accordion (taps of 44 px).
 * The header's six-odd menus and two buttons need a wide screen side by side, hence `lg`.
 */

type Open = { index: number; pinned: boolean };

const HOVER_OPEN_MS = 120;
const HOVER_SWITCH_MS = 40;
const HOVER_CLOSE_MS = 200;

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
      {/* While a menu is open, the page under it is dimmed; a press on it closes the menu (the outside-press handler) rather than following what is beneath. */}
      {openIndex !== null && <div aria-hidden="true" className="absolute inset-x-0 top-full hidden h-dvh bg-slate-950/20 backdrop-blur-[2px] motion-safe:animate-fade-in lg:block" />}
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
                      "inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-sm font-medium transition-colors hover:text-text",
                      openIndex === i ? "bg-surface-sunken text-text" : "text-muted",
                    )}
                  >
                    {item.label}
                    <ChevronDown aria-hidden="true" className={cn("h-3.5 w-3.5 text-subtle transition-transform duration-200", openIndex === i && "rotate-180 text-text")} />
                  </button>
                  <div
                    id={`${baseId}-panel-${i}`}
                    hidden={openIndex !== i}
                    className="absolute inset-x-0 top-full z-50"
                    onClick={closeOnLink}
                  >
                    <MenuPanel menu={item} idPrefix={`${baseId}-panel-${i}`} cta={cta} />
                  </div>
                </li>
              ) : (
                <li key={`link-${i}`}>
                  <SiteAnchor href={item.href} className="rounded-full px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:text-text">
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
                            {column.items.map((link, j) => {
                              const product = productByPath(link.href);
                              return (
                                <li key={j}>
                                  <SiteAnchor href={link.href} className="flex min-h-11 items-center gap-3 rounded-md px-4 text-[15px] text-muted hover:bg-surface-sunken hover:text-text">
                                    {product && <ProductIcon product={product.key} className="h-8 w-8" />}
                                    {product && link.description ? (
                                      // A product's line under its name, on one line: the row stays a 44 px tap.
                                      <span className="min-w-0">
                                        <span className="block truncate">{link.label}</span>
                                        <span className="block truncate text-xs text-subtle">{link.description}</span>
                                      </span>
                                    ) : (
                                      link.label
                                    )}
                                  </SiteAnchor>
                                </li>
                              );
                            })}
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
 * A menu's panel: the full width of the header, under it, with the page's own content width inside, and
 * a bar along its foot — the menu's own link, and the call to action. Taller than the screen, it scrolls
 * on its own rather than the page behind it. A menu of products is drawn as the Product menu
 * (`productShape`); any other as its columns side by side.
 */
function MenuPanel({ menu, idPrefix, cta }: { menu: NavMenu; idPrefix: string; cta: SiteLink }) {
  const shape = productShape(menu);
  return (
    <div className="max-h-[calc(100dvh-4rem)] overflow-y-auto overscroll-contain border-b border-line bg-surface shadow-[0_32px_64px_-24px_rgb(15_23_42/0.3)] motion-safe:animate-fade-rise">
      <Container className="py-7">{shape ? <ProductPanel shape={shape} idPrefix={idPrefix} /> : <ColumnsPanel menu={menu} idPrefix={idPrefix} />}</Container>
      {menu.footer && (
        <div className="border-t border-line bg-surface-sunken/60">
          <Container className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3.5">
            <SiteAnchor href={menu.footer.href} className="group inline-flex items-center gap-1.5 text-sm font-medium text-text transition-colors hover:text-brand">
              {menu.footer.label}
              <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
            </SiteAnchor>
            <SiteAnchor href={cta.href} className="group inline-flex items-center gap-1.5 text-sm font-semibold text-brand">
              {cta.label}
              <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
            </SiteAnchor>
          </Container>
        </div>
      )}
    </div>
  );
}

type Column = { title: string; index: number; items: NavMenuItem[] };
type ProductEntry = { link: NavMenuItem; product: Product };
type ProductColumn = { title: string; index: number; links: ProductEntry[] };
type ProductShape = { feature: ProductColumn | null; stacks: ProductColumn[][]; side: Column[]; every: Product[] };

/**
 * How a menu of products is laid out — found from its links, so the CMS's menu needs nothing more. A
 * column whose every link is a product's page is a product column. The one holding a single product is
 * the feature (Deskzo One, which is all of them); the rest go into two stacks of about the same height,
 * each column to the shorter in turn; any other column (add-ons, capabilities) sits to the side. Null
 * for a menu without a product column.
 */
function productShape(menu: NavMenu): ProductShape | null {
  const products: ProductColumn[] = [];
  const side: Column[] = [];
  menu.columns.forEach((column, index) => {
    const links = column.items.map((link) => ({ link, product: productByPath(link.href) }));
    if (links.length && links.every((l): l is ProductEntry => !!l.product)) products.push({ title: column.title, index, links });
    else side.push({ title: column.title, index, items: column.items });
  });
  if (!products.length) return null;
  const feature = products.find((c) => c.links.length === 1) ?? null;
  const stacks: [ProductColumn[], ProductColumn[]] = [[], []];
  // A column's height: its links, and its title.
  const height = (stack: ProductColumn[]) => stack.reduce((n, c) => n + c.links.length + 1, 0);
  for (const column of products.filter((c) => c !== feature)) (height(stacks[0]) <= height(stacks[1]) ? stacks[0] : stacks[1]).push(column);
  return { feature, stacks: stacks.filter((s) => s.length), side, every: products.flatMap((c) => c.links.map((l) => l.product)) };
}

function ColumnTitle({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="px-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-subtle">
      {children}
    </p>
  );
}

/**
 * A page's icon in its small tile, beside a link's name (src/components/site/nav-icons.ts); nothing for an
 * address without one. `raised`: on the side panel's grey, the tile is white.
 */
function NavIconChip({ href, raised = false }: { href: string; raised?: boolean }) {
  const key = navIconKey(href);
  if (!key) return null;
  const Icon = NAV_ICONS[key]!;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted ring-1 ring-line transition-colors group-hover:text-brand group-hover:ring-[color-mix(in_srgb,var(--brand)_35%,var(--line))]",
        raised ? "bg-surface" : "bg-surface-sunken group-hover:bg-surface",
      )}
    >
      <Icon className="h-4 w-4" />
    </span>
  );
}

/** The arrow that slides in beside a link's name as the pointer comes over it. */
function HoverArrow() {
  return <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 -translate-x-1 opacity-0 transition-[opacity,transform] duration-200 group-hover:translate-x-0 group-hover:opacity-100" />;
}

/**
 * The Product menu: the feature card at the left, the products in two stacks — each with its icon, name
 * and line — and the other columns in a quieter panel at the right. Between `lg` and `xl` the side panel
 * moves under the rest, its links three across.
 */
function ProductPanel({ shape, idPrefix }: { shape: ProductShape; idPrefix: string }) {
  const { feature, stacks, side, every } = shape;
  const grid = feature
    ? side.length
      ? "lg:grid-cols-[15rem_minmax(0,1fr)] xl:grid-cols-[17rem_minmax(0,1fr)_18rem]"
      : "lg:grid-cols-[15rem_minmax(0,1fr)] xl:grid-cols-[17rem_minmax(0,1fr)]"
    : side.length
      ? "lg:grid-cols-[minmax(0,1fr)_18rem]"
      : "";
  return (
    <div className={cn("grid gap-6 xl:gap-8", grid)}>
      {feature && <FeatureCard column={feature} id={`${idPrefix}-${feature.index}`} every={every} />}
      <div className={cn("grid gap-x-6 gap-y-7", stacks.length > 1 && "sm:grid-cols-2")}>
        {stacks.map((stack, s) => (
          <div key={s} className="flex min-w-0 flex-col gap-7">
            {stack.map((column) => (
              <div key={column.index}>
                {column.title && <ColumnTitle id={`${idPrefix}-${column.index}`}>{column.title}</ColumnTitle>}
                <ul aria-labelledby={column.title ? `${idPrefix}-${column.index}` : undefined} className={cn("space-y-0.5", column.title && "mt-2")}>
                  {column.links.map(({ link, product }, j) => (
                    <li key={j}>
                      <SiteAnchor href={link.href} className="group flex items-start gap-3 rounded-xl p-2 transition-colors hover:bg-surface-sunken">
                        <ProductIcon product={product.key} className="h-10 w-10 transition-transform duration-200 ease-out group-hover:-translate-y-0.5" />
                        <span className="min-w-0 pt-px">
                          <span className="flex items-center gap-1 text-sm font-semibold text-text transition-colors group-hover:text-brand">
                            {link.label}
                            <HoverArrow />
                          </span>
                          {link.description && <span className="mt-0.5 line-clamp-2 text-[13px] leading-5 text-muted">{link.description}</span>}
                        </span>
                      </SiteAnchor>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ))}
      </div>
      {side.length > 0 && (
        <div className={cn("space-y-5 rounded-2xl bg-surface-sunken/70 p-3", feature && "lg:col-span-2 xl:col-span-1")}>
          {side.map((column) => (
            <div key={column.index}>
              {column.title && (
                <div className="pt-2">
                  <ColumnTitle id={`${idPrefix}-${column.index}`}>{column.title}</ColumnTitle>
                </div>
              )}
              <ul aria-labelledby={column.title ? `${idPrefix}-${column.index}` : undefined} className={cn("grid gap-0.5", column.title && "mt-2", feature && "lg:grid-cols-3 xl:grid-cols-1")}>
                {column.items.map((link, j) => (
                  <li key={j}>
                    <SiteAnchor href={link.href} className="group flex items-start gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-surface">
                      <NavIconChip href={link.href} raised />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1 text-sm font-medium text-text transition-colors group-hover:text-brand">
                          {link.label}
                          <HoverArrow />
                        </span>
                        {/* Under the rest, three across (below `xl`), the names alone keep the panel short. */}
                        {link.description && <span className={cn("mt-0.5 text-[12.5px] leading-5 text-muted", feature ? "block lg:hidden xl:block" : "block")}>{link.description}</span>}
                      </span>
                    </SiteAnchor>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The featured product — Deskzo One — as a card in Deskzo blue's light: its icon, name and line, and the
 * icons of every product it holds, which lift in a wave as the pointer comes over the card.
 */
function FeatureCard({ column, id, every }: { column: ProductColumn; id: string; every: Product[] }) {
  const first = column.links[0];
  if (!first) return null;
  const { link, product } = first;
  const others = every.filter((p) => p.key !== product.key);
  return (
    <div className="flex min-w-0 flex-col">
      {column.title && <ColumnTitle id={id}>{column.title}</ColumnTitle>}
      <SiteAnchor
        href={link.href}
        className={cn(
          "group relative flex flex-1 flex-col overflow-hidden rounded-2xl border border-[color-mix(in_srgb,var(--brand)_22%,var(--line))] bg-[linear-gradient(160deg,color-mix(in_srgb,var(--brand)_12%,var(--surface))_0%,var(--surface)_70%)] p-5 transition-shadow duration-300 hover:shadow-[0_18px_40px_-18px_color-mix(in_srgb,var(--brand)_55%,transparent)]",
          column.title && "mt-2",
        )}
      >
        <span aria-hidden="true" className="pointer-events-none absolute -right-14 -top-14 h-44 w-44 rounded-full bg-brand opacity-15 blur-3xl transition-opacity duration-300 group-hover:opacity-25" />
        <ProductIcon product={product.key} className="relative h-14 w-14 transition-transform duration-300 ease-out group-hover:-translate-y-1" />
        <span className="relative mt-4 text-lg font-semibold tracking-tight text-text">{link.label}</span>
        {link.description && <span className="relative mt-1 text-sm leading-6 text-muted">{link.description}</span>}
        {others.length > 0 && (
          // At the card's foot, like a dock: as many across as fit, the last row centred.
          <span aria-hidden="true" className="relative mt-auto block pt-6">
            <span className="flex flex-wrap justify-center gap-1 rounded-xl border border-line/70 bg-surface/80 p-2 shadow-sm xl:gap-1.5">
              {others.map((p, k) => (
                <ProductIcon key={p.key} product={p.key} className="h-8 w-8 transition-transform duration-300 ease-out group-hover:-translate-y-1 xl:h-9 xl:w-9" style={{ transitionDelay: `${k * 25}ms` }} />
              ))}
            </span>
          </span>
        )}
        <span aria-hidden="true" className={cn("relative inline-flex items-center gap-1.5 text-sm font-semibold text-brand", others.length ? "mt-4" : "mt-auto pt-5")}>
          {`Explore ${link.label}`}
          <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
        </span>
      </SiteAnchor>
    </div>
  );
}

/** Any other menu: its columns side by side, kept together at the left when there are few. */
const COLUMNS_GRID: Record<number, string> = { 1: "grid-cols-1 max-w-md", 2: "grid-cols-2 max-w-3xl", 3: "grid-cols-3 max-w-5xl", 4: "grid-cols-4", 5: "grid-cols-5" };

/** Names alone (the Compare menu): tiles, three across, rather than a long thin list. */
const asTiles = (column: NavMenu["columns"][number]) => column.items.length > 3 && column.items.every((i) => !i.description);

function ColumnsPanel({ menu, idPrefix }: { menu: NavMenu; idPrefix: string }) {
  const cols = Math.min(Math.max(menu.columns.length, 1), 5);
  const single = menu.columns[0];
  return (
    <div className={cn("grid gap-x-8 gap-y-7", cols === 1 && single && asTiles(single) ? "grid-cols-1 max-w-2xl" : COLUMNS_GRID[cols])}>
      {menu.columns.map((column, c) => {
        const tiles = asTiles(column);
        return (
          <div key={c} className="min-w-0">
            {column.title && <ColumnTitle id={`${idPrefix}-${c}`}>{column.title}</ColumnTitle>}
            <ul aria-labelledby={column.title ? `${idPrefix}-${c}` : undefined} className={cn(tiles ? "grid grid-cols-2 gap-2 xl:grid-cols-3" : "space-y-0.5", column.title && (tiles ? "mt-3" : "mt-2"))}>
              {column.items.map((link, j) => {
                const product = productByPath(link.href);
                return (
                  <li key={j}>
                    {tiles ? (
                      <SiteAnchor
                        href={link.href}
                        className="group flex items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3 py-2.5 text-sm font-medium text-text transition-colors hover:border-line-strong hover:bg-surface-sunken"
                      >
                        <span className="truncate">{link.label}</span>
                        <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-subtle transition-[color,transform] duration-200 group-hover:translate-x-0.5 group-hover:text-brand" />
                      </SiteAnchor>
                    ) : (
                      <SiteAnchor href={link.href} className="group flex items-start gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-surface-sunken">
                        {product ? <ProductIcon product={product.key} className="h-9 w-9" /> : <NavIconChip href={link.href} />}
                        <span className="min-w-0">
                          <span className="flex items-center gap-1 text-sm font-medium text-text transition-colors group-hover:text-brand">
                            {link.label}
                            <HoverArrow />
                          </span>
                          {link.description && <span className="mt-0.5 line-clamp-2 text-[13px] leading-5 text-muted">{link.description}</span>}
                        </span>
                      </SiteAnchor>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
