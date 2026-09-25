import { randomBytes, timingSafeEqual } from "node:crypto";
import { digestSecret } from "@/lib/crypto";

/**
 * Credentials for the lead capture API — a key ID and a secret, used as HTTP Basic auth.
 *
 * Basic because every language, every form plugin and every "send to webhook" setting can do it
 * without a library, and a key ID plus a secret is the "API and password" people expect. The key ID
 * is public (it is the username, and it appears in the settings list); the secret is shown once and
 * kept only as a digest, so a copy of the database cannot be used to send leads.
 */

export type Credentials = { keyId: string; secret: string };

/** A fresh pair. 160 bits of ID, 256 of secret — neither guessable nor worth trying. */
export function newCredentials(): Credentials {
  return {
    keyId: `lck_${randomBytes(10).toString("hex")}`,
    secret: `lcs_${randomBytes(32).toString("base64url")}`,
  };
}

/** `Authorization: Basic base64(keyId:secret)` read back, or null for anything else. */
export function parseBasicAuth(header: string | null): Credentials | null {
  if (!header || !/^basic /i.test(header)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon <= 0) return null;
  const keyId = decoded.slice(0, colon).trim();
  const secret = decoded.slice(colon + 1).trim();
  if (!/^lck_[0-9a-f]{20}$/.test(keyId) || secret.length < 10 || secret.length > 200) return null;
  return { keyId, secret };
}

/** Whether a secret is the one a digest was made from — compared in constant time. */
export async function secretMatches(secret: string, digest: string): Promise<boolean> {
  const a = Buffer.from(await digestSecret(secret));
  const b = Buffer.from(digest);
  return a.length === b.length && timingSafeEqual(a, b);
}
