import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";

/**
 * The signed part of a document render pass — see render-grant.ts for the whole story.
 *
 * Split out because the proxy checks it on every request to a print page, and the proxy should not
 * need a database to reject a forged or stale pass. This file is the stateless half: is the token
 * well-formed, signed by this installation, for this document, and not yet expired. Whether it has
 * already been used is the database's half, and is decided by the page.
 *
 * Token: `<nonce>.<expiresAtMs>.<signature>`, the signature an HMAC over the nonce, the document id
 * and the expiry, keyed from AUTH_SECRET under its own label so it cannot be confused with any other
 * signature this installation makes.
 */

export const RENDER_PARAM = "render";
export const RENDER_TTL_MS = 2 * 60_000;

let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET must be set to sign document render passes.");
  cachedKey = scryptSync(secret, "wroffy-document-render", 32);
  return cachedKey;
}

function sign(nonce: string, documentId: string, expiresAt: number): string {
  return createHmac("sha256", key()).update(`${nonce}.${documentId}.${expiresAt}`).digest("base64url");
}

export function newRenderToken(documentId: string, now = Date.now()): { token: string; nonce: string; expiresAt: Date } {
  const nonce = randomBytes(24).toString("base64url");
  const expiresAt = now + RENDER_TTL_MS;
  return { token: `${nonce}.${expiresAt}.${sign(nonce, documentId, expiresAt)}`, nonce, expiresAt: new Date(expiresAt) };
}

/** The nonce, if the token is genuine, for this document, and in date. Null for anything else. */
export function verifyRenderToken(token: string | null | undefined, documentId: string, now = Date.now()): string | null {
  if (!token || token.length > 200) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [nonce, expires, signature] = parts;
  if (!/^[A-Za-z0-9_-]{32}$/.test(nonce) || !/^\d{13}$/.test(expires)) return null;
  const expiresAt = Number(expires);
  if (expiresAt < now || expiresAt > now + RENDER_TTL_MS + 5_000) return null;
  const expected = Buffer.from(sign(nonce, documentId, expiresAt));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return nonce;
}

/** The document id in a print-page path, or null — `/documents/<id>/print` and nothing else. */
export function printPathDocumentId(pathname: string): string | null {
  const match = pathname.match(/^\/documents\/([A-Za-z0-9_-]{1,64})\/print$/);
  return match ? match[1] : null;
}
