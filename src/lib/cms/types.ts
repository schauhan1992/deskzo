import type { CmsRole, SeoEntityType, SiteLeadStatus, SitePageStatus, SitePostStatus, SiteRedirectMatch } from "@deskzo/control-client";
import type { BlockType, SiteBlock, SiteSeo, SiteSettings } from "@/components/site/blocks/types";
import type { CheckResult, EntityScore, SeoImage, SeoLabel, SeoSiteContext } from "@/lib/seo/types";

/**
 * The website CMS's shared vocabulary — roles and what each may do, the shapes its loaders and
 * actions hand out, and the one result type every action answers with.
 *
 * Client-safe: plain data and types only (the control client is imported for its types alone), so
 * the CMS's client components import from here freely. The server side is src/lib/cms/*.ts.
 */

export type { CmsRole, SeoEntityType, SiteLeadStatus, SitePageStatus, SitePostStatus, SiteRedirectMatch };

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

/**
 * The signed-in CMS user.
 *
 * `script`: a script run on the server acting through the CMS's own functions (the website seed,
 * scripts/site-seed-pages.ts). It acts with `role`; what it changes is recorded as "script" (its
 * `updatedBy` and the activity log), and a post it creates is by `id`, a real CMS account. Never set
 * from a session.
 */
export type CmsMe = { id: string; email: string; name: string; role: CmsRole; script?: true };

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

/**
 * What a page save, publish or restore answers: enough to carry on editing (a built-in page's first save gives it its real `id`).
 * `redirect`: the 301 made automatically when a published page's address changed (cmsChangePageSlug), for the editor's notice.
 */
export type PageSaved = { id: string; slug: string; version: string; status: PageStatus; changed: boolean; updatedAt: Date; publishedAt: Date | null; redirect?: AutoRedirect | null };

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

// ─── Search & AI ─────────────────────────────────────────────────────────────────────────────────
// What crawlers may do on the public site (Settings › Search & AI, admins only; src/lib/cms/search-policy.ts).
// Not a draft: a change is live as soon as it is saved.

export type SearchPolicy = {
  /** The whole public site kept out of search engines: every page noindex, no sitemap, no llms.txt, no AI crawler. */
  hideSite: boolean;
  /** AI search crawlers (ChatGPT search, Claude, Perplexity…) may read the site — S-D2's default. */
  aiSearch: boolean;
  /** AI training crawlers (GPTBot, ClaudeBot, CCBot, Google-Extended…) may read the site. */
  aiTraining: boolean;
  /** /llms.txt is served. */
  llmsTxt: boolean;
  /** llms.txt's opening line; empty, the site's search description. */
  llmsSummary: string;
};

export const DEFAULT_SEARCH_POLICY: SearchPolicy = { hideSite: false, aiSearch: true, aiTraining: false, llmsTxt: true, llmsSummary: "" };
export const LLMS_SUMMARY_MAX = 500;

/** The policy as it applies: `hidden` is `hideSite`, or forced by a staging installation (PLATFORM_ENV=staging), which is never indexed. */
export type EffectiveSearchPolicy = SearchPolicy & { hidden: boolean; forcedHidden: boolean };

/** The Search & AI page's data: the policy, who changed it last, and where the site's own files are. */
export type SearchPolicyDetail = { policy: SearchPolicy; effective: EffectiveSearchPolicy; updatedAt: Date | null; updatedBy: string | null; siteOrigin: string };

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

/**
 * A post's search and sharing details. Each falls back: title → the post's title, description → the excerpt, image → the cover.
 * `keywords`: its primary keywords, keyword 1 first (at most three, no repeats); absent when none.
 */
export type PostSeo = { title?: string; description?: string; ogImage?: string; noindex?: boolean; noLlms?: boolean; keywords?: string[] };

/**
 * The blocks a post's body may use: no second h1 (hero, pageHeader) and no forms or live pricing.
 * Related links, yes — a guide's "read next" is internal linking; the comparison table and a hub's
 * module highlights are for pages.
 */
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
  "relatedLinks",
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
  /** Its tags' slugs, by name. The same tags with their names: `tagRefs`. */
  tags: string[];
  tagRefs: CmsTermRef[];
  /** Its categories, the main one (breadcrumbs) first. */
  categories: CmsTermRef[];
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
  /** Live now, or published or scheduled at some point: deleting it offers a redirect (default /blog). */
  wasPublished: boolean;
};

/** `redirect`: the 301 made automatically when a live post's address changed, for the editor's notice. */
export type PostSaved = { id: string; slug: string; version: string; status: SitePostStatus; live: boolean; publishAt: Date | null; updatedAt: Date; redirect?: AutoRedirect | null };

