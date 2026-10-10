/**
 * The public website's product, solutions, comparison and resource pages, the guides, and the
 * header's menus and the footer — published through the website CMS's own functions.
 *
 *   npm run site:seed-pages                      publish (or update) everything, then recalculate the SEO scores
 *   npm run site:seed-pages -- --dry-run         say what it would do; write nothing
 *   npm run site:seed-pages -- --only compare    only these sections (comma-separated: product,products,solutions,compare,resources,guides)
 *   npm run site:seed-pages -- --no-nav          leave the navigation and footer alone
 *   npm run site:seed-pages -- --no-scores       don't recalculate the SEO scores afterwards
 *   npm run site:seed-pages -- --json <file>     also write the result (outcomes, scores, top issues) to a file
 *   npm run site:seed-pages -- --restore cards   publish these pages (comma-separated addresses) even though a person
 *                                                deleted or moved them in the CMS — when the page is wanted back
 *
 * It runs against the control plane in CONTROL_DATABASE_URL — the site this installation serves.
 * The content is in scripts/site-content/ (one module per section); the rules are in
 * scripts/lib/site-seed.ts: what the seed made it keeps up to date, and anything a person has changed
 * in the CMS since is left alone and listed. Everything is in the CMS's activity log as "script".
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { partnerOrigin } from "../src/lib/partners/users";
import { closeControlDb, controlConfigured } from "../src/lib/platform/control-db";
import { runSiteSeed, type SeedReport } from "./lib/site-seed";
import { loadSections, sectionNames } from "./site-content";
import { siteNav } from "./site-content/nav";

const args = process.argv.slice(2);
const has = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function printScores(report: SeedReport) {
  if (!report.scores.length) return;
  console.log("\nSEO scores (overall · SEO · AEO · GEO)");
  for (const s of report.scores) {
    console.log(`${String(s.overall).padStart(3)} ${s.label.padEnd(17)} ${String(s.seo).padStart(3)} ${String(s.aeo).padStart(3)} ${String(s.geo).padStart(3)}  ${s.path}`);
    for (const i of s.issues.slice(0, 3)) console.log(`      ${i.status === "FAIL" ? "fail" : "warn"} ${i.label}: ${i.message}`);
  }
}

async function main() {
  if (!controlConfigured()) throw new Error("CONTROL_DATABASE_URL is not set: the seed writes to the control plane's website content.");
  const only = value("only")?.split(",").map((s) => s.trim()).filter(Boolean);
  const known = sectionNames();
  const unknown = (only ?? []).filter((n) => !known.includes(n));
  if (unknown.length) throw new Error(`No section ${unknown.join(", ")}. The sections are: ${known.join(", ")}.`);
  const sections = await loadSections(only);
  const dryRun = has("dry-run");
  console.log(dryRun ? "Dry run: nothing is written.\n" : "");
  const report = await runSiteSeed({
    sections,
    nav: has("no-nav") ? null : siteNav({ partnerPortal: `${partnerOrigin()}/` }),
    restore: value("restore")?.split(",").map((s) => s.trim()).filter(Boolean),
    dryRun,
    scores: !dryRun && !has("no-scores"),
    log: (line) => console.log(line),
  });
  const count = (outcome: string) => report.results.filter((r) => r.outcome === outcome).length;
  console.log(
    `\n${dryRun ? "Would have: " : ""}${count("created")} created, ${count("updated")} updated, ${count("unchanged")} unchanged, ${count("skipped")} left alone (changed by a person), ${count("failed")} failed.`,
  );
  console.log(report.author ? `Guides are by the CMS's first admin: ${report.author.name} (${report.author.email}).` : "There is no active CMS admin, so no guide could be given an author.");
  printScores(report);
  if (report.proposedNav && !dryRun) console.log("\nThe settings were left alone. The proposed navigation and footer:\n" + JSON.stringify(report.proposedNav, null, 2));
  const out = value("json");
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  if (count("failed")) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closeControlDb);
