import type { CompanyRelationshipType } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/chart";
import { resolveAccounts, reversedLines, reversibleLineSelect, writeEntry } from "@/lib/ledger/journal";
import { isVendorRelationshipType } from "@/lib/validation/company";
import { normalizeCompanyName } from "@/lib/company-name";
import { readHeadings, type ImportPlan, type PlannedRow } from "./import";
import { parseNumber, RowReader, type FieldChange } from "./importers/types";

/**
 * Opening balances from one file — a trial balance from Zoho Books or anywhere else — posted as one
 * journal entry on the day the books start in Deskzo (owner, 18 Oct 2026):
 *
 *   · **Who:** whoever may post a journal by hand and import finance data (src/actions/opening-balances.ts).
 *   · **Accounts** by code, else by name; one Deskzo doesn't have is refused — import the chart first.
 *     A group or an archived account takes no lines, as on the journal form; a GST account names its
 *     GSTIN when there is more than one.
 *   · **Customers and vendors.** A Receivables or Payables row names its party, as one balance with no
 *     ageing — for a company that doesn't bring its open invoices across. A party whose open invoices or
 *     bills were imported is refused: the documents import already posted those balances
 *     (src/lib/portability/documents.ts), and counting them twice is the one mistake an opening can't hide.
 *   · **A difference** between debits and credits goes to Opening Balance Equity, and the preview says so
 *     in red, with the figure — a decision, not an accident.
 *   · **All or nothing.** It is one entry: any unusable row and nothing is posted.
 *   · **Again** replaces: the entry an earlier run of this import made is reversed on the start day, the
 *     new one posted, both kept.
 */

const C = {
  code: "Account code",
  account: "Account",
  debit: "Debit",
  credit: "Credit",
  balance: "Balance",
  party: "Party",
  gstin: "GSTIN",
  narration: "Narration",
} as const;

/** The usual headings in trial balance exports (Zoho Books' among them), matched ignoring case and punctuation. */
const ALIASES: Record<string, string[]> = {
  [C.code]: ["Code", "Ledger Code", "GL Code", "Account No"],
  [C.account]: ["Account Name", "Ledger", "Ledger Name", "Particulars", "Account Head"],
  [C.debit]: ["Dr", "Debit Amount", "Opening Debit", "Net Debit", "Debit Balance"],
  [C.credit]: ["Cr", "Credit Amount", "Opening Credit", "Net Credit", "Credit Balance"],
  [C.balance]: ["Closing Balance", "Opening Balance", "Net Balance"],
  [C.party]: ["Customer Name", "Vendor Name", "Contact Name", "Party Name", "Customer", "Vendor"],
  [C.gstin]: ["GST Number", "GST Identification Number (GSTIN)"],
  [C.narration]: ["Description", "Notes", "Remarks"],
};
const headings = { templateColumns: Object.values(C) as string[], headerAliases: ALIASES };
export const OPENING_TEMPLATE_COLUMNS: string[] = [C.code, C.account, C.debit, C.credit, C.party, C.gstin, C.narration];

/** How an entry this import made is known again, so a second run can replace it. */
export const OPENING_IMPORT_NARRATION = "Opening balances — imported";

const GST_KEYS: string[] = [
  SYSTEM_ACCOUNTS.INPUT_CGST,
  SYSTEM_ACCOUNTS.INPUT_SGST,
  SYSTEM_ACCOUNTS.INPUT_IGST,
  SYSTEM_ACCOUNTS.OUTPUT_CGST,
  SYSTEM_ACCOUNTS.OUTPUT_SGST,
  SYSTEM_ACCOUNTS.OUTPUT_IGST,
];

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export type OpeningOptions = { openingDate?: string | null; filename?: string };
type Line = { line: number; accountId: string; accountName: string; debit: number; credit: number; companyId: string | null; partyName: string | null; gstRegistrationId: string | null; narration: string | null };
type Read = { error: string } | { skip: string } | Line;

