/**
 * The public website's content model: site-wide settings, pages, and the typed blocks a page is made
 * of. The platform console's CMS edits exactly these shapes; src/components/site/blocks renders them;
 * src/lib/platform/site-content.ts hands them out (today the defaults in ../defaults.ts).
 *
 * ## Written to be edited by somebody other than a developer
 *
 *   · Every prop is plain data — strings, numbers, booleans, arrays of those. There is no HTML
 *     anywhere: rich text is structured (`RichNode`), and React escapes every string it renders.
 *   · Links are checked when rendered, not trusted when saved: only a path on this site
 *     ("/pricing", "/#modules", "/contact?topic=demo") or an http(s) address becomes a link
 *     (`safeHref` in ../links.ts); anything else is shown as plain text. Images the same (`safeSrc`).
 *   · Icons and product previews are names from a fixed list, never components or markup.
 *   · Text may carry tokens, replaced when shown: {siteName} {tagline} {displayDomain} {salesEmail}
 *     {trialDays}. Unknown tokens are left as they are.
 *   · Blocks never carry a workspace's data. The two that show live data — `pricingTable` (plans on
 *     sale, from the control plane) and the forms — fetch or post it themselves.
 */

// ─── Links, actions, media ───────────────────────────────────────────────────────────────────────

/** A path on this site, or an http(s) address. Anything else is not rendered as a link. */
export type Href = string;

export type SiteLink = { label: string; href: Href };

/**
 * A button. `signup` is the site's own call to action, which follows whether signing up is open
 * (SiteSettings.signupCta): "Start free trial" while it is, "Request an invitation" while it is not.
 */
export type SiteAction = { kind: "link"; label: string; href: Href } | { kind: "signup" };

export const ICON_NAMES = [
  "sparkles",
  "chart",
  "receipt",
  "package",
  "book",
  "users",
  "headset",
  "megaphone",
  "layers",
  "database",
  "key",
  "fingerprint",
  "shield",
  "scroll",
  "door",
  "lock",
  "server",
  "history",
  "globe",
  "rupee",
  "card",
  "truck",
  "map-pin",
  "file-text",
  "calendar",
  "mail",
  "check",
  "bot",
  "building",
  "gauge",
] as const;
export type IconName = (typeof ICON_NAMES)[number];

/** The stylised product screens drawn in HTML and CSS (src/components/site/previews.tsx). */
export const PREVIEW_KINDS = ["pipeline", "invoice", "attendance"] as const;
export type PreviewKind = (typeof PREVIEW_KINDS)[number];

export type SiteMedia = { kind: "preview"; preview: PreviewKind } | { kind: "image"; src: Href; alt: string };

// ─── Rich text ───────────────────────────────────────────────────────────────────────────────────

/** A run of text, optionally bold, italic or a link. */
export type RichSpan = { text: string; strong?: boolean; em?: boolean; href?: Href };
/** Plain text, or runs of it. */
export type RichInline = string | RichSpan[];

export type RichNode =
  | { type: "heading"; level: 2 | 3; text: string; anchor?: string }
  | { type: "paragraph"; text: RichInline }
  | { type: "list"; ordered?: boolean; items: RichInline[] }
  | { type: "table"; columns: string[]; rows: RichInline[][] }
  | { type: "note"; tone: "info" | "warning"; text: RichInline };

// ─── Blocks ──────────────────────────────────────────────────────────────────────────────────────

/** Shared by most blocks: an id to link to (`/#modules`), a small line above the heading, the heading and an introduction. */
type SectionHead = { anchor?: string; eyebrow?: string; heading: string; intro?: string };

/** The top of the home page: the page's one h1. */
export type HeroProps = {
  eyebrow?: string;
  heading: string;
  subheading?: string;
  primary?: SiteAction;
  secondary?: SiteAction;
  /** Under the buttons while signing up is open ("Free for {trialDays} days…"). */
  note?: string;
  /** Under the buttons while signing up is by invitation. */
  noteInviteOnly?: string;
  media?: SiteMedia;
};

/** The top of an inner page: its h1, an introduction, and an optional notice (a draft, a caveat). */
export type PageHeaderProps = {
  eyebrow?: string;
  heading: string;
  intro?: string;
  notice?: { tone: "info" | "warning"; text: string };
};

export type FeatureGridProps = SectionHead & {
  columns?: 2 | 3 | 4;
  items: { icon?: IconName; title: string; body: string; bullets?: string[]; link?: SiteLink }[];
};

/**
 * The product's modules, grouped. `key` names a module in src/lib/modules.ts, which is where "sold in
 * India only" comes from; an item without a key (or with an unknown one) is shown as written.
 */
export type ModuleGridProps = SectionHead & {
  groups: { icon: IconName; title: string; summary?: string; modules: { key?: string; label: string; blurb: string }[] }[];
  footnote?: string;
};

export type RichTextProps = { anchor?: string; heading?: string; content: RichNode[] };

