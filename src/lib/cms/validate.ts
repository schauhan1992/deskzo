import {
  BLOCK_TYPES,
  ICON_NAMES,
  PREVIEW_KINDS,
  type BlockPropsMap,
  type BlockType,
  type SiteBlock,
  type SiteSeo,
  type SiteSettings,
} from "@/components/site/blocks/types";
import type { CmsIssue, PageDocument, PostSeo } from "@/lib/cms/types";
import { keywordProblems, MAX_KEYWORDS, normaliseKeywords } from "@/lib/seo/keywords";

/**
 * Checking what an editor sends before it is stored — against the site's own content model
 * (src/components/site/blocks/types.ts), written out below as field specs, one per block type.
 *
 *   · An unknown block type, a wrong type of value, text over its length, a link that is not a site
 *     path, an #anchor, http(s) or mailto:, an image that is not from the media library — each is an
 *     issue, with the path to the field and the block's id, and nothing is stored.
 *   · Unknown props are dropped, strings are cleaned of control characters, empty optional ones left
 *     out. Block ids are kept when they are sensible, and made up when missing or repeated.
 *   · Two modes. "draft" is what autosave sends, half-written blocks and all: a required field may be
 *     empty (it is stored as ""), a required list may be empty. "publish" asks for everything the page
 *     needs: required text filled in, lists with at least one item, empty lines dropped.
 *
 * Pure: no database and nothing server-only, so the CMS's editor can run the same checks in the
 * browser for instant feedback (the server always checks again). Which media ids exist, and whether
 * they have alt text, is checked by the caller with the ids collected here (`media`).
 */

export type ValidationMode = "draft" | "publish";

type Field =
  /** `keep`: always a string, possibly empty, never an issue for being empty. `raw`: not trimmed (a rich-text run). */
  | { k: "text"; max: number; req?: boolean; keep?: boolean; raw?: boolean; email?: boolean }
  | { k: "href"; req?: boolean; webOnly?: boolean }
  | { k: "image"; req?: boolean }
  | { k: "anchor" }
  | { k: "enum"; values: readonly (string | number)[]; req?: boolean }
  | { k: "bool" }
  | { k: "texts"; max: number; maxItems: number; req?: boolean }
  | { k: "action"; req?: boolean }
  | { k: "link"; req?: boolean }
  | { k: "media"; req?: boolean }
  | { k: "rich"; maxItems: number; req?: boolean }
  | { k: "list"; of: Fields; maxItems: number; req?: boolean; min?: number }
  | { k: "object"; of: Fields; req?: boolean }
  /** The primary keywords (`checkKeywords`): stored normalised, left out when there are none. */
  | { k: "keywords" };
type Fields = Record<string, Field>;

const text = (max: number, req = false): Field => ({ k: "text", max, req });
const keep = (max: number): Field => ({ k: "text", max, keep: true });
const list = (of: Fields, maxItems: number, req = false, min?: number): Field => ({ k: "list", of, maxItems, req, min });

const HEADING = 200;
const LABEL = 80;
const SHORT = 120;
const BODY = 1000;
const LONG = 2000;

const SECTION_HEAD = { anchor: { k: "anchor" }, eyebrow: text(LABEL), heading: text(HEADING, true), intro: text(BODY) } satisfies Fields;
const ICON: Field = { k: "enum", values: ICON_NAMES };
const ICON_REQ: Field = { k: "enum", values: ICON_NAMES, req: true };
const LINK: Fields = { label: text(LABEL, true), href: { k: "href", req: true } };

