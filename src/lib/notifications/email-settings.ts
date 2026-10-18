import type { NotificationType } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { NOTIFICATION_CATALOGUE } from "@/lib/notifications/catalogue";
import { EMAILED_BY_DEFAULT, SWEPT_REMINDERS, canBeEmailed } from "@/lib/notifications/email-defaults";

export { EMAILED_BY_DEFAULT, IN_APP_ONLY, SWEPT_REMINDERS, canBeEmailed } from "@/lib/notifications/email-defaults";

/**
 * Which notifications this workspace emails (owner, 18 Oct 2026): an admin's choice for everyone,
 * under Settings › Email notifications. The choice is final — a person can't turn an email off, or
 * on, for themselves; what they mute in their own bell doesn't stop it. Each goes at once, one email
 * per notification, through the company's mail server when one is set up and Deskzo's otherwise
 * (src/lib/email.ts).
 *
 * A row only where an admin has chosen (`notification_email_types`); a type without one keeps its
 * default, and a workspace not migrated yet has the defaults throughout. Every query names its columns,
 * so one reading a column a workspace hasn't been migrated to yet is the only one that notices.
 */

/** What admins have chosen, type by type; empty in a workspace not migrated yet. */
async function storedChoices(): Promise<{ type: NotificationType; email: boolean; updatedAt: Date }[]> {
  try {
    return await db.notificationEmailType.findMany({ select: { type: true, email: true, updatedAt: true } });
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/** Every type this workspace emails now. */
export async function emailedTypes(): Promise<Set<NotificationType>> {
  const out = new Set<NotificationType>([...EMAILED_BY_DEFAULT].filter(canBeEmailed));
  for (const row of await storedChoices()) {
    if (row.email && canBeEmailed(row.type)) out.add(row.type);
    else out.delete(row.type);
  }
  return out;
}

/** Whether one type is emailed — read for each notification as it's raised. */
export async function isEmailed(type: NotificationType): Promise<boolean> {
  if (!canBeEmailed(type)) return false;
  try {
    const row = await db.notificationEmailType.findUnique({ where: { type }, select: { email: true } });
    if (row) return row.email;
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  return EMAILED_BY_DEFAULT.has(type);
}

export type EmailChoice = {
  type: NotificationType;
  email: boolean;
  /** Offered with a switch: false for the ones only the bell raises. */
  switchable: boolean;
  /** Left as it came: nobody has chosen. */
  isDefault: boolean;
};

/** Every catalogued type with what this workspace does with it, for the admin's screen. */
export async function emailChoices(): Promise<EmailChoice[]> {
  const stored = new Map((await storedChoices()).map((r) => [r.type, r]));
  return NOTIFICATION_CATALOGUE.map((d) => {
    const switchable = canBeEmailed(d.type);
    const row = stored.get(d.type);
    return {
      type: d.type,
      email: switchable && (row ? row.email : EMAILED_BY_DEFAULT.has(d.type)),
      switchable,
      isDefault: !row,
    };
  });
}

/**
 * Records an admin's choice for one type. The caller checks who may, and that the type can be emailed.
 * Switched on from off, it's on from now: a swept reminder that fell due before isn't emailed.
 */
export async function setEmailed(type: NotificationType, email: boolean, byUserId: string, now: Date = new Date()): Promise<void> {
  const before = await db.notificationEmailType.findUnique({ where: { type }, select: { email: true } });
  const onSince = !email ? null : before?.email ? undefined : now;
  await db.notificationEmailType.upsert({
    where: { type },
    create: { type, email, updatedById: byUserId, onSince: email ? now : null },
    update: { email, updatedById: byUserId, ...(onSince === undefined ? {} : { onSince }) },
    select: { type: true },
  });
}

/**
 * The swept reminders this workspace emails, each with when it was switched on — what the scheduled
 * sweep looks for (src/lib/notifications/reminder-emails.ts). Empty in a workspace not migrated yet.
 */
export async function sweptReminderKinds(): Promise<Map<NotificationType, Date>> {
  try {
    const rows = await db.notificationEmailType.findMany({
      where: { email: true, type: { in: [...SWEPT_REMINDERS] } },
      select: { type: true, onSince: true, updatedAt: true },
    });
    return new Map(rows.map((r) => [r.type, r.onSince ?? r.updatedAt]));
  } catch (err) {
    if (notMigratedYet(err)) return new Map();
    throw err;
  }
}