/** What a post's editor saves. Every field is sent every time. */
export type PostInput = {
  title: string;
  slug: string;
  excerpt: string | null;
  coverMediaId: string | null;
  /**
   * At most ten. Each is a tag's slug, or a name: an existing tag is matched by slug, then by name
   * (any case), then by the name's slug; anything else becomes a new tag (writers may create them;
   * a new tag's name is at most 40 characters). Stored as SiteTag records — never as free text.
   */
  tags: string[];
  /** Category ids, the main one first (at most ten). Left out: the post's categories stay as they are. */
  categories?: string[];
  body: SiteBlock[];
  seo: PostSeo | null;
};

// ─── Categories and tags ─────────────────────────────────────────────────────────────────────────

/** A category or tag as a post and a list refer to it. */
export type CmsTermRef = { id: string; slug: string; name: string };

/**
 * A category's or tag's own search and sharing details. Each falls back: title → the name, description → the description.
 * `keywords`: its archive's primary keywords, keyword 1 first (at most three, no repeats); absent when none.
 */
export type TermSeo = { title?: string; description?: string; imageMediaId?: string; keywords?: string[]; noindex?: boolean };

/** Category and tag slugs: lower-case words and hyphens, at most 60 (the database's CHECKs). */
export const TERM_SLUG_MAX = 60;
export const CATEGORY_NAME_MAX = 60;
export const TAG_NAME_MAX = 40;
export const TERM_DESCRIPTION_MAX = 500;

export type CategoryRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  parentId: string | null;
  position: number;
  seo: TermSeo | null;
  /** "/blog/category/<slug>". */
  path: string;
  /** Posts in it, not archived — its own only. */
  posts: number;
  /** Of those, on the site now. */
  livePosts: number;
  updatedAt: Date;
  /** A name ("Asha Rao", "Script"). */
  updatedBy: string;
};

/** A top-level category and its children (one level: children have none). */
export type CategoryNode = CategoryRow & { children: CategoryRow[] };

export type CategoryInput = {
  name: string;
  /** Blank: made from the name. */
  slug?: string;
  description?: string | null;
  /** A top-level category's id, or null for a top-level one. */
  parentId?: string | null;
  seo?: TermSeo | null;
};

export type TagRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  seo: TermSeo | null;
  /** "/blog/tag/<slug>". */
  path: string;
  posts: number;
  livePosts: number;
  updatedAt: Date;
  updatedBy: string;
};

export type TagInput = { name: string; slug?: string; description?: string | null; seo?: TermSeo | null };

// ─── Redirects ───────────────────────────────────────────────────────────────────────────────────

export const REDIRECT_STATUSES = [301, 302, 307, 308] as const;
export type RedirectStatus = (typeof REDIRECT_STATUSES)[number];
/** Saving the 5,001st is refused. */
export const MAX_REDIRECTS = 5_000;
/** A visitor passes through at most this many redirects in a row; a longer chain is refused on save. */
export const MAX_REDIRECT_HOPS = 3;
export const REDIRECT_IMPORT_MAX_ROWS = 1_000;

/**
 * The public site's own routes: never redirected, and a redirect from one (or from anything under it)
 * is refused — "That page is part of the site and can't be redirected". The home page is too.
 */
export const SITE_BUILTIN_ROUTES = ["/signup", "/signin", "/contact", "/pricing", "/security", "/privacy", "/terms", "/partners"] as const;

/** What a redirect's form sends. `match` left out: PREFIX when `from` ends in "/*", else EXACT. */
export type RedirectInput = { from: string; to: string; status?: number; match?: SiteRedirectMatch; enabled?: boolean; note?: string | null };

/** Where a redirect leads a visitor, following the redirects after it. Only for 2 hops or more. */
export type RedirectChain = { hops: number; final: string; loop: boolean; through: string[] };

/** A page, post or archive on the site now, at an address a redirect takes over (src/lib/cms/redirect-covers.ts). */
export type LiveAddress = { path: string; kind: "page" | "post" | "blog" | "category" | "tag"; title: string };

/** The live addresses a redirect sends visitors away from: how many, and the first few. */
export type RedirectCovers = { total: number; examples: LiveAddress[] };

export type RedirectRow = {
  id: string;
  /** Normalised: lower-case, no query, no trailing slash; a PREFIX one ends in "/*". */
  fromPath: string;
  /** A site path ("/pricing", "/new/*") or an https:// address. */
  toUrl: string;
  status: RedirectStatus;
  match: SiteRedirectMatch;
  enabled: boolean;
  /** Made by a slug change or a tag merge ("created automatically"). */
  automatic: boolean;
  note: string | null;
  hits: number;
  lastHitAt: Date | null;
  /** Its target is another site: only admins create or change these. */
  external: boolean;
  /** Set when a visitor goes through 2–3 redirects in a row from here: "Point it straight at `final`". */
  chain: RedirectChain | null;
  /** How many live pages, posts and archives it hides now — on the list only (src/lib/cms/redirect-covers.ts). */
  hides?: number;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string;
};

