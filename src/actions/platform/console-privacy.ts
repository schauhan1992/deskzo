"use server";

import type { PrivacyRequestStatus, StaffRole } from "@deskzo/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import { ENTER, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { updatePrivacyRequest } from "@/lib/platform/privacy-requests";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";

/**
 * The console's Privacy requests (src/app/platform-console/(console)/privacy-requests): OWNER, ADMIN and
 * SUPPORT move a request along and keep notes on what was done — the record that shows it was answered,
 * and when. Each change is in the platform's audit log (`privacy.update`), by reference, never the person's
 * details.
 */

async function asStaff<T>(roles: readonly StaffRole[], work: (staff: Staff) => Promise<T>): Promise<ConsoleResult<T>> {
  let staff: Staff;
  try {
    staff = await requireStaff(roles);
  } catch (err) {
    if (err instanceof StaffRefused) return { ok: false, error: err.message };
    throw err;
  }
  try {
    return { ok: true, data: await work(staff) };
  } catch (err) {
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
}

/** A request's status, its notes, or both. */
export async function consoleUpdatePrivacyRequest(id: string, change: { status?: string; notes?: string }) {
  return asStaff(ENTER, async (staff): Promise<{ ref: string; status: PrivacyRequestStatus }> => {
    const result = await updatePrivacyRequest(String(id ?? ""), { status: change?.status, notes: change?.notes }, staff.id);
    await consoleAudit(staff, "privacy.update", { ref: result.ref, status: result.status, ...(change?.notes !== undefined ? { notes: true } : {}) });
    revalidateConsole();
    return result;
  });
}
