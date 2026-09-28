"use server";

import { randomUUID } from "node:crypto";
import type { StaffRole } from "@wroffy/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import { applyStanding } from "@/lib/billing/lifecycle";
import { dayMonthYear } from "@/lib/console-shared/format";
import { parseDirectoryFilters, type DirectoryFilters, type RawParams } from "@/lib/console-shared/params";
import type { BulkItemResult, BulkResult, CsvExport } from "@/lib/console-shared/types";
import { BULK_CAPS, extendDays, previewApplyStanding, previewExtendTrial, type ApplyStandingPreview, type ExtendTrialPreview } from "@/lib/platform/bulk";
import { MANAGERS, SELLERS, WRITERS, clampInt, consoleAudit, consoleAuditMany, consoleRefusal, idList, revalidateConsole } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import { setTrialEnd } from "@/lib/platform/plans";
import { ConsoleRefused } from "@/lib/platform/refused";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";
import { workspacesCsv } from "@/lib/platform/workspace-directory";
import { forgetRegistry } from "@/lib/tenancy/registry";

/**
 * The workspace directory's actions: the CSV export, and the bulk actions on the rows selected —
 * billing rules applied, trials extended, tags added or removed — with a trial extended one at a
 * time from the directory's and the trials board's row menus.
 *
 * Every bulk action is previewed first; the action works its preview out again on the server and
 * refuses when it would now do more harm than the confirmation said (a hold or a close nobody saw).
 * Each workspace changed gets its own audit entry, and the batch one more, all with one `batchId`.
 * There is no bulk hold, reopen, close or plan change; bulk migration is not offered either.
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

/** The selected rows, checked: at least one, at most `cap`. */
function selection(ids: unknown, cap: number): string[] {
  const list = idList(ids, cap);
  if (list === null) throw new ConsoleRefused(`Choose at most ${cap} workspaces at a time.`);
  if (!list.length) throw new ConsoleRefused("Choose one or more workspaces.");
  return list;
}

function trialLength(days: unknown) {
  const n = extendDays(days);
  if (n === null) throw new ConsoleRefused("A trial is extended by 7, 14 or 30 days.");
  return n;
}

/**
 * Why one workspace of a batch failed, fit to show: a refusal's own words. Anything else is a fault,
 * not an answer — logged on the server, and the rest of the batch still goes ahead.
 */
function failure(err: unknown, what: string, tenantId: string): string {
  const refusal = consoleRefusal(err);
  if (refusal !== null) return refusal;
  console.error(`[console] ${what} failed for ${tenantId}`, err);
  return "It failed — see the server log.";
}

/** A selected id whose workspace has gone since the page was drawn. */
const gone = (tenantId: string): BulkItemResult => ({ tenantId, slug: "", ok: false, error: "That workspace no longer exists." });

function tally(batchId: string, items: BulkItemResult[]): BulkResult {
  return {
    batchId,
    ok: items.filter((i) => i.ok).length,
    skipped: items.filter((i) => !i.ok && i.skipped).length,
    failed: items.filter((i) => !i.ok && !i.skipped).length,
    items,
  };
}

// ─── Export ──────────────────────────────────────────────────────────────────────────────────────

/** Only the strings of a query, as the page's own parser would see them. */
function queryParams(input: unknown): RawParams {
  const raw: RawParams = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return raw;
  for (const [key, value] of Object.entries(input).slice(0, 40)) if (typeof value === "string") raw[key] = value.slice(0, 2000);
  return raw;
}

/**
 * The directory as filtered on screen — or just the rows selected — as CSV. Personal data in bulk,
 * so sellers only, and recorded.
 */
export async function consoleExportWorkspaces(params: Record<string, string>, ids?: string[]): Promise<ConsoleResult<CsvExport>> {
  return asStaff(SELLERS, async (staff) => {
    const f: DirectoryFilters = parseDirectoryFilters(queryParams(params));
    // "Export selected": the rows ticked, within the filters on screen.
    if (ids !== undefined && ids !== null) f.ids = selection(ids, 100);
    const out = await workspacesCsv(f);
    const filters = Object.fromEntries(Object.entries(f).filter(([key]) => key !== "ids" && key !== "page" && key !== "pageSize"));
    await consoleAudit(staff, "export.workspaces", { filters, rows: out.rows, selected: f.ids?.length ?? 0 });
    return out;
  });
}

// ─── Apply billing rules ─────────────────────────────────────────────────────────────────────────

