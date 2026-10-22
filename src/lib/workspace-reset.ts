import { db, getTenantDb } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { PEOPLE_ONLY } from "@/lib/people";
import { runBackup } from "@/lib/backup/run";
import { restoreInProgress } from "@/lib/backup/maintenance";
import { resetAllData, resetOverview } from "@/lib/data-reset";
import { workspaceAccountsReset } from "@/lib/platform/account-hooks";
import { forgetAutomationUser } from "@/lib/automation-user";
import { resyncDeviceRoutes } from "@/lib/platform/device-routes";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { currentTenant } from "@/lib/tenancy/resolve";
import { confirmIdentity, type IdentityProof } from "@/lib/security/confirm-identity";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * Resetting a workspace to a fresh one (owner, 22 Oct 2026): everything goes but the super admin's
 * account and the workspace itself — its address, plan and billing, which live in the platform, not here.
 * Built on the reset engine (src/lib/data-reset.ts) and the safety copy a restore takes, with the rails a
 * customer's own button needs:
 *
 *   · **The super admin only**, who types the workspace's address and confirms it's them — password, and
 *     the two-factor code when they have it on (src/lib/security/confirm-identity.ts).
 *   · **A day's wait.** It is scheduled, not run: every admin is told at once, and any admin can cancel it
 *     until it starts (`RESET_WAIT_HOURS`). A rash or a malicious press is not a wipe.
 *   · **A safety copy first**, kept 30 days whatever the retention says: undoing the reset is restoring
 *     it from Settings › Backups. No copy, no reset.
 *   · **Not once the books are real.** A workspace that has generated an e-invoice or an e-way bill has
 *     filed with the GST system, and the law wants those records kept for years — its reset is refused,
 *     and support can export and close it instead.
 *   · The reset itself is one transaction: it finishes, or nothing changed.
 *
 * Due resets are run by the backup tick (src/app/api/backup/tick, `npm run db:backup -- --if-due`), the
 * same knock that takes the scheduled backups.
 */

export const RESET_WAIT_HOURS = 24;
export const RESET_SAFETY_COPY_DAYS = 30;
const HOUR = 3_600_000;

export type ResetBlocker = { key: "einvoices" | "ewaybills" | "restore" | "scheduled"; message: string };

/** What stops a reset being asked for now. */
export async function resetBlockers(): Promise<ResetBlocker[]> {
  const blockers: ResetBlocker[] = [];
  const [einvoices, ewaybills, scheduled, restoring] = await Promise.all([
    db.tradeDocument.count({ where: { irn: { not: null } } }),
    db.ewayBill.count({ where: { ewayBillNumber: { not: null } } }),
    db.workspaceReset.count({ where: { status: { in: ["SCHEDULED", "RUNNING"] } } }),
    restoreInProgress(),
  ]);
  if (einvoices > 0) blockers.push({ key: "einvoices", message: `${einvoices} e-invoice${einvoices === 1 ? " has" : "s have"} been generated here — filed with the GST system, so these records must be kept. Ask support to export and close the workspace instead.` });
  if (ewaybills > 0) blockers.push({ key: "ewaybills", message: `${ewaybills} e-way bill${ewaybills === 1 ? " has" : "s have"} been generated here — filed with the GST system, so these records must be kept. Ask support to export and close the workspace instead.` });
  if (scheduled > 0) blockers.push({ key: "scheduled", message: "A reset is already scheduled." });
  if (restoring) blockers.push({ key: "restore", message: "A restore is running." });
  return blockers;
}

/** Everybody who looks after backups — told when a reset is asked for, and may cancel it. */
async function admins(): Promise<{ id: string; name: string }[]> {
  const people = await db.user.findMany({ where: { active: true, ...PEOPLE_ONLY }, select: { id: true, name: true, isSuperAdmin: true } });
  const out: { id: string; name: string }[] = [];
  for (const p of people) if (p.isSuperAdmin || (await can(p.id, "backups.manage"))) out.push({ id: p.id, name: p.name });
  return out;
}

async function platformAudit(action: string, detail: Record<string, unknown>) {
  if (!controlConfigured()) return;
  try {
    const tenant = await currentTenant();
    if (tenant.source !== "control") return;
    await controlDb().platformAuditLog.create({ data: { actorKind: "SYSTEM", actor: "workspace-reset", action, tenantId: tenant.id, detail: detail as never } });
  } catch (err) {
    console.warn("[workspace-reset] the platform audit log could not be written", err instanceof Error ? err.message : err);
  }
}