export type ImageTextProps = SectionHead & {
  body?: string[];
  bullets?: string[];
  action?: SiteAction;
  media: SiteMedia;
  mediaSide?: "left" | "right";
};

export type StatsProps = { anchor?: string; heading?: string; items: { value: string; label: string }[] };

export type FaqProps = SectionHead & { items: { question: string; answer: string[] }[] };

export type CtaProps = {
  anchor?: string;
  heading: string;
  body?: string;
  primary?: SiteAction;
  secondary?: SiteAction;
  /** A full-width band in the brand colour, or a quieter panel. */
  variant?: "band" | "panel";
};

/** Plans on sale, read live from the control plane for the country in the address (`?country=`). */
export type PricingTableProps = {
  anchor?: string;
  /** Beside the country picker. */
  countryLabel: string;
  editionsHeading: string;
  extrasHeading: string;
  extrasIntro?: string;
  /** Under the plans, e.g. "Every plan starts with a {trialDays}-day free trial." */
  trialNote?: string;
  /** Under the plans: what every plan includes. */
  footnote?: string;
  emptyHeading: string;
  emptyBody: string;
  emptyAction?: SiteAction;
};

export type SecurityHighlightsProps = SectionHead & {
  items: { icon: IconName; title: string; body: string }[];
  link?: SiteLink;
};

export type ContactTopicLabels = { demo: string; sales: string; support: string; other: string };

export type ContactFormProps = {
  anchor?: string;
  heading: string;
  intro?: string;
  topics: ContactTopicLabels;
  submitLabel: string;
  successHeading: string;
  successBody: string;
  asideHeading?: string;
  aside?: { title: string; body: string; link?: SiteLink }[];
};

/** Customers' logos. Empty by default: the site shows none until there are real ones. */
export type LogoCloudProps = { anchor?: string; heading?: string; items: { name: string; imageUrl?: Href; href?: Href }[] };

/** A customer's words. Not used by default: the site shows none until there are real ones. */
export type TestimonialProps = { anchor?: string; quote: string; name: string; role?: string; company?: string; imageUrl?: Href };

export type ProductPreviewsProps = SectionHead & { items: { preview: PreviewKind; title: string; body: string }[] };

/**
 * One cell of a comparison: "yes", "partial" or "no" (shown as an icon and "Yes", "Partly", "No"),
 * or words of the editor's own, shown as written ("From ₹999 a month", "With an add-on").
 */
export type ComparisonMark = string;
export const COMPARISON_MARKS = ["yes", "partial", "no"] as const;

/**
 * This product beside another, feature by feature — for the comparison pages. `competitor` is the
 * other product's name as the page states it; `asOf` ("yyyy-mm-dd") is the day its public website
 * was read, shown as "Information about {competitor} from its public website as of {asOf}". Each
 * row may carry the page of the competitor's site it was read from (`source`, an http(s) address,
 * linked `nofollow`); `disclaimer` is shown under the table.
 */
export type ComparisonTableProps = SectionHead & {
  competitor: string;
  asOf: string;
  rows: { feature: string; us: ComparisonMark; them: ComparisonMark; note?: string; source?: Href }[];
  disclaimer: string;
};

/** Cards linking to other pages on this site (never elsewhere) — "Related", "Read next". */
export type RelatedLinksProps = SectionHead & { links: { label: string; href: Href; description?: string }[] };

/** A hub page's map of the pages under it: groups of links, each with a line on what it covers. */
export type ModuleHighlightsProps = SectionHead & { groups: { title: string; items: { label: string; href: Href; description: string }[] }[] };

/** Signing in: to a workspace by its name, or "find my workspaces" by email. */
export type WorkspaceSigninProps = {
  anchor?: string;
  goHeading: string;
  goBody?: string;
  findHeading: string;
  findBody?: string;
  /** Shown after any "find my workspaces" request — the same whatever the address. */
  confirmationHeading: string;
  confirmationBody: string;
};

/** Setting up a workspace — the signup flow (src/components/platform/signup-flow.tsx) and what surrounds it. */
export type SignupFormProps = {
  heading: string;
  body?: string;
  bodyInviteOnly?: string;
  asideHeading?: string;
  asideItems?: string[];
};

export type BlockPropsMap = {
  hero: HeroProps;
  pageHeader: PageHeaderProps;
  featureGrid: FeatureGridProps;
  moduleGrid: ModuleGridProps;
  richText: RichTextProps;
  imageText: ImageTextProps;
  stats: StatsProps;
  faq: FaqProps;
  cta: CtaProps;
  pricingTable: PricingTableProps;
  securityHighlights: SecurityHighlightsProps;
  contactForm: ContactFormProps;
  logoCloud: LogoCloudProps;
  testimonial: TestimonialProps;
  productPreviews: ProductPreviewsProps;
  workspaceSignin: WorkspaceSigninProps;
  signupForm: SignupFormProps;
  comparisonTable: ComparisonTableProps;
  relatedLinks: RelatedLinksProps;
  moduleHighlights: ModuleHighlightsProps;
};

