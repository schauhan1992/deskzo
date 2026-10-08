"use server";

import type { Prisma, RevenueScheduleKind, RevenueScheduleStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { canSeeCompany, viaCompanyScope } from "@/lib/authz/company-scope";
import { recordAudit } from "@/lib/audit";
import { requireModuleUser } from "@/lib/modules-access";
import { isMonthKey, lastCompletedMonth, monthLabel, round2, type MonthKey } from "@/lib/revenue/periods";
import { runRevenueRecognition, type RecognitionResult } from "@/lib/revenue/run";
import {
  approveRevenueSchedule,
  cancelRevenueSchedule,
  editRevenueSchedule,
  mayApproveSchedule,
  ScheduleRefusal,
  type SchedulePatch,
  type ScheduleApprovalVerdict,
} from "@/lib/revenue/schedules";
import {
  customerRevenue as customerRevenueOf,
  deferredTieOut,
  getSchedule as getScheduleDetail,
  listSchedules as listScheduleRows,
  rollForward as rollForwardOf,
  waterfall as waterfallOf,
  type CustomerRevenue,
  type RollForward,
  type ScheduleDetail,
  type ScheduleListRow,
  type Waterfall,
} from "@/lib/revenue/reports";
import {
  openingCandidates as openingCandidatesOf,
  postOpening as postOpeningEntry,
  previewOpening as previewOpeningLines,
  type OpeningCandidate,
  type OpeningLineInput,
  type OpeningPreviewLine,
} from "@/lib/revenue/opening";
import type { ActionResult } from "@/actions/company";

/**
 * Revenue & Close: revenue recognition (spec §3, owner decisions D1–D4).
 *
 * Every export is behind the `revenue_close` plan check. Reading needs `revenue.viewReports` (or
 * `revenue.manage`); anything that changes a schedule or posts an entry needs `revenue.manage`, which
 * is sensitive and not delegable. Lists and a customer's figures are limited to the customers the
 * caller may see, as receivables are (`viaCompanyScope`).
 *
 * The work itself is in src/lib/revenue — these check who is asking, record it, and refresh the pages.
 */

const PAGES = ["/accounting/revenue", "/accounting/revenue/waterfall", "/accounting/journal", "/accounting"];
const refresh = () => PAGES.forEach((p) => revalidatePath(p));

/** Somebody who may read revenue — or an error that says they may not. */
async function reader() {
  const user = await requireModuleUser("revenue_close");
  if (!(await can(user.id, "revenue.viewReports")) && !(await can(user.id, "revenue.manage"))) {
    throw new Error("You don't have permission to see revenue recognition.");
  }
  return user;
}

/** Somebody who may change schedules and post recognition, or `allowed: false`. */
async function manager() {
  const user = await requireModuleUser("revenue_close");
  return { user, allowed: await can(user.id, "revenue.manage") };
}

const NOT_MANAGER = "Changing revenue schedules and posting recognition needs Revenue & Close management.";

function failure(error: unknown, fallback: string): { ok: false; error: string } {
  if (error instanceof ScheduleRefusal) return { ok: false, error: error.message };
  return { ok: false, error: error instanceof Error ? error.message : fallback };
}

async function scope(userId: string): Promise<Prisma.RevenueScheduleWhereInput> {
  return (await viaCompanyScope(userId)) as Prisma.RevenueScheduleWhereInput;
}

/** "INV-0042 · Annual support" — how the audit log names a schedule. */
async function scheduleLabel(id: string): Promise<string> {
  const row = await db.revenueSchedule.findUnique({
    where: { id },
    select: { document: { select: { docNumber: true } }, line: { select: { name: true } }, company: { select: { name: true } } },
  });
  return [row?.document?.docNumber, row?.line?.name, row?.company.name].filter(Boolean).join(" · ") || id;
}

const money = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ─── Recognition ─────────────────────────────────────────────────────────────────────────────────

/**
 * "Recognise through <month>": posts every due month of every ACTIVE schedule, up to and including
 * `throughMonth`, which must be a month already over. One entry per month posted in; closed months
 * catch up in the first open one.
 */
export async function revenueRun(input: { throughMonth: string }): Promise<ActionResult<RecognitionResult>> {
  const { user, allowed } = await manager();
  if (!allowed) return { ok: false, error: NOT_MANAGER };
  const throughMonth = input?.throughMonth;
  if (!isMonthKey(throughMonth)) return { ok: false, error: "Choose the month to recognise through." };
  const last = lastCompletedMonth(new Date());
  if (throughMonth > last) {
    return { ok: false, error: `${monthLabel(throughMonth)} isn't over yet — recognise through ${monthLabel(last)} at the latest.` };
  }
  try {
    const result = await runRevenueRecognition({ throughMonth, actorId: user.id });
    // Each month's entry is in the audit log already (the run records it, for the nightly job too).
    if (result.months.length === 0) {
      await recordAudit({
        userId: user.id,
        action: "UPDATE",
        entityType: "RevenueSchedule",
        entityId: "run",
        entityLabel: `Ran revenue recognition through ${monthLabel(throughMonth)} — nothing was due`,
      });
    }
    refresh();
    return { ok: true, data: result };
  } catch (error) {
    return failure(error, "Could not run revenue recognition.");
  }
}

// ─── Schedules by hand ───────────────────────────────────────────────────────────────────────────

/**
 * Approves a schedule made or changed by hand (D2): somebody with `revenue.manage` other than its
 * maker. The super admin may approve their own, and the audit log says so in as many words.
 */
export async function approveSchedule(id: string): Promise<ActionResult<{ id: string; status: RevenueScheduleStatus; reason: ScheduleApprovalVerdict["reason"] }>> {
  const { user, allowed } = await manager();
  const me = await db.user.findUnique({ where: { id: user.id }, select: { isSuperAdmin: true } });
  if (!allowed && !me?.isSuperAdmin) return { ok: false, error: NOT_MANAGER };
  if (typeof id !== "string" || !id) return { ok: false, error: "Which schedule?" };
  try {
    const { verdict } = await db.$transaction((tx) =>
      approveRevenueSchedule(tx, { id, actor: { id: user.id, isSuperAdmin: !!me?.isSuperAdmin, canManage: allowed } }),
    );
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "RevenueSchedule",
      entityId: id,
      entityLabel:
        `Approved revenue schedule ${await scheduleLabel(id)}` +
        (verdict.reason === "super-admin-own" ? " — their own, as super admin" : ""),
    });
    refresh();
    return { ok: true, data: { id, status: "ACTIVE", reason: verdict.reason } };
  } catch (error) {
    return failure(error, "Could not approve that schedule.");
  }
}

