import { rm } from "node:fs/promises";
import { runBackup } from "@/lib/backup/run";
import { backupRootFor } from "@/lib/backup/maintenance";
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

async function audit(tenantId: string, actor: string, action: string, detail?: Record<string, unknown>) {
  await controlDb().platformAuditLog.create({ data: { actorKind: "SCRIPT", actor, action, tenantId, detail: detail as never } });
}

export async function suspendTenant(tenantId: string, actor: string, reason: string): Promise<void> {
  await controlDb().tenant.update({ where: { id: tenantId }, data: { status: "SUSPENDED", suspendedAt: new Date() } });
  await audit(tenantId, actor, "tenant.suspend", { reason });
  forgetRegistry();
}

export async function resumeTenant(tenantId: string, actor: string): Promise<void> {
  const tenant = await controlDb().tenant.findUniqueOrThrow({ where: { id: tenantId } });
  if (tenant.status !== "SUSPENDED") throw new Error(`Workspace ${tenant.slug} is ${tenant.status}, not suspended.`);
  await controlDb().tenant.update({ where: { id: tenantId }, data: { status: "ACTIVE", suspendedAt: null } });
  await audit(tenantId, actor, "tenant.resume");
  forgetRegistry();
}

export async function deprovisionTenant(tenantId: string, actor: string, options: { finalBackup?: boolean } = {}): Promise<{ backup: string | null }> {
  const control = controlDb();
  const row = await control.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  if (row.isDefault) throw new Error("The first workspace is the installation's own and is not closed this way.");
  if (row.status === "DEPROVISIONED") throw new Error(`Workspace ${row.slug} is already closed.`);

  // Held first, so nobody is working in it while it is backed up and dropped.
  if (row.status !== "SUSPENDED") await control.tenant.update({ where: { id: tenantId }, data: { status: "SUSPENDED", suspendedAt: new Date() } });
  forgetRegistry();

  let backup: string | null = null;
  if (options.finalBackup !== false && row.dbUrlCipher) {
    const tenant = await tenantById(tenantId);
    if (!tenant) throw new Error("The workspace could not be read back for its final backup.");
    // The registry serves only active workspaces to requests; a script may still act as a held one.
    const outcome = await runAsTenant(tenant, () => runBackup({ kind: "FULL" }));
    if (!outcome.ok) throw new Error(`The final backup failed, so nothing was dropped: ${outcome.error}`);
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
  if (row.status !== "DEPROVISIONED" || !row.deprovisionedAt) throw new Error(`Workspace ${row.slug} has not been closed.`);
  const due = new Date(row.deprovisionedAt.getTime() + RETENTION_DAYS * 86_400_000);
  if (!options.force && due > new Date()) throw new Error(`Workspace ${row.slug} is kept until ${due.toISOString().slice(0, 10)}.`);
  await rm(backupRootFor({ id: row.id, isDefault: false }), { recursive: true, force: true });
  await control.tenant.update({ where: { id: tenantId }, data: { keyBundleCipher: "" } });
  await audit(tenantId, actor, "tenant.purge");
  forgetRegistry();
}
