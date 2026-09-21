"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { hasEffectivePermission } from "@/actions/permission";
import { parseAttlog } from "@/lib/hr/iclock";
import { linkPunchesToUsers, rollupPunches } from "@/lib/hr/punch-rollup";
import { dateOnly } from "@/lib/hr/calendar";
import type { ActionResult } from "@/actions/company";

/**
 * Registering terminals, mapping enrolment numbers to people, and the manual import fallback.
 *
 * All of it is HR's, behind `hr.manage`: a terminal registration decides whose uploads are believed,
 * and an enrolment mapping decides whose attendance a punch becomes.
 */

async function requireHr() {
  const user = await requireUser();
  const allowed = await hasEffectivePermission(user.id, "hr.manage");
  return { user, allowed };
}

// ─── Devices ──────────────────────────────────────────────────────────────────

export async function listBiometricDevices() {
  const { allowed } = await requireHr();
  if (!allowed) return [];
  return toPlain(
    await db.biometricDevice.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }],
      include: { _count: { select: { punches: true } } },
    }),
  );
}

export async function saveBiometricDevice(input: {
  id?: string;
  serialNumber: string;
  name: string;
  location?: string;
  timezone?: string;
  active?: boolean;
}): Promise<ActionResult<{ id: string }>> {
  const { user, allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can register a biometric terminal." };

  const serialNumber = input.serialNumber.trim().toUpperCase();
  const name = input.name.trim();
  if (!serialNumber) return { ok: false, error: "The serial number is what identifies the device — it can't be blank." };
  if (!name) return { ok: false, error: "Give the terminal a name." };

  const payload = {
    serialNumber,
    name,
    location: input.location?.trim() || null,
    timezone: input.timezone?.trim() || "Asia/Kolkata",
    active: input.active ?? true,
  };

  try {
    const row = input.id
      ? await db.biometricDevice.update({ where: { id: input.id }, data: payload, select: { id: true } })
      : await db.biometricDevice.create({ data: payload, select: { id: true } });

    await recordAudit({
      userId: user.id,
      action: input.id ? "UPDATE" : "CREATE",
      entityType: "BiometricDevice",
      entityId: row.id,
      entityLabel: `${name} (${serialNumber})${payload.active ? "" : " — disabled"}`,
    });
    revalidatePath("/people/devices");
    return { ok: true, data: row };
  } catch {
    return { ok: false, error: `Serial ${serialNumber} is already registered.` };
  }
}

export async function setBiometricDeviceActive(id: string, active: boolean): Promise<ActionResult<null>> {
  const { user, allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can change a terminal." };

  const device = await db.biometricDevice.update({
    where: { id },
    data: { active },
    select: { name: true, serialNumber: true },
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "BiometricDevice",
    entityId: id,
    entityLabel: `${device.name} (${device.serialNumber}) ${active ? "enabled" : "disabled — its uploads are now refused"}`,
  });
  revalidatePath("/people/devices");
  return { ok: true, data: null };
}

// ─── Mapping enrolment numbers to people ──────────────────────────────────────

/**
 * Enrolment numbers seen on the terminals that belong to nobody yet.
 *
 * The whole reason unmatched punches are kept: this list is the work queue, and mapping a number
 * recovers everything already collected against it rather than starting from today.
 */
export async function unmappedEnrolments() {
  const { allowed } = await requireHr();
  if (!allowed) return [];

  const rows = await db.biometricPunch.groupBy({
    by: ["deviceUserId"],
    where: { userId: null },
    _count: { _all: true },
    _min: { punchedAt: true },
    _max: { punchedAt: true },
    orderBy: { _max: { punchedAt: "desc" } },
    take: 100,
  });

  return rows.map((r) => ({
    deviceUserId: r.deviceUserId,
    punches: r._count._all,
    firstSeen: r._min.punchedAt?.toISOString() ?? null,
    lastSeen: r._max.punchedAt?.toISOString() ?? null,
  }));
}

/**
 * Attaches a terminal enrolment number to a person, then replays the punches it already has.
 *
 * The replay is the point. Somebody enrolled on Monday and mapped on Friday gets the week's
 * attendance rather than losing it — and without it the obvious workaround would be re-syncing the
 * whole terminal, which is exactly the operation most likely to go wrong.
 */
export async function mapEnrolment(userId: string, biometricId: string): Promise<ActionResult<{ linked: number; days: number }>> {
  const { user, allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can map a biometric number." };

  const value = biometricId.trim();
  if (!value) return { ok: false, error: "Enter the enrolment number from the terminal." };

  const target = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
  if (!target) return { ok: false, error: "That user no longer exists." };

  const clash = await db.employeeProfile.findFirst({
    where: { biometricId: value, userId: { not: userId } },
    select: { user: { select: { name: true } } },
  });
  if (clash) {
    return { ok: false, error: `Enrolment number ${value} already belongs to ${clash.user.name}.` };
  }

  await db.employeeProfile.upsert({
    where: { userId },
    create: { userId, biometricId: value },
    update: { biometricId: value },
  });

  const linked = await linkPunchesToUsers([value]);
  const rollup = await rollupPunches({ userId });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "EmployeeProfile",
    entityId: userId,
    entityLabel: `Biometric enrolment ${value} mapped to ${target.name} — ${linked} punch(es) recovered`,
  });
  revalidatePath("/people/devices");
  revalidatePath("/people/attendance");
  return { ok: true, data: { linked, days: rollup.daysWritten } };
}

export async function clearEnrolment(userId: string): Promise<ActionResult<null>> {
  const { user, allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can change a biometric mapping." };

  await db.employeeProfile.update({ where: { userId }, data: { biometricId: null } });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "EmployeeProfile",
    entityId: userId,
    entityLabel: "Biometric enrolment unmapped",
  });
  revalidatePath("/people/devices");
  return { ok: true, data: null };
}