export async function consolePreviewApplyStanding(ids: string[]): Promise<ConsoleResult<ApplyStandingPreview>> {
  return asStaff(MANAGERS, async () => previewApplyStanding(selection(ids, BULK_CAPS.applyStanding)));
}

const APPLIED: Record<"none" | "held" | "lifted" | "closed", string> = { none: "Nothing to do", held: "Held", lifted: "Hold lifted", closed: "Closed" };

/**
 * Each selected workspace's billing standing applied now, as the tick would. `expect` is what the
 * confirmation showed: when the preview, worked out again, would now hold or close more than that,
 * nothing is done. The installation's own workspace is passed over.
 */
export async function consoleBulkApplyStanding(ids: string[], expect: { held: number; closed: number }): Promise<ConsoleResult<BulkResult>> {
  return asStaff(MANAGERS, async (staff) => {
    const wanted = selection(ids, BULK_CAPS.applyStanding);
    const allowed = { held: clampInt(expect?.held, 0, BULK_CAPS.applyStanding, 0), closed: clampInt(expect?.closed, 0, BULK_CAPS.applyStanding, 0) };
    const now = new Date();
    const preview = await previewApplyStanding(wanted, now);
    if (preview.counts.held > allowed.held || preview.counts.closed > allowed.closed) throw new ConsoleRefused("The preview is out of date — look again.");

    const batchId = randomUUID();
    const planned = new Map(preview.items.map((i) => [i.tenantId, i]));
    const items: BulkItemResult[] = [];
    const audit: { action: string; detail: Record<string, unknown>; tenantId: string | null }[] = [];
    const done = { held: 0, lifted: 0, closed: 0 };
    for (const tenantId of wanted) {
      const item = planned.get(tenantId);
      if (!item) {
        items.push(gone(tenantId));
        continue;
      }
      if (item.skipped) {
        items.push({ tenantId, slug: item.slug, ok: false, skipped: true, outcome: "The installation's own workspace — billing never touches it." });
        continue;
      }
      try {
        const outcome = await applyStanding(tenantId, now);
        if (outcome.action !== "none") done[outcome.action] += 1;
        items.push({ tenantId, slug: outcome.slug, ok: true, outcome: APPLIED[outcome.action] });
        audit.push({ action: "billing.apply", detail: { standing: outcome.standing, action: outcome.action, batchId }, tenantId });
      } catch (err) {
        items.push({ tenantId, slug: item.slug, ok: false, error: failure(err, "applying billing rules", tenantId) });
      }
    }
    forgetRegistry();
    const result = tally(batchId, items);
    audit.push({ action: "bulk.apply-standing", detail: { batchId, count: wanted.length, ...done, failed: result.failed }, tenantId: null });
    await consoleAuditMany(staff, audit);
    revalidateConsole();
    return result;
  });
}

// ─── Extend trials ───────────────────────────────────────────────────────────────────────────────

export async function consolePreviewExtendTrial(ids: string[], days: number): Promise<ConsoleResult<ExtendTrialPreview>> {
  return asStaff(SELLERS, async () => {
    const length = trialLength(days);
    return previewExtendTrial(selection(ids, BULK_CAPS.extendTrial), length);
  });
}

/**
 * The selected workspaces' trials extended by `days`, each from its end (or from now, for one that
 * has ended), then its standing applied — which reopens one held because its trial ran out. A
 * workspace without a trial, closed, or paying at a gateway is passed over.
 */
export async function consoleBulkExtendTrial(ids: string[], days: number): Promise<ConsoleResult<BulkResult>> {
  return asStaff(SELLERS, async (staff) => {
    const length = trialLength(days);
    const wanted = selection(ids, BULK_CAPS.extendTrial);
    const now = new Date();
    const preview = await previewExtendTrial(wanted, length, now);
    const batchId = randomUUID();
    const planned = new Map(preview.items.map((i) => [i.tenantId, i]));
    const items: BulkItemResult[] = [];
    for (const tenantId of wanted) {
      const item = planned.get(tenantId);
      if (!item) {
        items.push(gone(tenantId));
        continue;
      }
      if (!item.eligible || !item.to || !item.from) {
        items.push({ tenantId, slug: item.slug, ok: false, skipped: true, outcome: item.why ?? "This workspace has no trial." });
        continue;
      }
      try {
        // The lib records `tenant.trial` for each, with the batch.
        await setTrialEnd(tenantId, item.to, `staff:${staff.id}`, { days: length, from: item.from.toISOString(), batchId });
        const outcome = await applyStanding(tenantId, now);
        items.push({ tenantId, slug: item.slug, ok: true, outcome: `Ends ${dayMonthYear(item.to)}${outcome.action === "lifted" ? " · hold lifted" : ""}` });
      } catch (err) {
        items.push({ tenantId, slug: item.slug, ok: false, error: failure(err, "extending a trial", tenantId) });
      }
    }
    const result = tally(batchId, items);
    await consoleAudit(staff, "bulk.trial-extend", { batchId, count: wanted.length, days: length, ok: result.ok, skipped: result.skipped, failed: result.failed });
    revalidateConsole();
    return result;
  });
}

