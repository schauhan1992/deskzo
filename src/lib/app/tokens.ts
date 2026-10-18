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
