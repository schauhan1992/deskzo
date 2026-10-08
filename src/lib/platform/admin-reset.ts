import { createHash, randomBytes } from "node:crypto";
import { awaitingSetup } from "@/lib/account-setup";
import { ADMIN_RESET_LINK_TTL_MS, adminResetMail } from "@/lib/admin-password";
import { automationUserId } from "@/lib/automation-user";
import { COMPANY_NAME } from "@/lib/brand-names";
import { db } from "@/lib/db";
import { cleanText } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { ConsoleRefused } from "@/lib/platform/refused";
import type { Staff } from "@/lib/platform/staff-session";
import { lockoutState, recordFailure } from "@/lib/security/lockout";
import { tenantKey } from "@/lib/tenancy/cache";
import { tenantById } from "@/lib/tenancy/registry";
import { runAsTenant, tenantOrigin } from "@/lib/tenancy/resolve";
import { signInPolicyFor } from "@/lib/workplace/sign-in-rules-server";
import { PEOPLE_ONLY } from "@/lib/people";

/**
 * Staff sending a workspace's super admin a link to choose a new password (owner, 5 Oct 2026 —
 * Workspace 360 › Support, "Send a password reset").
 *
 * The link goes to the super admin's own address as the workspace records it — never to the console,
 * never to staff, never to an address staff type — so staff can help somebody locked out without ever
 * being able to get in themselves. It is the same link the workspace's own admins send
 * (src/actions/user.ts `sendPasswordResetEmail`): once, for 24 hours, replacing any unused one; the
 * current password keeps working until it is used. It counts against the address's "Forgot your
 * password?" limit, and staff send at most one per workspace every ten minutes.
 *
 * Recorded in the platform audit log (`tenant.admin-reset`) and in the workspace's own, under its
 * Automation account, naming the staff member — so the workspace can see it happened.
 */

export const ADMIN_RESET_EVERY_MS = 10 * 60_000;

/** "r•••@acme.com" — enough for staff to read back to the caller, not the whole address. */
export function maskedAddress(address: string): string {
  const [local = "", domain = ""] = address.split("@");
  return `${local.slice(0, 1)}•••@${domain}`;
}

export async function sendWorkspaceAdminReset(staff: Staff, tenantId: string, now = new Date()): Promise<{ name: string; to: string }> {
  const control = controlDb();
  const row = await control.tenant.findUnique({ where: { id: String(tenantId ?? "") }, select: { id: true, slug: true, name: true, status: true } });
  if (!row) throw new ConsoleRefused("That workspace no longer exists.");
  if (row.status !== "ACTIVE") throw new ConsoleRefused("Only an open workspace can be signed into — this one isn't open.");
  const recent = await control.platformAuditLog.findFirst({
    where: { tenantId: row.id, action: "tenant.admin-reset", at: { gt: new Date(now.getTime() - ADMIN_RESET_EVERY_MS) } },
    select: { id: true },
  });
  if (recent) throw new ConsoleRefused("A reset link went to its super admin a few minutes ago. Give it ten minutes to arrive before sending another.");
  const tenant = await tenantById(row.id);
  if (!tenant) throw new ConsoleRefused("That workspace no longer exists.");

  const who = cleanText(staff.name, 80).replace(/\s+/g, " ");
  const sender = who && !who.includes("@") ? `${who}, from ${COMPANY_NAME} support,` : `${COMPANY_NAME} support`;

  const sent = await runAsTenant(tenant, async () => {
    const admin = await db.user.findFirst({
      where: { isSuperAdmin: true, ...PEOPLE_ONLY },
      select: { id: true, name: true, email: true, role: true, active: true, isSuperAdmin: true },
    });
    if (!admin) throw new ConsoleRefused("This workspace has no super admin to send it to.");
    if (!admin.active) throw new ConsoleRefused("Its super admin's account is switched off, so a password wouldn't let them in.");
    if (await awaitingSetup(admin.id)) throw new ConsoleRefused("Its super admin hasn't chosen a password yet — their setup email is what they need, from the workspace's Users page.");
    const policy = await signInPolicyFor(admin);
    if (!policy.password) throw new ConsoleRefused("Its super admin signs in without a password (single sign-on only), so a password link wouldn't help.");

    const address = admin.email.trim();
    const keys = [`${await tenantKey()}|reset:${address.toLowerCase()}`];
    const limit = lockoutState(keys);
    if (limit.lockedOut) throw new ConsoleRefused(`Too many password emails for that address just now. Try again in ${Math.ceil(limit.retryInSeconds / 60)} minutes.`);
    recordFailure(keys);

    const token = randomBytes(32).toString("base64url");
    await db.$transaction(async (tx) => {
      await tx.passwordResetToken.deleteMany({ where: { userId: admin.id, usedAt: null } });
      await tx.passwordResetToken.create({ data: { tokenHash: createHash("sha256").update(token).digest("hex"), userId: admin.id, expiresAt: new Date(now.getTime() + ADMIN_RESET_LINK_TTL_MS) } });
    });
    const url = `${await tenantOrigin(tenant)}/reset-password?t=${encodeURIComponent(token)}`;
    try {
      await sendPlatformMail({ type: "ACCOUNT", to: address, ...adminResetMail({ name: admin.name, workspace: row.name, admin: sender, url }) });
    } catch {
      // The link exists only in the email that didn't go: nobody else is ever shown it.
      await db.passwordResetToken.deleteMany({ where: { userId: admin.id, usedAt: null } });
      throw new ConsoleRefused("The email couldn't be sent — the Mail log says why. Nothing changed for them.");
    }
    await db.auditLog
      .create({
        data: {
          userId: await automationUserId(),
          action: "UPDATE",
          entityType: "User",
          entityId: admin.id,
          entityLabel: `${admin.name} — sent a password reset email by ${COMPANY_NAME} support (${who || "staff"})`,
        },
      })
      .catch(() => {});
    return { name: admin.name, to: address };
  });

  await control.platformAuditLog.create({ data: { actorKind: "STAFF", actor: staff.id, action: "tenant.admin-reset", tenantId: row.id, detail: { to: maskedAddress(sent.to) } } });
  return { name: sent.name, to: maskedAddress(sent.to) };
}
