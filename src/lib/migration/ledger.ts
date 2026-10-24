import type { Prisma, VoucherType } from "@prisma/client";
import { db } from "@/lib/db";
import { nextAccountsNumber } from "@/lib/accounts/numbering";
import { accountsSettings } from "@/lib/accounts/settings";
import { voucherAmount, voucherProblem, voucherTypeLabels, type AccountFacts, type VoucherLineInput } from "@/lib/accounts/vouchers";
import { branchIdentity } from "@/lib/branches/identity";
import { normalizeCompanyName } from "@/lib/company-name";
import { stateCodeFromName } from "@/lib/documents/create-draft";
import { GST_STATE_CODES, resolveSupplyType } from "@/lib/gst-engine";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/chart";
import { ensureChartOfAccounts, writeEntry } from "@/lib/ledger/journal";
import type { workspaceClock } from "@/lib/time/workspace";
import { asDate, MigrationRefused } from "./state";

/**
 * What the purchase side of a migration needs from the books (src/lib/migration): the old system's accounts
 * found in Deskzo's chart, the head office its entries are tagged to, and how its expenses and journals are
 * written — as Deskzo's own vouchers, so each has a number and a page, as one typed in would.
 *
 * Zoho Books posts a bill's, a vendor credit's or an expense's lines to whatever account each line names
 * (Rent, Office Supplies, Furniture …), where Deskzo's own forms post to fixed ones. A migrated one keeps the
 * account its line had, or the month-end check would disagree on those accounts every month.
 */

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export type ChartAccount = AccountFacts & { systemKey: string | null };

/** The chart as it stands, read once a part: found by code, else by name, else by the bank account it is. */
export type Chart = {
  byId: Map<string, ChartAccount>;
  /** An account a line can post to: one that exists, isn't a group, and isn't closed. */
  find(text: string): ChartAccount | { error: string };
  system(key: keyof typeof SYSTEM_ACCOUNTS): ChartAccount;
};

export async function loadChart(): Promise<Chart> {
  await ensureChartOfAccounts();
  const rows = await db.ledgerAccount.findMany({
    select: { id: true, code: true, name: true, isGroup: true, active: true, systemKey: true, bankAccount: { select: { id: true, name: true } } },
  });
  const money = new Set<string>([SYSTEM_ACCOUNTS.BANK, SYSTEM_ACCOUNTS.CASH]);
  const party = new Set<string>([SYSTEM_ACCOUNTS.AR, SYSTEM_ACCOUNTS.AP]);
  const accounts: (ChartAccount & { bankName: string | null })[] = rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    isGroup: r.isGroup,
    active: r.active,
    systemKey: r.systemKey,
    isMoney: (r.systemKey !== null && money.has(r.systemKey)) || r.bankAccount !== null,
    needsParty: r.systemKey !== null && party.has(r.systemKey),
    bankName: r.bankAccount?.name ?? null,
  }));
  const byId = new Map<string, ChartAccount>(accounts.map((a) => [a.id, a]));
  const usable = (a: ChartAccount): ChartAccount | { error: string } =>
    a.isGroup ? { error: `${a.name} is a group in Deskzo's chart — name an account inside it.` } : !a.active ? { error: `${a.name} is closed in Deskzo's chart.` } : a;
  return {
    byId,
    find(text) {
      const t = text.trim().toLowerCase();
      if (!t) return { error: "No account given." };
      const byCode = accounts.find((a) => a.code.toLowerCase() === t);
      if (byCode) return usable(byCode);
      const byName = accounts.filter((a) => a.name.toLowerCase() === t);
      if (byName.length > 1) return { error: `More than one account is called "${text.trim()}" — use its code.` };
      const found = byName[0] ?? accounts.find((a) => a.bankName?.toLowerCase() === t);
      // Petty cash and plain "Cash" are the books' cash account unless the chart has one by that name.
      const cash = !found && /^(petty\s*)?cash$/.test(t) ? accounts.find((a) => a.systemKey === SYSTEM_ACCOUNTS.CASH) : undefined;
      if (found ?? cash) return usable((found ?? cash)!);
      return { error: `No account "${text.trim()}" in Deskzo's chart. Add it under Accounting › Chart of accounts, or import your chart, then check again.` };
    },
    system(key) {
      const a = accounts.find((x) => x.systemKey === SYSTEM_ACCOUNTS[key]);
      if (!a) throw new Error(`Chart of accounts is missing: ${key}. Open Accounting → Chart of accounts to restore it.`);
      return a;
    },
  };
}