export type EditScheduleResult =
  | { status: "confirm"; reclass: number; date: string; months: { month: MonthKey; amount: number }[] }
  | { status: "saved"; reclass: number; entryNumber: string | null; months: { month: MonthKey; amount: number }[] };

/**
 * Re-plans a schedule: `startDate`/`endDate` (yyyy-mm-dd), `amount`, `spreadEvenly`, `note`. Posted
 * months never change. The schedule then needs approving again (D2).
 *
 * A new amount moves the difference between Deferred Revenue and Sales now. That is an entry, so the
 * first call returns `status: "confirm"` with the figure and the date; call again with
 * `confirmReclass` set to that figure to make the change.
 */
export async function editSchedule(
  id: string,
  patch: SchedulePatch & { confirmReclass?: number },
): Promise<ActionResult<EditScheduleResult>> {
  const { user, allowed } = await manager();
  if (!allowed) return { ok: false, error: NOT_MANAGER };
  if (typeof id !== "string" || !id || !patch || typeof patch !== "object") return { ok: false, error: "Which schedule, and what change?" };
  const clean: SchedulePatch = {
    ...(patch.startDate !== undefined ? { startDate: String(patch.startDate) } : {}),
    ...(patch.endDate !== undefined ? { endDate: String(patch.endDate) } : {}),
    ...(patch.amount !== undefined ? { amount: Number(patch.amount) } : {}),
    ...(patch.spreadEvenly !== undefined ? { spreadEvenly: Boolean(patch.spreadEvenly) } : {}),
    ...(patch.note !== undefined ? { note: patch.note === null ? null : String(patch.note).slice(0, 1000) } : {}),
  };
  if (Object.keys(clean).length === 0) return { ok: false, error: "Nothing to change." };
  try {
    const before = await scheduleLabel(id);
    const outcome = await db.$transaction((tx) =>
      editRevenueSchedule(tx, {
        id,
        patch: clean,
        actorId: user.id,
        confirmReclass: patch.confirmReclass === undefined ? undefined : Number(patch.confirmReclass),
      }),
    );
    if (!outcome.done) {
      return { ok: true, data: { status: "confirm", reclass: outcome.reclass, date: outcome.date.toISOString(), months: outcome.months } };
    }
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "RevenueSchedule",
      entityId: id,
      entityLabel:
        `Changed revenue schedule ${before} (${Object.keys(clean).join(", ")})${outcome.state.status === "PENDING_APPROVAL" ? " — waiting for approval" : ""}` +
        (outcome.entry ? `; ${money(Math.abs(outcome.reclass))} moved ${outcome.reclass > 0 ? "to Sales" : "to Deferred Revenue"} in ${outcome.entry.entryNumber}` : ""),
    });
    refresh();
    return { ok: true, data: { status: "saved", reclass: outcome.reclass, entryNumber: outcome.entry?.entryNumber ?? null, months: outcome.months } };
  } catch (error) {
    return failure(error, "Could not change that schedule.");
  }
}

