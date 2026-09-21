import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from "crypto";

/**
 * Symmetric encryption for secrets we must store (TOTP secrets, the Microsoft SSO client secret) but
 * never want to leak in a DB dump. Keyed from AUTH_SECRET, which every deployment of this app already
 * requires for NextAuth — no separate key to provision or lose track of.
 */
function getSecret() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET must be set to encrypt/decrypt stored secrets.");
  }
  return secret;
}

function getKey() {
  return scryptSync(getSecret(), "wroffy-crm-secret-store", 32);
}

export function encryptSecret(plainText: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(":");
}

/**
 * A one-way fingerprint of a secret, for spotting the same password used twice.
 *
 * HMAC rather than a plain hash, and keyed from the same `AUTH_SECRET`: a bare SHA-256 of a
 * password is reversible in seconds against any wordlist, so a column of them would be a worse
 * liability than the ciphertext beside it. With the key it is only useful for equality — two rows
 * with the same digest hold the same secret, and nothing about the digest says what that secret is.
 *
 * Deliberately a different salt from `getKey`, so a digest can never be mistaken for key material.
 */
export function digestSecret(plainText: string): string {
  return createHmac("sha256", scryptSync(getSecret(), "wroffy-crm-secret-digest", 32))
    .update(plainText, "utf8")
    .digest("base64");
}

export function decryptSecret(cipherText: string): string {
  const [ivB64, authTagB64, dataB64] = cipherText.split(":");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}
