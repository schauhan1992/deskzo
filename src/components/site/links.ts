import type { SiteAction, SiteLink, SiteRenderContext } from "@/components/site/blocks/types";

/**
 * What the site's content may link to and show — checked when rendered, because content comes from
 * people editing it in the website CMS, not from code review.
 *
 *   · a path on this site: "/pricing", "/#modules", "/contact?topic=demo" — never "//elsewhere",
 *     which a browser reads as another host;
 *   · an http(s) address;
 *   · `mailto:` one plain address — nothing after it (no ?subject=, no second address).
 *
 * Nothing else: no `javascript:`, no `data:`.
 */
export function safeHref(raw: string | null | undefined): string | null {
  const href = String(raw ?? "").trim();
  if (!href || href.length > 2048 || /[\s\u0000-\u001f\\]/.test(href)) return null;
  if (href.startsWith("/")) return href.startsWith("//") ? null : href;
  if (href.startsWith("#")) return href;
  // An email link, when it names one plain address (the CMS allows them; nothing else rides along).
  if (/^mailto:[^\s@?#]+@[^\s@?#]+\.[^\s@?#]+$/i.test(href)) return href;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** An image: a file on this site, or an https address. */
export function safeSrc(raw: string | null | undefined): string | null {
  const src = safeHref(raw);
  if (!src) return null;
  return src.startsWith("/") || src.startsWith("https:") ? src : null;
}

/** An element id from content ("modules" for /#modules): lower-case letters, digits and hyphens. */
export function anchorId(raw: string | null | undefined): string | undefined {
  const id = String(raw ?? "").trim();
  return /^[a-z][a-z0-9-]{0,47}$/.test(id) ? id : undefined;
}

/** Whether a checked link stays on this site (rendered with next/link) or leaves it. */
export const isInternal = (href: string) => href.startsWith("/") || href.startsWith("#");

/**
 * Whether a link may be shown: not when it goes to a page of the site that is switched off for now
 * (`SiteRenderContext.hiddenPaths`), which would only answer "not found".
 */
export function linkShown(href: string | null | undefined, ctx: Pick<SiteRenderContext, "hiddenPaths">): boolean {
  if (!href || !ctx.hiddenPaths?.length || !href.startsWith("/")) return true;
  const path = href.split(/[?#]/)[0]!.replace(/(.)\/+$/, "$1");
  return !ctx.hiddenPaths.includes(path);
}

/**
 * Replaces the tokens content may carry. Unknown ones are left as written, so a typo shows up on the
 * page rather than disappearing.
 */
export function fill(text: string | null | undefined, ctx: Pick<SiteRenderContext, "settings" | "trialDays">): string {
  const values: Record<string, string> = {
    siteName: ctx.settings.siteName,
    tagline: ctx.settings.tagline,
    displayDomain: ctx.settings.displayDomain,
    salesEmail: ctx.settings.salesEmail,
    trialDays: String(ctx.trialDays),
  };
  return String(text ?? "").replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

/**
 * A comparison table's cell as the site shows it (and the SEO engine reads it): "yes", "partial" and
 * "no" become a mark and a word — "Yes", "Partly", "No" — and anything else is shown as written.
 */
export function comparisonMark(raw: string | null | undefined): { kind: "yes" | "partial" | "no" | "text"; text: string } {
  const value = String(raw ?? "").trim();
  switch (value.toLowerCase()) {
    case "yes":
      return { kind: "yes", text: "Yes" };
    case "partial":
      return { kind: "partial", text: "Partly" };
    case "no":
      return { kind: "no", text: "No" };
    default:
      return { kind: "text", text: value };
  }
}

/** A source's site, as its link says it: "zoho.com" for https://www.zoho.com/crm/pricing.html. Null when it is not an http(s) address. */
export function sourceSite(raw: string | null | undefined): { href: string; name: string } | null {
  const href = safeHref(raw);
  if (!href || !/^https?:/i.test(href)) return null;
  try {
    return { href, name: new URL(href).hostname.replace(/^www\./, "") };
  } catch {
    return null;
  }
}

const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/**
 * "2026-09-29" as "29 September 2026" — the calendar day it names, the same in every zone; null when it
 * is not a date. Spelled here rather than asked of Intl, so the CMS's preview in a browser reads as the
 * site does.
 */
export function calendarDateLabel(value: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  // 31 February is not a date, and Date.UTC would quietly make it 3 March.
  const probe = new Date(Date.UTC(year, month, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month || probe.getUTCDate() !== day) return null;
  return `${day} ${LONG_MONTHS[month]} ${year}`;
}

/** An action as the link it is now: `signup` follows whether signing up is open. */
export function resolveAction(action: SiteAction, ctx: Pick<SiteRenderContext, "settings" | "signupOpen" | "trialDays">): SiteLink {
  if (action.kind === "signup") {
    const cta = ctx.signupOpen ? ctx.settings.signupCta.open : ctx.settings.signupCta.inviteOnly;
    return { label: fill(cta.label, ctx), href: cta.href };
  }
  return { label: fill(action.label, ctx), href: action.href };
}
