/**
 * Syncs world places from GeoNames, in a process of its own — started by `startWorldPlacesSync`
 * (src/actions/reference-data.ts), not meant to be run by hand; `npm run db:geonames:download` is
 * the command-line way to do the same thing.
 *
 * Downloads GeoNames' files into prisma/reference/geonames/ and loads them (geonames.ts), writing
 * its progress to the `reference_syncs` row the action claimed, which the settings page polls. A
 * separate process for the PIN directory's reason: minutes of work that must outlive the request.
 */
import "dotenv/config";
import { PrismaClient } from "@deskzo/reference-client";
import { GEONAMES_DIR, downloadGeonames, loadGeonames } from "./geonames";

// The shared reference database (prisma/reference/schema.prisma), which belongs to no workspace.
const db = new PrismaClient({ datasourceUrl: process.env.REFERENCE_DATABASE_URL });
const KEY = "geonames";

async function main() {
  const sync = await db.referenceSync.findUnique({ where: { key: KEY } });
  if (!sync || sync.status !== "RUNNING") return;

  let lastWrite = 0;
  const progress = async (message: string, done?: number, total?: number) => {
    // About once a second — every batch would be thousands of writes for a bar.
    if (Date.now() - lastWrite < 1000 && done !== total) return;
    lastWrite = Date.now();
    await db.referenceSync.update({ where: { key: KEY }, data: { message, ...(done !== undefined ? { fetched: done } : {}), ...(total !== undefined ? { total } : {}) } });
  };

  try {
    await downloadGeonames(GEONAMES_DIR, progress);
    const outcomes = await loadGeonames(db, GEONAMES_DIR, progress);
    const refused = outcomes.filter((o) => o.outcome === "refused");
    const summary = outcomes
      .map((o) => `${o.key.replace("geonames-", "")}: ${o.outcome}${o.rows ? ` (${o.rows.toLocaleString("en-IN")})` : ""}`)
      .join(" · ");
    await db.referenceSync.update({
      where: { key: KEY },
      data: {
        status: refused.length ? "FAILED" : "SUCCEEDED",
        finishedAt: new Date(),
        message: (refused.length ? `Not loaded — ${refused.map((r) => r.detail).join("; ")}. ` : "") + summary,
      },
    });
  } catch (error) {
    await db.referenceSync.update({
      where: { key: KEY },
      data: { status: "FAILED", finishedAt: new Date(), message: String((error as Error).message ?? error).slice(0, 600) },
    });
  }
}

main().finally(() => db.$disconnect());
