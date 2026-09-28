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

/** An action as the link it is now: `signup` follows whether signing up is open. */
export function resolveAction(action: SiteAction, ctx: Pick<SiteRenderContext, "settings" | "signupOpen" | "trialDays">): SiteLink {
  if (action.kind === "signup") {
    const cta = ctx.signupOpen ? ctx.settings.signupCta.open : ctx.settings.signupCta.inviteOnly;
    return { label: fill(cta.label, ctx), href: cta.href };
  }
  return { label: fill(action.label, ctx), href: action.href };
}
