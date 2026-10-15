import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspaceClock } from "@/lib/time/workspace";
import { documentMailLimits } from "@/lib/platform/document-mail-limits";

/**
 * What a person may still send through Deskzo's mail today — the limits are Deskzo's
 * (src/lib/platform/document-mail-limits.ts), counted here in this workspace's own sends
 * (`DeskzoDocumentMail`), in recipients, since the start of the workspace's day.
 */

export type DeskzoAllowance = {
  /** Recipients this person may still send to today; the lower of their own and the workspace's. */
  left: number;
  person: { used: number; limit: number };
  workspace: { used: number; limit: number };
};

async function todayStart(): Promise<Date> {
  const clock = await workspaceClock();
  return clock.startOfDay(clock.today()) ?? new Date(Date.now() - 24 * 3_600_000);
}

export async function deskzoAllowance(userId: string): Promise<DeskzoAllowance> {
  const limits = await documentMailLimits();
  const since = await todayStart();
  let person = 0;
  let workspace = 0;
  try {
    const [mine, all] = await Promise.all([
      db.deskzoDocumentMail.aggregate({ where: { userId, sentAt: { gte: since } }, _sum: { recipients: true } }),
      db.deskzoDocumentMail.aggregate({ where: { sentAt: { gte: since } }, _sum: { recipients: true } }),
    ]);
    person = mine._sum.recipients ?? 0;
    workspace = all._sum.recipients ?? 0;
  } catch (err) {
    // Before the table exists nothing has been sent through it.
    if (!notMigratedYet(err)) throw err;
  }
  return {
    left: Math.max(0, Math.min(limits.personDaily - person, limits.workspaceDaily - workspace)),
    person: { used: person, limit: limits.personDaily },
    workspace: { used: workspace, limit: limits.workspaceDaily },
  };
}

/** Why this send would go past today's limits, in words — or null when it fits. */
export function allowanceRefusal(allowance: DeskzoAllowance, recipients: number): string | null {
  if (allowance.workspace.limit === 0 || allowance.person.limit === 0) {
    return "Deskzo's mail isn't sending documents for workspaces at the moment. Set up your own mail — your mailbox (Settings → Security) or a mail server (Settings › Messaging) — to email this.";
  }
  if (recipients <= allowance.left) return null;
  const which =
    allowance.person.limit - allowance.person.used <= allowance.workspace.limit - allowance.workspace.used
      ? `your ${allowance.person.limit} a day`
      : `your company's ${allowance.workspace.limit} a day`;
  const room = allowance.left === 0 ? "None are left today" : `Only ${allowance.left} more recipient${allowance.left === 1 ? " is" : "s are"} left today`;
  return `Documents sent through Deskzo's mail are limited to ${which}, counted in recipients. ${room}. Set up your own mail (Settings › Messaging) to send without this limit, or send it tomorrow.`;
}

/** Counts a send that went through Deskzo's mail. Never throws: the mail has already gone. */
export async function recordDeskzoSend(userId: string, documentId: string | null, recipients: number): Promise<void> {
  try {
    await db.deskzoDocumentMail.create({ data: { userId, documentId, recipients } });
  } catch (err) {
    console.error("[documents] Deskzo send not counted", err instanceof Error ? err.message : err);
  }
}

/** Rows past any day that could still count — run with the nightly chores. */
export async function purgeOldDeskzoSends(): Promise<number> {
  try {
    return (await db.deskzoDocumentMail.deleteMany({ where: { sentAt: { lt: new Date(Date.now() - 40 * 24 * 3_600_000) } } })).count;
  } catch (err) {
    if (notMigratedYet(err)) return 0;
    throw err;
  }
}