/** A moment as the workspace reads its own clock. */
const when = async (d: Date) => (await workspaceClock()).dateTime(d);

export type ResetRequest = { confirm?: unknown } & IdentityProof;

/** The super admin asks for the reset: checked, then scheduled a day out, and every admin told. */
export async function requestWorkspaceReset(userId: string, input: ResetRequest): Promise<{ ok: true; runAfter: Date } | { ok: false; error: string; needsCode?: boolean }> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, isSuperAdmin: true } });
  if (!user?.isSuperAdmin) return { ok: false, error: "Only the workspace's super admin can reset it." };
  const tenant = await currentTenant();
  const typed = typeof input.confirm === "string" ? input.confirm.trim().toLowerCase() : "";
  if (typed !== tenant.slug.toLowerCase()) return { ok: false, error: `Type the workspace's address, ${tenant.slug}, to confirm.` };
  const blockers = await resetBlockers();
  if (blockers.length) return { ok: false, error: blockers[0]!.message };
  const proved = await confirmIdentity(user.id, input, "a workspace reset");
  if (!proved.ok) return proved;

  const runAfter = new Date(Date.now() + RESET_WAIT_HOURS * HOUR);
  const reset = await db.workspaceReset.create({ data: { requestedById: user.id, requestedByName: user.name, runAfter }, select: { id: true } });
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "WorkspaceReset", entityId: reset.id, entityLabel: `Workspace reset scheduled for ${await when(runAfter)}` });
  await platformAudit("workspace.reset.scheduled", { resetId: reset.id, by: user.name, runAfter: runAfter.toISOString() });
  for (const admin of await admins()) {
    await notifyUser({
      userId: admin.id,
      type: "SECURITY_ALERT",
      title: "The workspace is going to be reset",
      message: `${user.name} asked to reset this workspace. On ${await when(runAfter)} every record, setting and account except theirs will be removed (a copy is kept 30 days). If this wasn't meant, cancel it from Settings › Backups before then.`,
      link: "/settings/backups",
    });
  }
  return { ok: true, runAfter };
}

/** Any admin who looks after backups, or the super admin, calls it off — while it hasn't started. */
export async function cancelWorkspaceReset(userId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, isSuperAdmin: true } });
  if (!user || !(user.isSuperAdmin || (await can(user.id, "backups.manage")))) return { ok: false, error: "You can't cancel a reset." };
  const pending = await db.workspaceReset.findFirst({ where: { status: "SCHEDULED" }, select: { id: true } });
  if (!pending) return { ok: false, error: "No reset is scheduled — or it has already started." };
  const done = await db.workspaceReset.updateMany({ where: { id: pending.id, status: "SCHEDULED" }, data: { status: "CANCELLED", cancelledByName: user.name, cancelledAt: new Date() } });
  if (done.count === 0) return { ok: false, error: "The reset has already started." };
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "WorkspaceReset", entityId: pending.id, entityLabel: "Workspace reset cancelled" });
  await platformAudit("workspace.reset.cancelled", { resetId: pending.id, by: user.name });
  for (const admin of await admins()) {
    await notifyUser({ userId: admin.id, type: "SECURITY_ALERT", title: "The workspace reset was cancelled", message: `${user.name} cancelled the reset. Nothing was removed.`, link: "/settings/backups" });
  }
  return { ok: true };
}

export type ResetRun = { ran: false; reason: string } | { ran: true; ok: true; backup: string; tablesEmptied: number; usersRemoved: number } | { ran: true; ok: false; error: string };

/**
 * Runs the workspace's reset if one is due — from the backup tick, in the workspace in hand. Claimed by a
 * conditional update, so two ticks can't both run it. A failure leaves the data as it was (the reset is one
 * transaction, and nothing runs without its safety copy) and says why on the record.
 */
