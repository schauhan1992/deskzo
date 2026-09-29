import { db } from "@/lib/db";
import { doorCheck } from "@/lib/access/record";
import { spendHandoffTicket } from "@/lib/platform/handoff";
import { activeSupportGrant } from "@/lib/platform/support";
import { isAutomationKind } from "@/lib/people";

/**
 * The account a one-time pass signs in at this workspace — or nobody. The "handoff" sign-in
 * (src/lib/auth.ts) is this and nothing more; it lives here so it can be checked without the rest of
 * the sign-in machinery.
 *
 * The pass is spent against the workspace the request is on, so one made for another workspace signs
 * nobody in here. Never an account with two-factor on: a pass must not be a way around it. An owner's
 * pass signs in a member, and passes the door as any sign-in would; a support pass signs in a support
 * account, and only while the workspace's grant is live.
 */
export async function handoffAccount(ticket: string, tenantId: string) {
  const pass = await spendHandoffTicket(ticket, tenantId);
  if (!pass) return null;
  const user = await db.user.findUnique({ where: { email: pass.email } });
  if (!user || !user.active || user.twoFactorEnabledAt) return null;
  // Never the workspace's Automation account (src/lib/automation-user.ts), whatever the pass is for.
  if (isAutomationKind(user.kind)) return null;
  if (pass.purpose === "owner-signup") {
    if (user.kind !== "MEMBER" || (await doorCheck(user))) return null;
  } else if (pass.purpose === "support") {
    if (user.kind !== "SUPPORT" || !(await activeSupportGrant(tenantId, true))) return null;
  } else {
    return null;
  }
  return user;
}