/** A company by its name, as the file gives it — a vendor, a customer, either. */
export async function findParty(name: string) {
  return db.company.findUnique({ where: { normalizedName: normalizeCompanyName(name) }, select: { id: true, name: true, relationshipType: true } });
}

/** A state as a file gives it — "27", "27-Maharashtra", "Maharashtra", "MH" — as its two-digit GST code. */
export function stateCodeOf(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const code = /^\d{2}\b/.exec(t)?.[0];
  if (code && code in GST_STATE_CODES) return code;
  const upper = t.toUpperCase();
  const byShort = Object.entries(GST_STATE_CODES).find(([, short]) => short === upper)?.[0];
  return byShort ?? stateCodeFromName(t.replace(/^\d{2}\s*[-–]\s*/, ""));
}

/** Where a vendor supplies from: its primary location's state, else its GSTIN's. */
export async function vendorStateCode(companyId: string): Promise<string | null> {
  const location = await db.companyLocation.findFirst({ where: { companyId }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }], select: { state: true, gstNumber: true } });
  const fromGstin = location?.gstNumber && /^\d{2}/.test(location.gstNumber) ? location.gstNumber.slice(0, 2) : null;
  return stateCodeFromName(location?.state ?? null) ?? (fromGstin && fromGstin in GST_STATE_CODES ? fromGstin : null);
}

export type HeadOffice = { branchId: string | null; gstRegistrationId: string | null; stateCode: string | null };

/** The head office: what the migrated purchases are tagged to, and the state their GST is split against — as a document form reads them. */
export async function headOffice(): Promise<HeadOffice> {
  const identity = await branchIdentity(null);
  return { branchId: identity.branchId || null, gstRegistrationId: identity.gstRegistrationId, stateCode: identity.stateCode };
}

/**
 * Input tax split as the supply was: CGST and SGST when the vendor is in our state, IGST when it isn't. With no
 * state for the vendor it is taken as ours — an expense's, as Zoho Books takes it, is local unless it says not.
 */
export function splitInputTax(tax: number, vendorState: string | null, head: HeadOffice) {
  const intra = resolveSupplyType(vendorState ?? head.stateCode, head.stateCode) === "INTRA_STATE";
  const cgst = intra ? round2(tax / 2) : 0;
  return { cgst, sgst: intra ? round2(tax - cgst) : 0, igst: intra ? 0 : round2(tax) };
}

export type LedgerContext = { chart: Chart; head: HeadOffice; prefixes: Record<string, string>; vouchersReady: boolean };

/** What a step's check and import are given: the migration, its year, the clock, who, and the books — read once a part. */
export type StepContext = {
  migrationId: string;
  window: { from: string; to: string };
  clock: Awaited<ReturnType<typeof workspaceClock>>;
  userId: string;
  ledger: () => Promise<LedgerContext>;
};

export async function ledgerContext(): Promise<LedgerContext> {
  const [chart, head, settings] = await Promise.all([loadChart(), headOffice(), accountsSettings()]);
  return { chart, head, prefixes: settings.seriesPrefixes, vouchersReady: settings.migrated };
}

/** Which voucher a set of lines is, by where the money went — null when it's none of them (money both ways and more). */
export function voucherTypeOf(lines: readonly VoucherLineInput[], chart: Chart): VoucherType | null {
  const money = lines.filter((l) => chart.byId.get(l.accountId)?.isMoney);
  if (money.length === 0) return "JOURNAL";
  if (money.length === lines.length) return "CONTRA";
  if (money.every((l) => l.credit > 0)) return "PAYMENT";
  if (money.every((l) => l.debit > 0)) return "RECEIPT";
  return null;
}

