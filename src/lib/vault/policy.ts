import type { Prisma, VaultAccessLevel, VaultRevealVia } from "@prisma/client";

/**
 * Who may open a stored credential, and when one is overdue for changing.
 *
 * Pure, because these are the two things that have to be right and neither is visible when it is
 * wrong. An over-wide access rule produces no error — just a colleague who can read a password
 * nobody meant to give them. A rotation rule that never fires produces a vault of five-year-old
 * passwords that everybody believes is being maintained.
 */

/** The four ways somebody can be entitled to a record, in the order they are checked. */
export const revealViaLabels: Record<VaultRevealVia, string> = {
  OWNER: "Own record",
  SHARE: "Shared with them",
  DEPARTMENT: "Shared with their department",
  ADMIN: "Admin override",
};

export const accessLevelLabels: Record<VaultAccessLevel, string> = {
  VIEW: "Can open",
  MANAGE: "Can open, edit and share",
};

/**
 * Records this person may see at all.
 *
 * Note that `viewAll` returns everything rather than composing with the rest: an admin is entitled
 * to the whole vault, which is a decision taken openly and paid for by telling the owner every
 * time they use it — see `entitlement` below and the notification in the action.
 *
 * A department share is matched on the viewer's own department, so somebody moving teams gains and
 * loses standing access by moving, without anybody editing a share. That is the convenience it is
 * for, and the reason the owner is shown the department by name rather than a head count.
 */
/**
 * The page sizes the vault offers.
 *
 * Here rather than beside the action that uses it: `src/actions/vault.ts` is a `"use server"`
 * module, and those may export nothing but async functions — a plain constant exported from one
 * fails the production build with an error that names the file and not the line.
 */
export const VAULT_PAGE_SIZES = [10, 25, 50, 100] as const;

/**
 * How long a deleted record is kept before it is destroyed for good.
 *
 * Two months is long enough for somebody to notice they deleted the wrong thing and short enough
 * that the archive does not quietly become a second vault — a shadow copy of every password the
 * company has ever used, sitting where nobody looks and nobody audits, is a worse outcome than the
 * mistake the archive exists to undo.
 */
export const ARCHIVE_RETENTION_DAYS = 60;

/** Days left before an archived record is destroyed. Negative means it is already due. */
export function daysLeftInArchive(archivedAt: Date, now: Date): number {
  const due = archivedAt.getTime() + ARCHIVE_RETENTION_DAYS * 86400000;
  return Math.ceil((due - now.getTime()) / 86400000);
}

