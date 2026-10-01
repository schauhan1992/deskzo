"use server";

import type { StaffRole } from "@deskzo/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import { ENTER, MANAGERS, OWNERS, cleanText, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import { addDomain, checkDomain, clearPrimary, makePrimary, removeDomain } from "@/lib/platform/domains";
import { ConsoleRefused } from "@/lib/platform/refused";
import { setSetting } from "@/lib/platform/settings";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";

/**
 * Workspace 360's Domains panel, and the platform switch that lets workspaces add custom domains
 * (src/lib/platform/domains.ts).
 *
 *   Add, Make primary, Remove   owners and admins (MANAGERS) — they change what a workspace is
 *                               reached at. Staff add whatever the switch says, for testing and
 *                               support; the workspace's allowance still applies (raise its custom-
 *                               domain limit to give more). Remove asks why.
 *   Check now                   owners, admins and support (ENTER): it asks DNS and moves the address
 *                               on, as the owner's own button does, at most every 30 seconds.
 *   domains.offered             owners only, like every platform setting.
 *
 * Every change is in the platform audit log under the staff member; `addedBy` is "staff:<email>".
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
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
}

const GONE = "That workspace no longer exists.";

function idOf(value: unknown, gone: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ConsoleRefused(gone);
  return id;
}

/** A workspace that is not closed — a closed one's addresses are gone with it. */
async function openTenant(tenantId: unknown): Promise<string> {
  const id = idOf(tenantId, GONE);
  const tenant = await controlDb().tenant.findUnique({ where: { id }, select: { status: true } });
  if (!tenant) throw new ConsoleRefused(GONE);
  if (tenant.status === "DEPROVISIONED") throw new ConsoleRefused("This workspace is closed.");
  return id;
}

/** An address for the workspace, waiting for its records. */
export async function consoleAddDomain(tenantId: string, host: string): Promise<ConsoleResult<{ id: string; host: string }>> {
  return asStaff(MANAGERS, async (staff) => {
    const id = await openTenant(tenantId);
    const row = await addDomain(id, cleanText(host, 300), `staff:${staff.email}`);
    await consoleAudit(staff, "tenant.domain.add", { host: row.host }, id);
    revalidateConsole();
    return { id: row.id, host: row.host };
  });
}

/** Its records looked up now — what the owner's Check now does. */
export async function consoleCheckDomain(tenantId: string, domainId: string): Promise<ConsoleResult<{ status: string; outcome: string; problems: string[] }>> {
  return asStaff(ENTER, async (staff) => {
    const id = idOf(tenantId, GONE);
    const check = await checkDomain(idOf(domainId, "That address no longer exists."), { tenantId: id, throttle: true, actor: `staff:${staff.id}` });
    await consoleAudit(staff, "tenant.domain.check", { host: check.domain?.host ?? null, outcome: check.outcome }, id);
    revalidateConsole();
    return { status: check.domain?.status ?? "GONE", outcome: check.outcome, problems: check.problems };
  });
}

/** Links in emails and documents use this live address. */
export async function consoleMakeDomainPrimary(tenantId: string, domainId: string): Promise<ConsoleResult<null>> {
  return asStaff(MANAGERS, async (staff) => {
    const id = await openTenant(tenantId);
    const row = await makePrimary(idOf(domainId, "That address no longer exists."), id);
    await consoleAudit(staff, "tenant.domain.primary", { host: row.host }, id);
    revalidateConsole();
    return null;
  });
}

/** Links go back to its own subdomain. */
export async function consoleClearDomainPrimary(tenantId: string): Promise<ConsoleResult<null>> {
  return asStaff(MANAGERS, async (staff) => {
    const id = await openTenant(tenantId);
    const was = await clearPrimary(id);
    if (!was) throw new ConsoleRefused("Its own address is the primary one already.");
    await consoleAudit(staff, "tenant.domain.primary", { host: null, was }, id);
    revalidateConsole();
    return null;
  });
}

/** It stops reaching the workspace at once. Says why — it is kept with the change. */
export async function consoleRemoveDomain(tenantId: string, domainId: string, reason: string): Promise<ConsoleResult<null>> {
  return asStaff(MANAGERS, async (staff) => {
    const id = idOf(tenantId, GONE);
    const why = cleanText(reason, 300);
    if (why.length < 5) throw new ConsoleRefused("Say why — at least 5 characters. It is kept with the change.");
    const row = await removeDomain(idOf(domainId, "That address no longer exists."), id);
    await consoleAudit(staff, "tenant.domain.remove", { host: row.host, kind: row.kind, status: row.status, wasPrimary: row.isPrimary, reason: why }, id);
    revalidateConsole();
    return null;
  });
}

/**
 * Whether workspace owners may add custom domains. Owners only. Turning it off adds nothing and
 * removes nothing: addresses already added keep working, and staff still add them from here.
 */
export async function consoleSetDomainsOffered(offered: boolean): Promise<ConsoleResult<null>> {
  return asStaff(OWNERS, async (staff) => {
    if (offered !== true && offered !== false) throw new ConsoleRefused("Choose on or off.");
    await setSetting("domains.offered", offered ? "1" : "0", staff.id);
    await consoleAudit(staff, "domains.settings", { offered });
    revalidateConsole();
    return null;
  });
}