export type BlockType = keyof BlockPropsMap;

/** Every block type, for the CMS's "add a block" menu. */
export const BLOCK_TYPES = [
  "hero",
  "pageHeader",
  "featureGrid",
  "moduleGrid",
  "richText",
  "imageText",
  "stats",
  "faq",
  "cta",
  "pricingTable",
  "securityHighlights",
  "contactForm",
  "logoCloud",
  "testimonial",
  "productPreviews",
  "workspaceSignin",
  "signupForm",
  "comparisonTable",
  "relatedLinks",
  "moduleHighlights",
] as const satisfies readonly BlockType[];
// Every block type is in the list: this fails to compile if one is added to BlockPropsMap and not here.
type Assert<T extends true> = T;
export type EveryBlockTypeListed = Assert<[Exclude<BlockType, (typeof BLOCK_TYPES)[number]>] extends [never] ? true : false>;

/** One block on a page. `id` is stable across edits (the CMS's key for it). */
export type SiteBlock = { [K in BlockType]: { id: string; type: K; props: BlockPropsMap[K] } }[BlockType];

// ─── Pages ───────────────────────────────────────────────────────────────────────────────────────

export type SiteSeo = {
  /** Put into the site's title template ("%s · {siteName}") unless `absoluteTitle`. */
  title: string;
  absoluteTitle?: boolean;
  description: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: Href;
  /** Kept out of search engines (the signup page). */
  noindex?: boolean;
  /** Left out of /llms.txt (src/lib/seo/llms.ts); a noindex page is left out anyway. */
  noLlms?: boolean;
  /**
   * The page's primary keywords, keyword 1 first (at most three; trimmed, no repeats): for the SEO
   * Intelligence engine's placement checks and `<meta name="keywords">`. Absent when there are none —
   * as in every page saved before they existed.
   */
  keywords?: string[];
};

/**
 * A page. `slug` is its address: "home" is "/", anything else "/<slug>" (lower-case words and
 * hyphens, "/" between levels). `title` is its name in the CMS and in lists; `seo.title` is what a
 * browser tab and a search result show.
 */
export type SitePage = { slug: string; title: string; seo: SiteSeo; blocks: SiteBlock[] };

// ─── Site-wide settings ──────────────────────────────────────────────────────────────────────────

export type SocialNetwork = "linkedin" | "x" | "youtube" | "facebook" | "instagram" | "github" | "other";

/** A link in a header menu's column: its words, where it goes, and a line on what is there. */
export type NavMenuItem = { label: string; href: Href; description?: string };

/**
 * A header item that opens a panel of links (a "mega-menu"): columns, each a title and its links,
 * and optionally one link along the panel's foot ("See every feature"). Told apart from a plain
 * link by its `columns`.
 */
export type NavMenu = { label: string; columns: { title: string; items: NavMenuItem[] }[]; footer?: SiteLink };

/** One item across the header: a link, or a menu. Settings saved before menus existed hold links only — still valid. */
export type NavItem = SiteLink | NavMenu;

/** The header's and footer's limits, which the CMS's validator and editor hold too. */
export const NAV_LIMITS = { items: 8, columns: 5, columnItems: 10, description: 80, footerColumns: 6, footerLinks: 10 } as const;

export type SiteSettings = {
  siteName: string;
  tagline: string;
  /** The domain as the site writes it in text ("yourcompany.{displayDomain}"). Links use PLATFORM_DOMAIN. */
  displayDomain: string;
  /** Shown on the site. Contact requests are mailed to PLATFORM_SALES_EMAIL, not here. */
  salesEmail: string;
  nav: NavItem[];
  signinLink: SiteLink;
  signupCta: { open: SiteLink; inviteOnly: SiteLink };
  footer: { columns: { title: string; links: SiteLink[] }[]; note?: string };
  social: { network: SocialNetwork; href: Href; label?: string }[];
  seo: { titleTemplate: string; defaultTitle: string; description: string; ogImage?: Href };
  /** The page for an address the site does not have. */
  notFound: { heading: string; body: string; links: SiteLink[] };
};

// ─── Rendering ───────────────────────────────────────────────────────────────────────────────────

/** What a block is rendered with besides its props — worked out per request, never stored. */
export type SiteRenderContext = {
  settings: SiteSettings;
  /** Anybody may sign up (src/lib/platform/settings.ts signupOpen). */
  signupOpen: boolean;
  trialDays: number;
  /** The address's query, for the blocks that read one: pricingTable (country, interval), contactForm (topic). */
  searchParams: Record<string, string | undefined>;
  /** ".<PLATFORM_DOMAIN>[:port]" — what follows a workspace's name in its address. */
  workspaceSuffix: string;
  /**
   * Pages of the site switched off for now — the partner programme's, by its settings. Links to them
   * are left out of the header, footer and link blocks rather than sent to the not-found page.
   */
  hiddenPaths?: readonly string[];
};
