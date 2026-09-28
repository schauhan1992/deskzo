import type { ActivityFeedItem } from "@/components/console/kit/activity-feed";
import type { Tone } from "@/lib/console-shared/types";
import { formatIstDateTime } from "@/lib/india-time";
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

export type ActionCategory = "auth" | "account" | "user" | "security" | "page" | "post" | "media" | "settings" | "lead" | "preview";

export const ACTION_CATEGORIES: readonly { key: ActionCategory; label: string }[] = [
  { key: "page", label: "Pages" },
  { key: "post", label: "Posts" },
  { key: "media", label: "Media" },
  { key: "settings", label: "Settings & navigation" },
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
  "media.upload": { label: "Uploaded an image", tone: "brand" },
  "media.alt": { label: "Changed an image's alt text", tone: "neutral" },
  "media.delete": { label: "Deleted an image", tone: "danger" },
  "lead.create": { label: "A lead came in", tone: "brand" },
  "lead.update": { label: "Updated a lead", tone: "neutral" },
  "lead.export": { label: "Exported leads", tone: "neutral" },
  "preview.link": { label: "Opened a draft preview", tone: "neutral" },
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
 * The screen a row is about, where there is one: a page, a post, an image, a lead — and people and
 * settings, for those who may open them. Deleted things still link; their screen says they are gone.
 */
export function entityHref(row: Pick<CmsAuditRow, "entity" | "entityId" | "action">, opts: { canOpenUsers: boolean; canOpenSecurity: boolean }): string | null {
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
    case "settings":
      if (row.action === "security.two-factor-policy") return opts.canOpenSecurity ? CMS_ROUTES.security : null;
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

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What a row was about, in a few words: the thing's name (`subject`) and, when the detail says more,
 * one line of it (`note`) — "About us", "/about → /company/about", "Editor → Admin".
 */
export function describeActivity(row: Pick<CmsAuditRow, "action" | "detail">): { subject: string | null; note: string | null } {
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
      return { subject: title ?? slug, note: at ? `Goes live ${formatIstDateTime(at)} IST` : null };
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
    default:
      return { subject: null, note: null };
  }
}

/**
 * Log rows as the console's `ActivityFeed` draws them (the dashboard, My account): "Published a page
 * — About us", the note under it, who, and when. `hideActor` for a feed that is all one person's.
 */
export function activityFeedItems(rows: CmsAuditRow[], opts: { canOpenUsers: boolean; canOpenSecurity: boolean; hideActor?: boolean }): ActivityFeedItem[] {
  return rows.map((row) => {
    const { label, tone } = actionLabel(row.action);
    const { subject, note } = describeActivity(row);
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
