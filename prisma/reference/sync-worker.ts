/**
 * Syncs the PIN directory from data.gov.in, in a process of its own.
 *
 *   started by `startPinDirectorySync` (src/actions/reference-data.ts) — not meant to be run by hand;
 *   `npm run db:reference:download` is the command-line way to do the same thing.
 *
 * ## Why a separate process
 *
 * A sync is ~170 requests to a public API and then a 165,000-row transaction: minutes, not seconds.
 * Run inside the request that asked for it, it would die with the request — a closed tab, a proxy
 * timeout, a dev-server reload. So the settings action claims the run in `reference_syncs`, starts
 * this detached, and returns; this writes its progress to the same row, and the page polls it. The
 * same shape as the restore worker, for the same reason.
 *
 * ## The key
 *
 * Read from `reference_syncs.apiKeyCipher` and decrypted here — never passed on a command line or in
 * the environment, where other processes on the machine can read it. It goes to api.data.gov.in and
 * nowhere else; `fetchDirectory` keeps it out of every message, and this file never logs one.
 */
import "dotenv/config";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@deskzo/reference-client";
import { openForPlatform } from "../../src/lib/platform/kek";
import { PIN_DIRECTORY_KEY } from "../../src/lib/geo/pincode";
import { fetchDirectory } from "./fetch";
import { loadPincodes, saveCanonicalCopy } from "./pincodes";

// The shared reference database (prisma/reference/schema.prisma), which belongs to no workspace.
const db = new PrismaClient({ datasourceUrl: process.env.REFERENCE_DATABASE_URL });
const scratch = path.join(tmpdir(), `pin-directory-${process.pid}.csv`);

async function main() {
  const sync = await db.referenceSync.findUnique({ where: { key: PIN_DIRECTORY_KEY } });
  // Only a run the action claimed. Started any other way, there is nothing here to do.
  if (!sync || sync.status !== "RUNNING") return;

  const progress = (data: { fetched?: number; total?: number | null; message?: string }) =>
    db.referenceSync.update({ where: { key: PIN_DIRECTORY_KEY }, data });

  try {
    if (!sync.apiKeyCipher) throw new Error("No API key is saved. Add one above and sync again.");
    const apiKey = openForPlatform("reference-sync-key", sync.apiKeyCipher);

    await progress({ message: "Fetching from data.gov.in…" });
    let lastWrite = 0;
    const { csv, rows } = await fetchDirectory({
      apiKey,
      onProgress: async (fetched, total) => {
        // Every page would be ~170 writes for a bar nobody reads that closely; every second or so is
        // smooth enough, and the last page always lands.
        if (Date.now() - lastWrite < 1000 && fetched !== total) return;
        lastWrite = Date.now();
        await progress({ fetched, total });
      },
    });

    await progress({ fetched: rows, total: rows, message: "Loading into the directory…" });
    writeFileSync(scratch, csv);
    const result = await loadPincodes(db, { file: scratch, sourceLabel: "data.gov.in API" });

    // Best effort: on a development machine this is the copy to commit; on a server whose code
    // directory is read-only it cannot be written, and the directory itself is already loaded.
    try {
      saveCanonicalCopy(scratch);
    } catch {
      /* the load above is what matters */
    }

    let message: string;
    if (result.status === "unchanged") {
      message = `Already up to date — ${result.rows.toLocaleString("en-IN")} post offices, unchanged since the last sync.`;
    } else {
      const unresolved = Object.entries(result.unresolvedStates);
      message =
        `Loaded ${result.rows.toLocaleString("en-IN")} post offices across ${result.pincodes.toLocaleString("en-IN")} PINs.` +
        (unresolved.length
          ? ` ${unresolved.length} state name${unresolved.length === 1 ? "" : "s"} did not resolve to a GST code (${unresolved
              .map(([name, n]) => `${name}: ${n}`)
              .join(", ")}) — those PINs will not fill in a state.`
          : "");
    }
    await db.referenceSync.update({
      where: { key: PIN_DIRECTORY_KEY },
      data: { status: "SUCCEEDED", finishedAt: new Date(), message },
    });
  } catch (error) {
    await db.referenceSync.update({
      where: { key: PIN_DIRECTORY_KEY },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        // Already stripped of the key by `fetchDirectory`; capped so a stack-sized message cannot fill
        // the settings page.
        message: (error instanceof Error ? error.message : String(error)).slice(0, 600),
      },
    });
  }
}

main()
  .catch(() => {
    /* recorded on the row above; there is nowhere else for output to go */
  })
  .finally(async () => {
    rmSync(scratch, { force: true });
    await db.$disconnect();
  });
