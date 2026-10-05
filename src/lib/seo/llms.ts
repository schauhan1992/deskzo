import type { NavItem } from "@/components/site/blocks/types";
import { isNavMenu } from "@/components/site/nav";

/**
 * The public site's /llms.txt (llmstxt.org): a Markdown file that tells an AI assistant what the site is
 * and where its pages are — the site's name as the heading, a one-line summary as a quote, then its
 * pages as links with a line about each.
 *
 * The pages are grouped as the header groups them: each menu (Product, Solutions…) is a section with the
 * pages its columns link to, in the menu's order, then any page under one of those ("/product/crm" with
 * "/product"). Pages no menu holds — the home page, pricing, legal — come first under "Pages", in the
 * sitemap's order; posts last under "Blog", newest first. Only what the
 * caller gives is listed: src/app/llms.txt/route.ts passes what the sitemap would, less anything an
 * editor left out of llms.txt.
 *
 * Pure: the route and the checks share it.
 */

export type LlmsEntry = { path: string; title: string; description: string };

export type LlmsInput = {
  siteName: string;
  /** The opening quote: the CMS's llms.txt summary, else the site's search description. */
  summary: string;
  /** "https://deskzo.com" — every link is absolute. */
  origin: string;
  /** The header's items, for the sections. */
  nav: readonly NavItem[];
  pages: readonly LlmsEntry[];
  posts: readonly LlmsEntry[];
};

/** "/product/crm?x#y" and "/product/crm/" both as "/product/crm"; anything off the site, null. */
function sitePathOf(href: unknown): string | null {
  if (typeof href !== "string" || !href.startsWith("/") || href.startsWith("//")) return null;
  const path = href.split(/[?#]/)[0] ?? "";
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : "/";
}

/** One line of Markdown text: no line breaks, and nothing that would end a link's text early. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const linkText = (text: string) => oneLine(text).replace(/[[\]]/g, "");

function line(entry: LlmsEntry, origin: string): string {
  const url = `${origin}${entry.path === "/" ? "/" : entry.path}`;
  const description = oneLine(entry.description);
  return `- [${linkText(entry.title) || url}](${url})${description ? `: ${description}` : ""}`;
}

export function buildLlmsTxt(input: LlmsInput): string {
  const byPath = new Map(input.pages.map((p) => [p.path, p]));
  const placed = new Set<string>();
  const sections: { title: string; entries: LlmsEntry[] }[] = [];

  for (const item of input.nav) {
    if (!isNavMenu(item)) continue;
    const entries: LlmsEntry[] = [];
    const take = (href: unknown) => {
      const path = sitePathOf(href);
      const page = path ? byPath.get(path) : undefined;
      if (page && !placed.has(page.path)) {
        placed.add(page.path);
        entries.push(page);
      }
    };
    for (const column of item.columns ?? []) for (const link of column.items ?? []) take(link.href);
    take(item.footer?.href);
    if (entries.length) sections.push({ title: oneLine(item.label), entries });
  }

  // A page no menu links to joins the section of its nearest parent that one does ("/product/crm" under
  // "/product"'s), after the menu's own; the rest — the home page among them — are "Pages".
  const sectionOf = new Map<string, (typeof sections)[number]>();
  for (const section of sections) for (const entry of section.entries) sectionOf.set(entry.path, section);
  const rest: LlmsEntry[] = [];
  for (const page of input.pages.filter((p) => !placed.has(p.path))) {
    let parent = page.path;
    let home: (typeof sections)[number] | undefined;
    while (!home && parent.lastIndexOf("/") > 0) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      home = sectionOf.get(parent);
    }
    if (home) home.entries.push(page);
    else rest.push(page);
  }
  if (rest.length) sections.unshift({ title: "Pages", entries: rest });
  if (input.posts.length) sections.push({ title: "Blog", entries: [...input.posts] });

  const out = [`# ${oneLine(input.siteName)}`, ""];
  const summary = oneLine(input.summary);
  if (summary) out.push(`> ${summary}`, "");
  for (const section of sections) {
    out.push(`## ${section.title}`, "");
    for (const entry of section.entries) out.push(line(entry, input.origin));
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}
