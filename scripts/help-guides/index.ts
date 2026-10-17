import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PageDocument } from "../../src/lib/cms/types";
import type { SeedGuide } from "./types";

/**
 * Every guide draft in this directory: any `*.ts` file except this one, types.ts and names starting
 * with "_", each exporting `guide` (a SeedGuide) and named by its module's key. A file that doesn't is
 * an error, not skipped silently — check:help-guides and the seed both read through here.
 */
const NOT_GUIDES = new Set(["index", "types"]);

export function guideFileNames(): string[] {
  return readdirSync(__dirname)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.startsWith("_"))
    .map((f) => f.slice(0, -3))
    .filter((n) => !NOT_GUIDES.has(n))
    .sort();
}

export type LoadedGuide = { file: string; guide: SeedGuide };

export async function loadGuides(only?: readonly string[]): Promise<LoadedGuide[]> {
  const out: LoadedGuide[] = [];
  for (const file of guideFileNames().filter((n) => !only?.length || only.includes(n))) {
    const mod = (await import(pathToFileURL(path.join(__dirname, `${file}.ts`)).href)) as { guide?: SeedGuide; default?: { guide?: SeedGuide } };
    const guide = mod.guide ?? mod.default?.guide;
    if (!guide || typeof guide !== "object" || typeof guide.slug !== "string") throw new Error(`scripts/help-guides/${file}.ts must export \`guide\` (a SeedGuide).`);
    out.push({ file, guide });
  }
  return out;
}

/** The CMS page a guide draft becomes: its title and SEO, and the guide as its one block. */
export function guideDocument(guide: SeedGuide): PageDocument {
  return {
    title: guide.title,
    seo: { title: guide.seo.title, description: guide.seo.description, keywords: [...guide.seo.keywords] },
    blocks: [{ id: "guide", type: "helpGuide", props: guide.guide }],
  };
}
