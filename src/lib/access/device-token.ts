import { createHash, randomBytes } from "node:crypto";

/**
 * The device cookie: 256 random bits that name one browser, stored in the database only as a hash.
 *
 * http-only so no script on the page can read it, and long-lived so a browser stays the same device
 * for as long as it keeps its cookies. Held only by browsers that reach a signed-in page or the
 * sign-in screen — never set on the public customer pages, which have no business being tracked.
 */
export const DEVICE_COOKIE = "deskzo_device";
export const DEVICE_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function newDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Anything that is not exactly the shape we issue is treated as no cookie at all. */
export function validDeviceToken(value: string | null | undefined): value is string {
  return typeof value === "string" && TOKEN_SHAPE.test(value);
}

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