/** Every block type's props. The mapped type fails to compile when a block or a prop in types.ts is missing here. */
const BLOCK_SPECS = {
  hero: {
    eyebrow: text(LABEL),
    heading: text(HEADING, true),
    subheading: text(600),
    primary: { k: "action" },
    secondary: { k: "action" },
    note: text(300),
    noteInviteOnly: text(300),
    media: { k: "media" },
  },
  pageHeader: {
    eyebrow: text(LABEL),
    heading: text(HEADING, true),
    intro: text(BODY),
    notice: { k: "object", of: { tone: { k: "enum", values: ["info", "warning"], req: true }, text: text(600, true) } },
  },
  featureGrid: {
    ...SECTION_HEAD,
    columns: { k: "enum", values: [2, 3, 4] },
    items: list({ icon: ICON, title: text(SHORT, true), body: text(BODY, true), bullets: { k: "texts", max: 200, maxItems: 12 }, link: { k: "link" } }, 24, true),
  },
  moduleGrid: {
    ...SECTION_HEAD,
    groups: list(
      { icon: ICON_REQ, title: text(SHORT, true), summary: text(600), modules: list({ key: text(60), label: text(LABEL, true), blurb: text(300, true) }, 30, true) },
      16,
      true,
    ),
    footnote: text(600),
  },
  richText: { anchor: { k: "anchor" }, heading: text(HEADING), content: { k: "rich", maxItems: 300, req: true } },
  imageText: {
    ...SECTION_HEAD,
    body: { k: "texts", max: LONG, maxItems: 10 },
    bullets: { k: "texts", max: 200, maxItems: 12 },
    action: { k: "action" },
    media: { k: "media", req: true },
    mediaSide: { k: "enum", values: ["left", "right"] },
  },
  stats: { anchor: { k: "anchor" }, heading: text(HEADING), items: list({ value: text(40, true), label: text(SHORT, true) }, 8, true) },
  faq: { ...SECTION_HEAD, items: list({ question: text(300, true), answer: { k: "texts", max: LONG, maxItems: 10, req: true } }, 40, true) },
  cta: {
    anchor: { k: "anchor" },
    heading: text(HEADING, true),
    body: text(BODY),
    primary: { k: "action" },
    secondary: { k: "action" },
    variant: { k: "enum", values: ["band", "panel"] },
  },
  pricingTable: {
    anchor: { k: "anchor" },
    countryLabel: text(LABEL, true),
    editionsHeading: text(HEADING, true),
    extrasHeading: text(HEADING, true),
    extrasIntro: text(BODY),
    trialNote: text(300),
    footnote: text(600),
    emptyHeading: text(HEADING, true),
    emptyBody: text(BODY, true),
    emptyAction: { k: "action" },
  },
  securityHighlights: { ...SECTION_HEAD, items: list({ icon: ICON_REQ, title: text(SHORT, true), body: text(BODY, true) }, 24, true), link: { k: "link" } },
  contactForm: {
    anchor: { k: "anchor" },
    heading: text(HEADING, true),
    intro: text(BODY),
    topics: { k: "object", req: true, of: { demo: text(60, true), sales: text(60, true), support: text(60, true), other: text(60, true) } },
    submitLabel: text(60, true),
    successHeading: text(HEADING, true),
    successBody: text(BODY, true),
    asideHeading: text(HEADING),
    aside: list({ title: text(SHORT, true), body: text(BODY, true), link: { k: "link" } }, 6),
  },
  logoCloud: { anchor: { k: "anchor" }, heading: text(HEADING), items: list({ name: text(SHORT, true), imageUrl: { k: "image" }, href: { k: "href" } }, 24, true) },
  testimonial: { anchor: { k: "anchor" }, quote: text(BODY, true), name: text(SHORT, true), role: text(SHORT), company: text(SHORT), imageUrl: { k: "image" } },
  productPreviews: { ...SECTION_HEAD, items: list({ preview: { k: "enum", values: PREVIEW_KINDS, req: true }, title: text(SHORT, true), body: text(BODY, true) }, 6, true) },
  workspaceSignin: {
    anchor: { k: "anchor" },
    goHeading: text(HEADING, true),
    goBody: text(BODY),
    findHeading: text(HEADING, true),
    findBody: text(BODY),
    confirmationHeading: text(HEADING, true),
    confirmationBody: text(BODY, true),
  },
  signupForm: { heading: text(HEADING, true), body: text(BODY), bodyInviteOnly: text(BODY), asideHeading: text(HEADING), asideItems: { k: "texts", max: 300, maxItems: 12 } },
} satisfies { [K in BlockType]: Record<keyof BlockPropsMap[K], Field> };

