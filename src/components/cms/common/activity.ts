import type { ActivityFeedItem } from "@/components/console/kit/activity-feed";
import type { Tone } from "@/lib/console-shared/types";
import type { Clock } from "@/lib/time/zone";
import { CMS_ROUTES } from "@/lib/cms/nav";
import { CMS_AUDIT_ACTIONS, CMS_ROLE_LABELS, LEAD_STATUS_LABELS, LEAD_TOPIC_LABELS, type CmsAuditAction, type CmsAuditRow, type CmsRole, type SiteLeadStatus } from "@/lib/cms/types";

/**
 * The CMS activity log in words: a label for every action it writes (built from `CMS_AUDIT_ACTIONS`,
 * so a new action without a label fails to compile), the categories the Activity page filters by,
 * the screen each row links to, and a one-line summary of the row's detail — ids, slugs, titles and
 * counts, which is all the log ever holds.
 *
 * Pure and client-safe.
 */

export type ActionCategory = "auth" | "account" | "user" | "security" | "page" | "post" | "category" | "tag" | "media" | "settings" | "redirect" | "lead" | "preview";

export const ACTION_CATEGORIES: readonly { key: ActionCategory; label: string }[] = [
  { key: "page", label: "Pages" },
  { key: "post", label: "Posts" },
  { key: "category", label: "Categories" },
  { key: "tag", label: "Tags" },
  { key: "media", label: "Media" },
  { key: "settings", label: "Settings & navigation" },
  { key: "redirect", label: "Redirects" },
  { key: "lead", label: "Leads" },
  { key: "preview", label: "Previews" },
  { key: "user", label: "Users" },
  { key: "security", label: "Security" },
  { key: "auth", label: "Sign-ins" },
  { key: "account", label: "Own account" },
];

export const CMS_ACTION_LABELS: Record<CmsAuditAction, { label: string; tone: Tone }> = {
  "auth.sign-in": { label: "Signed in", tone: "neutral" },
  "auth.sign-out": { label: "Signed out", tone: "neutral" },
  "auth.password.set": { label: "Chose a password", tone: "neutral" },
  "auth.two-factor.enrolled": { label: "Turned on two-factor", tone: "success" },
  "auth.two-factor.removed": { label: "Removed their authenticator", tone: "warning" },
  "account.password-link": { label: "Asked for a password link", tone: "neutral" },
  "account.rename": { label: "Changed a name", tone: "neutral" },
  "account.session.end": { label: "Ended a session", tone: "neutral" },
  "account.sessions.end-others": { label: "Signed out other sessions", tone: "neutral" },
  "user.create": { label: "Invited a user", tone: "brand" },
  "user.role": { label: "Changed a role", tone: "info" },
  "user.deactivate": { label: "Switched off a user", tone: "danger" },
  "user.reactivate": { label: "Switched a user back on", tone: "info" },
  "user.setup-link": { label: "Sent a new setup link", tone: "neutral" },
  "user.two-factor.reset": { label: "Reset a user's two-factor", tone: "warning" },
  "user.sessions.end": { label: "Signed a user out everywhere", tone: "warning" },
  "security.two-factor-policy": { label: "Changed the two-factor policy", tone: "warning" },
  "page.create": { label: "Created a page", tone: "brand" },
  "page.save": { label: "Edited a page draft", tone: "neutral" },
  "page.publish": { label: "Published a page", tone: "success" },
  "page.unpublish": { label: "Unpublished a page", tone: "warning" },
  "page.version.save": { label: "Saved a page version", tone: "neutral" },
  "page.version.restore": { label: "Restored a page version", tone: "info" },
  "page.slug": { label: "Changed a page's address", tone: "info" },
  "page.archive": { label: "Archived a page", tone: "warning" },
  "page.unarchive": { label: "Restored an archived page", tone: "info" },
  "page.delete": { label: "Deleted a page", tone: "danger" },
  "post.create": { label: "Created a post", tone: "brand" },
  "post.save": { label: "Edited a post", tone: "neutral" },
  "post.publish": { label: "Published a post", tone: "success" },
  "post.schedule": { label: "Scheduled a post", tone: "info" },
  "post.unpublish": { label: "Unpublished a post", tone: "warning" },
  "post.archive": { label: "Archived a post", tone: "warning" },
  "post.unarchive": { label: "Restored an archived post", tone: "info" },
  "post.delete": { label: "Deleted a post", tone: "danger" },
  "settings.save": { label: "Edited the settings draft", tone: "neutral" },
  "settings.publish": { label: "Published the site settings", tone: "success" },
  "settings.search": { label: "Changed the search & AI settings", tone: "warning" },
  "media.upload": { label: "Uploaded an image", tone: "brand" },
  "media.alt": { label: "Changed an image's alt text", tone: "neutral" },
  "media.delete": { label: "Deleted an image", tone: "danger" },
  "lead.create": { label: "A lead came in", tone: "brand" },
  "lead.update": { label: "Updated a lead", tone: "neutral" },
  "lead.export": { label: "Exported leads", tone: "neutral" },
  "preview.link": { label: "Opened a draft preview", tone: "neutral" },
  "category.create": { label: "Added a category", tone: "brand" },
  "category.update": { label: "Changed a category", tone: "neutral" },
  "category.delete": { label: "Deleted a category", tone: "danger" },
  "tag.create": { label: "Added a tag", tone: "brand" },
  "tag.update": { label: "Changed a tag", tone: "neutral" },
  "tag.merge": { label: "Merged tags", tone: "info" },
  "tag.delete": { label: "Deleted a tag", tone: "danger" },
  "redirect.create": { label: "Added a redirect", tone: "brand" },
  "redirect.update": { label: "Changed a redirect", tone: "neutral" },
  "redirect.delete": { label: "Deleted a redirect", tone: "danger" },
  "redirect.import": { label: "Imported redirects", tone: "info" },
};

