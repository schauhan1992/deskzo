"use server";

import type { ConsoleResult } from "@/actions/platform/console";
import { consoleZone } from "@/lib/platform/console-clock";
import { OWNERS, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { ConsoleRefused } from "@/lib/platform/refused";
import { setSetting } from "@/lib/platform/settings";
import { StaffRefused, requireStaff } from "@/lib/platform/staff-session";
import { readTimeZone } from "@/lib/time/zones";

/**
 * Settings › Time zone: the console's clock, for all staff (src/lib/platform/console-clock.ts). Owners
 * only, as every platform-wide setting is; audited.
 */
export async function consoleSetTimeZone(zone: unknown): Promise<ConsoleResult<null>> {
  let staff;
  try {
    staff = await requireStaff(OWNERS);
  } catch (err) {
    if (err instanceof StaffRefused) return { ok: false, error: err.message };
    throw err;
  }
  try {
    const chosen = readTimeZone(zone);
    if (!chosen) throw new ConsoleRefused("Choose a time zone from the list.");
    const before = await consoleZone();
    if (before === chosen) return { ok: true, data: null };
    await setSetting("console.timezone", chosen, staff.id);
    await consoleAudit(staff, "console.time-zone", { from: before, to: chosen });
    revalidateConsole();
    return { ok: true, data: null };
  } catch (err) {
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
}