/** Everyone with a mapping, for the devices page. */
export async function mappedEnrolments() {
  const { allowed } = await requireHr();
  if (!allowed) return [];
  return toPlain(
    await db.employeeProfile.findMany({
      where: { biometricId: { not: null } },
      select: {
        userId: true,
        biometricId: true,
        employeeCode: true,
        user: { select: { id: true, name: true, active: true } },
      },
      orderBy: { user: { name: "asc" } },
    }),
  );
}

// ─── Manual import ────────────────────────────────────────────────────────────

/**
 * The fallback for sites that cannot point a terminal at this server.
 *
 * Plenty of eSSL installations run eTimeTrackLite on a PC in the office with no route in from
 * outside, and the realistic answer there is the .dat / .txt export that software produces — which
 * is the same tab-separated ATTLOG format the push protocol uses, so the same parser reads it.
 */
export async function importPunchFile(deviceId: string, contents: string): Promise<
  ActionResult<{ parsed: number; stored: number; rejected: number; linked: number; days: number }>
> {
  const { user, allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can import attendance." };

  const device = await db.biometricDevice.findUnique({ where: { id: deviceId }, select: { id: true, name: true } });
  if (!device) return { ok: false, error: "Pick the terminal this file came from." };

  const { punches, rejected } = parseAttlog(contents);
  if (punches.length === 0) {
    return {
      ok: false,
      error: rejected.length
        ? `Nothing readable in that file — the first line failed with "${rejected[0].why}".`
        : "That file has no attendance rows in it.",
    };
  }

  const created = await db.biometricPunch.createMany({
    data: punches.map((p) => ({
      deviceId: device.id,
      deviceUserId: p.deviceUserId,
      punchedAt: p.punchedAt,
      punchType: p.punchType,
      verifyMode: p.verifyMode,
      raw: p.raw,
    })),
    skipDuplicates: true,
  });

  const linked = await linkPunchesToUsers([...new Set(punches.map((p) => p.deviceUserId))]);
  const rollup = await rollupPunches();

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "BiometricPunch",
    entityId: device.id,
    entityLabel: `Imported ${created.count} punch(es) from a file for ${device.name}`,
  });
  revalidatePath("/people/devices");
  revalidatePath("/people/attendance");
  return {
    ok: true,
    data: { parsed: punches.length, stored: created.count, rejected: rejected.length, linked, days: rollup.daysWritten },
  };
}

/** Re-runs the rollup by hand, for when a mapping or a leave cancellation changes what a day means. */
export async function reprocessPunches(): Promise<ActionResult<{ days: number; punches: number; skipped: number }>> {
  const { allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can reprocess attendance." };

  await linkPunchesToUsers();
  const result = await rollupPunches();
  revalidatePath("/people/attendance");
  revalidatePath("/people/devices");
  return { ok: true, data: { days: result.daysWritten, punches: result.punchesProcessed, skipped: result.skipped.length } };
}

/** The raw log for one person and day, for settling a dispute about a time. */
export async function punchesFor(userId: string, date: string) {
  const user = await requireUser();
  const canSeeOthers =
    (await hasEffectivePermission(user.id, "hr.manage")) || (await hasEffectivePermission(user.id, "hr.viewAll"));
  if (userId !== user.id && !canSeeOthers) return [];

  const day = dateOnly(date);
  const end = new Date(day.getTime() + 24 * 60 * 60 * 1000 - 1);
  return toPlain(
    await db.biometricPunch.findMany({
      where: { userId, punchedAt: { gte: day, lte: end } },
      orderBy: { punchedAt: "asc" },
      include: { device: { select: { name: true } } },
    }),
  );
}

/** Recent activity across all terminals, so "is it working" has an answer. */
export async function recentPunches(limit = 25) {
  const { allowed } = await requireHr();
  if (!allowed) return [];
  return toPlain(
    await db.biometricPunch.findMany({
      orderBy: { punchedAt: "desc" },
      take: limit,
      include: {
        device: { select: { name: true } },
        user: { select: { id: true, name: true } },
      },
    }),
  );
}
