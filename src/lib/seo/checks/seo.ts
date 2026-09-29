import { figures } from "@/lib/seo/checks/facts";
import {
  ALL_KINDS,
  bodyField,
  CONTENT_KINDS,
  descriptionFieldName,
  fail,
  headingProblems,
  info,
  isArchive,
  isExcluded,
  isForm,
  isRedirected,
  notApplicable,
  pass,
  seoField,
  seoPlace,
  titleFieldName,
  warn,
} from "@/lib/seo/checks/util";
import { analyseKeyword, keywordProblems, stuffedKeywords, uniqueKeywords } from "@/lib/seo/keywords";
import { istDay, plural, quote, share, significantWords, squash, stem, tokenize } from "@/lib/seo/text";
import type { CheckDef, JsonLd, SeoEntityKind, SeoInput } from "@/lib/seo/types";

/**
 * The SEO checks: metadata, content, address, sharing, technical, structured data and keywords.
 * One object per check — adding a check is adding an object here. Each says specifically what it
 * found and what to do, and points at the editor field where there is one.
 */

export const TITLE_RANGE = { min: 30, max: 60 } as const;
export const DESCRIPTION_RANGE = { min: 70, max: 160 } as const;
/** Words a page needs to cover its topic, by kind. Archives are judged on their description instead. */
export const MIN_WORDS: Partial<Record<SeoEntityKind, number>> = { post: 300, page: 150, home: 150 };
export const ARCHIVE_DESCRIPTION_MIN_WORDS = 20;
/** Past this many words a page wants H2 sections. */
export const SECTION_WORDS = 300;

/** The JSON-LD types each kind should carry (owner decision S-D1). */
export const EXPECTED_LD: Record<SeoEntityKind, string[]> = {
  home: ["Organization", "WebSite"],
  page: ["WebPage", "BreadcrumbList"],
  post: ["BlogPosting", "BreadcrumbList"],
  category: ["CollectionPage", "BreadcrumbList"],
  tag: ["CollectionPage", "BreadcrumbList"],
  "blog-index": [],
};

const norm = (s: string) => squash(s).toLowerCase();
const len = (s: string) => [...s].length;
const noun = (input: SeoInput) => (input.kind === "post" ? "post" : input.kind === "category" ? "category" : input.kind === "tag" ? "tag" : "page");

const BLOG_INDEX_FIXED = "The blog index's title and description are fixed in code.";
const BLOG_INDEX_HONEST = "The CMS changes the posts it lists, not its title or description — those are in the site's code (src/app/platform-site/blog/page.tsx).";

const GENERIC_TITLES: ReadonlySet<string> = new Set(["home", "homepage", "home page", "untitled", "page", "new page", "welcome", "index", "post", "new post", "blog post", "draft", "test"]);
const VAGUE_ANCHOR = /^(click here|here|read more|more|learn more|see more|this link|link|this page|go|continue|details|info)$/i;

/** robots.txt's disallow rules are prefixes. */
export const robotsBlocked = (input: SeoInput): string | null => input.site.robotsDisallow.find((p) => p && input.path.startsWith(p)) ?? null;

/** Why the sitemap leaves a live, indexable entity out — null when it is listed (mirrors src/app/sitemap.ts). */
export function sitemapExclusion(input: SeoInput): "not-live" | "noindex" | "redirected" | "no-posts" | "later-page" | null {
  if (!input.live) return "not-live";
  if (isExcluded(input)) return "noindex";
  // The blog is listed once any post is live; an archive is live only while it has a post, so it always has one here.
  if (input.kind === "blog-index" && input.site.livePostCount === 0) return "no-posts";
  if (input.archive && input.archive.page > 1) return "later-page";
  if (isRedirected(input)) return "redirected";
  return null;
}

/** The site's sitemap would list it. */
export const inSitemap = (input: SeoInput): boolean => sitemapExclusion(input) === null;

/** The canonical as a site path: an absolute one on this site's origin loses the origin. */
function canonicalPath(input: SeoInput): string | null {
  const c = input.meta.canonical;
  if (!c) return null;
  const origin = input.site.origin;
  return origin && c.startsWith(`${origin}/`) ? c.slice(origin.length) : c;
}

const hasType = (ld: JsonLd[], type: string) => ld.some((o) => o["@type"] === type);

function keywordAnalysis(input: SeoInput, which: "first" | "all") {
  const kws = uniqueKeywords(input.keywords);
  return (which === "first" ? kws.slice(0, 1) : kws).map((k) => analyseKeyword(input, k));
}

