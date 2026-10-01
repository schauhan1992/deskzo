"use server";

import type { StaffRole } from "@deskzo/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import type { CmsActor } from "@/lib/cms/audit";
import { cmsRefusal } from "@/lib/cms/guard";
import { createCmsUser, newCmsSetupLink } from "@/lib/cms/users";
import { MANAGERS, OWNERS, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";

/**
 * The console's "Website CMS" page (src/app/platform-console/(console)/website): how the website's CMS
 * gets its first admin, and how an admin locked out gets back in. The CMS's accounts are its own
 * (src/lib/cms/users.ts); nothing here signs anybody in to it.
 *
 *   consoleInviteCmsAdmin   OWNER      a new CMS ADMIN — the setup link is emailed to them and shown
 *                                      once to the owner, to pass on if the mail does not arrive
 *   consoleCmsAdminLink     managers   a fresh setup link for a CMS admin, emailed to them only
 *
 * Each is in the platform's audit log (consoleAudit) and the CMS's own (as "Platform staff: <name>").
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
    const cms = cmsRefusal(err);
    if (cms) return { ok: false, error: cms.error };
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
}

const staffActor = (staff: Staff): CmsActor => ({ kind: "staff", id: staff.id, name: staff.name });

export async function consoleInviteCmsAdmin(input: { email: string; name: string }): Promise<ConsoleResult<{ setupUrl: string; emailed: boolean }>> {
  return asStaff(OWNERS, async (staff) => {
    const made = await createCmsUser({ email: String(input?.email ?? ""), name: String(input?.name ?? ""), role: "ADMIN" }, staffActor(staff));
    await consoleAudit(staff, "cms.admin.invite", { email: String(input?.email ?? "").trim().toLowerCase(), cmsUserId: made.id, emailed: made.emailed });
    revalidateConsole();
    return { setupUrl: made.setupUrl, emailed: made.emailed };
  });
}

export async function consoleCmsAdminLink(userId: string): Promise<ConsoleResult<{ emailed: boolean }>> {
  return asStaff(MANAGERS, async (staff) => {
    const id = String(userId ?? "").slice(0, 40);
    const user = await controlDb().cmsUser.findUnique({ where: { id }, select: { role: true, email: true } });
    // From the console, only the CMS's admins: everybody else is theirs to look after.
    if (!user || user.role !== "ADMIN") throw new StaffRefused("That is not a CMS admin.");
    const sent = await newCmsSetupLink(id, staffActor(staff), false);
    await consoleAudit(staff, "cms.admin.setup-link", { email: user.email, cmsUserId: id, emailed: sent.emailed });
    revalidateConsole();
    return { emailed: sent.emailed };
  });
}
