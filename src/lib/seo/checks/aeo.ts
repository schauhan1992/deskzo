import {
  ALL_KINDS,
  answerUnder,
  bodyField,
  CONTENT_KINDS,
  fail,
  headingProblems,
  info,
  isForm,
  isInformational,
  isLegal,
  notApplicable,
  pass,
  primaryKeyword,
  questionHeadings,
  seoField,
  topicOf,
  warn,
} from "@/lib/seo/checks/util";
import { countWords, hasPhrase, istDay, plural, quote, sentences, share, sharedWords, squash } from "@/lib/seo/text";
import type { CheckDef, SeoInput } from "@/lib/seo/types";

/**
 * AEO — answer engine optimisation: an internal heuristic for how readily a page's content can be
 * lifted as a direct answer (featured snippets, voice answers, AI overviews). It never claims any
 * platform's score. What it asks depends on the page: an article is expected to answer questions, a
 * form page or a legal page is not, and no page is ever told it must have an FAQ.
 */

/** The longest answer, in words, that still reads as "the answer" under a question. */
export const ANSWER_MAX_WORDS = 60;
/** Paragraphs longer than this are hard to read and to quote. */
export const LONG_PARAGRAPH_WORDS = 120;
/** A section this long (words per H2) wants splitting. */
export const SECTION_MAX_WORDS = 350;

const norm = (s: string) => squash(s).toLowerCase();
const noun = (input: SeoInput) => (input.kind === "post" ? "post" : input.kind === "category" ? "category" : input.kind === "tag" ? "tag" : "page");

function notInformational(input: SeoInput): string {
  if (isForm(input)) return "A form page: it isn't expected to answer questions.";
  if (isLegal(input)) return "A legal page: scored for structure and readability, not for answers.";
  return `A short page (${plural(input.content.wordCount, "word")}): it isn't expected to answer questions. Pages of more than 400 words and posts are.`;
}

const GENERIC_AUTHORS = /^(admin|administrator|editor|author|user|staff|team|the team|script|system|test|guest|webmaster|marketing|unknown|anonymous)$/i;
const DANGLING_START = /^(this|that|these|those|it|its|they|them|as (mentioned|noted|discussed|said|shown|we saw)|the above|above)\b/i;
const DEFINITION = /\b(is|are)\s+(a|an|the|one|when|how|what|where)\b|\bmeans\b|\brefers to\b|\bis defined as\b|\bstands for\b/i;
const COMPARISON = /\b(vs\.?|versus|compared (to|with)|comparison|comparing|differences? between)\b/i;

