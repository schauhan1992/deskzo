import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { platformHmac } from "@/lib/platform/kek";
import { protocolFor } from "@/lib/tenancy/host";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * Linked sign-in's keys: its tokens, browser secrets, credential stamps, cookie names and lifetimes
 * (spec §4.1). Pure — no database, no request — so every step can be checked from a script.
 *
 * ## Tokens
 *
 * `<r>.<m>`: `r` is 32 random bytes (base64url, 43 characters) and only its SHA-256 is stored, as
 * handoff tickets are. `m` is the first 16 bytes (22 characters) of an HMAC over `r` and the row's
 * claims, under a key derived from the platform key for the *verifying* workspace and the token's
 * kind (kek.ts `platformHmac`). So a row edited or inserted in the control plane — a new user id, a
 * later expiry — signs nobody in without PLATFORM_MASTER_KEY, and a token made for one workspace or
 * one purpose is worthless at another.
 */

export const LINK_INTENT_TTL_MS = 600_000;
export const LINK_COMPLETION_TTL_MS = 60_000;
export const SWITCH_TICKET_TTL_MS = 60_000;
export const SWITCH_FINISH_TTL_MS = 300_000;
export const SWITCH_MAX_CODE_ATTEMPTS = 5;
export const MAX_LINKED_WORKSPACES = 20;
/** How recent a Microsoft sign-in must be to stand in for the password when linking. */
export const SSO_FRESH_MS = 600_000;

export type TokenKind = "link-intent" | "link-completion" | "link-switch";

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{22}$/;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The MAC part, as it travels. Claims are joined by newlines, so none may hold one — or two lists could sign alike. */
function macOf(kind: TokenKind, verifierTenantId: string, r: string, claims: string[]): string | null {
  if (claims.some((c) => typeof c !== "string" || c.includes("\n"))) return null;
  return platformHmac(verifierTenantId, kind)
    .update(r + "\n" + claims.join("\n"))
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

/** A new token for `claims`, checked later by `verifierTenantId`. Store `hash`; send `token` (in a URL fragment only). */
export function mintToken(kind: TokenKind, verifierTenantId: string, claims: string[]): { token: string; hash: string } {
  const r = randomBytes(32).toString("base64url");
  const m = macOf(kind, verifierTenantId, r, claims);
  if (!m) throw new Error("A linked sign-in claim can't hold a line break.");
  return { token: `${r}.${m}`, hash: sha256Hex(r) };
}

/** The stored hash a token is looked up by — null when it is not the shape this makes. */
export function tokenHashOf(token: string): string | null {
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return null;
  return sha256Hex(token.slice(0, 43));
}

/**
 * Whether the token's MAC is right for its kind, the verifying workspace and the claims read back from
 * its row. Compared as the canonical text, so no second spelling of the same bytes passes.
 */
export function tokenMacValid(kind: TokenKind, verifierTenantId: string, token: string, claims: string[]): boolean {
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return false;
  const expected = macOf(kind, verifierTenantId, token.slice(0, 43), claims);
  if (!expected) return false;
  const given = Buffer.from(token.slice(44), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** A secret for a browser's cookie; only its hash is stored. */
export function newBrowserSecret(): { secret: string; hash: string } {
  const secret = randomBytes(32).toString("base64url");
  return { secret, hash: sha256Hex(secret) };
}

/**
 * The account's credentials as one value (spec §4.4): changes whenever its address or password hash
 * does, by any path — its own change, a reset link, an import, SQL. A member whose stamp no longer
 * matches is unlinked. 64 lower-case hex characters (the database checks).
 */
export function credentialStamp(tenantId: string, user: { id: string; email: string; passwordHash: string }): string {
  return platformHmac(tenantId, "link-stamp")
    .update([user.id, user.email.trim().toLowerCase(), user.passwordHash].join("\n"))
    .digest("hex");
}

export type LinkCookie = "link" | "link-in" | "switch";

/** `__Host-deskzo.<cookie>` over https — bound to the exact host — and the plain name over http, as the session cookie is. */
export function linkCookieName(cookie: LinkCookie, secure: boolean): string {
  return `${secure ? "__Host-" : ""}deskzo.${cookie}`;
}

/** Seconds: the asking browser's and the approving browser's cookies last as long as a request; the switch's as its finish. */
export const LINK_COOKIE_MAX_AGE: Record<LinkCookie, number> = {
  link: LINK_INTENT_TTL_MS / 1000,
  "link-in": LINK_INTENT_TTL_MS / 1000,
  switch: SWITCH_FINISH_TTL_MS / 1000,
};

/** Where a workspace is reached — from the registry's primary host, never from anything a request says. */
export function originOf(tenant: Pick<Tenant, "primaryHost">): string {
  return `${protocolFor(tenant.primaryHost)}://${tenant.primaryHost}`;
}
