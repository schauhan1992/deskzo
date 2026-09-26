"use server";

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import type { StaffRole } from "@wroffy/control-client";
import { controlDb } from "@/lib/platform/control-db";
import { LifecycleRefused, deprovisionTenant, resumeTenant, suspendTenant } from "@/lib/platform/lifecycle";
import { PlanRefused, savePlan, setLimitOverrides, setModuleOverride, setWorkspacePlans, type PlanInput } from "@/lib/platform/plans";
import { removePinApiKey, savePinApiKey, startPinSync, startWorldSync } from "@/lib/platform/reference-sync";
import { enterAsSupport } from "@/lib/platform/support";
import { StaffChangeRefused, createStaff, deactivateStaff, endStaffSessions, issuePasswordSetup, resetStaffTwoFactor, setStaffRole } from "@/lib/platform/staff";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";
import { migrateEverything } from "@/lib/platform/tenant-migrations";

/**
 * What staff can do from the console. Every action starts with `requireStaff` and the roles allowed —
 *
 *   OWNER      everything, and the only one who manages staff or closes a workspace;
 *   ADMIN      workspaces held and reopened, jobs, migrations, invitations, terminals, reference data;
 *   SUPPORT    into a workspace on its super admin's grant;
 *   BILLING    plans, and which plans a workspace is on (and invoices, when billing arrives);
 *   READONLY   nothing here — the console's pages only.
 *
 * — and everything that changes something is in the platform's audit log, under the staff member.
 */

export type ConsoleResult<T = null> = { ok: true; data: T } | { ok: false; error: string };

const MANAGERS: readonly StaffRole[] = ["OWNER", "ADMIN"];

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
    if (err instanceof StaffChangeRefused || err instanceof LifecycleRefused || err instanceof PlanRefused) return { ok: false, error: err.message };
    throw err;
  }
}

const audit = (staff: Staff, action: string, detail: Record<string, unknown>, tenantId?: string) =>
  controlDb().platformAuditLog.create({ data: { actorKind: "STAFF", actor: staff.id, action, tenantId: tenantId ?? null, detail: detail as never } });

// ─── Workspaces ─────────────────────────────────────────────────────────────────────────────────

export async function consoleSuspend(tenantId: string, reason: string) {
  return asStaff(MANAGERS, (staff) => suspendTenant(String(tenantId), `staff:${staff.id}`, String(reason ?? "").slice(0, 300) || "held from the console"));
}

export async function consoleResume(tenantId: string) {
  return asStaff(MANAGERS, (staff) => resumeTenant(String(tenantId), `staff:${staff.id}`));
}

/** Typed confirmation: the workspace's own name, so nobody closes the wrong one by a slip. */
export async function consoleDeprovision(tenantId: string, typedSlug: string) {
  return asStaff(["OWNER"], async (staff) => {
    const tenant = await controlDb().tenant.findUniqueOrThrow({ where: { id: String(tenantId) }, select: { slug: true } });
    if (String(typedSlug ?? "").trim() !== tenant.slug) throw new StaffChangeRefused(`Type ${tenant.slug} to close it.`);
    return deprovisionTenant(String(tenantId), `staff:${staff.id}`);
  });
}

export async function consoleEnterAsSupport(tenantId: string) {
  return asStaff(["OWNER", "ADMIN", "SUPPORT"], async (staff) => {
    const entered = await enterAsSupport(staff, String(tenantId));
    if (!entered.ok) throw new StaffChangeRefused(entered.error);
    return { url: entered.url };
  });
}

export async function consoleMigrateWorkspace(slug: string) {
  return asStaff(MANAGERS, async (staff) => {
    const summary = await migrateEverything({ only: String(slug) });
    await audit(staff, "migrate.workspace", { slug, runId: summary.runId });
    const outcome = summary.workspaces.find((w) => w.slug === slug);
    if (!outcome) throw new StaffChangeRefused("That workspace is not one a migration covers.");
    if (outcome.ok !== true) throw new StaffChangeRefused(outcome.ok === "skipped" ? "A migration of it is already running." : `It failed: ${outcome.error?.split("\n")[0]}`);
    return summary.runId;
  });
}

// ─── Provisioning ───────────────────────────────────────────────────────────────────────────────

const WORKER = path.join(process.cwd(), "scripts", "platform-worker.ts");
const TSX_CLI = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
function startWorker() {
  spawn(process.execPath, [TSX_CLI, WORKER, "--once"], { cwd: process.cwd(), detached: true, stdio: "ignore", env: process.env }).unref();
}

export async function consoleRetryJob(jobId: string) {
  return asStaff(MANAGERS, async (staff) => {
    const job = await controlDb().provisioningJob.update({ where: { id: String(jobId) }, data: { status: "PENDING", attempts: 0, runAfter: new Date(), error: null, step: "Waiting to start" } });
    await audit(staff, "provision.retry", { jobId }, job.tenantId);
    startWorker();
    return null;
  });
}

export async function consoleTopUpWarmPool() {
  return asStaff(MANAGERS, async (staff) => {
    await audit(staff, "warm-pool.top-up", {});
    startWorker();
    return null;
  });
}

// ─── Invitations, terminals, reference data ─────────────────────────────────────────────────────

