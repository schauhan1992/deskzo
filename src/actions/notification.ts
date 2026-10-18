"use server";

import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { revalidatePath } from "next/cache";
import type { NotificationType } from "@prisma/client";
import { syncSystemNotifications } from "@/lib/notify";
import { NOTIFICATION_CATALOGUE, describeNotification, notificationLabel, wants } from "@/lib/notifications/catalogue";
import { canBeEmailed, emailChoices, emailedTypes, setEmailed, type EmailChoice } from "@/lib/notifications/email-settings";
import { refuseWhileViewingAs } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspaceClock } from "@/lib/time/workspace";
import type { ActionResult } from "@/actions/company";
import { SOUND_FOR_TYPE, chimes, parseReminderSounds, type ReminderSounds } from "@/lib/reminder-sounds";

export async function getNotifications(params?: { unreadOnly?: boolean; limit?: number }) {
  const user = await requireModuleUser("notifications");
  await syncSystemNotifications(user.id);
  return db.notification.findMany({
    where: { userId: user.id, ...(params?.unreadOnly ? { read: false } : {}) },
    orderBy: { createdAt: "desc" },
    take: params?.limit ?? 20,
  });
}

/** This person's reminder sounds (src/lib/reminder-sounds.ts) — all on where the column isn't there yet. */
async function soundsOf(userId: string): Promise<ReminderSounds> {
  try {
    const row = await db.user.findUnique({ where: { id: userId }, select: { reminderSounds: true } });
    return parseReminderSounds(row?.reminderSounds);
  } catch {
    return {};
  }
}

/**
 * What the bell asks every 45 seconds: the unread count, and the newest reminder that arrived since it
 * last asked, if it should chime (owner, 8 Oct 2026). `since` is when the bell asked before — on the
 * first ask, when the page opened — so a reminder from yesterday never chimes on today's first load.
 */
export async function notificationPulse(since?: string): Promise<{ count: number; chime: { id: string; type: NotificationType } | null }> {
  const user = await requireModuleUser("notifications");
  await syncSystemNotifications(user.id);
  const after = since ? new Date(since) : null;
  const [count, newest, sounds] = await Promise.all([
    db.notification.count({ where: { userId: user.id, read: false } }),
    after && !Number.isNaN(after.getTime())
      ? db.notification.findFirst({
          where: { userId: user.id, read: false, type: { in: Object.keys(SOUND_FOR_TYPE) as NotificationType[] }, createdAt: { gt: after } },
          orderBy: { createdAt: "desc" },
          select: { id: true, type: true },
        })
      : null,
    soundsOf(user.id),
  ]);
  return { count, chime: newest && chimes(sounds, newest.type) ? newest : null };
}

export async function getReminderSounds(): Promise<ReminderSounds> {
  const user = await requireModuleUser("notifications");
  return soundsOf(user.id);
}

export async function saveReminderSounds(input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("notifications");
  const sounds = parseReminderSounds(input);
  await db.user.update({ where: { id: user.id }, data: { reminderSounds: sounds }, select: { id: true } });
  revalidatePath("/notifications");
  return { ok: true, data: null };
}

export async function markNotificationRead(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("notifications");
  const notification = await db.notification.findUnique({ where: { id } });
  if (!notification || notification.userId !== user.id) {
    return { ok: false, error: "Notification not found." };
  }
  await db.notification.update({ where: { id }, data: { read: true, readAt: new Date() } });
  return { ok: true, data: null };
}

export async function markAllNotificationsRead(): Promise<ActionResult<null>> {
  const user = await requireModuleUser("notifications");
  await db.notification.updateMany({ where: { userId: user.id, read: false }, data: { read: true, readAt: new Date() } });
  return { ok: true, data: null };
}

/**
 * The history page.
 *
 * Every query here is scoped by `user.id` taken from the session and never from an argument, which
 * is the property that makes the rest safe: a notification is addressed to one person, and there is
 * no parameter on any of these that could name somebody else's.
 */

export type NotificationRow = {
  id: string;
  type: NotificationType;
  title: string;
  message: string | null;
  link: string | null;
  read: boolean;
  createdAt: Date;
  archivedAt: Date | null;
};

export type NotificationPage = {
  rows: NotificationRow[];
  total: number;
  unread: number;
  archived: number;
  /** Types this person has actually received, for the filter — not all thirty-nine. */
  presentTypes: NotificationType[];
};

