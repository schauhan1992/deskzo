import type { CmsRole, SiteLeadStatus, SitePageStatus, SitePostStatus } from "@wroffy/control-client";
import type { BlockType, SiteBlock, SiteSeo, SiteSettings } from "@/components/site/blocks/types";

/**
 * The website CMS's shared vocabulary — roles and what each may do, the shapes its loaders and
 * actions hand out, and the one result type every action answers with.
 *
 * Client-safe: plain data and types only (the control client is imported for its types alone), so
 * the CMS's client components import from here freely. The server side is src/lib/cms/*.ts.
 */

export type { CmsRole, SiteLeadStatus, SitePageStatus, SitePostStatus };

// ─── Roles ───────────────────────────────────────────────────────────────────────────────────────

export const CMS_ROLES = ["ADMIN", "EDITOR", "AUTHOR", "VIEWER"] as const satisfies readonly CmsRole[];

/** Everybody signed in to the CMS. */
export const CMS_EVERYONE: readonly CmsRole[] = CMS_ROLES;
/** Drafts pages and posts, uploads media, restores a version into a draft. */
export const CMS_WRITERS: readonly CmsRole[] = ["ADMIN", "EDITOR", "AUTHOR"];
/** Publishes and unpublishes, archives and deletes, edits site settings and navigation, works the leads. */
export const CMS_PUBLISHERS: readonly CmsRole[] = ["ADMIN", "EDITOR"];
/** CMS accounts and the CMS's own security (two-factor policy). */
export const CMS_ADMINS: readonly CmsRole[] = ["ADMIN"];

export const CMS_ROLE_LABELS: Record<CmsRole, string> = { ADMIN: "Admin", EDITOR: "Editor", AUTHOR: "Author", VIEWER: "Viewer" };

/** One line each, for the role picker. */
export const CMS_ROLE_DESCRIPTIONS: Record<CmsRole, string> = {
  ADMIN: "Everything an editor does, plus CMS accounts and security settings.",
  EDITOR: "Edits and publishes pages, posts, media, navigation and site settings; works the leads inbox.",
  AUTHOR: "Drafts pages and posts and uploads images. Publishes nothing; changes nobody else's posts.",
  VIEWER: "Reads everything, leads included, and changes nothing.",
};

/**
 * What a role may do, as plain booleans a server page hands to a client component. For showing and
 * hiding only — every action checks the role again itself.
 */
export type CmsCaps = {
  role: CmsRole;
  /** Create pages and posts, save drafts, upload media, restore versions into a draft. */
  write: boolean;
  /** Publish, unpublish, schedule, archive and delete; site settings and navigation. */
  publish: boolean;
  /** Change a lead's status or notes, export leads. Everybody may read them. */
  workLeads: boolean;
  /** CMS accounts, the two-factor policy. */
  admin: boolean;
};

export function cmsCapsFor(role: CmsRole): CmsCaps {
  return {
    role,
    write: CMS_WRITERS.includes(role),
    publish: CMS_PUBLISHERS.includes(role),
    workLeads: CMS_PUBLISHERS.includes(role),
    admin: CMS_ADMINS.includes(role),
  };
}

// ─── Results ─────────────────────────────────────────────────────────────────────────────────────

/** A problem with one field of a document: `path` like "blocks[2].props.items[0].title". */
export type CmsIssue = { path: string; message: string; blockId?: string };

/** Somebody else saved since this copy was loaded. */
export type CmsConflict = { version: string; updatedBy: string };

/** What every CMS action answers. Never a secret: no hash, token, secret or document of another kind. */
export type CmsResult<T> = { ok: true; data: T } | { ok: false; error: string; issues?: CmsIssue[]; conflict?: CmsConflict };

/** A refusal the person can act on — turned into `{ ok: false, error }` by the actions. */
export class CmsRefused extends Error {
  issues?: CmsIssue[];
  conflict?: CmsConflict;
  constructor(message: string, extra?: { issues?: CmsIssue[]; conflict?: CmsConflict }) {
    super(message);
    this.name = "CmsRefused";
    this.issues = extra?.issues;
    this.conflict = extra?.conflict;
  }
}

// ─── People ──────────────────────────────────────────────────────────────────────────────────────

/** The signed-in CMS user. */
export type CmsMe = { id: string; email: string; name: string; role: CmsRole };

export type CmsUserRow = {
  id: string;
  email: string;
  name: string;
  role: CmsRole;
  active: boolean;
  /** An authenticator is set up. */
  twoFactor: boolean;
  /** Has chosen a password (a setup link has been used at least once). */
  hasPassword: boolean;
  /** A setup link is out and has not expired. */
  setupPending: boolean;
  lastSignInAt: Date | null;
  createdAt: Date;
  /** Who made the account, as a name ("Asha Rao", "Platform staff: Ravi", "Script"). */
  createdBy: string;
  /** Sessions that still let them in. */
  liveSessions: number;
};