/** A trial balance's "Balance" cell: "1,250.00 Dr", "1,250.00 Cr", or signed (a credit negative). */
function balanceOf(raw: string): { debit: number; credit: number } | { error: string } | null {
  const text = raw.trim();
  if (!text) return null;
  const side = /\b(dr|cr)\.?\s*$/i.exec(text)?.[1]?.toLowerCase();
  const parsed = parseNumber(C.balance, text.replace(/\b(dr|cr)\.?\s*$/i, ""));
  if (parsed.error || parsed.value === undefined) return { error: parsed.error ?? `${C.balance} "${raw}" isn't an amount.` };
  const value = side === "cr" ? -Math.abs(parsed.value) : side === "dr" ? Math.abs(parsed.value) : parsed.value;
  return value >= 0 ? { debit: value, credit: 0 } : { debit: 0, credit: -value };
}

type Lookups = {
  accounts: { id: string; code: string; name: string; isGroup: boolean; active: boolean; systemKey: string | null }[];
  registrations: { id: string; gstin: string }[];
};

async function readRow(row: Record<string, string>, line: number, lookups: Lookups): Promise<Read> {
  const r = new RowReader(row);
  const code = r.text(C.code);
  const name = r.text(C.account);
  // A trial balance's own total line, and rows with nothing on them, aren't accounts.
  if (!code && /^(grand\s+)?total\b/i.test(name)) return { skip: "the file's total" };
  let debit = r.number(C.debit) ?? 0;
  let credit = r.number(C.credit) ?? 0;
  if (r.error) return { error: r.error };
  const balance = balanceOf(r.text(C.balance));
  if (balance && "error" in balance) return { error: balance.error };
  if (balance && !debit && !credit) ({ debit, credit } = balance);
  if (debit < 0 || credit < 0) return { error: `${C.debit} and ${C.credit} can't be negative — put a credit in ${C.credit}.` };
  if (debit && credit) return { error: `A line carries a debit or a credit, not both — net them first.` };
  if (!debit && !credit) return { skip: "nothing to post" };
  if (!code && !name) return { error: `Name the account: its ${C.code} or its name.` };

  const byCode = code ? lookups.accounts.find((a) => a.code.toLowerCase() === code.toLowerCase()) : undefined;
  const byName = !byCode && name ? lookups.accounts.filter((a) => a.name.toLowerCase() === name.toLowerCase()) : [];
  if (byName.length > 1) return { error: `More than one account is called "${name}" — give its ${C.code}.` };
  const account = byCode ?? byName[0];
  if (!account) return { error: `No account ${code ? `with code ${code}` : `called "${name}"`}. Import the chart of accounts first, or correct it.` };
  if (account.isGroup) return { error: `${account.name} is a group — post to one of the accounts under it.` };
  if (!account.active) return { error: `${account.name} is archived and can't take new entries.` };

  // A customer's or vendor's balance names them, unless their open documents already brought it.
  const partyName = r.text(C.party) || null;
  let companyId: string | null = null;
  const owed = account.systemKey === SYSTEM_ACCOUNTS.AR ? "customer" : account.systemKey === SYSTEM_ACCOUNTS.AP ? "vendor" : null;
  if (owed && !partyName) return { error: `A ${owed === "customer" ? "receivable" : "payable"} names its ${owed} — give ${C.party} on the ${account.name} row.` };
  if (partyName) {
    const party = await db.company.findUnique({ where: { normalizedName: normalizeCompanyName(partyName) }, select: { id: true, name: true, relationshipType: true } });
    if (!party) return { error: `No ${owed ?? "company"} named "${partyName}". Import Companies or Vendors first, or correct the spelling.` };
    const vendor = isVendorRelationshipType(party.relationshipType as CompanyRelationshipType);
    if (owed === "vendor" && !vendor) return { error: `${party.name} isn't a vendor — a payable is owed to a vendor.` };
    if (owed === "customer" && vendor) return { error: `${party.name} is a vendor — a receivable is owed by a customer.` };
    if (owed) {
      const imported = await db.tradeDocument.findFirst({
        where: { companyId: party.id, origin: "IMPORTED", docType: { in: ["INVOICE", "BILL", "CREDIT_NOTE"] }, status: { not: "CANCELLED" } },
        select: { docNumber: true },
      });
      if (imported) return { error: `${party.name}'s open documents were imported (${imported.docNumber} among them), and their balances posted then — leave ${party.name} out of this file.` };
    }
    companyId = party.id;
  }

  // A GST line belongs to one GSTIN's return: the file's, or the only one there is.
  let gstRegistrationId: string | null = null;
  if (account.systemKey && GST_KEYS.includes(account.systemKey)) {
    const gstin = r.text(C.gstin).toUpperCase();
    const named = gstin ? lookups.registrations.find((g) => g.gstin === gstin) : undefined;
    if (gstin && !named) return { error: `${gstin} isn't one of your GST registrations.` };
    if (!named && lookups.registrations.length > 1) return { error: `Say which GSTIN this ${account.name} balance belongs to — give ${C.gstin}.` };
    gstRegistrationId = named?.id ?? lookups.registrations[0]?.id ?? null;
  }

  return { line, accountId: account.id, accountName: `${account.code} · ${account.name}`, debit: round2(debit), credit: round2(credit), companyId, partyName, gstRegistrationId, narration: r.text(C.narration) || null };
}