const SEO_SPEC: Fields = {
  title: text(SHORT, true),
  absoluteTitle: { k: "bool" },
  description: keep(300),
  ogTitle: text(SHORT),
  ogDescription: text(300),
  ogImage: { k: "image" },
  noindex: { k: "bool" },
  keywords: { k: "keywords" },
} satisfies Record<keyof SiteSeo, Field>;

const POST_SEO_SPEC: Fields = { title: text(SHORT), description: text(300), ogImage: { k: "image" }, noindex: { k: "bool" }, keywords: { k: "keywords" } } satisfies Record<keyof PostSeo, Field>;

const SOCIAL_NETWORKS = ["linkedin", "x", "youtube", "facebook", "instagram", "github", "other"] as const;

const SETTINGS_SPEC: Fields = {
  siteName: text(LABEL, true),
  tagline: keep(160),
  displayDomain: keep(100),
  salesEmail: { k: "text", max: 254, keep: true, email: true },
  nav: list(LINK, 8, true, 0),
  signinLink: { k: "link", req: true },
  signupCta: { k: "object", req: true, of: { open: { k: "link", req: true }, inviteOnly: { k: "link", req: true } } },
  footer: { k: "object", req: true, of: { columns: list({ title: text(LABEL, true), links: list(LINK, 10, true, 0) }, 5, true, 0), note: text(300) } },
  social: list({ network: { k: "enum", values: SOCIAL_NETWORKS, req: true }, href: { k: "href", req: true, webOnly: true }, label: text(LABEL) }, 10, true, 0),
  seo: { k: "object", req: true, of: { titleTemplate: text(SHORT, true), defaultTitle: text(SHORT, true), description: keep(300), ogImage: { k: "image" } } },
  notFound: { k: "object", req: true, of: { heading: text(HEADING, true), body: text(BODY, true), links: list(LINK, 6, true, 0) } },
} satisfies Record<keyof SiteSettings, Field>;

export const MAX_BLOCKS = 60;

// ─── Checks shared with the rest of the CMS ──────────────────────────────────────────────────────

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const MEDIA_SRC = /^\/media\/([a-z0-9]{20,40})$/;
const ANCHOR = /^[a-z][a-z0-9-]{0,47}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A link an editor may store: a path on this site ("/pricing", "/contact?topic=demo" — never
 * "//elsewhere"), an "#anchor", an http(s) address, or mailto: an address. The site checks again
 * when it renders (src/components/site/links.ts safeHref), and shows mailto: as plain text.
 */
