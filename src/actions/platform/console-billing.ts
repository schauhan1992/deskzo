"use server";

import type { PlanKind, StaffRole } from "@wroffy/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import { GatewayError } from "@/lib/billing/gateway";
import { previewLifecycle, runBillingLifecycle } from "@/lib/billing/lifecycle";
import { resyncSubscription } from "@/lib/billing/reconcile";
import { reprocessBillingEvent } from "@/lib/billing/webhooks";
import { parseInvoiceFilters, type InvoiceFilters, type RawParams } from "@/lib/console-shared/params";
import { redactSecrets } from "@/lib/console-shared/redact";
import type { CsvExport } from "@/lib/console-shared/types";
import { billingEvent, type BillingEventDetail } from "@/lib/platform/billing-events";
import { MANAGERS, SELLERS, clampInt, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import { previewPlanSave, type PlanSavePreview } from "@/lib/platform/entitlement-preview";
import { withPlatformLease } from "@/lib/platform/fanout";
import type { PlanInput } from "@/lib/platform/plans";
import { ConsoleRefused } from "@/lib/platform/refused";
import { invoicesCsv } from "@/lib/platform/revenue";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";
import { recordTick } from "@/lib/platform/tick-summary";

/**
 * The console's billing operations: exporting invoices, looking into a webhook (and, for an owner,
 * its raw payload), replaying one that failed, reading a subscription back from its gateway, running
 * the billing lifecycle now rather than at the next tick, and previewing what saving a plan would do.
 *
 * Sellers (owner, admin, billing) for all of it, but the lifecycle run — managers — and the raw
 * payload and internal plans — owners. Every change is in the platform's audit log under the staff
 * member, once; reads are not, except an export and a raw payload.
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

/** A row's id as the browser sent it: a cuid-shaped string, or nothing. */
function recordId(input: unknown): string | null {
  const id = typeof input === "string" ? input.trim() : "";
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

/** The workspace an audit entry may point at — only one that still exists (an event's id is not a foreign key). */
async function existingTenant(tenantId: string | null): Promise<string | null> {
  if (!tenantId) return null;
  const tenant = await controlDb().tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
  return tenant?.id ?? null;
}

/** At most `n` slugs for an audit entry; the counts beside them say how many there were. */
const first = (slugs: string[], n = 50) => slugs.slice(0, n);

// ─── Invoices ────────────────────────────────────────────────────────────────────────────────────

/** The invoices list's filters, as the page's query string, to CSV — every matching invoice, up to 10,000. */
export async function consoleExportInvoices(params: Record<string, string>): Promise<ConsoleResult<CsvExport>> {
  return asStaff(SELLERS, async (staff) => {
    const raw: RawParams = {};
    if (params && typeof params === "object" && !Array.isArray(params)) {
      for (const [key, value] of Object.entries(params).slice(0, 40)) {
        if (typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key)) raw[key] = value.slice(0, 200);
      }
    }
    const filters = parseInvoiceFilters(raw);
    const out = await invoicesCsv(filters);
    // Every page is exported: the one on screen is not a filter.
    const asked: Partial<InvoiceFilters> = { ...filters };
    delete asked.page;
    await consoleAudit(staff, "export.invoices", { filters: asked, rows: out.rows });
    return out;
  });
}

// ─── Webhooks ────────────────────────────────────────────────────────────────────────────────────

/**
 * One webhook with its payload, personal fields replaced. `raw` shows it as the gateway sent it — an
 * owner's, and recorded, because it holds the customer's personal data.
 */
export async function consoleBillingEvent(id: string, raw?: boolean): Promise<ConsoleResult<BillingEventDetail>> {
  return asStaff(SELLERS, async (staff) => {
    const asRaw = raw === true;
    if (asRaw && staff.role !== "OWNER") throw new ConsoleRefused("Only an owner sees a webhook's payload unredacted.");
    const key = recordId(id);
    const event = key ? await billingEvent(key, { raw: asRaw }) : null;
    if (!event) throw new ConsoleRefused("That event no longer exists.");
    if (asRaw) await consoleAudit(staff, "billing.event.view-raw", { eventId: event.eventId, gateway: event.gateway, type: event.type });
    return event;
  });
}

/**
 * A webhook that was not processed, run again through the same handler from its stored payload —
 * one at a time, so a person sees each outcome. A processed one is refused: resync its subscription.
 */
export async function consoleReplayBillingEvent(id: string): Promise<ConsoleResult<{ ok: boolean; error: string | null }>> {
  return asStaff(SELLERS, async (staff) => {
    const key = recordId(id);
    const event = key ? await controlDb().billingEvent.findUnique({ where: { id: key }, select: { id: true, eventId: true, gateway: true, type: true } }) : null;
    if (!event) throw new ConsoleRefused("That event no longer exists.");
    const about = { eventId: event.eventId, gateway: event.gateway, type: event.type };
    let result: Awaited<ReturnType<typeof reprocessBillingEvent>>;
    try {
      result = await reprocessBillingEvent(event.id);
    } catch (err) {
      // The gateway could not be reached, or refused: the attempt is recorded on the event, and here.
      if (err instanceof GatewayError) {
        await consoleAudit(staff, "billing.event.replay", { ...about, ok: false, error: redactSecrets(err.message)?.slice(0, 300) ?? null });
        revalidateConsole();
      }
      throw err;
    }
    const error = redactSecrets(result.error);
    await consoleAudit(staff, "billing.event.replay", { ...about, ok: result.ok, ...(error ? { error: error.slice(0, 300) } : {}) }, await existingTenant(result.tenantId));
    revalidateConsole();
    return { ok: result.ok, error };
  });
}

// ─── Subscriptions ───────────────────────────────────────────────────────────────────────────────

/** A gateway subscription read back from its gateway now — for a webhook that never arrived. Its workspace's standing follows. */
export async function consoleResyncSubscription(subscriptionId: string): Promise<ConsoleResult<{ before: string; after: string }>> {
  return asStaff(SELLERS, async (staff) => {
    const id = recordId(subscriptionId);
    if (!id) throw new ConsoleRefused("That subscription no longer exists.");
    const r = await resyncSubscription(id);
    await consoleAudit(staff, "billing.resync", { subscriptionId: id, externalId: r.externalId, gateway: r.gateway, before: r.before, after: r.after }, r.tenantId);
    revalidateConsole();
    return { before: r.before, after: r.after };
  });
}

// ─── The billing lifecycle ───────────────────────────────────────────────────────────────────────

/** Who the billing lifecycle would hold, lift, close and remind if it ran now — nothing done. */
export async function consolePreviewLifecycle(): Promise<ConsoleResult<{ held: string[]; lifted: string[]; closed: string[]; remind: string[] }>> {
  return asStaff(MANAGERS, () => previewLifecycle());
}

/**
 * The billing lifecycle, now — what the hourly tick does, under the tick's own lease. `expect` is
 * what the preview the person confirmed would hold and close: if it would now do more, it is refused
 * to be previewed again, rather than holding workspaces nobody was shown.
 */
export async function consoleRunBillingLifecycle(expect: { held: number; closed: number }): Promise<ConsoleResult<{ held: string[]; lifted: string[]; closed: string[]; reminded: number }>> {
  return asStaff(MANAGERS, async (staff) => {
    const asked = (expect ?? null) as { held?: unknown; closed?: unknown } | null;
    const held = clampInt(asked?.held, 0, 1_000_000, -1);
    const closed = clampInt(asked?.closed, 0, 1_000_000, -1);
    if (held < 0 || closed < 0) throw new ConsoleRefused("Preview the run first, then confirm what it will do.");

    const preview = await previewLifecycle();
    if (preview.held.length > held || preview.closed.length > closed) {
      throw new ConsoleRefused(`It would now hold ${preview.held.length} and close ${preview.closed.length} — more than you confirmed. Preview it again.`);
    }

    const started = Date.now();
    const ran = await withPlatformLease("platform-tick", 30 * 60_000, async () => {
      const outcomes = await runBillingLifecycle();
      const done = {
        held: outcomes.filter((o) => o.action === "held").map((o) => o.slug),
        lifted: outcomes.filter((o) => o.action === "lifted").map((o) => o.slug),
        closed: outcomes.filter((o) => o.action === "closed").map((o) => o.slug),
        reminded: outcomes.filter((o) => o.reminded).map((o) => o.slug),
      };
      try {
        await recordTick({ ms: Date.now() - started, held: done.held, lifted: done.lifted, closed: done.closed, reminded: done.reminded.length, daily: null }, staff.id);
      } catch (err) {
        // The summary is for reading later; the run itself is done and audited below.
        console.error("[console] could not record the tick summary", err);
      }
      return done;
    });
    if (!ran.ran) throw new ConsoleRefused("The platform tick is running right now — it does the same.");

    const { held: h, lifted, closed: c, reminded } = ran.value;
    await consoleAudit(staff, "billing.lifecycle.run", {
      held: first(h),
      lifted: first(lifted),
      closed: first(c),
      reminded: first(reminded),
      counts: { held: h.length, lifted: lifted.length, closed: c.length, reminded: reminded.length },
    });
    revalidateConsole();
    return { held: h, lifted, closed: c, reminded: reminded.length };
  });
}

// ─── Plans ───────────────────────────────────────────────────────────────────────────────────────

/** A plan as the browser sent it, re-made from plain values — the save's own checks then apply to it. */
function planInput(input: unknown): PlanInput {
  const i = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const list = (v: unknown, cap: number) => (Array.isArray(v) ? v.slice(0, cap).map((x) => String(x)) : []);
  const limit = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
  return {
    key: String(i.key ?? "").slice(0, 200),
    name: String(i.name ?? "").slice(0, 200),
    kind: String(i.kind ?? "") as PlanKind,
    description: i.description === null || i.description === undefined ? null : String(i.description).slice(0, 2000),
    allModules: !!i.allModules,
    modules: list(i.modules, 500),
    countries: list(i.countries, 300),
    seats: limit(i.seats),
    copilotTokens: limit(i.copilotTokens),
    // Left out: the plan keeps its own — as the save does it.
    ...(i.customDomains === undefined ? {} : { customDomains: limit(i.customDomains) }),
    isDefault: !!i.isDefault,
    active: i.active !== false,
    sortOrder: Number.isInteger(i.sortOrder) ? (i.sortOrder as number) : 0,
  };
}

/** What saving a plan would change, and for which workspaces — nothing saved. An internal plan is an owner's. */
export async function consolePreviewPlanSave(input: PlanInput): Promise<ConsoleResult<PlanSavePreview>> {
  return asStaff(SELLERS, async (staff) => {
    const plan = planInput(input);
    if (plan.kind === "INTERNAL" && staff.role !== "OWNER") throw new ConsoleRefused("Only an owner makes or changes an internal plan.");
    return previewPlanSave(plan);
  });
}