/**
 * A CMS session as the CMS lists it. `handle` names it for "End this session" and is neither the
 * cookie's token nor the stored hash of it.
 */
export type CmsSessionRow = { handle: string; createdAt: Date; lastSeenAt: Date; expiresAt: Date; mfa: boolean; ip: string | null; device: string; current: boolean };

export type CmsTwoFactorMode = "optional" | "required";

// ─── Pages ───────────────────────────────────────────────────────────────────────────────────────

/** A page's content — what `site_pages.draft` and `.published` hold. */
export type PageDocument = { title: string; seo: SiteSeo; blocks: SiteBlock[] };

/** The site's own pages: always there, editable, never unpublished or deleted (they fall back to src/components/site/defaults.ts). */
export const BUILTIN_PAGE_SLUGS = ["home", "pricing", "security", "contact", "signin", "signup", "terms", "privacy"] as const;
export type BuiltinPageSlug = (typeof BUILTIN_PAGE_SLUGS)[number];

/** The block each form page must keep, or the page stops working. */
export const REQUIRED_BLOCKS: Partial<Record<BuiltinPageSlug, BlockType>> = {
  pricing: "pricingTable",
  contact: "contactForm",
  signin: "workspaceSignin",
  signup: "signupForm",
};

/**
 * First segments no new page may take: the site's own routes (blog, media, preview, and partners —
 * the partner programme's "Become a partner" and "Find a partner", src/app/platform-site/partners),
 * the platform's folders, and addresses that are files. A built-in page's own slug is not free either.
 */
export const RESERVED_PAGE_SEGMENTS = ["blog", "media", "preview", "partners", "api", "sitemap", "robots", "favicon", "platform-site", "platform-console", "platform-cms", "_next"] as const;

/**
 * "DEFAULT": a built-in page nobody has saved — the site shows its default content. `id` is then
 * "builtin-<slug>", which every page function accepts until the first save gives it a real id.
 */
export type PageStatus = "DEFAULT" | SitePageStatus;

export type PageListRow = {
  id: string;
  slug: string;
  /** Its address on the site: "/" for home. */
  path: string;
  title: string;
  status: PageStatus;
  builtin: boolean;
  /** Published, and the draft differs from what is published. */
  changed: boolean;
  archived: boolean;
  updatedAt: Date | null;
  updatedBy: string | null;
  publishedAt: Date | null;
};

export type PageDetail = {
  id: string;
  /** False for a built-in page never saved: `draft` is its default content. */
  saved: boolean;
  slug: string;
  path: string;
  builtin: boolean;
  status: PageStatus;
  draft: PageDocument;
  published: PageDocument | null;
  changed: boolean;
  archived: boolean;
  /** Pass back as `version` when saving: the save is refused if somebody else saved in between. "" before the first save. */
  version: string;
  updatedAt: Date | null;
  updatedBy: string | null;
  publishedAt: Date | null;
  publishedBy: string | null;
  createdAt: Date | null;
  createdBy: string | null;
  /** A block type this page must keep (the form it exists for), when it has one. */
  requiredBlock: BlockType | null;
};

export type PageVersionRow = { id: string; note: string | null; createdAt: Date; createdBy: string; title: string; blocks: number };

/** What a page save, publish or restore answers: enough to carry on editing (a built-in page's first save gives it its real `id`). */
export type PageSaved = { id: string; slug: string; version: string; status: PageStatus; changed: boolean; updatedAt: Date; publishedAt: Date | null };

// ─── Site settings ───────────────────────────────────────────────────────────────────────────────

export type SettingsDetail = {
  /** What editors change: the stored draft over the defaults (the defaults until first saved). */
  draft: SiteSettings;
  /** What the site shows now, when anything was ever published (else the defaults are live). */
  published: SiteSettings | null;
  saved: boolean;
  /** The draft differs from what the site shows. */
  changed: boolean;
  version: string;
  updatedAt: Date | null;
  updatedBy: string | null;
  publishedAt: Date | null;
};

// ─── Dashboard ───────────────────────────────────────────────────────────────────────────────────

export type CmsDashboard = {
  pages: { published: number; drafts: number; changed: number; builtinsDefault: number };
  posts: { published: number; scheduled: number; drafts: number };
  leads: { newTotal: number; newThisWeek: number };
  media: { total: number; needsAlt: number };
  /** The signed-in user's own drafts, most recently changed first (at most 8). */
  myDrafts: { kind: "page" | "post"; id: string; title: string; href: string; updatedAt: Date }[];
  recent: CmsAuditRow[];
  /** For "getting started" hints. */
  setup: { taglinePlaceholder: boolean; homePublished: boolean; settingsPublished: boolean };
};

// ─── Posts ───────────────────────────────────────────────────────────────────────────────────────

/** A post's search and sharing details. Each falls back: title → the post's title, description → the excerpt, image → the cover. */
export type PostSeo = { title?: string; description?: string; ogImage?: string; noindex?: boolean };

