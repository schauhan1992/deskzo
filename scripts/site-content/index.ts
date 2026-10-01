import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SeedSection } from "./types";

/**
 * Every data module in this directory, in the order the seed publishes them: the hubs' sections
 * first (a hub's children name it in their breadcrumbs), then anything else alphabetically.
 *
 * A module is any `*.ts` file here except this one, types.ts, nav.ts and names starting with "_";
 * it exports `section` (a SeedSection). A file that doesn't is an error, not skipped silently.
 */
const ORDER = ["product", "solutions", "compare", "resources", "guides"];
const NOT_SECTIONS = new Set(["index", "types", "nav"]);

export async function loadSections(only?: string[]): Promise<SeedSection[]> {
  const dir = __dirname;
  const names = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.startsWith("_"))
    .map((f) => f.slice(0, -3))
    .filter((n) => !NOT_SECTIONS.has(n))
    .filter((n) => !only?.length || only.includes(n))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const sections: SeedSection[] = [];
  for (const name of names) {
    const mod = (await import(pathToFileURL(path.join(dir, `${name}.ts`)).href)) as { section?: SeedSection; default?: { section?: SeedSection } };
    const section = mod.section ?? mod.default?.section;
    if (!section || typeof section !== "object" || typeof section.name !== "string") throw new Error(`scripts/site-content/${name}.ts must export \`section\` (a SeedSection).`);
    sections.push(section);
  }
  return sections;
}

function rank(name: string): number {
  const i = ORDER.indexOf(name);
  return i === -1 ? ORDER.length : i;
}

/** The modules' names, for `--only`. */
export function sectionNames(): string[] {
  return readdirSync(__dirname)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.startsWith("_"))
    .map((f) => f.slice(0, -3))
    .filter((n) => !NOT_SECTIONS.has(n));
}