/** The actions, as filter options, in the log's own order. */
export const ACTION_OPTIONS = CMS_AUDIT_ACTIONS.map((action) => ({ value: action, label: CMS_ACTION_LABELS[action].label }));

const isKnown = (action: string): action is CmsAuditAction => Object.prototype.hasOwnProperty.call(CMS_ACTION_LABELS, action);

/** A row's words and colour. An action written by a newer release shows as itself rather than breaking the page. */
export function actionLabel(action: string): { label: string; tone: Tone } {
  return isKnown(action) ? CMS_ACTION_LABELS[action] : { label: action, tone: "neutral" };
}

/**
 * "Asha Rao (asha@example.com)" as the log stores a CMS user → the name, with the address kept for a
 * tooltip. "Platform staff: Ravi", "script" and "Website" come back as they are.
 */
export function actorParts(label: string): { name: string; email: string | null } {
  const m = /^(.*) \(([^()\s]+@[^()\s]+)\)$/.exec(label);
  if (m) return { name: m[1]!, email: m[2]! };
  return { name: label === "script" ? "Script" : label, email: null };
}

/**
 * The screen a row is about, where there is one: a page, a post, an image, a lead, the categories and
 * tags — and people, settings and redirects, for those who may open them. Deleted things still link;
 * their screen says they are gone.
 */
export function entityHref(
  row: Pick<CmsAuditRow, "entity" | "entityId" | "action">,
  opts: { canOpenUsers: boolean; canOpenSecurity: boolean; canOpenRedirects?: boolean },
): string | null {
  const id = row.entityId;
  switch (row.entity) {
    case "page":
      return id && row.action !== "page.delete" ? CMS_ROUTES.page(id) : null;
    case "post":
      return id && row.action !== "post.delete" ? CMS_ROUTES.post(id) : null;
    case "media":
      return id && row.action !== "media.delete" ? CMS_ROUTES.mediaItem(id) : null;
    case "lead":
      return id ? CMS_ROUTES.lead(id) : CMS_ROUTES.leads;
    case "user":
      return opts.canOpenUsers ? CMS_ROUTES.users : null;
    case "category":
      return CMS_ROUTES.categories;
    case "tag":
      return CMS_ROUTES.tags;
    case "redirect":
      return opts.canOpenRedirects ? CMS_ROUTES.redirects : null;
    case "settings":
      if (row.action === "security.two-factor-policy") return opts.canOpenSecurity ? CMS_ROUTES.security : null;
      // Search & AI is an admin's page, as Security is.
      if (row.action === "settings.search") return opts.canOpenSecurity ? CMS_ROUTES.search : null;
      return CMS_ROUTES.settings;
    default:
      return null;
  }
}

