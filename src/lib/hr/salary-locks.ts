import { db } from "@/lib/db";

/**
 * The latest locked or paid payroll month on or after the month a salary structure would start in, or
 * null. A structure starting then would contradict payslips already issued, so it is refused — by the
 * salary form (saveSalaryStructure) and the migration import (src/lib/portability/importers/payroll.ts)
 * alike. Server only.
 */
export async function lockedRunFrom(effectiveFrom: Date): Promise<{ month: number; year: number } | null> {
  return db.payrollRun.findFirst({
    where: {
      status: { in: ["LOCKED", "PAID"] },
      OR: [
        { year: { gt: effectiveFrom.getUTCFullYear() } },
        { year: effectiveFrom.getUTCFullYear(), month: { gte: effectiveFrom.getUTCMonth() + 1 } },
      ],
    },
    orderBy: [{ year: "desc" }, { month: "desc" }],
    select: { month: true, year: true },
  });
}
