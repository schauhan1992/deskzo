import { rm } from "node:fs/promises";
import { runBackup } from "@/lib/backup/run";
import { backupRootFor } from "@/lib/backup/maintenance";
import { consoleClock } from "@/lib/platform/console-clock";
import { controlDb } from "@/lib/platform/control-db";
import { dropWorkspaceDatabase } from "@/lib/platform/provisioner";
import { forgetRegistry, tenantById } from "@/lib/tenancy/registry";
import { runAsTenant } from "@/lib/tenancy/resolve";

/**
 * Holding, reopening and closing a workspace — from the console, and until then from
 * `npm run platform:tenant`. Every change is in the platform audit log with who asked.
 *
 *   · suspend — held: the proxy shows a notice instead of the app, its API and terminals are turned
 *     away, its scheduled jobs skip it. Nothing is deleted.
 *   · resume — open again, exactly as it was.
 *   · deprovision — closed: a final full backup into its own folder, then its database and role are
 *     dropped, its addresses and terminal routes let go. Its keys are kept, because the final backup
 *     is unreadable without them.
 *   · purge — after the retention period (90 days): its keys are wiped and its backups deleted. After
 *     this nothing of it can be read by anybody.
 */

export const RETENTION_DAYS = 90;

/** A change refused for a reason worth telling whoever asked — shown as it is, in the console. */
export class LifecycleRefused extends Error {}

/** `actor`: "staff:<id>" from the console, or a script's name. */
async function audit(tenantId: string, actor: string, action: string, detail?: Record<string, unknown>) {
  const staff = actor.startsWith("staff:");
  await controlDb().platformAuditLog.create({ data: { actorKind: staff ? "STAFF" : "SCRIPT", actor: staff ? actor.slice(6) : actor, action, tenantId, detail: detail as never } });
}

/**
 * `kind`: STAFF, or BILLING — unpaid, a trial over, a subscription ended (src/lib/billing/lifecycle.ts).
 * A billing hold leaves the owner the billing page, and is lifted by paying; a staff hold is not
 * lifted by billing, and replaces a billing one.
 */
export async function suspendTenant(tenantId: string, actor: string, reason: string, kind: "STAFF" | "BILLING" = "STAFF"): Promise<void> {
  const tenant = await controlDb().tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { status: true, suspendedFor: true } });
  // Billing never softens a staff hold into one the owner could lift by paying.
  if (kind === "BILLING" && tenant.status === "SUSPENDED" && tenant.suspendedFor === "STAFF") return;
  await controlDb().tenant.update({ where: { id: tenantId }, data: { status: "SUSPENDED", suspendedAt: tenant.status === "SUSPENDED" ? undefined : new Date(), suspendedFor: kind } });
  await audit(tenantId, actor, "tenant.suspend", { reason, kind });
  forgetRegistry();
}

export async function resumeTenant(tenantId: string, actor: string): Promise<void> {
  const tenant = await controlDb().tenant.findUniqueOrThrow({ where: { id: tenantId } });
  if (tenant.status !== "SUSPENDED") throw new LifecycleRefused(`Workspace ${tenant.slug} is ${tenant.status}, not suspended.`);
  await controlDb().tenant.update({ where: { id: tenantId }, data: { status: "ACTIVE", suspendedAt: null, suspendedFor: null } });
  await audit(tenantId, actor, "tenant.resume");
  forgetRegistry();
}

/** Paid again: open — but only a billing hold; a staff hold stays until staff lift it. */
export async function liftBillingHold(tenantId: string, actor: string): Promise<boolean> {
  const lifted = await controlDb().tenant.updateMany({ where: { id: tenantId, status: "SUSPENDED", suspendedFor: "BILLING" }, data: { status: "ACTIVE", suspendedAt: null, suspendedFor: null } });
  if (!lifted.count) return false;
  await audit(tenantId, actor, "tenant.resume", { billing: true });
  forgetRegistry();
  return true;
}

export async function deprovisionTenant(tenantId: string, actor: string, options: { finalBackup?: boolean } = {}): Promise<{ backup: string | null }> {
  const control = controlDb();
  const row = await control.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  if (row.isDefault) throw new LifecycleRefused("The first workspace is the installation's own and is not closed this way.");
  if (row.status === "DEPROVISIONED") throw new LifecycleRefused(`Workspace ${row.slug} is already closed.`);

  // Held first, so nobody is working in it while it is backed up and dropped.
  if (row.status !== "SUSPENDED") await control.tenant.update({ where: { id: tenantId }, data: { status: "SUSPENDED", suspendedAt: new Date(), suspendedFor: "STAFF" } });
  forgetRegistry();

  let backup: string | null = null;
  if (options.finalBackup !== false && row.dbUrlCipher) {
    const tenant = await tenantById(tenantId);
    if (!tenant) throw new LifecycleRefused("The workspace could not be read back for its final backup.");
    // The registry serves only active workspaces to requests; a script may still act as a held one.
    const outcome = await runAsTenant(tenant, () => runBackup({ kind: "FULL" }));
    if (!outcome.ok) throw new LifecycleRefused(`The final backup failed, so nothing was dropped: ${outcome.error}`);
    backup = outcome.filename;
  }

  if (row.dbName && row.dbRole) await dropWorkspaceDatabase(row.dbName, row.dbRole);
  await control.$transaction(async (tx) => {
    await tx.tenantDomain.deleteMany({ where: { tenantId } });
    await tx.biometricDeviceRoute.deleteMany({ where: { tenantId } });
    await tx.tenant.update({ where: { id: tenantId }, data: { status: "DEPROVISIONED", deprovisionedAt: new Date(), dbUrlCipher: null } });
  });
  await audit(tenantId, actor, "tenant.deprovision", { backup });
  forgetRegistry();
  return { backup };
}

export async function purgeTenant(tenantId: string, actor: string, options: { force?: boolean } = {}): Promise<void> {
  const control = controlDb();
  const row = await control.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  if (row.status !== "DEPROVISIONED" || !row.deprovisionedAt) throw new LifecycleRefused(`Workspace ${row.slug} has not been closed.`);
  const due = new Date(row.deprovisionedAt.getTime() + RETENTION_DAYS * 86_400_000);
  // The day on the console's clock: the refusal is shown to staff as it is.
  if (!options.force && due > new Date()) throw new LifecycleRefused(`Workspace ${row.slug} is kept until ${(await consoleClock()).date(due)}.`);
  await rm(backupRootFor({ id: row.id, isDefault: false }), { recursive: true, force: true });
  await control.tenant.update({ where: { id: tenantId }, data: { keyBundleCipher: "" } });
  await audit(tenantId, actor, "tenant.purge");
  forgetRegistry();
}
