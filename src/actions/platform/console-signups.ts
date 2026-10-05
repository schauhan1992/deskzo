"use server";

import type { StaffRole } from "@deskzo/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import { SIGNUP_VIEWERS } from "@/lib/console-shared/roles";
import { consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { resendSignupCode } from "@/lib/platform/signup-code";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";

/**
 * Console › Signups: staff following up on a stuck signup (src/lib/platform/signup-code.ts). Whoever
 * may open the page may send a new code — it goes only to the address the signup was made with, and
 * nobody sees it.
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

/** A new code for a signup whose address was never confirmed, to that address. */
export async function consoleResendSignupCode(signupId: string): Promise<ConsoleResult<{ email: string; until: string }>> {
  return asStaff(SIGNUP_VIEWERS, async (staff) => {
    const sent = await resendSignupCode(staff, String(signupId ?? ""));
    revalidateConsole();
    return { email: sent.email, until: sent.until.toISOString() };
  });
}
