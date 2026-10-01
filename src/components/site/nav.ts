import type { NavItem, NavMenu, NavMenuItem, SiteLink, SiteRenderContext } from "@/components/site/blocks/types";
import { fill, linkShown } from "@/components/site/links";

/**
 * The header's items as the site reads them: a link, or a menu of columns. Stored settings are read
 * tolerantly — those saved before menus existed hold plain links, which are items as they are, and
 * anything that is neither (a half-written menu from an older editor, a stray value) is left out
 * rather than breaking every page's header. Pure and client-safe: the header, the CMS's preview and
 * the checks share it.
 */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A menu, not a link: it has columns. */
export function isNavMenu(item: NavItem): item is NavMenu {
  return Array.isArray((item as Partial<NavMenu>).columns);
}

function readLink(raw: unknown): SiteLink | null {
  if (!isObj(raw) || !str(raw.label).trim() || !str(raw.href).trim()) return null;
  return { label: str(raw.label), href: str(raw.href) };
}

function readMenuItem(raw: unknown): NavMenuItem | null {
  const link = readLink(raw);
  if (!link) return null;
  const description = isObj(raw) ? str(raw.description).trim() : "";
  return description ? { ...link, description } : link;
}

/** The stored `nav`, as items the header can draw. */
export function readNav(raw: unknown): NavItem[] {
  if (!Array.isArray(raw)) return [];
  const out: NavItem[] = [];
  for (const entry of raw) {
    if (!isObj(entry) || !str(entry.label).trim()) continue;
    if (Array.isArray(entry.columns)) {
      const columns = entry.columns
        .filter(isObj)
        .map((c) => ({ title: str(c.title), items: (Array.isArray(c.items) ? c.items : []).map(readMenuItem).filter((i): i is NavMenuItem => !!i) }))
        .filter((c) => c.items.length);
      const footer = readLink(entry.footer);
      // A menu with nothing in it has nothing to open.
      if (columns.length) out.push({ label: str(entry.label), columns, ...(footer ? { footer } : {}) });
      continue;
    }
    const link = readLink(entry);
    if (link) out.push(link);
  }
  return out;
}

/**
 * The header's items with their tokens ({siteName}, {trialDays}…) filled — what the header is handed.
 * Links to a page switched off for now are left out, and a column or menu left empty goes with them.
 */
export function fillNav(raw: unknown, ctx: Pick<SiteRenderContext, "settings" | "trialDays" | "hiddenPaths">): NavItem[] {
  const t = (s: string | undefined) => fill(s, ctx);
  const shown = (href: string) => linkShown(href, ctx);
  return readNav(raw).flatMap((item): NavItem[] => {
    if (!isNavMenu(item)) return shown(item.href) ? [{ label: t(item.label), href: item.href }] : [];
    const columns = item.columns
      .map((c) => ({ title: t(c.title), items: c.items.filter((i) => shown(i.href)).map((i) => ({ label: t(i.label), href: i.href, ...(i.description ? { description: t(i.description) } : {}) })) }))
      .filter((c) => c.items.length);
    if (!columns.length) return [];
    return [{ label: t(item.label), columns, ...(item.footer && shown(item.footer.href) ? { footer: { label: t(item.footer.label), href: item.footer.href } } : {}) }];
  });
}

/** Every link the header holds, menus opened out — for the checks and anything that lists the site's links. */
export function navLinks(nav: readonly NavItem[]): SiteLink[] {
  return nav.flatMap((item) => (isNavMenu(item) ? [...item.columns.flatMap((c) => c.items.map((i) => ({ label: i.label, href: i.href }))), ...(item.footer ? [item.footer] : [])] : [item]));
}
