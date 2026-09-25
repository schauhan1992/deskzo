import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import path from "node:path";
import Papa from "papaparse";
import { Prisma, type PrismaClient } from "@prisma/client";
import { PIN_DIRECTORY_KEY, mapColumns, parseRow, type PostOfficeRow, type SkipReason } from "../../src/lib/geo/pincode";

/**
 * Loads India Post's All India Pincode Directory into `post_offices`.
 *
 * ## The source
 *
 * The Department of Posts publishes it monthly on the Government's open-data platform:
 * data.gov.in → "All India Pincode Directory till last month". It is Government Open Data Licence
 * material — free to reuse, attribution to the Department of Posts. The copy this app uses is
 * committed at `prisma/reference/india-post-pincodes.csv.gz`, so every machine and every
 * `migrate reset` gets the same directory without anybody downloading it again.
 *
 * ## What "load" means
 *
 * Replace, not merge. The file is the whole directory; a PIN that was closed last month should stop
 * being offered this month, which only a replacement does. The replacement is one transaction, so a
 * reader never sees the table half-empty.
 *
 * The same file twice is a no-op — its SHA-256 is recorded against `india-post-pincodes` in
 * `reference_datasets` — so this is safe to call from `prisma/seed.ts` on every run.
 */

export const CANONICAL_FILE = path.join(__dirname, "india-post-pincodes.csv.gz");

export type LoadResult =
  | { status: "unchanged"; rows: number }
  | {
      status: "loaded";
      rows: number;
      previous: number;
      skipped: Record<SkipReason, number>;
      unresolvedStates: Record<string, number>;
      pincodes: number;
    };

/** A file as text, gzipped or not — told apart by its first two bytes, not its name. */
export function readDirectoryFile(file: string): { text: string; checksum: string } {
  const raw = readFileSync(file);
  const checksum = createHash("sha256").update(raw).digest("hex");
  const bytes = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  // A byte-order mark would otherwise become part of the first heading, and "\uFEFFcirclename"
  // matches no column — the kind of failure that looks like a wrong file rather than a stray byte.
  return { text: bytes.toString("utf8").replace(/^\uFEFF/, ""), checksum };
}

/** Every usable row of a directory file, plus what was set aside and why. */
export function parseDirectory(text: string) {
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: "greedy" });
  const columns = mapColumns(parsed.meta.fields ?? []);
  if (!columns.ok) {
    throw new Error(
      `This doesn't look like the India Post directory — it has no ${columns.missing.join(", ")} column. ` +
        `Found: ${(parsed.meta.fields ?? []).slice(0, 12).join(", ") || "no headings at all"}.`,
    );
  }

  const rows: PostOfficeRow[] = [];
  const skipped: Record<SkipReason, number> = { "bad-pincode": 0, "no-office": 0, "no-district": 0 };
  const unresolvedStates: Record<string, number> = {};

  for (const record of parsed.data) {
    const row = parseRow(record, columns.map);
    if ("skip" in row) {
      skipped[row.skip] += 1;
      continue;
    }
    if (!row.stateCode) unresolvedStates[row.stateName || "(blank)"] = (unresolvedStates[row.stateName || "(blank)"] ?? 0) + 1;
    rows.push(row);
  }
  return { rows, skipped, unresolvedStates };
}

/**
 * The floor below which a new file is refused rather than loaded.
 *
 * Replacing 165,000 rows with whatever a file contains means a truncated download, or the wrong CSV
 * with a column that happens to be called "pincode", would empty the lookup for the whole country
 * in one transaction. A real month-on-month change moves a few hundred offices. Losing half of them
 * is not an update; `force` exists for the day it genuinely is.
 */
const MIN_SHARE_OF_PREVIOUS = 0.5;

/**
 * Why a load should not go ahead, or null if it should.
 *
 * Pure so it can be checked on its own. The alternative — handing the real loader a one-line file to
 * see whether it refuses — would, the day this guard broke, replace the country's post offices with
 * that one line. A check must not be able to destroy the data it exists to protect.
 */
export function refusalFor(current: number, incoming: number, force: boolean): string | null {
  if (incoming === 0) return "The file parsed, but not one row in it was a usable post office.";
  if (!force && current > 0 && incoming < current * MIN_SHARE_OF_PREVIOUS) {
    return (
      `Refusing to replace ${current.toLocaleString("en-IN")} post offices with ${incoming.toLocaleString("en-IN")} — ` +
      `that is less than half, which looks like a truncated or wrong file. Re-run with --force if it is right.`
    );
  }
  return null;
}

