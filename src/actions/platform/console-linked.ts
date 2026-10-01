"use server";

import type { StaffRole } from "@deskzo/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import { OWNERS, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { saveLinkedSignInSetting } from "@/lib/platform/linked/groups";
import { ConsoleRefused } from "@/lib/platform/refused";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";

/**
 * Settings › Linked sign-in (owner decision #8): the platform's switch for linked sign-in in every
 * workspace at once — the same `linkedSignIn.enabled` that `npm run linked-sign-in -- on|off` sets
 * from the server. Owners only; everybody else who opens Settings sees it, not a control.
 *
 * Saved through `saveLinkedSignInSetting`, which writes no audit of its own, so the entry here is the
 * one record: `linked.settings` under the staff member. Not `setLinkedSignInEnabled` — that is the
 * script's, and records the change as the script. This process follows at once; others within 30 s.
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

/**
 * Linked sign-in on or off, for every workspace. Off: no workspace shows its switcher, and nobody can
 * link accounts or switch between them — the links themselves are kept, for when it is on again.
 */
export async function consoleSetLinkedSignIn(enabled: boolean): Promise<ConsoleResult<null>> {
  return asStaff(OWNERS, async (staff) => {
    // From a browser: only a real boolean, never a truthy string.
    if (enabled !== true && enabled !== false) throw new ConsoleRefused("Choose on or off.");
    await saveLinkedSignInSetting(enabled, staff.id);
    await consoleAudit(staff, "linked.settings", { enabled });
    revalidateConsole();
    return null;
  });
}
