/**
 * Loads GeoNames' states, cities and postal codes — everything outside India — into geo_states,
 * geo_cities and geo_postal_codes.
 *
 *   npm run db:geonames             load from prisma/reference/geonames/
 *   npm run db:geonames:download    download from download.geonames.org first, then load
 *   Settings → World places         the same, in a worker (prisma/reference/geonames-worker.ts)
 *
 * The files are GeoNames' own (CC BY 4.0), kept in prisma/reference/geonames/ and never committed —
 * about 55 MB compressed. India is skipped throughout: its states are the GST list and its postal
 * codes are India Post's directory (post_offices), which are the authoritative sources and the ones
 * tax depends on.
 *
 * ## One dataset, one transaction
 *
 * Each table is replaced whole inside a transaction, so lookups see the old rows until the new ones
 * are all in — never half a table. A file much smaller than what is loaded is refused unless forced,
 * because a truncated download would otherwise empty most of the table. And a file whose checksum
 * matches what was last loaded is skipped: a sync that finds nothing new changes nothing.
 *
 * These are reference tables (src/lib/reference-data.ts): this file is one of the few places
 * allowed to delete from them.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync, createWriteStream } from "node:fs";
import path from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";
import { parseAdmin1Line, parseCityLine, parsePostalLine, plainText, postalKey } from "../../src/lib/geo/geonames";
import { fileLines, zipLines } from "../../src/lib/geo/zip-lines";

export const GEONAMES_DIR = path.join(process.cwd(), "prisma", "reference", "geonames");

export const GEONAMES_FILES = [
  { file: "countryInfo.txt", url: "https://download.geonames.org/export/dump/countryInfo.txt" },
  { file: "admin1CodesASCII.txt", url: "https://download.geonames.org/export/dump/admin1CodesASCII.txt" },
  { file: "cities1000.zip", url: "https://download.geonames.org/export/dump/cities1000.zip" },
  { file: "postal-allCountries.zip", url: "https://download.geonames.org/export/zip/allCountries.zip" },
  { file: "GB_full.csv.zip", url: "https://download.geonames.org/export/zip/GB_full.csv.zip" },
  { file: "CA_full.csv.zip", url: "https://download.geonames.org/export/zip/CA_full.csv.zip" },
  { file: "NL_full.csv.zip", url: "https://download.geonames.org/export/zip/NL_full.csv.zip" },
] as const;

/** The countries whose full postal codes come from a file of their own, replacing the short form. */
const FULL_POSTAL = [
  { country: "GB", file: "GB_full.csv.zip", entry: "GB_full.txt" },
  { country: "CA", file: "CA_full.csv.zip", entry: "CA_full.txt" },
  { country: "NL", file: "NL_full.csv.zip", entry: "NL_full.txt" },
] as const;

export const GEONAMES_KEYS = { states: "geonames-states", cities: "geonames-cities", postal: "geonames-postal" } as const;

const BATCH = 5000;
const SKIP_COUNTRY = "IN";

export type Progress = (message: string, done?: number, total?: number) => Promise<void> | void;
export type LoadOutcome = { key: string; outcome: "loaded" | "unchanged" | "missing" | "refused"; rows: number; detail?: string };

// ─── Download ────────────────────────────────────────────────────────────────────────────────────

/**
 * Every file, fetched to a `.part` beside its final name and renamed once complete — a failed or
 * interrupted download never replaces a good file. GeoNames' server drops connections often, so each
 * file is retried, resuming where it stopped.
 */
export async function downloadGeonames(dir: string, progress: Progress = () => {}): Promise<void> {
  mkdirSync(dir, { recursive: true });
  for (const [i, f] of GEONAMES_FILES.entries()) {
    await progress(`Downloading ${f.file} (${i + 1} of ${GEONAMES_FILES.length})…`, i, GEONAMES_FILES.length);
    const part = path.join(dir, `${f.file}.part`);
    rmSync(part, { force: true });
    let lastError = "";
    for (let attempt = 1; attempt <= 8; attempt++) {
      const have = existsSync(part) ? statSync(part).size : 0;
      try {
        const res = await fetch(f.url, { headers: have ? { range: `bytes=${have}-` } : {}, signal: AbortSignal.timeout(10 * 60_000) });
        if (!res.ok && res.status !== 206) throw new Error(`GeoNames answered ${res.status}`);
        if (have && res.status !== 206) rmSync(part, { force: true });
        const expected = Number(res.headers.get("content-length") ?? "0") + (res.status === 206 ? have : 0);
        const out = createWriteStream(part, { flags: res.status === 206 ? "a" : "w" });
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
        }
        await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
        const got = statSync(part).size;
        if (expected && got < expected) throw new Error(`stopped at ${got} of ${expected} bytes`);
        renameSync(part, path.join(dir, f.file));
        lastError = "";
        break;
      } catch (e) {
        lastError = (e as Error).message;
        await new Promise((r) => setTimeout(r, Math.min(30_000, 2_000 * attempt)));
      }
    }
    if (lastError) throw new Error(`Couldn't download ${f.file} from GeoNames: ${lastError}`);
  }
}