export function isAllowedHref(raw: string, webOnly = false): boolean {
  const href = raw.trim();
  if (!href || href.length > 2048 || /[\s\u0000-\u001f\u007f\\]/.test(href)) return false;
  if (!webOnly && href.startsWith("/")) return !href.startsWith("//");
  if (!webOnly && href.startsWith("#")) return ANCHOR.test(href.slice(1));
  if (!webOnly && /^mailto:/i.test(href)) return EMAIL.test(decodeURIComponentSafe(href.slice(7).split("?")[0] ?? ""));
  try {
    const url = new URL(href);
    return (url.protocol === "https:" || url.protocol === "http:") && !!url.hostname;
  } catch {
    return false;
  }
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

/** The media id in a "/media/<id>" address, or null. */
export function mediaIdOf(src: unknown): string | null {
  const m = typeof src === "string" ? MEDIA_SRC.exec(src.trim()) : null;
  return m ? m[1] : null;
}

/** Page slugs: lower-case words and hyphens, "/" between levels (src/lib/platform/site-content.ts SLUG_PATTERN). */
export const PAGE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
/** Post slugs: one level. */
export const POST_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Post slugs the blog's own routes need: /blog/category/<slug>, /blog/tag/<slug>, and "page" for
 * paging. A post may not take one — nor may a new post's address made from its title (it gets "-2").
 */
export const RESERVED_POST_SLUGS = ["category", "tag", "page"] as const;

export function isReservedPostSlug(slug: string): boolean {
  return (RESERVED_POST_SLUGS as readonly string[]).includes(slug);
}

/** Category and tag slugs: the post slug's format, at most 60 (the database's CHECKs). */
export const TERM_SLUG = POST_SLUG;

/** "Hello, World!" → "hello-world". */
export function slugify(value: string, max = 80): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/** More slots than this is not an editor's three boxes. */
const KEYWORD_SLOTS_MAX = 10;

/**
 * An entity's primary keywords (a page's, a post's, a category's or tag's `seo.keywords`), as its
 * editor holds them: up to three filled boxes, blanks allowed. The rules are the SEO engine's own
 * (src/lib/seo/keywords.ts `keywordProblems`), so the editor and the server refuse the same things:
 * a repeat of an earlier keyword (compared case-insensitively, on its words — the issue is on the
 * later one), a fourth, one over 80 characters, one with no letter or digit. `index` is the box
 * (from 0), null for the list as a whole.
 *
 * `keywords` is what is stored: trimmed, inner whitespace collapsed, blanks dropped (`normaliseKeywords`)
 * — an empty list is stored as no field at all.
 */
export function checkKeywords(value: unknown): { keywords: string[]; issues: { index: number | null; message: string }[] } {
  if (value === undefined || value === null) return { keywords: [], issues: [] };
  if (!Array.isArray(value)) return { keywords: [], issues: [{ index: null, message: `Keywords are a list of up to ${MAX_KEYWORDS}.` }] };
  if (value.length > KEYWORD_SLOTS_MAX) return { keywords: [], issues: [{ index: null, message: `At most ${MAX_KEYWORDS} primary keywords.` }] };
  const issues: { index: number | null; message: string }[] = [];
  const cleaned = value.map((entry, index) => {
    if (entry === undefined || entry === null) return "";
    if (typeof entry !== "string") {
      issues.push({ index, message: "A keyword is text." });
      return "";
    }
    return entry.replace(CONTROL, " ");
  });
  issues.push(...keywordProblems(cleaned));
  return { keywords: issues.length ? [] : normaliseKeywords(cleaned), issues };
}

// ─── The walker ──────────────────────────────────────────────────────────────────────────────────

type Ctx = { mode: ValidationMode; issues: CmsIssue[]; media: Set<string>; blockId?: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const missing = (v: unknown) => v === undefined || v === null;

function issue(ctx: Ctx, path: string, message: string) {
  if (ctx.issues.length >= 200) return;
  ctx.issues.push({ path, message, ...(ctx.blockId ? { blockId: ctx.blockId } : {}) });
}

function cleanText(value: string, raw: boolean): string {
  const cleaned = value.replace(/\r\n?/g, "\n").replace(CONTROL, "");
  return raw ? cleaned : cleaned.trim();
}

/** A field's value once checked; `undefined` leaves it out. */
function checkField(field: Field, value: unknown, path: string, ctx: Ctx): unknown {
  const publish = ctx.mode === "publish";
  const required = "req" in field && !!field.req;

  if (missing(value) && field.k !== "list" && field.k !== "object" && field.k !== "texts" && field.k !== "rich") {
    if (field.k === "text" && field.keep) return "";
    if (!required) return undefined;
    if (publish) {
      issue(ctx, path, "Fill this in.");
      return undefined;
    }
    switch (field.k) {
      case "text":
      case "href":
      case "image":
        return "";
      case "enum":
        return field.values[0];
      case "action":
        return { kind: "signup" };
      case "link":
        return { label: "", href: "" };
      case "media":
        return { kind: "preview", preview: PREVIEW_KINDS[0] };
      default:
        return undefined;
    }
  }

  switch (field.k) {
    case "text": {
      if (typeof value !== "string") {
        issue(ctx, path, "This must be text.");
        return undefined;
      }
      const t = cleanText(value, !!field.raw);
      if (t.length > field.max) issue(ctx, path, `Keep this to ${field.max.toLocaleString("en-IN")} characters (it has ${t.length.toLocaleString("en-IN")}).`);
      if (field.email && t && !EMAIL.test(t)) issue(ctx, path, "Enter an email address.");
      if (!t.trim()) {
        if (field.keep) return "";
        if (required) {
          if (publish) issue(ctx, path, "Fill this in.");
          return "";
        }
        return undefined;
      }
      return t;
    }
    case "href": {
      if (typeof value !== "string") {
        issue(ctx, path, "A link must be text.");
        return undefined;
      }
      const h = value.trim();
      if (!h) {
        if (required && publish) issue(ctx, path, "Add a link.");
        return required ? "" : undefined;
      }
      if (!isAllowedHref(h, field.webOnly)) {
        issue(ctx, path, field.webOnly ? "Use an http(s) address." : "Links must be a page on this site (/pricing), an #anchor, an http(s) address or mailto:.");
        return undefined;
      }
      return h;
    }
    case "image": {
      if (typeof value !== "string") {
        issue(ctx, path, "Choose an image from the media library.");
        return undefined;
      }
      const src = value.trim();
      if (!src) {
        if (required && publish) issue(ctx, path, "Choose an image.");
        return required ? "" : undefined;
      }
      const id = mediaIdOf(src);
      if (!id) {
        issue(ctx, path, "Choose an image from the media library.");
        return undefined;
      }
      ctx.media.add(id);
      return `/media/${id}`;
    }
    case "anchor": {
      if (typeof value !== "string") {
        issue(ctx, path, "An anchor must be text.");
        return undefined;
      }
      const a = value.trim().replace(/^#/, "");
      if (!a) return undefined;
      if (!ANCHOR.test(a)) {
        issue(ctx, path, "Use lower-case letters, digits and hyphens, starting with a letter (at most 48).");
        return undefined;
      }
      return a;
    }
    case "enum": {
      const numeric = typeof field.values[0] === "number";
      const v = numeric && typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
      if (!field.values.includes(v as string | number)) {
        issue(ctx, path, `Choose one of: ${field.values.join(", ")}.`);
        return undefined;
      }
      return v;
    }
    case "bool": {
      if (typeof value !== "boolean") {
        issue(ctx, path, "This must be yes or no.");
        return undefined;
      }
      return value ? true : undefined;
    }
    case "texts": {
      if (missing(value)) {
        if (!required) return undefined;
        if (publish) issue(ctx, path, "Add at least one line.");
        return [];
      }
      if (!Array.isArray(value)) {
        issue(ctx, path, "This must be a list of lines.");
        return undefined;
      }
      if (value.length > field.maxItems) issue(ctx, path, `At most ${field.maxItems} lines.`);
      const lines = value.slice(0, field.maxItems).map((line, i) => checkField({ k: "text", max: field.max, keep: true }, line, `${path}[${i}]`, ctx) as string);
      const out = publish ? lines.filter((l) => l.trim()) : lines;
      if (required && publish && out.length === 0) issue(ctx, path, "Add at least one line.");
      if (!required && out.length === 0) return undefined;
      return out;
    }
    case "action": {
      if (!isObj(value)) {
        issue(ctx, path, "A button is a link or the signup button.");
        return undefined;
      }
      if (value.kind === "signup") return { kind: "signup" };
      if (value.kind !== "link") {
        issue(ctx, path, "A button is a link or the signup button.");
        return undefined;
      }
      return {
        kind: "link",
        label: checkField(text(LABEL, true), value.label, `${path}.label`, ctx) ?? "",
        href: checkField({ k: "href", req: true }, value.href, `${path}.href`, ctx) ?? "",
      };
    }
    case "link": {
      if (!isObj(value)) {
        issue(ctx, path, "A link has a label and an address.");
        return undefined;
      }
      return { label: checkField(text(LABEL, true), value.label, `${path}.label`, ctx) ?? "", href: checkField({ k: "href", req: true }, value.href, `${path}.href`, ctx) ?? "" };
    }
    case "media": {
      if (!isObj(value)) {
        issue(ctx, path, "Choose an image or a product preview.");
        return undefined;
      }
      if (value.kind === "preview") return { kind: "preview", preview: checkField({ k: "enum", values: PREVIEW_KINDS, req: true }, value.preview, `${path}.preview`, ctx) ?? PREVIEW_KINDS[0] };
      if (value.kind === "image") {
        return {
          kind: "image",
          src: checkField({ k: "image", req: true }, value.src, `${path}.src`, ctx) ?? "",
          alt: checkField(text(200, true), value.alt, `${path}.alt`, ctx) ?? "",
        };
      }
      issue(ctx, path, "Choose an image or a product preview.");
      return undefined;
    }
    case "rich":
      return checkRich(value, path, ctx, field.maxItems, required);
    case "list": {
      if (missing(value)) {
        if (!required) return undefined;
        if (publish && (field.min ?? 1) > 0) issue(ctx, path, "Add at least one.");
        return [];
      }
      if (!Array.isArray(value)) {
        issue(ctx, path, "This must be a list.");
        return undefined;
      }
      if (value.length > field.maxItems) issue(ctx, path, `At most ${field.maxItems}.`);
      if (publish && value.length < (field.min ?? (required ? 1 : 0))) issue(ctx, path, "Add at least one.");
      const items = value.slice(0, field.maxItems).map((item, i) => checkObject(field.of, item, `${path}[${i}]`, ctx));
      if (!required && items.length === 0) return undefined;
      return items;
    }
    case "object": {
      if (missing(value)) {
        if (!required) return undefined;
        return checkObject(field.of, {}, path, ctx);
      }
      return checkObject(field.of, value, path, ctx);
    }
    case "keywords": {
      const checked = checkKeywords(value);
      for (const p of checked.issues) issue(ctx, p.index === null ? path : `${path}[${p.index}]`, p.message);
      return checked.keywords.length ? checked.keywords : undefined;
    }
  }
}

function checkObject(spec: Fields, value: unknown, path: string, ctx: Ctx): Record<string, unknown> {
  if (!isObj(value)) {
    issue(ctx, path, "This must be a group of fields.");
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(spec)) {
    const v = checkField(field, value[key], path ? `${path}.${key}` : key, ctx);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

const INLINE_TEXT: Field = { k: "text", max: 5000, keep: true, raw: true };

function checkInline(value: unknown, path: string, ctx: Ctx, required: boolean): unknown {
  if (typeof value === "string" || missing(value)) {
    const t = checkField(INLINE_TEXT, value ?? "", path, ctx) as string;
    if (required && ctx.mode === "publish" && !t.trim()) issue(ctx, path, "Fill this in.");
    return t;
  }
  if (!Array.isArray(value)) {
    issue(ctx, path, "This must be text.");
    return "";
  }
  if (value.length > 60) issue(ctx, path, "At most 60 runs of text.");
  const spans = value.slice(0, 60).map((span, i) => {
    const p = `${path}[${i}]`;
    if (!isObj(span)) {
      issue(ctx, p, "This must be text.");
      return { text: "" };
    }
    const out: Record<string, unknown> = { text: checkField({ k: "text", max: 2000, keep: true, raw: true }, span.text, `${p}.text`, ctx) };
    if (span.strong === true) out.strong = true;
    if (span.em === true) out.em = true;
    const href = checkField({ k: "href" }, span.href, `${p}.href`, ctx);
    if (href) out.href = href;
    return out;
  });
  if (required && ctx.mode === "publish" && !spans.some((s) => String(s.text).trim())) issue(ctx, path, "Fill this in.");
  return spans;
}

function checkRich(value: unknown, path: string, ctx: Ctx, maxItems: number, required: boolean): unknown {
  if (missing(value)) {
    if (required && ctx.mode === "publish") issue(ctx, path, "Add some text.");
    return required ? [] : undefined;
  }
  if (!Array.isArray(value)) {
    issue(ctx, path, "This must be a list of paragraphs, headings and lists.");
    return undefined;
  }
  if (value.length > maxItems) issue(ctx, path, `At most ${maxItems} paragraphs, headings and lists.`);
  if (required && ctx.mode === "publish" && value.length === 0) issue(ctx, path, "Add some text.");
  const nodes: unknown[] = [];
  value.slice(0, maxItems).forEach((node, i) => {
    const p = `${path}[${i}]`;
    if (!isObj(node)) {
      issue(ctx, p, "Unknown kind of text.");
      return;
    }
    switch (node.type) {
      case "heading": {
        const level = checkField({ k: "enum", values: [2, 3], req: true }, node.level ?? 2, `${p}.level`, ctx);
        const out: Record<string, unknown> = { type: "heading", level: level ?? 2, text: checkField(text(HEADING, true), node.text, `${p}.text`, ctx) ?? "" };
        const anchor = checkField({ k: "anchor" }, node.anchor, `${p}.anchor`, ctx);
        if (anchor) out.anchor = anchor;
        nodes.push(out);
        return;
      }
      case "paragraph":
        nodes.push({ type: "paragraph", text: checkInline(node.text, `${p}.text`, ctx, true) });
        return;
      case "list": {
        const items = Array.isArray(node.items) ? node.items : [];
        if (!Array.isArray(node.items) && !missing(node.items)) issue(ctx, `${p}.items`, "This must be a list.");
        if (items.length > 50) issue(ctx, `${p}.items`, "At most 50 items.");
        const checked = items.slice(0, 50).map((item, j) => checkInline(item, `${p}.items[${j}]`, ctx, false));
        const kept = ctx.mode === "publish" ? checked.filter((c) => (typeof c === "string" ? c.trim() : (c as { text: string }[]).some((s) => s.text.trim()))) : checked;
        if (ctx.mode === "publish" && kept.length === 0) issue(ctx, `${p}.items`, "Add at least one item.");
        nodes.push({ type: "list", ...(node.ordered === true ? { ordered: true } : {}), items: kept });
        return;
      }
      case "table": {
        const columns = (checkField({ k: "texts", max: LABEL, maxItems: 8, req: true }, node.columns, `${p}.columns`, ctx) as string[] | undefined) ?? [];
        const rows = Array.isArray(node.rows) ? node.rows : [];
        if (!Array.isArray(node.rows) && !missing(node.rows)) issue(ctx, `${p}.rows`, "This must be a list of rows.");
        if (rows.length > 100) issue(ctx, `${p}.rows`, "At most 100 rows.");
        const checkedRows = rows.slice(0, 100).map((row, r) => {
          if (!Array.isArray(row)) {
            issue(ctx, `${p}.rows[${r}]`, "A row is a list of cells.");
            return [];
          }
          if (row.length > 8) issue(ctx, `${p}.rows[${r}]`, "At most 8 cells.");
          return row.slice(0, 8).map((cell, c) => checkInline(cell, `${p}.rows[${r}][${c}]`, ctx, false));
        });
        nodes.push({ type: "table", columns, rows: checkedRows });
        return;
      }
      case "note": {
        const tone = checkField({ k: "enum", values: ["info", "warning"], req: true }, node.tone ?? "info", `${p}.tone`, ctx);
        nodes.push({ type: "note", tone: tone ?? "info", text: checkInline(node.text, `${p}.text`, ctx, true) });
        return;
      }
      default:
        issue(ctx, `${p}.type`, "Unknown kind of text.");
    }
  });
  return nodes;
}

const BLOCK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A list of blocks. `allowed` narrows the types (a post's body). */
function checkBlocks(value: unknown, path: string, ctx: Ctx, allowed: readonly BlockType[]): SiteBlock[] {
  if (missing(value)) return [];
  if (!Array.isArray(value)) {
    issue(ctx, path, "The content must be a list of blocks.");
    return [];
  }
  if (value.length > MAX_BLOCKS) issue(ctx, path, `At most ${MAX_BLOCKS} blocks.`);
  const seen = new Set<string>();
  const out: SiteBlock[] = [];
  value.slice(0, MAX_BLOCKS).forEach((block, i) => {
    const p = `${path}[${i}]`;
    if (!isObj(block)) {
      issue(ctx, p, "Not a block.");
      return;
    }
    let id = typeof block.id === "string" && BLOCK_ID.test(block.id) ? block.id : "";
    if (!id || seen.has(id)) id = globalThis.crypto.randomUUID().slice(0, 8);
    seen.add(id);
    const type = block.type;
    ctx.blockId = id;
    if (typeof type !== "string" || !(BLOCK_TYPES as readonly string[]).includes(type)) {
      issue(ctx, `${p}.type`, "Unknown block type.");
      ctx.blockId = undefined;
      return;
    }
    if (!allowed.includes(type as BlockType)) {
      issue(ctx, `${p}.type`, "This block can't be used here.");
      ctx.blockId = undefined;
      return;
    }
    const props = checkObject(BLOCK_SPECS[type as BlockType] as Fields, block.props ?? {}, `${p}.props`, ctx);
    ctx.blockId = undefined;
    out.push({ id, type, props } as SiteBlock);
  });
  return out;
}

export type Checked<T> = { ok: true; value: T; media: string[] } | { ok: false; issues: CmsIssue[]; media: string[] };

function finish<T>(ctx: Ctx, value: T): Checked<T> {
  const media = [...ctx.media];
  return ctx.issues.length ? { ok: false, issues: ctx.issues, media } : { ok: true, value, media };
}

/** A page's document: { title, seo, blocks }. */
export function checkPageDocument(input: unknown, mode: ValidationMode): Checked<PageDocument> {
  const ctx: Ctx = { mode, issues: [], media: new Set() };
  const doc = isObj(input) ? input : {};
  if (!isObj(input)) issue(ctx, "", "Not a page.");
  const title = checkField(text(SHORT, true), doc.title, "title", ctx) as string | undefined;
  const seo = checkObject(SEO_SPEC, doc.seo ?? {}, "seo", ctx) as unknown as SiteSeo;
  const blocks = checkBlocks(doc.blocks, "blocks", ctx, BLOCK_TYPES);
  if (mode === "publish" && blocks.length === 0) issue(ctx, "blocks", "Add at least one block.");
  return finish(ctx, { title: title ?? "", seo: { ...seo, title: seo.title ?? "", description: seo.description ?? "" }, blocks });
}

/** A post's body blocks, limited to `allowed`. */
export function checkPostBody(input: unknown, mode: ValidationMode, allowed: readonly BlockType[]): Checked<SiteBlock[]> {
  const ctx: Ctx = { mode, issues: [], media: new Set() };
  const blocks = checkBlocks(input, "body", ctx, allowed);
  return finish(ctx, blocks);
}

export function checkPostSeo(input: unknown): Checked<PostSeo | null> {
  const ctx: Ctx = { mode: "draft", issues: [], media: new Set() };
  if (missing(input)) return finish(ctx, null);
  const seo = checkObject(POST_SEO_SPEC, input, "seo", ctx) as PostSeo;
  return finish(ctx, Object.keys(seo).length ? seo : null);
}

/** The site's settings, whole — the caller merges a partial change over the current draft first. */
export function checkSiteSettings(input: unknown, mode: ValidationMode): Checked<SiteSettings> {
  const ctx: Ctx = { mode, issues: [], media: new Set() };
  const settings = checkObject(SETTINGS_SPEC, input, "", ctx) as unknown as SiteSettings;
  if (settings.seo && !String(settings.seo.titleTemplate ?? "").includes("%s")) issue(ctx, "seo.titleTemplate", 'The title template needs "%s" where the page\'s title goes.');
  return finish(ctx, settings);
}

/** Every "/media/<id>" anywhere in a stored document — for "where is this image used". */
export function mediaIdsIn(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    const id = mediaIdOf(value);
    if (id) into.add(id);
  } else if (Array.isArray(value)) {
    for (const v of value) mediaIdsIn(v, into);
  } else if (isObj(value)) {
    for (const v of Object.values(value)) mediaIdsIn(v, into);
  }
  return into;
}

/**
 * An issue at every place in a document that uses one of `ids` — "this image is not in the library",
 * "this image has no alt text" — with the path and the block it is in.
 */
export function mediaIssues(value: unknown, ids: Set<string>, message: (id: string) => string, path = "", blockId?: string, out: CmsIssue[] = []): CmsIssue[] {
  if (typeof value === "string") {
    const id = mediaIdOf(value);
    if (id && ids.has(id)) out.push({ path, message: message(id), ...(blockId ? { blockId } : {}) });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => mediaIssues(v, ids, message, `${path}[${i}]`, blockId, out));
  } else if (isObj(value)) {
    const inBlock = typeof value.id === "string" && typeof value.type === "string" && isObj(value.props) ? value.id : blockId;
    for (const [k, v] of Object.entries(value)) mediaIssues(v, ids, message, path ? `${path}.${k}` : k, inBlock, out);
  }
  return out;
}

/** JSON with its keys in a fixed order: two documents that say the same thing compare equal. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObj(value)) {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