const GST_KEYS: string[] = [
  SYSTEM_ACCOUNTS.INPUT_CGST, SYSTEM_ACCOUNTS.INPUT_SGST, SYSTEM_ACCOUNTS.INPUT_IGST,
  SYSTEM_ACCOUNTS.OUTPUT_CGST, SYSTEM_ACCOUNTS.OUTPUT_SGST, SYSTEM_ACCOUNTS.OUTPUT_IGST,
];

/** The lines' problem as a voucher of the kind they are, or null — what checking a file asks before anything is written. */
export function voucherLinesProblem(lines: VoucherLineInput[], ledger: LedgerContext): string | null {
  const type = voucherTypeOf(lines, ledger.chart);
  if (type) return voucherProblem(type, lines, ledger.chart.byId);
  // A plain entry keeps the one rule of a voucher's that isn't about its kind: a receivable or payable line names whose.
  const orphan = lines.findIndex((l) => ledger.chart.byId.get(l.accountId)?.needsParty && !l.companyId);
  return orphan < 0 ? null : `Line ${orphan + 1}: ${ledger.chart.byId.get(lines[orphan]!.accountId)!.name} is a receivable or payable — choose whose.`;
}

/**
 * Writes an expense or a journal from the old system as a posted voucher of the kind its lines make it — a
 * payment when money left a bank or cash account, a receipt when it came in, a contra between them, a journal
 * when no money moved — numbered in Deskzo's series for its date and posted on it. Lines that are none of
 * those (money in and out with other lines besides) are posted as a plain journal entry instead.
 */
export async function writeMigratedVoucher(
  tx: Prisma.TransactionClient,
  v: { day: string; narration: string; reference: string | null; companyId: string | null; lines: VoucherLineInput[]; userId: string; ledger: LedgerContext },
): Promise<{ kind: "voucher" | "journal"; id: string; number: string }> {
  const { chart, head } = v.ledger;
  const date = asDate(v.day);
  const narration = v.narration.slice(0, 500);
  const entryLines = v.lines.map((l) => ({
    ...l,
    companyId: l.companyId ?? null,
    branchId: l.branchId ?? head.branchId,
    gstRegistrationId: GST_KEYS.includes(chart.byId.get(l.accountId)?.systemKey ?? "") ? head.gstRegistrationId : null,
  }));
  const type = voucherTypeOf(v.lines, chart);
  if (!type || !v.ledger.vouchersReady) {
    const entry = await writeEntry(tx, { date, narration, source: "MANUAL", userId: v.userId, lines: entryLines, companyId: v.companyId, branchId: head.branchId });
    return { kind: "journal", id: entry.id, number: entry.entryNumber };
  }
  const problem = voucherProblem(type, v.lines, chart.byId);
  if (problem) throw new MigrationRefused(problem);
  const number = await nextAccountsNumber(tx, type, date, v.ledger.prefixes);
  const voucher = await tx.accountVoucher.create({
    data: {
      type,
      number,
      date,
      status: "POSTED",
      narration,
      reference: v.reference?.slice(0, 80) || null,
      companyId: v.companyId,
      moneyAccountId: v.lines.find((l) => chart.byId.get(l.accountId)?.isMoney)?.accountId ?? null,
      amount: voucherAmount(v.lines),
      createdById: v.userId,
      postedById: v.userId,
      postedAt: new Date(),
      lines: { create: entryLines.map((l, i) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, companyId: l.companyId, departmentId: null, branchId: l.branchId, narration: l.narration?.slice(0, 200) ?? null, sortOrder: i })) },
    },
    select: { id: true, number: true },
  });
  await writeEntry(tx, {
    date,
    narration: `${voucherTypeLabels[type]} voucher ${voucher.number} — ${narration}`,
    source: "VOUCHER",
    userId: v.userId,
    lines: entryLines,
    companyId: v.companyId,
    accountVoucherId: voucher.id,
    postingKey: `voucher:${voucher.id}`,
  });
  return { kind: "voucher", id: voucher.id, number: voucher.number };
}
