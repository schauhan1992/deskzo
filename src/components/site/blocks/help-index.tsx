import type { HelpIndexProps, SiteRenderContext } from "@/components/site/blocks/types";
import { HelpSearch, type HelpIndexGroup } from "@/components/site/help-search";
import { anchorId, fill } from "@/components/site/links";
import { Container } from "@/components/site/ui";
import { moduleAvailability } from "@/lib/help/guides";
import { listHelpGuides, type SiteGuideSummary } from "@/lib/platform/site-content";
import { ADD_ONS, PRODUCTS } from "@/lib/products";

/**
 * The Help Center's index (/help): every published guide, grouped by what includes its module — the
 * modules every product comes with first, then each product in src/lib/products.ts's order (a module
 * two products share is under both), then the add-ons — with one search over all of them. Deskzo One
 * holds every module, so it has no group of its own.
 */
export async function HelpIndexBlock({ props, ctx }: { props: HelpIndexProps; ctx: SiteRenderContext }) {
  let guides: SiteGuideSummary[] = [];
  try {
    guides = await listHelpGuides();
  } catch {
    guides = [];
  }
  const t = (s?: string) => fill(s, ctx);
  const filled = guides.map((g) => ({ ...g, title: t(g.title), summary: t(g.summary), words: t(g.words) }));
  return (
    <section id={anchorId(props.anchor)} className="scroll-mt-20 pb-16 sm:pb-24">
      <Container>
        <HelpSearch groups={helpIndexGroups(filled, t(props.everyProductHeading))} searchLabel={t(props.searchLabel)} emptyText={t(props.emptyText)} />
      </Container>
    </section>
  );
}

type Card = HelpIndexGroup["guides"][number];

/** The index's groups, in order, each with its guides by title. Pure, so check:help-guides can read it. */
export function helpIndexGroups(guides: Pick<SiteGuideSummary, "slug" | "path" | "module" | "title" | "summary" | "words">[], everyProductHeading: string): HelpIndexGroup[] {
  const card = (g: (typeof guides)[number]): Card => ({ slug: g.slug, path: g.path, module: g.module, title: g.title, summary: g.summary, words: g.words });
  const placed = new Set<string>();
  const groups: HelpIndexGroup[] = [];
  const everywhere = guides.filter((g) => moduleAvailability(g.module)?.everywhere);
  if (everywhere.length) {
    groups.push({ key: "everywhere", title: everyProductHeading, tagline: null, path: null, guides: everywhere.map(card) });
    for (const g of everywhere) placed.add(g.module);
  }
  for (const product of PRODUCTS) {
    if (product.modules.length === 0) continue;
    const inIt = guides.filter((g) => product.modules.includes(g.module) && !moduleAvailability(g.module)?.everywhere);
    if (!inIt.length) continue;
    groups.push({ key: product.key, title: product.name, tagline: product.tagline, path: product.path, guides: inIt.map(card) });
    for (const g of inIt) placed.add(g.module);
  }
  for (const addOn of ADD_ONS) {
    const inIt = guides.filter((g) => addOn.modules.includes(g.module) && !placed.has(g.module));
    if (!inIt.length) continue;
    groups.push({ key: `addon-${addOn.key}`, title: addOn.name, tagline: addOn.tagline, path: null, guides: inIt.map(card) });
    for (const g of inIt) placed.add(g.module);
  }
  const rest = guides.filter((g) => !placed.has(g.module));
  if (rest.length) groups.push({ key: "more", title: "More", tagline: null, path: null, guides: rest.map(card) });
  return groups;
}
