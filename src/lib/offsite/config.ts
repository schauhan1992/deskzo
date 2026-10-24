import path from "node:path";
import { backupBase } from "@/lib/backup/maintenance";
import { logBase } from "@/lib/logs/access-log";
import { OffsiteError, normalPrefix, openStore, type OffsiteStore, type StoreConfig } from "@/lib/offsite/store";
import { getSecret, getSetting } from "@/lib/platform/settings";

/**
 * The off-site store as an owner set it in the console (Settings › Backups & logs), and how long
 * backups and logs are kept there.
 *
 *   offsite.provider         "azure" | "s3" | "filesystem"; unset — nothing leaves the server
 *   offsite.config           the store's address as JSON, without its secret
 *   offsite.secret           the SAS token or secret access key, sealed, never shown back
 *   offsite.backupKeepDays   35 unless set (owner, 24 Oct 2026); 7–3650
 *   offsite.logKeepDays      365 unless set (owner, 24 Oct 2026); 180–3650 — CERT-In's Directions of
 *                            April 2022 require 180 days at least, so less can't be chosen
 *
 * Plain http is refused except to this machine: a SAS token or a signed request crossing the internet
 * in the clear is a key handed to whoever is listening.
 */

export const OFFSITE_PROVIDERS = ["azure", "s3", "filesystem"] as const;
export type OffsiteProvider = (typeof OFFSITE_PROVIDERS)[number];

export const BACKUP_KEEP_DAYS = { min: 7, max: 3650, fallback: 35 } as const;
export const LOG_KEEP_DAYS = { min: 180, max: 3650, fallback: 365 } as const;
/** However few days are set, this many of each workspace's newest backups stay off-site. */
export const OFFSITE_KEEP_MINIMUM = 3;

export type OffsiteSetup = {
  config: StoreConfig | null;
  secretSet: boolean;
  backupKeepDays: number;
  logKeepDays: number;
};

const days = (raw: string | null, range: { min: number; max: number; fallback: number }) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= range.min && n <= range.max ? n : range.fallback;
};

export async function offsiteSetup(): Promise<OffsiteSetup> {
  const [provider, raw, backupKeep, logKeep, secret] = await Promise.all([
    getSetting("offsite.provider"),
    getSetting("offsite.config"),
    getSetting("offsite.backupKeepDays"),
    getSetting("offsite.logKeepDays"),
    getSecret("offsite.secret").catch(() => null),
  ]);
  let config: StoreConfig | null = null;
  if (provider && raw) {
    try {
      config = parseStoreConfig({ ...(JSON.parse(raw) as object), provider });
    } catch {
      config = null;
    }
  }
  return { config, secretSet: !!secret, backupKeepDays: days(backupKeep, BACKUP_KEEP_DAYS), logKeepDays: days(logKeep, LOG_KEEP_DAYS) };
}

/** The store to write to now, or null when none is set up — or its secret is missing. */
export async function currentStore(): Promise<{ store: OffsiteStore; setup: OffsiteSetup } | null> {
  const setup = await offsiteSetup();
  if (!setup.config) return null;
  const secret = setup.config.provider === "filesystem" ? null : await getSecret("offsite.secret");
  if (setup.config.provider !== "filesystem" && !secret) return null;
  return { store: openStore(setup.config, secret), setup };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function address(raw: unknown, what: string): URL {
  const text = typeof raw === "string" ? raw.trim() : "";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new OffsiteError(`The ${what} isn't a web address.`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw new OffsiteError(`The ${what} must start https:// — keys and backups don't cross the internet in the clear.`);
  }
  if (url.username || url.password) throw new OffsiteError(`The ${what} can't carry a user name or password.`);
  return url;
}

function prefixOf(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "deskzo";
  if (!/^[A-Za-z0-9._\-/]{0,100}$/.test(text) || text.split("/").some((s) => s === "." || s === "..")) {
    throw new OffsiteError("The folder inside the store may use letters, digits, dots, dashes, underscores and slashes.");
  }
  return normalPrefix(text).replace(/\/$/, "");
}

/** A store's settings, checked. Throws `OffsiteError` with what to fix. */
export function parseStoreConfig(input: unknown): StoreConfig {
  const x = (input ?? {}) as Record<string, unknown>;
  const prefix = prefixOf(x.prefix);
  if (x.provider === "azure") {
    const url = address(x.containerUrl, "container address");
    if (url.search) throw new OffsiteError("Paste the container's address without the part after the ?: that is the SAS token, which has its own field.");
    const parts = url.pathname.split("/").filter(Boolean);
    // Azure: /<container>. The Azurite emulator puts the account first: /<account>/<container>.
    if (parts.length < 1 || parts.length > 2 || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(parts[parts.length - 1])) {
      throw new OffsiteError("The address should end with the container's name: https://<account>.blob.core.windows.net/<container>.");
    }
    return { provider: "azure", containerUrl: `${url.origin}/${parts.join("/")}`, prefix };
  }
  if (x.provider === "s3") {
    const url = address(x.endpoint, "endpoint");
    if (url.pathname !== "/" || url.search) throw new OffsiteError("The endpoint is just the address, like https://s3.ap-south-1.amazonaws.com — the bucket has its own field.");
    const region = typeof x.region === "string" && x.region.trim() ? x.region.trim() : "us-east-1";
    if (!/^[a-z0-9-]{1,32}$/.test(region)) throw new OffsiteError("The region is a short name like ap-south-1 (Cloudflare R2: auto).");
    const bucket = typeof x.bucket === "string" ? x.bucket.trim() : "";
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new OffsiteError("A bucket's name is 3 to 63 lower-case letters, digits, dots and dashes.");
    const accessKeyId = typeof x.accessKeyId === "string" ? x.accessKeyId.trim() : "";
    if (!/^[A-Za-z0-9/+=_-]{8,128}$/.test(accessKeyId)) throw new OffsiteError("That doesn't look like an access key id.");
    return { provider: "s3", endpoint: url.origin, region, bucket, accessKeyId, pathStyle: x.pathStyle === true, prefix };
  }
  if (x.provider === "filesystem") {
    const folder = typeof x.path === "string" ? x.path.trim() : "";
    if (!folder || !path.isAbsolute(folder)) throw new OffsiteError("Give the folder's full path, like /mnt/offsite.");
    const resolved = path.resolve(folder);
    for (const [inside, what] of [
      [backupBase(), "BACKUP_DIR"],
      [logBase(), "the log folder"],
    ] as const) {
      const rel = path.relative(inside, resolved);
      if (!rel || (!rel.startsWith("..") && !path.isAbsolute(rel))) throw new OffsiteError(`The folder can't be inside ${what}: a copy on the same disk is not off-site.`);
    }
    return { provider: "filesystem", path: resolved, prefix };
  }
  throw new OffsiteError("Choose Azure Blob, S3-compatible storage or a folder.");
}

/** What is stored in `offsite.config`: the settings without the provider, which has its own key. */
export function storedConfig(config: StoreConfig): string {
  const rest: Record<string, unknown> = { ...config };
  delete rest.provider;
  return JSON.stringify(rest);
}

export function parseKeepDays(raw: unknown, which: "backups" | "logs"): number {
  const range = which === "backups" ? BACKUP_KEEP_DAYS : LOG_KEEP_DAYS;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(n) || n < range.min || n > range.max) {
    throw new OffsiteError(
      which === "logs"
        ? `Logs are kept ${range.min} to ${range.max} days — CERT-In requires 180 at least.`
        : `Backups are kept ${range.min} to ${range.max} days.`,
    );
  }
  return n;
}
