import { notFound, redirect } from "next/navigation";
import type { StaffRole } from "@wroffy/control-client";
import { currentStaffSession, type Staff } from "@/lib/platform/staff-session";

/**
 * The first line of every console page: the staff member looking at it, or a redirect to where they
 * need to be — signing in, or enrolling their authenticator. A layout is not enough on its own: the
 * App Router keeps a layout across navigations without running it again, so each page checks itself.
 *
 * `roles`: a page only some roles may open. Anybody else gets a plain "not found", the same as a page
 * that does not exist.
 */
export async function consoleStaff(roles?: readonly StaffRole[]): Promise<Staff> {
  const session = await currentStaffSession();
  if (!session) redirect("/login");
  if (!session.mfaDone) redirect(session.enrolled ? "/login" : "/enrol");
  if (roles && roles.length && !roles.includes(session.staff.role)) notFound();
  return session.staff;
}

/** Who may do what from the console, for pages deciding which buttons to show (the actions check again). */
export const CONSOLE_MANAGERS: readonly StaffRole[] = ["OWNER", "ADMIN"];
export const mayManage = (staff: Staff) => CONSOLE_MANAGERS.includes(staff.role);
export const mayEnterWorkspaces = (staff: Staff) => (["OWNER", "ADMIN", "SUPPORT"] as StaffRole[]).includes(staff.role);
export const isOwner = (staff: Staff) => staff.role === "OWNER";
