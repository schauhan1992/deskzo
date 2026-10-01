import type { IconName, PreviewKind, RichInline, RichNode, SiteAction, SiteBlock } from "../../src/components/site/blocks/types";
import { byPath, type CatalogGroup } from "./_catalog";
import type { SeedPage } from "./types";

/**
 * The page shapes the seed's sections share, built from compact specs so each data module reads as
 * content, not as JSON. Every builder returns a SeedPage the CMS validates as it is.
 */

export const SIGNUP: SiteAction = { kind: "signup" };
export const DEMO: SiteAction = { kind: "link", label: "Book a demo", href: "/contact?topic=demo" };
const TRIAL_NOTE = "Free for {trialDays} days. No card needed to start.";
const INVITE_NOTE = "Setting up a workspace is by invitation for now.";

export type Seo = { title: string; description: string; keywords: [string, string, string] };
export type Feature = { icon: IconName; title: string; body: string; bullets?: string[] };
/** A question and its answer, one paragraph per string — the first a direct answer of 60 words or fewer. */
export type Faq = [question: string, ...answer: string[]];

/**
 * A "how it works" section: drawn beside one of the site's product previews where a preview shows
 * this very screen, and as numbered steps in text where none does (the site uses no stock images).
 */
export type How = {
  heading: string;
  intro?: string;
  body?: string[];
  bullets?: string[];
  /** Numbered steps (the text form only). */
  steps?: string[];
  preview?: PreviewKind;
  side?: "left" | "right";
};

