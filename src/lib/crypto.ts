import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "crypto";
import { currentKeys, type TenantKeys } from "@/lib/tenancy/keys";

/**
 * Symmetric encryption for secrets we must store (two-factor seeds, the vault, mailbox tokens,
 * provider keys) but never want to leak in a database dump.
 *
 * Keyed per workspace: each has its own data key and digest key (src/lib/tenancy/keys.ts), so a
 * ciphertext copied from one workspace's database into another's opens as nothing. Asynchronous
 * because finding the workspace's keys may mean opening its key bundle.
 *
 * The stored format — `iv:tag:data`, base64 — is the one the installation always wrote. The first
 * workspace's keys are the ones it was written under, so everything stored before workspaces reads
 * back unchanged.
 */

export function encryptWith(keys: Pick<TenantKeys, "dataKey">, plainText: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.dataKey, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(":");
}

export function decryptWith(keys: Pick<TenantKeys, "dataKey">, cipherText: string): string {
  const [ivB64, authTagB64, dataB64] = cipherText.split(":");
  const decipher = createDecipheriv("aes-256-gcm", keys.dataKey, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

export async function encryptSecret(plainText: string): Promise<string> {
  return encryptWith(await currentKeys(), plainText);
}

export async function decryptSecret(cipherText: string): Promise<string> {
  return decryptWith(await currentKeys(), cipherText);
}

/**
 * A one-way fingerprint of a secret, for spotting the same password used twice.
 *
 * HMAC rather than a plain hash, under the workspace's digest key: a bare SHA-256 of a password is
 * reversible in seconds against any wordlist, so a column of them would be a worse liability than
 * the ciphertext beside it. With the key it is only useful for equality — two rows with the same
 * digest hold the same secret, and nothing about the digest says what that secret is.
 */
export async function digestSecret(plainText: string): Promise<string> {
  const { digestKey } = await currentKeys();
  return createHmac("sha256", digestKey).update(plainText, "utf8").digest("base64");
}