/** The entry an earlier run of this import made, still standing — what a new run replaces. */
function earlierImport() {
  return db.journalEntry.findFirst({
    where: { source: "OPENING", narration: { startsWith: OPENING_IMPORT_NARRATION }, reversesId: null, reversedBy: { is: null } },
    orderBy: { createdAt: "desc" },
    select: { id: true, entryNumber: true, date: true, companyId: true, lines: { orderBy: { sortOrder: "asc" }, select: reversibleLineSelect } },
  });
}

type Worked = {
  rows: PlannedRow[];
  lines: Line[];
  errors: number;
  debit: number;
  credit: number;
  difference: number;
  earlier: Awaited<ReturnType<typeof earlierImport>>;
  start: { day: string; at: Date };
  readAs: { from: string; to: string }[];
  unknownColumns: string[];
};

async function work(fileRows: Record<string, string>[], options: OpeningOptions): Promise<Worked | { error: string }> {
  const day = (options.openingDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: "Give the day your books start in Deskzo — the opening balances are posted on it." };
  const lock = await db.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
  const locked = lock?.lockedUntil ? lock.lockedUntil.toISOString().slice(0, 10) : null;
  if (locked && day <= locked) return { error: `The books are closed to ${locked}. Pick a start day after that.` };
  const earlier = await earlierImport();
  if (earlier && locked && earlier.date.toISOString().slice(0, 10) <= locked) {
    return { error: `The opening balances imported before (${earlier.entryNumber}) are in a closed period, so they can't be replaced. Correct them with a journal in an open one.` };
  }

  const { rows, readAs } = readHeadings(headings, fileRows);
  const [accounts, registrations] = await Promise.all([
    db.ledgerAccount.findMany({ select: { id: true, code: true, name: true, isGroup: true, active: true, systemKey: true } }),
    db.gstRegistration.findMany({ where: { active: true }, select: { id: true, gstin: true } }),
  ]);
  const planned: PlannedRow[] = [];
  const lines: Line[] = [];
  for (const [i, row] of rows.entries()) {
    const line = i + 2;
    const read = await readRow(row, line, { accounts, registrations });
    if ("error" in read) planned.push({ line, action: "error", key: "", label: row[C.account] || row[C.code] || `Row ${line}`, changes: [], error: read.error });
    else if ("skip" in read) planned.push({ line, action: "skip", key: "", label: row[C.account] || row[C.code] || `Row ${line}`, changes: [] });
    else {
      lines.push(read);
      const changes: FieldChange[] = [
        read.debit ? { field: C.debit, from: "(new)", to: rupees(read.debit) } : { field: C.credit, from: "(new)", to: rupees(read.credit) },
        ...(read.partyName ? [{ field: C.party, from: "(new)", to: read.partyName }] : []),
      ];
      planned.push({ line, action: "create", key: read.accountId, label: read.accountName, changes });
    }
  }
  const debit = round2(lines.reduce((t, l) => t + l.debit, 0));
  const credit = round2(lines.reduce((t, l) => t + l.credit, 0));
  const known = new Set(Object.values(C) as string[]);
  return {
    rows: planned,
    lines,
    errors: planned.filter((r) => r.action === "error").length,
    debit,
    credit,
    difference: round2(debit - credit),
    earlier,
    start: { day, at: new Date(`${day}T12:00:00Z`) },
    readAs,
    unknownColumns: [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => c && !known.has(c)),
  };
}