export type RedirectFilters = { q?: string; match?: SiteRedirectMatch; enabled?: boolean; automatic?: boolean; external?: boolean; chained?: boolean; sort?: "recent" | "from" | "hits"; page?: number };

/** A redirect as it would be saved, and what is wrong with it — the dialog's live checks. */
export type RedirectCheck = {
  ok: boolean;
  issues: CmsIssue[];
  /** Normalised, once `from` and `to` are readable. */
  normalised: { fromPath: string; toUrl: string; match: SiteRedirectMatch; status: RedirectStatus; external: boolean } | null;
  /** Another redirect already from the same address (a save then updates nothing: it is refused). */
  existingId: string | null;
  chain: RedirectChain | null;
  /** The live pages it would hide once saved and switched on; null when none (src/lib/cms/redirect-covers.ts). */
  covers?: RedirectCovers | null;
};

/** One row of an import file, and what importing it would do. */
export type RedirectImportRow = {
  /** The file's line number (the header is line 1). */
  line: number;
  from: string;
  to: string;
  status: number | null;
  match: SiteRedirectMatch | null;
  note: string | null;
  outcome: "create" | "update" | "unchanged" | "refuse";
  reason: string | null;
  /** The redirect it updates (or leaves unchanged). */
  id: string | null;
  /** For a row to create or update: how many live pages it would hide (src/lib/cms/redirect-covers.ts). */
  hides?: number;
};

export type RedirectImportResult = {
  rows: RedirectImportRow[];
  counts: { create: number; update: number; unchanged: number; refuse: number };
  /** False for a preview; true once imported (refused rows are skipped, the rest applied). */
  applied: boolean;
};

/** A 301 made automatically (a slug change, a tag merge). `created` false: an existing one was updated. */
export type AutoRedirect = { id: string; from: string; to: string; created: boolean };

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

export type MediaUsage = { kind: "page" | "post" | "settings" | "category" | "tag"; id: string; title: string; href: string; where: "published" | "draft" };

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
  "settings.search",
  "media.upload",
  "media.alt",
  "media.delete",
  "lead.create",
  "lead.update",
  "lead.export",
  "preview.link",
  "category.create",
  "category.update",
  "category.delete",
  "tag.create",
  "tag.update",
  "tag.merge",
  "tag.delete",
  "redirect.create",
  "redirect.update",
  "redirect.delete",
  "redirect.import",
] as const;
export type CmsAuditAction = (typeof CMS_AUDIT_ACTIONS)[number];

export type CmsAuditFilters = { actorId?: string; action?: string; entity?: string; from?: string; to?: string; page?: number };

/** One page of a list: `total` across every page. */
export type Paged<T> = { rows: T[]; total: number; page: number; pageSize: number };

// ─── SEO Intelligence ────────────────────────────────────────────────────────────────────────────
// The score cache the dashboard reads (src/lib/cms/seo-scores.ts; control `seo_scores`). The scores
// are internal indicators, not Google's or any AI platform's.

/** What is scored (SeoEntityType): a page (keyed by its slug), a post, a category, a tag (by id), the blog's index (key "blog"). */
export const SEO_ENTITY_TYPES = ["PAGE", "POST", "CATEGORY", "TAG", "BLOG_INDEX"] as const satisfies readonly SeoEntityType[];
/** The blog index's key. */
export const SEO_BLOG_INDEX_KEY = "blog";

/** Which version was scored: the published one, a draft (an added page never published, a post not yet live), a built-in page's default content, a scheduled post. */
export type SeoScoreStatus = "published" | "draft" | "default" | "scheduled";
export const SEO_SCORE_STATUSES = ["published", "draft", "default", "scheduled"] as const satisfies readonly SeoScoreStatus[];

export const SEO_SORTS = ["lowest", "highest", "issues", "recent"] as const;
export type SeoSort = (typeof SEO_SORTS)[number];
export const SEO_PAGE_SIZE = 25;
export const SEO_PAGE_SIZE_MAX = 100;
/** A "Recalculate all" batch: 25 by default, at most 50. */
export const SEO_BATCH_SIZE = 25;
export const SEO_BATCH_SIZE_MAX = 50;

