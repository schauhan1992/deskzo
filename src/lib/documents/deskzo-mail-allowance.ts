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

/**
 * Helpdesk replies through Deskzo's mail are kept in the same ledger under this mark, with an allowance of their own
 * (security review, 23 Oct 2026): a support desk answers far more than it sends documents, and its replies go out
 * from Deskzo's address by default. Everything else — documents, calendar invitations, payment reminders — shares the
 * allowance below. An `OR` with null, not a NOT: a NOT over a nullable column drops the rows that are null.
 */
const HELPDESK_MARK = "helpdesk:";
const NOT_HELPDESK = { OR: [{ documentId: null }, { NOT: { documentId: { startsWith: HELPDESK_MARK } } }] };
const HELPDESK_ONLY = { documentId: { startsWith: HELPDESK_MARK } };

/** A helpdesk's replies through Deskzo's mail a day, in recipients: each person's, and the workspace's in all. */
export const HELPDESK_MAIL_LIMITS = { personDaily: 200, workspaceDaily: 1000 } as const;

export async function deskzoAllowance(userId: string): Promise<DeskzoAllowance> {
  const limits = await documentMailLimits();
  const since = await todayStart();
  let person = 0;
  let workspace = 0;
  try {
    const [mine, all] = await Promise.all([
      db.deskzoDocumentMail.aggregate({ where: { userId, sentAt: { gte: since }, ...NOT_HELPDESK }, _sum: { recipients: true } }),
      db.deskzoDocumentMail.aggregate({ where: { sentAt: { gte: since }, ...NOT_HELPDESK }, _sum: { recipients: true } }),
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

/**
 * Why a helpdesk reply can't go through Deskzo's mail today, or null when it can. `userId` null: the automatic
 * acknowledgement, which counts against the workspace's share only.
 */
export async function helpdeskMailRefusal(userId: string | null, recipients: number): Promise<string | null> {
  const since = await todayStart();
  let person = 0;
  let workspace = 0;
  try {
    const [mine, all] = await Promise.all([
      userId ? db.deskzoDocumentMail.aggregate({ where: { userId, sentAt: { gte: since }, ...HELPDESK_ONLY }, _sum: { recipients: true } }) : null,
      db.deskzoDocumentMail.aggregate({ where: { sentAt: { gte: since }, ...HELPDESK_ONLY }, _sum: { recipients: true } }),
    ]);
    person = mine?._sum.recipients ?? 0;
    workspace = all._sum.recipients ?? 0;
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  const left = Math.min(userId ? HELPDESK_MAIL_LIMITS.personDaily - person : Infinity, HELPDESK_MAIL_LIMITS.workspaceDaily - workspace);
  if (recipients <= left) return null;
  return `Replies through Deskzo's mail are limited to ${HELPDESK_MAIL_LIMITS.personDaily} recipients a person and ${HELPDESK_MAIL_LIMITS.workspaceDaily} a company each day, and today's is used up. Set up your own mail server (Settings › Messaging) to send without this limit, or send it tomorrow.`;
}

/** Counts a helpdesk reply that went through Deskzo's mail. Never throws: the mail has already gone. */
export async function recordHelpdeskSend(userId: string | null, ticketId: string, recipients: number): Promise<void> {
  await recordDeskzoSend(userId ?? "helpdesk:acknowledgement", `${HELPDESK_MARK}${ticketId}`, recipients);
}

/**
 * A send's recipients counted before it goes, under a lock (security review, 23 Oct 2026): checked first and counted
 * after, sends made at the same moment all saw the same room left. The row to give back if the send then fails, or
 * why it doesn't fit. The count is read on the shared client once the lock is held, so it sees every send before it.
 */
export async function reserveDeskzoSend(userId: string, documentId: string | null, recipients: number): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('deskzo:deskzo-mail'))`;
    const over = allowanceRefusal(await deskzoAllowance(userId), recipients);
    if (over) return { ok: false as const, error: over };
    const row = await tx.deskzoDocumentMail.create({ data: { userId, documentId, recipients }, select: { id: true } });
    return { ok: true as const, id: row.id };
  });
}

/** A reservation given back: the send it was for didn't go through Deskzo's mail after all. */
export async function releaseDeskzoSend(id: string): Promise<void> {
  await db.deskzoDocumentMail.deleteMany({ where: { id } }).catch((err) => console.error("[documents] Deskzo send not given back", err instanceof Error ? err.message : err));
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
