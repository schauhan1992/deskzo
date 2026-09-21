import { randomInt } from "crypto";

/**
 * The invite code, and the window it works in.
 *
 * Pure, because both halves are things that fail silently. A code alphabet with an `O` in it
 * produces visitors who cannot sign in and a receptionist who blames the tablet. A validity window
 * off by a few hours turns away somebody standing in the lobby at nine in the morning.
 */

/**
 * No 0/O, no 1/I/L. Somebody is reading this off a phone screen and typing it on a tablet, and
 * every one of those pairs is a support call.
 */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const LENGTH = 8;

/** About 10^12 combinations — see the model comment for why that alone is not the whole defence. */
export function generateCode(): string {
  let out = "";
  // randomInt, not Math.random: the codes are a credential for the length of a day, and a
  // predictable sequence of them would be worth predicting.
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/**
 * What somebody typed, cleaned up.
 *
 * Case folded, and spaces and dashes removed because people insert them. Deliberately no
 * lookalike substitution: the alphabet already has no `O`, `0`, `I`, `1` or `L` in it, so there is
 * nothing to disambiguate — a code cannot contain the characters that would need mapping. Adding a
 * mapping anyway would mean guessing what somebody meant, and guessing wrong turns one mistyped
 * character into a different valid-looking code.
 */
export function normaliseCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, LENGTH);
}

/** Whether a string could be a code at all, before anything is looked up. */
export function looksLikeCode(input: string): boolean {
  const cleaned = normaliseCode(input);
  return cleaned.length === LENGTH && [...cleaned].every((c) => ALPHABET.includes(c));
}

/**
 * Whether a code is live right now.
 *
 * From the start of the day it is expected until midday the following day. The morning's grace is
 * deliberate: a visitor due at 5pm who arrives at 9am the next day because the meeting moved should
 * not be sent away, and a code that stays live for a week is a code worth stealing.
 */
export function isWithinWindow(expectedAt: Date, now: Date): boolean {
  const dayStart = new Date(Date.UTC(expectedAt.getUTCFullYear(), expectedAt.getUTCMonth(), expectedAt.getUTCDate()));
  const graceEnd = new Date(dayStart.getTime() + 36 * 3600_000);
  return now >= dayStart && now <= graceEnd;
}

/** How many wrong codes a desk may produce before it stops answering, and for how long. */
export const MAX_FAILED_LOOKUPS = 8;
export const LOCKOUT_WINDOW_MS = 10 * 60_000;

/**
 * Whether this desk is currently locked out, and what the counter should become.
 *
 * Returned rather than applied so the caller does the single write — and so this can be reasoned
 * about without a database.
 */
export function lookupThrottle(
  kiosk: { failedLookups: number; failedSince: Date | null },
  now: Date,
): { lockedOut: boolean; nextCount: number; windowStart: Date } {
  const windowExpired = !kiosk.failedSince || now.getTime() - kiosk.failedSince.getTime() > LOCKOUT_WINDOW_MS;
  if (windowExpired) return { lockedOut: false, nextCount: 1, windowStart: now };
  const nextCount = kiosk.failedLookups + 1;
  return { lockedOut: kiosk.failedLookups >= MAX_FAILED_LOOKUPS, nextCount, windowStart: kiosk.failedSince! };
}

/**
 * The message a host sends to their visitor.
 *
 * Built here rather than in the component so the check can assert what it contains — and, more to
 * the point, what it does not. No kiosk URL: the code is useless without standing at the desk, and
 * a message that also carried the tablet link would put a staff-directory credential into somebody
 * else's inbox.
 */
export function inviteMessage(invite: {
  name: string;
  code: string;
  hostName: string;
  companyName: string;
  expectedAt: Date;
  formatWhen: (d: Date) => string;
}): string {
  return [
    `Hello ${invite.name},`,
    ``,
    `You're expected at ${invite.companyName} on ${invite.formatWhen(invite.expectedAt)} to see ${invite.hostName}.`,
    ``,
    `When you arrive, enter this code on the tablet at reception:`,
    ``,
    `    ${invite.code}`,
    ``,
    `That's all you'll need — it saves filling the form in on the day.`,
  ].join("\n");
}