export const SEO_CHECKS: readonly CheckDef[] = [
  // ─── Metadata ──────────────────────────────────────────────────────────────────────────────────
  {
    id: "seo.title.present",
    label: "SEO title",
    category: "seo",
    group: "metadata",
    weight: 10,
    applicableTo: ALL_KINDS,
    evaluate(input, w) {
      if (input.kind === "blog-index") return info(`${BLOG_INDEX_FIXED} Its title is ${quote(input.meta.title)}.`, BLOG_INDEX_HONEST);
      const m = input.meta;
      const field = seoField(input, "title");
      if (!m.rawTitle.trim()) {
        return fail(
          `No title: the browser tab and search results would show only ${m.title.trim() ? quote(m.title) : "the address"}.`,
          `Write a title in ${titleFieldName(input)} (${seoPlace(input)}).`,
          { field, severity: "critical" },
        );
      }
      if (m.titleSource === "fallback") return pass(w, `No SEO title of its own: the site uses the ${input.kind === "post" ? "post's title" : "name"}, ${quote(m.rawTitle)}.`, { field });
      return pass(w, `Title: ${quote(m.title, 90)}.`, { field });
    },
  },
  {
    id: "seo.title.length",
    label: "Title length",
    category: "seo",
    group: "metadata",
    weight: 6,
    applicableTo: ALL_KINDS,
    evaluate(input, w) {
      if (input.kind === "blog-index") return info(`${BLOG_INDEX_FIXED} ${quote(input.meta.title)} is ${len(input.meta.title)} characters.`, BLOG_INDEX_HONEST);
      const m = input.meta;
      if (!m.rawTitle.trim()) return notApplicable("No title to measure.");
      const field = seoField(input, "title");
      const n = len(m.title.trim());
      if (n >= TITLE_RANGE.min && n <= TITLE_RANGE.max) return pass(w, `The title is ${n} characters, within ${TITLE_RANGE.min}–${TITLE_RANGE.max}.`, { field });
      const over = n > TITLE_RANGE.max;
      const distance = over ? n - TITLE_RANGE.max : TITLE_RANGE.min - n;
      const earned = distance <= 10 ? share(w, 0.5) : 0;
      const addition = m.templateAddition.trim();
      if (over) {
        const room = Math.max(10, TITLE_RANGE.max - len(m.templateAddition));
        return warn(
          earned,
          `The title is ${n} characters: ${quote(m.title, 90)}. Search results show about ${TITLE_RANGE.max}.`,
          `Shorten ${titleFieldName(input)} to about ${room} characters${addition ? ` — the site adds “${addition}” after it` : ""}.`,
          { field },
        );
      }
      return warn(
        earned,
        `The title is only ${n} characters: ${quote(m.title)}.`,
        `Say more in ${titleFieldName(input)}: what the ${noun(input)} offers, with keyword 1 — ${TITLE_RANGE.min}–${TITLE_RANGE.max} characters in all${addition ? `, “${addition}” included` : ""}.`,
        { field },
      );
    },
  },
  {
    id: "seo.title.unique",
    label: "Unique, descriptive title",
    category: "seo",
    group: "metadata",
    weight: 5,
    applicableTo: ALL_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      if (input.kind === "blog-index") return info(BLOG_INDEX_FIXED, BLOG_INDEX_HONEST);
      const m = input.meta;
      const raw = norm(m.rawTitle);
      if (!raw) return notApplicable("No title to compare.");
      const field = seoField(input, "title");
      const dup = input.site.others.find((o) => o.id !== input.id && o.path !== input.path && norm(o.title) === norm(m.title));
      if (dup) return fail(`${quote(m.title)} is also the title of ${dup.path}.`, `Make ${titleFieldName(input)} say what is particular to this ${noun(input)}, so search results can tell the two apart.`, { field });
      if (GENERIC_TITLES.has(raw) || raw === norm(input.site.siteName) || raw === norm(input.site.defaultTitle)) {
        return warn(share(w, 0.5), `The title is just ${quote(m.rawTitle)} — it names the site or a generic page, not what this ${noun(input)} is about.`, `Describe this ${noun(input)} in ${titleFieldName(input)}: its topic, with keyword 1.`, { field });
      }
      return pass(w, "No other page on the site has this title, and it says more than the site's name.", { field });
    },
  },
  {
    id: "seo.description.present",
    label: "Meta description",
    category: "seo",
    group: "metadata",
    weight: 10,
    applicableTo: ALL_KINDS,
    evaluate(input, w) {
      if (input.kind === "blog-index") return info(`${BLOG_INDEX_FIXED} Its description is ${quote(input.meta.description, 90)}.`, BLOG_INDEX_HONEST);
      const m = input.meta;
      const field = seoField(input, "description");
      if (!m.description.trim()) {
        if (input.kind === "post") {
          return fail("No meta description: the post has neither a description nor an excerpt, so search engines pick text from it themselves.", "Write one or two sentences in “Description” (Address, SEO & author), or give the post an excerpt.", {
            field,
            severity: "critical",
          });
        }
        return fail("No meta description: search engines pick text from the page themselves.", `Write one or two sentences in ${descriptionFieldName(input)} (${seoPlace(input)}).`, { field, severity: "critical" });
      }
      if (m.descriptionSource === "fallback") {
        const from = input.kind === "post" ? "excerpt" : `${noun(input)}'s description`;
        return pass(w, `No description of its own: the site uses the ${from}, ${quote(m.description, 90)}.`, { field });
      }
      if (m.descriptionSource === "generated") {
        return warn(share(w, 0.5), `No description of its own: the site writes ${quote(m.description, 90)}, which says nothing particular about it.`, `Write a description in ${descriptionFieldName(input)}, or give the ${noun(input)} a description of its own.`, {
          field,
        });
      }
      return pass(w, `Description: ${quote(m.description, 90)}.`, { field });
    },
  },
  {
    id: "seo.description.length",
    label: "Description length",
    category: "seo",
    group: "metadata",
    weight: 5,
    applicableTo: ALL_KINDS,
    evaluate(input, w) {
      if (input.kind === "blog-index") return info(BLOG_INDEX_FIXED, BLOG_INDEX_HONEST);
      const d = squash(input.meta.description);
      if (!d) return notApplicable("No description to measure.");
      const field = seoField(input, "description");
      const n = len(d);
      const { min, max } = DESCRIPTION_RANGE;
      if (n >= min && n <= max) return pass(w, `The description is ${n} characters, within ${min}–${max}.`, { field });
      const distance = n > max ? n - max : min - n;
      const earned = distance <= 20 ? share(w, 0.5) : 0;
      if (n > max) {
        const hidden = [...d].slice(max - 3).join("");
        return warn(earned, `The description is ${n} characters; search results cut it at about ${max}, so ${quote(hidden, 50)} won't show.`, `Tighten ${descriptionFieldName(input)} to ${max} characters, the point first.`, { field });
      }
      return warn(earned, `The description is only ${n} characters: ${quote(d)}.`, `Expand ${descriptionFieldName(input)} to ${min}–${max} characters: what the reader gets from this ${noun(input)}, with a keyword.`, { field });
    },
  },
  {
    id: "seo.canonical",
    label: "Canonical address",
    category: "seo",
    group: "metadata",
    weight: 4,
    applicableTo: ALL_KINDS,
    evaluate(input, w) {
      const expected = input.archive && input.archive.page > 1 ? `${input.path}?page=${input.archive.page}` : input.path;
      const c = canonicalPath(input);
      if (!c) return fail("No canonical address.", "The site sets one for every page; its absence means this page's metadata is broken — tell a developer.");
      if (!c.startsWith("/") || c.startsWith("//")) return fail(`The canonical ${quote(c)} is not an address on this site.`, "The canonical must be this page's own address on the site — tell a developer.");
      if (c !== expected) return warn(0, `The canonical is ${c}, not this page's own address, ${expected}.`, "A page that should be found at its own address must name itself as canonical — tell a developer.");
      if (input.archive && input.archive.page > 1) return pass(w, `Canonical: ${c} — a later page of the archive is a page of its own.`);
      return pass(w, `Canonical: ${c}.`);
    },
  },
  {
    id: "seo.robots",
    label: "Robots meta tag",
    category: "seo",
    group: "metadata",
    weight: 3,
    applicableTo: ALL_KINDS,
    evaluate(input, w) {
      const r = input.meta.robots;
      const field = seoField(input, "noindex");
      if (!r.index) {
        return info("Intentionally excluded from search: the page carries noindex.", field ? `Nothing to do. To have it found, untick “Keep this ${noun(input)} out of search engines” (${seoPlace(input)}).` : "", { field });
      }
      if (!r.follow) return warn(share(w, 0.5), "Search engines may index this page but are told not to follow its links.", "Let them follow links: a page that is indexed should pass its links on — tell a developer.");
      return pass(w, "Search engines may index this page and follow its links.");
    },
  },

  // ─── Content ───────────────────────────────────────────────────────────────────────────────────
  {
    id: "seo.h1",
    label: "One H1",
    category: "seo",
    group: "content",
    weight: 8,
    applicableTo: ALL_KINDS,
    evaluate(input, w) {
      const h1s = input.content.headings.filter((h) => h.level === 1);
      if (!h1s.length) {
        const recommendation =
          input.kind === "post" ? "Give the post a title — it is the page's H1." : isArchive(input) ? `Give the ${noun(input)} a name — it is the archive's H1.` : "Add a Page header or Hero block at the top: its heading becomes the page's H1.";
        return fail("No H1: no main heading says what the page is.", recommendation, { field: input.kind === "post" ? "title" : isArchive(input) ? "name" : "blocks", severity: "critical" });
      }
      if (h1s.length > 1) {
        return warn(share(w, 0.5), `${h1s.length} H1s: ${h1s.map((h) => quote(h.text, 40)).join(", ")}.`, "Keep one Hero, Page header or Signup form block; put the rest in sections with an H2 heading.", {
          field: h1s[1].field ?? undefined,
        });
      }
      return pass(w, `One H1: ${quote(h1s[0].text)}.`, { field: h1s[0].field ?? undefined });
    },
  },
  {
    id: "seo.headings.hierarchy",
    label: "Heading order",
    category: "seo",
    group: "content",
    weight: 4,
    applicableTo: ALL_KINDS,
    evaluate(input, w) {
      if (input.content.headings.length < 2) return notApplicable("Too few headings to form a ladder.");
      const problems = headingProblems(input);
      if (!problems.length) return pass(w, "Headings step down in order: H1, then H2 sections, then H3s within them.");
      return warn(
        share(w, 1 - 0.5 * problems.length),
        `${problems[0].message}${problems.length > 1 ? ` (and ${plural(problems.length - 1, "more place")})` : ""}`,
        "Add an H2 section heading above it, or make it an H2 — a Rich text heading's level, or a section's heading.",
        { field: problems[0].field ?? undefined },
      );
    },
  },
  {
    id: "seo.headings.h2",
    label: "H2 sections",
    category: "seo",
    group: "content",
    weight: 3,
    applicableTo: CONTENT_KINDS,
    evaluate(input, w) {
      if (isForm(input)) return notApplicable("A form page, not an article.");
      const words = input.content.wordCount;
      if (words <= SECTION_WORDS) return notApplicable(`Short pages (${words} words) don't need sections.`);
      const h2 = input.content.headings.filter((h) => h.level === 2).length;
      if (h2) return pass(w, `${plural(h2, "H2 section")} for ${words} words.`);
      return warn(0, `${words} words and no H2 headings.`, "Break the text into sections, each under an H2 that says what it covers (a Rich text block's heading, or a section heading).", { field: bodyField(input) });
    },
  },
  {
    id: "seo.content.length",
    label: "Enough text",
    category: "seo",
    group: "content",
    weight: 8,
    applicableTo: ALL_KINDS,
    evaluate(input, w) {
      if (input.kind === "blog-index") return info("The blog index's own words are fixed in code; the posts it lists are its content.", BLOG_INDEX_HONEST);
      if (isForm(input)) return notApplicable("A form page, not an article: its length doesn't matter.");
      if (isArchive(input)) {
        const d = input.content.paragraphs.find((p) => p.field === "description");
        const words = d?.words ?? 0;
        const min = ARCHIVE_DESCRIPTION_MIN_WORDS;
        if (words >= min) return pass(w, `The ${noun(input)}'s description runs ${words} words.`, { field: "description" });
        if (words > 0) {
          return warn(share(w, words / min), `The ${noun(input)}'s description is only ${words} words — the only text on the archive besides its list of posts.`, `Expand the ${noun(input)}'s description to a few sentences on what its posts cover.`, {
            field: "description",
          });
        }
        return warn(0, `The ${noun(input)} has no description, so its archive is only a list of posts.`, `Give the ${noun(input)} a description: a few sentences on what its posts cover.`, { field: "description" });
      }
      const min = MIN_WORDS[input.kind] ?? 150;
      const words = input.content.wordCount;
      const field = bodyField(input);
      if (words === 0) return fail("No text at all.", input.kind === "post" ? "Write the post's body." : "Add blocks with text.", { field, severity: "critical" });
      if (words >= min) return pass(w, `${words} words (at least ${min} for a ${noun(input)}).`);
      return warn(share(w, words / min), `Only ${words} words; a ${noun(input)} needs about ${min} to cover its topic.`, `Add about ${min - words} words: what the reader should know, in sections under H2 headings.`, { field });
    },
  },
  {
    id: "seo.links.internal",
    label: "Internal links",
    category: "seo",
    group: "content",
    weight: 4,
    applicableTo: CONTENT_KINDS,
    evaluate(input, w) {
      if (isForm(input)) return notApplicable("A form page.");
      const internal = input.content.links.filter((l) => l.internal && !l.href.startsWith("#"));
      if (internal.length) return pass(w, `${plural(internal.length, "link")} to other pages on the site.`);
      return warn(
        0,
        "No links to other pages on the site.",
        input.kind === "post" ? "Link to a related post or page from the text: select words in a paragraph and add a link, e.g. to /pricing." : "Link to a related page — a button in a section, or a link in text.",
        { field: bodyField(input) },
      );
    },
  },
  {
    id: "seo.links.external",
    label: "Sources linked",
    category: "seo",
    group: "content",
    weight: 2,
    applicableTo: CONTENT_KINDS,
    evaluate(input, w) {
      const external = input.content.links.filter((l) => /^https?:/i.test(l.href));
      if (input.kind !== "post") return info(external.length ? `${plural(external.length, "link")} to other sites.` : "No links to other sites — fine for a page like this.");
      if (external.length) return pass(w, `${plural(external.length, "link")} to other sites.`);
      const stats = figures(input).filter((f) => f.citeWorthy);
      if (stats.length) {
        return warn(0, `The post cites figures — ${quote(stats[0].sentence)} — but links to no source.`, "Link each figure to where it comes from: select its words and add the source's address.", {
          field: stats[0].field ?? undefined,
        });
      }
      return pass(w, "No figures that need a source.");
    },
  },
  {
    id: "seo.links.anchor-text",
    label: "Descriptive link text",
    category: "seo",
    group: "content",
    weight: 3,
    applicableTo: CONTENT_KINDS,
    evaluate(input, w) {
      const links = input.content.links.filter((l) => l.label);
      if (!links.length) return notApplicable("No links with text.");
      const bare = (l: { label: string; href: string }) => /^(https?:\/\/|www\.)/i.test(l.label) || l.label === l.href;
      const vague = links.filter((l) => VAGUE_ANCHOR.test(l.label.replace(/[\s.…:→›»]+$/u, "")) || bare(l));
      if (!vague.length) return pass(w, `Every link's text says where it goes (${plural(links.length, "link")}).`);
      const first = vague[0];
      return warn(
        share(w, 1 - vague.length / links.length),
        `${plural(vague.length, "link")} with text that doesn't say where it goes, e.g. ${quote(first.label)}.`,
        `Use words that name the destination — “See pricing plans” rather than ${quote(first.label)}.`,
        { field: first.field ?? undefined },
      );
    },
  },
  {
    id: "seo.images.alt",
    label: "Image alt text",
    category: "seo",
    group: "content",
    weight: 5,
    applicableTo: ALL_KINDS,
    evaluate(input, w) {
      const images = input.content.images.filter((i) => !i.decorative);
      if (!images.length) return notApplicable("No images.");
      const missing = images.filter((i) => !i.alt);
      if (!missing.length) return pass(w, `${images.length === 1 ? "The image has" : `All ${images.length} images have`} alt text.`);
      const first = missing[0];
      const recommendation = first.library ? "Add alt text to the image in the media library: say what it shows." : "Describe the image in the block's alt text: what it shows, in a sentence.";
      const field = first.field ?? undefined;
      if (missing.length === images.length) return fail(`${images.length === 1 ? "The image has" : `None of the ${images.length} images has`} alt text.`, recommendation, { field });
      return warn(share(w, 1 - missing.length / images.length), `${missing.length} of ${images.length} images have no alt text.`, recommendation, { field });
    },
  },
  {
    id: "seo.images.alt-duplicate",
    label: "Distinct alt text",
    category: "seo",
    group: "content",
    weight: 2,
    applicableTo: ALL_KINDS,
    evaluate(input, w) {
      const images = input.content.images.filter((i) => !i.decorative && i.alt);
      if (images.length < 2) return notApplicable("Fewer than two images with alt text.");
      const bySrc = new Map<string, Set<string>>();
      for (const i of images) {
        const key = norm(i.alt);
        const set = bySrc.get(key) ?? new Set<string>();
        set.add(i.src);
        bySrc.set(key, set);
      }
      const dup = images.find((i) => (bySrc.get(norm(i.alt))?.size ?? 0) > 1);
      if (!dup) return pass(w, "Each image's alt text is its own.");
      return warn(0, `${bySrc.get(norm(dup.alt))!.size} different images share the alt text ${quote(dup.alt)}.`, "Give each image alt text that says what it, in particular, shows.", { field: dup.field ?? undefined });
    },
  },
  {
    id: "seo.images.alt-filename",
    label: "Alt text is not a file name",
    category: "seo",
    group: "content",
    weight: 2,
    applicableTo: ALL_KINDS,
    evaluate(input, w) {
      const images = input.content.images.filter((i) => !i.decorative && i.alt);
      if (!images.length) return notApplicable("No images with alt text.");
      const looksLikeFile = (alt: string) =>
        /\.(png|jpe?g|gif|webp|svg|avif|bmp|tiff?|heic)$/i.test(alt) || /^(img|image|dsc|dscn|pxl|screenshot|screen shot|photo|pic|picture|untitled)[\s_-]*\d*$/i.test(alt) || (!/\s/.test(alt) && /[_-]/.test(alt) && /\d/.test(alt));
      const bad = images.find((i) => looksLikeFile(i.alt));
      if (!bad) return pass(w, "No alt text is a file name.");
      return warn(0, `The alt text ${quote(bad.alt)} is a file name, not a description.`, bad.library ? "Replace it in the media library with a sentence about what the image shows." : "Replace it with a sentence about what the image shows.", {
        field: bad.field ?? undefined,
      });
    },
  },

  // ─── Address ───────────────────────────────────────────────────────────────────────────────────
  {
    id: "seo.url.readable",
    label: "Readable address",
    category: "seo",
    group: "url",
    weight: 4,
    applicableTo: ALL_KINDS,
    evaluate(input, w) {
      if (input.kind === "home") return pass(w, "The home page is at /.");
      if (input.isBuiltin) return pass(w, `${input.path}: a short, fixed address.`);
      const words = input.slug.split(/[-/]+/).filter(Boolean).length;
      const n = input.path.length;
      if (n <= 75 && words <= 5) return pass(w, `${input.path}: ${plural(words, "word")}.`, { field: "slug" });
      const recommendation = "Shorten the slug to the 3–5 words that name the topic, e.g. keyword 1. Changing a live address leaves a redirect behind automatically.";
      const message = `The address ${input.path} runs ${plural(words, "word")}${n > 75 ? ` and ${n} characters` : ""}.`;
      return warn(n <= 100 && words <= 8 ? share(w, 0.5) : 0, message, recommendation, { field: "slug" });
    },
  },
  {
    id: "seo.url.keyword",
    label: "Keyword in the address",
    category: "seo",
    group: "url",
    weight: 2,
    applicableTo: ALL_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      if (input.kind === "home" || input.isBuiltin) return notApplicable("The address of a built-in page is fixed.");
      const kws = uniqueKeywords(input.keywords);
      if (!kws.length) return notApplicable("No primary keywords yet.");
      const slugWords = new Set(tokenize(input.slug).map(stem));
      let best = { keyword: kws[0], share: 0 };
      for (const k of kws) {
        const words = [...significantWords(k)];
        const found = words.length ? words.filter((x) => slugWords.has(x)).length / words.length : 0;
        if (found > best.share) best = { keyword: k, share: found };
      }
      if (best.share === 1) return pass(w, `The address contains ${quote(best.keyword)}.`, { field: "slug" });
      const suggestion = tokenize(kws[0]).join("-");
      const recommendation = `Put keyword 1's words in the slug, e.g. “${suggestion}”. Changing a live address leaves a redirect behind automatically.`;
      if (best.share > 0) return warn(share(w, 0.5), `The address ${input.path} has only part of ${quote(best.keyword)}.`, recommendation, { field: "slug" });
      return warn(0, `No keyword's words are in the address ${input.path}.`, recommendation, { field: "slug" });
    },
  },
  {
    id: "seo.url.valid",
    label: "Well-formed address",
    category: "seo",
    group: "url",
    weight: 2,
    applicableTo: ALL_KINDS,
    evaluate(input, w) {
      const p = input.path;
      if (p === "/") return pass(w, "The home page is at /.");
      const problem = /[A-Z]/.test(p)
        ? "has capital letters"
        : /_/.test(p)
          ? "has underscores"
          : /--/.test(p)
            ? "has a double hyphen"
            : /(^|\/)-|-($|\/)/.test(p)
              ? "starts or ends a word with a hyphen"
              : /\/\//.test(p)
                ? "has an empty segment"
                : p.length > 1 && p.endsWith("/")
                  ? "ends with a slash"
                  : /\.[a-z0-9]{2,4}$/i.test(p)
                    ? "ends like a file name"
                    : /[^a-z0-9\-/]/.test(p)
                      ? "has characters other than letters, digits and hyphens"
                      : null;
      if (!problem) return pass(w, "Lower-case words and hyphens only.");
      return fail(`The address ${p} ${problem}.`, "Use lower-case words and hyphens only, like spring-update.", { field: seoField(input, "slug") });
    },
  },

  // ─── Sharing ───────────────────────────────────────────────────────────────────────────────────
  {
    id: "seo.og.title",
    label: "Title when shared",
    category: "seo",
    group: "social",
    weight: 2,
    applicableTo: ALL_KINDS,
    evaluate(input, w) {
      const t = squash(input.meta.ogTitle);
      if (!t) return warn(0, "No title when shared: link previews show the address instead.", `Write a title in ${titleFieldName(input)}.`, { field: seoField(input, "title") });
      const own = norm(t) !== norm(input.meta.rawTitle) && norm(t) !== norm(input.meta.title);
      return pass(w, `Shared as ${quote(t)}${own ? "" : " (the page's title)"}.`, { field: seoField(input, own ? "ogTitle" : "title") });
    },
  },
  {
    id: "seo.og.description",
    label: "Description when shared",
    category: "seo",
    group: "social",
    weight: 2,
    applicableTo: ALL_KINDS,
    evaluate(input, w) {
      const d = squash(input.meta.ogDescription);
      if (!d) {
        return warn(0, "No description when shared: link previews show only the title.", input.kind === "post" ? "Write a description, or give the post an excerpt." : `Write a description in ${descriptionFieldName(input)}.`, {
          field: seoField(input, "description"),
        });
      }
      return pass(w, `Shared with the description ${quote(d, 60)}.`);
    },
  },
  {
    id: "seo.og.image",
    label: "Image when shared",
    category: "seo",
    group: "social",
    weight: 3,
    applicableTo: ALL_KINDS,
    evaluate(input, w) {
      const m = input.meta;
      const field = seoField(input, "ogImage");
      switch (m.ogImageSource) {
        case "own":
          return pass(w, "Shared with an image of its own.", { field });
        case "cover":
          return pass(w, "Shared with the post's cover image.", { field: "coverMediaId" });
        case "site":
          return info("Shared with the site's default image.", `Choose an image for this ${noun(input)} in “Image when shared” (${seoPlace(input)}) so its link previews stand out.`, { field });
        case "fixed":
          return info(m.ogImage ? "The blog index's sharing card is fixed in code." : "The blog index's sharing card is fixed in code and has no image.", BLOG_INDEX_HONEST);
        default: {
          const recommendation =
            input.kind === "post"
              ? "Give the post a cover image, or choose one in “Image when shared”."
              : isArchive(input)
                ? `Choose an image in ${seoPlace(input)}, or set the site's default sharing image in Settings.`
                : "Choose one in “Image when shared”, or set the site's default sharing image in Settings.";
          return warn(0, "No image when shared: link previews on LinkedIn, WhatsApp or X are text only.", recommendation, { field });
        }
      }
    },
  },
  {
    id: "seo.twitter.card",
    label: "X (Twitter) card",
    category: "seo",
    group: "social",
    weight: 1,
    applicableTo: ALL_KINDS,
    evaluate(input, w) {
      const card = input.meta.twitterCard;
      if (!card) return warn(0, "No X (Twitter) card.", "The site sets one on every page; its absence means the page's metadata is broken — tell a developer.");
      return pass(w, `X card: ${card === "summary_large_image" ? "large image" : "summary"}.`);
    },
  },

  // ─── Technical ─────────────────────────────────────────────────────────────────────────────────
  {
    id: "seo.indexable",
    label: "Indexable",
    category: "seo",
    group: "technical",
    weight: 6,
    applicableTo: ALL_KINDS,
    evaluate(input, w) {
      if (isExcluded(input)) return info("Intentionally excluded from search engines (noindex).", "", { field: seoField(input, "noindex") });
      if (!input.live) {
        if (input.status === "scheduled" && input.editorial.publishedAt) return info(`Scheduled: not on the site until ${istDay(input.editorial.publishedAt)}.`);
        return info("Not on the site yet: scored as it would be once published.");
      }
      return pass(w, "On the site, and search engines may index it.");
    },
  },
  {
    id: "seo.sitemap",
    label: "In the sitemap",
    category: "seo",
    group: "technical",
    weight: 3,
    applicableTo: ALL_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      switch (sitemapExclusion(input)) {
        case null:
          return pass(w, `${input.path} is listed in the sitemap.`);
        case "not-live":
          return notApplicable("Not on the site, so not in the sitemap yet.");
        case "later-page":
          return notApplicable("Only an archive's first page is in the sitemap.");
        case "no-posts":
          return info("The sitemap lists the blog and its archives once a post is live.");
        case "redirected":
          return warn(0, `An enabled redirect sends ${input.path} elsewhere, so the sitemap leaves it out.`, "Switch the redirect off in Redirects if this page should be found at its address.");
        default:
          return notApplicable("Excluded from search.");
      }
    },
  },
  {
    id: "seo.robots-conflict",
    label: "No indexing conflicts",
    category: "seo",
    group: "technical",
    weight: 5,
    applicableTo: ALL_KINDS,
    evaluate(input, w) {
      const blocked = robotsBlocked(input);
      if (isExcluded(input)) {
        if (blocked) {
          return info(
            `robots.txt also blocks ${blocked}, so crawlers never read this page's noindex; it can still be listed by its address alone if other sites link to it.`,
            "Nothing the CMS changes: robots.txt is in the site's code.",
          );
        }
        return pass(w, "No conflicts: excluded from search and left out of the sitemap.");
      }
      if (blocked) {
        return fail(`robots.txt blocks ${blocked} while the page asks to be indexed, so search engines can't read it.`, "Keep the page out of search engines in its SEO settings, or have a developer allow it in robots.txt.", { severity: "critical" });
      }
      const canonical = canonicalPath(input)?.split("?")[0] ?? null;
      if (canonical && canonical !== input.path) {
        return fail(`The page is indexable, but its canonical points to ${canonical}: search engines are told to index that page instead.`, "A page that should be found must name itself as canonical — tell a developer.", { severity: "critical" });
      }
      if (input.live && isRedirected(input)) {
        return warn(share(w, 0.5), `A redirect sends visitors from ${input.path} elsewhere, so this live ${noun(input)} can't be reached at its own address.`, "Switch the redirect off in Redirects, or unpublish the page.");
      }
      return pass(w, "No conflicts between robots.txt, the robots meta tag, the canonical and the sitemap.");
    },
  },
  {
    id: "seo.status",
    label: "Publishing status",
    category: "seo",
    group: "technical",
    weight: 2,
    applicableTo: ALL_KINDS,
    evaluate(input, w) {
      switch (input.status) {
        case "default":
          return info("Shows its default content: nobody has saved this built-in page in the CMS yet.", "Edit and publish it to change its words, title or description.");
        case "draft":
          return info("A draft: not on the site. The scores show how it would do once published.");
        case "scheduled":
          return input.live ? pass(w, "Scheduled, and its time has come: it is on the site.") : info(input.editorial.publishedAt ? `Scheduled for ${istDay(input.editorial.publishedAt)}.` : "Scheduled.");
        default:
          return input.live ? pass(w, "Published.") : info(input.editorial.publishedAt ? `Published, but not live until ${istDay(input.editorial.publishedAt)}.` : "Published, but not live.");
      }
    },
  },
  {
    id: "seo.structured-data",
    label: "Structured data",
    category: "seo",
    group: "structured-data",
    weight: 5,
    applicableTo: ALL_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      const expected = EXPECTED_LD[input.kind];
      if (!expected.length) return info("The blog index emits no structured data; the posts and archives it lists carry their own.", BLOG_INDEX_HONEST);
      const ld = input.jsonLd;
      if (!ld.length) {
        return fail(
          `No structured data: search engines get no ${expected[0]} JSON-LD for this ${noun(input)}.`,
          input.site.emitsJsonLd ? "Structured data is built from the page's content; if it is missing here, tell a developer." : "A developer change: the site doesn't emit JSON-LD yet — nothing in the CMS turns it on.",
        );
      }
      const missing = expected.filter((t) => !hasType(ld, t));
      if (missing.length) return warn(share(w, 1 - missing.length / expected.length), `Structured data is missing ${missing.join(" and ")}.`, "Tell a developer: the site should emit it for every page of this kind.");
      return pass(w, `Structured data: ${[...new Set(ld.map((o) => o["@type"]))].join(", ")}.`);
    },
  },

  // ─── Keywords ──────────────────────────────────────────────────────────────────────────────────
  {
    id: "seo.keywords.present",
    label: "Primary keywords",
    category: "seo",
    group: "keywords",
    weight: 6,
    applicableTo: ALL_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      if (input.kind === "blog-index") return info("The blog index has no primary keywords: its words are fixed in code.", BLOG_INDEX_HONEST);
      const field = seoField(input, "keywords");
      const kws = input.keywords;
      if (!kws.length) return warn(0, "No primary keywords yet.", "Add up to three primary keywords to get placement analysis", { field });
      const problems = keywordProblems(kws);
      if (problems.length) return warn(share(w, 0.5), problems[0].message, "Make each keyword a different phrase: keyword 1 is what the page is about, 2 and 3 support it.", { field });
      return pass(w, `${plural(kws.length, "primary keyword")}: ${kws.map((k) => quote(k, 40)).join(", ")}.`, { field });
    },
  },
  {
    id: "seo.keyword.title",
    label: "Keyword 1 in the title",
    category: "seo",
    group: "keywords",
    weight: 4,
    applicableTo: ALL_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      const [a] = keywordAnalysis(input, "first");
      if (!a) return notApplicable("No keyword 1 yet.");
      const field = seoField(input, "title");
      if (a.inTitle) return pass(w, `Keyword 1, ${quote(a.keyword)}, is in the title.`, { field });
      return warn(0, `Keyword 1, ${quote(a.keyword)}, is not in the title ${quote(input.meta.title)}.`, `Work “${a.keyword}” into ${titleFieldName(input)}, near the start.`, { field });
    },
  },
  {
    id: "seo.keyword.description",
    label: "Keyword in the description",
    category: "seo",
    group: "keywords",
    weight: 2,
    applicableTo: ALL_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      const all = keywordAnalysis(input, "all");
      if (!all.length) return notApplicable("No primary keywords yet.");
      const field = seoField(input, "description");
      const hit = all.find((a) => a.inDescription);
      if (hit) return pass(w, `The description mentions ${quote(hit.keyword)}.`, { field });
      return warn(0, "No primary keyword is in the description.", `Mention “${all[0].keyword}” in ${descriptionFieldName(input)} — search results bold the words a searcher typed.`, { field });
    },
  },
  {
    id: "seo.keyword.h1",
    label: "Keyword 1 in the H1",
    category: "seo",
    group: "keywords",
    weight: 3,
    applicableTo: ALL_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      const [a] = keywordAnalysis(input, "first");
      if (!a) return notApplicable("No keyword 1 yet.");
      const h1 = input.content.headings.find((h) => h.level === 1);
      if (!h1) return notApplicable("No H1 (see “One H1”).");
      if (a.inH1) return pass(w, `Keyword 1, ${quote(a.keyword)}, is in the H1.`, { field: h1.field ?? undefined });
      return warn(0, `Keyword 1, ${quote(a.keyword)}, is not in the H1 ${quote(h1.text)}.`, `Use “${a.keyword}” in the main heading, if it reads naturally.`, { field: h1.field ?? undefined });
    },
  },
  {
    id: "seo.keyword.first-section",
    label: "Keyword 1 in the opening",
    category: "seo",
    group: "keywords",
    weight: 2,
    applicableTo: ALL_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      const [a] = keywordAnalysis(input, "first");
      if (!a) return notApplicable("No keyword 1 yet.");
      const field = input.content.paragraphs[0]?.field ?? undefined;
      if (!input.content.firstSection) return warn(0, "There's no opening text for keyword 1 to be in.", `Open with a paragraph that says what this ${noun(input)} is about, using “${a.keyword}”.`, { field: bodyField(input) });
      if (a.inFirstSection) return pass(w, `Keyword 1, ${quote(a.keyword)}, is in the opening text.`, { field });
      return warn(0, `Keyword 1, ${quote(a.keyword)}, is not in the first 100 words.`, `Mention “${a.keyword}” in the opening paragraph.`, { field });
    },
  },
  {
    id: "seo.keyword.body",
    label: "Keyword 1 in the text",
    category: "seo",
    group: "keywords",
    weight: 2,
    applicableTo: ALL_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      const [a] = keywordAnalysis(input, "first");
      if (!a) return notApplicable("No keyword 1 yet.");
      if (a.inBody) return pass(w, `Keyword 1, ${quote(a.keyword)}, appears ${plural(a.occurrences, "time")} (${a.density}% of the words).`);
      return warn(0, `Keyword 1, ${quote(a.keyword)}, is not in the text.`, `Use “${a.keyword}” where it fits in the body — a paragraph that explains it.`, { field: bodyField(input) });
    },
  },
  {
    id: "seo.keywords.secondary",
    label: "Keywords 2 and 3 used",
    category: "seo",
    group: "keywords",
    weight: 2,
    applicableTo: ALL_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      const rest = keywordAnalysis(input, "all").slice(1);
      if (!rest.length) return notApplicable("No keyword 2 or 3.");
      const used = rest.filter((a) => a.inTitle || a.inDescription || a.inH1 || a.inHeadings || a.inBody || a.inFirstSection);
      if (used.length === rest.length) return pass(w, `${rest.map((a) => quote(a.keyword)).join(" and ")} appear on the page.`);
      const missing = rest.find((a) => !used.includes(a))!;
      return warn(share(w, used.length / rest.length), `${quote(missing.keyword)} appears nowhere on the page.`, `Use “${missing.keyword}” in a section heading or a paragraph, or replace it with a keyword the page is about.`, {
        field: seoField(input, "keywords"),
      });
    },
  },
  {
    id: "seo.keyword.stuffing",
    label: "No keyword stuffing",
    category: "seo",
    group: "keywords",
    weight: 4,
    applicableTo: ALL_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      if (!uniqueKeywords(input.keywords).length) return notApplicable("No primary keywords yet.");
      const stuffed = stuffedKeywords(input);
      if (!stuffed.length) return pass(w, "The keywords are used at a natural rate.");
      const s = stuffed[0];
      const inTitle = s.reason.includes("title");
      return warn(0, `${quote(s.keyword)} looks stuffed: ${s.reason}.`, "Use it where it reads naturally — once in the title, the H1 and the opening — and vary the wording elsewhere. Repetition can count against a page.", {
        field: inTitle ? seoField(input, "title") : bodyField(input),
      });
    },
  },
  {
    id: "seo.keywords.meta-tag",
    label: "Keywords meta tag",
    category: "seo",
    group: "keywords",
    weight: 0,
    applicableTo: ALL_KINDS,
    evaluate(input) {
      if (!input.meta.keywords.length) return notApplicable("No keywords meta tag (the page has no primary keywords).");
      return info(`The keywords meta tag lists ${input.meta.keywords.map((k) => quote(k, 40)).join(", ")}.`, "Emitted for completeness only: search engines ignore it, so it earns no points.");
    },
  },
];