/**
 * One workspace's trial extended by `days` — the end worked out here, never from the browser's
 * clock — then its standing applied. `action` is what that did ("lifted" when it reopened).
 */
export async function consoleExtendTrial(tenantId: string, days: number): Promise<ConsoleResult<{ endsAt: string; action: "none" | "held" | "lifted" | "closed" }>> {
  return asStaff(SELLERS, async (staff) => {
    const length = trialLength(days);
    const id = idList([tenantId], 1)?.[0];
    const now = new Date();
    const item = id ? (await previewExtendTrial([id], length, now)).items[0] : undefined;
    if (!id || !item) throw new ConsoleRefused("That workspace no longer exists.");
    if (!item.eligible || !item.to || !item.from) throw new ConsoleRefused(item.why ?? "This workspace has no trial.");
    await setTrialEnd(id, item.to, `staff:${staff.id}`, { days: length, from: item.from.toISOString() });
    const outcome = await applyStanding(id, now);
    revalidateConsole();
    return { endsAt: item.to.toISOString(), action: outcome.action };
  });
}

// ─── Tags ────────────────────────────────────────────────────────────────────────────────────────

const TAG = /^[a-z0-9][a-z0-9-]{0,23}$/;
const MAX_TAGS = 10;

/**
 * A tag added to (or removed from) each selected workspace, in one statement: one already tagged,
 * or already holding ten tags, is left as it is — the database's own limit is never hit.
 */
export async function consoleBulkTag(ids: string[], tag: string, add: boolean): Promise<ConsoleResult<BulkResult>> {
  return asStaff(WRITERS, async (staff) => {
    const label = String(tag ?? "").trim().toLowerCase();
    if (!TAG.test(label)) throw new ConsoleRefused("A tag is 1–24 lower-case letters, digits and dashes, starting with a letter or digit.");
    if (typeof add !== "boolean") throw new ConsoleRefused("Say whether to add the tag or remove it.");
    const wanted = selection(ids, BULK_CAPS.tag);
    const control = controlDb();
    const before = await control.tenant.findMany({ where: { id: { in: wanted } }, select: { id: true, slug: true, tags: true } });
    const known = before.map((t) => t.id);
    // Single statements, so two people tagging at once can neither duplicate a tag nor pass ten (MAX_TAGS).
    const changed = known.length
      ? add
        ? await control.$queryRaw<{ id: string }[]>`
            UPDATE "tenants" SET "tags" = array_append("tags", ${label}::text)
            WHERE "id" = ANY(${known}::text[]) AND NOT (${label}::text = ANY("tags")) AND cardinality("tags") < 10
            RETURNING "id"`
        : await control.$queryRaw<{ id: string }[]>`
            UPDATE "tenants" SET "tags" = array_remove("tags", ${label}::text)
            WHERE "id" = ANY(${known}::text[]) AND ${label}::text = ANY("tags")
            RETURNING "id"`
      : [];

    const batchId = randomUUID();
    const done = new Set(changed.map((r) => r.id));
    const byId = new Map(before.map((t) => [t.id, t]));
    const items = wanted.map((tenantId): BulkItemResult => {
      const t = byId.get(tenantId);
      if (!t) return gone(tenantId);
      if (done.has(tenantId)) return { tenantId, slug: t.slug, ok: true, outcome: add ? "Added" : "Removed" };
      const why = add ? (t.tags.includes(label) ? `Already tagged ${label}.` : t.tags.length >= MAX_TAGS ? `Already has ${MAX_TAGS} tags.` : "Left as it was.") : `Not tagged ${label}.`;
      return { tenantId, slug: t.slug, ok: false, skipped: true, outcome: why };
    });
    await consoleAuditMany(staff, [
      ...[...done].map((tenantId) => ({ action: "tenant.tags", detail: add ? { added: [label], batchId } : { removed: [label], batchId }, tenantId })),
      { action: "bulk.tag", detail: { batchId, tag: label, add, count: wanted.length, changed: done.size }, tenantId: null },
    ]);
    revalidateConsole();
    return tally(batchId, items);
  });
}
