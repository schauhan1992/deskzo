"use server";

import type { StaffRole } from "@deskzo/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import { OWNERS, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";
import { setPlatformPaused } from "@/lib/automate/switches";

/**
 * Settings › Automate: the platform's kill switch for Deskzo Automate in every workspace at once
 * (src/lib/automate/switches.ts). Owners only. Off: no workflow starts or moves on anywhere; runs keep
 * their place and carry on when it is switched back on. Audited as `automate.settings`.
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

export async function consoleSetAutomateRunning(running: boolean): Promise<ConsoleResult<null>> {
  return asStaff(OWNERS, async (staff) => {
    if (running !== true && running !== false) return null;
    await setPlatformPaused(!running, staff.id);
    await consoleAudit(staff, "automate.settings", { running });
    revalidateConsole();
    return null;
  });
}