/** The blocks a post's body may use: no second h1 (hero, pageHeader) and no forms or live pricing. */
export const POST_BLOCK_TYPES = [
  "richText",
  "imageText",
  "featureGrid",
  "moduleGrid",
  "stats",
  "faq",
  "cta",
  "securityHighlights",
  "logoCloud",
  "testimonial",
  "productPreviews",
] as const satisfies readonly BlockType[];

export type PostListRow = {
  id: string;
  slug: string;
  path: string;
  title: string;
  status: SitePostStatus;
  /** On the public site now (published, or scheduled and its time has come). */
  live: boolean;
  publishAt: Date | null;
  publishedAt: Date | null;
  tags: string[];
  coverMediaId: string | null;
  author: { id: string; name: string };
  archived: boolean;
  updatedAt: Date;
  updatedBy: string;
};

export type PostDetail = PostListRow & {
  excerpt: string | null;
  body: SiteBlock[];
  seo: PostSeo | null;
  version: string;
  createdAt: Date;
};

export type PostSaved = { id: string; slug: string; version: string; status: SitePostStatus; live: boolean; publishAt: Date | null; updatedAt: Date };

/** What a post's editor saves. Every field is sent every time. */
export type PostInput = {
  title: string;
  slug: string;
  excerpt: string | null;
  coverMediaId: string | null;
  tags: string[];
  body: SiteBlock[];
  seo: PostSeo | null;
};

// ─── Media ───────────────────────────────────────────────────────────────────────────────────────

export const MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;

export type MediaRow = {
  id: string;
  /** Site-relative: "/media/<id>". It also answers on the CMS host, for previews. */
  url: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  alt: string;
  /** No alt text yet: it cannot be published on a page until it has some. */
  needsAlt: boolean;
  createdAt: Date;
  createdBy: string;
};

export type MediaUsage = { kind: "page" | "post" | "settings"; id: string; title: string; href: string; where: "published" | "draft" };

// ─── Leads ───────────────────────────────────────────────────────────────────────────────────────

export const LEAD_STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "CLOSED", "SPAM"] as const satisfies readonly SiteLeadStatus[];
export const LEAD_STATUS_LABELS: Record<SiteLeadStatus, string> = { NEW: "New", CONTACTED: "Contacted", QUALIFIED: "Qualified", CLOSED: "Closed", SPAM: "Spam" };
export const LEAD_TOPICS = ["demo", "sales", "support", "other"] as const;
export const LEAD_TOPIC_LABELS: Record<(typeof LEAD_TOPICS)[number], string> = { demo: "Demo", sales: "Sales", support: "Support", other: "Other" };

export type LeadRow = {
  id: string;
  name: string;
  email: string;
  company: string | null;
  phone: string | null;
  topic: string;
  status: SiteLeadStatus;
  createdAt: Date;
  updatedAt: Date;
  /** Who last changed it, as a name. */
  handledBy: string | null;
  hasNotes: boolean;
};

export type LeadDetail = LeadRow & { message: string; notes: string | null; ip: string | null };

export type LeadFilters = { status?: SiteLeadStatus; topic?: string; from?: string; to?: string; q?: string; page?: number };

// ─── Activity ────────────────────────────────────────────────────────────────────────────────────

export type CmsAuditRow = { id: string; at: Date; actorId: string | null; actorLabel: string; action: string; entity: string; entityId: string | null; detail: Record<string, unknown> | null };

/** Every action the CMS writes to its activity log, for the activity page's labels and filter. */
export const CMS_AUDIT_ACTIONS = [
  "auth.sign-in",
  "auth.sign-out",
  "auth.password.set",
  "auth.two-factor.enrolled",
  "auth.two-factor.removed",
  "account.password-link",
  "account.rename",
  "account.session.end",
  "account.sessions.end-others",
  "user.create",
  "user.role",
  "user.deactivate",
  "user.reactivate",
  "user.setup-link",
  "user.two-factor.reset",
  "user.sessions.end",
  "security.two-factor-policy",
  "page.create",
  "page.save",
  "page.publish",
  "page.unpublish",
  "page.version.save",
  "page.version.restore",
  "page.slug",
  "page.archive",
  "page.unarchive",
  "page.delete",
  "post.create",
  "post.save",
  "post.publish",
  "post.schedule",
  "post.unpublish",
  "post.archive",
  "post.unarchive",
  "post.delete",
  "settings.save",
  "settings.publish",
  "media.upload",
  "media.alt",
  "media.delete",
  "lead.create",
  "lead.update",
  "lead.export",
  "preview.link",
] as const;
export type CmsAuditAction = (typeof CMS_AUDIT_ACTIONS)[number];

export type CmsAuditFilters = { actorId?: string; action?: string; entity?: string; from?: string; to?: string; page?: number };

/** One page of a list: `total` across every page. */
export type Paged<T> = { rows: T[]; total: number; page: number; pageSize: number };