/** What the file would post, line by line, writing nothing — with the difference and any entry it replaces said. */
export async function planOpeningBalances(fileRows: Record<string, string>[], options: OpeningOptions): Promise<ImportPlan> {
  const worked = await work(fileRows, options);
  if ("error" in worked) throw new Error(worked.error);
  const creates = worked.rows.filter((r) => r.action === "create").map((r) => r.line);
  const notices: ImportPlan["notices"] = [];
  if (creates.length) {
    notices.push({
      text: `Posted as one entry on ${worked.start.day}: debits ${rupees(worked.debit)}, credits ${rupees(worked.credit)}. Customers and vendors whose open documents you import are posted by that import — leave them out here.`,
      lines: creates,
    });
  }
  if (worked.difference !== 0 && creates.length) {
    notices.push({
      text: `Debits and credits differ by ${rupees(Math.abs(worked.difference))}: that goes to Opening Balance Equity as a ${worked.difference > 0 ? "credit" : "debit"}. Check it's the difference you expect before importing.`,
      lines: creates,
      tone: "danger",
    });
  }
  if (worked.earlier) {
    notices.push({ text: `This replaces the opening balances imported before (${worked.earlier.entryNumber}): that entry is reversed on ${worked.start.day}, and both are kept.`, lines: creates });
  }
  return {
    area: "opening-balances",
    totalRows: worked.rows.length,
    creates: creates.length,
    updates: 0,
    skips: worked.rows.filter((r) => r.action === "skip").length,
    errors: worked.errors,
    rows: worked.rows,
    unknownColumns: worked.unknownColumns,
    notices,
    readAs: worked.readAs,
  };
}

/**
 * Posts the file as one entry, or nothing: any unusable row refuses it all, since half an opening is
 * worse than none. An entry this import made before is reversed on the same day in the same step.
 */
export async function applyOpeningBalances(
  fileRows: Record<string, string>[],
  actorUserId: string,
  options: OpeningOptions,
): Promise<{ created: number; updated: number; skipped: number; failed: { line: number; error: string }[]; entryNumber?: string }> {
  const worked = await work(fileRows, options);
  if ("error" in worked) throw new Error(worked.error);
  const skipped = worked.rows.filter((r) => r.action === "skip").length;
  if (worked.errors > 0) {
    return { created: 0, updated: 0, skipped, failed: worked.rows.filter((r) => r.action === "error").map((r) => ({ line: r.line, error: r.error ?? "Unusable row." })) };
  }
  if (worked.lines.length === 0) return { created: 0, updated: 0, skipped, failed: [{ line: 1, error: "There's nothing to post in that file." }] };

  const { start, earlier } = worked;
  const entry = await db.$transaction(async (tx) => {
    if (earlier) {
      await writeEntry(tx, {
        date: start.at,
        narration: `Reversal of ${earlier.entryNumber} — opening balances imported again`,
        source: "OPENING",
        userId: actorUserId,
        lines: reversedLines(earlier.lines),
        companyId: earlier.companyId,
        reversesId: earlier.id,
      });
    }
    const lines = worked.lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, companyId: l.companyId, gstRegistrationId: l.gstRegistrationId, narration: l.narration }));
    if (worked.difference !== 0) {
      const equity = (await resolveAccounts(tx, ["OPENING_BALANCE_EQUITY"])).get("OPENING_BALANCE_EQUITY")!;
      const gap = Math.abs(worked.difference);
      lines.push({ accountId: equity, debit: worked.difference < 0 ? gap : 0, credit: worked.difference > 0 ? gap : 0, companyId: null, gstRegistrationId: null, narration: "The difference between the file's debits and credits" });
    }
    return writeEntry(tx, {
      date: start.at,
      narration: `${OPENING_IMPORT_NARRATION}${options.filename ? ` from ${options.filename}` : ""}`,
      source: "OPENING",
      userId: actorUserId,
      lines,
    });
  });
  await recordAudit({ userId: actorUserId, action: "CREATE", entityType: "JournalEntry", entityId: entry.id, entityLabel: `${entry.entryNumber} — opening balances imported${earlier ? `, replacing ${earlier.entryNumber}` : ""}` });
  return { created: worked.lines.length, updated: 0, skipped, failed: [], entryNumber: entry.entryNumber };
}
