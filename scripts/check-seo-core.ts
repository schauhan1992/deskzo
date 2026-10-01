/**
 * check:seo-core — the SEO Intelligence engine (src/lib/seo), pure: no database, no network.
 *
 *   · keywords: normalised, repeats refused case-insensitively, placement found on word boundaries;
 *   · a near-perfect page scores 90 or more (and the suite says why it is not 100 when it is not);
 *     missing metadata is critical and costs points; noindex is excluded, never a failure; a post
 *     with an author, dates and schema; a category archive; the home page; the blog index;
 *   · missing, repeated and stuffed keywords; empty content; FAQ structured data only with a
 *     visible FAQ; structured-data completeness; nothing invented (no author, no date, no image);
 *   · the label bands at 39/40, 59/60 and 79/80, the 50/25/25 weighting, every score an integer
 *     from 0 to 100 under a fixed-seed fuzz, the same input giving the same output;
 *   · the comparison table (a table, its sources external links), related links and the page map
 *     (internal links, their headings): extracted as the block components render them, link for
 *     link; no new JSON-LD; a nested page's BreadcrumbList is its visible trail;
 *   · the site score: weighted, noindex and drafts left out; `serialiseLd` escaping "</script>";
 *   · metadata parity: the pure builders return exactly what the site's own generateMetadata
 *     functions return — every built-in page, the not-found page, the layout, the blog index, an
 *     archive and a post — rendered on the site's defaults with the control plane switched off.
 *
 *   npm run check:seo-core
 */
import Module from "node:module";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Metadata } from "next";
import type { SiteBlock, SitePage, SiteSettings } from "../src/components/site/blocks/types";
import {
  AEO_CHECKS,
  analyseKeyword,
  buildArchiveMetadata,
  buildBlogIndexMetadata,
  buildLayoutMetadata,
  buildNotFoundMetadata,
  buildPageMetadata,
  buildPostMetadata,
  crossReference,
  effectiveMetadata,
  faqPageLd,
  GEO_CHECKS,
  inputFromArchive,
  inputFromBlogIndex,
  inputFromPage,
  inputFromPost,
  keywordProblems,
  labelFor,
  layoutView,
  normaliseKeywords,
  overallScore,
  parseSeoField,
  scoreCategory,
  scoreEntity,
  SEO_CHECKS,
  serialiseLd,
  siteContextFrom,
  siteEntry,
  siteScore,
  seoStatusOf,
  WEIGHTS,
  type ArchiveSource,
  type CheckResult,
  type EntityScore,
  type JsonLd,
  type PostSource,
  type SeoInput,
  type SeoSiteContext,
  type SiteScoreEntry,
} from "../src/lib/seo";

// The parity section loads the site's own modules: with the control plane emptied (not deleted — a
// Prisma client imported later reloads .env and would put a deleted value back) they read the defaults.
process.env.CONTROL_DATABASE_URL = "";

