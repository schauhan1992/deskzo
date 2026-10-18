import { randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { digestSecret } from "@/lib/crypto";
import { isApiScope, type ApiScope } from "@/lib/api/scopes";

/**
 * Public API keys (owner, 17 Oct 2026): a key ID and a secret, sent together as one bearer token —
 * `Authorization: Bearer dzk_….dzs_…`. The key ID is public (it is in the settings list); the secret
 * is shown once and kept only as a digest under the workspace's digest key, so a copy of the database
 * can't call the API. A key acts as the person who made it (src/lib/api/actor.ts).
 */

export class ApiKeyRefused extends Error {}

const KEY_ID = /^dzk_[0-9a-f]{20}$/;
const SECRET = /^dzs_[A-Za-z0-9_-]{43}$/;
/** Keys a person may hold at once, live or not yet expired. */
export const MAX_KEYS_PER_PERSON = 20;

export type ApiToken = { keyId: string; secret: string };

/** A fresh pair: 80 bits of ID, 256 of secret. */
export function newApiToken(): ApiToken {
  return { keyId: `dzk_${randomBytes(10).toString("hex")}`, secret: `dzs_${randomBytes(32).toString("base64url")}` };
}

/** The token as it is sent: one string, the two halves joined by a dot. */
export const tokenText = (t: ApiToken) => `${t.keyId}.${t.secret}`;

/** `Authorization: Bearer <keyId>.<secret>` read back — or null for anything else. */
export function parseBearer(header: string | null): ApiToken | null {
  const match = /^bearer\s+(\S+)$/i.exec(String(header ?? "").trim());
  if (!match) return null;
  const [keyId, secret, extra] = match[1]!.split(".");
  if (extra !== undefined || !keyId || !secret || !KEY_ID.test(keyId) || !SECRET.test(secret)) return null;
  return { keyId, secret };
}

/** Whether a secret is the one a digest was made from — in constant time. */
export async function apiSecretMatches(secret: string, digest: string): Promise<boolean> {
  const a = Buffer.from(await digestSecret(secret));
  const b = Buffer.from(digest);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type NewKeyInput = { name: string; scopes: string[]; expiresAt?: Date | null };

/** Makes a key acting as `userId`; the token is returned once and never again. */
export async function createApiKey(userId: string, input: NewKeyInput, now = new Date()): Promise<{ id: string; keyId: string; token: string }> {
  const name = String(input.name ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
  if (name.length < 2) throw new ApiKeyRefused("Name the key — what it's for, like “Zapier”.");
  const scopes = [...new Set((input.scopes ?? []).filter(isApiScope))] as ApiScope[];
  if (!scopes.length) throw new ApiKeyRefused("Choose at least one thing the key may touch.");
  if ((input.scopes ?? []).some((s) => !isApiScope(s))) throw new ApiKeyRefused("One of those isn't something a key can be given.");
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime())) throw new ApiKeyRefused("An expiry date has to be in the future.");
  const held = await db.apiKey.count({ where: { userId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } });
  if (held >= MAX_KEYS_PER_PERSON) throw new ApiKeyRefused(`You hold ${MAX_KEYS_PER_PERSON} keys already — revoke one you no longer use first.`);
  const token = newApiToken();
  const made = await db.apiKey.create({
    data: { name, keyId: token.keyId, secretDigest: await digestSecret(token.secret), scopes, userId, expiresAt },
    select: { id: true, keyId: true },
  });
  return { ...made, token: tokenText(token) };
}
