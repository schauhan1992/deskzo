import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * Which of somebody's payslips and letters are kept from them (owner, 21 Oct 2026: the file manager, where an
 * admin turns each of an employee's documents on or off). Read by every place the person reads their own —
 * My HR, Payroll, their Letters card, the print pages — so a document switched off is off everywhere, not
 * only in the file manager. Uploaded documents carry their own switch (`EmployeeDocument.visibleToEmployee`).
 *
 * Nothing is hidden in a workspace whose database doesn't have the table yet: everything shows, as it did.
 */

export type HideableKind = "PAYSLIP" | "LETTER";

/** The ids of this person's payslips or letters that are switched off for them. */
export async function hiddenFileIds(userId: string, kind: HideableKind): Promise<Set<string>> {
  try {
    const rows = await db.employeeFileVisibility.findMany({ where: { userId, kind, hidden: true }, select: { refId: true } });
    return new Set(rows.map((r) => r.refId));
  } catch (err) {
    if (notMigratedYet(err)) return new Set();
    throw err;
  }
}

/** Whether one payslip or letter is switched off for the person it belongs to. */
export async function isFileHidden(kind: HideableKind, refId: string): Promise<boolean> {
  try {
    const row = await db.employeeFileVisibility.findUnique({ where: { kind_refId: { kind, refId } }, select: { hidden: true } });
    return row?.hidden === true;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}
