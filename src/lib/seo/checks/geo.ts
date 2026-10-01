import { figures, unsupportedClaims } from "@/lib/seo/checks/facts";
import { EXPECTED_LD } from "@/lib/seo/checks/seo";
import {
  ALL_KINDS,
  answerUnder,
  bodyField,
  CONTENT_KINDS,
  fail,
  info,
  isForm,
  isInformational,
  isVagueHeading,
  notApplicable,
  pass,
  PAGE_KINDS,
  questionHeadings,
  topicOf,
  warn,
} from "@/lib/seo/checks/util";
import { stuffedKeywords } from "@/lib/seo/keywords";
import { hasPhrase, istDay, monthsBetween, plural, quote, round2, share, sharedWords, squash, STOPWORDS, tokenize } from "@/lib/seo/text";
import type { CheckDef, JsonLd, SeoInput } from "@/lib/seo/types";

/**
 * GEO — generative engine optimisation: an internal heuristic for how well AI search can identify,
 * trust and quote a page — named entities, specific and sourced facts, dates, machine-readable
 * structure, and whether AI search crawlers may read the site at all (owner decision S-D2). It never
 * claims to predict whether any AI system will include the page.
 */

/** A post this many months past its last update is due a review. */
export const STALE_MONTHS = 24;
/** A post with fewer distinct H2 sections, or fewer words, covers its topic thinly. */
export const DEPTH = { sections: 3, words: 800 } as const;
export const PASSAGE_WORDS = { min: 40, max: 120 } as const;
/** One word (not a stopword) past this share of the text, this many times, reads as repetition. A page's topic word runs to 3–5%. */
export const REPEAT = { density: 6, occurrences: 10 } as const;

const norm = (s: string) => squash(s).toLowerCase();
const noun = (input: SeoInput) => (input.kind === "post" ? "post" : input.kind === "category" ? "category" : input.kind === "tag" ? "tag" : "page");

/** The properties each JSON-LD type needs to be useful. */
const REQUIRED_PROPS: Record<string, string[]> = {
  Organization: ["name", "url"],
  WebSite: ["name", "url"],
  WebPage: ["name", "url"],
  CollectionPage: ["name", "url"],
  BlogPosting: ["headline", "datePublished", "author", "publisher"],
  BreadcrumbList: ["itemListElement"],
  FAQPage: ["mainEntity"],
};

/** What to do when a BlogPosting property is missing — each comes from something the editor controls. */
const PROP_FIXES: Record<string, string> = {
  author: "Add author information to improve content attribution.",
  datePublished: "Publish or schedule the post: its date goes into the structured data.",
  headline: "Give the post a title.",
};

