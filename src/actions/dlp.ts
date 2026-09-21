"use server";

import type { ActivityKind } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { logActivity, alertAdmins } from "@/lib/activity";
import { getSecurityPolicy } from "@/lib/security/store";
import { dlpApplies, screenshotDecision, istDayKey } from "@/lib/security/policy";
import { throttle } from "@/lib/security/throttle";

/**
 * What the browser-side guard is allowed to tell the server.
 *
 * This is the one place a client writes to the security log, so it is written defensively:
 *
 *   - Only the kinds in `CLIENT_REPORTABLE` can be written. Without that list, `"use server"`
 *     would have handed every signed-in user an endpoint for forging `LOGIN` rows or a
 *     `SECURITY_POLICY_CHANGED` row naming somebody else.
 *   - The row is attributed to the session, never to anything the caller says.
 *   - Reports are throttled per user per kind. A page that fires a copy event in a loop would
 *     otherwise fill the table, and the events being reported are ones a hostile client controls
 *     completely.
 *
 * And the honest part: a client that simply does not call this reports nothing. Blocking the
 * clipboard and counting screenshots are deterrents against carelessness. Someone who opens
 * devtools and deletes the listeners is not detected here — they are detected, if at all, by the
 * server-side read-volume check in `src/lib/security/bulk-read.ts`, which does not depend on the
 * browser cooperating.
 */

const CLIENT_REPORTABLE = [
  "COPY_BLOCKED",
  "CUT_BLOCKED",
  "PASTE_BLOCKED",
  "CONTEXT_MENU_BLOCKED",
  "PRINT_BLOCKED",
  "DEVTOOLS_OPENED",
] as const satisfies readonly ActivityKind[];

type ClientReportableKind = (typeof CLIENT_REPORTABLE)[number];

function isReportable(kind: string): kind is ClientReportableKind {
  return (CLIENT_REPORTABLE as readonly string[]).includes(kind);
}

const LABELS: Record<ClientReportableKind, string> = {
  COPY_BLOCKED: "tried to copy",
  CUT_BLOCKED: "tried to cut",
  PASTE_BLOCKED: "tried to paste",
  CONTEXT_MENU_BLOCKED: "opened the right-click menu",
  PRINT_BLOCKED: "tried to print",
  DEVTOOLS_OPENED: "appears to have opened developer tools",
};

export async function reportDlpEvent(input: { kind: string; path?: string; detail?: string }): Promise<void> {
  const user = await requireUser();
  if (!isReportable(input.kind)) return;

  const policy = await getSecurityPolicy();
  // An exempt user's browser should not be reporting at all, but a stale page from before the
  // exemption was granted would. Dropping it here keeps the log consistent with the policy.
  if (!dlpApplies(user.role, policy)) return;

  // One row per user per kind per two minutes, with the rest counted into the next one. Somebody
  // holding Ctrl+C down is one event worth knowing about, not four hundred.
  const { write, suppressedSince } = throttle(`dlp:${user.id}:${input.kind}`, 120_000);
  if (!write) return;

  const repeats = suppressedSince > 0 ? ` (${suppressedSince} more in the last few minutes)` : "";
  await logActivity({
    kind: input.kind,
    summary: `${user.name} ${LABELS[input.kind]}${repeats}`,
    path: input.path,
    metadata: { detail: input.detail?.slice(0, 200) ?? null, repeatsFolded: suppressedSince },
  });
}

export type ScreenshotVerdict = {
  allowed: boolean;
  remaining: number | null;
  reason: string;
  /** False when the policy does not apply to this person — the guard then stops asking. */
  enforced: boolean;
};

/**
 * Counts a screenshot attempt against the daily allowance and says whether it was within it.
 *
 * The increment is an atomic upsert against a unique key rather than a read-then-write, so two
 * attempts a few milliseconds apart cannot both see "one used" and both be allowed.
 *
 * Attempts past the cap still increment. The number stops meaning "screenshots taken" and starts
 * meaning "attempts made", which is the more interesting figure once somebody is over the line.
 */
export async function reportScreenshot(input: { path?: string } = {}): Promise<ScreenshotVerdict> {
  const user = await requireUser();
  const policy = await getSecurityPolicy();

  if (!dlpApplies(user.role, policy) || policy.screenshotLimitPerDay < 0) {
    return { allowed: true, remaining: null, reason: "", enforced: false };
  }

  const day = istDayKey();
  const row = await db.screenshotAllowance.upsert({
    where: { userId_day: { userId: user.id, day } },
    create: { userId: user.id, day, count: 1 },
    update: { count: { increment: 1 }, lastAt: new Date() },
    select: { count: true },
  });

  // `count` includes the attempt just made, and the decision is about the state before it.
  const used = row.count - 1;
  const decision = screenshotDecision(used, policy.screenshotLimitPerDay);

  await logActivity({
    kind: decision.allowed ? "SCREENSHOT" : "SCREENSHOT_BLOCKED",
    summary: decision.allowed
      ? `${user.name} took a screenshot (${row.count} of ${policy.screenshotLimitPerDay} today)`
      : `${user.name} attempted a screenshot past the daily limit (attempt ${row.count}, limit ${policy.screenshotLimitPerDay})`,
    path: input.path,
    metadata: { attemptsToday: row.count, limit: policy.screenshotLimitPerDay, allowed: decision.allowed },
  });

  if (policy.screenshotNotifyAdmins) {
    // Every screenshot is reported, not only the refused ones — that was the ask, and a cap of two
    // is only meaningful if somebody sees the two. Throttled per user per hour so a busy day is a
    // notification rather than a stream.
    const { write, suppressedSince } = throttle(`shot-alert:${user.id}`, 3_600_000);
    if (write) {
      const more = suppressedSince > 0 ? ` and ${suppressedSince} more in the last hour` : "";
      await alertAdmins({
        title: decision.allowed ? "Screenshot taken" : "Screenshot blocked — over the daily limit",
        message: `${user.name} (${user.email}) — attempt ${row.count} today, limit ${policy.screenshotLimitPerDay}${more}. Page: ${input.path ?? "unknown"}.`,
        link: "/activity?kind=SCREENSHOT",
      });
    }
  }

  return { ...decision, enforced: true };
}