// ─── Load ────────────────────────────────────────────────────────────────────────────────────────

async function checksum(files: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files) {
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function unchanged(db: PrismaClient, key: string, sum: string): Promise<boolean> {
  const row = await db.referenceDataset.findUnique({ where: { key } });
  return row?.checksum === sum && row.rowCount > 0;
}

/** Refuses a file that would shrink the table to less than half — almost always a broken download. */
export function shrinks(current: number, next: number): boolean {
  return current > 1000 && next < current / 2;
}

async function recordDataset(tx: Prisma.TransactionClient, key: string, source: string, sum: string, rows: number, skipped: number) {
  await tx.referenceDataset.upsert({
    where: { key },
    create: { key, source, checksum: sum, rowCount: rows, skipped },
    update: { source, checksum: sum, rowCount: rows, skipped, loadedAt: new Date() },
  });
}

const TX = { timeout: 60 * 60_000, maxWait: 60_000 };

/**
 * After a replace, the old rows' space is marked for reuse and the planner's statistics refreshed.
 * Without it every sync leaves a table's worth of dead rows behind — the postal codes are ~700 MB, so
 * two syncs made them 1.4 GB. Plain VACUUM, not FULL: it takes no lock that would stop lookups.
 * Outside the transaction, where VACUUM has to run; a failure costs disk space, not the load.
 */
async function tidy(db: PrismaClient, table: "geo_states" | "geo_cities" | "geo_postal_codes") {
  try {
    await db.$executeRawUnsafe(`VACUUM ANALYZE "${table}"`);
  } catch {
    /* autovacuum will get to it */
  }
}

export async function loadStates(db: PrismaClient, dir: string, force = false): Promise<LoadOutcome> {
  const key = GEONAMES_KEYS.states;
  const file = path.join(dir, "admin1CodesASCII.txt");
  if (!existsSync(file)) return { key, outcome: "missing", rows: 0 };
  const sum = await checksum([file]);
  if (!force && (await unchanged(db, key, sum))) return { key, outcome: "unchanged", rows: await db.geoState.count() };

  const rows: Prisma.GeoStateCreateManyInput[] = [];
  let skipped = 0;
  for await (const line of fileLines(file)) {
    const s = parseAdmin1Line(line);
    if (!s) {
      if (line.trim()) skipped++;
      continue;
    }
    if (s.countryCode === SKIP_COUNTRY) continue;
    rows.push({ countryCode: s.countryCode, code: s.code, name: s.name, asciiName: s.asciiName });
  }
  const current = await db.geoState.count();
  if (!force && shrinks(current, rows.length)) return { key, outcome: "refused", rows: rows.length, detail: `only ${rows.length} states against ${current} loaded` };

  await db.$transaction(async (tx) => {
    await tx.geoState.deleteMany({});
    for (let i = 0; i < rows.length; i += BATCH) await tx.geoState.createMany({ data: rows.slice(i, i + BATCH), skipDuplicates: true });
    await recordDataset(tx, key, "GeoNames admin1CodesASCII.txt", sum, rows.length, skipped);
  }, TX);
  await tidy(db, "geo_states");
  return { key, outcome: "loaded", rows: rows.length };
}

export async function loadCities(db: PrismaClient, dir: string, force = false): Promise<LoadOutcome> {
  const key = GEONAMES_KEYS.cities;
  const file = path.join(dir, "cities1000.zip");
  if (!existsSync(file)) return { key, outcome: "missing", rows: 0 };
  const sum = await checksum([file]);
  if (!force && (await unchanged(db, key, sum))) return { key, outcome: "unchanged", rows: await db.geoCity.count() };

  const rows: Prisma.GeoCityCreateManyInput[] = [];
  let skipped = 0;
  for await (const line of zipLines(file, "cities1000.txt")) {
    const c = parseCityLine(line);
    if (!c) {
      if (line.trim()) skipped++;
      continue;
    }
    if (c.countryCode === SKIP_COUNTRY) continue;
    rows.push({
      id: c.id,
      name: c.name,
      asciiName: c.asciiName,
      plainName: plainText(c.name),
      countryCode: c.countryCode,
      stateCode: c.admin1Code,
      population: c.population,
      latitude: c.latitude,
      longitude: c.longitude,
    });
  }
  const current = await db.geoCity.count();
  if (!force && shrinks(current, rows.length)) return { key, outcome: "refused", rows: rows.length, detail: `only ${rows.length} cities against ${current} loaded` };

  await db.$transaction(async (tx) => {
    await tx.geoCity.deleteMany({});
    for (let i = 0; i < rows.length; i += BATCH) await tx.geoCity.createMany({ data: rows.slice(i, i + BATCH), skipDuplicates: true });
    await recordDataset(tx, key, "GeoNames cities1000", sum, rows.length, skipped);
  }, TX);
  await tidy(db, "geo_cities");
  return { key, outcome: "loaded", rows: rows.length };
}

/**
 * The postal codes: the all-countries file, less India and less the countries whose full file is
 * here too, then each full file. Streamed straight into the transaction in batches — the full set is
 * several million rows, and none of it needs holding at once.
 */
export async function loadPostal(db: PrismaClient, dir: string, progress: Progress = () => {}, force = false): Promise<LoadOutcome> {
  const key = GEONAMES_KEYS.postal;
  const main = path.join(dir, "postal-allCountries.zip");
  if (!existsSync(main)) return { key, outcome: "missing", rows: 0 };
  const full = FULL_POSTAL.filter((f) => existsSync(path.join(dir, f.file)));
  const sum = await checksum([main, ...full.map((f) => path.join(dir, f.file))]);
  if (!force && (await unchanged(db, key, sum))) return { key, outcome: "unchanged", rows: await db.geoPostalCode.count() };

  const replaced = new Set<string>([SKIP_COUNTRY, ...full.map((f) => f.country)]);
  const sources: { file: string; entry: string; only?: string }[] = [
    { file: main, entry: "allCountries.txt" },
    ...full.map((f) => ({ file: path.join(dir, f.file), entry: f.entry, only: f.country })),
  ];

  // Counted first, so a truncated file is refused before anything is deleted.
  let incoming = 0;
  for (const s of sources) {
    for await (const line of zipLines(s.file, s.entry)) {
      const p = parsePostalLine(line);
      if (p && (s.only ? p.countryCode === s.only : !replaced.has(p.countryCode))) incoming++;
    }
  }
  const current = await db.geoPostalCode.count();
  if (!force && shrinks(current, incoming)) return { key, outcome: "refused", rows: incoming, detail: `only ${incoming} postal codes against ${current} loaded` };

  let written = 0;
  let skipped = 0;
  await db.$transaction(async (tx) => {
    await tx.geoPostalCode.deleteMany({});
    let batch: Prisma.GeoPostalCodeCreateManyInput[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      await tx.geoPostalCode.createMany({ data: batch });
      written += batch.length;
      batch = [];
      await progress("Loading postal codes…", written, incoming);
    };
    for (const s of sources) {
      for await (const line of zipLines(s.file, s.entry)) {
        const p = parsePostalLine(line);
        if (!p) {
          if (line.trim()) skipped++;
          continue;
        }
        if (s.only ? p.countryCode !== s.only : replaced.has(p.countryCode)) continue;
        batch.push({
          countryCode: p.countryCode,
          postalCode: p.postalCode,
          postalKey: postalKey(p.postalCode),
          placeName: p.placeName,
          stateName: p.admin1Name,
          stateCode: p.admin1Code,
          district: p.admin2Name,
          latitude: p.latitude,
          longitude: p.longitude,
        });
        if (batch.length >= BATCH) await flush();
      }
    }
    await flush();
    await recordDataset(tx, key, `GeoNames postal codes${full.length ? ` (full ${full.map((f) => f.country).join(", ")})` : ""}`, sum, written, skipped);
  }, TX);
  await tidy(db, "geo_postal_codes");
  return { key, outcome: "loaded", rows: written };
}

export async function loadGeonames(db: PrismaClient, dir = GEONAMES_DIR, progress: Progress = () => {}, force = false): Promise<LoadOutcome[]> {
  await progress("Loading states and provinces…");
  const states = await loadStates(db, dir, force);
  await progress("Loading towns and cities…");
  const cities = await loadCities(db, dir, force);
  await progress("Counting postal codes…");
  const postal = await loadPostal(db, dir, progress, force);
  return [states, cities, postal];
}

/**
 * For the seed and the restore: loads whatever is empty from the files, if they are here. With no
 * files it says how to get them and carries on — an installation without world places still works,
 * with free-text addresses outside India.
 */
export async function ensureGeonames(db: PrismaClient): Promise<void> {
  const [states, cities, postal] = await Promise.all([db.geoState.count(), db.geoCity.count(), db.geoPostalCode.count()]);
  if (states > 0 && cities > 0 && postal > 0) return;
  if (!existsSync(GEONAMES_DIR)) {
    console.log("  World places: no GeoNames files yet — run `npm run db:geonames:download` or sync from Settings → World places.");
    return;
  }
  const outcomes = await loadGeonames(db, GEONAMES_DIR);
  for (const o of outcomes) console.log(`  World places: ${o.key} ${o.outcome}${o.rows ? ` (${o.rows.toLocaleString("en-IN")} rows)` : ""}`);
}