const key = (slug: string) => slug.replace(/\//g, "-");

/** A paragraph of plain text, or of runs: `[["Read the ", ""], ["CBIC's notice", "https://…"]]` style is `link()`. */
export const p = (text: RichInline): RichNode => ({ type: "paragraph", text });
export const h2 = (text: string, anchor?: string): RichNode => ({ type: "heading", level: 2, text, ...(anchor ? { anchor } : {}) });
export const h3 = (text: string, anchor?: string): RichNode => ({ type: "heading", level: 3, text, ...(anchor ? { anchor } : {}) });
export const ul = (...items: RichInline[]): RichNode => ({ type: "list", items });
export const ol = (...items: RichInline[]): RichNode => ({ type: "list", ordered: true, items });
export const table = (columns: string[], rows: RichInline[][]): RichNode => ({ type: "table", columns, rows });
export const note = (text: RichInline, tone: "info" | "warning" = "info"): RichNode => ({ type: "note", tone, text });
/** Inline runs: strings are plain text, `[text, href]` a link, `{ b: text }` bold. */
export function runs(...parts: (string | [string, string] | { b: string })[]): RichInline {
  return parts.map((part) => (typeof part === "string" ? { text: part } : Array.isArray(part) ? { text: part[0], href: part[1] } : { text: part.b, strong: true }));
}

/** Related pages as cards, labelled and described from the catalogue unless given. */
export function related(id: string, heading: string, paths: (string | { path: string; label?: string; description?: string })[], intro?: string): SiteBlock {
  return {
    id,
    type: "relatedLinks",
    props: {
      heading,
      ...(intro ? { intro } : {}),
      links: paths.map((item) => {
        const given = typeof item === "string" ? { path: item } : item;
        const known = given.label && given.description ? null : byPath(given.path);
        const path = given.path;
        const label = given.label ?? known?.label ?? path;
        const description = given.description ?? known?.summary;
        return { label, href: path, ...(description ? { description } : {}) };
      }),
    },
  };
}

/** A hub's map: every group of the catalogue, each page with its summary. */
export function pageMap(id: string, heading: string, intro: string, groups: CatalogGroup[]): SiteBlock {
  return {
    id,
    type: "moduleHighlights",
    props: { heading, intro, groups: groups.map((g) => ({ title: g.title, items: g.entries.map((e) => ({ label: e.label, href: e.path, description: e.summary })) })) },
  };
}

function howBlock(id: string, how: How, eyebrow?: string): SiteBlock {
  if (how.preview) {
    return {
      id,
      type: "imageText",
      props: {
        ...(eyebrow ? { eyebrow } : {}),
        heading: how.heading,
        ...(how.intro ? { intro: how.intro } : {}),
        ...(how.body?.length ? { body: how.body } : {}),
        ...(how.bullets?.length ? { bullets: how.bullets } : {}),
        media: { kind: "preview", preview: how.preview },
        mediaSide: how.side ?? "right",
      },
    };
  }
  const content: RichNode[] = [];
  if (how.intro) content.push(p(how.intro));
  for (const para of how.body ?? []) content.push(p(para));
  if (how.steps?.length) content.push(ol(...how.steps));
  if (how.bullets?.length) content.push(ul(...how.bullets));
  return { id, type: "richText", props: { heading: how.heading, content } };
}

function faqBlock(id: string, heading: string, faqs: Faq[]): SiteBlock {
  return { id, type: "faq", props: { anchor: "faq", heading, items: faqs.map(([question, ...answer]) => ({ question, answer })) } };
}

function ctaBlock(id: string, cta: { heading: string; body: string } | undefined): SiteBlock {
  return {
    id,
    type: "cta",
    props: {
      heading: cta?.heading ?? "See it with your own data",
      body: cta?.body ?? "Set up a workspace for your company and switch on the modules you need. Every workspace starts with a {trialDays}-day free trial.",
      primary: SIGNUP,
      secondary: DEMO,
      variant: "band",
    },
  };
}

function hero(id: string, eyebrow: string, heading: string, subheading: string, preview?: PreviewKind): SiteBlock {
  return {
    id,
    type: "hero",
    props: {
      eyebrow,
      heading,
      subheading,
      primary: SIGNUP,
      secondary: DEMO,
      note: TRIAL_NOTE,
      noteInviteOnly: INVITE_NOTE,
      ...(preview ? { media: { kind: "preview", preview } } : {}),
    },
  };
}

// ─── A product module's page ─────────────────────────────────────────────────────────────────────

export type ProductSpec = {
  slug: string;
  /** The page's name in the CMS and in breadcrumbs ("CRM"). */
  name: string;
  seo: Seo;
  eyebrow: string;
  h1: string;
  lead: string;
  heroPreview?: PreviewKind;
  /** The answer-first opening: a question-shaped H2, its short answer, then more. */
  answer: { question: string; answer: string; more?: RichInline[]; list?: RichInline[] };
  features: { heading: string; intro?: string; columns?: 2 | 3; items: Feature[] };
  how: How[];
  faqHeading?: string;
  faq: Faq[];
  related: string[];
  relatedHeading?: string;
  cta?: { heading: string; body: string };
};

export function productPage(spec: ProductSpec): SeedPage {
  const k = key(spec.slug);
  const answer: RichNode[] = [p(spec.answer.answer), ...(spec.answer.more ?? []).map((m) => p(m)), ...(spec.answer.list?.length ? [ul(...spec.answer.list)] : [])];
  const blocks: SiteBlock[] = [
    hero(`${k}-hero`, spec.eyebrow, spec.h1, spec.lead, spec.heroPreview),
    { id: `${k}-answer`, type: "richText", props: { heading: spec.answer.question, content: answer } },
    { id: `${k}-features`, type: "featureGrid", props: { heading: spec.features.heading, ...(spec.features.intro ? { intro: spec.features.intro } : {}), columns: spec.features.columns ?? 3, items: spec.features.items } },
    ...spec.how.map((h, i) => howBlock(`${k}-how-${i + 1}`, h)),
    faqBlock(`${k}-faq`, spec.faqHeading ?? `Questions about ${spec.name}`, spec.faq),
    related(`${k}-related`, spec.relatedHeading ?? "Works with", spec.related),
    ctaBlock(`${k}-cta`, spec.cta),
  ];
  return { slug: spec.slug, document: { title: spec.name, seo: { title: spec.seo.title, description: spec.seo.description, keywords: [...spec.seo.keywords] }, blocks } };
}

// ─── A solution page ─────────────────────────────────────────────────────────────────────────────

export type SolutionSpec = {
  slug: string;
  name: string;
  seo: Seo;
  eyebrow: string;
  h1: string;
  lead: string;
  heroPreview?: PreviewKind;
  answer: { question: string; answer: string; more?: RichInline[] };
  /** The reader's problems, each as a problem (the title) and how the product handles it (the body). */
  problems: { heading: string; intro?: string; items: Feature[] };
  modules: { heading: string; intro: string; groups: { title: string; paths: string[] }[] };
  workflow: How;
  faqHeading: string;
  faq: Faq[];
  related: string[];
  cta?: { heading: string; body: string };
};

export function solutionPage(spec: SolutionSpec): SeedPage {
  const k = key(spec.slug);
  const blocks: SiteBlock[] = [
    hero(`${k}-hero`, spec.eyebrow, spec.h1, spec.lead, spec.heroPreview),
    { id: `${k}-answer`, type: "richText", props: { heading: spec.answer.question, content: [p(spec.answer.answer), ...(spec.answer.more ?? []).map((m) => p(m))] } },
    { id: `${k}-problems`, type: "featureGrid", props: { heading: spec.problems.heading, ...(spec.problems.intro ? { intro: spec.problems.intro } : {}), columns: 2, items: spec.problems.items } },
    {
      id: `${k}-modules`,
      type: "moduleHighlights",
      props: {
        heading: spec.modules.heading,
        intro: spec.modules.intro,
        groups: spec.modules.groups.map((g) => ({ title: g.title, items: g.paths.map((path) => ({ label: byPath(path).label, href: path, description: byPath(path).summary })) })),
      },
    },
    howBlock(`${k}-workflow`, spec.workflow),
    faqBlock(`${k}-faq`, spec.faqHeading, spec.faq),
    related(`${k}-related`, "Related pages", spec.related),
    ctaBlock(`${k}-cta`, spec.cta),
  ];
  return { slug: spec.slug, document: { title: spec.name, seo: { title: spec.seo.title, description: spec.seo.description, keywords: [...spec.seo.keywords] }, blocks } };
}

// ─── A hub ───────────────────────────────────────────────────────────────────────────────────────

export type HubSpec = {
  slug: string;
  name: string;
  seo: Seo;
  eyebrow: string;
  h1: string;
  intro: string;
  map: { heading: string; intro: string; groups: CatalogGroup[] };
  extra?: SiteBlock[];
  /** The other hubs, as cards under the map. */
  related?: string[];
  cta?: { heading: string; body: string };
};

export function hubPage(spec: HubSpec): SeedPage {
  const k = key(spec.slug);
  const blocks: SiteBlock[] = [
    { id: `${k}-header`, type: "pageHeader", props: { eyebrow: spec.eyebrow, heading: spec.h1, intro: spec.intro } },
    pageMap(`${k}-map`, spec.map.heading, spec.map.intro, spec.map.groups),
    ...(spec.extra ?? []),
    ...(spec.related?.length ? [related(`${k}-related`, "Also on this site", spec.related)] : []),
    ctaBlock(`${k}-cta`, spec.cta),
  ];
  return { slug: spec.slug, document: { title: spec.name, seo: { title: spec.seo.title, description: spec.seo.description, keywords: [...spec.seo.keywords] }, blocks } };
}
