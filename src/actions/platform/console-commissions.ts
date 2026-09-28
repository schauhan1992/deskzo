"use server";

import type { StaffRole } from "@wroffy/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import type { RawParams } from "@/lib/console-shared/params";
import { parseCommissionFilters, parseReportFilters, reportRange } from "@/lib/console-shared/partner-params";
import { PAYERS } from "@/lib/console-shared/roles";
import type { CsvExport } from "@/lib/console-shared/types";
import { addAdjustment, accrueCommissions, voidCommission, type AccrualRun } from "@/lib/partners/commission";
import { commissionsCsv, partnerReportCsv, statementCsvById } from "@/lib/partners/commission-data";
import { partnerRefusal } from "@/lib/partners/guard";
import { revealPayout, setPayout, type PayoutDetails } from "@/lib/partners/payout";
import { partnerIdBySlug } from "@/lib/partners/registry";
import { approveStatement, generateStatements, markStatementPaid, voidStatement } from "@/lib/partners/statements";
import { PartnerRefused, type PayoutInput, type PayoutMask, type TaxLineInput } from "@/lib/partners/types";
import { SELLERS, cleanText, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";

/**
 * The console's partner money (spec §9.4): bank details, commission entries, the commission run,
 * statements and the money exports.
 *
 *   PAYERS (OWNER, BILLING)   money that leaves the platform: revealing and setting a partner's bank
 *                             details; approving, paying and voiding statements
 *   SELLERS                   voiding an entry, adding an adjustment, running commission now,
 *                             generating statements, the commission, statement and report CSVs
 *
 * `consoleRevealPayout` is the one place a partner's full bank details ever leave the server — to
 * OWNER or BILLING, one partner at a time, recorded in both audit logs (the partner sees it too).
 * Nothing else returns them; `consoleSetPayout` answers with the mask alone.
 *
 * Each change goes through the partner library (which checks everything again and writes the
 * partner's own log), then writes the platform audit exactly once, naming the partner by slug
 * (`detail.partner`), and refreshes the console. The detail never holds bank details, codes, hashes
 * or an adjustment's note.
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
    // Every engine and partner-library refusal is a PartnerRefused.
    const partner = partnerRefusal(err);
    if (partner) return partner;
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
}

// ─── Inputs, re-coerced (the libraries check them again, in full) ────────────────────────────────

const id = (v: unknown) => cleanText(v, 40);
const optional = (v: unknown, max: number) => (v === null || v === undefined ? null : cleanText(v, max));
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A whole number of minor units as typed, for the library to check; NaN for anything else (refused there), null for nothing. */
function minorUnits(v: unknown): number | null {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
  if (typeof v === "number") return v;
  return typeof v === "string" && /^\s*-?\d{1,13}\s*$/.test(v) ? Number(v.trim()) : NaN;
}

function payoutInput(v: unknown): PayoutInput {
  const x = obj(v);
  return {
    accountHolder: cleanText(x.accountHolder, 200),
    bankName: cleanText(x.bankName, 200),
    country: cleanText(x.country, 4),
    currency: cleanText(x.currency, 8),
    accountNumber: optional(x.accountNumber, 60),
    ifsc: optional(x.ifsc, 20),
    iban: optional(x.iban, 60),
    swift: optional(x.swift, 20),
    routingNumber: optional(x.routingNumber, 30),
    note: optional(x.note, 300),
  };
}

function taxLinesInput(v: unknown): TaxLineInput[] | null {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) throw new PartnerRefused("Tax lines are a list.");
  if (v.length > 6) throw new PartnerRefused("A statement has at most 6 tax lines.");
  return v.map((line) => {
    const x = obj(line);
    const amount = minorUnits(x.amount);
    return { label: cleanText(x.label, 80), kind: cleanText(x.kind, 10).toUpperCase() as TaxLineInput["kind"], rate: optional(x.rate, 12), amount };
  });
}

/** The page's query string, for an export: strings only, sensible keys, cut. */
function rawParams(params: unknown): RawParams {
  const raw: RawParams = {};
  for (const [key, value] of Object.entries(obj(params)).slice(0, 40)) {
    if (typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key)) raw[key] = value.slice(0, 200);
  }
  return raw;
}

async function slugOf(partnerId: string): Promise<string> {
  const row = partnerId ? await controlDb().partner.findUnique({ where: { id: partnerId }, select: { slug: true } }) : null;
  if (!row) throw new PartnerRefused("That partner no longer exists.");
  return row.slug;
}

// ─── Bank details (PAYERS) ───────────────────────────────────────────────────────────────────────

