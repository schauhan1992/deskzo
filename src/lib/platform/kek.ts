import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, type Hmac } from "node:crypto";

/**
 * The platform key: what every workspace's own keys, and its database address, are sealed under in
 * the control plane.
 *
 * Derived from PLATFORM_MASTER_KEY (base64 of 32 random bytes; set once, backed up with the
 * database backups, never changed without re-sealing every workspace). Nothing is ever encrypted
 * with it directly except these seals, so it can later move into a cloud key service behind these
 * two functions without anything else noticing.
 *
 * Each seal is bound to its workspace and its purpose as AES-GCM associated data: a sealed key
 * bundle copied onto another workspace's row, or a database address pasted into the key bundle's
 * column, fails to open rather than opening as something else.
 */

const FORMAT = "k1";
let cached: { raw: string; key: Buffer } | null = null;

function platformKey(): Buffer {
  const raw = process.env.PLATFORM_MASTER_KEY?.trim();
  if (!raw) throw new Error("PLATFORM_MASTER_KEY is not set, so workspace keys cannot be opened.");
  if (cached?.raw === raw) return cached.key;
  const decoded = Buffer.from(raw, "base64");
  const isBase64 = decoded.toString("base64").replace(/=+$/, "") === raw.replace(/=+$/, "");
  const material = isBase64 ? decoded : Buffer.from(raw, "utf8");
  if (material.length < 32) throw new Error("PLATFORM_MASTER_KEY must be at least 32 bytes — base64 of 32 random bytes.");
  const key = Buffer.from(hkdfSync("sha256", material, "wroffy/platform", "kek/v1", 32));
  cached = { raw, key };
  return key;
}

export type SealPurpose = "db-url" | "key-bundle";

/** Whose it is and what for, as GCM associated data: "<tenant id>|db-url", "platform|reference-sync-key". */
const aad = (owner: string, purpose: string) => Buffer.from(`${owner}|${purpose}`, "utf8");

function seal(owner: string, purpose: string, plainText: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", platformKey(), iv);
  cipher.setAAD(aad(owner, purpose));
  const data = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return [FORMAT, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

function open(owner: string, purpose: string, sealed: string): string {
  const [format, iv, tag, data] = sealed.split(".");
  if (format !== FORMAT || !iv || !tag || data === undefined) throw new Error("Not a sealed value this platform wrote.");
  const decipher = createDecipheriv("aes-256-gcm", platformKey(), Buffer.from(iv, "base64url"));
  decipher.setAAD(aad(owner, purpose));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

export function sealForTenant(tenantId: string, purpose: SealPurpose, plainText: string): string {
  return seal(tenantId, purpose, plainText);
}

export function openForTenant(tenantId: string, purpose: SealPurpose, sealed: string): string {
  return open(tenantId, purpose, sealed);
}

export type SignPurpose = "backup-archive";

/**
 * A signature only the platform can make, for one workspace and one purpose — derived from the
 * platform key, so it needs no key of its own and nobody without PLATFORM_MASTER_KEY can forge one.
 * A backup archive the platform wrote carries one; a file crafted elsewhere, or written for another
 * workspace, does not verify (src/lib/backup/archive.ts).
 */
export function platformHmac(tenantId: string, purpose: SignPurpose): Hmac {
  const key = Buffer.from(hkdfSync("sha256", platformKey(), "wroffy/platform-sign", `${purpose}|${tenantId}`, 32));
  return createHmac("sha256", key);
}

/** Whether signatures can be made and checked here at all. */
export function platformKeyConfigured(): boolean {
  return !!process.env.PLATFORM_MASTER_KEY?.trim();
}

export type PlatformSealPurpose = "reference-sync-key" | "warm-db-url" | "staff-totp";

/**
 * Sealing for something that belongs to no workspace — the data.gov.in key that refreshes the shared
 * PIN directory. Same key and format as `sealForTenant`, bound to "platform" and the purpose instead.
 * "platform" is a reserved name (src/lib/tenancy/host.ts), so no workspace's id is ever that, and a
 * workspace's sealed value can never be passed off as one of these or the reverse.
 */
export function sealForPlatform(purpose: PlatformSealPurpose, plainText: string): string {
  return seal("platform", purpose, plainText);
}

export function openForPlatform(purpose: PlatformSealPurpose, sealed: string): string {
  return open("platform", purpose, sealed);
}