const SETTINGS_FIELD_NAMES: Record<string, string> = {
  siteName: "site name",
  tagline: "tagline",
  displayDomain: "display domain",
  salesEmail: "sales email",
  nav: "header menu",
  signinLink: "sign-in link",
  signupCta: "sign-up button",
  footer: "footer",
  social: "social links",
  seo: "search defaults",
  notFound: "not-found page",
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const roleName = (v: unknown) => (typeof v === "string" && v in CMS_ROLE_LABELS ? CMS_ROLE_LABELS[v as CmsRole] : String(v ?? "?"));
const leadStatusName = (v: unknown) => (typeof v === "string" && v in LEAD_STATUS_LABELS ? LEAD_STATUS_LABELS[v as SiteLeadStatus] : String(v ?? "?"));
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;
const joined = (parts: (string | null | false | undefined)[]) => parts.filter((p): p is string => !!p).join(" · ") || null;

const TERM_FIELD_NAMES: Record<string, string> = { name: "name", slug: "address", description: "description", seo: "search details", parent: "parent" };

/** A category's or tag's change: its old and new address when that moved, else which fields changed — and the redirect left behind. */
function termChange(d: Record<string, unknown>, archive: (slug: string) => string): string | null {
  const slug = str(d.slug);
  const from = str(d.from);
  const fields = Array.isArray(d.changed) ? d.changed.filter((f): f is string => typeof f === "string" && f !== "slug").map((f) => TERM_FIELD_NAMES[f] ?? f) : [];
  return joined([from && slug ? `${archive(from)} → ${archive(slug)}` : null, fields.length ? fields.join(", ") : null, str(d.redirectId) ? "a redirect was made from the old address" : null]);
}

const categoryArchive = (slug: string) => `/blog/category/${slug}`;
const tagArchive = (slug: string) => `/blog/tag/${slug}`;
const REDIRECT_FIELD_NAMES: Record<string, string> = { from: "old address", to: "target", status: "status", match: "match", enabled: "on/off", note: "note" };

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What a row was about, in a few words: the thing's name (`subject`) and, when the detail says more,
 * one line of it (`note`) — "About us", "/about → /company/about", "Editor → Admin". A time in it is
 * on `clock`, the console's.
 */
export function describeActivity(row: Pick<CmsAuditRow, "action" | "detail">, clock: Clock): { subject: string | null; note: string | null } {
  const d = row.detail ?? {};
  const title = str(d.title);
  const slug = str(d.slug);
  const path = slug ? (slug === "home" ? "/" : `/${slug}`) : null;
  switch (row.action) {
    case "page.slug":
      return { subject: null, note: `/${str(d.from) ?? "?"} → /${str(d.to) ?? "?"}` };
    case "page.create":
    case "page.publish":
    case "page.unpublish":
    case "page.archive":
    case "page.delete":
      return { subject: title ?? path, note: title && path ? path : null };
    case "page.save":
    case "page.unarchive":
    case "page.version.save":
    case "page.version.restore":
      return { subject: path, note: num(d.blocks) !== null ? count(num(d.blocks)!, "block") : null };
    case "post.schedule": {
      const at = str(d.publishAt);
      return { subject: title ?? slug, note: at ? `Goes live ${clock.dateTime(at)}` : null };
    }
    case "post.create":
    case "post.publish":
    case "post.unpublish":
    case "post.archive":
    case "post.delete":
      return { subject: title ?? slug, note: slug ? `/blog/${slug}` : null };
    case "post.save":
      return { subject: slug ? `/blog/${slug}` : null, note: d.live === true ? "A live post — the change showed on the site at once" : null };
    case "post.unarchive":
      return { subject: slug ? `/blog/${slug}` : null, note: null };
    case "preview.link":
      return { subject: path ?? (slug ? `/blog/${slug}` : null), note: null };
    case "media.upload": {
      const size = num(d.size);
      return { subject: str(d.filename), note: size !== null ? sizeText(size) : null };
    }
    case "media.alt":
      return { subject: str(d.filename), note: d.empty === true ? "Alt text removed" : null };
    case "media.delete":
      return { subject: str(d.filename), note: null };
    case "user.create":
      return { subject: str(d.email), note: d.role ? `As ${roleName(d.role)}` : null };
    case "user.role":
      return { subject: str(d.email), note: `${roleName(d.from)} → ${roleName(d.to)}` };
    case "user.deactivate":
    case "user.reactivate":
    case "user.two-factor.reset":
      return { subject: str(d.email), note: null };
    case "user.setup-link":
      return { subject: str(d.email), note: null };
    case "user.sessions.end":
    case "account.sessions.end-others": {
      const n = num(d.sessions);
      return { subject: null, note: n !== null ? count(n, "session") : null };
    }
    case "auth.sign-in":
      return { subject: null, note: d.twoFactor === true ? "With two-factor" : "Password only" };
    case "security.two-factor-policy":
      return { subject: null, note: d.mode === "required" ? "Now required for everybody" : d.mode === "optional" ? "Now optional" : null };
    case "settings.search": {
      const said: Record<string, (on: boolean) => string> = {
        hideSite: (on) => (on ? "site hidden from search" : "site visible in search"),
        aiSearch: (on) => (on ? "AI search allowed" : "AI search refused"),
        aiTraining: (on) => (on ? "AI training allowed" : "AI training refused"),
        llmsTxt: (on) => (on ? "llms.txt on" : "llms.txt off"),
      };
      const fields = Array.isArray(d.fields) ? d.fields.filter((f): f is string => typeof f === "string") : [];
      const parts = fields.map((f) => (f in said && typeof d[f] === "boolean" ? said[f]!(d[f] as boolean) : f === "llmsSummary" ? "llms.txt summary" : f));
      return { subject: null, note: parts.length ? parts.join(", ") : null };
    }
    case "settings.save": {
      const fields = Array.isArray(d.fields) ? d.fields.filter((f): f is string => typeof f === "string").map((f) => SETTINGS_FIELD_NAMES[f] ?? f) : [];
      return { subject: null, note: fields.length ? fields.join(", ") : null };
    }
    case "lead.create":
      return { subject: null, note: typeof d.topic === "string" && d.topic in LEAD_TOPIC_LABELS ? `Topic: ${LEAD_TOPIC_LABELS[d.topic as keyof typeof LEAD_TOPIC_LABELS]}` : null };
    case "lead.update": {
      const parts = [d.from || d.to ? `${leadStatusName(d.from)} → ${leadStatusName(d.to)}` : null, d.notes === true ? "notes edited" : null].filter(Boolean);
      return { subject: null, note: parts.length ? parts.join(" · ") : null };
    }
    case "lead.export": {
      const n = num(d.rows);
      return { subject: null, note: n !== null ? count(n, "row") : null };
    }
    case "category.create":
      return { subject: str(d.name) ?? slug, note: joined([slug ? categoryArchive(slug) : null, str(d.parent) ? `under ${str(d.parent)}` : null]) };
    case "category.update":
      if (d.reorder === true) return { subject: null, note: str(d.parent) ? `Put the subcategories of ${str(d.parent)} in a new order` : "Put the top-level categories in a new order" };
      return { subject: str(d.name) ?? slug, note: termChange(d, categoryArchive) };
    case "category.delete": {
      const n = num(d.posts);
      return { subject: str(d.name) ?? slug, note: joined([slug ? categoryArchive(slug) : null, n ? `taken off ${count(n, "post")}` : null]) };
    }
    case "tag.create":
      return { subject: str(d.name) ?? slug, note: str(d.post) ? "Added while writing a post" : slug ? tagArchive(slug) : null };
    case "tag.update":
      return { subject: str(d.name) ?? slug, note: termChange(d, tagArchive) };
    case "tag.merge": {
      const n = num(d.posts);
      const from = str(d.from);
      return {
        subject: str(d.fromName) ?? from,
        note: joined([str(d.into) ? `into #${str(d.into)}` : null, n !== null ? `${count(n, "post")} moved` : null, str(d.redirectId) && from ? `${tagArchive(from)} now redirects` : null]),
      };
    }
    case "tag.delete": {
      const n = num(d.posts);
      return { subject: str(d.name) ?? slug, note: joined([slug ? tagArchive(slug) : null, n ? `taken off ${count(n, "post")}` : null]) };
    }
    case "redirect.create": {
      const from = str(d.from);
      const to = str(d.to);
      return {
        subject: from && to ? `${from} → ${to}` : from,
        note: d.automatic === true ? "Made automatically when an address changed" : joined([num(d.status) !== null ? String(num(d.status)) : null, d.match === "PREFIX" ? "everything under it" : null, d.enabled === false ? "switched off" : null]),
      };
    }
    case "redirect.update": {
      const from = str(d.from);
      const to = str(d.to);
      const fields = Array.isArray(d.changed) ? d.changed.filter((f): f is string => typeof f === "string").map((f) => REDIRECT_FIELD_NAMES[f] ?? f) : [];
      const toggled = d.enabled === false ? "switched off" : d.enabled === true ? "switched on" : null;
      return {
        subject: from && to ? `${from} → ${to}` : from,
        note: str(d.reason) ?? (d.automatic === true ? "Updated automatically when an address changed" : joined([toggled, str(d.fromBefore) ? `was from ${str(d.fromBefore)}` : null, str(d.toBefore) ? `was to ${str(d.toBefore)}` : null, !toggled && fields.length ? fields.join(", ") : null])),
      };
    }
    case "redirect.delete": {
      const from = str(d.from);
      const to = str(d.to);
      return { subject: from && to ? `${from} → ${to}` : from, note: str(d.reason) ?? (d.automatic === true ? "It had been made automatically" : null) };
    }
    case "redirect.import": {
      const parts = [
        num(d.created) ? `${num(d.created)!.toLocaleString("en-IN")} created` : null,
        num(d.updated) ? `${num(d.updated)!.toLocaleString("en-IN")} updated` : null,
        num(d.unchanged) ? `${num(d.unchanged)!.toLocaleString("en-IN")} unchanged` : null,
        num(d.refused) ? `${num(d.refused)!.toLocaleString("en-IN")} refused` : null,
      ];
      const rows = num(d.rows);
      return { subject: rows !== null ? count(rows, "row") : null, note: joined(parts) };
    }
    default:
      return { subject: null, note: null };
  }
}

/**
 * Log rows as the console's `ActivityFeed` draws them (the dashboard, My account): "Published a page
 * — About us", the note under it, who, and when. `hideActor` for a feed that is all one person's.
 */
export function activityFeedItems(
  rows: CmsAuditRow[],
  opts: { canOpenUsers: boolean; canOpenSecurity: boolean; canOpenRedirects?: boolean; hideActor?: boolean },
  clock: Clock,
): ActivityFeedItem[] {
  return rows.map((row) => {
    const { label, tone } = actionLabel(row.action);
    const { subject, note } = describeActivity(row, clock);
    return {
      id: row.id,
      at: row.at,
      title: subject ? `${label} — ${subject}` : label,
      detail: note,
      actor: opts.hideActor ? null : actorParts(row.actorLabel).name,
      tone,
      href: entityHref(row, opts),
    };
  });
}
