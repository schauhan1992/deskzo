"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { recordAudit } from "@/lib/audit";
import { readOfficeLocation } from "@/lib/hr/geofence";
import type { ActionResult } from "@/actions/company";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { getDownlineUserIds } from "@/lib/org-chart";
import { notMigratedYet } from "@/lib/not-migrated";
import { PEOPLE_ONLY } from "@/lib/people";

/**
 * Where somebody clocked in or out from the Deskzo app on a day (owner, 18 Oct 2026; src/app/api/app/attendance) —
 * for the day's details on the attendance grid. Only to whoever may see that person's attendance, by the grid's
 * own rule: themselves, their managers up the line, and HR with "See everyone's attendance" or "Manage HR".
 */
export type ClockedPlace = {
  kind: "IN" | "OUT";
  at: string;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  /** How it was checked (owner, 22 Oct 2026; src/lib/hr/clock.ts) — null on rows from before. */
  check: "INSIDE" | "EXCEPTION" | "NOT_ENFORCED" | null;
  distanceM: number | null;
  radiusM: number | null;
  office: string | null;
  exceptionReason: string | null;
};

export async function attendanceLocations(userId: string, date: string): Promise<ClockedPlace[]> {
  const viewer = await requireModuleUser("hr");
  if (!(await isModuleEnabled("hr"))) return [];
  if (typeof userId !== "string" || typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const sees =
    userId === viewer.id ||
    (await hasEffectivePermission(viewer.id, "hr.viewAll")) ||
    (await hasEffectivePermission(viewer.id, "hr.manage")) ||
    (await getDownlineUserIds(viewer.id)).includes(userId);
  if (!sees) return [];
  const where = { userId, date: new Date(`${date}T00:00:00Z`) };
  const base = { kind: true, at: true, latitude: true, longitude: true, accuracyM: true } as const;
  try {
    const rows = await db.attendanceLocation.findMany({
      where,
      orderBy: { at: "asc" },
      select: { ...base, check: true, distanceM: true, radiusM: true, branch: { select: { name: true } }, exception: { select: { reason: true } } },
    });
    return rows.map((r) => ({
      kind: r.kind, at: r.at.toISOString(), latitude: r.latitude, longitude: r.longitude, accuracyM: r.accuracyM,
      check: r.check, distanceM: r.distanceM, radiusM: r.radiusM, office: r.branch?.name ?? null, exceptionReason: r.exception?.reason ?? null,
    }));
  } catch (err) {
    // A workspace not migrated to GPS attendance yet: where it was, as before.
    if (!notMigratedYet(err)) throw err;
    const rows = await db.attendanceLocation.findMany({ where, orderBy: { at: "asc" }, select: base });
    return rows.map((r) => ({ kind: r.kind, at: r.at.toISOString(), latitude: r.latitude, longitude: r.longitude, accuracyM: r.accuracyM, check: null, distanceM: null, radiusM: null, office: null, exceptionReason: null }));
  }
}

// ─── Each office's attendance location (owner, 22 Oct 2026) ──────────────────────────────────────

export type OfficeLocationRow = {
  id: string;
  name: string;
  code: string;
  address: string;
  isHeadOffice: boolean;
  active: boolean;
  /** Active people who work here — and, at the head office, everybody with no branch at all. */
  people: number;
  latitude: number | null;
  longitude: number | null;
  geofenceRadiusM: number;
  geoMaxAccuracyM: number;
  geofenceEnforced: boolean;
  geoExceptionsAllowed: boolean;
};

const OFFICE_BASE = { id: true, name: true, code: true, addressLine1: true, addressLine2: true, city: true, state: true, pincode: true, isHeadOffice: true, active: true } as const;
const OFFICE_GEO = { latitude: true, longitude: true, geofenceRadiusM: true, geoMaxAccuracyM: true, geofenceEnforced: true, geoExceptionsAllowed: true } as const;

/**
 * Every office with its attendance location, for Settings › People › Attendance locations — HR's to set
 * (`hr.manage`). Null for anybody else. `migrated` is false where the workspace's database doesn't have GPS
 * attendance yet: the offices are listed, and nothing can be saved.
 */
export async function listOfficeLocations(): Promise<{ migrated: boolean; offices: OfficeLocationRow[] } | null> {
  const user = await requireModuleUser("hr");
  if (!(await hasEffectivePermission(user.id, "hr.manage"))) return null;
  const [branches, unassigned] = await Promise.all([
    db.branch.findMany({ orderBy: [{ isHeadOffice: "desc" }, { active: "desc" }, { name: "asc" }], select: { ...OFFICE_BASE, _count: { select: { members: { where: { active: true, ...PEOPLE_ONLY } } } } } }),
    db.user.count({ where: { active: true, branchId: null, ...PEOPLE_ONLY } }),
  ]);
  let geo = new Map<string, Pick<OfficeLocationRow, keyof typeof OFFICE_GEO>>();
  let migrated = true;
  try {
    const rows = await db.branch.findMany({ select: { id: true, ...OFFICE_GEO } });
    geo = new Map(rows.map((r) => [r.id, r]));
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    migrated = false;
  }
  return {
    migrated,
    offices: branches.map((b) => ({
      id: b.id,
      name: b.name,
      code: b.code,
      address: [b.addressLine1, b.addressLine2, b.city, b.state, b.pincode].filter(Boolean).join(", "),
      isHeadOffice: b.isHeadOffice,
      active: b.active,
      people: b._count.members + (b.isHeadOffice ? unassigned : 0),
      latitude: geo.get(b.id)?.latitude ?? null,
      longitude: geo.get(b.id)?.longitude ?? null,
      geofenceRadiusM: geo.get(b.id)?.geofenceRadiusM ?? 100,
      geoMaxAccuracyM: geo.get(b.id)?.geoMaxAccuracyM ?? 50,
      geofenceEnforced: geo.get(b.id)?.geofenceEnforced ?? false,
      geoExceptionsAllowed: geo.get(b.id)?.geoExceptionsAllowed ?? true,
    })),
  };
}

const officeLocationSchema = z.object({
  branchId: z.string().min(1),
  latitude: z.union([z.number(), z.string()]).nullish(),
  longitude: z.union([z.number(), z.string()]).nullish(),
  radiusM: z.union([z.number(), z.string()]).nullish(),
  maxAccuracyM: z.union([z.number(), z.string()]).nullish(),
  enforced: z.boolean(),
  exceptionsAllowed: z.boolean(),
});

/** Sets an office's point, radius, accuracy limit and switches — validated here, whatever the form allowed. */
export async function saveOfficeLocation(input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("hr");
  if (!(await hasEffectivePermission(user.id, "hr.manage"))) return { ok: false, error: "Only HR can set offices' attendance locations." };
  const parsed = officeLocationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const read = readOfficeLocation(parsed.data);
  if (!read.ok) return read;
  const value = read.value;

  const branch = await db.branch.findUnique({ where: { id: parsed.data.branchId }, select: { id: true, name: true } });
  if (!branch) return { ok: false, error: "That office no longer exists." };
  let before: { latitude: number | null; geofenceEnforced: boolean } | null;
  try {
    before = await db.branch.findUnique({ where: { id: branch.id }, select: { latitude: true, geofenceEnforced: true } });
    await db.branch.update({ where: { id: branch.id }, data: value, select: { id: true } });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: "GPS attendance isn't set up in this workspace yet — the database needs its update first." };
    throw err;
  }

  // What changed, in words — the office's point is its own, not a person's, but the log needn't carry it.
  const turned = before && before.geofenceEnforced !== value.geofenceEnforced ? (value.geofenceEnforced ? "; GPS attendance turned on" : "; GPS attendance turned off") : "";
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Branch",
    entityId: branch.id,
    entityLabel: `${branch.name}: attendance location ${value.latitude === null ? "cleared" : "set"}, radius ${value.geofenceRadiusM} m, accuracy limit ${value.geoMaxAccuracyM} m, exceptions ${value.geoExceptionsAllowed ? "allowed" : "not allowed"}${turned}`,
  });
  revalidatePath("/settings/attendance-locations");
  revalidatePath("/people/me");
  revalidatePath("/people/attendance");
  return { ok: true, data: null };
}