export async function listNotifications(params: {
  page: number;
  pageSize: number;
  /** "inbox" hides what has been archived; "archived" shows only that. */
  view?: "inbox" | "archived";
  unreadOnly?: boolean;
  type?: string;
  from?: string;
  to?: string;
}): Promise<NotificationPage> {
  const user = await requireModuleUser("notifications");
  await syncSystemNotifications(user.id);

  const view = params.view === "archived" ? "archived" : "inbox";
  // On createdAt, in the workspace's days. It used to be spread straight into the query, naming no column at all.
  const created = (await workspaceClock()).dayRange(params.from, params.to);
  const where = {
    userId: user.id,
    ...(view === "archived" ? { archivedAt: { not: null } } : { archivedAt: null }),
    ...(params.unreadOnly ? { read: false } : {}),
    ...(params.type && params.type !== "all" ? { type: params.type as NotificationType } : {}),
    ...(created ? { createdAt: created } : {}),
  };

  const [rows, total, unread, archived, present] = await Promise.all([
    db.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      select: {
        id: true,
        type: true,
        title: true,
        message: true,
        link: true,
        read: true,
        createdAt: true,
        archivedAt: true,
      },
    }),
    db.notification.count({ where }),
    db.notification.count({ where: { userId: user.id, archivedAt: null, read: false } }),
    db.notification.count({ where: { userId: user.id, archivedAt: { not: null } } }),
    // Offering all thirty-nine types in the filter, most of which this person will never have seen,
    // is a dropdown nobody can find anything in.
    db.notification.groupBy({ by: ["type"], where: { userId: user.id } }),
  ]);

  return { rows, total, unread, archived, presentTypes: present.map((p) => p.type) };
}

export async function archiveNotification(input: { ids: string[] }): Promise<ActionResult<{ archived: number }>> {
  const user = await requireModuleUser("notifications");
  if (input.ids.length === 0) return { ok: true, data: { archived: 0 } };

  // Scoped by userId as well as by id, so an id from anywhere else matches nothing rather than
  // archiving somebody else's notification.
  const result = await db.notification.updateMany({
    where: { id: { in: input.ids }, userId: user.id },
    data: { archivedAt: new Date(), read: true, readAt: new Date() },
  });

  revalidatePath("/notifications");
  return { ok: true, data: { archived: result.count } };
}

export async function unarchiveNotification(input: { ids: string[] }): Promise<ActionResult<{ restored: number }>> {
  const user = await requireModuleUser("notifications");
  if (input.ids.length === 0) return { ok: true, data: { restored: 0 } };

  const result = await db.notification.updateMany({
    where: { id: { in: input.ids }, userId: user.id },
    data: { archivedAt: null },
  });

  revalidatePath("/notifications");
  return { ok: true, data: { restored: result.count } };
}

/**
 * Deletes for good.
 *
 * Offered because an archive that only ever grows is a second list nobody reads. Nothing else in
 * the app depends on a notification row — it is a message, not a record — so this is a real delete
 * rather than another flag on top of a flag.
 */
export async function deleteNotifications(input: { ids: string[] }): Promise<ActionResult<{ deleted: number }>> {
  const user = await requireModuleUser("notifications");
  if (input.ids.length === 0) return { ok: true, data: { deleted: 0 } };

  const result = await db.notification.deleteMany({ where: { id: { in: input.ids }, userId: user.id } });

  revalidatePath("/notifications");
  return { ok: true, data: { deleted: result.count } };
}

/** Empties the archive. The one bulk action worth asking about, so the UI confirms first. */
export async function emptyNotificationArchive(): Promise<ActionResult<{ deleted: number }>> {
  const user = await requireModuleUser("notifications");
  const result = await db.notification.deleteMany({ where: { userId: user.id, archivedAt: { not: null } } });
  revalidatePath("/notifications");
  return { ok: true, data: { deleted: result.count } };
}

/** `emailed`: whether the workspace emails it — its admins' choice for everyone, shown, not changed, here. */
export type PreferenceRow = { type: NotificationType; inApp: boolean; emailed: boolean; alwaysOn: boolean };

/**
 * What this person has chosen, merged over the defaults.
 *
 * Every catalogued type comes back whether or not a row exists, because the screen has to show all
 * of them — and "no row" means on, not missing.
 */
export async function notificationPreferences(): Promise<ActionResult<PreferenceRow[]>> {
  const user = await requireModuleUser("notifications");
  const [stored, emailed] = await Promise.all([
    db.notificationPreference.findMany({ where: { userId: user.id }, select: { type: true, inApp: true, email: true } }),
    emailedTypes(),
  ]);
  const byType = new Map(stored.map((s) => [s.type, s]));

  return {
    ok: true,
    data: NOTIFICATION_CATALOGUE.map((d) => ({
      type: d.type,
      inApp: wants(d.type, "inApp", byType.get(d.type)),
      emailed: emailed.has(d.type),
      alwaysOn: d.alwaysOn === true,
    })),
  };
}

