"use server";

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import type { StaffRole } from "@wroffy/control-client";
import { gatewayLabel } from "@/lib/console-shared/labels";
import { isoDateOrUndefined } from "@/lib/console-shared/params";
import { controlDb } from "@/lib/platform/control-db";
import { ALL_ROLES, ENTER, MANAGERS, OWNERS, SELLERS, cleanText, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { deprovisionTenant, resumeTenant, suspendTenant } from "@/lib/platform/lifecycle";
import { giveTrialPlans, liveGatewaySubscription, savePlan, setLimitOverrides, setModuleOverride, setTrialEnd, setWorkspacePlans, type PlanInput } from "@/lib/platform/plans";
import { applyStanding } from "@/lib/billing/lifecycle";
import { addPlanPrice, retirePlanPrice } from "@/lib/billing/prices";
import { ConsoleRefused } from "@/lib/platform/refused";
import { SECRET_KEYS, setSecret, setSetting, type SecretKey } from "@/lib/platform/settings";
import { forgetRegistry } from "@/lib/tenancy/registry";
import { removePinApiKey, savePinApiKey, startPinSync, startWorldSync } from "@/lib/platform/reference-sync";
import { enterAsSupport } from "@/lib/platform/support";
import { StaffChangeRefused, createStaff, deactivateStaff, endStaffSessions, issuePasswordSetup, resetStaffTwoFactor, setStaffRole } from "@/lib/platform/staff";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";
import { migrateEverything, type MigrationSummary } from "@/lib/platform/tenant-migrations";

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
 *
 * Inputs come from a browser, so each is coerced again here whatever its type says. A refusal
 * (a library's own, a row that vanished meanwhile) comes back as `{ ok: false, error }` through
 * `consoleRefusal`; anything else is a bug and is thrown. New console actions live in their own files
 * beside this one — this one only keeps the ones it has always had.
 */

export type ConsoleResult<T = null> = { ok: true; data: T } | { ok: false; error: string };

async function asStaff<T>(roles: readonly StaffRole[], work: (staff: Staff) => Promise<T>): Promise<ConsoleResult<T>> {
  let staff: Staff;
  try {
    staff = await requireStaff(roles);
  } catch (err) {
    if (err instanceof StaffRefused) return { ok: false, error: err.message };
    throw err;
  }
  let data: T;
  try {
    data = await work(staff);
  } catch (err) {
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
  // Every action here changes something: every console page shows it at once, the nav badges included.
  revalidateConsole();
  return { ok: true, data };
}

/** A role from the browser: one of the five, or a refusal — never passed to the database unchecked. */
function roleOf(input: unknown): StaffRole {
  const role = ALL_ROLES.find((r) => r === input);
  if (!role) throw new ConsoleRefused("Choose a role.");
  return role;
}

// ─── Workspaces ─────────────────────────────────────────────────────────────────────────────────

/**
 * Held by staff: an open workspace, or one held for billing (which becomes a staff hold that paying
 * does not lift — the result says so). A workspace paying at a gateway needs its address typed too,
 * here as well as in the page, so a forged call cannot skip it.
 */
export async function consoleSuspend(tenantId: string, reason: string, typedSlug?: string) {
  return asStaff(MANAGERS, async (staff): Promise<{ replacedBillingHold: boolean }> => {
    const why = cleanText(reason, 300);
    if (why.length < 3) throw new ConsoleRefused("Say why — at least 3 characters.");
    const id = String(tenantId ?? "");
    const tenant = await controlDb().tenant.findUniqueOrThrow({ where: { id }, select: { slug: true, status: true, suspendedFor: true } });
    const billingHold = tenant.status === "SUSPENDED" && tenant.suspendedFor === "BILLING";
    if (tenant.status === "SUSPENDED" && !billingHold) throw new ConsoleRefused("It is held by staff already.");
    if (tenant.status !== "ACTIVE" && !billingHold) {
      throw new ConsoleRefused(
        tenant.status === "PROVISIONING"
          ? "It is still being set up — there is nothing to hold yet."
          : tenant.status === "MIGRATING"
            ? "It is held for a failed migration — migrate it again from the Migrations page."
            : "It is closed.",
      );
    }
    const gateway = await liveGatewaySubscription(id);
    if (gateway && String(typedSlug ?? "").trim() !== tenant.slug) throw new ConsoleRefused(`It pays through ${gatewayLabel(gateway.gateway)} — type ${tenant.slug} to hold it.`);
    await suspendTenant(id, `staff:${staff.id}`, why, "STAFF");
    return { replacedBillingHold: billingHold };
  });
}

export async function consoleResume(tenantId: string) {
  return asStaff(MANAGERS, (staff) => resumeTenant(String(tenantId ?? ""), `staff:${staff.id}`));
}

/** Typed confirmation: the workspace's own name, so nobody closes the wrong one by a slip. */
export async function consoleDeprovision(tenantId: string, typedSlug: string) {
  return asStaff(OWNERS, async (staff) => {
    const id = String(tenantId ?? "");
    const tenant = await controlDb().tenant.findUniqueOrThrow({ where: { id }, select: { slug: true } });
    if (String(typedSlug ?? "").trim() !== tenant.slug) throw new StaffChangeRefused(`Type ${tenant.slug} to close it.`);
    return deprovisionTenant(id, `staff:${staff.id}`);
  });
}

export async function consoleEnterAsSupport(tenantId: string) {
  return asStaff(ENTER, async (staff) => {
    const entered = await enterAsSupport(staff, String(tenantId ?? ""));
    if (!entered.ok) throw new StaffChangeRefused(entered.error);
    return { url: entered.url };
  });
}

/** What `migrateEverything` throws when the migrate lease is held — a run from the server, or another console's. */
const MIGRATION_BUSY = "Another migration run is in progress.";

/** One workspace brought to the latest schema now. Recorded once its outcome is known — a failure too, since it leaves the workspace held. */
export async function consoleMigrateWorkspace(slug: string) {
  return asStaff(MANAGERS, async (staff) => {
    const wanted = cleanText(slug, 64).toLowerCase();
    const tenant = wanted ? await controlDb().tenant.findUnique({ where: { slug: wanted }, select: { id: true, status: true } }) : null;
    if (!tenant) throw new ConsoleRefused("That no longer exists.");
    if (tenant.status !== "ACTIVE" && tenant.status !== "MIGRATING") throw new ConsoleRefused("That workspace is not one a migration covers.");
    let summary: MigrationSummary;
    try {
      summary = await migrateEverything({ only: wanted });
    } catch (err) {
      if (err instanceof Error && err.message === MIGRATION_BUSY) throw new ConsoleRefused("Another migration run is in progress — try again when it has finished.");
      throw err;
    }
    const outcome = summary.workspaces.find((w) => w.slug === wanted);
    if (!outcome) throw new ConsoleRefused("That workspace is not one a migration covers.");
    if (outcome.ok === "skipped") throw new ConsoleRefused("A migration of it is already running.");
    await consoleAudit(staff, "migrate.workspace", { slug: wanted, runId: summary.runId, ok: outcome.ok }, tenant.id);
    if (!outcome.ok) {
      // Refused, but something changed: the run is recorded and the workspace is held until one works.
      revalidateConsole();
      throw new ConsoleRefused(`It failed: ${outcome.error?.split("\n")[0] || "its output is on the Migrations page."}`);
    }
    return summary.runId;
  });
}

// ─── Provisioning ───────────────────────────────────────────────────────────────────────────────

const WORKER = path.join(process.cwd(), "scripts", "platform-worker.ts");
const TSX_CLI = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
function startWorker() {
  spawn(process.execPath, [TSX_CLI, WORKER, "--once"], { cwd: process.cwd(), detached: true, stdio: "ignore", env: process.env }).unref();
}

/** A failed setup queued again from its first step. Only a failed one: a running or finished setup is left alone. */
export async function consoleRetryJob(jobId: string) {
  return asStaff(MANAGERS, async (staff) => {
    const id = cleanText(jobId, 64);
    const control = controlDb();
    const job = id ? await control.provisioningJob.findUnique({ where: { id }, select: { tenantId: true, status: true } }) : null;
    if (!job) throw new ConsoleRefused("That no longer exists.");
    // Conditional, so two people pressing "Try again" at once queue it once.
    const retried = await control.provisioningJob.updateMany({
      where: { id, status: "FAILED" },
      data: { status: "PENDING", attempts: 0, runAfter: new Date(), error: null, step: "Waiting to start" },
    });
    if (retried.count === 0) throw new ConsoleRefused("Only a failed setup is tried again.");
    await consoleAudit(staff, "provision.retry", { jobId: id }, job.tenantId);
    startWorker();
    return null;
  });
}

export async function consoleTopUpWarmPool() {
  return asStaff(MANAGERS, async (staff) => {
    await consoleAudit(staff, "warm-pool.top-up", {});
    startWorker();
    return null;
  });
}

// ─── Invitations, terminals, reference data ─────────────────────────────────────────────────────

/** The code is shown once, to whoever made it; only its hash is kept. */
export async function consoleCreateInvite(input: { note: string; uses: number; days: number; planKey?: string | null }) {
  return asStaff(MANAGERS, async (staff) => {
    const code = randomBytes(9).toString("base64url");
    const days = Math.min(90, Math.max(1, Math.round(Number(input?.days) || 14)));
    const uses = Math.min(100, Math.max(1, Math.round(Number(input?.uses) || 1)));
    const note = cleanText(input?.note, 200) || null;
    const planKey = cleanText(input?.planKey, 64) || null;
    if (planKey) {
      const plan = await controlDb().plan.findUnique({ where: { key: planKey }, select: { active: true, kind: true } });
      if (!plan || !plan.active || plan.kind === "INTERNAL") throw new StaffChangeRefused("That plan is not one a new workspace can start on.");
    }
    await controlDb().signupInvite.create({
      data: {
        codeHash: createHash("sha256").update(code).digest("hex"),
        note,
        maxUses: uses,
        expiresAt: new Date(Date.now() + days * 86_400_000),
        createdBy: staff.id,
        planKey,
      },
      select: { codeHash: true },
    });
    await consoleAudit(staff, "invite.create", { note, days, planKey });
    return { code };
  });
}

/**
 * Its code stops working now. Only a live invitation is ended — an expired or used-up one keeps the
 * end it had. The audit entry names it by its hash's first eight characters, which is how the
 * Invitations page tells an ended invitation from an expired one.
 */
export async function consoleEndInvite(codeHash: string) {
  return asStaff(MANAGERS, async (staff) => {
    const hash = String(codeHash ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new ConsoleRefused("That no longer exists.");
    const control = controlDb();
    const invite = await control.signupInvite.findUnique({ where: { codeHash: hash }, select: { uses: true, maxUses: true } });
    if (!invite) throw new ConsoleRefused("That no longer exists.");
    if (invite.uses >= invite.maxUses) throw new ConsoleRefused("It is used up already — its code no longer works.");
    const now = new Date();
    const ended = await control.signupInvite.updateMany({ where: { codeHash: hash, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, data: { expiresAt: now } });
    if (ended.count === 0) throw new ConsoleRefused("It has ended already.");
    await consoleAudit(staff, "invite.end", { codeHashPrefix: hash.slice(0, 8) });
    return null;
  });
}

export async function consoleReleaseDevice(serial: string) {
  return asStaff(MANAGERS, async (staff) => {
    // An unknown serial is Prisma's P2025, which reads "That no longer exists."
    const route = await controlDb().biometricDeviceRoute.delete({ where: { serial: cleanText(serial, 128) }, select: { serial: true, tenantId: true } });
    await consoleAudit(staff, "device-route.release", { serial: route.serial }, route.tenantId);
    return null;
  });
}

export async function consoleSavePinKey(key: string) {
  return asStaff(MANAGERS, async (staff) => {
    const saved = await savePinApiKey(String(key ?? ""));
    if (!saved.ok) throw new StaffChangeRefused(saved.error);
    await consoleAudit(staff, "reference.pin-key.save", {});
    return null;
  });
}

export async function consoleRemovePinKey() {
  return asStaff(MANAGERS, async (staff) => {
    await removePinApiKey();
    await consoleAudit(staff, "reference.pin-key.remove", {});
    return null;
  });
}

export async function consoleStartSync(which: "pin" | "world") {
  return asStaff(MANAGERS, async (staff) => {
    if (which !== "pin" && which !== "world") throw new ConsoleRefused("Choose the PIN directory or the world places.");
    const started = which === "pin" ? await startPinSync(`staff:${staff.id}`) : await startWorldSync(`staff:${staff.id}`);
    if (!started.ok) throw new StaffChangeRefused(started.error);
    await consoleAudit(staff, `reference.${which}.sync`, {});
    return null;
  });
}

// ─── Plans ──────────────────────────────────────────────────────────────────────────────────────

/** Who sells: owners, admins and billing. An internal plan — never sold, everything free — is an owner's. */
export async function consoleSavePlan(input: PlanInput) {
  return asStaff(SELLERS, async (staff) => {
    if (!input || typeof input !== "object") throw new ConsoleRefused("Say what the plan is.");
    if (input.kind === "INTERNAL" && staff.role !== "OWNER") throw new StaffChangeRefused("Only an owner makes or changes an internal plan.");
    return savePlan(input, `staff:${staff.id}`);
  });
}

/** At most this many lines in one save — more than any workspace is ever on. */
const MAX_PLAN_ITEMS = 50;

export async function consoleSetWorkspacePlans(tenantId: string, items: { planKey: string; quantity: number }[]) {
  return asStaff(SELLERS, async (staff) => {
    const given: unknown[] = Array.isArray(items) ? items : [];
    if (given.length > MAX_PLAN_ITEMS) throw new ConsoleRefused(`Choose at most ${MAX_PLAN_ITEMS} plans.`);
    const list = given.map((item) => {
      const i = (item && typeof item === "object" ? item : {}) as { planKey?: unknown; quantity?: unknown };
      return { planKey: cleanText(i.planKey, 64), quantity: Number(i.quantity) };
    });
    const internal = list.length ? await controlDb().plan.count({ where: { key: { in: list.map((i) => i.planKey) }, kind: "INTERNAL" } }) : 0;
    if (internal && staff.role !== "OWNER") throw new StaffChangeRefused("Only an owner puts a workspace on an internal plan.");
    await setWorkspacePlans(String(tenantId ?? ""), list, `staff:${staff.id}`);
    return null;
  });
}

/** `granted`: true adds the module, false takes it away, null goes back to what the plans say. */
export async function consoleSetModuleOverride(tenantId: string, moduleKey: string, granted: boolean | null, reason: string) {
  return asStaff(MANAGERS, async (staff) => {
    if (granted !== null && typeof granted !== "boolean") throw new ConsoleRefused("Add it, take it away, or go back to what the plans say.");
    await setModuleOverride(String(tenantId ?? ""), cleanText(moduleKey, 64), granted, cleanText(reason, 300), staff.id);
    return null;
  });
}

export async function consoleSetLimitOverrides(tenantId: string, input: { seats: string | number | null; copilotTokens: string | number | null }) {
  return asStaff(SELLERS, async (staff) => {
    await setLimitOverrides(String(tenantId ?? ""), { seats: input?.seats ?? null, copilotTokens: input?.copilotTokens ?? null }, `staff:${staff.id}`);
    return null;
  });
}

// ─── Billing ────────────────────────────────────────────────────────────────────────────────────

/** A price for a plan, made at its gateway first. */
export async function consoleAddPrice(input: { planKey: string; gateway: "STRIPE" | "RAZORPAY"; currency: string; interval: "MONTH" | "YEAR"; amount: number; perSeat: boolean }) {
  return asStaff(SELLERS, async (staff) => {
    const gateway = input?.gateway;
    if (gateway !== "STRIPE" && gateway !== "RAZORPAY") throw new ConsoleRefused("Choose Stripe or Razorpay.");
    const interval = input?.interval;
    if (interval !== "MONTH" && interval !== "YEAR") throw new ConsoleRefused("Monthly or yearly.");
    return addPlanPrice(
      { planKey: cleanText(input.planKey, 64), gateway, currency: cleanText(input.currency, 8), interval, amount: Number(input.amount), perSeat: input.perSeat === true },
      `staff:${staff.id}`,
    );
  });
}

export async function consoleRetirePrice(priceId: string) {
  return asStaff(SELLERS, async (staff) => {
    await retirePlanPrice(cleanText(priceId, 64), `staff:${staff.id}`);
    return null;
  });
}

/** A key longer than this is not one — every gateway's is far shorter. */
const MAX_KEY_LENGTH = 500;

/**
 * The gateways' keys — typed in here, sealed, never shown back. An empty field leaves a key as it
 * is; `clear` removes one. Owners only: a key moves money. Every value is checked before any is
 * written, so a bad one leaves all of them as they were.
 */
export async function consoleSaveGatewayKeys(input: { values: Partial<Record<SecretKey, string>>; clear?: SecretKey[] }) {
  return asStaff(OWNERS, async (staff) => {
    const values: Partial<Record<string, unknown>> = input?.values && typeof input.values === "object" ? input.values : {};
    const clearing: unknown[] = Array.isArray(input?.clear) ? input.clear : [];
    if (clearing.some((key) => !(SECRET_KEYS as readonly unknown[]).includes(key))) throw new ConsoleRefused("Choose the keys to remove from the list.");
    const writes: { key: SecretKey; value: string | null }[] = [];
    for (const key of SECRET_KEYS) {
      if (clearing.includes(key)) {
        writes.push({ key, value: null });
        continue;
      }
      const raw = values[key];
      const value = typeof raw === "string" ? raw.trim() : "";
      if (!value) continue;
      if (value.length > MAX_KEY_LENGTH) throw new StaffChangeRefused("That key is too long to be one.");
      if (/\s/.test(value)) throw new ConsoleRefused("A key has no spaces in it — paste it exactly as the gateway shows it.");
      writes.push({ key, value });
    }
    if (writes.length === 0) throw new ConsoleRefused("Type a key to save, or choose one to remove.");
    for (const w of writes) await setSecret(w.key, w.value, staff.id);
    await consoleAudit(staff, "billing.keys", { changed: writes.map((w) => (w.value === null ? `${w.key} removed` : w.key)) });
    return null;
  });
}

/**
 * Whether every staff member must use an authenticator. Owners only, and recorded: turning it off
 * lets anybody with a staff password into the console.
 */
export async function consoleSetStaffTwoFactor(mode: "required" | "off") {
  return asStaff(OWNERS, async (staff) => {
    if (mode !== "required" && mode !== "off") throw new StaffChangeRefused("Required or off.");
    await setSetting("staff.twoFactor", mode, staff.id);
    await consoleAudit(staff, "staff.two-factor.policy", { mode });
    return null;
  });
}

/** Open signup, the trial's length, and whether ended workspaces are closed by themselves. Owners only. */
export async function consoleSaveBillingSettings(input: { signupOpen: boolean; trialDays: number; autoDeprovision: boolean }) {
  return asStaff(OWNERS, async (staff) => {
    const days = Math.round(Number(input?.trialDays));
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new StaffChangeRefused("A trial is 1 to 90 days.");
    const open = !!input?.signupOpen;
    const autoClose = !!input?.autoDeprovision;
    await setSetting("signup.open", open ? "1" : "0", staff.id);
    await setSetting("trial.days", String(days), staff.id);
    await setSetting("billing.autoDeprovision", autoClose ? "1" : "0", staff.id);
    await consoleAudit(staff, "billing.settings", { signupOpen: open, trialDays: days, autoDeprovision: autoClose });
    return null;
  });
}

/** The trial ends at the end of that day in India (23:59:59 IST). */
export async function consoleSetTrialEnd(tenantId: string, endsOn: string) {
  return asStaff(SELLERS, async (staff) => {
    const day = isoDateOrUndefined(String(endsOn ?? ""));
    const date = day ? new Date(`${day}T23:59:59+05:30`) : null;
    if (!date || Number.isNaN(date.getTime())) throw new StaffChangeRefused("Give the date the trial ends.");
    const id = String(tenantId ?? "");
    await setTrialEnd(id, date, `staff:${staff.id}`);
    await applyStanding(id);
    return null;
  });
}

/** Its trial's plans kept without charge — a pilot, a partner. Billing leaves it alone after. */
export async function consoleGiveTrialPlans(tenantId: string) {
  return asStaff(MANAGERS, async (staff) => {
    const id = String(tenantId ?? "");
    await giveTrialPlans(id, `staff:${staff.id}`);
    await applyStanding(id);
    return null;
  });
}

/** Its standing applied now, rather than at the next tick. */
export async function consoleApplyStanding(tenantId: string) {
  return asStaff(MANAGERS, async (staff) => {
    const id = String(tenantId ?? "");
    const outcome = await applyStanding(id);
    forgetRegistry();
    await consoleAudit(staff, "billing.apply", { standing: outcome.standing, action: outcome.action }, id);
    return outcome.action;
  });
}

// ─── Staff (owners only) ────────────────────────────────────────────────────────────────────────

export async function consoleAddStaff(input: { email: string; name: string; role: StaffRole }) {
  return asStaff(OWNERS, async (staff) => {
    const role = roleOf(input?.role);
    return createStaff({ email: String(input?.email ?? "").slice(0, 254), name: cleanText(input?.name, 100), role }, staff.id);
  });
}

export async function consoleSetStaffRole(userId: string, role: StaffRole) {
  return asStaff(OWNERS, async (staff) => setStaffRole(String(userId ?? ""), roleOf(role), staff.id));
}

export async function consoleDeactivateStaff(userId: string) {
  return asStaff(OWNERS, async (staff) => {
    const id = String(userId ?? "");
    if (id === staff.id) throw new StaffChangeRefused("You can't switch yourself off.");
    return deactivateStaff(id, staff.id);
  });
}

export async function consoleEndStaffSessions(userId: string) {
  return asStaff(OWNERS, (staff) => endStaffSessions(String(userId ?? ""), staff.id));
}

export async function consoleResetStaffTwoFactor(userId: string) {
  return asStaff(OWNERS, (staff) => resetStaffTwoFactor(String(userId ?? ""), staff.id));
}

/** A new one-time password link, for a forgotten password. */
export async function consoleNewSetupLink(userId: string) {
  return asStaff(OWNERS, async (staff) => {
    const id = String(userId ?? "");
    const url = await issuePasswordSetup(id);
    await consoleAudit(staff, "staff.setup-link", { userId: id });
    return { url };
  });
}
