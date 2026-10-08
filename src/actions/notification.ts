"use server";

import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { revalidatePath } from "next/cache";
import type { NotificationType } from "@prisma/client";
import { syncSystemNotifications } from "@/lib/notify";
import { NOTIFICATION_CATALOGUE, describeNotification, wants } from "@/lib/notifications/catalogue";
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

export type PreferenceRow = { type: NotificationType; inApp: boolean; email: boolean; alwaysOn: boolean };

/**
 * What this person has chosen, merged over the defaults.
 *
 * Every catalogued type comes back whether or not a row exists, because the screen has to show all
 * of them — and "no row" means on, not missing.
 */
export async function notificationPreferences(): Promise<ActionResult<PreferenceRow[]>> {
  const user = await requireModuleUser("notifications");
  const stored = await db.notificationPreference.findMany({
    where: { userId: user.id },
    select: { type: true, inApp: true, email: true },
  });
  const byType = new Map(stored.map((s) => [s.type, s]));

  return {
    ok: true,
    data: NOTIFICATION_CATALOGUE.map((d) => ({
      type: d.type,
      inApp: wants(d.type, "inApp", byType.get(d.type)),
      email: wants(d.type, "email", byType.get(d.type)),
      alwaysOn: d.alwaysOn === true,
    })),
  };
}

export async function setNotificationPreference(input: {
  type: string;
  inApp: boolean;
  email: boolean;
}): Promise<ActionResult<{ type: string }>> {
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
    create: { userId: user.id, type: definition.type, inApp: input.inApp, email: input.email },
    update: { inApp: input.inApp, email: input.email },
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