export const AEO_CHECKS: readonly CheckDef[] = [
  {
    id: "aeo.intent",
    label: "Clear topic",
    category: "aeo",
    group: "answers",
    weight: 10,
    applicableTo: ALL_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      if (input.kind === "blog-index") return info("The blog index's heading, title and opening line are fixed in code (“Blog”).", "The CMS can't change them; the posts it lists carry the topics.");
      const h1 = input.content.h1s[0];
      if (!h1) return fail("No H1, so the page's topic isn't stated where answer engines look first.", "Add a Page header or Hero block whose heading says what the page is about.", { field: bodyField(input) });
      const title = input.meta.rawTitle || input.meta.title;
      const agree = sharedWords(h1, title) > 0 || norm(title).includes(norm(h1)) || norm(h1).includes(norm(title));
      const first = input.content.firstParagraph;
      const kw = primaryKeyword(input);
      const opens = isForm(input) || (!!first && (sharedWords(first, h1) > 0 || sharedWords(first, title) > 0 || (!!kw && hasPhrase(first, kw))));
      const firstField = input.content.paragraphs.find((p) => p.text === first)?.field ?? bodyField(input);
      if (agree && opens) return pass(w, `The H1 ${quote(h1)} and the title agree, and the opening says what the ${noun(input)} is about.`);
      const titleHint = `Make the title and the H1 name the same topic${kw ? `, ideally “${kw}”` : ""}.`;
      const openHint = `Open with a sentence that says what this ${noun(input)} is about, in the H1's words${kw ? ` or “${kw}”` : ""}.`;
      if (!agree && !opens) return fail(`The H1 ${quote(h1)} and the title ${quote(title)} share no words, and the opening doesn't say what the ${noun(input)} is about.`, `${titleHint} ${openHint}`, { field: seoField(input, "title") });
      if (!agree) return warn(share(w, 0.5), `The H1 ${quote(h1)} and the title ${quote(title)} share no words — they don't say the same thing.`, titleHint, { field: seoField(input, "title") });
      return warn(share(w, 0.5), first ? `The opening, ${quote(first)}, doesn't mention the ${noun(input)}'s topic (${quote(h1)}).` : "There's no opening paragraph under the H1.", openHint, { field: firstField ?? undefined });
    },
  },
  {
    id: "aeo.question-headings",
    label: "Question-shaped headings",
    category: "aeo",
    group: "answers",
    weight: 6,
    applicableTo: CONTENT_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      if (!isInformational(input)) return notApplicable(notInformational(input));
      const qs = questionHeadings(input);
      if (qs.length) return pass(w, `${plural(qs.length, "heading")} asked as a question, e.g. ${quote(qs[0].text)}.`);
      const faqs = input.content.faqs.filter((f) => f.question);
      if (faqs.length) return pass(w, `The FAQ asks ${plural(faqs.length, "question")}.`);
      const topic = topicOf(input);
      const firstH2 = input.content.headings.find((h) => h.level === 2);
      const examples = topic ? `“What is ${topic}?” or “How does ${topic} work?”` : "“How does it work?” or “What does it cost?”";
      return warn(0, "No heading is phrased as a question a reader would ask.", `Phrase an H2 as a question this ${noun(input)} answers, in a reader's words — e.g. ${examples}.`, {
        field: firstH2?.field ?? bodyField(input),
      });
    },
  },
  {
    id: "aeo.answer-first",
    label: "Answer first",
    category: "aeo",
    group: "answers",
    weight: 8,
    applicableTo: CONTENT_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      const qs = questionHeadings(input);
      const faqs = input.content.faqs.filter((f) => f.question && f.answer);
      if (!qs.length && !faqs.length) return notApplicable("No question headings or FAQ to answer.");
      const problems: { message: string; field: string | null }[] = [];
      for (const q of qs) {
        const p = answerUnder(input, q.index);
        if (!p) problems.push({ message: `Add a concise answer below this H${q.level}: ${quote(q.text)}.`, field: q.field });
        else if (p.words > ANSWER_MAX_WORDS) problems.push({ message: `The answer under ${quote(q.text)} runs ${p.words} words before it stops; open with the answer in ${ANSWER_MAX_WORDS} words or fewer.`, field: p.field });
      }
      for (const f of faqs) {
        const opening = countWords(f.answer.split("\n\n")[0]);
        if (opening > ANSWER_MAX_WORDS) problems.push({ message: `The FAQ answer to ${quote(f.question)} opens with a ${opening}-word paragraph; lead with a short answer.`, field: f.field });
      }
      const total = qs.length + faqs.length;
      if (!problems.length) return pass(w, `Every question (${total}) is answered right below it, in ${ANSWER_MAX_WORDS} words or fewer.`);
      return warn(share(w, 1 - problems.length / total), problems[0].message, `Open each answer with one or two sentences (${ANSWER_MAX_WORDS} words at most) that answer the question, then explain.`, {
        field: problems[0].field ?? undefined,
      });
    },
  },
  {
    id: "aeo.faq",
    label: "FAQ and its structured data",
    category: "aeo",
    group: "answers",
    weight: 4,
    applicableTo: CONTENT_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      const visible = input.content.faqs.filter((f) => f.question && f.answer);
      const ld = input.jsonLd.find((o) => o["@type"] === "FAQPage");
      if (ld && !visible.length) return fail("FAQ structured data is emitted, but the page shows no FAQ.", "Structured data must match what the page shows: remove the FAQPage, or add the FAQ block it describes.", { severity: "critical" });
      if (visible.length) {
        const field = visible[0].field ?? undefined;
        if (!ld) {
          return warn(
            share(w, 0.5),
            `An FAQ with ${plural(visible.length, "question")} is on the page, but no FAQPage structured data goes with it.`,
            input.site.emitsJsonLd ? "Tell a developer: every visible FAQ should carry FAQPage structured data." : "A developer change: the site doesn't emit JSON-LD yet — nothing in the CMS turns it on.",
            { field },
          );
        }
        const names = Array.isArray(ld.mainEntity) ? (ld.mainEntity as { name?: unknown }[]).map((q) => norm(String(q.name ?? ""))) : [];
        const matches = names.length === visible.length && visible.every((f) => names.includes(norm(f.question)));
        if (!matches) return fail("The FAQ structured data doesn't match the questions on the page.", "Tell a developer: FAQPage must list exactly the questions the page shows.", { field, severity: "critical" });
        return pass(w, `An FAQ with ${plural(visible.length, "question")}, and FAQPage structured data that matches it.`, { field });
      }
      const qs = questionHeadings(input).length;
      if (qs >= 3 || input.pageType === "help" || input.pageType === "pricing") {
        const why = qs >= 3 ? `${qs} headings are questions` : `A ${input.pageType} page`;
        return info(`${why}: an FAQ block could collect the questions readers ask.`, "Consider an FAQ block — its questions and answers also become FAQPage structured data. Only with real questions, answered on the page.");
      }
      return notApplicable("Not every page needs an FAQ.");
    },
  },
  {
    id: "aeo.structure",
    label: "Sectioned for answers",
    category: "aeo",
    group: "content",
    weight: 5,
    applicableTo: CONTENT_KINDS,
    evaluate(input, w) {
      if (isForm(input)) return notApplicable("A form page.");
      const words = input.content.wordCount;
      if (words < 300) return notApplicable(`Short pages (${words} words) don't need sections.`);
      const sections = input.content.headings.filter((h) => h.level === 2).length;
      const perSection = Math.round(words / Math.max(1, sections));
      const ladder = headingProblems(input);
      let fraction = 1;
      const problems: string[] = [];
      if (sections < 2) {
        fraction -= 0.5;
        problems.push(`${words} words under ${plural(sections, "H2 section")}`);
      }
      if (perSection > SECTION_MAX_WORDS) {
        fraction -= 0.25;
        problems.push(`about ${perSection} words per section`);
      }
      if (ladder.length) {
        fraction -= 0.25;
        problems.push(ladder[0].message.replace(/\.$/, ""));
      }
      if (!problems.length) return pass(w, `${sections} H2 sections of about ${perSection} words each, in order.`);
      return warn(share(w, fraction), `${problems.join("; ")}.`, `Give each question or topic its own H2 section of up to ${SECTION_MAX_WORDS} words, H3s inside it — answer engines lift one section at a time.`, {
        field: ladder[0]?.field ?? bodyField(input),
      });
    },
  },
  {
    id: "aeo.definitions",
    label: "Definitions",
    category: "aeo",
    group: "answers",
    weight: 3,
    applicableTo: CONTENT_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      if (!isInformational(input)) return notApplicable(notInformational(input));
      const kw = primaryKeyword(input);
      const defs: { sentence: string; field: string | null }[] = [];
      for (const p of input.content.paragraphs) {
        for (const s of sentences(p.text)) {
          const at = s.search(DEFINITION);
          if (at > 0 && countWords(s.slice(0, at)) <= 8) defs.push({ sentence: s, field: p.field });
        }
      }
      const opening = input.content.paragraphs[0]?.field ?? bodyField(input);
      if (kw) {
        const own = defs.find((d) => hasPhrase(d.sentence, kw));
        if (own) return pass(w, `Defines ${quote(kw)}: ${quote(own.sentence)}.`, { field: own.field ?? undefined });
        if (defs.length) return warn(share(w, 0.5), `There are definitions, e.g. ${quote(defs[0].sentence)}, but none of keyword 1, ${quote(kw)}.`, `Add a one-sentence definition near the top: “${kw} is …”.`, { field: opening ?? undefined });
        return warn(0, `No sentence defines ${quote(kw)}.`, `Add a one-sentence definition near the top: “${kw} is …”.`, { field: opening ?? undefined });
      }
      if (defs.length) return pass(w, `Defines its terms, e.g. ${quote(defs[0].sentence)}.`, { field: defs[0].field ?? undefined });
      const topic = topicOf(input);
      return warn(0, "No sentence defines the key term.", `Add a one-sentence definition near the top${topic ? `, e.g. “${topic} is …”` : " — “X is …” for the term the page is about"}.`, { field: opening ?? undefined });
    },
  },
  {
    id: "aeo.lists",
    label: "Lists",
    category: "aeo",
    group: "content",
    weight: 3,
    applicableTo: CONTENT_KINDS,
    evaluate(input, w) {
      if (isForm(input) || isLegal(input)) return notApplicable(isForm(input) ? "A form page." : "A legal page.");
      const words = input.content.wordCount;
      if (words <= 300) return notApplicable(`Short pages (${words} words) don't need lists.`);
      const lists = input.content.lists.length;
      const tables = input.content.tables.length;
      if (lists || tables) return pass(w, `${plural(lists, "list")}${tables ? ` and ${plural(tables, "table")}` : ""}.`);
      return warn(0, `${words} words and no list.`, "Put steps, options or features as a list — easier to scan, and to quote.", { field: bodyField(input) });
    },
  },
  {
    id: "aeo.tables",
    label: "Tables for comparisons",
    category: "aeo",
    group: "content",
    weight: 2,
    applicableTo: CONTENT_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      const comparison = COMPARISON.test(input.content.text);
      const pricing = input.pageType === "pricing";
      if (!comparison && !pricing) return notApplicable("Nothing on the page compares options.");
      if (input.content.tables.length) return pass(w, `${plural(input.content.tables.length, "table")} lay the comparison out.`);
      if (pricing && input.content.blockTypes.includes("pricingTable")) return pass(w, "The live pricing table sets the plans side by side.");
      if (pricing) return warn(0, "The pricing page has no table of plans.", "Keep the Pricing table block on the page.", { field: "blocks" });
      return warn(0, "The page compares options in prose, without a table.", "Put the comparison in a table (a Rich text block's table): one row per option, one column per point compared.", { field: bodyField(input) });
    },
  },
  {
    id: "aeo.facts",
    label: "Clear facts",
    category: "aeo",
    group: "answers",
    weight: 4,
    applicableTo: ["page"],
    indexedOnly: true,
    evaluate(input, w) {
      if (input.pageType === "pricing") {
        if (input.content.blockTypes.includes("pricingTable")) return pass(w, "Prices come from the live pricing table: each plan, its price and what it includes.");
        return warn(0, "The pricing page shows no prices.", "Add the Pricing table block back — it lists each plan's price.", { field: "blocks" });
      }
      if (input.pageType === "security") {
        const measures = input.content.headings.filter((h) => h.level === 3).length;
        if (measures >= 3) return pass(w, `${measures} specific security measures, each under its own heading.`);
        return warn(share(w, measures / 3), `Only ${plural(measures, "specific measure")} named under a heading of its own.`, "State each security measure as its own point: what is protected, and how (a Security highlights block).", {
          field: bodyField(input),
        });
      }
      return notApplicable("Checked on the pricing and security pages.");
    },
  },
  {
    id: "aeo.breadcrumbs",
    label: "Breadcrumbs",
    category: "aeo",
    group: "structured-data",
    weight: 3,
    applicableTo: ["post", "category", "tag"],
    indexedOnly: true,
    evaluate(input, w) {
      const trail = input.content.breadcrumbs;
      if (!trail.length) return fail("No breadcrumb on the page.", "The blog's pages show one; its absence means the page is broken — tell a developer.");
      const ld = input.jsonLd.some((o) => o["@type"] === "BreadcrumbList");
      const shown = `${trail.map((c) => c.name).join(" › ")} › ${input.name}`;
      if (!ld) {
        return warn(share(w, 0.5), `The breadcrumb (${shown}) shows on the page, but no BreadcrumbList structured data goes with it.`, input.site.emitsJsonLd ? "Tell a developer: every breadcrumb should carry BreadcrumbList structured data." : "A developer change: the site doesn't emit JSON-LD yet.");
      }
      if (input.kind === "post" && !input.editorial.categories.length) {
        return warn(share(w, 0.75), `The breadcrumb is only ${shown}: the post has no category.`, "Put the post in a category — its breadcrumb then shows where it belongs.", { field: "categories" });
      }
      return pass(w, `Breadcrumb: ${shown}, with BreadcrumbList structured data.`);
    },
  },
  {
    id: "aeo.author-dates",
    label: "Author and date",
    category: "aeo",
    group: "freshness",
    weight: 5,
    applicableTo: ["post"],
    indexedOnly: true,
    evaluate(input, w) {
      const { author, publishedAt } = input.editorial;
      const site = norm(input.site.siteName);
      if (!author) return warn(publishedAt ? share(w, 0.4) : 0, "The post shows no author.", "Add author information to improve content attribution", { field: "author" });
      if (GENERIC_AUTHORS.test(author.trim()) || author.includes("@") || norm(author) === site) {
        return warn(share(w, 0.5), `The author is ${quote(author)} — it reads as an account or the company, not a person.`, "Add author information to improve content attribution: make the post's author the person who wrote it.", { field: "author" });
      }
      if (!publishedAt) return warn(share(w, 0.6), `By ${author}, but with no publication date: the post isn't published or scheduled.`, "Publish or schedule it — its date shows under its title.", { field: "publishAt" });
      return pass(w, `By ${author}, published ${istDay(publishedAt)}.`);
    },
  },
  {
    id: "aeo.readability",
    label: "Readability",
    category: "aeo",
    group: "readability",
    weight: 4,
    applicableTo: ["page", "home", "post", "category", "tag"],
    evaluate(input, w) {
      const paras = input.content.paragraphs;
      const words = paras.reduce((n, p) => n + p.words, 0);
      if (words < 50) return notApplicable("Too little running text to judge.");
      const lengths = paras.flatMap((p) => sentences(p.text)).map(countWords);
      const avg = Math.round((lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length)) * 10) / 10;
      const long = paras.filter((p) => p.words > LONG_PARAGRAPH_WORDS);
      const longest = long.reduce<(typeof long)[number] | null>((a, p) => (!a || p.words > a.words ? p : a), null);
      let fraction = avg <= 20 ? 1 : avg <= 25 ? 0.6 : avg <= 30 ? 0.3 : 0;
      fraction -= 0.2 * long.length;
      if (avg <= 20 && !long.length) return pass(w, `Sentences average ${avg} words; no paragraph runs past ${LONG_PARAGRAPH_WORDS}.`);
      const parts = [`Sentences average ${avg} words`];
      if (longest) parts.push(`${plural(long.length, "paragraph")} run${long.length === 1 ? "s" : ""} past ${LONG_PARAGRAPH_WORDS} words (the longest, ${quote(longest.text, 40)}, has ${longest.words})`);
      const tips = [avg > 20 ? "Split long sentences: aim for 15–20 words on average." : "", long.length ? `Break paragraphs over ${LONG_PARAGRAPH_WORDS} words into two or three, each making one point.` : ""].filter(Boolean);
      return warn(share(w, fraction), `${parts.join("; ")}.`, tips.join(" "), { field: longest?.field ?? bodyField(input) });
    },
  },
  {
    id: "aeo.self-contained",
    label: "Self-contained sections",
    category: "aeo",
    group: "answers",
    weight: 3,
    applicableTo: CONTENT_KINDS,
    indexedOnly: true,
    evaluate(input, w) {
      const heads = input.content.headings;
      const leading = input.content.paragraphs.filter((p) => p.leading && p.heading >= 0 && heads[p.heading]?.level >= 2);
      if (!leading.length) return notApplicable("No paragraph sits right under a section heading.");
      const bad = leading.filter((p) => DANGLING_START.test(p.text));
      if (!bad.length) return pass(w, "Every section opens with a sentence that stands on its own.");
      const first = bad[0];
      const opening = first.text.split(/\s+/).slice(0, 6).join(" ");
      return warn(
        share(w, 1 - bad.length / leading.length),
        `The section ${quote(heads[first.heading].text)} opens with ${quote(`${opening}…`)}, which leans on what came before.`,
        "Start each section by naming its subject, so the paragraph still makes sense when it is quoted on its own.",
        { field: first.field ?? undefined },
      );
    },
  },
];