export function visibleCredentialsWhere(
  userId: string,
  departmentId: string | null,
  viewAll: boolean,
): Prisma.VaultCredentialWhereInput {
  /**
   * Archived records are excluded here rather than at each call site, because this is the one
   * function every list composes — including the admin's. An admin who can see everything should
   * still not find a deleted record sitting in the ordinary list; the archive is its own screen,
   * and a deleted password turning up beside the live ones is the bug this is shaped to prevent.
   */
  if (viewAll) return { archivedAt: null };
  const now = new Date();
  const live = { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
  return {
    archivedAt: null,
    OR: [
      { ownerId: userId },
      { shares: { some: { userId, ...live } } },
      ...(departmentId ? [{ shares: { some: { departmentId, ...live } } }] : []),
    ],
  };
}

export type Entitlement = { via: VaultRevealVia; level: VaultAccessLevel } | null;

/**
 * How this person is entitled to this record, and to what.
 *
 * Ordered deliberately: ownership beats a share, a direct share beats a department one, and the
 * admin override is last so it is only ever recorded when nothing else applied. Getting that order
 * wrong would log an owner reading their own password as an admin override and send them a
 * notification about themselves — which is how people learn to ignore the notification.
 */
export function entitlementFor(
  credential: {
    ownerId: string;
    shares: { userId: string | null; departmentId: string | null; level: VaultAccessLevel; expiresAt: Date | null }[];
  },
  viewer: { id: string; departmentId: string | null; isAdmin: boolean },
  now: Date,
): Entitlement {
  if (credential.ownerId === viewer.id) return { via: "OWNER", level: "MANAGE" };

  const live = credential.shares.filter((s) => !s.expiresAt || s.expiresAt > now);

  const direct = live.find((s) => s.userId === viewer.id);
  if (direct) return { via: "SHARE", level: direct.level };

  const byDepartment = viewer.departmentId
    ? live.filter((s) => s.departmentId === viewer.departmentId)
    : [];
  if (byDepartment.length > 0) {
    // The most generous of several department grants wins, which is the only answer that does not
    // depend on row order.
    const level: VaultAccessLevel = byDepartment.some((s) => s.level === "MANAGE") ? "MANAGE" : "VIEW";
    return { via: "DEPARTMENT", level };
  }

  // Last, so it is recorded only when it was actually needed.
  if (viewer.isAdmin) return { via: "ADMIN", level: "MANAGE" };
  return null;
}

/** Whether the owner should hear about this reveal. Everything except their own. */
export function shouldTellOwner(via: VaultRevealVia) {
  return via !== "OWNER";
}

export type RotationState = "fine" | "due" | "overdue" | "unknown";

/**
 * Whether a password is overdue for changing.
 *
 * `unknown` is a real answer and not a failure: a record with no change date has never been
 * rotated through this app, which is worth saying out loud rather than quietly reporting "fine".
 */
export function rotationState(
  credential: {
    passwordChangedAt: Date | null;
    rotateAfterDays: number | null;
    rotateBy?: Date | null;
    rotateReason?: string | null;
  },
  now: Date,
): { state: RotationState; daysSince: number | null; daysUntilDue: number | null; reason: string | null } {
  /**
   * A deadline set by an event wins over the standing policy, and wins even when the record has
   * never been rotated here.
   *
   * That last part is the case that matters: somebody leaves, their credentials are handed over,
   * and the record has no `passwordChangedAt` because nobody ever changed it through this app.
   * Checking the policy first would return `unknown` and the one password that genuinely must be
   * changed would be the one the screen said nothing about.
   */
  if (credential.rotateBy) {
    const daysUntilDue = Math.floor((credential.rotateBy.getTime() - now.getTime()) / 86400000);
    const daysSince = credential.passwordChangedAt
      ? Math.floor((now.getTime() - credential.passwordChangedAt.getTime()) / 86400000)
      : null;
    return {
      state: daysUntilDue < 0 ? "overdue" : "due",
      daysSince,
      daysUntilDue,
      reason: credential.rotateReason ?? null,
    };
  }

  if (!credential.passwordChangedAt) return { state: "unknown", daysSince: null, daysUntilDue: null, reason: null };

  const daysSince = Math.floor((now.getTime() - credential.passwordChangedAt.getTime()) / 86400000);
  if (!credential.rotateAfterDays) return { state: "fine", daysSince, daysUntilDue: null, reason: null };

  const daysUntilDue = credential.rotateAfterDays - daysSince;
  if (daysUntilDue < 0) return { state: "overdue", daysSince, daysUntilDue, reason: null };
  // A fortnight's warning: long enough to schedule, short enough not to be ignored.
  if (daysUntilDue <= 14) return { state: "due", daysSince, daysUntilDue, reason: null };
  return { state: "fine", daysSince, daysUntilDue, reason: null };
}

/** How long somebody has to change a password they inherited from a leaver. */
export const HANDOVER_ROTATION_DAYS = 15;

/**
 * The window a billing expiry is worth nagging about, and how often.
 *
 * A month's warning, repeated every five days — six reminders, which is enough that one landing
 * in a busy week is not the only one, and few enough that they stay worth reading.
 */
export const EXPIRY_NOTICE_WINDOW_DAYS = 30;
export const EXPIRY_NOTICE_EVERY_DAYS = 5;

/**
 * Which reminder this is, or null when none is due.
 *
 * The bucket number *is* the schedule. There is no "last reminded at" column and no job state:
 * the key it produces changes once every five days as the date approaches, and the notification
 * writer puts it in `dedupeKey`, so a second run the same day writes nothing and a run five days
 * later writes one. A reminder that has already been sent cannot be sent twice, and one that was
 * missed because nobody opened the app is simply sent late rather than lost.
 *
 * Overdue keeps its own bucket rather than counting downwards forever, so a lapsed subscription
 * nags once and then waits — the message does not change, and repeating it daily is how the
 * whole category gets muted.
 */
export function expiryNoticeBucket(daysToExpiry: number | null): string | null {
  if (daysToExpiry === null) return null;
  if (daysToExpiry < 0) return "lapsed";
  if (daysToExpiry > EXPIRY_NOTICE_WINDOW_DAYS) return null;
  /**
   * `max(1, …)` because the window is thirty-one days wide counting today, which does not divide
   * into six five-day steps. Without it the boundary day sits alone in a bucket of its own and the
   * first reminder is followed by a second one the next morning — which is exactly the behaviour
   * that teaches somebody to ignore the rest.
   */
  return String(Math.max(1, Math.ceil(daysToExpiry / EXPIRY_NOTICE_EVERY_DAYS)));
}

/** Whether a record is close enough to expiry to be worth floating above everything else. */
export function isExpiringSoon(billingExpiry: Date | null, now: Date): boolean {
  const days = daysUntilExpiry(billingExpiry, now);
  return days !== null && days <= EXPIRY_NOTICE_WINDOW_DAYS;
}
/** Days until the subscription behind a login lapses, or null when nobody recorded one. */
export function daysUntilExpiry(billingExpiry: Date | null, now: Date): number | null {
  if (!billingExpiry) return null;
  return Math.floor((billingExpiry.getTime() - now.getTime()) / 86400000);
}

/**
 * How many other records share a password, counted only among the ones this person can see.
 *
 * Deliberately not the true company-wide figure. Telling somebody "this password is used on four
 * other records" when they can see none of them discloses something about accounts they have no
 * business knowing — and an admin, who can see everything, gets the complete picture anyway, which
 * is the person who should have it.
 */
export function reuseCounts(rows: { id: string; secretDigest: string }[]): Map<string, number> {
  const byDigest = new Map<string, number>();
  for (const row of rows) byDigest.set(row.secretDigest, (byDigest.get(row.secretDigest) ?? 0) + 1);

  const out = new Map<string, number>();
  for (const row of rows) out.set(row.id, (byDigest.get(row.secretDigest) ?? 1) - 1);
  return out;
}
