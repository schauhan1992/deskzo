import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Reader, type CityResponse } from "mmdb-lib";
import { formatIp, isPrivateIp, parseIp } from "@/lib/access/ip";

/**
 * Where an address is, from a location database on this server.
 *
 * Offline on purpose: an online lookup would send every member of staff's address, at every sign-in,
 * to a third party. The database is a MaxMind-format (.mmdb) city file — DB-IP's free "IP to City
 * Lite" by default, which is licensed CC BY 4.0 and so must be credited wherever its answers are
 * shown (`GEO_ATTRIBUTION`). MaxMind's GeoLite2 City works the same way if somebody prefers it.
 *
 * The newest .mmdb in the directory wins, so replacing next month's file is dropping it in. It is
 * read into memory on first use (~125 MB for the city file) and re-read when the file changes,
 * checked at most once a minute.
 *
 * Answers are city-level and approximate. Mobile data very often surfaces in the operator's hub
 * city, and a VPN surfaces wherever its server is — the screens say so.
 */

export const GEO_ATTRIBUTION = { text: "IP location by DB-IP", url: "https://db-ip.com" };

export function geoDirectory(): string {
  return path.resolve(process.env.GEOIP_DIR?.trim() || "geoip");
}

export type GeoResult = {
  city: string | null;
  region: string | null;
  countryCode: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
};

type Loaded = { reader: Reader<CityResponse>; file: string; mtimeMs: number; size: number; type: string; builtAt: Date };

let loaded: Loaded | null = null;
let checkedAt = 0;

function newestDatabase(): { file: string; mtimeMs: number; size: number } | null {
  const dir = geoDirectory();
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".mmdb"));
  } catch {
    return null;
  }
  const files = names.map((n) => {
    const file = path.join(dir, n);
    const s = statSync(file);
    return { file, mtimeMs: s.mtimeMs, size: s.size };
  });
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0] ?? null;
}

function database(): Loaded | null {
  const now = Date.now();
  if (loaded && now - checkedAt < 60_000) return loaded;
  checkedAt = now;
  const newest = newestDatabase();
  if (!newest) {
    loaded = null;
    return null;
  }
  if (loaded && loaded.file === newest.file && loaded.mtimeMs === newest.mtimeMs) return loaded;
  try {
    const reader = new Reader<CityResponse>(readFileSync(newest.file));
    loaded = {
      reader,
      file: newest.file,
      mtimeMs: newest.mtimeMs,
      size: newest.size,
      type: reader.metadata.databaseType,
      builtAt: new Date(reader.metadata.buildEpoch),
    };
  } catch (err) {
    // A half-copied or wrong file must not take sign-in down with it: no location is the answer.
    console.error("geo database could not be read", err);
    loaded = null;
  }
  return loaded;
}

/** Forget the loaded file — after an upload, so the next lookup reads the new one. */
export function reloadGeoDatabase() {
  loaded = null;
  checkedAt = 0;
}

export function geoDatabaseInfo(): { installed: boolean; file: string | null; type: string | null; builtAt: Date | null; sizeBytes: number | null; directory: string } {
  const db = database();
  return {
    installed: db !== null,
    file: db ? path.basename(db.file) : null,
    type: db?.type ?? null,
    builtAt: db?.builtAt ?? null,
    sizeBytes: db?.size ?? null,
    directory: geoDirectory(),
  };
}

/**
 * Null for an address the database does not know, for a private address (the office LAN is not a
 * place on the internet), and when no database is installed.
 */
export function lookupIp(ip: string | null | undefined): GeoResult | null {
  const parsed = parseIp(ip);
  if (!parsed || isPrivateIp(parsed)) return null;
  const db = database();
  if (!db) return null;
  let record: CityResponse | null = null;
  try {
    record = db.reader.get(formatIp(parsed)) ?? null;
  } catch {
    return null;
  }
  if (!record) return null;
  return {
    city: record.city?.names?.en ?? null,
    region: record.subdivisions?.[0]?.names?.en ?? null,
    countryCode: record.country?.iso_code ?? null,
    country: record.country?.names?.en ?? null,
    latitude: record.location?.latitude ?? null,
    longitude: record.location?.longitude ?? null,
  };
}

/** "Pune, Maharashtra, India" — as much of it as is known. */
export function placeText(g: { city: string | null; region: string | null; country: string | null } | null): string | null {
  if (!g) return null;
  const parts = [g.city, g.region, g.country].filter((p, i, all): p is string => !!p && all.indexOf(p) === i);
  return parts.length ? parts.join(", ") : null;
}