export async function loadPincodes(
  db: PrismaClient,
  options: {
    file?: string;
    force?: boolean;
    log?: (line: string) => void;
    /** What `reference_datasets.source` records — the file name unless something better is known. */
    sourceLabel?: string;
  } = {},
): Promise<LoadResult> {
  const file = options.file ?? CANONICAL_FILE;
  const log = options.log ?? (() => {});
  if (!existsSync(file)) throw new Error(`No directory file at ${file}.`);

  const { text, checksum } = readDirectoryFile(file);
  const [recorded, current] = await Promise.all([
    db.referenceDataset.findUnique({ where: { key: PIN_DIRECTORY_KEY } }),
    db.postOffice.count(),
  ]);

  // Unchanged means the same file *and* the rows still there. A matching checksum over an empty
  // table is a table somebody emptied by hand, and the fix for that is to load it again.
  if (!options.force && recorded?.checksum === checksum && current === recorded.rowCount) {
    return { status: "unchanged", rows: current };
  }

  const { rows, skipped, unresolvedStates } = parseDirectory(text);
  const refusal = refusalFor(current, rows.length, Boolean(options.force));
  if (refusal) throw new Error(refusal);

  log(`  ${rows.length.toLocaleString("en-IN")} post offices parsed — replacing ${current.toLocaleString("en-IN")}`);

  const BATCH = 5000;
  await db.$transaction(
    async (tx) => {
      await tx.postOffice.deleteMany({});
      for (let i = 0; i < rows.length; i += BATCH) {
        await tx.postOffice.createMany({
          data: rows.slice(i, i + BATCH).map((r) => ({
            ...r,
            latitude: r.latitude === null ? null : new Prisma.Decimal(r.latitude),
            longitude: r.longitude === null ? null : new Prisma.Decimal(r.longitude),
          })),
        });
      }
      const record = {
        source: options.sourceLabel ?? path.basename(file),
        checksum,
        rowCount: rows.length,
        skipped: Object.values(skipped).reduce((a, b) => a + b, 0),
        unresolvedStates: Object.keys(unresolvedStates).length ? unresolvedStates : Prisma.JsonNull,
        loadedAt: new Date(),
      };
      await tx.referenceDataset.upsert({
        where: { key: PIN_DIRECTORY_KEY },
        create: { key: PIN_DIRECTORY_KEY, ...record },
        update: record,
      });
    },
    { timeout: 10 * 60 * 1000, maxWait: 30 * 1000 },
  );

  return {
    status: "loaded",
    rows: rows.length,
    previous: current,
    skipped,
    unresolvedStates,
    pincodes: new Set(rows.map((r) => r.pincode)).size,
  };
}

/**
 * Keeps a loaded file as the committed copy, compressed — and says how big it came out.
 *
 * Only ever called *after* a file has loaded cleanly, so the copy every other machine and every
 * `migrate reset` reloads from is always the last good one. A file that is already gzipped is
 * kept as it is rather than compressed twice.
 */
export function saveCanonicalCopy(file: string): number {
  const raw = readFileSync(file);
  const gz = raw[0] === 0x1f && raw[1] === 0x8b ? raw : gzipSync(raw, { level: 9 });
  writeFileSync(CANONICAL_FILE, gz);
  return gz.length;
}

/**
 * The directory, if it is missing or stale — and silence if there is no file to load it from.
 *
 * What `prisma/seed.ts` calls. A fresh checkout without the file committed yet must still seed, so a
 * missing file is a note rather than a failure; everything else that goes wrong is reported.
 */
export async function ensurePincodes(db: PrismaClient, log: (line: string) => void = console.log): Promise<void> {
  if (!existsSync(CANONICAL_FILE)) {
    log("  PIN directory: no file at prisma/reference/india-post-pincodes.csv.gz — skipped (see prisma/reference/README.md)");
    return;
  }
  const result = await loadPincodes(db, { log });
  log(
    result.status === "unchanged"
      ? `  PIN directory: already loaded (${result.rows.toLocaleString("en-IN")} post offices)`
      : `  PIN directory: loaded ${result.rows.toLocaleString("en-IN")} post offices across ${result.pincodes.toLocaleString("en-IN")} PINs`,
  );
}