/**
 * A partner's full bank details, opened — for OWNER and BILLING only, and recorded: the platform's
 * audit log and the partner's own ("Platform staff viewed your payout details"). The page keeps them
 * in its own state; they are never rendered by the server.
 */
export async function consoleRevealPayout(partnerId: string): Promise<ConsoleResult<PayoutDetails>> {
  return asStaff(PAYERS, async (staff) => {
    const pid = id(partnerId);
    const slug = await slugOf(pid);
    const details = await revealPayout(pid, staff);
    await consoleAudit(staff, "partner.payout.reveal", { partner: slug });
    return details;
  });
}

/** New bank details for a partner: sealed, masked, and every one of its admins emailed the mask. Answers with the mask alone. */
export async function consoleSetPayout(partnerId: string, details: PayoutInput): Promise<ConsoleResult<{ mask: PayoutMask }>> {
  return asStaff(PAYERS, async (staff) => {
    const done = await setPayout(id(partnerId), payoutInput(details), staff);
    await consoleAudit(staff, "partner.payout.set", { partner: done.partnerSlug, country: done.mask.country, currency: done.mask.currency });
    revalidateConsole();
    return { mask: done.mask };
  });
}

// ─── Entries (SELLERS) ───────────────────────────────────────────────────────────────────────────

/** Voids a PENDING entry (and an accrual's pending reversals), with staff's reason; a draft statement it was on is worked out again. */
export async function consoleVoidCommission(entryId: string, reason: string): Promise<ConsoleResult<{ reversalsVoided: number; statementsVoided: string[] }>> {
  return asStaff(SELLERS, async (staff) => {
    const why = cleanText(reason, 600);
    const done = await voidCommission(id(entryId), why, staff);
    await consoleAudit(staff, "partner.commission.void", {
      partner: done.partnerSlug,
      entry: done.entryId,
      amount: done.amount,
      currency: done.currency,
      reason: why,
      reversalsVoided: done.reversalsVoided,
      ...(done.statementsVoided.length ? { statementsVoided: done.statementsVoided } : {}),
    });
    revalidateConsole();
    return { reversalsVoided: done.reversalsVoided, statementsVoided: done.statementsVoided };
  });
}

/**
 * A staff correction for a partner: `amount` in signed minor units (positive owed, negative taken
 * back), a note the partner sees, optionally the workspace it is about and the IST day it counts from.
 */
export async function consoleAddAdjustment(
  partnerSlug: string,
  input: { currency: string; amount: number; note: string; tenantSlug?: string | null; earnedOn?: string | null },
): Promise<ConsoleResult<{ id: string }>> {
  return asStaff(SELLERS, async (staff) => {
    const pid = await partnerIdBySlug(cleanText(partnerSlug, 60));
    if (!pid) throw new PartnerRefused("That partner no longer exists.");
    const x = obj(input);
    const amount = minorUnits(x.amount);
    const done = await addAdjustment(
      pid,
      { currency: cleanText(x.currency, 8), amount: amount ?? NaN, note: cleanText(x.note, 600), tenantSlug: optional(x.tenantSlug, 70), earnedOn: optional(x.earnedOn, 20) },
      staff,
    );
    const workspace = optional(x.tenantSlug, 70);
    // The note is the partner's to read on the entry; the platform log keeps the facts.
    await consoleAudit(staff, "partner.commission.adjust", { partner: done.partnerSlug, entry: done.id, amount: done.amount, currency: done.currency, ...(workspace ? { workspace: workspace.toLowerCase() } : {}) }, done.tenantId);
    revalidateConsole();
    return { id: done.id };
  });
}

/** Works out commission now, as the tick does (a run at the same time waits on each invoice's lock). */
export async function consoleRunCommissions(): Promise<ConsoleResult<AccrualRun>> {
  return asStaff(SELLERS, async (staff) => {
    const run = await accrueCommissions(new Date());
    await consoleAudit(staff, "partner.commissions.run", { invoices: run.invoices, accrued: run.accrued, reversed: run.reversed, failed: run.failed, outcomes: run.outcomes });
    revalidateConsole();
    return run;
  });
}

// ─── Statements ──────────────────────────────────────────────────────────────────────────────────

/** Drafts last IST month's statements now — every partner's, or one partner's (`partnerSlug`). */
export async function consoleGenerateStatements(partnerSlug?: string | null): Promise<ConsoleResult<{ period: string; made: number; partners: number; numbers: string[]; failed: number }>> {
  return asStaff(SELLERS, async (staff) => {
    const slug = partnerSlug ? cleanText(partnerSlug, 60).toLowerCase() : "";
    let partnerId: string | null = null;
    if (slug) {
      partnerId = await partnerIdBySlug(slug);
      if (!partnerId) throw new PartnerRefused("That partner no longer exists.");
    }
    const run = await generateStatements(new Date(), { by: `staff:${staff.id}`, partnerId, staff });
    await consoleAudit(staff, "partner.statements.generate", { period: run.period, made: run.made, partners: run.partners, ...(run.failed ? { failed: run.failed } : {}), ...(slug ? { partner: slug } : {}) });
    revalidateConsole();
    return { period: run.period, made: run.made, partners: run.partners, numbers: run.numbers, failed: run.failed };
  });
}

