"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { formatIstDateTime, parseIstDateTime } from "@/lib/india-time";
import { forgetMaintenanceCache, maintenanceState, MESSAGE_MAX } from "@/lib/maintenance";
import type { ActionResult } from "@/actions/company";

/**
 * Switching maintenance mode on, off, or on for later — see src/lib/maintenance.ts. The same
 * permission that lets somebody keep working while it is on: `settings.manage`.
 */

const NOT_ALLOWED = "You can't change maintenance mode.";

export async function getMaintenanceSettings() {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return null;
  const row = await db.maintenanceMode.findUnique({
    where: { id: "global" },
    select: { enabled: true, startsAt: true, endsAt: true, message: true, updatedAt: true, updatedBy: { select: { name: true } } },
  });
  const state = maintenanceState(row);
  // Who carries on while it is down — the same check the proxy makes, person by person.
  const active = await db.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const stillIn = (await Promise.all(active.map(async (u) => ((await can(u.id, "settings.manage")) ? u.name : null)))).filter((n): n is string => !!n);
  return toPlain({
    /** The server's clock, so the form can offer "in an hour" without reading one while it renders. */
    now: new Date(),
    stillIn,
    activeUsers: active.length,
    phase: state.phase,
    startsAt: state.startsAt,
    endsAt: state.endsAt,
    message: row?.message ?? "",
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy?.name ?? null,
  });
}

export type MaintenanceInput = {
  /** now — down from this moment; schedule — down from `startsAt`; off — back up. */
  mode: "now" | "schedule" | "off";
  /** India time, as a `datetime-local` input gives it. */
  startsAt?: string;
  endsAt?: string;
  message?: string;
};

export async function saveMaintenance(input: MaintenanceInput): Promise<ActionResult<{ phase: string }>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: NOT_ALLOWED };
  if (!input || !["now", "schedule", "off"].includes(input.mode)) return { ok: false, error: "Choose whether to switch it on now, schedule it or switch it off." };

  const message = (input.message ?? "").trim();
  if (message.length > MESSAGE_MAX) return { ok: false, error: `Keep the message under ${MESSAGE_MAX} characters — it has to be read at a glance.` };
  const now = new Date();

  let data: { enabled: boolean; startsAt: Date | null; endsAt: Date | null };
  if (input.mode === "off") {
    data = { enabled: false, startsAt: null, endsAt: null };
  } else {
    const startsAt = input.mode === "schedule" ? parseIstDateTime(input.startsAt ?? "") : null;
    if (input.mode === "schedule" && !startsAt) return { ok: false, error: "Pick when it starts." };
    if (startsAt && startsAt.getTime() <= now.getTime()) return { ok: false, error: "That start time has passed — switch it on now instead, or pick a later time." };
    const endsAt = input.endsAt?.trim() ? parseIstDateTime(input.endsAt) : null;
    if (input.endsAt?.trim() && !endsAt) return { ok: false, error: "That end time isn't a date and time." };
    if (endsAt && endsAt.getTime() <= (startsAt ?? now).getTime()) return { ok: false, error: "It has to end after it starts." };
    data = { enabled: true, startsAt, endsAt };
  }

  await db.maintenanceMode.upsert({
    where: { id: "global" },
    create: { id: "global", ...data, message: message || null, updatedById: user.id },
    update: { ...data, message: message || null, updatedById: user.id },
  });
  forgetMaintenanceCache();

  const until = data.endsAt ? ` until ${formatIstDateTime(data.endsAt)}` : " until switched off";
  const label =
    input.mode === "off"
      ? "Maintenance mode switched off"
      : input.mode === "now"
        ? `Maintenance mode switched on${until}`
        : `Maintenance scheduled from ${formatIstDateTime(data.startsAt!)}${until}`;
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "MaintenanceMode", entityId: "global", entityLabel: label });

  // The banner is in the layout every page shares.
  revalidatePath("/", "layout");
  return { ok: true, data: { phase: maintenanceState({ ...data, message }).phase } };
}
