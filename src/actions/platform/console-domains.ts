"use server";

import type { StaffRole } from "@deskzo/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import { CloudflareError, cloudflareConfig, cloudflareConnection, type CloudflareConnection } from "@/lib/platform/cloudflare-hostnames";
import { ENTER, MANAGERS, OWNERS, cleanText, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import { addDomain, checkDomain, clearPrimary, makePrimary, removeDomain } from "@/lib/platform/domains";
import { ConsoleRefused } from "@/lib/platform/refused";
import { setSecret, setSetting } from "@/lib/platform/settings";
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
 *   Cloudflare                  the zone and API token their HTTPS certificates are issued through
 *                               (src/lib/platform/cloudflare-hostnames.ts): saved by owners only;
 *                               Check connection by owners and admins.
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

/** A zone's id is 32 hexadecimal characters; an API token, some 40 letters, digits, hyphens and underscores. */
const ZONE_ID = /^[a-f0-9]{32}$/;
const API_TOKEN = /^[A-Za-z0-9_-]{30,200}$/;

/**
 * Cloudflare for SaaS: the zone workspaces' addresses are custom hostnames of, and the API token Deskzo uses
 * there — sealed, never shown back. An empty field leaves a value as it is; `clearToken` disconnects. Owners
 * only. Both are checked before either is written.
 */
export async function consoleSaveCloudflare(input: { zoneId?: string; token?: string; clearToken?: boolean }): Promise<ConsoleResult<null>> {
  return asStaff(OWNERS, async (staff) => {
    const zoneId = typeof input?.zoneId === "string" ? input.zoneId.trim().toLowerCase() : "";
    const token = typeof input?.token === "string" ? input.token.trim() : "";
    const clearToken = input?.clearToken === true;
    if (zoneId && !ZONE_ID.test(zoneId)) throw new ConsoleRefused("A zone id is 32 letters and digits — copy it from the zone's Overview page in Cloudflare, under API.");
    if (token && !API_TOKEN.test(token)) throw new ConsoleRefused("That doesn't look like a Cloudflare API token — paste it exactly as Cloudflare showed it when it was made.");
    if (!zoneId && !token && !clearToken) throw new ConsoleRefused("Type the zone id or the token to save.");
    const changed: string[] = [];
    if (zoneId) {
      await setSetting("cloudflare.zoneId", zoneId, staff.id);
      changed.push("zone id");
    }
    if (clearToken) {
      await setSecret("cloudflare.apiToken", null, staff.id);
      changed.push("token removed");
    } else if (token) {
      await setSecret("cloudflare.apiToken", token, staff.id);
      changed.push("token");
    }
    await consoleAudit(staff, "domains.cloudflare", { changed });
    revalidateConsole();
    return null;
  });
}

/** Asks Cloudflare, with what is saved, where workspaces' own addresses' requests go. Owners and admins. */
export async function consoleCheckCloudflare(): Promise<ConsoleResult<CloudflareConnection>> {
  return asStaff(MANAGERS, async () => {
    const cfg = await cloudflareConfig();
    if (!cfg) throw new ConsoleRefused("Save the zone id and the API token first.");
    try {
      return await cloudflareConnection(cfg);
    } catch (err) {
      if (err instanceof CloudflareError) throw new ConsoleRefused(err.message);
      throw err;
    }
  });
}