export type CancelScheduleResult =
  | { status: "confirm"; amount: number; date: string }
  | { status: "cancelled"; amount: number; entryNumber: string | null };

/**
 * Cancels a schedule: what it has left is recognised now, in one entry dated in the first open
 * period. The first call returns `status: "confirm"` with that figure; call again with `confirmAmount`
 * equal to it to cancel.
 */
export async function cancelSchedule(id: string, reason: string, confirmAmount?: number): Promise<ActionResult<CancelScheduleResult>> {
  const { user, allowed } = await manager();
  if (!allowed) return { ok: false, error: NOT_MANAGER };
  if (typeof id !== "string" || !id) return { ok: false, error: "Which schedule?" };
  const why = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
  if (!why) return { ok: false, error: "Say why it is being cancelled." };
  try {
    const label = await scheduleLabel(id);
    const outcome = await db.$transaction((tx) =>
      cancelRevenueSchedule(tx, { id, reason: why, actorId: user.id, confirmAmount: confirmAmount === undefined ? undefined : Number(confirmAmount) }),
    );
    if (!outcome.done) return { ok: true, data: { status: "confirm", amount: outcome.amount, date: outcome.date.toISOString() } };
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "RevenueSchedule",
      entityId: id,
      entityLabel: `Cancelled revenue schedule ${label} — ${money(outcome.amount)} recognised now${outcome.entry ? ` (${outcome.entry.entryNumber})` : ""}: ${why}`,
    });
    refresh();
    return { ok: true, data: { status: "cancelled", amount: outcome.amount, entryNumber: outcome.entry?.entryNumber ?? null } };
  } catch (error) {
    return failure(error, "Could not cancel that schedule.");
  }
}

// ─── Reading ─────────────────────────────────────────────────────────────────────────────────────

export type ScheduleListFilters = {
  status?: RevenueScheduleStatus;
  pendingApproval?: boolean;
  kind?: RevenueScheduleKind;
  companyId?: string;
  itemId?: string;
  documentId?: string;
  opening?: boolean;
  from?: MonthKey;
  to?: MonthKey;
  search?: string;
  take?: number;
  skip?: number;
};

/** The schedule list (spec §3.8), limited to the customers the caller may see. */
export async function listSchedules(filters?: ScheduleListFilters): Promise<{ rows: ScheduleListRow[]; total: number }> {
  const user = await reader();
  return listScheduleRows(db, { filters: filters ?? {}, scope: await scope(user.id) });
}

/**
 * One schedule, with what the caller may do to it. Null when it doesn't exist or its customer is
 * outside the caller's scope.
 */
export async function getSchedule(id: string): Promise<(ScheduleDetail & { viewer: { mayManage: boolean; mayApprove: ScheduleApprovalVerdict } }) | null> {
  const user = await reader();
  const detail = await getScheduleDetail(db, { id, scope: await scope(user.id) });
  if (!detail) return null;
  const [mayManage, me] = await Promise.all([
    can(user.id, "revenue.manage"),
    db.user.findUnique({ where: { id: user.id }, select: { isSuperAdmin: true } }),
  ]);
  return {
    ...detail,
    viewer: {
      mayManage,
      mayApprove: mayApproveSchedule({
        actor: { id: user.id, isSuperAdmin: !!me?.isSuperAdmin, canManage: mayManage },
        schedule: { status: detail.status, createdById: detail.createdById },
      }),
    },
  };
}

