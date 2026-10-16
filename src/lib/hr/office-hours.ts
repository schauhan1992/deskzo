import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import type { OfficeHours } from "@/lib/hr/office-hours-rules";

/**
 * The company's office hours (owner, 16 Oct 2026), or null while nobody has set them — or the table
 * isn't there yet. The rules are src/lib/hr/office-hours-rules.ts. Server only.
 */
export async function officeHours(): Promise<OfficeHours | null> {
  try {
    const row = await db.attendanceSettings.findUnique({ where: { id: "global" } });
    return row ? { startMinute: row.startMinute, endMinute: row.endMinute, graceMinutes: row.graceMinutes } : null;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}