/** One entity's cached score, as the dashboard's table lists it. */
export type SeoScoreRow = {
  type: SeoEntityType;
  key: string;
  /** Its address on the site. */
  path: string;
  /** Its name in the CMS: a page's or post's title, a term's name, "Blog". */
  title: string;
  status: SeoScoreStatus;
  /** On the site now. */
  live: boolean;
  /** Deliberately kept out of search (noindex): shown as excluded, never penalised. */
  excluded: boolean;
  /** Live and not excluded: in the site's score. */
  indexable: boolean;
  seo: number;
  aeo: number;
  geo: number;
  overall: number;
  /** `overall`'s band: always shown with the number. */
  label: SeoLabel;
  critical: number;
  warnings: number;
  missingMetadata: boolean;
  missingSchema: boolean;
  missingKeywords: boolean;
  /** Its robots settings disagree with robots.txt, the canonical or a redirect (seo.robots-conflict warned or failed). */
  indexingConflict: boolean;
  /** Its primary keywords when it was scored. */
  keywords: string[];
  /** The content changed, the settings were published, or the engine changed since: the numbers may be out of date. */
  stale: boolean;
  calculatedAt: Date;
  contentUpdatedAt: Date | null;
  engineVersion: number;
  /** Where the CMS edits it (CMS_ROUTES); null for the blog index, which has no editor. */
  editHref: string | null;
};

export type SeoListFilters = {
  type?: SeoEntityType;
  status?: SeoScoreStatus;
  indexable?: boolean;
  /** 0–100, inclusive, on the overall score. */
  scoreMin?: number;
  scoreMax?: number;
  missingMetadata?: boolean;
  missingSchema?: boolean;
  missingKeywords?: boolean;
  /** true: only those with a critical issue; false: only those without. */
  critical?: boolean;
  /** true: only those deliberately kept out of search (noindex); false: only the others. */
  excluded?: boolean;
  /** true: only those with an indexing conflict; false: only those without. */
  conflict?: boolean;
  /** In the title or the address. */
  q?: string;
  sort?: SeoSort;
  page?: number;
  pageSize?: number;
};

/** The dashboard's cards: the weighted site score (noindex and not-live entities left out) and the counts, from the cache. */
export type SeoSiteSummary = {
  overall: number;
  seo: number;
  aeo: number;
  geo: number;
  label: SeoLabel;
  /** Live, indexable entities in the score. */
  scored: number;
  counts: {
    /** Critical issues across the scored entities. */
    critical: number;
    /** Warnings across the scored entities. */
    warnings: number;
    /** Scored pages (the home page included) under 60. */
    pagesNeedingAttention: number;
    /** Scored posts under 60. */
    postsNeedingAttention: number;
    /** Scored category and tag archives, and the blog index, under 60. */
    archivesNeedingAttention: number;
    missingMetadata: number;
    missingStructuredData: number;
    /** Scored entities without primary keywords (the blog index, which can't have any, left out). */
    noPrimaryKeywords: number;
    indexingConflicts: number;
    /** Live, deliberately kept out of search. */
    excluded: number;
    /** Drafts, posts scheduled for later, archives with nothing live. */
    notLive: number;
  };
  /** Scored entities by band. */
  distribution: Record<SeoLabel, number>;
  /** Live, indexable addresses: what the site offers search engines. */
  indexableUrls: number;
  /** Everything on the site that can be scored, and of those: with a cached score, out of date, never calculated. */
  entities: number;
  calculated: number;
  stale: number;
  uncalculated: number;
  lastCalculatedAt: Date | null;
  /** Site-wide checks (AI crawlers, Organization, default sharing image, title template), reported beside the score. */
  siteChecks: CheckResult[];
  engineVersion: number;
};

/** One entity's whole calculation: every check, with what to do about it. */
export type SeoScoreDetail = {
  row: SeoScoreRow;
  score: EntityScore;
  /** Calculated just now (it was stale or missing) rather than read from the cache. */
  fresh: boolean;
  /** The JSON-LD @types the site emits for it, and those its kind should carry (src/lib/seo EXPECTED_LD). */
  jsonLd: { emitted: string[]; expected: string[] };
};

/** What "Recalculate all" gets back from each batch. Loop, passing `cursor` back, until `done`. */
export type SeoBatchResult = { done: boolean; cursor: string | null; processed: number; failed: number; remaining: number };

/** What an editor scores with, live in the browser: the site around the entity, loaded once when the editor opens. */
export type SeoEditorContext = {
  /** The published settings and the rest (src/lib/seo `SeoSiteContext`); `others` holds every live entity but this one. */
  site: SeoSiteContext;
  aiSearchCrawlersAllowed: boolean;
  /** Library images this entity refers to (its documents, a cover, a sharing image, its archive's cards), by id. */
  media: Record<string, { alt: string; width: number | null; height: number | null }>;
  /** For a category or tag: its archive's first page as the site shows it now; null otherwise. */
  archive: { posts: { title: string; path: string; excerpt: string | null; cover: SeoImage | null }[]; total: number; pages: number; parent: { name: string; path: string } | null } | null;
  engineVersion: number;
  /** Its cached row (the dashboard's number for what the site shows now), flagged stale when out of date; null when never calculated. */
  cached: SeoScoreRow | null;
};
