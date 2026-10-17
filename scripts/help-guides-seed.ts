/**
 * The Help Center's guide drafts — one per module, in scripts/help-guides/ — saved in the website CMS
 * as DRAFT pages at help/<guide>, for Deskzo's staff to read, correct and publish there (CMS › Help
 * guides). Nothing is published unless it is asked for with --publish.
 *
 *   npm run help:seed-guides                    save every draft (new ones made, the seed's own updated)
 *   npm run help:seed-guides -- --dry-run       say what it would do; write nothing
 *   npm run help:seed-guides -- --only leads,orders
 *   npm run help:seed-guides -- --publish       save them, then publish the seed's own drafts — never a
 *                                                page a person has changed (that one is staff's to publish)
 *
 * It runs against the control plane in CONTROL_DATABASE_URL, through the CMS's own functions
 * (src/lib/cms/content.ts), acting as "script" — so the validator, the activity log and the history
 * are as they would be for a person. It never overwrites a person's work:
 *
 *   · a guide with no page is made, as a draft;
 *   · a page the seed wrote last, still a draft, is updated — or left when it already matches;
 *   · a page a person has changed, published, archived, moved or deleted is left alone and listed;
 *   · a module whose guide a person made at another address is left alone and listed.
 */
import "dotenv/config";
import { refLabels } from "../src/lib/cms/audit";
import { createPage, publishPage, savePageDraft } from "../src/lib/cms/content";
import { listGuidePages } from "../src/lib/cms/guides";
import { CmsRefused, type CmsMe } from "../src/lib/cms/types";
import { checkPageDocument, pageSlugProblem, stableJson } from "../src/lib/cms/validate";
import { closeControlDb, controlConfigured, controlDb } from "../src/lib/platform/control-db";
import { guideDocument, loadGuides } from "./help-guides";

const SEED_ACTOR = "script";
const args = process.argv.slice(2);
const has = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const when = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

type Outcome = "created" | "updated" | "unchanged" | "skipped" | "failed";
const PUBLISH_NOTE = "Published by the Help Center seed (npm run help:seed-guides -- --publish).";

async function goneByHand(slug: string): Promise<string | null> {
  const moved = await controlDb().cmsAuditLog.findFirst({
    where: { entity: "page", action: "page.slug", actorLabel: { not: SEED_ACTOR }, detail: { path: ["from"], equals: slug } },
    orderBy: { at: "desc" },
    select: { at: true, actorLabel: true, detail: true },
  });
  if (moved) return `moved to /${String((moved.detail as { to?: string } | null)?.to ?? "another address")} by ${moved.actorLabel} on ${when(moved.at)}`;
  const deleted = await controlDb().cmsAuditLog.findFirst({
    where: { entity: "page", action: "page.delete", actorLabel: { not: SEED_ACTOR }, detail: { path: ["slug"], equals: slug } },
    orderBy: { at: "desc" },
    select: { at: true, actorLabel: true },
  });
  return deleted ? `deleted by ${deleted.actorLabel} on ${when(deleted.at)}` : null;
}

