import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * The Deskzo app's secrets (owner, 18 Oct 2026).
 *
 *   · A pairing code: shown on somebody's own Settings › Deskzo app page, as a QR and as ten characters to
 *     type, good for ten minutes and once. Characters that read alike (0/O, 1/I/L) are left out.
 *   · The phone's token, handed over once when the code is used: `dzp_<app device id>.<secret>`. Only the
 *     secret's digest is kept, on the device row (`UserDevice.tokenHash`).
 */

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const PAIRING_CODE_LENGTH = 10;
export const PAIRING_MINUTES = 10;

export const digest = (secret: string) => createHash("sha256").update(secret).digest("hex");

/** Ten characters from the alphabet above — about 50 bits, for ten minutes, behind a lockout. */
export function newPairingCode(): string {
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  return code;
}

/** As typed: any case, with or without the spaces and dashes it is shown with. Null when it can't be one. */
export function normalisePairingCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.toUpperCase().replace(/[\s-]/g, "");
  return code.length === PAIRING_CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c)) ? code : null;
}

/** "K7QX M4PR T9" — how a code is shown for typing. */
export const spacedCode = (code: string) => `${code.slice(0, 4)} ${code.slice(4, 8)} ${code.slice(8)}`;

/** What the QR carries: the workspace's address and the code. The app opens it; a camera shows it as text. */
export const pairingLink = (origin: string, code: string) => `deskzo://pair?host=${encodeURIComponent(new URL(origin).host)}&code=${code}`;

export const newPhoneSecret = () => randomBytes(32).toString("base64url");
export const phoneToken = (appDeviceId: string, secret: string) => `dzp_${appDeviceId}.${secret}`;

const TOKEN = /^Bearer\s+dzp_([a-z0-9]{20,40})\.([A-Za-z0-9_-]{43})$/;

/** The phone's token from an Authorization header, or null when there is none or it can't be one. */
export function parsePhoneToken(header: string | null): { appDeviceId: string; secret: string } | null {
  const m = TOKEN.exec(header?.trim() ?? "");
  return m ? { appDeviceId: m[1]!, secret: m[2]! } : null;
}

/** Whether a secret is the one whose digest is stored — compared in constant time. */
export function secretMatches(secret: string, storedDigest: string): boolean {
  const a = Buffer.from(digest(secret), "hex");
  const b = Buffer.from(storedDigest.padEnd(64, "0").slice(0, 64), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─── Signing in through the phone's browser ──────────────────────────────────────────────────────

/**
 * How long a code sent back to the app by the browser lasts. It goes straight from the page to the app, so it
 * needs seconds; a slow phone gets two minutes.
 */
export const BROWSER_SIGN_IN_MINUTES = 2;

/** A PKCE challenge as the app sends it (RFC 7636, S256): 43 characters of base64url. */
export const validChallenge = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);

/** Whether the app's secret is the one the challenge was made from — compared in constant time. */
export function verifierMatches(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const a = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Where the page sends the code: back into the app that asked. */
export const signedInLink = (code: string) => `deskzo://signed-in?code=${code}`;
