import type { SiteLink, SiteSettings } from "@/components/site/blocks/types";
import { stableJson } from "@/lib/cms/validate";

/**
 * "What changes on publish": the site's settings as they would go live, against what the site shows
 * now — one line per thing that differs, in words ("Tagline: Your tagline goes here → Built for
 * India"). Lists are summarised by their labels rather than dumped, since the point is to recognise
 * the change, not to review it character by character. Pure and client-safe.
 */

export type SettingsChange = { key: string; label: string; from: string; to: string };

/** Strings trimmed; empty strings, nulls and undefined left out — so "" and a missing optional field compare equal. */
export function normalize(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const n = normalize(v);
      if (n === "" || n === null || n === undefined) continue;
      out[k] = n;
    }
    return out;
  }
  return value;
}

export const sameValue = (a: unknown, b: unknown) => stableJson(normalize(a)) === stableJson(normalize(b));

const MAX = 70;
const clip = (text: string) => (text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text);
const shown = (text: string | undefined | null) => (text && text.trim() ? `“${clip(text.trim())}”` : "(empty)");
const labels = (links: SiteLink[] | undefined) => (links && links.length ? clip(links.map((l) => l.label.trim() || "(no label)").join(" · ")) : "(none)");
const linkText = (link: SiteLink | undefined) => (link ? `${link.label.trim() || "(no label)"} → ${link.href.trim() || "(no address)"}` : "(none)");

function listChange(key: string, label: string, from: SiteLink[] | undefined, to: SiteLink[] | undefined): SettingsChange | null {
  if (sameValue(from, to)) return null;
  const a = labels(from);
  const b = labels(to);
  return { key, label, from: a, to: a === b ? `${b} (addresses changed)` : b };
}

function textChange(key: string, label: string, from: string | undefined, to: string | undefined): SettingsChange | null {
  return sameValue(from ?? "", to ?? "") ? null : { key, label, from: shown(from), to: shown(to) };
}

function linkChange(key: string, label: string, from: SiteLink | undefined, to: SiteLink | undefined): SettingsChange | null {
  return sameValue(from, to) ? null : { key, label, from: linkText(from), to: linkText(to) };
}

export function settingsChanges(next: SiteSettings, live: SiteSettings): SettingsChange[] {
  const columns = (s: SiteSettings) =>
    s.footer?.columns?.length ? clip(s.footer.columns.map((c) => `${c.title.trim() || "(untitled)"} (${c.links.length})`).join(" · ")) : "(none)";
  const social = (s: SiteSettings) => (s.social?.length ? clip(s.social.map((x) => x.label?.trim() || x.network).join(" · ")) : "(none)");
  const changes: (SettingsChange | null)[] = [
    textChange("siteName", "Site name", live.siteName, next.siteName),
    textChange("tagline", "Tagline", live.tagline, next.tagline),
    textChange("displayDomain", "Display domain", live.displayDomain, next.displayDomain),
    textChange("salesEmail", "Sales email", live.salesEmail, next.salesEmail),
    sameValue(live.social, next.social) ? null : { key: "social", label: "Social links", from: social(live), to: social(next) },
    textChange("seo.titleTemplate", "Title template", live.seo?.titleTemplate, next.seo?.titleTemplate),
    textChange("seo.defaultTitle", "Default title", live.seo?.defaultTitle, next.seo?.defaultTitle),
    textChange("seo.description", "Default description", live.seo?.description, next.seo?.description),
    sameValue(live.seo?.ogImage, next.seo?.ogImage)
      ? null
      : { key: "seo.ogImage", label: "Sharing image", from: live.seo?.ogImage ? "An image" : "(none)", to: next.seo?.ogImage ? (live.seo?.ogImage ? "Another image" : "An image") : "(none)" },
    listChange("nav", "Header menu", live.nav, next.nav),
    linkChange("signinLink", "Sign-in link", live.signinLink, next.signinLink),
    linkChange("signupCta.open", "Button while sign-up is open", live.signupCta?.open, next.signupCta?.open),
    linkChange("signupCta.inviteOnly", "Button while invitation-only", live.signupCta?.inviteOnly, next.signupCta?.inviteOnly),
    sameValue(live.footer?.columns, next.footer?.columns) ? null : { key: "footer.columns", label: "Footer columns", from: columns(live), to: columns(next) === columns(live) ? `${columns(next)} (links changed)` : columns(next) },
    textChange("footer.note", "Footer note", live.footer?.note, next.footer?.note),
    textChange("notFound.heading", "Not-found heading", live.notFound?.heading, next.notFound?.heading),
    textChange("notFound.body", "Not-found text", live.notFound?.body, next.notFound?.body),
    listChange("notFound.links", "Not-found links", live.notFound?.links, next.notFound?.links),
  ];
  return changes.filter((c): c is SettingsChange => c !== null);
}
