/**
 * Puts the product strip (owner, 24 Oct 2026: "a product strip with the icons to the home page") into a
 * home page that is published in the website CMS — the built-in home page has it already, but a home page
 * someone published from the CMS is that copy, and keeps showing it until the strip is added there.
 *
 *   npm run site:home-products              add it after the numbers under the hero, and publish
 *   npm run site:home-products -- --dry-run say what it would do; write nothing
 *
 * It does nothing when the home page already has a product strip (anybody's, wherever they put it), and
 * refuses when the home page has changes saved but not yet published: publishing would publish those too,
 * so the strip is added in the CMS's editor instead (Add block › Product strip). The words are the
 * built-in strip's (src/components/site/defaults.ts HOME_PRODUCT_STRIP), editable in the CMS afterwards.
 * Runs against CONTROL_DATABASE_URL; the publish is in the CMS's history and activity log as "script".
 */
import "dotenv/config";
import type { SiteBlock } from "../src/components/site/blocks/types";
import { HOME_PRODUCT_STRIP } from "../src/components/site/defaults";
import { refLabels } from "../src/lib/cms/audit";
import { publishPage } from "../src/lib/cms/content";
import type { CmsMe, PageDocument } from "../src/lib/cms/types";
import { stableJson } from "../src/lib/cms/validate";
import { closeControlDb, controlConfigured, controlDb } from "../src/lib/platform/control-db";

const SCRIPT: CmsMe = { id: "script", email: "", name: "Script", role: "ADMIN", script: true };
const dryRun = process.argv.includes("--dry-run");

/** Where it goes: after the numbers under the hero, else after the hero, else first. */
function insertAt(blocks: SiteBlock[]): number {
  const stats = blocks.findIndex((b) => b.type === "stats");
  if (stats >= 0) return stats + 1;
  const hero = blocks.findIndex((b) => b.type === "hero");
  return hero >= 0 ? hero + 1 : 0;
}

async function main() {
  if (!controlConfigured()) throw new Error("CONTROL_DATABASE_URL is not set: the home page is in the control plane's website content.");
  const row = await controlDb().sitePage.findUnique({ where: { slug: "home" } });
  if (!row || row.status !== "PUBLISHED" || !row.published) {
    console.log("The home page isn't published from the CMS, so the site shows its built-in home page, which has the product strip. Nothing to do.");
    return;
  }
  if (row.archivedAt) {
    console.log("The home page is archived in the CMS. Nothing done.");
    return;
  }
  const published = row.published as unknown as PageDocument;
  if (published.blocks.some((b) => b.type === "productStrip")) {
    console.log("The home page already has a product strip. Nothing done.");
    return;
  }
  if (stableJson(row.draft) !== stableJson(row.published)) {
    const by = (await refLabels([row.updatedBy])).get(row.updatedBy) ?? row.updatedBy;
    console.log(
      `The home page has changes saved but not published (last saved by ${by} on ${row.updatedAt.toISOString().slice(0, 10)}). Publishing the strip would publish them too, so nothing is done: add it in the CMS's editor (Add block › Product strip), or publish or discard those changes and run this again.`,
    );
    process.exitCode = 1;
    return;
  }
  const at = insertAt(published.blocks);
  const taken = new Set(published.blocks.map((b) => b.id));
  const id = taken.has(HOME_PRODUCT_STRIP.id) ? `${HOME_PRODUCT_STRIP.id}-${Date.now().toString(36)}` : HOME_PRODUCT_STRIP.id;
  const blocks = [...published.blocks.slice(0, at), { ...structuredClone(HOME_PRODUCT_STRIP), id }, ...published.blocks.slice(at)];
  const after = at > 0 ? `after the ${published.blocks[at - 1]!.type} block` : "at the top";
  if (dryRun) {
    console.log(`Would add the product strip to the home page ${after}, and publish it.`);
    return;
  }
  await publishPage(row.id, { document: { ...published, blocks }, version: row.updatedAt.toISOString(), note: "The product strip (site:home-products)" }, SCRIPT);
  console.log(`Added the product strip to the home page ${after}, and published it.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeControlDb());