/** The bell only: whether a kind is emailed is the workspace's choice (Settings › Email notifications). */
export async function setNotificationPreference(input: { type: string; inApp: boolean }): Promise<ActionResult<{ type: string }>> {
  const user = await requireModuleUser("notifications");

  const definition = describeNotification(input.type as NotificationType);
  if (!definition) return { ok: false, error: "That isn't a notification we send." };

  /**
   * Refused rather than accepted and ignored.
   *
   * `wants` already forces these on whatever the row says, so storing a mute would be harmless —
   * and that is exactly the problem: the screen would show it as off while the notifications kept
   * arriving, which reads as a bug and takes the credibility of every other switch with it.
   */
  if (definition.alwaysOn) {
    return {
      ok: false,
      error: "This one can't be switched off — it exists so somebody is told whether or not they want to be.",
    };
  }

  await db.notificationPreference.upsert({
    where: { userId_type: { userId: user.id, type: definition.type } },
    create: { userId: user.id, type: definition.type, inApp: input.inApp === true },
    update: { inApp: input.inApp === true },
  });

  revalidatePath("/notifications");
  return { ok: true, data: { type: definition.type } };
}

/** Back to the defaults — every type on — by deleting the opinions rather than rewriting them. */
export async function resetNotificationPreferences(): Promise<ActionResult<{ cleared: number }>> {
  const user = await requireModuleUser("notifications");
  const result = await db.notificationPreference.deleteMany({ where: { userId: user.id } });
  revalidatePath("/notifications");
  return { ok: true, data: { cleared: result.count } };
}

/**
 * Settings › Email notifications (owner, 18 Oct 2026): which kinds the workspace emails, chosen by
 * whoever changes its settings, for everyone (src/lib/notifications/email-settings.ts).
 */
const NOT_AN_ADMIN = "Only somebody who can change the workspace's settings can choose which notifications are emailed.";
const STILL_UPDATING = "This workspace is still being updated to offer this. Try again in a few minutes.";

/** Who may choose: the module, then settings.manage — and never while viewing as somebody else. */
async function emailAdmin(): Promise<{ id: string } | { error: string }> {
  const user = await requireModuleUser("notifications");
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { error: viewingAs };
  if (!(await can(user.id, "settings.manage"))) return { error: NOT_AN_ADMIN };
  return { id: user.id };
}

/** The admin's screen: every kind with what the workspace does with it. */
export async function notificationEmailChoices(): Promise<ActionResult<EmailChoice[]>> {
  const user = await requireModuleUser("notifications");
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: NOT_AN_ADMIN };
  return { ok: true, data: await emailChoices() };
}

export async function setNotificationEmail(input: { type: string; email: boolean }): Promise<ActionResult<{ type: NotificationType; email: boolean }>> {
  const admin = await emailAdmin();
  if ("error" in admin) return { ok: false, error: admin.error };
  const definition = describeNotification(input.type as NotificationType);
  if (!definition) return { ok: false, error: "That isn't a notification Deskzo sends." };
  if (!canBeEmailed(definition.type)) {
    return { ok: false, error: "This one goes to everyone in the company, so it stays in the bell rather than emailing every employee." };
  }
  const email = input.email === true;
  try {
    await setEmailed(definition.type, email, admin.id);
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: STILL_UPDATING };
    throw err;
  }
  await recordAudit({
    userId: admin.id,
    action: "UPDATE",
    entityType: "NotificationEmailType",
    entityId: definition.type,
    entityLabel: `"${notificationLabel(definition.type)}" ${email ? "is emailed" : "is no longer emailed"}`,
  });
  revalidatePath("/settings/notification-emails");
  revalidatePath("/notifications");
  return { ok: true, data: { type: definition.type, email } };
}

/** Back to how it came: the admins' choices forgotten, the two emailed from the start emailed again. */
export async function resetNotificationEmails(): Promise<ActionResult<{ cleared: number }>> {
  const admin = await emailAdmin();
  if ("error" in admin) return { ok: false, error: admin.error };
  let result: { count: number };
  try {
    result = await db.notificationEmailType.deleteMany({});
  } catch (err) {
    if (notMigratedYet(err)) return { ok: true, data: { cleared: 0 } };
    throw err;
  }
  if (result.count > 0) {
    await recordAudit({ userId: admin.id, action: "UPDATE", entityType: "NotificationEmailType", entityId: "all", entityLabel: "Email notifications back to the defaults" });
  }
  revalidatePath("/settings/notification-emails");
  revalidatePath("/notifications");
  return { ok: true, data: { cleared: result.count } };
}
