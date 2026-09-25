import type { Role } from "@/lib/roles";

/**
 * The shape of the DLP policy, its defaults, and the questions the rest of the app asks it.
 *
 * Pure — no database, no Next runtime — so the decisions are testable on their own and the client
 * guard can be handed a plain object rather than reaching for a connection it does not have.
 */

export type SecurityPolicyShape = {
  blockCopy: boolean;
  blockCut: boolean;
  blockPaste: boolean;
  blockContextMenu: boolean;
  blockTextSelection: boolean;
  blockPrint: boolean;
  blockDevTools: boolean;
  blurOnBlur: boolean;
  screenshotLimitPerDay: number;
  screenshotNotifyAdmins: boolean;
  watermarkEnabled: boolean;
  watermarkOpacity: number;
  exportRowLimit: number;
  exportRequiresReason: boolean;
  bulkReadThreshold: number;
  bulkReadWindowMinutes: number;
  blockBots: boolean;
  blockAiCrawlers: boolean;
  botMode: "BLOCK" | "LOG";
  logPageViews: boolean;
  retentionDays: number;
  exemptRoles: Role[];
};

/**
 * What the app behaves as before anybody has been to the settings screen.
 *
 * Deliberately permissive on the deterrents and strict on the perimeter. Turning on copy-blocking
 * for an organisation that never asked for it makes the app feel broken — people paste an order
 * number into an email a hundred times a day and would simply conclude the ERP is faulty. Bot
 * blocking, by contrast, has no legitimate victim: nothing in here belongs in a search index or a
 * training set, so it is on from the first boot.
 */
export const DEFAULT_SECURITY_POLICY: SecurityPolicyShape = {
  blockCopy: false,
  blockCut: false,
  blockPaste: false,
  blockContextMenu: false,
  blockTextSelection: false,
  blockPrint: false,
  blockDevTools: false,
  blurOnBlur: false,
  screenshotLimitPerDay: 2,
  screenshotNotifyAdmins: true,
  watermarkEnabled: false,
  watermarkOpacity: 7,
  exportRowLimit: 1000,
  exportRequiresReason: false,
  bulkReadThreshold: 400,
  bulkReadWindowMinutes: 10,
  blockBots: true,
  blockAiCrawlers: true,
  botMode: "BLOCK",
  logPageViews: false,
  retentionDays: 365,
  exemptRoles: [],
};

/**
 * Whether the client-side deterrents apply to this person.
 *
 * An admin is always exempt, and this is not a convenience. The settings that switch copy-blocking
 * on live inside the app; an admin who blocked their own clipboard could not paste a client secret
 * into the field that turns it off again. A control you can lock yourself out of is a control that
 * eventually gets left off for everyone.
 */
export function dlpApplies(role: Role | null | undefined, policy: SecurityPolicyShape): boolean {
  if (!role) return false;
  if (role === "ADMIN") return false;
  return !policy.exemptRoles.includes(role);
}

/** Nothing switched on means nothing to mount, and the guard can skip rendering entirely. */
export function hasAnyDeterrent(policy: SecurityPolicyShape): boolean {
  return (
    policy.blockCopy ||
    policy.blockCut ||
    policy.blockPaste ||
    policy.blockContextMenu ||
    policy.blockTextSelection ||
    policy.blockPrint ||
    policy.blockDevTools ||
    policy.blurOnBlur ||
    policy.watermarkEnabled ||
    policy.screenshotLimitPerDay >= 0
  );
}

export type ScreenshotDecision = {
  allowed: boolean;
  /** How many remain today after this one. Null when the cap is off. */
  remaining: number | null;
  reason: string;
};

/**
 * Whether this screenshot attempt is within the daily cap.
 *
 * `used` is the count *before* this attempt. -1 is unlimited, 0 refuses every attempt.
 *
 * Note what "allowed" means here, because it is narrower than it sounds: nothing in a browser can
 * stop the operating system taking a picture of the screen. Refusing an attempt means the page
 * blanks itself, says no, and files a record — which is a deterrent and an audit trail, not a
 * prevention. The number is worth capping anyway, because the log of who hit the cap is exactly
 * the list worth asking about.
 */
export function screenshotDecision(used: number, limitPerDay: number): ScreenshotDecision {
  if (limitPerDay < 0) return { allowed: true, remaining: null, reason: "Screenshots are not capped." };
  if (limitPerDay === 0) {
    return { allowed: false, remaining: 0, reason: "Screenshots are switched off for your account." };
  }
  if (used >= limitPerDay) {
    return {
      allowed: false,
      remaining: 0,
      reason: `You have used today's ${limitPerDay} screenshot${limitPerDay === 1 ? "" : "s"}. The attempt has been logged.`,
    };
  }
  const remaining = limitPerDay - used - 1;
  return {
    allowed: true,
    remaining,
    reason:
      remaining === 0
        ? "That was your last screenshot for today. It has been recorded."
        : `${remaining} screenshot${remaining === 1 ? "" : "s"} left today. This one has been recorded.`,
  };
}

/**
 * The working day a screenshot counts against, in IST.
 *
 * Not `toISOString().slice(0,10)`, which is UTC: a screenshot taken at 3am IST is 21:30 the
 * previous day in UTC, so a UTC key would hand somebody a second allowance every night and reset
 * the cap in the middle of the afternoon shift.
 */
const IST_OFFSET_MINUTES = 330;

export function istDayKey(at: Date = new Date()): string {
  return new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

/**
 * Whether an export is within the row cap.
 *
 * Enforced on the server, unlike everything above it — the row limit is applied where the rows are
 * fetched, so a client that lies about what it asked for still gets the capped number.
 */
export function exportDecision(
  rows: number,
  policy: Pick<SecurityPolicyShape, "exportRowLimit">,
): { allowed: boolean; reason: string } {
  if (policy.exportRowLimit <= 0) return { allowed: true, reason: "" };
  if (rows > policy.exportRowLimit) {
    return {
      allowed: false,
      reason: `That export is ${rows.toLocaleString("en-IN")} rows and the limit is ${policy.exportRowLimit.toLocaleString("en-IN")}. Narrow the filters and try again.`,
    };
  }
  return { allowed: true, reason: "" };
}

/**
 * Whether read volume in the window looks like work or like collection.
 *
 * This is the one anti-scraping control here that a browser extension cannot get around, and the
 * reason is simple: whatever is reading the data has to ask the server for it. An extension
 * quietly walking every company page generates the request volume of somebody opening a thousand
 * pages in ten minutes, and no amount of client-side cleverness hides that from the server.
 *
 * It does not block — a genuine month-end reconciliation can look like this, and blocking the
 * accountant on the last day of the quarter is worse than the leak. It raises a CRITICAL activity
 * row and tells the admins, which is the right response to "this might be nothing".
 */
export function isBulkRead(
  readsInWindow: number,
  policy: Pick<SecurityPolicyShape, "bulkReadThreshold">,
): boolean {
  return policy.bulkReadThreshold > 0 && readsInWindow >= policy.bulkReadThreshold;
}