export async function runDueWorkspaceReset(now = new Date()): Promise<ResetRun> {
  let due;
  try {
    due = await db.workspaceReset.findFirst({ where: { status: "SCHEDULED", runAfter: { lte: now } }, orderBy: { runAfter: "asc" } });
  } catch {
    // A workspace not migrated yet has no such table — and so nothing scheduled.
    return { ran: false, reason: "no reset table yet" };
  }
  if (!due) return { ran: false, reason: "nothing due" };
  if (await restoreInProgress()) return { ran: false, reason: "a restore is running" };
  const claimed = await db.workspaceReset.updateMany({ where: { id: due.id, status: "SCHEDULED" }, data: { status: "RUNNING", startedAt: new Date() } });
  if (claimed.count === 0) return { ran: false, reason: "taken by another run" };

  const fail = async (error: string): Promise<ResetRun> => {
    await db.workspaceReset.update({ where: { id: due.id }, data: { status: "FAILED", finishedAt: new Date(), error } });
    await platformAudit("workspace.reset.failed", { resetId: due.id, error });
    for (const admin of await admins()) {
      await notifyUser({ userId: admin.id, type: "SECURITY_ALERT", title: "The workspace reset failed", message: `Nothing was removed: ${error}`, link: "/settings/backups" });
    }
    return { ran: true, ok: false, error };
  };

  const superAdmin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!superAdmin) return fail("The workspace has no super admin to keep.");

  const safety = await runBackup({
    kind: "FULL",
    triggeredById: due.requestedById,
    reason: "Before resetting the workspace",
    keepUntil: new Date(now.getTime() + RESET_SAFETY_COPY_DAYS * 24 * HOUR),
  });
  if (!safety.ok) return fail(`A safety copy couldn't be taken, so nothing was reset: ${safety.error}`);
  await db.workspaceReset.update({ where: { id: due.id }, data: { backupFilename: safety.filename } });

  let outcome;
  try {
    outcome = await resetAllData(await getTenantDb(), superAdmin.id);
  } catch (err) {
    return fail(`The reset failed and nothing was changed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // As the reset leaves things: the removed accounts' links and index rows, the Automation account
  // remembered, the terminals' routes.
  await workspaceAccountsReset("workspace-reset");
  await forgetAutomationUser();
  await resyncDeviceRoutes().catch(() => null);

  await db.workspaceReset.update({ where: { id: due.id }, data: { status: "DONE", finishedAt: new Date() } });
  // The audit log was just emptied with everything else; this is its first line.
  await recordAudit({
    userId: superAdmin.id,
    action: "DELETE",
    entityType: "Workspace",
    entityId: due.id,
    entityLabel: `Workspace reset — ${outcome.tablesEmptied} tables emptied, ${outcome.usersRemoved} users removed; the copy taken before is ${safety.filename}`,
  });
  await platformAudit("workspace.reset.done", { resetId: due.id, backup: safety.filename, ...outcome });
  await notifyUser({
    userId: superAdmin.id,
    type: "SECURITY_ALERT",
    title: "The workspace was reset",
    message: `Everything but your account was removed. The workspace as it was is kept 30 days as ${safety.filename} — restore it from Settings › Backups to undo the reset.`,
    link: "/settings/backups",
  });
  return { ran: true, ok: true, backup: safety.filename, ...outcome };
}

/** What the Backups page shows about resetting, for this person. Null when they may neither ask nor cancel. */
export async function workspaceResetState(userId: string) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { isSuperAdmin: true } });
  const isSuperAdmin = !!user?.isSuperAdmin;
  const canCancel = isSuperAdmin || (await can(userId, "backups.manage"));
  if (!canCancel) return null;
  let rows: Awaited<ReturnType<typeof db.workspaceReset.findMany>> = [];
  try {
    rows = await db.workspaceReset.findMany({ orderBy: { requestedAt: "desc" }, take: 5 });
  } catch {
    return null;
  }
  const scheduled = rows.find((r) => r.status === "SCHEDULED" || r.status === "RUNNING") ?? null;
  const last = rows.find((r) => r.status === "DONE" || r.status === "FAILED" || r.status === "CANCELLED") ?? null;
  const undo = last?.status === "DONE" && last.backupFilename ? await db.backup.findFirst({ where: { filename: last.backupFilename, status: "SUCCEEDED" }, select: { id: true, filename: true, sizeBytes: true, startedAt: true } }) : null;
  const tenant = await currentTenant();
  return {
    isSuperAdmin,
    canCancel,
    slug: tenant.slug,
    blockers: isSuperAdmin && !scheduled ? await resetBlockers() : [],
    overview: isSuperAdmin && !scheduled ? await resetOverview(await getTenantDb()) : null,
    scheduled: scheduled && { id: scheduled.id, status: scheduled.status, requestedByName: scheduled.requestedByName, requestedAt: scheduled.requestedAt, runAfter: scheduled.runAfter },
    last: last && { status: last.status, requestedByName: last.requestedByName, cancelledByName: last.cancelledByName, finishedAt: last.finishedAt ?? last.cancelledAt, error: last.error, backupFilename: last.backupFilename },
    undo: undo && { id: undo.id, filename: undo.filename, sizeBytes: undo.sizeBytes === null ? null : Number(undo.sizeBytes), startedAt: undo.startedAt },
  };
}