/** Approves a DRAFT with staff's tax lines (at most six): its entries become APPROVED and the partner is emailed. */
export async function consoleApproveStatement(statementId: string, input: { taxLines?: TaxLineInput[] | null }): Promise<ConsoleResult<{ number: string; total: number; netPayable: number }>> {
  return asStaff(PAYERS, async (staff) => {
    const done = await approveStatement(id(statementId), { taxLines: taxLinesInput(obj(input).taxLines) }, staff);
    await consoleAudit(staff, "partner.statement.approve", { partner: done.partnerSlug, statement: done.number, total: done.total, netPayable: done.netPayable, currency: done.currency });
    revalidateConsole();
    return { number: done.number, total: done.total, netPayable: done.netPayable };
  });
}

/** Records the payment of an APPROVED statement: its reference and the IST day it was paid. With the two-person rule on, not by whoever approved it. */
export async function consoleMarkStatementPaid(statementId: string, input: { reference: string; paidOn: string; note?: string | null }): Promise<ConsoleResult<{ number: string; paidOn: string }>> {
  return asStaff(PAYERS, async (staff) => {
    const x = obj(input);
    const done = await markStatementPaid(id(statementId), { reference: cleanText(x.reference, 200), paidOn: cleanText(x.paidOn, 20), note: optional(x.note, 600) }, staff);
    await consoleAudit(staff, "partner.statement.paid", { partner: done.partnerSlug, statement: done.number, reference: done.reference, paidOn: done.paidOn, netPayable: done.netPayable, currency: done.currency });
    revalidateConsole();
    return { number: done.number, paidOn: done.paidOn };
  });
}

/** Voids a DRAFT or APPROVED statement, with staff's reason: its entries go back to PENDING for the next one. */
export async function consoleVoidStatement(statementId: string, reason: string): Promise<ConsoleResult<{ number: string; entries: number }>> {
  return asStaff(PAYERS, async (staff) => {
    const why = cleanText(reason, 600);
    const done = await voidStatement(id(statementId), why, staff);
    await consoleAudit(staff, "partner.statement.void", { partner: done.partnerSlug, statement: done.number, was: done.was, entries: done.entries, reason: why });
    revalidateConsole();
    return { number: done.number, entries: done.entries };
  });
}

// ─── Exports (SELLERS, recorded with their row counts) ───────────────────────────────────────────

/**
 * Commission entries as CSV, from the page's query string: `"review"` — the Review tab's list;
 * `"partner"` — one partner's entries (the query string names it: `partner=<slug>`).
 */
export async function consoleExportCommissions(params: Record<string, string>, scope: "review" | "partner" = "review"): Promise<ConsoleResult<CsvExport>> {
  return asStaff(SELLERS, async (staff) => {
    const filters = parseCommissionFilters(rawParams(params));
    const which = scope === "partner" ? "partner" : "review";
    const out = await commissionsCsv(filters, which);
    const asked: Partial<typeof filters> = { ...filters };
    delete asked.page;
    await consoleAudit(staff, "export.commissions", { scope: which, filters: asked, rows: out.rows, ...(filters.partner ? { partner: filters.partner } : {}) });
    return out;
  });
}

/** One statement as CSV: its entries, total, tax lines and net payable. */
export async function consoleExportStatement(statementId: string): Promise<ConsoleResult<CsvExport>> {
  return asStaff(SELLERS, async (staff) => {
    const out = await statementCsvById(id(statementId));
    if (!out) throw new PartnerRefused("That statement no longer exists.");
    await consoleAudit(staff, "export.commissions", { partner: out.partnerSlug, statement: out.number, rows: out.rows });
    return { filename: out.filename, csv: out.csv, rows: out.rows };
  });
}

/** The Reports tab for its IST window (the page's query string: `from`, `to`), as CSV. */
export async function consoleExportPartnerReport(params: Record<string, string>): Promise<ConsoleResult<CsvExport>> {
  return asStaff(SELLERS, async (staff) => {
    const filters = parseReportFilters(rawParams(params));
    const now = new Date();
    const out = await partnerReportCsv(filters, now);
    await consoleAudit(staff, "export.partner-report", { ...reportRange(filters, now), rows: out.rows });
    return out;
  });
}