const counts: Record<string, { ok: number; fail: number }> = {};
let current = "setup";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  process.stdout.write(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}\n`);
  counts[current] ??= { ok: 0, fail: 0 };
  counts[current][pass ? "ok" : "fail"] += 1;
  if (!pass) failures += 1;
};
const section = (title: string) => {
  current = title;
  process.stdout.write(`\n— ${title} —\n`);
};
const note = (text: string) => process.stdout.write(`       ${text}\n`);

const NOW = new Date("2026-09-29T06:30:00Z");
const allChecks = (s: EntityScore) => [...s.seo.checks, ...s.aeo.checks, ...s.geo.checks];
const find = (s: EntityScore, id: string): CheckResult | undefined => allChecks(s).find((c) => c.id === id);
const statusOf = (s: EntityScore, id: string) => find(s, id)?.status ?? "missing";
const types = (ld: JsonLd[]) => ld.map((o) => o["@type"]);
const notPassed = (s: EntityScore) => allChecks(s).filter((c) => c.status === "WARNING" || c.status === "FAIL");
const explain = (s: EntityScore) => {
  for (const c of notPassed(s)) note(`  ${c.status} ${c.id} ${c.pointsEarned}/${c.pointsAvailable}: ${c.message}`);
};

// ─── Fixtures ────────────────────────────────────────────────────────────────────────────────────

function block<T extends SiteBlock["type"]>(id: string, type: T, props: Extract<SiteBlock, { type: T }>["props"]): SiteBlock {
  return { id, type, props } as SiteBlock;
}

const NEAR_PERFECT_KEYWORDS = ["GST invoice software", "e-invoicing", "place of supply"];

function nearPerfectPage(): Parameters<typeof inputFromPage>[0] {
  return {
    id: "page-gst",
    slug: "gst-invoice-software",
    title: "GST invoice software",
    status: "published",
    seo: {
      title: "GST invoice software for Indian companies",
      description: "GST invoice software that numbers, taxes and e-invoices every sale, with the place of supply worked out for you. See how it works.",
      ogImage: "/media/cm0ogimage000000000000001",
      keywords: NEAR_PERFECT_KEYWORDS,
    },
    blocks: [
      block("b-header", "pageHeader", {
        eyebrow: "Invoicing",
        heading: "GST invoice software for growing Indian companies",
        intro: "Deskzo One is GST invoice software that numbers, taxes and files every invoice for you. It runs from the first quote to the e-invoice the portal accepts.",
      }),
      block("b-what", "richText", {
        content: [
          { type: "heading", level: 2, text: "What is GST invoice software?" },
          { type: "paragraph", text: "GST invoice software is a tool that writes tax invoices with the right rates and an unbroken number series. It then reports each one to the invoice portal." },
          {
            type: "paragraph",
            text: "Every invoice starts from a quote or an order, so the customer, the items and the prices are already known. The software looks up each item's HSN code and rate. It works out whether the sale is within a state or between states, and splits the tax into CGST and SGST or IGST. Nobody types a tax amount by hand, which is where most invoice errors begin.",
          },
          {
            type: "list",
            items: ["Numbers invoices in one series per branch and financial year", "Works out CGST, SGST and IGST from the place of supply", "Sends e-invoices to the portal and keeps the IRN and QR code"],
          },
        ],
      }),
      block("b-how", "richText", {
        content: [
          { type: "heading", level: 2, text: "How does e-invoicing work?" },
          { type: "paragraph", text: "E-invoicing means each business invoice is registered on the government's invoice portal. The portal returns a reference number and a signed QR code." },
          {
            type: "paragraph",
            text: [
              { text: "According to the GST Network, " },
              { text: "e-invoicing applies to businesses with a turnover above ₹5 crore", href: "https://einvoice1.gst.gov.in" },
              { text: " since August 2023. The software checks each invoice against the portal's rules before sending it. It keeps the reply with the invoice for audits." },
            ],
          },
          {
            type: "table",
            columns: ["Invoice type", "E-invoice needed?"],
            rows: [
              ["Tax invoice to a business", "Yes"],
              ["Invoice to a consumer", "No"],
              ["Credit note to a business", "Yes"],
            ],
          },
        ],
      }),
      block("b-place", "richText", {
        content: [
          { type: "heading", level: 2, text: "How is the place of supply decided?" },
          { type: "paragraph", text: "The place of supply is the state where the customer receives the goods or services. When it matches your state, the invoice charges CGST and SGST. When it differs, it charges IGST." },
          {
            type: "paragraph",
            text: "For services, the rules look at where the customer is registered. For goods, they look at where the delivery ends. Deskzo One reads both from the customer's record and the delivery address. It shows the result on the invoice before you issue it, so you correct an address rather than a tax return.",
          },
        ],
      }),
      block("b-faq", "faq", {
        heading: "Questions about GST invoices",
        items: [
          { question: "Can I cancel an e-invoice?", answer: ["Yes, within 24 hours of registering it on the portal. After that, issue a credit note instead."] },
          { question: "Do I need a separate series for each branch?", answer: ["Each GST registration needs its own invoice series. A company with two registrations keeps two series."] },
        ],
      }),
      block("b-image", "imageText", {
        heading: "Invoices your customers can read",
        body: ["Every invoice shows the tax split, the place of supply and the QR code where the customer expects them."],
        action: { kind: "link", label: "See pricing plans", href: "/pricing" },
        media: { kind: "image", src: "/media/cm0invoice0000000000000001", alt: "A GST invoice with the tax split into CGST and SGST" },
      }),
      block("b-cta", "cta", { heading: "Start invoicing with GST in minutes", body: "Set up a workspace and send your first invoice today.", primary: { kind: "signup" }, variant: "panel" }),
    ],
  };
}

function goodPost(): PostSource {
  return {
    id: "post-numbering",
    slug: "gst-invoice-numbering",
    title: "How GST invoice numbering works",
    excerpt: "One series per registration and financial year, no gaps, and what to do when an invoice is cancelled.",
    cover: { src: "/media/cm0cover00000000000000001", alt: "An invoice register with numbers in sequence", width: 1600, height: 900 },
    seo: { title: "GST invoice numbering rules explained", description: "GST invoice numbering in plain words: one series per registration and financial year, no gaps, and what happens when you cancel an invoice.", keywords: ["GST invoice numbering", "invoice series"] },
    author: "Asha Rao",
    publishedAt: new Date("2026-08-12T04:30:00Z"),
    updatedAt: new Date("2026-09-20T09:00:00Z"),
    categories: [{ slug: "guides", name: "Guides", path: "/blog/category/guides" }],
    tagLinks: [
      { slug: "gst", name: "GST", path: "/blog/tag/gst" },
      { slug: "invoicing", name: "Invoicing", path: "/blog/tag/invoicing" },
    ],
    body: [
      block("p-1", "richText", {
        content: [
          { type: "heading", level: 2, text: "What is GST invoice numbering?" },
          { type: "paragraph", text: "GST invoice numbering is the rule that every tax invoice carries a unique number from a series of at most sixteen characters. Each series belongs to one registration and one financial year." },
          {
            type: "paragraph",
            text: [
              { text: "The number can hold letters, digits, hyphens and slashes. Most companies start each invoice series again from one every year, with the year in the prefix, so a number never repeats across years. See how Deskzo One numbers them on " },
              { text: "the pricing page", href: "/pricing" },
              { text: "." },
            ],
          },
        ],
      }),
    ],
  };
}

function guidesArchive(): ArchiveSource {
  return {
    kind: "category",
    id: "cat-guides",
    slug: "guides",
    name: "Guides",
    description: "Step-by-step guides to GST invoicing, payroll and accounting in Deskzo One, written for the people who run them every month in growing Indian companies.",
    seo: { title: "GST, payroll and accounting guides", description: "Step-by-step guides to GST invoicing, payroll and accounting for growing Indian companies, from the team that builds Deskzo One.", keywords: ["guides"] },
    image: { src: "/media/cm0guides0000000000000001", alt: "Guides", width: 1200, height: 630 },
    posts: [{ title: "How GST invoice numbering works", path: "/blog/gst-invoice-numbering", excerpt: "One series per registration and financial year.", cover: { src: "/media/cm0cover00000000000000001", alt: "An invoice register with numbers in sequence" } }],
    total: 1,
    page: 1,
    pages: 1,
    parent: null,
  };
}

// ─── A fixed-seed random source, for the fuzz ────────────────────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  // The top imports are the pure engine only; the site's own modules are required here and in the
  // parity section, which must load them after its stubs are in place.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { DEFAULT_SITE_PAGES, DEFAULT_SITE_SETTINGS } = require("../src/components/site/defaults") as typeof import("../src/components/site/defaults");
  const settings: SiteSettings = { ...DEFAULT_SITE_SETTINGS, social: [{ network: "linkedin", href: "https://www.linkedin.com/company/deskzo" }] };
  const site: SeoSiteContext = siteContextFrom(settings, {
    trialDays: 14,
    signupOpen: true,
    origin: "https://deskzo.test",
    aiSearchCrawlersAllowed: true,
    placeholderTagline: DEFAULT_SITE_SETTINGS.tagline,
    livePostCount: 5,
  });

  // ── Keywords ─────────────────────────────────────────────────────────────────────────────────
  section("Keywords");
  ok("trimmed, whitespace collapsed, blanks dropped, at most three", isDeepStrictEqual(normaliseKeywords(["  GST   invoice ", "", "  ", "e-invoicing", "place of supply", "fourth"]), ["GST invoice", "e-invoicing", "place of supply"]));
  ok("a comma-separated string is read as a list", isDeepStrictEqual(normaliseKeywords("a, b ,, c"), ["a", "b", "c"]));
  ok("anything else is no keywords", isDeepStrictEqual(normaliseKeywords(42), []) && isDeepStrictEqual(normaliseKeywords({ keywords: ["x"] }), []) && isDeepStrictEqual(normaliseKeywords([1, null, "ok"]), ["ok"]));
  const dup = keywordProblems(["GST invoice", "", "gst  INVOICE"]);
  ok("a repeat is refused, compared case-insensitively (blank slots are fine)", dup.length === 1 && dup[0].index === 2 && dup[0].message.includes("repeats keyword 1"), dup);
  ok("a fourth keyword is refused", keywordProblems(["a", "b", "c", "d"]).some((p) => p.index === 3));
  ok("a keyword with no word is refused", keywordProblems(["—"]).length === 1);
  const comma = keywordProblems(["GST software", "payroll, India"]);
  ok("a keyword with a comma is refused — the keywords meta would read it as two", comma.length === 1 && comma[0].index === 1 && /comma/.test(comma[0].message), JSON.stringify(comma));
  ok("three distinct keywords are fine", keywordProblems(NEAR_PERFECT_KEYWORDS).length === 0);

  const perfect = inputFromPage(nearPerfectPage(), site, NOW);
  const a1 = analyseKeyword(perfect, "gst INVOICE software");
  ok("placement: case-insensitive, multi-word, in title, description, URL, H1, opening, body and headings", a1.inTitle && a1.inDescription && a1.inUrl && a1.inH1 && a1.inFirstSection && a1.inBody && a1.inHeadings, a1);
  ok("placement: in an image's alt", analyseKeyword(perfect, "tax split").inImageAlt);
  ok("matching is on word boundaries ('voice' is not in 'invoice')", analyseKeyword(perfect, "voice").occurrences === 0);
  ok("a hyphenated keyword matches the words it is made of", analyseKeyword(perfect, "E-Invoicing").occurrences >= 2);
  ok("density is occurrences × words ÷ word count, in percent", Math.abs(a1.density - Math.round(((a1.occurrences * 3) / perfect.content.wordCount) * 10000) / 100) < 0.001, a1);

  // ── The near-perfect page ────────────────────────────────────────────────────────────────────
  section("A near-perfect page");
  const perfectScore = scoreEntity(perfect);
  note(`SEO ${perfectScore.seo.score} · AEO ${perfectScore.aeo.score} · GEO ${perfectScore.geo.score} · overall ${perfectScore.overall} (${perfectScore.label}), ${perfect.content.wordCount} words`);
  ok("scores 90 or more overall", perfectScore.overall >= 90, perfectScore.overall);
  ok("  and in each of SEO, AEO and GEO", perfectScore.seo.score >= 90 && perfectScore.aeo.score >= 90 && perfectScore.geo.score >= 90);
  ok("  labelled Excellent, with no critical issue", perfectScore.label === "Excellent" && perfectScore.critical === 0);
  const short = notPassed(perfectScore);
  if (perfectScore.overall < 100) for (const c of short) note(`not 100 because ${c.id} (${c.status}, ${c.pointsEarned}/${c.pointsAvailable}): ${c.message}`);
  else note("100: every scored check passes.");
  ok("  its JSON-LD: WebPage, BreadcrumbList and FAQPage", isDeepStrictEqual(types(perfect.jsonLd), ["WebPage", "BreadcrumbList", "FAQPage"]), types(perfect.jsonLd));
  ok("  the meta keywords tag is INFO and worth no points", statusOf(perfectScore, "seo.keywords.meta-tag") === "INFO" && find(perfectScore, "seo.keywords.meta-tag")!.pointsAvailable === 0);
  ok("  its metadata carries the keywords, deduplicated", isDeepStrictEqual(perfect.meta.keywords, NEAR_PERFECT_KEYWORDS));
  ok("  the final title is the template's: “… · Deskzo One”", perfect.meta.title === "GST invoice software for Indian companies · Deskzo One", perfect.meta.title);
  ok("  the internal link to /pricing and the signup button are found; the portal link is external", perfect.content.links.some((l) => l.href === "/pricing" && l.internal) && perfect.content.links.some((l) => l.href === "/signup") && perfect.content.links.some((l) => l.href.startsWith("https://einvoice1") && !l.internal));
  ok("  a library image is marked as one", perfect.content.images.length === 1 && perfect.content.images[0].library);
  ok("  a block's issue points at blocks[<id>]", find(perfectScore, "seo.h1")?.field === "blocks[b-header]", find(perfectScore, "seo.h1")?.field);
  ok("  which parseSeoField takes apart for the editor", isDeepStrictEqual(parseSeoField("blocks[b-header]"), { kind: "block", root: "blocks", blockId: "b-header" }) && isDeepStrictEqual(parseSeoField("seo.description"), { kind: "field", path: "seo.description" }) && parseSeoField(undefined) === null);
  ok("the CMS's statuses map to the engine's", seoStatusOf("DEFAULT") === "default" && seoStatusOf("DRAFT") === "draft" && seoStatusOf("PUBLISHED") === "published" && seoStatusOf("SCHEDULED") === "scheduled");

  // ── Missing metadata ─────────────────────────────────────────────────────────────────────────
  section("Missing metadata");
  const bare = inputFromPage({ id: "page-about", slug: "about-us", title: "About us", status: "published", seo: { title: "", description: "" }, blocks: [block("h", "pageHeader", { heading: "About us", intro: "We build software for companies in India." })] }, site, NOW);
  const bareScore = scoreEntity(bare);
  const titleCheck = find(bareScore, "seo.title.present")!;
  const descCheck = find(bareScore, "seo.description.present")!;
  ok("no title: FAIL, critical, no points, points at seo.title", titleCheck.status === "FAIL" && titleCheck.severity === "critical" && titleCheck.pointsEarned === 0 && titleCheck.pointsAvailable === 10 && titleCheck.field === "seo.title", titleCheck);
  ok("no description: FAIL, critical, points at seo.description", descCheck.status === "FAIL" && descCheck.severity === "critical" && descCheck.field === "seo.description");
  ok("  counted as critical issues", bareScore.critical >= 2, bareScore.critical);
  ok("  and the SEO score drops well below the near-perfect page's", bareScore.seo.score < perfectScore.seo.score - 25, `${bareScore.seo.score} vs ${perfectScore.seo.score}`);
  ok("the rendered title of an empty SEO title is only the template's addition", bare.meta.title === " · Deskzo One", bare.meta.title);
  const postNoDesc = inputFromPost({ ...goodPost(), excerpt: null, seo: { title: "x" } }, site, NOW);
  const postNoDescCheck = find(scoreEntity(postNoDesc), "seo.description.present")!;
  ok("a post with neither a description nor an excerpt: FAIL, critical, and the message says which", postNoDescCheck.status === "FAIL" && postNoDescCheck.severity === "critical" && postNoDescCheck.message.includes("excerpt"));
  const postExcerpt = scoreEntity(inputFromPost({ ...goodPost(), seo: { title: "x" } }, site, NOW));
  ok("a post whose excerpt is its description: PASS, and it says it is the excerpt", statusOf(postExcerpt, "seo.description.present") === "PASS" && find(postExcerpt, "seo.description.present")!.message.includes("excerpt"));

  // ── noindex ──────────────────────────────────────────────────────────────────────────────────
  section("An intentionally excluded page (noindex)");
  const signupPage = DEFAULT_SITE_PAGES.find((p) => p.slug === "signup")!;
  const signup = inputFromPage({ ...signupPage, status: "default" }, site, NOW);
  const signupScore = scoreEntity(signup);
  ok("the signup page is excluded", signupScore.excluded);
  ok("  its robots and indexability checks are INFO", statusOf(signupScore, "seo.robots") === "INFO" && statusOf(signupScore, "seo.indexable") === "INFO");
  ok("  “Intentionally excluded” is what they say", find(signupScore, "seo.indexable")!.message.startsWith("Intentionally excluded"));
  ok("  no check fails because of noindex", !allChecks(signupScore).some((c) => c.status === "FAIL" && /noindex|excluded/i.test(c.message)));
  ok("  checks that only matter when indexed do not apply", ["seo.sitemap", "seo.keywords.present", "seo.title.unique", "geo.ai-crawlers", "aeo.intent"].every((id) => statusOf(signupScore, id) === "NOT_APPLICABLE"));
  ok("  robots.txt blocking /signup too is INFO, not a conflict", statusOf(signupScore, "seo.robots-conflict") === "INFO");
  const thanks = inputFromPage({ id: "p-thanks", slug: "thank-you", title: "Thanks", seo: { title: "Thank you", description: "", noindex: true }, blocks: [] }, site, NOW);
  const thanksScore = scoreEntity(thanks);
  ok("a noindex CMS page with nothing on it is still excluded, not failed for noindex", thanksScore.excluded && statusOf(thanksScore, "seo.robots") === "INFO" && statusOf(thanksScore, "seo.indexable") === "INFO");
  ok("  and every score stays within 0–100", [thanksScore.seo.score, thanksScore.aeo.score, thanksScore.geo.score, thanksScore.overall].every((n) => n >= 0 && n <= 100));
  const emptyCategory = scoreCategory(GEO_CHECKS, thanks);
  ok("a category with nothing scored is 100, and says so", emptyCategory.score === 100 && !!emptyCategory.note, emptyCategory.note);

  // ── A post ───────────────────────────────────────────────────────────────────────────────────
  section("A post with an author, dates and schema");
  const post = inputFromPost(goodPost(), site, NOW);
  const postScore = scoreEntity(post);
  note(`SEO ${postScore.seo.score} · AEO ${postScore.aeo.score} · GEO ${postScore.geo.score} · overall ${postScore.overall} (${postScore.label})`);
  explain(postScore);
  const posting = post.jsonLd.find((o) => o["@type"] === "BlogPosting")!;
  ok("its JSON-LD: BlogPosting and BreadcrumbList", isDeepStrictEqual(types(post.jsonLd), ["BlogPosting", "BreadcrumbList"]), types(post.jsonLd));
  ok("  BlogPosting: headline, description, both dates, the author as a Person, the publisher", posting.headline === "How GST invoice numbering works" && !!posting.description && posting.datePublished === "2026-08-12T04:30:00.000Z" && posting.dateModified === "2026-09-20T09:00:00.000Z" && isDeepStrictEqual(posting.author, { "@type": "Person", name: "Asha Rao" }) && (posting.publisher as { name?: string }).name === "Deskzo One", posting);
  ok("  image (absolute), main category, tags as keywords, mainEntityOfPage", posting.image === "https://deskzo.test/media/cm0cover00000000000000001" && posting.articleSection === "Guides" && isDeepStrictEqual(posting.keywords, ["GST", "Invoicing"]) && isDeepStrictEqual(posting.mainEntityOfPage, { "@type": "WebPage", "@id": "https://deskzo.test/blog/gst-invoice-numbering" }));
  const crumbs = post.jsonLd.find((o) => o["@type"] === "BreadcrumbList")!.itemListElement as { name: string; item: string }[];
  ok("  the breadcrumb is the visible one — Blog › Guides › the post", isDeepStrictEqual(crumbs.map((c) => c.name), ["Blog", "Guides", "How GST invoice numbering works"]));
  ok("  author and date, freshness and structured data pass", ["aeo.author-dates", "geo.freshness", "geo.machine-readable", "seo.structured-data", "aeo.breadcrumbs"].every((id) => statusOf(postScore, id) === "PASS"), ["aeo.author-dates", "geo.freshness", "geo.machine-readable", "seo.structured-data", "aeo.breadcrumbs"].map((id) => `${id}:${statusOf(postScore, id)}`));
  ok("  its H1 is its title, and the issue points at the title field", post.content.h1s[0] === "How GST invoice numbering works" && find(postScore, "seo.h1")?.field === "title");
  ok("  a post's blocks are body[<id>]", post.content.paragraphs.some((p) => p.field === "body[p-1]"));

  const anon = inputFromPost({ ...goodPost(), author: null, cover: null, publishedAt: null, updatedAt: null, status: "draft" }, site, NOW);
  const anonLd = anon.jsonLd.find((o) => o["@type"] === "BlogPosting")!;
  const anonScore = scoreEntity(anon);
  ok("nothing invented: no author, no dates, no image in its BlogPosting", !("author" in anonLd) && !("datePublished" in anonLd) && !("dateModified" in anonLd) && !("image" in anonLd), anonLd);
  ok("  “Add author information to improve content attribution”", find(anonScore, "aeo.author-dates")?.recommendation === "Add author information to improve content attribution", find(anonScore, "aeo.author-dates"));
  ok("  structured-data completeness: BlogPosting without author and datePublished is incomplete", statusOf(anonScore, "geo.machine-readable") === "WARNING" && /author/.test(find(anonScore, "geo.machine-readable")!.message) && /datePublished/.test(find(anonScore, "geo.machine-readable")!.message));
  ok("  a draft is INFO, not on the site", !anon.live && statusOf(anonScore, "seo.status") === "INFO" && statusOf(anonScore, "seo.sitemap") === "NOT_APPLICABLE");
  const script = scoreEntity(inputFromPost({ ...goodPost(), author: "Script" }, site, NOW));
  ok("a generic author (“Script”) is a warning", statusOf(script, "aeo.author-dates") === "WARNING");
  const stale = scoreEntity(inputFromPost({ ...goodPost(), publishedAt: new Date("2023-01-10T00:00:00Z"), updatedAt: new Date("2024-01-10T00:00:00Z") }, site, NOW));
  ok("a post last updated over two years before `now` is due a review", statusOf(stale, "geo.freshness") === "WARNING" && /months ago/.test(find(stale, "geo.freshness")!.message));
  const scheduled = inputFromPost({ ...goodPost(), status: "scheduled", publishedAt: new Date("2026-10-05T00:00:00Z") }, site, NOW);
  ok("a post scheduled after `now` is not live yet", !scheduled.live && statusOf(scoreEntity(scheduled), "seo.status") === "INFO");

  // ── A category archive ───────────────────────────────────────────────────────────────────────
  section("A category archive");
  const cat = inputFromArchive(guidesArchive(), site, NOW);
  const catScore = scoreEntity(cat);
  note(`SEO ${catScore.seo.score} · AEO ${catScore.aeo.score} · GEO ${catScore.geo.score} · overall ${catScore.overall} (${catScore.label})`);
  explain(catScore);
  ok("its JSON-LD: CollectionPage and BreadcrumbList", isDeepStrictEqual(types(cat.jsonLd), ["CollectionPage", "BreadcrumbList"]));
  ok("  its H1 is its name, its description is its intro", cat.content.h1s[0] === "Guides" && cat.content.paragraphs[0]?.field === "description");
  ok("  enough text (its description), its own title and description", ["seo.content.length", "seo.title.present", "seo.description.present", "seo.canonical"].every((id) => statusOf(catScore, id) === "PASS"));
  ok("  its sharing image is its own", cat.meta.ogImageSource === "own" && cat.meta.ogImage?.alt === "Guides" && cat.meta.ogImage?.width === 1200);
  const page2 = inputFromArchive({ ...guidesArchive(), page: 2, pages: 2, total: 13 }, site, NOW);
  const page2Score = scoreEntity(page2);
  ok("page 2's canonical is its own address, and passes", page2.meta.canonical === "/blog/category/guides?page=2" && statusOf(page2Score, "seo.canonical") === "PASS" && page2.meta.title.startsWith("GST, payroll and accounting guides (page 2)"));
  ok("  and only the first page is in the sitemap", statusOf(page2Score, "seo.sitemap") === "NOT_APPLICABLE");
  const plainTag = inputFromArchive({ kind: "tag", slug: "gst", name: "GST", description: null, seo: null, image: null, posts: guidesArchive().posts, total: 1 }, site, NOW);
  const plainTagScore = scoreEntity(plainTag);
  ok("a tag with no description: its generated description is a warning, its missing intro too", statusOf(plainTagScore, "seo.description.present") === "WARNING" && statusOf(plainTagScore, "seo.content.length") === "WARNING" && plainTag.meta.description === "Posts tagged GST, from Deskzo One.");

  // ── The home page and the blog index ─────────────────────────────────────────────────────────
  section("The home page and the blog index");
  const home = inputFromPage({ ...DEFAULT_SITE_PAGES.find((p) => p.slug === "home")!, status: "default" }, site, NOW);
  const homeScore = scoreEntity(home);
  note(`home: SEO ${homeScore.seo.score} · AEO ${homeScore.aeo.score} · GEO ${homeScore.geo.score} · overall ${homeScore.overall} (${homeScore.label})`);
  explain(homeScore);
  const org = home.jsonLd.find((o) => o["@type"] === "Organization")!;
  ok("the home page is its own kind, with Organization and WebSite JSON-LD", home.kind === "home" && isDeepStrictEqual(types(home.jsonLd), ["Organization", "WebSite"]), types(home.jsonLd));
  ok("  Organization: name, address and social profiles — no logo (the site's is a letter mark)", org.name === "Deskzo One" && org.url === "https://deskzo.test/" && isDeepStrictEqual(org.sameAs, ["https://www.linkedin.com/company/deskzo"]) && !("logo" in org), org);
  ok("  entity identification is checked on it", ["PASS", "WARNING"].includes(statusOf(homeScore, "geo.entity")));
  ok("  its default status is INFO", statusOf(homeScore, "seo.status") === "INFO");
  ok("  the placeholder tagline counts as unset", site.tagline === null);
  const builtins = DEFAULT_SITE_PAGES.map((p) => inputFromPage({ ...p, status: "default" }, site, NOW));
  ok("every built-in page extracts with exactly one H1 (as check:site asserts of the rendered pages)", builtins.every((i) => i.content.h1s.length === 1), builtins.map((i) => `${i.path}:${i.content.h1s.length}`).join(" "));
  ok("  and the default pages have no content images (check:site: no <img>)", builtins.every((i) => i.content.images.length === 0));
  const blog = inputFromBlogIndex({ posts: guidesArchive().posts }, site, NOW);
  const blogScore = scoreEntity(blog);
  note(`blog index: SEO ${blogScore.seo.score} · AEO ${blogScore.aeo.score} · GEO ${blogScore.geo.score} · overall ${blogScore.overall}`);
  ok("the blog index's title and description are INFO: fixed in code", statusOf(blogScore, "seo.title.present") === "INFO" && find(blogScore, "seo.title.present")!.message.includes("fixed in code"));
  ok("  and the recommendation says what the CMS can and can't change", find(blogScore, "seo.title.present")!.recommendation.includes("The CMS changes the posts it lists, not its title or description"));
  ok("  it emits no JSON-LD (S-D1 names none for it)", blog.jsonLd.length === 0);
  ok("  its metadata is the site's: “Blog · Deskzo One”, canonical /blog", blog.meta.title === "Blog · Deskzo One" && blog.meta.canonical === "/blog" && blog.meta.twitterCard === "summary");

  // ── Keywords in the scores ───────────────────────────────────────────────────────────────────
  section("Missing, repeated and stuffed keywords");
  const noKw = scoreEntity(inputFromPage({ ...nearPerfectPage(), seo: { ...nearPerfectPage().seo, keywords: [] } }, site, NOW));
  const kwCheck = find(noKw, "seo.keywords.present")!;
  ok("no keywords: a WARNING, not a failure", kwCheck.status === "WARNING" && kwCheck.recommendation === "Add up to three primary keywords to get placement analysis", kwCheck);
  ok("  placement checks do not apply", ["seo.keyword.title", "seo.keyword.h1", "seo.keyword.stuffing", "seo.url.keyword"].every((id) => statusOf(noKw, id) === "NOT_APPLICABLE"));
  const dupKw = scoreEntity(inputFromPage({ ...nearPerfectPage(), seo: { ...nearPerfectPage().seo, keywords: ["GST invoice software", "gst invoice SOFTWARE"] } }, site, NOW));
  ok("repeated keywords: a warning naming the repeat", statusOf(dupKw, "seo.keywords.present") === "WARNING" && /repeats keyword 1/.test(find(dupKw, "seo.keywords.present")!.message));
  const stuffedPage = inputFromPage(
    {
      id: "p-stuffed",
      slug: "crm-software",
      title: "CRM",
      seo: { title: "CRM software for teams", description: "CRM software for growing teams in India: leads, calls, visits and a pipeline in one place, with reports.", keywords: ["CRM software"] },
      blocks: [
        block("s-h", "pageHeader", { heading: "CRM software", intro: "CRM software that your team will use." }),
        block("s-b", "richText", {
          content: [
            { type: "heading", level: 2, text: "Why CRM software?" },
            { type: "paragraph", text: "CRM software helps. Our CRM software is the CRM software for people who want CRM software. Buy CRM software today, because CRM software is CRM software and nothing else is CRM software." },
          ],
        }),
      ],
    },
    site,
    NOW,
  );
  const stuffedScore = scoreEntity(stuffedPage);
  const stuffing = find(stuffedScore, "seo.keyword.stuffing")!;
  ok("stuffing: a WARNING that loses its points", stuffing.status === "WARNING" && stuffing.pointsEarned === 0 && stuffing.pointsAvailable > 0, stuffing);
  ok("  GEO flags the repetition too", statusOf(stuffedScore, "geo.stuffing") === "WARNING");
  ok("  its density is reported", (stuffedScore.keywords[0]?.density ?? 0) > 3, stuffedScore.keywords[0]);
  const titleStuffed = scoreEntity(inputFromPage({ ...nearPerfectPage(), seo: { ...nearPerfectPage().seo, title: "GST invoice software | GST invoice software" } }, site, NOW));
  ok("the same keyword twice in the title is stuffing", statusOf(titleStuffed, "seo.keyword.stuffing") === "WARNING" && /title/.test(find(titleStuffed, "seo.keyword.stuffing")!.message));

  // ── Empty content ────────────────────────────────────────────────────────────────────────────
  section("Empty content");
  const empty = inputFromPage({ id: "p-empty", slug: "empty", title: "Empty", seo: { title: "An empty page on the site for testing", description: "Nothing here yet — a page with no blocks at all, to see that the engine copes with it." }, blocks: [] }, site, NOW);
  const emptyScore = scoreEntity(empty);
  ok("no blocks: no H1 and no text are critical failures", statusOf(emptyScore, "seo.h1") === "FAIL" && statusOf(emptyScore, "seo.content.length") === "FAIL" && find(emptyScore, "seo.content.length")!.severity === "critical");
  ok("  scores stay within 0–100 and nothing crashes", [emptyScore.seo.score, emptyScore.aeo.score, emptyScore.geo.score, emptyScore.overall].every((n) => Number.isInteger(n) && n >= 0 && n <= 100) && !allChecks(emptyScore).some((c) => c.message.startsWith("This check could not run")));
  ok("  its word count is 0 and it has no first section", empty.content.wordCount === 0 && empty.content.firstSection === "");
  const emptyPost = scoreEntity(inputFromPost({ ...goodPost(), body: [], excerpt: null }, site, NOW));
  ok("a post with an empty body is short of text", statusOf(emptyPost, "seo.content.length") === "WARNING" || statusOf(emptyPost, "seo.content.length") === "FAIL");

  // ── FAQ structured data ──────────────────────────────────────────────────────────────────────
  section("FAQ structured data only with a visible FAQ");
  const noFaq = inputFromPage({ ...nearPerfectPage(), blocks: nearPerfectPage().blocks.filter((b) => b.type !== "faq") }, site, NOW);
  ok("no FAQ block: no FAQPage", !types(noFaq.jsonLd).includes("FAQPage"));
  const faqItems = perfect.jsonLd.find((o) => o["@type"] === "FAQPage")!.mainEntity as { name: string; acceptedAnswer: { text: string } }[];
  ok("an FAQ block: FAQPage with the visible questions and answers", faqItems.length === 2 && faqItems[0].name === "Can I cancel an e-invoice?" && faqItems[0].acceptedAnswer.text === "Yes, within 24 hours of registering it on the portal. After that, issue a credit note instead.");
  const unanswered = inputFromPage({ ...nearPerfectPage(), blocks: [block("f", "faq", { heading: "Questions", items: [{ question: "Is it free?", answer: [] }] })] }, site, NOW);
  ok("an FAQ with a question and no answer: no FAQPage", !types(unanswered.jsonLd).includes("FAQPage") && faqPageLd([{ question: "Q?", answer: " " }]) === null);
  const injected: SeoInput = { ...noFaq, jsonLd: [...noFaq.jsonLd, faqPageLd([{ question: "Invented?", answer: "Yes." }])!] };
  const injectedCheck = find(scoreEntity(injected), "aeo.faq")!;
  ok("FAQPage without a visible FAQ is a critical failure", injectedCheck.status === "FAIL" && injectedCheck.severity === "critical");
  const tokenFaq = inputFromPage({ ...nearPerfectPage(), blocks: [block("f", "faq", { heading: "Trial", items: [{ question: "How long is the trial?", answer: ["{trialDays} days."] }] })] }, site, NOW);
  ok("FAQ answers are the visible text, tokens filled", (tokenFaq.jsonLd.find((o) => o["@type"] === "FAQPage")!.mainEntity as { acceptedAnswer: { text: string } }[])[0].acceptedAnswer.text === "14 days.");

  // ── Structured-data completeness ─────────────────────────────────────────────────────────────
  section("Structured-data completeness");
  const noLdSite = { ...site, emitsJsonLd: false };
  const noLd = scoreEntity(inputFromPage(nearPerfectPage(), noLdSite, NOW));
  ok("a site that emits no JSON-LD: structured data FAILs in SEO and GEO", statusOf(noLd, "seo.structured-data") === "FAIL" && statusOf(noLd, "geo.machine-readable") === "FAIL");
  ok("  and the recommendation says the CMS can't turn it on", /nothing in the CMS turns it on/.test(find(noLd, "seo.structured-data")!.recommendation));
  const partial: SeoInput = { ...perfect, jsonLd: perfect.jsonLd.filter((o) => o["@type"] !== "BreadcrumbList") };
  ok("a missing BreadcrumbList is a partial warning", statusOf(scoreEntity(partial), "seo.structured-data") === "WARNING");
  ok("every page kind's JSON-LD is complete when content is", ["geo.machine-readable"].every((id) => statusOf(perfectScore, id) === "PASS" && statusOf(postScore, id) === "PASS" && statusOf(catScore, id) === "PASS"));

  // ── The comparison table, related links and page map ─────────────────────────────────────────
  section("New blocks: the comparison table, related links and the page map");
  const comparePage = (): Parameters<typeof inputFromPage>[0] => ({
    id: "page-compare",
    slug: "compare/zoho-one",
    title: "{siteName} vs Zoho One",
    status: "published",
    seo: { title: "Zoho One vs Deskzo One", description: "How Deskzo One and Zoho One compare, feature by feature, from each product's own public information.", keywords: ["Zoho One alternative"] },
    blocks: [
      block("c-head", "pageHeader", { heading: "{siteName} and Zoho One compared", intro: "What each product offers for an Indian company, side by side." }),
      block("c-table", "comparisonTable", {
        heading: "Zoho One vs {siteName}, feature by feature",
        intro: "Each answer about Zoho One comes from its own website.",
        competitor: "Zoho One",
        asOf: "2026-09-29",
        rows: [
          { feature: "GST e-invoicing", us: "yes", them: "YES", source: "https://www.zoho.com/in/books/e-invoicing/" },
          { feature: "Payroll", us: "yes", them: "partial", note: "Zoho Payroll is a separate app.", source: "https://zoho.com/in/payroll/" },
          { feature: "Price for 10 people", us: "From {trialDays} days free", them: "no" },
          { feature: "Hostile source", us: "no", them: "no", source: "javascript:alert(1)" },
        ],
        disclaimer: "Product names and trademarks belong to their owners.",
      }),
      block("c-related", "relatedLinks", {
        heading: "Related pages",
        links: [
          { label: "Plans and pricing", href: "/pricing", description: "What each plan includes." },
          { label: "Tally compared", href: "/compare/tally" },
          { label: "Somewhere else", href: "https://example.com/elsewhere" },
        ],
      }),
      block("c-map", "moduleHighlights", {
        heading: "Everything in the product",
        groups: [
          { title: "Sell and serve", items: [{ label: "CRM", href: "/product/crm", description: "Companies, contacts and leads." }] },
          { title: "Only elsewhere", items: [{ label: "Out", href: "https://example.com/out", description: "Not a page on this site." }] },
        ],
      }),
    ],
  });
  const cmp = inputFromPage({ ...comparePage(), parents: [{ name: "Compare", path: "/compare" }] }, site, NOW);
  const cmpTable = cmp.content.tables[0];
  ok("the comparison table is read as a table: a column per product and a row per feature", cmp.content.tables.length === 1 && isDeepStrictEqual(cmpTable?.columns, ["Feature", "Deskzo One", "Zoho One"]) && cmpTable?.rows === 4, cmpTable);
  ok(
    "  each answer as the page shows it — Yes, Partly, No, or the words (tokens filled); a row's note with its feature",
    ["GST e-invoicing", "Yes", "Partly", "No", "From 14 days free", "Payroll. Zoho Payroll is a separate app."].every((s) => cmpTable?.text.split("\n").includes(s)),
    cmpTable?.text,
  );
  const external = cmp.content.links.filter((l) => !l.internal);
  ok(
    "  each source an external link named by its site (www. dropped); a javascript: source is no link",
    isDeepStrictEqual(
      external.map((l) => `${l.label} ${l.href}`),
      ["zoho.com https://www.zoho.com/in/books/e-invoicing/", "zoho.com https://zoho.com/in/payroll/"],
    ),
    external,
  );
  ok("  its heading an h2; the as-of line and the disclaimer are paragraphs", cmp.content.headings.some((h) => h.level === 2 && h.text === "Zoho One vs Deskzo One, feature by feature") && cmp.content.paragraphs.some((p) => p.text === "Information about Zoho One from its public website as of 29 September 2026.") && cmp.content.paragraphs.some((p) => p.text === "Product names and trademarks belong to their owners."));
  const internal = cmp.content.links.filter((l) => l.internal).map((l) => `${l.label} ${l.href}`);
  ok("related links and the page map are internal links with their words — any other address is left out, as the site leaves it out", isDeepStrictEqual(internal, ["Plans and pricing /pricing", "Tally compared /compare/tally", "CRM /product/crm"]), internal);
  ok("  the page map's groups are h3s under its h2 (a group with no page on this site shows nothing)", isDeepStrictEqual(cmp.content.headings.filter((h) => h.level === 3).map((h) => h.text), ["Sell and serve"]) && cmp.content.headings.some((h) => h.level === 2 && h.text === "Everything in the product"));
  ok("  each block's content points at its block", cmpTable?.field === "blocks[c-table]" && cmp.content.links.find((l) => l.href === "/product/crm")?.field === "blocks[c-map]");
  ok("no new JSON-LD types, and no FAQPage without an FAQ block: WebPage and BreadcrumbList", isDeepStrictEqual(types(cmp.jsonLd), ["WebPage", "BreadcrumbList"]), types(cmp.jsonLd));
  const cmpCrumbs = (cmp.jsonLd.find((o) => o["@type"] === "BreadcrumbList")?.itemListElement ?? []) as { name: string; item: string }[];
  ok(
    "a nested page's trail is its breadcrumb: Home › the page above › itself by its title (tokens filled)",
    cmpCrumbs.map((c) => `${c.name} ${c.item}`).join(" | ") === "Home https://deskzo.test/ | Compare https://deskzo.test/compare | Deskzo One vs Zoho One https://deskzo.test/compare/zoho-one",
    cmpCrumbs,
  );
  ok("  the visible breadcrumb is kept apart from the content, the page left off", isDeepStrictEqual(cmp.content.breadcrumbs, [{ name: "Home", path: "/" }, { name: "Compare", path: "/compare" }]));
  const orphan = inputFromPage(comparePage(), site, NOW);
  ok(
    "  with no page above it, Home › itself; a page that isn't nested keeps Home › its H1",
    ((orphan.jsonLd[1]?.itemListElement ?? []) as { name: string }[]).map((c) => c.name).join(" › ") === "Home › Deskzo One vs Zoho One" &&
      ((perfect.jsonLd[1]?.itemListElement ?? []) as { name: string }[]).map((c) => c.name).join(" › ") === "Home › GST invoice software for growing Indian companies" &&
      perfect.content.breadcrumbs.length === 0,
  );
  const cmpScore = scoreEntity(cmp);
  ok("the checks read them: the comparison has its table, the links' words say where they go, the sources count", statusOf(cmpScore, "aeo.tables") === "PASS" && statusOf(cmpScore, "seo.links.anchor-text") === "PASS" && statusOf(cmpScore, "seo.links.internal") === "PASS", `${statusOf(cmpScore, "aeo.tables")} ${statusOf(cmpScore, "seo.links.anchor-text")} ${statusOf(cmpScore, "seo.links.internal")}`);

  // Parity with the renderer: what the extractor reads is what the block components put on the page.
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const { createElement } = require("react") as typeof import("react");
  const { ComparisonTableBlock } = require("../src/components/site/blocks/comparison-table") as typeof import("../src/components/site/blocks/comparison-table");
  const { RelatedLinksBlock } = require("../src/components/site/blocks/related-links") as typeof import("../src/components/site/blocks/related-links");
  const { ModuleHighlightsBlock } = require("../src/components/site/blocks/module-highlights") as typeof import("../src/components/site/blocks/module-highlights");
  const renderCtx = { settings, signupOpen: true, trialDays: 14, searchParams: {}, workspaceSuffix: ".deskzo.test" };
  const blocksOf = comparePage().blocks;
  // The fixture's own props for a block type, handed to that type's component.
  const propsOf = (type: SiteBlock["type"]) => blocksOf.find((b) => b.type === type)!.props as never;
  const renderedHtml = [
    renderToStaticMarkup(createElement(ComparisonTableBlock, { props: propsOf("comparisonTable"), ctx: renderCtx })),
    renderToStaticMarkup(createElement(RelatedLinksBlock, { props: propsOf("relatedLinks"), ctx: renderCtx })),
    renderToStaticMarkup(createElement(ModuleHighlightsBlock, { props: propsOf("moduleHighlights"), ctx: renderCtx })),
  ].join("\n");
  const unescape = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const anchors = [...renderedHtml.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ href: unescape(m[1]), text: unescape(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() }));
  const renderedHrefs = anchors.map((a) => a.href).sort();
  const extractedHrefs = cmp.content.links.map((l) => l.href).sort();
  ok("parity: the links rendered are exactly the links extracted, each rendered with its extracted words", isDeepStrictEqual(renderedHrefs, extractedHrefs) && cmp.content.links.every((l) => anchors.some((a) => a.href === l.href && a.text.startsWith(l.label))), { renderedHrefs, extractedHrefs });
  const renderedText = unescape(renderedHtml.replace(/<[^>]+>/g, "\n")).split("\n").map((s) => s.trim()).filter(Boolean).join(" ");
  const missingText = [...cmp.content.headings.filter((h) => h.field !== "blocks[c-head]").map((h) => h.text), ...cmp.content.paragraphs.filter((p) => p.field !== "blocks[c-head]").map((p) => p.text), ...(cmpTable?.columns ?? [])].filter((s) => !renderedText.includes(s));
  ok("  every heading, paragraph and column extracted is on the rendered page", missingText.length === 0, missingText);
  ok(
    "  a source link is nofollow, noopener and noreferrer; the table has a caption, column and row headers",
    anchors.filter((a) => a.href.startsWith("https://")).length === 2 &&
      (renderedHtml.match(/rel="nofollow noopener noreferrer"/g) ?? []).length === 2 &&
      /<caption[^>]*>/.test(renderedHtml) &&
      (renderedHtml.match(/scope="col"/g) ?? []).length === 3 &&
      (renderedHtml.match(/scope="row"/g) ?? []).length === 4,
  );
  ok("  a mark is a word as well as an icon: Yes, Partly and No are on the page", ["Yes", "Partly", "No"].every((w) => new RegExp(`>${w}<`).test(renderedHtml)) && !renderedHtml.includes("javascript:"));

  // ── Labels and weights ───────────────────────────────────────────────────────────────────────
  section("Label bands and the overall weighting");
  const bands: [number, string][] = [
    [0, "Poor"],
    [39, "Poor"],
    [40, "Needs improvement"],
    [59, "Needs improvement"],
    [60, "Good"],
    [79, "Good"],
    [80, "Excellent"],
    [100, "Excellent"],
    [-3, "Poor"],
    [Number.NaN, "Poor"],
  ];
  for (const [n, label] of bands) ok(`${n} is ${label}`, labelFor(n) === label, labelFor(n));
  ok("WEIGHTS are 50/25/25", WEIGHTS.seo === 0.5 && WEIGHTS.aeo === 0.25 && WEIGHTS.geo === 0.25);
  ok("overall = round(0.5 × SEO + 0.25 × AEO + 0.25 × GEO): 80/40/60 → 65", overallScore({ seo: 80, aeo: 40, geo: 60 }) === 65);
  ok("  rounds: 81/40/60 → 65.5 → 66", overallScore({ seo: 81, aeo: 40, geo: 60 }) === 66);
  ok("  configurable: equal weights 80/40/60 → 60", overallScore({ seo: 80, aeo: 40, geo: 60 }, { seo: 1, aeo: 1, geo: 1 }) === 60);
  for (const [label, s] of [["near-perfect page", perfectScore], ["missing metadata", bareScore], ["post", postScore], ["archive", catScore], ["home", homeScore]] as const) {
    ok(`  ${label}: overall is the weighted mean of its three`, s.overall === Math.round(0.5 * s.seo.score + 0.25 * s.aeo.score + 0.25 * s.geo.score), `${s.seo.score}/${s.aeo.score}/${s.geo.score} → ${s.overall}`);
  }
  const sum = (checks: CheckResult[], k: "pointsEarned" | "pointsAvailable") => checks.reduce((n, c) => n + c[k], 0);
  ok("  a category's score is 100 × earned ÷ available, over scored checks only", bareScore.seo.score === Math.round((100 * sum(bareScore.seo.checks, "pointsEarned")) / sum(bareScore.seo.checks, "pointsAvailable")));
  ok("  INFO and NOT_APPLICABLE carry no points either way", allChecks(signupScore).every((c) => (c.status === "INFO" || c.status === "NOT_APPLICABLE" ? c.pointsAvailable === 0 && c.pointsEarned === 0 : true)));

  // ── Fuzz ─────────────────────────────────────────────────────────────────────────────────────
  section("Every score within 0–100 (fixed-seed fuzz)");
  const rand = mulberry32(20260929);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const WORDS = ["GST", "invoice", "the", "best", "#1", "40%", "₹1,200", "2025", "</script>", "é", "你好", "", " ", "It", "This", "What is it?", "click here", "https://x.test", "Deskzo One", "deskzo-one", "{siteName}", "{trialDays}", String.fromCharCode(0)];
  const text = (max = 30) => Array.from({ length: Math.floor(rand() * max) }, () => pick(WORDS)).join(pick([" ", " ", ". ", "? ", ""]));
  const junk = (): unknown => pick([null, undefined, 42, true, [], {}, text(), [text(), 7], { text: text() }]);
  const href = () => pick(["/pricing", "#top", "https://example.com/x", "javascript:alert(1)", "//evil.test", "mailto:a@b.co", "", text(3)]);
  const media = () => pick([{ kind: "image", src: pick(["/media/cm0abc00000000000000000001", "https://cdn.test/a.png", "data:x", ""]), alt: pick(["", "IMG_2044.jpg", text(6)]) }, { kind: "preview", preview: "pipeline" }, junk()]);
  const rich = () => pick([
    { type: "heading", level: pick([2, 3, 4]), text: text(8) },
    { type: "paragraph", text: pick([text(), [{ text: text(), href: href() }, { text: text() }]]) },
    { type: "list", items: [text(8), [{ text: text(5), href: href() }]] },
    { type: "table", columns: [text(2), text(2)], rows: [[text(3), text(3)], junk()] },
    { type: "note", tone: "info", text: text() },
    junk(),
  ]);
  const randomBlock = (i: number): unknown => {
    const type = pick([
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
      "unknownBlock",
    ]);
    const props = {
      heading: text(8),
      eyebrow: text(3),
      intro: text(),
      subheading: text(),
      body: pick([text(), [text(), text()], junk()]),
      items: pick([[{ title: text(4), body: text(), question: text(6), answer: [text()], value: "12", label: text(3), name: text(2), imageUrl: pick(["/media/cm0abc00000000000000000001", ""]), href: href(), icon: "check", link: { label: text(2), href: href() } }], junk()]),
      groups: pick([[{ title: text(3), summary: text(), modules: [{ label: text(2), blurb: text() }], items: pick([[{ label: text(2), href: href(), description: text() }], junk()]) }], junk()]),
      competitor: pick([text(2), junk()]),
      asOf: pick(["2026-09-29", "2026-02-30", "", text(1), junk()]),
      rows: pick([[{ feature: text(3), us: pick(["yes", "partial", "no", text(2), junk()]), them: pick(["YES", "Partial", text(2)]), note: pick([undefined, text()]), source: href() }, junk()], junk()]),
      links: pick([[{ label: text(2), href: href(), description: pick([undefined, text()]) }, junk()], junk()]),
      disclaimer: pick([text(), junk()]),
      content: pick([Array.from({ length: Math.floor(rand() * 6) }, rich), junk()]),
      primary: pick([{ kind: "signup" }, { kind: "link", label: text(2), href: href() }, junk()]),
      media: media(),
      quote: text(),
      notice: pick([{ tone: "info", text: text() }, junk()]),
      aside: pick([[{ title: text(2), body: text(), link: { label: text(2), href: href() } }], junk()]),
      asideItems: pick([[text(), text()], junk()]),
    };
    return pick([{ id: `r${i}`, type, props }, { id: `r${i}`, type, props: junk() }, { type, props }, junk()]);
  };
  let fuzzed = 0;
  let bad: string | null = null;
  for (let i = 0; i < 400 && !bad; i++) {
    const kind = pick(["page", "home", "post", "category", "tag", "blog"] as const);
    const fuzzSite = { ...site, aiSearchCrawlersAllowed: rand() < 0.5, emitsJsonLd: rand() < 0.8, livePostCount: Math.floor(rand() * 3), redirectedPaths: rand() < 0.1 ? ["/fuzz"] : [] };
    const blocks = Array.from({ length: Math.floor(rand() * 8) }, (_, j) => randomBlock(j)) as SiteBlock[];
    const seo = { title: pick([text(8), "", "x".repeat(200)]), description: pick([text(), "", "y".repeat(400)]), noindex: rand() < 0.2, absoluteTitle: rand() < 0.2, ogImage: pick([undefined, "", "/media/cm0abc00000000000000000001", "javascript:x"]), keywords: pick([[], [text(2)], [text(2), text(2), text(2), text(2)], junk()]) };
    let input: SeoInput;
    if (kind === "page" || kind === "home") input = inputFromPage({ slug: kind === "home" ? "home" : pick(["fuzz", "pricing", "security", "signup", "a/b-c"]), title: text(3), seo, blocks, status: pick(["published", "draft", "default"] as const) }, fuzzSite, NOW);
    else if (kind === "post") {
      input = inputFromPost(
        { slug: "fuzz", title: text(6), excerpt: pick([null, text()]), cover: pick([null, { src: "/media/cm0abc00000000000000000001", alt: text(3) }]), body: blocks, seo: pick([null, seo]), author: pick([null, "Script", text(2)]), publishedAt: pick([null, NOW, new Date("2020-01-01T00:00:00Z"), new Date(Number.NaN)]), updatedAt: pick([null, NOW]), categories: pick([[], [{ slug: "a", name: text(2), path: "/blog/category/a" }]]), tagLinks: [], status: pick(["published", "draft", "scheduled"] as const) },
        fuzzSite,
        NOW,
      );
    } else if (kind === "blog") input = inputFromBlogIndex({ posts: pick([[], guidesArchive().posts]) }, fuzzSite, NOW);
    else input = inputFromArchive({ kind, slug: "fuzz", name: text(3), description: pick([null, text()]), seo: pick([null, seo, junk()]), image: pick([null, { src: "/media/cm0abc00000000000000000001", alt: "", width: null, height: null }]), posts: pick([[], guidesArchive().posts]), total: Math.floor(rand() * 3), page: pick([1, 2]) }, fuzzSite, NOW);
    const s = scoreEntity(input);
    fuzzed += 1;
    const scores = [s.seo.score, s.aeo.score, s.geo.score, s.overall];
    const crashed = allChecks(s).find((c) => c.message.startsWith("This check could not run"));
    const overpaid = allChecks(s).find((c) => c.pointsEarned > c.pointsAvailable || c.pointsEarned < 0 || !Number.isFinite(c.pointsEarned));
    if (!scores.every((n) => Number.isInteger(n) && n >= 0 && n <= 100)) bad = `case ${i}: scores ${scores.join("/")}`;
    else if (crashed) bad = `case ${i}: ${crashed.id} ${crashed.message}`;
    else if (overpaid) bad = `case ${i}: ${overpaid.id} earned ${overpaid.pointsEarned}/${overpaid.pointsAvailable}`;
    else if (labelFor(s.overall) !== s.label) bad = `case ${i}: label ${s.label} for ${s.overall}`;
    else if (serialiseLd(input.jsonLd).includes("<")) bad = `case ${i}: serialised JSON-LD holds a "<"`;
  }
  ok(`${fuzzed} random pages, posts, archives and blog indexes: every score an integer in 0–100, no check crashed, no check overpaid`, !bad, bad ?? "");

  // ── Determinism ──────────────────────────────────────────────────────────────────────────────
  section("Determinism");
  ok("the same input scores the same twice", isDeepStrictEqual(scoreEntity(perfect), scoreEntity(perfect)));
  ok("the same source extracts and scores the same twice", isDeepStrictEqual(scoreEntity(inputFromPost(goodPost(), site, NOW)), scoreEntity(inputFromPost(goodPost(), site, NOW))));
  ok("  byte for byte", JSON.stringify(scoreEntity(inputFromArchive(guidesArchive(), site, NOW))) === JSON.stringify(scoreEntity(inputFromArchive(guidesArchive(), site, NOW))));
  ok("the registries hold unique ids", new Set([...SEO_CHECKS, ...AEO_CHECKS, ...GEO_CHECKS].map((c) => c.id)).size === SEO_CHECKS.length + AEO_CHECKS.length + GEO_CHECKS.length);

  // ── Duplicates across the site ───────────────────────────────────────────────────────────────
  section("Duplicates across the site");
  const twin = inputFromPage({ ...nearPerfectPage(), id: "page-twin", slug: "gst-software" }, site, NOW);
  const [p1, p2] = crossReference([perfect, twin]);
  const twinScore = scoreEntity(p2);
  ok("two pages with the same title: FAIL, naming the other page", statusOf(twinScore, "seo.title.unique") === "FAIL" && find(twinScore, "seo.title.unique")!.message.includes("/gst-invoice-software"));
  ok("  the same description and H1: a GEO warning", statusOf(twinScore, "geo.duplicates") === "WARNING");
  ok("  a page is never its own duplicate", statusOf(scoreEntity(crossReference([perfect])[0]), "seo.title.unique") === "PASS" && p1.site.others.length === 2);

  // ── The site score ───────────────────────────────────────────────────────────────────────────
  section("The site score");
  const fake = (overall: number, excluded = false): EntityScore => {
    const bd = (score: number) => ({ score, maxScore: 100 as const, checks: [], note: null });
    return { seo: bd(overall), aeo: bd(overall), geo: bd(overall), overall, label: labelFor(overall), excluded, critical: 1, warnings: 0, keywords: [] };
  };
  const entry = (kind: SiteScoreEntry["kind"], slug: string, isBuiltin: boolean, overall: number, extra: Partial<SiteScoreEntry> = {}): SiteScoreEntry => ({ id: slug, kind, slug, path: `/${slug}`, isBuiltin, live: true, keywords: ["k"], jsonLdTypes: kind === "home" ? ["Organization", "WebSite"] : [], score: fake(overall), ...extra });
  const entries: SiteScoreEntry[] = [
    entry("home", "home", true, 90),
    entry("page", "pricing", true, 70),
    entry("page", "terms", true, 50),
    entry("post", "a-post", false, 40),
    entry("category", "guides", false, 20),
    entry("page", "thank-you", false, 0, { score: fake(0, true) }),
    entry("page", "draft", false, 0, { live: false }),
  ];
  const meta = { aiSearchCrawlersAllowed: false, defaultOgImage: null, titleTemplate: "%s · Deskzo One", siteName: "Deskzo One" };
  const ss = siteScore(entries, meta);
  const expected = Math.round((3 * 90 + 2 * 70 + 1 * 50 + 1 * 40 + 0.5 * 20) / (3 + 2 + 1 + 1 + 0.5));
  ok(`weighted: home ×3, built-in marketing ×2, other pages and posts ×1, archives ×½ → ${expected}`, ss.overall === expected && ss.seo === expected, ss.overall);
  ok("  not the blind average of every entity", ss.overall !== Math.round(entries.reduce((n, e) => n + e.score.overall, 0) / entries.length));
  ok("  the noindex page and the draft are left out, and counted apart", ss.counts.scored === 5 && ss.counts.excluded === 1 && ss.counts.notLive === 1, ss.counts);
  ok("  needing attention (under 60): terms, the post and the archive", ss.counts.needsAttention === 3);
  ok("  critical issues summed over the scored ones", ss.counts.critical === 5);
  ok("  the distribution counts the scored ones by label", ss.distribution.Excellent === 1 && ss.distribution.Good === 1 && ss.distribution["Needs improvement"] === 2 && ss.distribution.Poor === 1, ss.distribution);
  const sc = Object.fromEntries(ss.siteChecks.map((c) => [c.id, c.status]));
  ok("site-level checks: AI crawlers blocked FAIL, Organization on home PASS, no default image and a good template", sc["site.ai-crawlers"] === "FAIL" && sc["site.organization"] === "PASS" && sc["site.og-default"] === "WARNING" && sc["site.title-template"] === "PASS", sc);
  ok("no entities: every score 0, nothing divided by zero", siteScore([], meta).overall === 0 && siteScore([], meta).weight === 0);
  const real = crossReference([perfect, bare, post, cat, home, signup]);
  const realSite = siteScore(
    real.map((i) => siteEntry(i, scoreEntity(i))),
    meta,
  );
  ok("from real entities: missing metadata counted once (the bare page), signup excluded", realSite.counts.missingMetadata === 1 && realSite.counts.excluded === 1, realSite.counts);

  // ── serialiseLd ──────────────────────────────────────────────────────────────────────────────
  section("serialiseLd");
  const hostile = { name: "</script><script>alert(1)</script>", note: "Tom & Jerry <b>", sep: `a${String.fromCharCode(0x2028)}b` };
  const out = serialiseLd(hostile);
  const bs = String.fromCharCode(92);
  ok("no “<”, “>” or “&” survives", !/[<>&]/.test(out), out);
  ok("  they are JSON unicode escapes", out.includes(`${bs}u003c/script${bs}u003e`) && out.includes(`${bs}u0026`), out);
  ok("  the line separator is escaped too", out.includes(`${bs}u2028`) && !out.includes(String.fromCharCode(0x2028)));
  ok("  JSON.parse gives back exactly the original", isDeepStrictEqual(JSON.parse(out), hostile));
  ok("  undefined serialises as null", serialiseLd(undefined) === "null");

  // ── Metadata parity ──────────────────────────────────────────────────────────────────────────
  await parity(DEFAULT_SITE_PAGES, DEFAULT_SITE_SETTINGS);

  section("Summary");
  for (const [name, c] of Object.entries(counts)) if (name !== "Summary") note(`${name}: ${c.ok} ok${c.fail ? `, ${c.fail} failed` : ""}`);
}

/** URLs as their address, undefined kept apart from missing — so two Metadata objects compare field for field, in order. */
function canon(v: unknown): unknown {
  if (v instanceof URL) return { URL: v.href };
  if (v instanceof Date) return { Date: v.toISOString() };
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.entries(v).map(([k, x]) => [k, x === undefined ? "<undefined>" : canon(x)]);
  return v;
}
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

async function parity(pages: SitePage[], defaults: SiteSettings) {
  section("Metadata parity with the site's own generateMetadata");
  const internals = Module as unknown as { _load(request: string, parent: { filename?: string } | undefined, isMain: boolean): unknown };
  const originalLoad = internals._load;
  const { PLATFORM_DOMAIN } = require("../src/lib/tenancy/host") as typeof import("../src/lib/tenancy/host");
  const host = PLATFORM_DOMAIN;
  const fixturePost = {
    slug: "gst-invoice-numbering",
    path: "/blog/gst-invoice-numbering",
    title: "How GST invoice numbering works",
    excerpt: "One series per registration and financial year.",
    cover: { src: "/media/cm0cover00000000000000001", alt: "An invoice register", width: 1600, height: 900 },
    tags: ["gst"],
    categories: [{ slug: "guides", name: "Guides", path: "/blog/category/guides" }],
    tagLinks: [{ slug: "gst", name: "GST", path: "/blog/tag/gst" }],
    publishedAt: new Date("2026-08-12T04:30:00Z"),
    author: "Asha Rao",
    body: [],
    seo: { title: "GST invoice numbering rules explained", noindex: false },
    updatedAt: new Date("2026-09-20T09:00:00Z"),
  };
  let postStubbed = 0;
  internals._load = function (this: unknown, request: string, parent: { filename?: string } | undefined, isMain: boolean) {
    if (request === "next/headers" || request.endsWith(`${path.sep}next${path.sep}headers.js`)) {
      return { headers: async () => new Headers({ host }), cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }) };
    }
    if (request === "next/navigation") {
      return {
        notFound: () => {
          throw new Error("notFound");
        },
        redirect: (to: string) => {
          throw new Error(`redirect ${to}`);
        },
        useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
        usePathname: () => "/",
        useSearchParams: () => new URLSearchParams(),
      };
    }
    if (request === "@/lib/platform/site-content" && parent?.filename?.includes(`${path.sep}blog${path.sep}[slug]${path.sep}`)) {
      const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
      return {
        ...real,
        getPublishedPost: async (slug: string) => {
          postStubbed += 1;
          return slug === fixturePost.slug ? fixturePost : null;
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  } as typeof originalLoad;

  try {
    const pageView = require("../src/components/site/page-view") as typeof import("../src/components/site/page-view");
    const { requestHost, protocolFor } = require("../src/lib/tenancy/host") as typeof import("../src/lib/tenancy/host");
    const ctx = { settings: defaults, trialDays: 14 };
    for (const page of pages) {
      const theirs = await pageView.sitePageMetadata(page.slug);
      const ours = buildPageMetadata(page, ctx);
      ok(`/${page.slug === "home" ? "" : page.slug}: buildPageMetadata equals sitePageMetadata`, same(ours, theirs) && isDeepStrictEqual(ours, theirs), same(ours, theirs) ? "" : { ours: canon(ours), theirs: canon(theirs) });
      const eff = effectiveMetadata(ours, layoutView(ctx));
      const expectedTitle = page.seo.absoluteTitle ? (theirs.title as { absolute: string }).absolute : `${theirs.title as string} · Deskzo One`;
      if (page.slug === "pricing" || page.slug === "home") ok(`  its HTML title: ${quote(expectedTitle)}`, eff.title === expectedTitle, eff.title);
    }
    ok("an address with no page: buildNotFoundMetadata equals sitePageMetadata", same(buildNotFoundMetadata(ctx), await pageView.sitePageMetadata("no-such-page-here")));
    const h = requestHost(new Headers({ host }));
    const origin = typeof h === "string" && h ? new URL(`${protocolFor(h)}://${h}`) : undefined;
    const layoutTheirs = await pageView.siteLayoutMetadata();
    ok("the layout: buildLayoutMetadata equals siteLayoutMetadata (metadataBase included)", same(buildLayoutMetadata(ctx, origin), layoutTheirs), same(buildLayoutMetadata(ctx, origin), layoutTheirs) ? "" : { ours: canon(buildLayoutMetadata(ctx, origin)), theirs: canon(layoutTheirs) });

    const blogRoute = require("../src/app/platform-site/blog/page") as { generateMetadata: () => Promise<Metadata> };
    ok("the blog index: buildBlogIndexMetadata equals its generateMetadata", same(buildBlogIndexMetadata(defaults), await blogRoute.generateMetadata()));

    const archiveView = require("../src/app/platform-site/blog/archive-view") as typeof import("../src/app/platform-site/blog/archive-view");
    const archives = [
      { kind: "category" as const, name: "Guides", page: 1, canonical: "/blog/category/guides", seo: { title: "Guides", description: "Step-by-step guides.", image: { src: "/media/cm0guides0000000000000001", alt: "Guides", width: 1200, height: 630 } } },
      { kind: "category" as const, name: "Guides", page: 3, canonical: "/blog/category/guides?page=3", seo: { title: "Guides", description: null, image: { src: "/media/cm0guides0000000000000001", alt: "", width: null, height: null } } },
      { kind: "tag" as const, name: "GST", page: 1, canonical: "/blog/tag/gst", seo: { title: "GST", description: null, image: null } },
    ];
    for (const a of archives) {
      const theirs = await archiveView.archiveMetadata({ ...a, slug: "x", description: null, path: a.canonical.split("?")[0], posts: [], total: 1, pages: 3, prev: null, next: null, parent: null, children: [] } as never);
      const ours = buildArchiveMetadata(a, defaults);
      ok(`an archive (${a.kind}, page ${a.page}, ${a.seo.image ? "own image" : "no image"}): buildArchiveMetadata equals archiveMetadata`, same(ours, theirs), same(ours, theirs) ? "" : { ours: canon(ours), theirs: canon(theirs) });
    }
    ok("no archive: “Not found” both ways", same(buildArchiveMetadata(null, defaults), await archiveView.archiveMetadata(null)));

    const postRoute = require("../src/app/platform-site/blog/[slug]/page") as { generateMetadata: (p: { params: Promise<{ slug: string }> }) => Promise<Metadata> };
    const theirsPost = await postRoute.generateMetadata({ params: Promise.resolve({ slug: fixturePost.slug }) });
    ok("set-up: the post route read the stubbed post", postStubbed === 1, postStubbed);
    ok("a post: buildPostMetadata equals its generateMetadata", same(buildPostMetadata(fixturePost), theirsPost), same(buildPostMetadata(fixturePost), theirsPost) ? "" : { ours: canon(buildPostMetadata(fixturePost)), theirs: canon(theirsPost) });
    ok("no post: “Not found” both ways", same(buildPostMetadata(null), await postRoute.generateMetadata({ params: Promise.resolve({ slug: "missing-post" }) })));
  } catch (err) {
    ok("the site's metadata functions load and run without a database", false, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  } finally {
    internals._load = originalLoad;
  }
}

const quote = (s: string) => `“${s}”`;

main()
  .catch((err) => {
    ok("the suite ran to the end", false, err instanceof Error ? (err.stack ?? err.message) : String(err));
  })
  .finally(() => {
    process.stdout.write(`\n${failures ? `${failures} FAILED` : "all passed"}\n`);
    process.exit(failures ? 1 : 0);
  });
