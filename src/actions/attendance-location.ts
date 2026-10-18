"use server";

import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { getDownlineUserIds } from "@/lib/org-chart";

/**
 * Where somebody clocked in or out from the Deskzo app on a day (owner, 18 Oct 2026; src/app/api/app/attendance) —
 * for the day's details on the attendance grid. Only to whoever may see that person's attendance, by the grid's
 * own rule: themselves, their managers up the line, and HR with "See everyone's attendance" or "Manage HR".
 */
export async function attendanceLocations(userId: string, date: string): Promise<{ kind: "IN" | "OUT"; at: string; latitude: number; longitude: number; accuracyM: number | null }[]> {
  const viewer = await requireModuleUser("hr");
  if (!(await isModuleEnabled("hr"))) return [];
  if (typeof userId !== "string" || typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const sees =
    userId === viewer.id ||
    (await hasEffectivePermission(viewer.id, "hr.viewAll")) ||
    (await hasEffectivePermission(viewer.id, "hr.manage")) ||
    (await getDownlineUserIds(viewer.id)).includes(userId);
  if (!sees) return [];
  const rows = await db.attendanceLocation.findMany({
    where: { userId, date: new Date(`${date}T00:00:00Z`) },
    orderBy: { at: "asc" },
    select: { kind: true, at: true, latitude: true, longitude: true, accuracyM: true },
  });
  return rows.map((r) => ({ kind: r.kind, at: r.at.toISOString(), latitude: r.latitude, longitude: r.longitude, accuracyM: r.accuracyM }));
}