/** The code is shown once, to whoever made it; only its hash is kept. */
export async function consoleCreateInvite(input: { note: string; uses: number; days: number; planKey?: string | null }) {
  return asStaff(MANAGERS, async (staff) => {
    const code = randomBytes(9).toString("base64url");
    const days = Math.min(90, Math.max(1, Math.round(Number(input.days) || 14)));
    const planKey = input.planKey ? String(input.planKey) : null;
    if (planKey) {
      const plan = await controlDb().plan.findUnique({ where: { key: planKey }, select: { active: true, kind: true } });
      if (!plan || !plan.active || plan.kind === "INTERNAL") throw new StaffChangeRefused("That plan is not one a new workspace can start on.");
    }
    await controlDb().signupInvite.create({
      data: {
        codeHash: createHash("sha256").update(code).digest("hex"),
        note: String(input.note ?? "").slice(0, 200) || null,
        maxUses: Math.min(100, Math.max(1, Math.round(Number(input.uses) || 1))),
        expiresAt: new Date(Date.now() + days * 86_400_000),
        createdBy: staff.id,
        planKey,
      },
    });
    await audit(staff, "invite.create", { note: input.note, days, planKey });
    return { code };
  });
}

export async function consoleEndInvite(codeHash: string) {
  return asStaff(MANAGERS, async (staff) => {
    await controlDb().signupInvite.update({ where: { codeHash: String(codeHash) }, data: { expiresAt: new Date() } });
    await audit(staff, "invite.end", {});
    return null;
  });
}

export async function consoleReleaseDevice(serial: string) {
  return asStaff(MANAGERS, async (staff) => {
    const route = await controlDb().biometricDeviceRoute.delete({ where: { serial: String(serial) } });
    await audit(staff, "device-route.release", { serial }, route.tenantId);
    return null;
  });
}

export async function consoleSavePinKey(key: string) {
  return asStaff(MANAGERS, async (staff) => {
    const saved = await savePinApiKey(key);
    if (!saved.ok) throw new StaffChangeRefused(saved.error);
    await audit(staff, "reference.pin-key.save", {});
    return null;
  });
}

export async function consoleRemovePinKey() {
  return asStaff(MANAGERS, async (staff) => {
    await removePinApiKey();
    await audit(staff, "reference.pin-key.remove", {});
    return null;
  });
}

export async function consoleStartSync(which: "pin" | "world") {
  return asStaff(MANAGERS, async (staff) => {
    const started = which === "pin" ? await startPinSync(`staff:${staff.id}`) : await startWorldSync(`staff:${staff.id}`);
    if (!started.ok) throw new StaffChangeRefused(started.error);
    await audit(staff, `reference.${which}.sync`, {});
    return null;
  });
}

// ─── Plans ──────────────────────────────────────────────────────────────────────────────────────

/** Who sells: owners, admins and billing. An internal plan — never sold, everything free — is an owner's. */
const SELLERS: readonly StaffRole[] = ["OWNER", "ADMIN", "BILLING"];

export async function consoleSavePlan(input: PlanInput) {
  return asStaff(SELLERS, async (staff) => {
    if (input.kind === "INTERNAL" && staff.role !== "OWNER") throw new StaffChangeRefused("Only an owner makes or changes an internal plan.");
    return savePlan(input, `staff:${staff.id}`);
  });
}

export async function consoleSetWorkspacePlans(tenantId: string, items: { planKey: string; quantity: number }[]) {
  return asStaff(SELLERS, async (staff) => {
    const keys = (Array.isArray(items) ? items : []).map((i) => String(i.planKey));
    const internal = await controlDb().plan.count({ where: { key: { in: keys }, kind: "INTERNAL" } });
    if (internal && staff.role !== "OWNER") throw new StaffChangeRefused("Only an owner puts a workspace on an internal plan.");
    await setWorkspacePlans(String(tenantId), Array.isArray(items) ? items : [], `staff:${staff.id}`);
    return null;
  });
}

/** `granted`: true adds the module, false takes it away, null goes back to what the plans say. */
export async function consoleSetModuleOverride(tenantId: string, moduleKey: string, granted: boolean | null, reason: string) {
  return asStaff(MANAGERS, async (staff) => {
    await setModuleOverride(String(tenantId), String(moduleKey), granted === null ? null : !!granted, String(reason ?? ""), staff.id);
    return null;
  });
}

export async function consoleSetLimitOverrides(tenantId: string, input: { seats: string | number | null; copilotTokens: string | number | null }) {
  return asStaff(SELLERS, async (staff) => {
    await setLimitOverrides(String(tenantId), input ?? { seats: null, copilotTokens: null }, `staff:${staff.id}`);
    return null;
  });
}

// ─── Staff (owners only) ────────────────────────────────────────────────────────────────────────

export async function consoleAddStaff(input: { email: string; name: string; role: StaffRole }) {
  return asStaff(["OWNER"], (staff) => createStaff(input, staff.id));
}

export async function consoleSetStaffRole(userId: string, role: StaffRole) {
  return asStaff(["OWNER"], (staff) => setStaffRole(String(userId), role, staff.id));
}

export async function consoleDeactivateStaff(userId: string) {
  return asStaff(["OWNER"], async (staff) => {
    if (userId === staff.id) throw new StaffChangeRefused("You can't switch yourself off.");
    return deactivateStaff(String(userId), staff.id);
  });
}

export async function consoleEndStaffSessions(userId: string) {
  return asStaff(["OWNER"], (staff) => endStaffSessions(String(userId), staff.id));
}

export async function consoleResetStaffTwoFactor(userId: string) {
  return asStaff(["OWNER"], (staff) => resetStaffTwoFactor(String(userId), staff.id));
}

/** A new one-time password link, for a forgotten password. */
export async function consoleNewSetupLink(userId: string) {
  return asStaff(["OWNER"], async (staff) => {
    const url = await issuePasswordSetup(String(userId));
    await audit(staff, "staff.setup-link", { userId });
    return { url };
  });
}
