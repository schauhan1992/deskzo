"use server";

import type { PartnerRole } from "@wroffy/control-client";
import type { CsvExport } from "@/lib/console-shared/types";
import { partnerAudit } from "@/lib/partners/audit";
import { partnerActor, partnerRefusal, requirePartner, revalidatePortal, type PartnerMode } from "@/lib/partners/guard";
import { portalCommissionsCsv, portalStatementCsv, type CommissionFilters } from "@/lib/partners/portal-data";
import type { PartnerSessionState } from "@/lib/partners/session";
import { setPartnerInvoiceNumber } from "@/lib/partners/statements";
import { PARTNER_LIMITS, PARTNER_MONEY, PartnerRefused, type PartnerMe, type PartnerResult } from "@/lib/partners/types";
import { controlDb } from "@/lib/platform/control-db";

/**
 * Commissions and statements — the money roles only (ADMIN, FINANCE), and only the partner's own.
 *
 *   partnerExportCommissions          the commissions list as CSV, with the page's filters (at most 10,000 entries)
 *   partnerExportStatement            one APPROVED or PAID statement as CSV: its entries, total, tax lines, net payable
 *   partnerSetStatementInvoiceNumber  the partner's own invoice number on an APPROVED statement (until it is paid)
 *
 * Exports hold company names, invoice numbers and amounts — no email, bank detail or tax id — and are
 * limited to 20 an hour per person, counted from the activity log's export rows (so the limit holds
 * across processes; src/lib/platform/find-workspaces.ts's in-process counter is not for this tree).
 * Each export writes one activity row with its row count. A statement number of another partner, a
 * DRAFT or a VOID one is refused exactly as one that does not exist.
 */

async function asPartner<T>(roles: readonly PartnerRole[], mode: PartnerMode, work: (session: PartnerSessionState) => Promise<T>): Promise<PartnerResult<T>> {
  let session: PartnerSessionState;
  try {
    session = await requirePartner(roles, mode);
  } catch (err) {
    const refused = partnerRefusal(err);
    if (refused) return refused;
    throw err;
  }
  try {
    return { ok: true, data: await work(session) };
  } catch (err) {
    const refused = partnerRefusal(err);
    if (refused) return refused;
    throw err;
  }
}

const HOUR = 60 * 60_000;
const EXPORT_ACTIONS = ["export.commissions", "export.statement"];

/** Refuses the 21st export by one person within an hour — counted from the audit rows the exports write. */
async function withinExportLimit(me: PartnerMe, now: Date): Promise<void> {
  const recent = await controlDb().partnerAuditLog.count({
    where: { partnerId: me.partner.id, actorKind: "PARTNER", actorId: me.id, action: { in: EXPORT_ACTIONS }, at: { gt: new Date(now.getTime() - HOUR) } },
  });
  if (recent >= PARTNER_LIMITS.exportsPerHour) throw new PartnerRefused(`You have made ${PARTNER_LIMITS.exportsPerHour} exports in the last hour. Try again later.`);
}

/** The commissions page's filters, re-coerced: short strings or nothing (the loader checks each against what it may be). */
function filtersOf(raw: CommissionFilters | null | undefined): CommissionFilters {
  const x = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  // Left whole (the loader checks each exactly, as it does for the page); only absurd lengths are dropped.
  const pick = (value: unknown) => (typeof value === "string" && value.trim() && value.length <= 200 ? value.trim() : undefined);
  const filters: CommissionFilters = { status: pick(x.status), currency: pick(x.currency), from: pick(x.from), to: pick(x.to), customer: pick(x.customer) };
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)) as CommissionFilters;
}

export async function partnerExportCommissions(filters: CommissionFilters): Promise<PartnerResult<CsvExport>> {
  return asPartner(PARTNER_MONEY, "read", async ({ user }) => {
    const now = new Date();
    await withinExportLimit(user, now);
    const clean = filtersOf(filters);
    const csv = await portalCommissionsCsv(user, clean, now);
    await partnerAudit(partnerActor(user), user.partner.id, "export.commissions", "commission", null, { rows: csv.rows, ...clean });
    return csv;
  });
}

export async function partnerExportStatement(number: string): Promise<PartnerResult<CsvExport>> {
  return asPartner(PARTNER_MONEY, "read", async ({ user }) => {
    const now = new Date();
    await withinExportLimit(user, now);
    const made = await portalStatementCsv(user, String(number ?? "").slice(0, 80), now);
    if (!made) throw new PartnerRefused("That no longer exists.");
    await partnerAudit(partnerActor(user), user.partner.id, "export.statement", "statement", made.statementId, { statement: made.number, rows: made.rows });
    return { filename: made.filename, csv: made.csv, rows: made.rows };
  });
}

export async function partnerSetStatementInvoiceNumber(number: string, invoiceNumber: string): Promise<PartnerResult<{ number: string; invoiceNumber: string }>> {
  return asPartner(PARTNER_MONEY, "write", async ({ user }) => {
    const typed = String(invoiceNumber ?? "");
    // The library allows 60 characters and says so; this only keeps an absurd payload from reaching it.
    if (typed.length > 1000) throw new PartnerRefused("That is too long.");
    const done = await setPartnerInvoiceNumber(user, String(number ?? "").slice(0, 80), typed);
    revalidatePortal();
    return done;
  });
}
