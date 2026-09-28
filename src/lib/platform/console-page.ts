import { notFound, redirect } from "next/navigation";
import type { StaffRole } from "@wroffy/control-client";
import { ENV_LABEL } from "@/lib/console-shared/labels";
import { ENTER, MANAGERS, OWNERS, SELLERS, capsFor, hasRole, type Caps } from "@/lib/console-shared/roles";
import type { PlatformEnv } from "@/lib/console-shared/types";
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

/**
 * Who may do what from the console, for pages deciding which buttons to show (the actions check again).
 * The sets themselves live in src/lib/console-shared/roles.ts; typing them as StaffRole here is what
 * proves the console's role names and the control plane's are the same.
 */
export const CONSOLE_MANAGERS: readonly StaffRole[] = MANAGERS;
export const mayManage = (staff: Staff) => hasRole(staff.role, MANAGERS);
export const mayEnterWorkspaces = (staff: Staff) => hasRole(staff.role, ENTER);
export const isOwner = (staff: Staff) => hasRole(staff.role, OWNERS);
/** Plans, prices, trials and billing: OWNER, ADMIN, BILLING. */
export const maySell = (staff: Staff) => hasRole(staff.role, SELLERS);

/** Everything the staff member may do, as plain booleans a client component can take as a prop. */
export function consoleCaps(staff: Staff): Caps {
  return capsFor(staff.role);
}

/**
 * Which installation this is — shown on every console page so nobody mistakes staging for the real
 * thing. PLATFORM_ENV names it (production, staging or development); without it, a production build
 * is production and anything else is development.
 */
export function platformEnv(): PlatformEnv {
  const named = process.env.PLATFORM_ENV?.trim().toLowerCase();
  const key: PlatformEnv["key"] =
    named === "production" || named === "staging" || named === "development" ? named : process.env.NODE_ENV === "production" ? "production" : "development";
  return { key, ...ENV_LABEL[key], titlePrefix: key === "production" ? "" : `[${key}] ` };
}
