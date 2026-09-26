import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * What the two gateway clients share: their errors, and constant-time comparison of signatures.
 */

/** A gateway said no, or could not be reached. The message is the gateway's, fit to show staff. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

/** No keys entered for it in the console yet. */
export class GatewayNotConfigured extends GatewayError {
  constructor(readonly gateway: "Stripe" | "Razorpay") {
    super(`${gateway} is not set up yet — its keys are entered in the platform console, under Billing.`);
  }
}

export const hmacHex = (secret: string, payload: string) => createHmac("sha256", secret).update(payload, "utf8").digest("hex");

/** Equal, in constant time; strings of different lengths are simply unequal. */
export function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Seconds since 1970 from a gateway, as a Date; nothing for nothing. */
export const fromUnix = (seconds: unknown): Date | null => (typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000) : null);

/** Every gateway call gives up after this long, so a stuck gateway never holds a page or a tick. */
export const GATEWAY_TIMEOUT_MS = 20_000;