/** The deferred revenue roll-forward for a month, with the ledger's balance beside it. */
export async function rollForward(month: string): Promise<RollForward & { tieOut: { schedules: number; ledger: number; difference: number } }> {
  await reader();
  if (!isMonthKey(month)) throw new Error("Choose a month.");
  const [roll, tieOut] = await Promise.all([rollForwardOf(db, month), deferredTieOut(db)]);
  return { ...roll, tieOut };
}

/** The waterfall: revenue still to be recognised by customer or item, 12 or 24 months from now. */
export async function waterfall(params: { by: "customer" | "item"; months: 12 | 24 }): Promise<Waterfall> {
  const user = await reader();
  const by = params?.by === "item" ? "item" : "customer";
  const months = params?.months === 24 ? 24 : 12;
  return waterfallOf(db, { by, months, scope: await scope(user.id) });
}

/** A customer's revenue for the company page — refused for a company outside the caller's scope. */
export async function customerRevenue(companyId: string): Promise<CustomerRevenue | null> {
  const user = await reader();
  const company = await db.company.findUnique({ where: { id: companyId }, select: { ownerUserId: true, relationshipType: true } });
  if (!company || !(await canSeeCompany(user.id, company))) return null;
  return customerRevenueOf(db, { companyId });
}

// ─── Opening deferred revenue (D4) ───────────────────────────────────────────────────────────────

/** Invoices from the 24 months to `asAt` (yyyy-mm) with service or subscription lines and no schedule. */
export async function openingCandidates(input: { asAt: string }): Promise<ActionResult<OpeningCandidate[]>> {
  const { user, allowed } = await manager();
  if (!allowed) return { ok: false, error: NOT_MANAGER };
  try {
    const documentScope = (await viaCompanyScope(user.id)) as Prisma.TradeDocumentWhereInput;
    return { ok: true, data: await openingCandidatesOf(db, { asAt: input?.asAt, scope: documentScope }) };
  } catch (error) {
    return failure(error, "Could not list the invoices.");
  }
}

/** What each line would open with at the end of `asAt`: the unearned part, and its months. */
export async function previewOpening(input: { asAt: string; lines: OpeningLineInput[] }): Promise<ActionResult<{ asAt: MonthKey; lines: OpeningPreviewLine[]; total: number }>> {
  const { allowed } = await manager();
  if (!allowed) return { ok: false, error: NOT_MANAGER };
  try {
    return { ok: true, data: await previewOpeningLines(db, { asAt: input?.asAt, lines: sanitiseLines(input?.lines) }) };
  } catch (error) {
    return failure(error, "Could not work out the opening balance.");
  }
}

/**
 * Posts the opening: one adjusting entry at the end of `asAt` (which must be open) and a schedule
 * per line, each waiting for a second person's approval.
 */
export async function postOpening(input: { asAt: string; lines: OpeningLineInput[] }): Promise<ActionResult<{ entryNumber: string; schedules: number; total: number }>> {
  const { user, allowed } = await manager();
  if (!allowed) return { ok: false, error: NOT_MANAGER };
  try {
    const lines = sanitiseLines(input?.lines);
    const result = await db.$transaction((tx) => postOpeningEntry(tx, { asAt: input?.asAt, lines, actorId: user.id }), { timeout: 60_000 });
    await recordAudit({
      userId: user.id,
      action: "CREATE",
      entityType: "RevenueSchedule",
      entityId: result.entry.id,
      entityLabel: `Opened deferred revenue as at the end of ${monthLabel(input.asAt)}: ${money(result.total)} over ${result.scheduleIds.length} schedule${result.scheduleIds.length === 1 ? "" : "s"} (${result.entry.entryNumber}), waiting for approval`,
    });
    refresh();
    return { ok: true, data: { entryNumber: result.entry.entryNumber, schedules: result.scheduleIds.length, total: round2(result.total) } };
  } catch (error) {
    return failure(error, "Could not open deferred revenue.");
  }
}

function sanitiseLines(lines: unknown): OpeningLineInput[] {
  if (!Array.isArray(lines)) return [];
  return lines.slice(0, 500).map((l) => {
    const line = (l ?? {}) as Record<string, unknown>;
    return { lineId: String(line.lineId ?? ""), from: String(line.from ?? ""), to: String(line.to ?? "") };
  });
}