async function main() {
  if (!controlConfigured()) throw new Error("CONTROL_DATABASE_URL is not set: the guides are saved in the control plane's website content.");
  const dryRun = has("dry-run");
  const publish = has("publish");
  const only = value("only")?.split(",").map((s) => s.trim()).filter(Boolean);
  const guides = await loadGuides(only);
  const me: CmsMe = { id: SEED_ACTOR, email: "", name: "Script", role: "ADMIN", script: true };
  const existing = await listGuidePages();
  const results: { key: string; slug: string; outcome: Outcome; reason?: string }[] = [];
  console.log(dryRun ? "Dry run: nothing is written.\n" : "");

  for (const { file, guide } of guides) {
    const base = { key: file, slug: guide.slug };
    try {
      const problem = pageSlugProblem(guide.slug);
      if (problem) {
        results.push({ ...base, outcome: "failed", reason: problem });
        continue;
      }
      const checked = checkPageDocument(guideDocument(guide), "draft");
      if (!checked.ok) {
        results.push({ ...base, outcome: "failed", reason: `the CMS's validator refuses it: ${checked.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}` });
        continue;
      }
      const doc = checked.value;
      const elsewhere = existing.find((r) => r.module === guide.guide.module)?.page;
      if (elsewhere && elsewhere.slug !== guide.slug) {
        results.push({ ...base, outcome: "skipped", reason: `the module already has a guide at ${elsewhere.path}` });
        continue;
      }
      const row = await controlDb().sitePage.findUnique({ where: { slug: guide.slug }, select: { id: true, status: true, draft: true, archivedAt: true, updatedAt: true, updatedBy: true } });
      if (!row) {
        const gone = await goneByHand(guide.slug);
        if (gone) {
          results.push({ ...base, outcome: "skipped", reason: gone });
          continue;
        }
        if (!dryRun) {
          const made = await createPage({ slug: guide.slug, title: doc.title }, me);
          await savePageDraft(made.id, { document: doc, version: made.version }, me);
        }
        results.push({ ...base, outcome: "created", reason: dryRun ? "would save a new draft" : undefined });
        continue;
      }
      if (row.archivedAt) {
        results.push({ ...base, outcome: "skipped", reason: `archived in the CMS on ${when(row.archivedAt)}` });
        continue;
      }
      if (row.updatedBy !== SEED_ACTOR) {
        const label = (await refLabels([row.updatedBy])).get(row.updatedBy) ?? row.updatedBy;
        results.push({ ...base, outcome: "skipped", reason: `changed in the CMS by ${label} on ${when(row.updatedAt)}` });
        continue;
      }
      if (row.status !== "DRAFT") {
        results.push({ ...base, outcome: "skipped", reason: "published — the CMS holds it now" });
        continue;
      }
      if (stableJson(row.draft) === stableJson(doc)) {
        results.push({ ...base, outcome: "unchanged" });
        continue;
      }
      if (!dryRun) await savePageDraft(row.id, { document: doc, version: row.updatedAt.toISOString() }, me);
      results.push({ ...base, outcome: "updated", reason: dryRun ? "would save the new draft" : undefined });
    } catch (err) {
      results.push({ ...base, outcome: "failed", reason: err instanceof CmsRefused ? `${err.message} ${(err.issues ?? []).map((i) => i.path).join(", ")}` : err instanceof Error ? err.message : String(err) });
    }
  }

  for (const r of results) console.log(`${r.outcome.padEnd(9)} /${r.slug}${r.reason ? ` — ${r.reason}` : ""}`);

  // Publishing, only when asked: each guide whose page the seed wrote last and that is still a draft —
  // through the CMS's own publish, so a guide that fails its checks (a module, permission or product
  // that doesn't exist; another published guide for the module) is refused and listed, not forced.
  const published: string[] = [];
  const notPublished: { slug: string; reason: string }[] = [];
  if (publish) {
    for (const r of results.filter((x) => x.outcome !== "failed" && x.outcome !== "skipped")) {
      const row = await controlDb().sitePage.findUnique({ where: { slug: r.slug }, select: { id: true, status: true, updatedAt: true, updatedBy: true } });
      if (!row) {
        if (!dryRun) notPublished.push({ slug: r.slug, reason: "no page" });
        else published.push(r.slug);
        continue;
      }
      if (row.status !== "DRAFT" || row.updatedBy !== SEED_ACTOR) continue;
      if (dryRun) {
        published.push(r.slug);
        continue;
      }
      try {
        await publishPage(row.id, { version: row.updatedAt.toISOString(), note: PUBLISH_NOTE }, me);
        published.push(r.slug);
      } catch (err) {
        notPublished.push({ slug: r.slug, reason: err instanceof CmsRefused ? err.message : err instanceof Error ? err.message : String(err) });
      }
    }
    for (const slug of published) console.log(`${dryRun ? "would publish" : "published"} /${slug}`);
    for (const n of notPublished) console.log(`not published /${n.slug} — ${n.reason}`);
  }
  const count = (o: Outcome) => results.filter((r) => r.outcome === o).length;
  console.log(
    `\n${dryRun ? "Would have: " : ""}${count("created")} created, ${count("updated")} updated, ${count("unchanged")} unchanged, ${count("skipped")} left alone, ${count("failed")} failed. ${publish ? `${dryRun ? "Would publish" : "Published"} ${published.length}${notPublished.length ? `; ${notPublished.length} not published` : ""}.` : "Nothing was published: review them in the CMS under Help guides."}`,
  );
  if (count("failed") || notPublished.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closeControlDb);
