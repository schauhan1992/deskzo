"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { requireUser, viewAsContext } from "@/lib/session";
import { DomainRefused, addDomain, checkDomain, clearPrimary, makePrimary, removeDomain, workspaceDomains, type DomainView, type WorkspaceDomains } from "@/lib/platform/domains";
import { customDomainsOffered } from "@/lib/platform/settings";
import { currentTenant } from "@/lib/tenancy/resolve";
import type { ActionResult } from "@/actions/company";

/**
 * Settings › Domain — the workspace reached at an address of its own (src/lib/platform/domains.ts).
 * Its super admin's alone, as billing is: a member account, never while "viewing as" somebody.
 * Adding needs the platform to offer custom domains (`domains.offered`); what was added already can
 * be checked, made primary and removed whatever the switch says. Every change is in the workspace's
 * activity log; the page is rendered from `getDomainSettings`.
 */

async function owner(): Promise<{ ok: true; me: { id: string; name: string; email: string } } | { ok: false; error: string }> {
  const user = await requireUser();
  if (await viewAsContext()) return { ok: false, error: "Switch back to your own account first." };
  const me = await db.user.findUnique({ where: { id: user.id }, select: { id: true, name: true, email: true, isSuperAdmin: true, kind: true } });
  if (!me || !me.isSuperAdmin || me.kind !== "MEMBER") return { ok: false, error: "Only the workspace owner manages its custom domain." };
  return { ok: true, me: { id: me.id, name: me.name, email: me.email } };
}

/** The workspace, when it is one the control plane keeps — one from the environment has no addresses to add. */
async function controlTenant(): Promise<{ id: string } | null> {
  const tenant = await currentTenant();
  return tenant.source === "control" ? { id: tenant.id } : null;
}

const NOT_HERE = "Custom domains need the platform's control plane, which this installation does not use.";

const refusal = (err: unknown): { ok: false; error: string } | null => (err instanceof DomainRefused ? { ok: false, error: err.message } : null);

function done() {
  revalidatePath("/settings/domain");
  revalidatePath("/settings/security");
}

export type DomainSettingsView = WorkspaceDomains & {
  /** Whether owners may add custom domains on this platform yet. */
  offered: boolean;
  /** False for a workspace outside the control plane: nothing can be added. */
  available: boolean;
};

/** Everything the page shows — null for anybody but the owner (the page then says whose it is). */
export async function getDomainSettings(): Promise<DomainSettingsView | null> {
  const a = await owner();
  if (!a.ok) return null;
  const tenant = await controlTenant();
  if (!tenant) {
    const t = await currentTenant();
    return { ownHost: t.primaryHost, ownUrl: "", primaryHost: t.primaryHost, target: "", limit: 0, used: 0, canAdd: false, allowanceText: "", domains: [], offered: false, available: false };
  }
  const [view, offered] = await Promise.all([workspaceDomains(tenant.id), customDomainsOffered()]);
  return { ...view, offered, available: true };
}

/** An address of the workspace's own, waiting for its records. Refused while the platform does not offer them. */
export async function addCustomDomain(input: string): Promise<ActionResult<DomainView>> {
  const a = await owner();
  if (!a.ok) return a;
  const tenant = await controlTenant();
  if (!tenant) return { ok: false, error: NOT_HERE };
  if (!(await customDomainsOffered())) return { ok: false, error: "Custom domains aren't offered yet." };
  try {
    const row = await addDomain(tenant.id, String(input ?? "").slice(0, 2000), a.me.email);
    await recordAudit({ userId: a.me.id, action: "CREATE", entityType: "CustomDomain", entityId: row.id, entityLabel: `${row.host} added — waiting for its DNS records` });
    done();
    const view = (await workspaceDomains(tenant.id)).domains.find((d) => d.id === row.id);
    return view ? { ok: true, data: view } : { ok: false, error: "That address no longer exists." };
  } catch (err) {
    const r = refusal(err);
    if (r) return r;
    throw err;
  }
}

export type DomainCheckResult = { status: "PENDING" | "ACTIVE" | "BROKEN" | "GONE"; message: string };

/** Its DNS records looked up now — at most once every 30 seconds. Says what it found, in a sentence. */
export async function checkCustomDomain(id: string): Promise<ActionResult<DomainCheckResult>> {
  const a = await owner();
  if (!a.ok) return a;
  const tenant = await controlTenant();
  if (!tenant) return { ok: false, error: NOT_HERE };
  try {
    const check = await checkDomain(String(id ?? ""), { tenantId: tenant.id, throttle: true, actor: `workspace:${a.me.id}` });
    const host = check.domain?.host ?? "That address";
    const message =
      check.outcome === "taken"
        ? "Another workspace proved this address first, so it has been removed from this one."
        : check.outcome === "verified"
          ? `${host} is live — its records check out.`
          : check.outcome === "recovered"
            ? `${host} checks out again.`
            : check.passed
              ? `${host} checks out.`
              : `Not yet: ${check.problems.join("; ") || "the records could not be found"}.`;
    // A change in what is served is worth a line in the activity log; a check that changed nothing is not.
    if (check.domain && (check.outcome === "verified" || check.outcome === "recovered" || check.outcome === "stopped")) {
      await recordAudit({
        userId: a.me.id,
        action: "UPDATE",
        entityType: "CustomDomain",
        entityId: check.domain.id,
        entityLabel: check.outcome === "stopped" ? `${host} stopped — its records were not found` : `${host} verified — it now reaches the workspace`,
      });
    }
    done();
    return { ok: true, data: { status: check.domain?.status ?? "GONE", message } };
  } catch (err) {
    const r = refusal(err);
    if (r) return r;
    throw err;
  }
}

/** Links in emails and documents are built on this address from now on. Only a live one. */
export async function makeCustomDomainPrimary(id: string): Promise<ActionResult<null>> {
  const a = await owner();
  if (!a.ok) return a;
  const tenant = await controlTenant();
  if (!tenant) return { ok: false, error: NOT_HERE };
  try {
    const row = await makePrimary(String(id ?? ""), tenant.id);
    await recordAudit({ userId: a.me.id, action: "UPDATE", entityType: "CustomDomain", entityId: row.id, entityLabel: `${row.host} made the primary address` });
    done();
    return { ok: true, data: null };
  } catch (err) {
    const r = refusal(err);
    if (r) return r;
    throw err;
  }
}

/** Links go back to the workspace's own subdomain. */
export async function clearCustomDomainPrimary(): Promise<ActionResult<null>> {
  const a = await owner();
  if (!a.ok) return a;
  const tenant = await controlTenant();
  if (!tenant) return { ok: false, error: NOT_HERE };
  const was = await clearPrimary(tenant.id);
  if (was) await recordAudit({ userId: a.me.id, action: "UPDATE", entityType: "CustomDomain", entityId: tenant.id, entityLabel: `${was} is no longer the primary address` });
  done();
  return { ok: true, data: null };
}

/** It stops reaching the workspace at once. */
export async function removeCustomDomain(id: string): Promise<ActionResult<null>> {
  const a = await owner();
  if (!a.ok) return a;
  const tenant = await controlTenant();
  if (!tenant) return { ok: false, error: NOT_HERE };
  try {
    const row = await removeDomain(String(id ?? ""), tenant.id, { customOnly: true });
    await recordAudit({ userId: a.me.id, action: "DELETE", entityType: "CustomDomain", entityId: row.id, entityLabel: `${row.host} removed${row.isPrimary ? " — links use the workspace's own address again" : ""}` });
    done();
    return { ok: true, data: null };
  } catch (err) {
    const r = refusal(err);
    if (r) return r;
    throw err;
  }
}