function present(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim() !== "";
  return value !== null && value !== undefined;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every way the site's name is written in the text: "Deskzo One", "deskzo-one", "DeskzoOne". */
function nameMentions(text: string, name: string): string[] {
  const parts = name.split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (!parts.length) return [];
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${parts.join("[\\s\\-_.]*")})(?=$|[^\\p{L}\\p{N}])`, "giu");
  return [...text.matchAll(re)].map((m) => m[2]);
}

export const GEO_CHECKS: readonly CheckDef[] = [
  {
    id: "geo.entity",
    label: "Who and what",
    category: "geo",
    group: "entity",
    weight: 6,
    applicableTo: PAGE_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      const home = input.kind === "home";
      if (!home && input.pageType !== "pricing" && input.pageType !== "security") return notApplicable("Checked on the home, pricing and security pages.");
      const name = input.site.siteName;
      const text = input.content.text;
      const named = !!name && hasPhrase(text, name);
      const what = input.site.tagline ?? input.site.description;
      const says = what ? sharedWords(text, what) >= 2 : !!input.content.firstParagraph;
      const org = !home || input.jsonLd.some((o) => o["@type"] === "Organization");
      const parts = [named, says, ...(home ? [org] : [])];
      const good = parts.filter(Boolean).length;
      if (good === parts.length) return pass(w, `Names ${quote(name)} and says what it does${home ? ", with Organization structured data" : ""}.`);
      const field = bodyField(input);
      if (!named) {
        return warn(share(w, good / parts.length), `The ${home ? "home" : input.pageType} page never names ${quote(name)} in its content.`, `Name ${name} near the top — “${name} is …” — so AI answers can tell who is speaking and attribute what the page says.`, { field });
      }
      if (!says) return warn(share(w, good / parts.length), `The page doesn't say what ${name} does in the site's own words (its tagline or description).`, `Say plainly what ${name} is and does, near the top.`, { field });
      return warn(share(w, good / parts.length), "No Organization structured data on the home page.", input.site.emitsJsonLd ? "Tell a developer: the home page should carry Organization structured data." : "A developer change: the site doesn't emit JSON-LD yet.");
    },
  },
  {
    id: "geo.specificity",
    label: "Specific, not vague",
    category: "geo",
    group: "content",
    weight: 6,
    applicableTo: ["page", "home", "post", "category", "tag"],
    indexedOnly: true,
    evaluate(input, w) {
      const claims = unsupportedClaims(input);
      if (!claims.length) return pass(w, "No unsupported superlatives: claims come with figures or sources.");
      const c = claims[0];
      return warn(
        share(w, 1 - 0.34 * claims.length),
        `${quote(c.sentence)} claims ${quote(c.term)} with no figure or source to back it${claims.length > 1 ? ` (and ${plural(claims.length - 1, "more claim")})` : ""}.`,
        "Replace the superlative with a specific fact — a number, a result, a source — or drop it.",
        { field: c.field ?? undefined },
      );
    },
  },
  {
    id: "geo.statistics",
    label: "Figures in context",
    category: "geo",
    group: "content",
    weight: 4,
    applicableTo: CONTENT_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      const figs = figures(input);
      if (!figs.length) return notApplicable("No figures on the page.");
      const bare = figs.filter((f) => !f.context);
      if (!bare.length) return pass(w, `${plural(figs.length, "figure")}, each with its unit, date or source.`);
      return warn(
        share(w, 1 - bare.length / figs.length),
        `${quote(bare[0].sentence)} gives ${quote(bare[0].text)} without saying what it counts, when, or from where.`,
        "Give each figure its unit, date or source — “40% of invoices in 2025, according to …” rather than a bare number.",
        { field: bare[0].field ?? undefined },
      );
    },
  },
  {
    id: "geo.citations",
    label: "Sources for statistics",
    category: "geo",
    group: "content",
    weight: 5,
    applicableTo: CONTENT_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      const worthy = figures(input).filter((f) => f.citeWorthy);
      if (!worthy.length) return notApplicable("No statistics that need a source.");
      const uncited = worthy.filter((f) => !f.cited);
      if (!uncited.length) return pass(w, `Its ${plural(worthy.length, "statistic")} come with sources.`);
      return warn(
        share(w, 1 - uncited.length / worthy.length),
        `${quote(uncited[0].sentence)} states a statistic with no source.`,
        "Link the figure to where it comes from (select its words and add the source's address), or say “according to …”.",
        { field: uncited[0].field ?? undefined },
      );
    },
  },
  {
    id: "geo.freshness",
    label: "Dates",
    category: "geo",
    group: "freshness",
    weight: 5,
    applicableTo: ["post"],
    indexedOnly: true,
    evaluate(input, w) {
      const { publishedAt, updatedAt } = input.editorial;
      if (!publishedAt) return warn(0, "No publication date.", "Publish or schedule the post; its date shows under its title and goes into its structured data.", { field: "publishAt" });
      const ld = input.jsonLd.find((o) => o["@type"] === "BlogPosting");
      const ldDates = !!ld && present(ld.datePublished) && present(ld.dateModified);
      if (!ldDates) {
        return warn(
          share(w, 0.5),
          `The post shows its date (${istDay(publishedAt)}), but ${ld ? "its structured data lacks datePublished or dateModified" : "no BlogPosting structured data carries it"}.`,
          input.site.emitsJsonLd ? "Tell a developer: a post's structured data should carry both dates." : "A developer change: the site doesn't emit JSON-LD yet.",
        );
      }
      const last = updatedAt ?? publishedAt;
      const months = monthsBetween(last, input.now);
      if (months >= STALE_MONTHS) return warn(share(w, 0.5), `Last updated ${months} months ago (${istDay(last)}).`, "Review it: correct what has changed and save — AI answers prefer current sources.", { field: "body" });
      return pass(w, `Published ${istDay(publishedAt)}${updatedAt ? `, updated ${istDay(updatedAt)}` : ""}; both dates are in its structured data. (The post shows its published date; the site doesn't show the updated one.)`);
    },
  },
  {
    id: "geo.headings.descriptive",
    label: "Descriptive headings",
    category: "geo",
    group: "content",
    weight: 4,
    applicableTo: CONTENT_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      const hs = input.content.headings.filter((h) => h.level >= 2);
      if (!hs.length) return notApplicable("No section headings.");
      const bad = hs.filter((h) => isVagueHeading(h.text));
      if (!bad.length) return pass(w, `${plural(hs.length, "section heading")}, each naming its subject.`);
      return warn(share(w, 1 - bad.length / hs.length), `The heading ${quote(bad[0].text)} doesn't say what its section is about.`, `Name the section's subject — “How invoices are numbered” rather than ${quote(bad[0].text)}.`, {
        field: bad[0].field ?? undefined,
      });
    },
  },
  {
    id: "geo.qa-coverage",
    label: "Questions answered",
    category: "geo",
    group: "answers",
    weight: 4,
    applicableTo: CONTENT_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      const pairs = questionHeadings(input).filter((q) => answerUnder(input, q.index)).length + input.content.faqs.filter((f) => f.question && f.answer).length;
      if (!isInformational(input)) return pairs ? pass(w, `${plural(pairs, "question")} asked and answered.`) : notApplicable("Not an informational page: question-and-answer coverage isn't expected.");
      if (pairs >= 2) return pass(w, `${plural(pairs, "question")} asked and answered on the page.`);
      const topic = topicOf(input);
      const recommendation = `Cover the questions readers ask${topic ? ` about ${topic}` : ""}: an H2 phrased as a question with a short answer under it, or an FAQ block.`;
      if (pairs === 1) return warn(share(w, 0.5), "Only one question is asked and answered on the page.", recommendation, { field: bodyField(input) });
      return warn(0, "No question is asked and answered on the page.", recommendation, { field: bodyField(input) });
    },
  },
  {
    id: "geo.machine-readable",
    label: "Complete structured data",
    category: "geo",
    group: "structured-data",
    weight: 6,
    applicableTo: ALL_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      if (input.kind === "blog-index") return info("The blog index emits no structured data; the posts and archives it lists carry their own.", "Its markup is fixed in code.");
      const ld = input.jsonLd;
      const expected = EXPECTED_LD[input.kind];
      if (!ld.length) {
        return fail(
          `No JSON-LD: AI and search systems get no machine-readable ${expected[0]} for this ${noun(input)}.`,
          input.site.emitsJsonLd ? "Tell a developer: structured data is built from the page's content and should be here." : "A developer change: the site doesn't emit JSON-LD yet — nothing in the CMS turns it on.",
        );
      }
      const gaps: { message: string; fix: string }[] = [];
      for (const type of expected) if (!ld.some((o) => o["@type"] === type)) gaps.push({ message: `no ${type}`, fix: "Tell a developer: the site should emit it for every page of this kind." });
      let required = expected.length;
      for (const o of ld as JsonLd[]) {
        const props = REQUIRED_PROPS[o["@type"]] ?? [];
        required += props.length;
        for (const prop of props) if (!present(o[prop])) gaps.push({ message: `${o["@type"]} has no ${prop}`, fix: PROP_FIXES[prop] ?? "Tell a developer." });
        if (o["@type"] === "FAQPage") {
          const shown = input.content.faqs.filter((f) => f.question && f.answer).length;
          const listed = Array.isArray(o.mainEntity) ? o.mainEntity.length : 0;
          required += 1;
          if (listed !== shown) gaps.push({ message: `FAQPage lists ${listed} questions but the page shows ${shown}`, fix: "Tell a developer: FAQPage must list exactly the questions the page shows." });
        }
      }
      if (!gaps.length) return pass(w, `${[...new Set(ld.map((o) => o["@type"]))].join(", ")} — each complete.`);
      const first = gaps[0];
      return warn(share(w, 1 - gaps.length / Math.max(1, required)), `Structured data is incomplete: ${gaps.map((g) => g.message).join("; ")}.`, first.fix, { field: first.message.includes("author") ? "author" : undefined });
    },
  },
  {
    id: "geo.brand-consistency",
    label: "The site's name, spelt one way",
    category: "geo",
    group: "entity",
    weight: 3,
    applicableTo: ["page", "home", "post", "category", "tag"],
    indexedOnly: true,
    evaluate(input, w) {
      const name = input.site.siteName;
      if (!name) return notApplicable("The site has no name in Settings.");
      const mentions = nameMentions(input.content.text, name);
      if (!mentions.length) return notApplicable(`The content doesn't mention ${quote(name)}.`);
      const variant = mentions.find((m) => m !== name);
      if (!variant) return pass(w, `${quote(name)} is written the same way each of the ${plural(mentions.length, "time")} it appears.`);
      const where = [...input.content.paragraphs, ...input.content.headings].find((x) => x.text.includes(variant));
      return warn(0, `The site's name appears as ${quote(variant)}; Settings spell it ${quote(name)}.`, `Write ${quote(name)} exactly as Settings do, everywhere, so it is recognised as one name.`, { field: where?.field ?? undefined });
    },
  },
  {
    id: "geo.depth",
    label: "Topical depth",
    category: "geo",
    group: "content",
    weight: 5,
    applicableTo: ["post"],
    indexedOnly: true,
    evaluate(input, w) {
      const sections = new Set(input.content.headings.filter((h) => h.level === 2).map((h) => norm(h.text))).size;
      const words = input.content.wordCount;
      if (sections >= DEPTH.sections && words >= DEPTH.words) return pass(w, `${sections} distinct H2 sections over ${words} words.`);
      const fraction = Math.min(1, sections / DEPTH.sections) * 0.5 + Math.min(1, words / DEPTH.words) * 0.5;
      const needs = [sections < DEPTH.sections ? `at least ${DEPTH.sections} H2 sections, each covering one part of the topic` : "", words < DEPTH.words ? `about ${DEPTH.words} words in all` : ""].filter(Boolean).join(", and ");
      return warn(share(w, fraction), `${plural(sections, "distinct H2 section")} over ${words} words: thin coverage for a post.`, `Cover the topic in more depth: ${needs}.`, { field: bodyField(input) });
    },
  },
  {
    id: "geo.passages",
    label: "Quotable passages",
    category: "geo",
    group: "answers",
    weight: 4,
    applicableTo: CONTENT_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      if (isForm(input)) return notApplicable("A form page.");
      if (input.content.wordCount < 150) return notApplicable("Too little text for passages.");
      const heads = input.content.headings;
      const good = input.content.paragraphs.filter((p) => p.words >= PASSAGE_WORDS.min && p.words <= PASSAGE_WORDS.max && p.heading >= 0 && heads[p.heading]?.level >= 2 && !isVagueHeading(heads[p.heading].text));
      if (good.length) return pass(w, `${plural(good.length, "paragraph")} of ${PASSAGE_WORDS.min}–${PASSAGE_WORDS.max} words under descriptive headings — each can be quoted on its own.`);
      return warn(0, `No paragraph of ${PASSAGE_WORDS.min}–${PASSAGE_WORDS.max} words sits under a descriptive section heading.`, `Under each main H2, write one self-contained paragraph of ${PASSAGE_WORDS.min}–${PASSAGE_WORDS.max} words that answers the heading.`, {
        field: bodyField(input),
      });
    },
  },
  {
    id: "geo.duplicates",
    label: "Original, not thin",
    category: "geo",
    group: "content",
    weight: 5,
    applicableTo: ALL_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      const others = input.site.others.filter((o) => o.id !== input.id && o.path !== input.path);
      const desc = norm(input.meta.description);
      const h1 = norm(input.content.h1s[0] ?? "");
      const problems: { message: string; recommendation: string; field?: string }[] = [];
      const dupDesc = desc ? others.find((o) => norm(o.description) === desc) : undefined;
      if (dupDesc) problems.push({ message: `The description is the same as ${dupDesc.path}'s.`, recommendation: "Write a description particular to this page.", field: input.kind === "blog-index" ? undefined : "seo.description" });
      const dupH1 = h1 ? others.find((o) => norm(o.h1) === h1) : undefined;
      if (dupH1) problems.push({ message: `The H1 ${quote(input.content.h1s[0])} is also the H1 of ${dupH1.path}.`, recommendation: "Give the main heading words particular to this page." });
      const thinAt = input.kind === "post" ? 150 : input.kind === "page" || input.kind === "home" ? 80 : 0;
      if (thinAt && !isForm(input) && input.content.wordCount < thinAt) {
        problems.push({ message: `Only ${plural(input.content.wordCount, "word")}: too thin to be quoted as a source.`, recommendation: "Add the substance a reader came for: facts, steps, examples.", field: bodyField(input) });
      }
      if (!problems.length) return pass(w, "Its description and H1 are its own, and it has enough text to stand alone.");
      return warn(share(w, 1 - 0.4 * problems.length), problems.map((p) => p.message).join(" "), problems[0].recommendation, { field: problems[0].field });
    },
  },
  {
    id: "geo.stuffing",
    label: "No repetition",
    category: "geo",
    group: "keywords",
    weight: 3,
    applicableTo: ["page", "home", "post", "category", "tag"],
    indexedOnly: true,
    evaluate(input, w) {
      const stuffed = stuffedKeywords(input);
      if (stuffed.length) return warn(0, `${quote(stuffed[0].keyword)} is repeated past a natural rate: ${stuffed[0].reason}.`, "Write for the reader: use the keyword where it fits and vary the wording elsewhere.", { field: bodyField(input) });
      const tokens = tokenize(input.content.text);
      if (tokens.length < 150) return input.keywords.length ? pass(w, "The keywords are used at a natural rate.") : notApplicable("Too little text to judge repetition.");
      const counts = new Map<string, number>();
      for (const t of tokens) if (!STOPWORDS.has(t) && t.length >= 4 && !/^\d+$/.test(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
      let top: [string, number] = ["", 0];
      for (const entry of counts) if (entry[1] > top[1] || (entry[1] === top[1] && entry[0] < top[0])) top = entry;
      const density = round2((top[1] / tokens.length) * 100);
      if (top[1] >= REPEAT.occurrences && density > REPEAT.density) return warn(0, `${quote(top[0])} makes up ${density}% of the words.`, "Vary the wording: repeating one word this often reads as stuffing.", { field: bodyField(input) });
      return pass(w, "No word or phrase is repeated past a natural rate.");
    },
  },
  {
    id: "geo.ai-crawlers",
    label: "AI search crawlers allowed",
    category: "geo",
    group: "technical",
    weight: 6,
    applicableTo: ALL_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      if (input.site.aiSearchCrawlersAllowed) return pass(w, "AI search crawlers (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, PerplexityBot and others) may read the site; AI training crawlers stay blocked.");
      return fail(
        "robots.txt blocks AI search crawlers (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, PerplexityBot), so AI search can't read or cite this page.",
        "Site-wide, in code: allow the AI search crawlers in src/app/robots.ts and keep the training crawlers blocked (owner decision S-D2). Nothing in the CMS changes it.",
        { severity: "critical" },
      );
    },
  },
];
