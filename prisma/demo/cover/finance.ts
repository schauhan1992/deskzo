import {
  Prisma,
  type DocumentOrigin,
  type FollowUpChannel,
  type GstTreatment,
  type PaymentMethod,
  type PaymentTerms,
  type PrismaClient,
  type TradeDocumentStatus,
  type TradeDocumentType,
  type TransportMode,
  type VehicleType,
} from "@prisma/client";
import { createHash } from "node:crypto";
import type { DemoContext } from "../context";
import { DEMO_SKU, FOUNDED, chance, daysAgo, int, log, pick, some } from "../shared";
import { runAsTenant } from "../../../src/lib/tenancy/resolve";
import { clientFor, closeAllClients } from "../../../src/lib/tenancy/clients";
import type { Tenant } from "../../../src/lib/tenancy/state";
import { UNRESTRICTED } from "../../../src/lib/entitlements";
import { indiaClock } from "../../../src/lib/time/zone";
import {
  computeDocument,
  gstinCheckCharacter,
  GST_STATE_ABBREVIATIONS,
  OTHER_COUNTRY_CODE,
  panOfGstin,
  resolveSupplyType,
  stateCodeFromGstin,
  stateCodeFromName,
} from "../../../src/lib/gst-engine";
import { nextDocumentNumber } from "../../../src/lib/trade-number";
import { adoptUnassigned, branchIdentity, ensureHeadOffice, HEAD_OFFICE_REGISTRATION_ID } from "../../../src/lib/branches/identity";
import { formatDispatchAddress } from "../../../src/lib/branches/format";
import { SYSTEM_ACCOUNTS } from "../../../src/lib/ledger/chart";
import {
  ensureChartOfAccounts,
  postAssetDisposalToLedger,
  postChequeClearingToLedger,
  postDepreciationToLedger,
  postDocumentToLedger,
  postExchangeDifferenceToLedger,
  postPaymentToLedger,
  postVendorCreditToLedger,
  resolveAccounts,
  reverseDocumentPosting,
  reversedLines,
  reverseVendorCreditPosting,
  reversibleLineSelect,
  writeEntry,
} from "../../../src/lib/ledger/journal";
import { endOfMonth, monthlyCharge, startOfMonth } from "../../../src/lib/ledger/depreciation";
import { syncBillingMilestones } from "../../../src/lib/projects/billing-sync";
import { approvalDocumentFor, approvalPolicyFor } from "../../../src/lib/documents/approval-policy";
import { approvalRequirement } from "../../../src/lib/documents/approval";
import { syncInvoiceStatus } from "../../../src/lib/receivables/sync";
import { settleInvoice, settledStatus } from "../../../src/lib/receivables";
import { validityFor } from "../../../src/lib/eway/rules";
import { resolvePromises } from "../../../src/lib/collections/promises";
import { assessCompanies, assessCompany, cacheAssessments } from "../../../src/lib/credit/load";
import { creditConcerns, RATING_LABELS, termsExceed, type TermsKey } from "../../../src/lib/credit/engine";
import { paymentTermsLabels } from "../../../src/lib/gst";
import { formatOrderId } from "../../../src/lib/order-id";
import { automationUserId } from "../../../src/lib/automation-user";
import { runRevenueRecognition } from "../../../src/lib/revenue/run";
import { openingCandidates, postOpening, previewOpening } from "../../../src/lib/revenue/opening";
import { approveRevenueSchedule, cancelRevenueSchedule, editRevenueSchedule } from "../../../src/lib/revenue/schedules";
import { addMonths as addRevenueMonths, lastCompletedMonth as lastRevenueMonth } from "../../../src/lib/revenue/periods";
import { createAccountingSchedule, runAccountingSchedules, stopAccountingSchedule } from "../../../src/lib/close/schedules";
import { ensureDefaultTemplates, listTemplates, writeTemplate } from "../../../src/lib/close/templates";
import { evaluateAutoChecks, generateTasks, writeTaskStatus } from "../../../src/lib/close/checklist";
import { fluxFor, writeFluxNote } from "../../../src/lib/close/flux";
import { addMonths as addCloseMonths, lastCompletedMonth as lastCloseMonth, monthLabel as closeMonthLabel } from "../../../src/lib/close/months";

/**
 * Coverage: the money side — sales and purchase documents in every state a document can be in, the
 * branches and GST registrations they go out under, e-invoices and e-way bills, money paid out to
 * vendors, collections and credit, the books' own entries, and Revenue & Close.
 *
 * ## Through the app's own code, inside a workspace
 *
 * Everything here runs inside `runAsTenant` with a workspace pointed at DATABASE_URL, so the app's lib
 * functions that read through `db` (branches, collections, credit, revenue recognition, the close)
 * reach this database and nothing else. Without it a script's `db` is the legacy workspace — the
 * owner's real one — which is exactly how `ensureChartOfAccounts()` in prisma/demo/finance.ts ends up
 * looking at the wrong database (see the report).
 *
 * Every journal entry comes out of the ledger's own write path: documents through
 * `postDocumentToLedger` and `reverseDocumentPosting`, money through `postPaymentToLedger` and
 * `postExchangeDifferenceToLedger`, depreciation and disposals through theirs, prepaids and accruals
 * through `runAccountingSchedules`, revenue through `runRevenueRecognition` and the opening wizard,
 * and hand-written journals through `writeEntry` exactly as `createManualJournal` calls it.
 *
 * ## What it leaves alone
 *
 * No `FiscalYearClose` and no `LedgerLock`: either would refuse postings across this year. So no month
 * is CLOSED either — closing one moves the lock — but one has been closed and reopened, which is the
 * state that leaves behind. No close-task attachments: they are files.
 */

type Who = { id: string; name: string };
type Party = DemoContext["companies"][number];
type Loc = {
  id: string;
  companyId: string;
  label: string;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  pincode: string | null;
  gstNumber: string | null;
  gstTreatment: GstTreatment;
};
type Item = { id: string; name: string; type: string; hsnCode: string | null; unit: string | null; tax: number; price: number; cost: number };
type Br = {
  id: string;
  code: string;
  name: string;
  isHeadOffice: boolean;
  regId: string | null;
  gstin: string | null;
  state: string | null;
  dispatch: string;
  roundOff: boolean;
};
type LineIn = {
  item?: Item;
  name?: string;
  description?: string | null;
  qty: number;
  price: number;
  mode?: "PERCENT" | "AMOUNT";
  discount?: number;
  tax?: number;
  from?: Date | null;
  to?: Date | null;
  orderId?: string | null;
};
type DocIn = {
  type: TradeDocumentType;
  party: Party;
  loc: Loc;
  branch: Br;
  /** When it was raised. Its issue date is this instant's day in India, held as a typed day is. */
  at: Date;
  lines: LineIn[];
  origin: DocumentOrigin;
  by: Who;
  treatment?: GstTreatment;
  pos?: string | null;
  currency?: string;
  rate?: number;
  shipping?: { charge: number; rate: number };
  withholding?: { mode: "TDS" | "TCS"; section: string; rate: number };
  adjustment?: { label: string; amount: number };
  salesperson?: string | null;
  dueDays?: number;
  validDays?: number;
  reference?: string | null;
  notes?: string | null;
  terms?: string | null;
  sourceId?: string | null;
  againstId?: string | null;
  noTax?: boolean;
};
type Doc = {
  id: string;
  docNumber: string;
  type: TradeDocumentType;
  party: Party;
  loc: Loc;
  branch: Br;
  at: Date;
  issueDate: Date;
  dueDate: Date | null;
  total: number;
  currency: string;
  rate: number;
  sellerGstin: string | null;
  buyerGstin: string | null;
  deliveryState: string | null;
  goods: boolean;
  lines: { id: string; name: string; taxableValue: number }[];
};
/** What a payment needs to know about the document it settles. */
type Settles = { id: string; companyId: string; branchId: string | null; currency: string; rate: number; docType: TradeDocumentType };

const DAY = 86_400_000;
const TX = { timeout: 120_000, maxWait: 20_000 };
const r2 = (n: number) => Math.round(n * 100) / 100;
const dec = (n: number) => new Prisma.Decimal(r2(n).toFixed(2));
const SALES_TYPES = new Set<TradeDocumentType>(["PROPOSAL", "PROFORMA", "INVOICE", "CREDIT_NOTE", "DELIVERY_CHALLAN"]);
const rupees = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

/** Our PAN when the workspace has none on file: the right shape, and plainly nobody's. */
const DEMO_PAN = "AAKCD4721M";

function gstinFor(stateCode: string, pan: string, entity = "1"): string {
  const first = `${stateCode}${pan}${entity}Z`;
  return `${first}${gstinCheckCharacter(first) ?? "0"}`;
}

function randomPan(): string {
  const L = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const letter = () => L[int(0, L.length - 1)];
  return `${letter()}${letter()}${letter()}C${letter()}${int(1000, 9999)}${letter()}`;
}

/** An instant in India `daysBack` days ago, on a working day, in office hours — never in the future. */
function workday(daysBack: number, hour?: number): Date {
  let base = daysAgo(Math.max(daysBack, 0));
  const first = indiaClock.parts(base);
  if (first.weekday === 0) base = new Date(base.getTime() - 2 * DAY);
  if (first.weekday === 6) base = new Date(base.getTime() - DAY);
  const p = indiaClock.parts(base);
  const at = indiaClock.at(p.year, p.month, p.day, hour ?? int(10, 17), int(0, 59));
  return capNow(at);
}

function capNow(at: Date): Date {
  const latest = Date.now() - 5 * 60_000;
  return at.getTime() > latest ? new Date(latest) : at;
}

/**
 * Runs `work` without the email stub's line per notification (src/lib/email.ts): generating a month's
 * checklist tells every task's owner, and the seed's output is for people to read.
 */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("[email stub]")) return;
    original(...args);
  };
  try {
    return await work();
  } finally {
    console.log = original;
  }
}

/** Notes a person leaves on a manual close task they finished. */
const MANUAL_NOTES: Record<string, string> = {
  "Vendor bills entered; accruals for missing bills": "All bills for the month entered; the audit fee and the Bengaluru electricity are accrued under Prepaids & accruals.",
  "GST returns prepared": "GSTR-1 filed on the 11th and GSTR-3B on the 20th — both agree with the books.",
  "Petty cash counted and agreed": "Counted the box with the office manager — agrees with Cash in Hand; vouchers filed.",
  "TDS reconciled": "Challans paid by the 7th agree with TDS Payable; nothing outstanding.",
};

/** What a person does with an automatic check that failed, when they can account for it. */
const FAILED_CHECK_NOTES: Record<string, { status: "DONE" | "NOT_APPLICABLE"; note: string }> = {
  "bank-reconciled": { status: "DONE", note: "Agreed to the statements on the banks' portals — the import here is behind, and the only differences are cheques in transit." },
  "payroll-posted": { status: "NOT_APPLICABLE", note: "This month's salaries were processed by the payroll bureau before the payroll module went live — booked from their journal." },
  "invoices-issued": { status: "DONE", note: "The draft waits for the customer's sign-off sheet and is dated in the month on purpose — reviewed." },
  "flux-explained": { status: "DONE", note: "The rest are rounding on the GST accounts — reviewed with the controller." },
};

/**
 * How a still-open close task ends up: in the earlier months everything is dealt with (August keeps the
 * bank reconciliation and TDS open); in the month being closed now only the early, manual ones are done.
 */
function closeVerdict(
  task: { title: string; autoCheck: string | null; autoOk: boolean | null },
  monthIndex: number,
  isLast: boolean,
): { status: "DONE" | "NOT_APPLICABLE"; note: string | null } | null {
  if (isLast) {
    return task.title === "Petty cash counted and agreed" || task.title === "Vendor bills entered; accruals for missing bills"
      ? { status: "DONE", note: MANUAL_NOTES[task.title] ?? null }
      : null;
  }
  if (monthIndex === 1 && (task.autoCheck === "bank-reconciled" || task.title === "TDS reconciled")) return null;
  if (task.title === "TDS reconciled" && monthIndex === 0) return { status: "NOT_APPLICABLE", note: "No TDS deducted on payments this month — nothing to reconcile." };
  if (task.autoCheck && task.autoOk === false) {
    return FAILED_CHECK_NOTES[task.autoCheck] ?? { status: "DONE", note: "Differences reviewed with the controller — timing items only." };
  }
  return { status: "DONE", note: MANUAL_NOTES[task.title] ?? null };
}

/** Every month in India from the one `from` falls in to the one `to` falls in, both included; months 0-based. */
function indianMonths(from: Date, to: Date): { year: number; month0: number }[] {
  const start = indiaClock.parts(from);
  const end = indiaClock.parts(to);
  const out: { year: number; month0: number }[] = [];
  for (let i = start.year * 12 + start.month; i <= end.year * 12 + end.month; i++) out.push({ year: Math.floor(i / 12), month0: i % 12 });
  return out;
}

const plusHours = (at: Date, h: number) => capNow(new Date(at.getTime() + h * 3_600_000));
const plusDays = (at: Date, d: number) => new Date(at.getTime() + d * DAY);
/** The calendar day an instant falls on in India, held as midnight UTC — how a typed day is kept. */
const dayOf = (at: Date) => indiaClock.calendarDate(at);
/** A calendar day `n` days after another. */
const addDay = (day: Date, n: number) => new Date(day.getTime() + n * DAY);

export default async function seedFinanceCover(db: PrismaClient, ctx: DemoContext): Promise<void> {
  void db;
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!url.searchParams.has("connection_limit")) url.searchParams.set("connection_limit", "4");
  // A workspace for the app's own code to run as: this database, every module in its plan, India.
  const tenant: Tenant = {
    id: `seed-cover-finance${url.pathname}`,
    slug: "seed-cover-finance",
    name: "Demo seed",
    status: "ACTIVE",
    dbUrl: url.toString(),
    primaryHost: "seed-cover-finance.localhost",
    hosts: ["seed-cover-finance.localhost"],
    source: "env",
    isDefault: false,
    keyBundleCipher: null,
    country: "IN",
    entitlements: UNRESTRICTED,
    holdReason: null,
  };
  try {
    await runAsTenant(tenant, () => seed(clientFor(tenant), ctx));
  } finally {
    await closeAllClients();
  }
}

async function seed(app: PrismaClient, ctx: DemoContext) {
  // ── Who does the work ─────────────────────────────────────────────────────────────────────────
  const people = ctx.people;
  const fallback: Who = ctx.admin;
  const byTitle = (title: string) => people.find((p) => p.title === title);
  const accountsTeam = people.filter((p) => p.dept === "Accounts");
  const controller: Who = byTitle("Finance Controller") ?? accountsTeam[0] ?? fallback;
  const execs: Who[] = accountsTeam.filter((p) => p.id !== controller.id);
  if (execs.length === 0) execs.push(controller);
  const purchaseTeam: Who[] = people.filter((p) => p.dept === "Purchase");
  const purchaseMgr: Who = byTitle("Purchase Manager") ?? purchaseTeam[0] ?? controller;
  if (purchaseTeam.length === 0) purchaseTeam.push(purchaseMgr);
  const salesTeam: Who[] = people.filter((p) => p.dept === "Sales" || p.dept === "Inside Sales");
  if (salesTeam.length === 0) salesTeam.push(fallback);
  const salesHead: Who = byTitle("Head of Sales") ?? people.find((p) => p.dept === "Sales" && p.isManager) ?? controller;
  const director: Who = people.find((p) => p.role === "ADMIN") ?? fallback;
  const gm: Who = byTitle("General Manager") ?? director;
  const hrManager: Who = byTitle("HR Manager") ?? gm;
  const support: Who[] = people.filter((p) => p.dept === "Support");
  const exec = () => pick(execs);
  const now = new Date();

  await ensureChartOfAccounts(app);

  // ── The parties and the catalogue ─────────────────────────────────────────────────────────────
  const customers = ctx.companies.filter((c) => c.relationship === "CLIENT" && c.stage === "CUSTOMER");
  const vendors = ctx.companies.filter((c) => ["VENDOR", "DISTRIBUTOR", "OEM"].includes(c.relationship));
  // The scenarios below need a handful of each: four small buyers, a few registered customers, vendors to buy from.
  if (customers.length < 8 || vendors.length < 2) {
    log("Finance", "skipped — the demo has too few customers or vendors to bill");
    return;
  }
  const locRows = await app.companyLocation.findMany({
    where: { companyId: { in: ctx.companies.map((c) => c.id) } },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    select: { id: true, companyId: true, label: true, address: true, city: true, state: true, country: true, pincode: true, gstNumber: true, gstTreatment: true },
  });
  const locs = new Map<string, Loc[]>();
  for (const l of locRows) locs.set(l.companyId, [...(locs.get(l.companyId) ?? []), l]);
  const primary = (c: Party): Loc => {
    const list = locs.get(c.id) ?? [];
    return list.find((l) => l.id === c.locationId) ?? list[0]!;
  };
  const stateOf = (l: Loc) => stateCodeFromGstin(l.gstNumber) ?? stateCodeFromName(l.state);
  const registered = customers.filter((c) => primary(c)?.gstNumber);
  const unregistered = customers.filter((c) => primary(c) && !primary(c).gstNumber);
  const inState = (codes: string[]) => registered.filter((c) => codes.includes(stateOf(primary(c)) ?? ""));
  const rotation = (list: Party[]) => {
    const order = some(list, list.length);
    let i = 0;
    return () => order[i++ % order.length]!;
  };
  const nextCustomer = rotation(registered.length ? registered : customers);
  const nextVendor = rotation(vendors);
  const ownerOf = (c: Party) => c.ownerId ?? pick(salesTeam).id;

  const itemRows = await app.item.findMany({
    where: { sku: { startsWith: DEMO_SKU } },
    orderBy: { sellingPrice: "asc" },
    select: { id: true, name: true, type: true, hsnCode: true, unit: true, taxRatePercent: true, sellingPrice: true, costPrice: true },
  });
  const items: Item[] = itemRows.map((i) => ({
    id: i.id,
    name: i.name,
    type: i.type,
    hsnCode: i.hsnCode,
    unit: i.unit,
    tax: Number(i.taxRatePercent ?? 18),
    price: Number(i.sellingPrice),
    cost: Number(i.costPrice ?? Number(i.sellingPrice) * 0.8),
  }));
  const goods = items.filter((i) => i.type === "GOOD");
  const services = items.filter((i) => i.type === "SERVICE");
  const subs = items.filter((i) => i.type === "SUBSCRIPTION");
  if (goods.length === 0 || services.length === 0 || subs.length === 0) {
    log("Finance", "skipped — the demo catalogue has no goods, services or subscriptions");
    return;
  }
  const itemNamed = (fragment: string, from: Item[]) => from.find((i) => i.name.includes(fragment)) ?? pick(from);

  const banks = await app.bankAccount.findMany({ where: { active: true }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, isDefault: true, ledgerAccountId: true } });
  const mainBank = banks.find((b) => b.isDefault) ?? banks[0] ?? null;
  const collectionsBank = banks.find((b) => /collection/i.test(b.name)) ?? mainBank;
  const accountsByCode = new Map((await app.ledgerAccount.findMany({ select: { id: true, code: true } })).map((a) => [a.code, a.id]));
  const bankLedgerId = mainBank?.ledgerAccountId ?? (await resolveAccounts(app as unknown as Prisma.TransactionClient, [SYSTEM_ACCOUNTS.BANK])).get(SYSTEM_ACCOUNTS.BANK)!;

  // ═══ Branches and GST registrations ═══════════════════════════════════════════════════════════
  const org = await app.organisationSettings.findUnique({ where: { id: "global" }, select: { pan: true, stateCode: true } });
  const existingRegs = await app.gstRegistration.findMany({ select: { id: true, gstin: true } });
  let headOffice = await app.branch.findFirst({ where: { isHeadOffice: true }, include: { gstRegistration: true } });
  const pan =
    (headOffice?.gstRegistration ? panOfGstin(headOffice.gstRegistration.gstin) : null) ??
    (org?.pan?.trim().toUpperCase() || null) ??
    (existingRegs[0] ? panOfGstin(existingRegs[0].gstin) : null) ??
    DEMO_PAN;
  const hoState = headOffice?.gstRegistration?.stateCode ?? (org?.stateCode?.trim() || "27");

  const freeCode = async (state: string) => {
    const base = GST_STATE_ABBREVIATIONS[state] ?? `S${state}`;
    let code = base;
    for (let n = 2; await app.gstRegistration.findUnique({ where: { code }, select: { id: true } }); n++) code = `${base}${n}`;
    return code;
  };
  const registration = async (state: string, opts: { active?: boolean; id?: string; threshold?: number } = {}) => {
    const gstin = gstinFor(state, pan);
    const found = await app.gstRegistration.findUnique({ where: { gstin }, select: { id: true } });
    if (found) return found.id;
    const row = await app.gstRegistration.create({
      data: {
        ...(opts.id ? { id: opts.id } : {}),
        gstin,
        stateCode: state,
        code: await freeCode(state),
        active: opts.active ?? true,
        // The development portal (Settings → Branches → e-invoice): a demo GSTIN must never reach the real IRP.
        einvoiceProvider: "mock",
        einvoiceUsername: `demo_${GST_STATE_ABBREVIATIONS[state]?.toLowerCase() ?? state}`,
        ewayIntraStateThreshold: opts.threshold !== undefined ? dec(opts.threshold) : null,
        createdById: controller.id,
      },
      select: { id: true },
    });
    return row.id;
  };

  if (!headOffice) {
    // The head office takes the fixed registration id when it is created (createHeadOffice), and adopting
    // the rows written without a branch then gives them its GSTIN too.
    if (existingRegs.length === 0) await registration(hoState, { id: HEAD_OFFICE_REGISTRATION_ID });
    await ensureHeadOffice();
  } else if (!headOffice.gstRegistrationId) {
    const id = await registration(hoState);
    await app.branch.update({ where: { id: headOffice.id }, data: { gstRegistrationId: id } });
  }
  await adoptUnassigned();
  headOffice = await app.branch.findFirst({ where: { isHeadOffice: true }, include: { gstRegistration: true } });

  const BRANCHES = [
    { code: "BLR", name: "Bengaluru", state: "29", stateName: "Karnataka", city: "Bengaluru", line1: "4th Floor, Prestige Meridian II, 30 MG Road", pincode: "560001", phone: "+91 80 4110 2200", email: "blr@demo.deskzo.invalid", active: true, reg: true, threshold: 100000 },
    { code: "DEL", name: "Delhi NCR", state: "07", stateName: "Delhi", city: "New Delhi", line1: "Unit 512, Ansal Tower, 38 Nehru Place", pincode: "110019", phone: "+91 11 4605 7700", email: "delhi@demo.deskzo.invalid", active: true, reg: true },
    { code: "MAA", name: "Chennai", state: "33", stateName: "Tamil Nadu", city: "Chennai", line1: "2nd Floor, Temple Steps, 184 Anna Salai", pincode: "600015", phone: "+91 44 4350 1900", email: null, active: false, reg: true },
    { code: "CCU", name: "Kolkata liaison office", state: "19", stateName: "West Bengal", city: "Kolkata", line1: "Room 7, Chatterjee International, 33A Jawaharlal Nehru Road", pincode: "700071", phone: "+91 33 4006 2211", email: null, active: true, reg: false },
  ] as const;
  for (const b of BRANCHES) {
    if (await app.branch.findUnique({ where: { code: b.code }, select: { id: true } })) continue;
    const regId = b.reg ? await registration(b.state, { active: b.active, threshold: "threshold" in b ? b.threshold : undefined }) : null;
    await app.branch.create({
      data: {
        name: b.name,
        code: b.code,
        gstRegistrationId: regId,
        addressLine1: b.line1,
        city: b.city,
        state: b.stateName,
        pincode: b.pincode,
        phone: b.phone,
        email: b.email,
        active: b.active,
        ...(b.code === "BLR"
          ? {
              bankName: "HDFC Bank",
              bankAccountNumber: "50200077123456",
              bankIfsc: "HDFC0000075",
              bankBranch: "MG Road, Bengaluru",
              upiId: "deskzo.blr@hdfcbank",
              invoiceTerms: "Payment within 30 days to the Bengaluru account above. Interest at 18% p.a. on overdue amounts.",
            }
          : {}),
        createdById: director.id,
      },
    });
  }
  const branchRows = await app.branch.findMany({ include: { gstRegistration: true } });
  const toBr = async (row: (typeof branchRows)[number]): Promise<Br> => {
    const identity = await branchIdentity(row.id);
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      isHeadOffice: row.isHeadOffice,
      regId: identity.gstRegistrationId,
      gstin: identity.gstin,
      state: identity.stateCode ?? row.gstRegistration?.stateCode ?? null,
      dispatch: formatDispatchAddress(identity),
      roundOff: identity.roundOffTotals,
    };
  };
  const HO = await toBr(branchRows.find((b) => b.isHeadOffice)!);
  const BLR = await toBr(branchRows.find((b) => b.code === "BLR")!);
  const DEL = await toBr(branchRows.find((b) => b.code === "DEL")!);

  // People at the two new offices: a few of the sales team call them home.
  if ((await app.user.count({ where: { branchId: { in: [BLR.id, DEL.id] } } })) === 0) {
    const team = people.filter((p) => (p.dept === "Sales" || p.dept === "Presales & Solutions" || p.dept === "Support") && !p.isManager);
    for (const [i, p] of some(team, 8).entries()) {
      await app.user.update({ where: { id: p.id }, data: { branchId: i % 2 === 0 ? BLR.id : DEL.id } });
    }
  }
  log("Branches", `${branchRows.length} (one inactive, one liaison office without a GSTIN), ${await app.gstRegistration.count()} GST registrations`);

  // ═══ Transporters ═════════════════════════════════════════════════════════════════════════════
  const TRANSPORTERS: { name: string; state: string; mode: TransportMode; contact: string; active: boolean; transin?: boolean }[] = [
    { name: "VRL Logistics Ltd", state: "29", mode: "ROAD", contact: "Ravi Hegde", active: true },
    { name: "Gati-KWE Express", state: "36", mode: "ROAD", contact: "Srinivas Rao", active: true },
    { name: "Blue Dart Express", state: "27", mode: "AIR", contact: "Neha Fernandes", active: true },
    { name: "CONCOR Rail Freight", state: "07", mode: "RAIL", contact: "Ashok Mehra", active: true },
    { name: "Shree Maruti Courier", state: "24", mode: "ROAD", contact: "Bharat Patel", active: true, transin: true },
    { name: "Coastal Container Lines", state: "33", mode: "SHIP", contact: "Joseph Anand", active: false },
  ];
  for (const t of TRANSPORTERS) {
    if (await app.transporter.findFirst({ where: { name: t.name }, select: { id: true } })) continue;
    await app.transporter.create({
      data: {
        name: t.name,
        // A transporter without GST registration gets a TRANSIN from the portal, in the same field.
        gstin: t.transin ? gstinFor(t.state, randomPan(), "0") : gstinFor(t.state, randomPan()),
        contactName: t.contact,
        phone: `+91 9${int(100000000, 999999999)}`,
        email: `dispatch.${t.name.split(" ")[0]!.toLowerCase()}@demo.deskzo.invalid`,
        defaultMode: t.mode,
        notes: t.active ? null : "Stopped using them after two delayed sea consignments — kept for the records that name them.",
        active: t.active,
        createdById: purchaseMgr.id,
      },
    });
  }
  const transporters = await app.transporter.findMany({ where: { active: true }, select: { id: true, name: true, defaultMode: true } });
  const transporterFor = (mode: TransportMode) => transporters.find((t) => t.defaultMode === mode) ?? transporters[0]!;
  log("Transporters", `${await app.transporter.count()}`);

  // ═══ Approval policies ════════════════════════════════════════════════════════════════════════
  // Only where nobody has configured one: a workspace's own policy is its owner's.
  if (!(await app.documentApprovalPolicy.findUnique({ where: { docType: "PROPOSAL" }, select: { docType: true } }))) {
    await app.documentApprovalPolicy.create({
      data: {
        docType: "PROPOSAL",
        enabled: true,
        approverRoles: ["MANAGEMENT"],
        managerApproves: true,
        minValue: dec(500000),
        maxDiscountPercent: new Prisma.Decimal(15),
        approvers: { connect: [{ id: salesHead.id }] },
        updatedById: director.id,
      },
    });
  }
  if (!(await app.documentApprovalPolicy.findUnique({ where: { docType: "PURCHASE_ORDER" }, select: { docType: true } }))) {
    await app.documentApprovalPolicy.create({
      data: {
        docType: "PURCHASE_ORDER",
        enabled: true,
        approverRoles: [],
        managerApproves: false,
        minValue: dec(200000),
        maxDiscountPercent: null,
        approvers: { connect: [{ id: purchaseMgr.id }, { id: controller.id }] },
        updatedById: director.id,
      },
    });
  }
  if (!(await app.documentApprovalPolicy.findUnique({ where: { docType: "CREDIT_NOTE" }, select: { docType: true } }))) {
    // Configured, then switched off — what the policy screen shows for a type somebody tried and dropped.
    await app.documentApprovalPolicy.create({
      data: { docType: "CREDIT_NOTE", enabled: false, approverRoles: ["ACCOUNTS"], managerApproves: false, minValue: dec(100000), updatedById: controller.id },
    });
  }
  log("Approval policies", `${await app.documentApprovalPolicy.count()} — quotes over ${rupees(500000)} or 15% off, purchase orders over ${rupees(200000)}`);

  // ═══ The places some customers buy from ═══════════════════════════════════════════════════════
  /**
   * Every GST treatment needs a buyer that really is one: a unit in a special economic zone, an
   * export-oriented unit, an office abroad, a composition dealer. Each is another location of an
   * existing customer — the way the app keeps a second site — so nothing new appears in the book.
   */
  const locationFor = async (company: Party, spec: Omit<Loc, "id" | "companyId">): Promise<Loc> => {
    const found = (locs.get(company.id) ?? []).find((l) => l.label === spec.label);
    if (found) return found;
    const row = await app.companyLocation.create({
      data: { companyId: company.id, ...spec, isPrimary: false, isBilling: true, isShipping: true },
      select: { id: true, companyId: true, label: true, address: true, city: true, state: true, country: true, pincode: true, gstNumber: true, gstTreatment: true },
    });
    locs.set(company.id, [...(locs.get(company.id) ?? []), row]);
    return row;
  };
  const panOf = (c: Party) => panOfGstin(primary(c)?.gstNumber) ?? randomPan();
  const sezCustomer = nextCustomer();
  const sezLoc = await locationFor(sezCustomer, {
    label: "SEZ unit — Whitefield", address: "Block C, Plot 21, ITPL SEZ, Whitefield", city: "Bengaluru", state: "Karnataka", country: "India", pincode: "560066",
    gstNumber: gstinFor("29", panOf(sezCustomer), "2"), gstTreatment: "SEZ",
  });
  const eouCustomer = nextCustomer();
  const eouLoc = await locationFor(eouCustomer, {
    label: "EOU plant — Sriperumbudur", address: "B-14, SIPCOT Industrial Park, Sriperumbudur", city: "Sriperumbudur", state: "Tamil Nadu", country: "India", pincode: "602105",
    gstNumber: gstinFor("33", panOf(eouCustomer), "3"), gstTreatment: "DEEMED_EXPORT",
  });
  const exportCustomer = nextCustomer();
  const exportLoc = await locationFor(exportCustomer, {
    label: "Singapore office", address: "1 Raffles Place, #20-01 One Raffles Place Tower 2", city: "Singapore", state: null, country: "Singapore", pincode: "048616",
    gstNumber: null, gstTreatment: "OVERSEAS",
  });
  const smallBuyers = unregistered.length >= 4 ? some(unregistered, 4) : some(customers, 4);
  const compositionCustomer = smallBuyers[0]!;
  const compositionLoc = await locationFor(compositionCustomer, {
    label: "Retail counter — Laxmi Road", address: "Shop 4, Shreenath Plaza, Laxmi Road", city: "Pune", state: "Maharashtra", country: "India", pincode: "411030",
    gstNumber: gstinFor("27", randomPan()), gstTreatment: "REGISTERED_COMPOSITION",
  });
  const b2cCustomer = smallBuyers[1]!;
  const consumerCustomer = smallBuyers[2]!;
  const consumerHome = primary(consumerCustomer);
  const consumerLoc = await locationFor(consumerCustomer, {
    label: "Proprietor's residence (personal purchases)", address: "Flat 1202, Sai Siddhi Towers, Hill Road", city: consumerHome.city, state: consumerHome.state, country: "India", pincode: consumerHome.pincode,
    gstNumber: null, gstTreatment: "CONSUMER",
  });
  const b2cSubscriber = smallBuyers[3]!;

  // ═══ Documents ════════════════════════════════════════════════════════════════════════════════

  /** Mirrors createTradeDocument: the tax engine over the lines, the branch's series, a draft. */
  const raise = async (d: DocIn): Promise<Doc> => {
    const isSales = SALES_TYPES.has(d.type);
    const abroad = Boolean(d.loc.country && !/^india$/i.test(d.loc.country.trim()));
    const partyGstin = d.loc.gstNumber?.trim() || null;
    const partyState = stateCodeFromGstin(partyGstin) ?? (abroad ? OTHER_COUNTRY_CODE : stateCodeFromName(d.loc.state));
    const ourState = d.branch.state;
    const destination = isSales ? (d.pos ?? partyState) : (d.pos ?? ourState);
    const supply = isSales ? resolveSupplyType(ourState, destination) : resolveSupplyType(partyState, ourState);
    const lineInputs = d.lines.map((l) => ({
      quantity: l.qty,
      unitPrice: l.price,
      discountMode: l.mode ?? ("PERCENT" as const),
      discountValue: l.discount ?? 0,
      taxRatePercent: d.noTax ? 0 : (l.tax ?? l.item?.tax ?? 18),
    }));
    const totals = computeDocument(lineInputs, supply, {
      shippingCharge: d.shipping?.charge ?? 0,
      shippingTaxRatePercent: d.shipping?.rate ?? 0,
      withholdingMode: d.withholding?.mode ?? "NONE",
      withholdingRatePercent: d.withholding?.rate ?? 0,
      adjustment: d.adjustment?.amount ?? 0,
      roundOff: d.branch.roundOff,
    });
    const zero = d.type === "DELIVERY_CHALLAN" && d.noTax;
    const issueDate = dayOf(d.at);
    const dueDate = d.dueDays !== undefined ? addDay(issueDate, d.dueDays) : null;
    const validUntil = d.validDays !== undefined ? addDay(issueDate, d.validDays) : null;
    const currency = d.currency ?? "INR";
    const rate = currency === "INR" ? 1 : (d.rate ?? 1);
    const sellerGstin = isSales ? d.branch.gstin : partyGstin;
    const buyerGstin = isSales ? partyGstin : d.branch.gstin;
    const billing = {
      billingLine1: d.loc.address,
      billingCity: d.loc.city,
      billingState: d.loc.state,
      billingStateCode: abroad ? OTHER_COUNTRY_CODE : partyState,
      billingPincode: d.loc.pincode,
      billingCountry: d.loc.country || "India",
    };
    const created = await app.$transaction(async (tx) => {
      const docNumber = await nextDocumentNumber(tx, d.type, issueDate, d.branch.id);
      return tx.tradeDocument.create({
        data: {
          docNumber,
          docType: d.type,
          direction: isSales ? "SALES" : "PURCHASE",
          status: "DRAFT",
          origin: d.origin,
          companyId: d.party.id,
          locationId: d.loc.id,
          branchId: d.branch.id,
          gstRegistrationId: d.branch.regId,
          placeOfSupplyCode: destination,
          currency,
          exchangeRate: new Prisma.Decimal(rate),
          sellerGstin,
          buyerGstin,
          gstTreatment: d.treatment ?? d.loc.gstTreatment,
          reverseCharge: false,
          dispatchFromAddress: isSales ? d.branch.dispatch : null,
          ...billing,
          shippingSameAsBilling: true,
          shippingLine1: d.loc.address,
          shippingCity: d.loc.city,
          shippingState: d.loc.state,
          shippingStateCode: abroad ? OTHER_COUNTRY_CODE : partyState,
          shippingPincode: d.loc.pincode,
          shippingCountry: d.loc.country || "India",
          shippingGstin: partyGstin,
          issueDate,
          dueDate,
          validUntil,
          reference: d.reference ?? null,
          notes: d.notes ?? null,
          terms: d.terms ?? null,
          salespersonId: isSales ? (d.salesperson ?? d.party.ownerId ?? d.by.id) : null,
          createdById: d.by.id,
          createdAt: d.at,
          sourceDocumentId: d.sourceId ?? null,
          againstDocumentId: d.againstId ?? null,
          // Only India's tax invoices and credit notes are reported; everything else never is.
          einvoiceStatus: d.type === "INVOICE" || d.type === "CREDIT_NOTE" ? "PENDING" : "NOT_APPLICABLE",
          subtotal: dec(zero ? 0 : totals.subtotal),
          discountTotal: dec(zero ? 0 : totals.discountTotal),
          taxableValue: dec(zero ? 0 : totals.taxableValue),
          cgstAmount: dec(zero ? 0 : totals.cgstAmount),
          sgstAmount: dec(zero ? 0 : totals.sgstAmount),
          igstAmount: dec(zero ? 0 : totals.igstAmount),
          shippingCharge: dec(totals.shippingCharge),
          shippingTaxRatePercent: new Prisma.Decimal(d.shipping?.rate ?? 0),
          withholdingMode: d.withholding?.mode ?? "NONE",
          withholdingSection: d.withholding?.section ?? null,
          withholdingRatePercent: new Prisma.Decimal(d.withholding?.rate ?? 0),
          withholdingAmount: dec(totals.withholdingAmount),
          adjustmentLabel: d.adjustment?.label ?? null,
          adjustment: dec(totals.adjustment),
          roundOff: dec(zero ? 0 : totals.roundOff),
          total: dec(zero ? 0 : totals.total),
          lines: {
            create: d.lines.map((l, i) => {
              const c = totals.lines[i]!;
              return {
                itemId: l.item?.id ?? null,
                companyProductId: l.orderId ?? null,
                servicePeriodFrom: l.from ?? null,
                servicePeriodTo: l.to ?? null,
                name: l.name ?? l.item?.name ?? "Item",
                description: l.description ?? null,
                hsnCode: l.item?.hsnCode ?? null,
                unit: l.item?.unit ?? null,
                quantity: new Prisma.Decimal(l.qty),
                unitPrice: dec(l.price),
                discountMode: l.mode ?? "PERCENT",
                discountValue: dec(l.discount ?? 0),
                discountAmount: dec(c.discountAmount),
                taxRatePercent: new Prisma.Decimal(lineInputs[i]!.taxRatePercent),
                taxableValue: dec(zero ? 0 : c.taxableValue),
                cgstAmount: dec(zero ? 0 : c.cgstAmount),
                sgstAmount: dec(zero ? 0 : c.sgstAmount),
                igstAmount: dec(zero ? 0 : c.igstAmount),
                lineTotal: dec(zero ? 0 : c.lineTotal),
                sortOrder: i,
              };
            }),
          },
        },
        select: { id: true, docNumber: true, total: true, lines: { orderBy: { sortOrder: "asc" }, select: { id: true, name: true, taxableValue: true } } },
      });
    }, TX);
    return {
      id: created.id,
      docNumber: created.docNumber,
      type: d.type,
      party: d.party,
      loc: d.loc,
      branch: d.branch,
      at: d.at,
      issueDate,
      dueDate,
      total: Number(created.total),
      currency,
      rate,
      sellerGstin,
      buyerGstin,
      deliveryState: abroad ? OTHER_COUNTRY_CODE : partyState,
      goods: d.lines.some((l) => l.item?.type === "GOOD"),
      lines: created.lines.map((l) => ({ id: l.id, name: l.name, taxableValue: Number(l.taxableValue) })),
    };
  };

  /** Mirrors issueTradeDocument: the branch's GSTIN snapshotted, the status, and the posting in one transaction. */
  const issue = async (doc: Doc, by: Who, at: Date = doc.at) => {
    await app.$transaction(async (tx) => {
      await tx.tradeDocument.update({
        where: { id: doc.id },
        data: {
          status: "ISSUED",
          issuedAt: capNow(at),
          branchId: doc.branch.id,
          gstRegistrationId: doc.branch.regId,
          ...(SALES_TYPES.has(doc.type) ? { sellerGstin: doc.branch.gstin } : { buyerGstin: doc.branch.gstin }),
        },
      });
      await postDocumentToLedger(tx, doc.id, by.id);
    }, TX);
  };

  /** A customer's answer to a quote, or a purchase order's acceptance — no posting either way. */
  const setStatus = (doc: Doc, status: TradeDocumentStatus) => app.tradeDocument.update({ where: { id: doc.id }, data: { status } });

  /** Mirrors setTradeDocumentStatus(CANCELLED): the posting reversed today, and any billing stage released. */
  const cancel = async (doc: Doc, by: Who) => {
    await app.$transaction(async (tx) => {
      await tx.tradeDocument.update({ where: { id: doc.id }, data: { status: "CANCELLED" } });
      await reverseDocumentPosting(tx, doc.id, by.id);
      await syncBillingMilestones(doc.id, tx);
    }, TX);
  };

  /** Sign-off: asked for, then given or refused (src/actions/document-approval.ts). */
  const submit = (doc: Doc, by: Who, at: Date) =>
    app.tradeDocument.update({ where: { id: doc.id }, data: { approvalStatus: "PENDING", submittedById: by.id, submittedAt: capNow(at), approvalNote: null, approvedById: null, approvedAt: null } });
  const decide = (doc: Doc, by: Who, at: Date, approved: boolean, note: string | null) =>
    app.tradeDocument.update({ where: { id: doc.id }, data: { approvalStatus: approved ? "APPROVED" : "REJECTED", approvedById: by.id, approvedAt: capNow(at), approvalNote: note } });

  /**
   * Issuing behind the sign-off gate, as issueTradeDocument does (`mayIssue`): a document over the
   * policy's limits is submitted and approved by somebody else first; one under them goes straight out.
   */
  const issueSigned = async (doc: Doc, submitter: Who, at: Date, approvers: Who[]) => {
    const [policy, facts] = await Promise.all([approvalPolicyFor(doc.type), approvalDocumentFor(doc.id)]);
    if (facts && approvalRequirement(policy, facts).required) {
      const approver = approvers.find((p) => p.id !== submitter.id) ?? director;
      await submit(doc, submitter, at);
      await decide(doc, approver, plusHours(at, int(1, 4)), true, null);
      await issue(doc, submitter, plusHours(at, 5));
    } else {
      await issue(doc, submitter, at);
    }
  };
  const buyer = () => {
    const team = purchaseTeam.filter((p) => p.id !== purchaseMgr.id);
    return pick(team.length ? team : purchaseTeam);
  };

  /** What the development IRP answers with (src/lib/einvoice/provider.ts MockProvider) — obviously not a real IRN. */
  const irnGenerated = async (doc: Doc, at: Date) => {
    const irn = createHash("sha256").update(`${doc.sellerGstin ?? "URP"}${doc.type}${doc.docNumber}`).digest("hex");
    const ackNo = `11${String(parseInt(irn.slice(0, 11), 16) % 1e13).padStart(13, "0")}`;
    const signedQrCode = Buffer.from(
      JSON.stringify({
        SellerGstin: doc.sellerGstin,
        BuyerGstin: doc.buyerGstin ?? "URP",
        DocNo: doc.docNumber,
        DocTyp: doc.type === "CREDIT_NOTE" ? "CRN" : "INV",
        DocDt: indiaClock.dateKey(doc.issueDate),
        TotInvVal: doc.total,
        Irn: irn,
      }),
    ).toString("base64");
    await app.tradeDocument.update({
      where: { id: doc.id },
      data: { einvoiceStatus: "GENERATED", irn, ackNo, ackDate: capNow(at), signedQrCode, einvoiceError: null },
    });
  };
  const irnFailed = (doc: Doc, error: string) => app.tradeDocument.update({ where: { id: doc.id }, data: { einvoiceStatus: "FAILED", einvoiceError: error } });
  /** B2C: nothing to report to the IRP, so it is not applicable rather than waiting. */
  const irnNotApplicable = (doc: Doc) => app.tradeDocument.update({ where: { id: doc.id }, data: { einvoiceStatus: "NOT_APPLICABLE" } });

  /** Mirrors recordInvoicePayment: the payment, its allocation, its posting and any exchange difference. */
  const receive = async (
    doc: Settles,
    o: { amount: number; at: Date; method: PaymentMethod; by: Who; rate?: number; reference?: string | null; notes?: string | null; bankAccountId?: string | null; clearAfterDays?: number },
  ) => {
    const rate = doc.currency === "INR" ? 1 : (o.rate ?? doc.rate);
    const at = capNow(o.at);
    const paymentId = await app.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: {
          companyId: doc.companyId,
          branchId: doc.branchId,
          direction: "RECEIVED",
          amount: dec(o.amount),
          currency: doc.currency,
          exchangeRate: new Prisma.Decimal(rate),
          paidOn: at,
          method: o.method,
          reference: o.reference ?? null,
          notes: o.notes ?? null,
          bankAccountId: o.method === "CASH" ? null : (o.bankAccountId ?? collectionsBank?.id ?? null),
          recordedByUserId: o.by.id,
          createdAt: plusHours(at, 2),
        },
        select: { id: true },
      });
      await tx.paymentAllocation.create({ data: { paymentId: p.id, documentId: doc.id, amount: dec(o.amount), allocatedByUserId: o.by.id, createdAt: plusHours(at, 2) } });
      await postPaymentToLedger(tx, p.id, o.by.id);
      await postExchangeDifferenceToLedger(tx, { paymentId: p.id, documentId: doc.id, allocatedAmount: o.amount, userId: o.by.id });
      return p.id;
    }, TX);
    await syncInvoiceStatus(doc.id);
    if (o.method === "CHEQUE" && o.clearAfterDays !== undefined) await clearCheque(paymentId, plusDays(at, o.clearAfterDays), o.by);
    return paymentId;
  };

  /** Mirrors clearCheque (src/actions/bank.ts) — only for a day that has come. */
  const clearCheque = async (paymentId: string, on: Date, by: Who) => {
    if (on.getTime() > Date.now()) return;
    const clearedOn = dayOf(on);
    await app.$transaction(async (tx) => {
      await tx.payment.update({ where: { id: paymentId }, data: { clearedOn } });
      await postChequeClearingToLedger(tx, paymentId, by.id, clearedOn);
    }, TX);
  };

  /** Mirrors recordBillPayment: money out against a vendor bill, and the bill's status after it. */
  const payBill = async (
    bill: Settles,
    o: { amount: number; at: Date; method: PaymentMethod; by: Who; rate?: number; reference?: string | null; notes?: string | null; clearAfterDays?: number },
  ) => {
    const rate = bill.currency === "INR" ? 1 : (o.rate ?? bill.rate);
    const at = capNow(o.at);
    const paymentId = await app.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: {
          companyId: bill.companyId,
          branchId: bill.branchId,
          direction: "PAID",
          amount: dec(o.amount),
          currency: bill.currency,
          exchangeRate: new Prisma.Decimal(rate),
          paidOn: at,
          method: o.method,
          reference: o.reference ?? null,
          notes: o.notes ?? null,
          recordedByUserId: o.by.id,
          createdAt: plusHours(at, 1),
        },
        select: { id: true },
      });
      await tx.paymentAllocation.create({ data: { paymentId: p.id, documentId: bill.id, amount: dec(o.amount), allocatedByUserId: o.by.id, createdAt: plusHours(at, 1) } });
      await postPaymentToLedger(tx, p.id, o.by.id);
      await postExchangeDifferenceToLedger(tx, { paymentId: p.id, documentId: bill.id, allocatedAmount: o.amount, userId: o.by.id });
      const after = await tx.tradeDocument.findUniqueOrThrow({
        where: { id: bill.id },
        select: { total: true, payments: { select: { amount: true } }, creditsReceived: { select: { amount: true } }, vendorCredits: { select: { amount: true } } },
      });
      const sum = (rows: { amount: Prisma.Decimal }[]) => rows.reduce((t, r) => t + Number(r.amount), 0);
      const settlement = settleInvoice(Number(after.total), sum(after.payments), sum(after.creditsReceived) + sum(after.vendorCredits));
      await tx.tradeDocument.update({ where: { id: bill.id }, data: { status: settlement.balance < 0.01 ? "PAID" : "PARTIALLY_PAID" } });
      return p.id;
    }, TX);
    if (o.method === "CHEQUE" && o.clearAfterDays !== undefined) await clearCheque(paymentId, plusDays(at, o.clearAfterDays), o.by);
    return paymentId;
  };

  /** Mirrors applyCreditNote: a credit note set against its invoice, and the invoice's status after it. */
  const applyCredit = async (cn: Doc, invoice: Doc, amount: number, by: Who, at: Date) => {
    await app.creditNoteApplication.create({ data: { creditNoteId: cn.id, invoiceId: invoice.id, amount: dec(amount), appliedByUserId: by.id, createdAt: capNow(at) } });
    await syncInvoiceStatus(invoice.id);
  };

  const settles = (d: Doc): Settles => ({ id: d.id, companyId: d.party.id, branchId: d.branch.id, currency: d.currency, rate: d.rate, docType: d.type });

  /** Roughly how far the goods travel — what Part A of an e-way bill asks for. */
  const DISTANCE: Record<string, number> = {
    "27": 38, "07": 1420, "06": 1395, "09": 1360, "08": 1150, "29": 985, "33": 1335, "36": 710, "24": 530,
    "19": 1960, "23": 590, "32": 1210, "04": 1660, "96": 0,
  };
  const distanceTo = (from: string | null, to: string | null) => {
    if (from && to && from === to) return int(12, 60);
    if (from === "07" && (to === "09" || to === "06")) return int(30, 60);
    return DISTANCE[to ?? ""] ?? 900;
  };
  let ewaySerial = 0;
  /** An e-way bill as the eway actions leave one: saved, generated, recorded from the portal, refused, or cancelled. */
  const ewayBill = async (
    doc: { id: string; total: number; branchState: string | null; deliveryState: string | null; docNumber: string },
    o: {
      status: "REQUIRED" | "GENERATED" | "FAILED" | "CANCELLED";
      at: Date;
      by: Who;
      mode?: TransportMode;
      vehicleType?: VehicleType;
      vehicle?: string | null;
      associated?: boolean;
      error?: string;
      cancelReason?: string;
      value?: number;
    },
  ) => {
    const mode = o.mode ?? "ROAD";
    const transporter = transporterFor(mode);
    const distanceKm = Math.max(1, distanceTo(doc.branchState, doc.deliveryState));
    const vehicleType = o.vehicleType ?? "REGULAR";
    const generated = o.status === "GENERATED" || o.status === "CANCELLED";
    const at = capNow(o.at);
    ewaySerial += 1;
    const number = `${int(1, 3)}${String(int(10_000_000, 99_999_999))}${String(ewaySerial).padStart(3, "0")}`;
    await app.ewayBill.create({
      data: {
        documentId: doc.id,
        declaredValue: dec(o.value ?? doc.total),
        interstate: Boolean(doc.branchState && doc.deliveryState && doc.branchState !== doc.deliveryState),
        distanceKm,
        transporterId: transporter.id,
        transportMode: mode,
        vehicleType,
        vehicleNumber: mode === "ROAD" ? (o.vehicle ?? `${["MH", "KA", "DL", "GJ"][int(0, 3)]}${String(int(1, 48)).padStart(2, "0")}${"ABCDEFGHJK"[int(0, 9)]}${"LMNPRSTUVW"[int(0, 9)]}${int(1000, 9999)}`) : null,
        transportDocNumber: mode === "ROAD" ? `LR${int(100000, 999999)}` : mode === "RAIL" ? `RR/${int(10000, 99999)}` : mode === "AIR" ? `AWB ${int(1000000, 9999999)}` : `BL/${int(1000, 9999)}/26`,
        transportDocDate: dayOf(at),
        status: o.status,
        ewayBillNumber: generated ? number : null,
        ewayBillDate: generated ? at : null,
        validUntil: generated ? validityFor(at, distanceKm, vehicleType).validUntil : null,
        error: o.status === "FAILED" ? (o.error ?? "702: The distance between the pincodes given is too high or low") : null,
        cancelledAt: o.status === "CANCELLED" ? plusHours(at, int(2, 9)) : null,
        cancelReason: o.status === "CANCELLED" ? (o.cancelReason ?? "Vehicle changed after loading — bill raised again with the new vehicle") : null,
        associated: o.associated ?? false,
        createdById: o.by.id,
        createdAt: at,
      },
    });
  };
  const ewayOf = (doc: Doc) => ({ id: doc.id, total: doc.total, branchState: doc.branch.state, deliveryState: doc.deliveryState, docNumber: doc.docNumber });

  // A period of service as the line holds it: calendar days.
  const yearFrom = (start: Date) => ({ from: start, to: addDay(new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate())), -1) });
  const monthsFrom = (start: Date, months: number) => ({ from: start, to: addDay(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, start.getUTCDate())), -1) });

  // The deemed export below is raised unconditionally, and nothing else in the demo raises one.
  const docsDone = (await app.tradeDocument.count({ where: { gstTreatment: "DEEMED_EXPORT" } })) > 0;
  /** Documents the later sections come back to — the subscriptions revenue works on, the bill a prepaid is made from — by the part they play. */
  const byRole: Record<string, Doc> = {};
  let documentCount = 0;
  let paymentsIn = 0;

  if (!docsDone) {
    const c = (party: Party = nextCustomer()) => ({ party, loc: primary(party) });
    const mh = inState(["27"]);
    const dl = inState(["07"]);
    const near = inState(["09", "06"]);
    const south = inState(["33", "32", "36"]);
    const fromList = (list: Party[]) => (list.length ? c(pick(list)) : c());

    // ── 1. A Mumbai sale: freight, a flat discount, its IRN and its e-way bill, paid in full ──────
    {
      const { party, loc } = fromList(mh);
      const doc = await raise({
        type: "INVOICE", party, loc, branch: HO, at: workday(52), origin: "MANUAL", by: exec(), dueDays: 30,
        lines: [
          { item: itemNamed("Latitude", goods), qty: 6, price: itemNamed("Latitude", goods).price },
          { item: itemNamed("UPS", goods), qty: 2, price: itemNamed("UPS", goods).price, mode: "AMOUNT", discount: 5000, description: "Festive offer — ₹5,000 off the pair" },
        ],
        shipping: { charge: 2500, rate: 18 },
        reference: `PO/${party.name.split(" ")[0]!.toUpperCase()}/2026/${int(100, 999)}`,
        terms: "Goods once sold will not be taken back. Warranty as per OEM terms.",
      });
      await issue(doc, exec(), doc.at);
      await irnGenerated(doc, plusHours(doc.at, 1));
      await ewayBill(ewayOf(doc), { status: "GENERATED", at: plusHours(doc.at, 3), by: pick(support.length ? support : execs), mode: "ROAD" });
      await receive(settles(doc), { amount: doc.total, at: workday(38), method: "BANK_TRANSFER", by: exec(), reference: `UTR HDFCN${int(100000000, 999999999)}` });
      documentCount += 1;
      paymentsIn += 1;
    }

    // ── 2. Bengaluru's services to a southern customer, the customer deducting TDS ────────────────
    {
      const { party, loc } = fromList(south);
      const vapt = itemNamed("VAPT", services);
      const amc = itemNamed("Comprehensive", services);
      const doc = await raise({
        type: "INVOICE", party, loc, branch: BLR, at: workday(78), origin: "MANUAL", by: exec(), dueDays: 45,
        lines: [
          { item: vapt, qty: 1, price: vapt.price, description: "External and internal VAPT, two rounds, with the retest report" },
          { item: amc, qty: 4, price: amc.price, discount: 5 },
        ],
        withholding: { mode: "TDS", section: "194J", rate: 10 },
        notes: "TDS under section 194J is deducted by you; please share Form 16A each quarter.",
      });
      await issue(doc, exec(), doc.at);
      await irnGenerated(doc, plusHours(doc.at, 2));
      await receive(settles(doc), { amount: r2(doc.total * 0.6), at: workday(48), method: "UPI", by: exec(), reference: `UPI/${int(100000000000, 999999999999)}`, notes: "Part payment — balance after their AMC sign-off" });
      documentCount += 1;
      paymentsIn += 1;
    }

    // ── 3. A Delhi sale of goods, TCS collected, an over-dimensional consignment, unpaid ─────────
    {
      const { party, loc } = fromList(dl.length ? dl : near);
      const server = itemNamed("PowerEdge", goods);
      const ups = itemNamed("UPS", goods);
      const doc = await raise({
        type: "INVOICE", party, loc, branch: HO, at: workday(112), origin: "MANUAL", by: exec(), dueDays: 30,
        lines: [
          { item: server, qty: 2, price: server.price },
          { item: ups, qty: 4, price: ups.price, discount: 4 },
        ],
        withholding: { mode: "TCS", section: "206C(1H)", rate: 0.1 },
        notes: "TCS collected under section 206C(1H).",
      });
      await issue(doc, exec(), doc.at);
      await irnGenerated(doc, plusHours(doc.at, 1));
      await ewayBill(ewayOf(doc), { status: "GENERATED", at: plusHours(doc.at, 20), by: purchaseMgr, mode: "ROAD", vehicleType: "OVER_DIMENSIONAL_CARGO" });
      documentCount += 1;
    }

    // ── 4. A supply to an SEZ unit, its bill recorded from the portal, paid by cheque ─────────────
    {
      const firewall = itemNamed("Sophos XGS", goods);
      const install = itemNamed("Firewall Installation", services);
      const doc = await raise({
        type: "INVOICE", party: sezCustomer, loc: sezLoc, branch: HO, at: workday(96), origin: "MANUAL", by: exec(), dueDays: 30, treatment: "SEZ",
        lines: [
          { item: firewall, qty: 2, price: firewall.price },
          { item: install, qty: 2, price: install.price },
        ],
        notes: "Supply to SEZ unit on payment of IGST.",
      });
      await issue(doc, exec(), doc.at);
      await irnGenerated(doc, plusHours(doc.at, 1));
      await ewayBill(ewayOf(doc), { status: "GENERATED", at: plusHours(doc.at, 5), by: exec(), mode: "AIR", associated: true });
      await receive(settles(doc), { amount: doc.total, at: workday(70), method: "CHEQUE", by: exec(), reference: `Chq ${int(100000, 999999)} — Axis Bank`, clearAfterDays: 3 });
      documentCount += 1;
      paymentsIn += 1;
    }

    // ── 5. A deemed export to an EOU: the IRP refused it, and so did the e-way portal ─────────────
    {
      const nas = itemNamed("Synology", goods);
      const hdd = itemNamed("IronWolf", goods);
      const doc = await raise({
        type: "INVOICE", party: eouCustomer, loc: eouLoc, branch: HO, at: workday(24), origin: "MANUAL", by: exec(), dueDays: 30, treatment: "DEEMED_EXPORT",
        lines: [
          { item: nas, qty: 3, price: nas.price },
          { item: hdd, qty: 12, price: hdd.price, discount: 3 },
        ],
        notes: "Supply to an EOU against Form A — deemed export.",
      });
      await issue(doc, exec(), doc.at);
      await irnFailed(doc, `3028: GSTIN - ${doc.buyerGstin} is not present in invoice registration portal`);
      await ewayBill(ewayOf(doc), { status: "FAILED", at: plusHours(doc.at, 2), by: exec(), error: "240: Could not retrieve transporter details from gstin" });
      documentCount += 1;
    }

    // ── 6–7. Exports in dollars: one settled at a better rate, one part-paid at a worse one ───────
    for (const [daysBack, bookRate, paidRate, share] of [
      [140, 83.1, 84.05, 1],
      [58, 83.4, 82.65, 0.5],
    ] as const) {
      const doc = await raise({
        type: "INVOICE", party: exportCustomer, loc: exportLoc, branch: HO, at: workday(daysBack), origin: "MANUAL", by: exec(), dueDays: 30,
        treatment: "OVERSEAS", pos: OTHER_COUNTRY_CODE, currency: "USD", rate: bookRate, noTax: true,
        lines: [
          { name: "Microsoft 365 tenant consolidation — APAC offices", description: "Fixed fee, 3 tenants into 1", qty: 1, price: 6800, tax: 0 },
          { item: itemNamed("Managed IT Support", services), name: "Managed IT support — remote, per seat per month", qty: 120, price: 9.5, tax: 0 },
        ],
        notes: "Export of services under LUT ARN AD270326012345X — no IGST charged.",
        terms: "Payable in USD by SWIFT to our EEFC account. Bank charges outside India are the remitter's.",
      });
      await issue(doc, exec(), doc.at);
      await irnGenerated(doc, plusHours(doc.at, 2));
      await receive(settles(doc), {
        amount: r2(doc.total * share), at: plusDays(doc.at, int(20, 30)), method: "BANK_TRANSFER", by: controller, rate: paidRate,
        reference: `SWIFT ${int(10000000, 99999999)}`, notes: `Converted at ₹${paidRate} by the bank on the day`,
      });
      documentCount += 1;
      paymentsIn += 1;
    }

    // ── 8. A composition dealer's counter: issued two days ago, its IRN and e-way still pending ───
    {
      const ap = itemNamed("UniFi", goods);
      const doc = await raise({
        type: "INVOICE", party: compositionCustomer, loc: compositionLoc, branch: HO, at: workday(2), origin: "MANUAL", by: exec(), dueDays: 15,
        treatment: "REGISTERED_COMPOSITION",
        lines: [{ item: ap, qty: 6, price: ap.price }],
      });
      await issue(doc, exec(), doc.at);
      await ewayBill(ewayOf(doc), { status: "REQUIRED", at: plusHours(doc.at, 1), by: exec() });
      documentCount += 1;
    }

    // ── 9–10. Unregistered buyers: a small office paying cash, a consumer paying by card ─────────
    {
      const optiplex = itemNamed("OptiPlex", goods);
      const doc = await raise({
        type: "INVOICE", party: b2cCustomer, loc: primary(b2cCustomer), branch: HO, at: workday(64), origin: "MANUAL", by: exec(), dueDays: 0,
        treatment: "UNREGISTERED",
        lines: [{ item: optiplex, qty: 1, price: optiplex.price, mode: "AMOUNT", discount: 1500 }],
      });
      await issue(doc, exec(), doc.at);
      await irnNotApplicable(doc);
      await receive(settles(doc), { amount: doc.total, at: plusHours(doc.at, 2), method: "CASH", by: exec(), reference: "Cash receipt CR-118", notes: "Paid at the counter" });
      const laptop = itemNamed("ThinkPad", goods);
      const consumer = await raise({
        type: "INVOICE", party: consumerCustomer, loc: consumerLoc, branch: HO, at: workday(33), origin: "MANUAL", by: exec(), dueDays: 0,
        treatment: "CONSUMER",
        lines: [
          { item: laptop, qty: 1, price: laptop.price, description: "For the proprietor's personal use" },
          { item: itemNamed("Windows 11", goods), qty: 1, price: itemNamed("Windows 11", goods).price },
        ],
      });
      await issue(consumer, exec(), consumer.at);
      await irnNotApplicable(consumer);
      await receive(settles(consumer), { amount: consumer.total, at: plusHours(consumer.at, 1), method: "CARD", by: exec(), reference: `POS ${int(100000, 999999)} — HDFC VISA ••4417` });
      documentCount += 2;
      paymentsIn += 2;
    }

    // ── 11. Its IRN generated and cancelled inside the portal's 24 hours — raised to the wrong buyer ─
    /** Earlier today in office hours, or yesterday evening before the office opens — always under 24 hours ago. */
    const withinTheDay = () => {
      const p = indiaClock.parts(now);
      const morning = indiaClock.at(p.year, p.month, p.day, 9, 30);
      if (now.getTime() - 3_600_000 >= morning.getTime()) return new Date(Math.max(morning.getTime(), now.getTime() - 6 * 3_600_000));
      return indiaClock.at(p.year, p.month, p.day - 1, 18, 0);
    };
    {
      const { party, loc } = c();
      const doc = await raise({
        type: "INVOICE", party, loc, branch: HO, at: withinTheDay(), origin: "MANUAL", by: exec(), dueDays: 30,
        lines: [{ item: itemNamed("ProBook", goods), qty: 3, price: itemNamed("ProBook", goods).price }],
      });
      await issue(doc, exec(), doc.at);
      await irnGenerated(doc, plusHours(doc.at, 1));
      await app.$transaction(async (tx) => {
        await tx.tradeDocument.update({
          where: { id: doc.id },
          data: { einvoiceStatus: "CANCELLED", einvoiceCancelledAt: capNow(new Date()), einvoiceCancelReason: "Raised on the group company's GSTIN by mistake — to be reissued to the right entity", status: "CANCELLED" },
        });
        await reverseDocumentPosting(tx, doc.id, controller.id);
        await syncBillingMilestones(doc.id, tx);
      }, TX);
      documentCount += 1;
    }

    // ── 12. Cancelled a week after issue: the order was withdrawn before delivery ────────────────
    {
      const doc = await raise({
        type: "INVOICE", party: smallBuyers[3]!, loc: primary(smallBuyers[3]!), branch: HO, at: workday(7), origin: "MANUAL", by: exec(), dueDays: 15,
        treatment: "UNREGISTERED",
        lines: [{ item: itemNamed("Rally Bar", goods), qty: 1, price: itemNamed("Rally Bar", goods).price }],
      });
      await issue(doc, exec(), doc.at);
      await irnNotApplicable(doc);
      byRole.cancelledLater = doc;
      documentCount += 1;
    }

    // ── 13. Drafts: one dated last month (the close will notice), one this week ──────────────────
    {
      const lastMonthEnd = (() => {
        const p = indiaClock.parts(now);
        return indiaClock.at(p.year, p.month, 0, 16, 10);
      })();
      const lateDraft = c();
      await raise({
        type: "INVOICE", ...lateDraft, branch: HO, at: lastMonthEnd, origin: "MANUAL", by: exec(), dueDays: 30,
        lines: [{ item: itemNamed("On-site Engineer", services), qty: 6, price: itemNamed("On-site Engineer", services).price }],
        notes: "Waiting for the customer's visit sign-off sheet before issuing.",
      });
      const draft = c();
      await raise({
        type: "INVOICE", ...draft, branch: DEL, at: workday(0, 11), origin: "MANUAL", by: exec(), dueDays: 30,
        lines: [{ item: itemNamed("Catalyst", goods), qty: 2, price: itemNamed("Catalyst", goods).price }],
      });
      documentCount += 2;
    }

    // ── 14. An invoice, a unit returned against it (credit note with its IRN), the rest paid ──────
    {
      const { party, loc } = fromList(mh);
      const nas = itemNamed("Latitude 3550", goods);
      const doc = await raise({
        type: "INVOICE", party, loc, branch: HO, at: workday(88), origin: "MANUAL", by: exec(), dueDays: 30,
        lines: [{ item: nas, qty: 10, price: nas.price, discount: 6 }],
      });
      await issue(doc, exec(), doc.at);
      await irnGenerated(doc, plusHours(doc.at, 1));
      const cnAt = plusDays(doc.at, 9);
      const cn = await raise({
        type: "CREDIT_NOTE", party, loc, branch: doc.branch, at: cnAt, origin: "CONVERSION", by: controller, againstId: doc.id,
        lines: [{ item: nas, qty: 1, price: nas.price, discount: 6, description: "One unit returned — dead on arrival, replaced by the OEM directly" }],
      });
      await issue(cn, controller, cnAt);
      await irnGenerated(cn, plusHours(cnAt, 1));
      await applyCredit(cn, doc, cn.total, controller, plusHours(cnAt, 2));
      await receive(settles(doc), { amount: r2(doc.total - cn.total), at: plusDays(doc.at, 26), method: "BANK_TRANSFER", by: exec(), reference: `NEFT ${int(100000000, 999999999)}` });
      documentCount += 2;
      paymentsIn += 1;
    }

    // ── 15. Subscriptions billed after Revenue & Close was switched on — earned month by month ────
    const subPlans: [string, number, number, Br, "paid" | "part" | "open"][] = [
      ["E3", 170, 40, HO, "paid"],
      ["Business Premium", 150, 85, HO, "paid"],
      ["Creative Cloud", 128, 12, HO, "part"],
      ["AutoCAD (Annual)", 104, 6, BLR, "paid"],
      ["Acronis", 86, 120, DEL, "paid"],
      ["Business Standard", 66, 60, HO, "open"],
      ["Revit", 45, 2, HO, "paid"],
      ["Teams Phone", 31, 90, DEL, "open"],
    ];
    for (const [i, [name, daysBack, seats, branch, paid]] of subPlans.entries()) {
      const item = itemNamed(name, subs);
      const partyPool = branch === DEL ? (dl.length ? dl : near) : branch === BLR ? south : registered;
      const { party, loc } = partyPool.length ? c(partyPool[i % partyPool.length]!) : c();
      const at = workday(daysBack);
      const period = yearFrom(dayOf(at));
      const qty = item.price > 50000 ? Math.max(1, Math.round(seats / 20)) : seats;
      const doc = await raise({
        type: "INVOICE", party, loc, branch, at, origin: "MANUAL", by: exec(), dueDays: 30,
        lines: [{ item, qty, price: item.price, discount: chance(0.5) ? int(2, 8) : 0, from: period.from, to: period.to, description: `Subscription term ${indiaClock.date(period.from)} – ${indiaClock.date(period.to)}` }],
      });
      await issue(doc, exec(), at);
      await irnGenerated(doc, plusHours(at, 1));
      if (paid === "paid") {
        await receive(settles(doc), { amount: doc.total, at: plusDays(at, int(12, 35)), method: pick(["BANK_TRANSFER", "BANK_TRANSFER", "UPI", "CHEQUE"] as const), by: exec(), reference: `NEFT ${int(100000000, 999999999)}`, clearAfterDays: 2 });
        paymentsIn += 1;
      } else if (paid === "part") {
        await receive(settles(doc), { amount: r2(doc.total * 0.5), at: plusDays(at, 30), method: "BANK_TRANSFER", by: exec(), reference: `RTGS ${int(100000000, 999999999)}`, notes: "First of two instalments, as agreed" });
        paymentsIn += 1;
      }
      byRole[`sub${i}`] = doc;
      documentCount += 1;
    }

    // A quarter's licences billed six months ago: every month of it is past, so its schedule will complete.
    {
      const item = itemNamed("Adobe Acrobat", subs);
      const { party, loc } = c();
      const at = workday(178);
      const period = monthsFrom(dayOf(at), 3);
      const doc = await raise({
        type: "INVOICE", party, loc, branch: HO, at, origin: "MANUAL", by: exec(), dueDays: 30,
        lines: [{ item, name: `${item.name} — quarterly`, qty: 25, price: r2(item.price / 4), from: period.from, to: period.to, description: "Quarterly term while they evaluate the annual plan" }],
      });
      await issue(doc, exec(), at);
      await irnGenerated(doc, plusHours(at, 1));
      await receive(settles(doc), { amount: doc.total, at: plusDays(at, 18), method: "BANK_TRANSFER", by: exec(), reference: `NEFT ${int(100000000, 999999999)}` });
      documentCount += 1;
      paymentsIn += 1;
    }

    // A small office's subscription, billed two months ago without a GSTIN — cancelled later, its months already earning.
    {
      const item = itemNamed("Business Basic", subs);
      const at = workday(62);
      const period = yearFrom(dayOf(at));
      const doc = await raise({
        type: "INVOICE", party: b2cSubscriber, loc: primary(b2cSubscriber), branch: HO, at, origin: "MANUAL", by: exec(), dueDays: 15, treatment: "UNREGISTERED",
        lines: [{ item, qty: 40, price: item.price, from: period.from, to: period.to }],
      });
      await issue(doc, exec(), at);
      await irnNotApplicable(doc);
      byRole.toCancel = doc;
      documentCount += 1;
    }

    // Seats taken off a subscription: a credit note against it, which comes off its deferred revenue.
    {
      // Business Standard, 60 seats, still unpaid: a quarter of the seats released before any of it was paid.
      const base = byRole.sub5!;
      const line = await app.tradeDocumentLine.findFirstOrThrow({ where: { documentId: base.id }, select: { itemId: true, unitPrice: true, discountValue: true, servicePeriodFrom: true, servicePeriodTo: true, quantity: true } });
      const item = items.find((i) => i.id === line.itemId)!;
      const at = plusDays(base.at, 41);
      const cn = await raise({
        type: "CREDIT_NOTE", party: base.party, loc: base.loc, branch: base.branch, at, origin: "CONVERSION", by: controller, againstId: base.id,
        lines: [{ item, qty: Math.max(1, Math.round(Number(line.quantity) / 4)), price: Number(line.unitPrice), discount: Number(line.discountValue), from: line.servicePeriodFrom, to: line.servicePeriodTo, description: "Seats released mid-term — their warehouse staff moved to a frontline plan" }],
      });
      await issue(cn, controller, at);
      await irnGenerated(cn, plusHours(at, 2));
      await applyCredit(cn, base, cn.total, controller, plusHours(at, 3));
      documentCount += 1;
    }

    // ── 16. Renewals: quoted from the renewals list, one accepted and invoiced for next year ──────
    {
      const due = await app.companyProduct.findMany({
        where: {
          companyId: { in: customers.map((x) => x.id) },
          orderStatus: { in: ["FULFILLED", "PROCESSING", "APPROVED"] },
          endDate: { gte: now, lte: new Date(now.getTime() + 45 * DAY) },
          item: { type: "SUBSCRIPTION" },
        },
        orderBy: { endDate: "asc" },
        take: 2,
        select: { id: true, companyId: true, locationId: true, quantity: true, unitPrice: true, endDate: true, item: { select: { id: true } } },
      });
      for (const [i, order] of due.entries()) {
        const party = ctx.companies.find((x) => x.id === order.companyId)!;
        const loc = (locs.get(party.id) ?? []).find((l) => l.id === order.locationId) ?? primary(party);
        const item = items.find((x) => x.id === order.item.id)!;
        const start = addDay(dayOf(order.endDate!), 1);
        const period = yearFrom(start);
        const at = workday(i === 0 ? 12 : 4);
        const price = r2(Number(order.unitPrice ?? item.price) * 1.05);
        const quote = await raise({
          type: "PROPOSAL", party, loc, branch: HO, at, origin: "RENEWAL", by: { id: ownerOf(party), name: "" }, validDays: 21,
          lines: [{ item, qty: order.quantity, price, orderId: order.id, from: period.from, to: period.to, description: "Renewal for the next term — 5% list price increase from the publisher" }],
          notes: "Renewal quotation. Prices held until the term ends.",
        });
        await issueSigned(quote, { id: ownerOf(party), name: "" }, at, [salesHead, gm]);
        if (i === 0) {
          await setStatus(quote, "ACCEPTED");
          const invoiceAt = workday(3);
          const invoice = await raise({
            type: "INVOICE", party, loc, branch: HO, at: invoiceAt, origin: "CONVERSION", by: exec(), dueDays: 30, sourceId: quote.id,
            lines: [{ item, qty: order.quantity, price, orderId: order.id, from: period.from, to: period.to, description: "Renewal — next term" }],
          });
          await issue(invoice, exec(), invoiceAt);
          await irnGenerated(invoice, plusHours(invoiceAt, 1));
          byRole.renewal = invoice;
          documentCount += 1;
        }
        documentCount += 1;
      }
    }

    // ── 17. Seats added part-way through a term: the pro-rata calculator's quotation ─────────────
    {
      const order = await app.companyProduct.findFirst({
        where: {
          companyId: { in: customers.map((x) => x.id) },
          orderStatus: { in: ["FULFILLED", "PROCESSING"] },
          endDate: { gte: new Date(now.getTime() + 90 * DAY) },
          item: { type: "SUBSCRIPTION" },
        },
        orderBy: { endDate: "asc" },
        select: { id: true, companyId: true, locationId: true, endDate: true, unitPrice: true, item: { select: { id: true } } },
      });
      if (order) {
        const party = ctx.companies.find((x) => x.id === order.companyId)!;
        const loc = (locs.get(party.id) ?? []).find((l) => l.id === order.locationId) ?? primary(party);
        const item = items.find((x) => x.id === order.item.id)!;
        const at = workday(5);
        const from = dayOf(at);
        const to = dayOf(order.endDate!);
        const days = Math.round((to.getTime() - from.getTime()) / DAY) + 1;
        const fullPrice = Number(order.unitPrice ?? item.price);
        const seats = int(5, 15);
        const quote = await raise({
          type: "PROPOSAL", party, loc, branch: HO, at, origin: "ADDON_CALCULATOR", by: { id: ownerOf(party), name: "" }, validDays: 15,
          lines: [{ item, qty: seats, price: r2((fullPrice * days) / 365), orderId: order.id, from, to, description: `${seats} seats added mid-term — ${days} of 365 days, co-terminous with the existing subscription` }],
        });
        await issueSigned(quote, { id: ownerOf(party), name: "" }, at, [salesHead, gm]);
        documentCount += 1;
      }
    }

    // ── 18. Quotations through sign-off: approved, waiting, sent back, and the customer's answers ─
    {
      const server = itemNamed("PowerEdge", goods);
      const firewall = itemNamed("Sophos XGS", goods);
      const web = itemNamed("Website", services);
      const bigQuote = (party: Party, at: Date, discount = 5) =>
        raise({
          type: "PROPOSAL", party, loc: primary(party), branch: HO, at, origin: "MANUAL", by: { id: ownerOf(party), name: "" }, validDays: 30,
          lines: [
            { item: server, qty: 2, price: server.price, discount },
            { item: firewall, qty: 1, price: firewall.price, discount },
          ],
        });
      // Approved by the head of sales, then sent, then accepted.
      const approved = await bigQuote(nextCustomer(), workday(46));
      await submit(approved, { id: ownerOf(approved.party), name: "" }, approved.at);
      await decide(approved, salesHead, plusHours(approved.at, 5), true, "Margin is fine at this discount — go ahead.");
      await issue(approved, { id: ownerOf(approved.party), name: "" }, plusHours(approved.at, 6));
      await setStatus(approved, "ACCEPTED");
      // Approved and sent; the customer is still deciding.
      const sent = await bigQuote(nextCustomer(), workday(9));
      await submit(sent, { id: ownerOf(sent.party), name: "" }, sent.at);
      await decide(sent, gm, plusHours(sent.at, 20), true, "Approved — match their earlier quote from the other bidder if asked.");
      await issue(sent, { id: ownerOf(sent.party), name: "" }, plusHours(sent.at, 22));
      // Waiting on the approver now.
      const waiting = await bigQuote(nextCustomer(), workday(1, 16));
      await submit(waiting, { id: ownerOf(waiting.party), name: "" }, plusHours(waiting.at, 1));
      // Sent back: 20% off is more than anybody may give without a reason.
      const heavy = await bigQuote(nextCustomer(), workday(6), 20);
      await submit(heavy, { id: ownerOf(heavy.party), name: "" }, heavy.at);
      await decide(heavy, salesHead, plusHours(heavy.at, 26), false, "20% is below our cost on the server. Hold at 12% or swap to the R350 configuration.");
      // A draft nobody has submitted yet.
      const party = nextCustomer();
      await raise({
        type: "PROPOSAL", party, loc: primary(party), branch: DEL, at: workday(2), origin: "MANUAL", by: { id: ownerOf(party), name: "" }, validDays: 30,
        lines: [{ item: web, qty: 1, price: web.price }],
      });
      // The customer said no; and one withdrawn by us.
      for (const [status, daysBack] of [["REJECTED", 70], ["CANCELLED", 40]] as const) {
        const p = nextCustomer();
        const quote = await raise({
          type: "PROPOSAL", party: p, loc: primary(p), branch: pick([HO, BLR, DEL]), at: workday(daysBack), origin: "MANUAL", by: { id: ownerOf(p), name: "" }, validDays: 30,
          lines: [{ item: itemNamed("ThinkPad", goods), qty: int(4, 12), price: itemNamed("ThinkPad", goods).price, discount: 5 }],
          notes: status === "REJECTED" ? "Customer chose a competitor's offer — lower price on a 3-year warranty." : "Withdrawn: the customer merged the requirement into their annual tender.",
        });
        await issueSigned(quote, { id: ownerOf(p), name: "" }, quote.at, [salesHead, gm]);
        await setStatus(quote, status);
      }
      documentCount += 7;
    }

    // ── 19. Purchase orders through sign-off, and the bills behind them ──────────────────────────
    {
      const vendorLoc = (v: Party) => primary(v);
      const po = async (at: Date, lines: LineIn[], by: Who = pick(purchaseTeam)) => {
        const v = nextVendor();
        return raise({ type: "PURCHASE_ORDER", party: v, loc: vendorLoc(v), branch: pick([HO, HO, BLR]), at, origin: "MANUAL", by, lines, terms: "Delivery within 7 days. Invoice must quote our PO number." });
      };
      const costLine = (item: Item, qty: number): LineIn => ({ item, qty, price: r2(item.cost || item.price * 0.82) });

      // Approved, issued, accepted, and billed against.
      const big = await po(workday(68), [costLine(itemNamed("PowerEdge", goods), 2), costLine(itemNamed("UPS", goods), 2)]);
      await submit(big, buyer(), big.at);
      await decide(big, purchaseMgr, plusHours(big.at, 4), true, "Within budget for the Delhi data-centre refresh.");
      await issue(big, purchaseMgr, plusHours(big.at, 5));
      await setStatus(big, "ACCEPTED");
      const bill = await raise({
        type: "BILL", party: big.party, loc: big.loc, branch: big.branch, at: plusDays(big.at, 6), origin: "CONVERSION", by: exec(), dueDays: 30, sourceId: big.id,
        lines: [costLine(itemNamed("PowerEdge", goods), 2), costLine(itemNamed("UPS", goods), 2)],
        reference: `INV/${int(1000, 9999)}/26-27`,
      });
      await issue(bill, exec(), bill.at);

      // A services bill with TDS under 194C withheld from the vendor.
      const cabler = nextVendor();
      const install = await raise({
        type: "BILL", party: cabler, loc: primary(cabler), branch: HO, at: workday(55), origin: "MANUAL", by: exec(), dueDays: 15,
        lines: [{ name: "Structured cabling — 120 nodes, Andheri office", qty: 120, price: 1850, tax: 18 }],
        withholding: { mode: "TDS", section: "194C", rate: 2 },
        reference: `CAB/${int(100, 999)}`,
      });
      await issue(install, exec(), install.at);

      // Waiting for the purchase manager; a draft; one cancelled because the customer cancelled.
      const waiting = await po(workday(1, 12), [costLine(itemNamed("Rally Bar", goods), 2)]);
      await submit(waiting, pick(purchaseTeam), plusHours(waiting.at, 1));
      await po(workday(0, 10), [costLine(itemNamed("Latitude", goods), 4)]);
      const dropped = await po(workday(36), [costLine(itemNamed("ProBook", goods), 3)]);
      await issueSigned(dropped, buyer(), dropped.at, [purchaseMgr, controller]);
      await setStatus(dropped, "CANCELLED");

      // The annual support contract we prepay, and a bill entered twice and cancelled.
      const supportVendor = nextVendor();
      const annual = await raise({
        type: "BILL", party: supportVendor, loc: primary(supportVendor), branch: HO, at: workday(122), origin: "MANUAL", by: exec(), dueDays: 30,
        lines: [{ name: "Annual OEM premium support — 24×7, 4-hour response (12 months)", qty: 1, price: 240000, tax: 18 }],
        reference: `SUP/${int(1000, 9999)}`,
        notes: "Prepaid for the year — expensed monthly under Prepaids & accruals.",
      });
      await issue(annual, exec(), annual.at);
      byRole.prepaidBill = annual;
      const dup = await raise({
        type: "BILL", party: bill.party, loc: bill.loc, branch: HO, at: workday(5), origin: "MANUAL", by: exec(), dueDays: 30,
        lines: [costLine(itemNamed("UPS", goods), 2)],
        reference: "Duplicate of the vendor's invoice already entered",
      });
      await issue(dup, exec(), dup.at);
      await cancel(dup, controller);
      documentCount += 8;

      // Money out against these bills — by bank, by cheque, and by the company card.
      await payBill(settles(bill), { amount: bill.total, at: plusDays(bill.at, 28), method: "BANK_TRANSFER", by: controller, reference: `NEFT ${int(100000000, 999999999)}` });
      await payBill(settles(install), { amount: r2(install.total / 2), at: plusDays(install.at, 14), method: "CHEQUE", by: controller, reference: `Our chq ${int(100000, 999999)}`, clearAfterDays: 4 });
      await payBill(settles(annual), { amount: annual.total, at: plusDays(annual.at, 10), method: "CARD", by: controller, reference: "Corporate card ••8812", notes: "Paid on the corporate card to lock the price" });
    }

    // ── 20. Delivery challans: raised by consignments, one by hand, one cancelled ───────────────
    {
      const consignments = await app.consignment.findMany({
        where: { reason: { in: ["REPAIR_OUT", "DEPLOYMENT", "COLLECTION", "REPAIR_RETURN"] }, status: { not: "DRAFT" }, documentId: null, toCompanyId: { in: ctx.companies.map((x) => x.id) } },
        orderBy: { consignmentNumber: "asc" },
        select: { id: true, consignmentNumber: true, reason: true, toCompanyId: true, toLocationId: true, dispatchedOn: true, declaredValue: true, createdById: true, branchId: true, toContact: { select: { name: true, phone: true } } },
      });
      let raised = 0;
      for (const consignment of consignments) {
        if (raised >= 3) break;
        const assets = await app.asset.findMany({
          where: { OR: [{ siteCompanyId: consignment.toCompanyId }, { ownerCompanyId: consignment.toCompanyId }] },
          take: 3,
          select: { assetTag: true, name: true, make: true, model: true, serialNumber: true, purchaseCost: true, item: { select: { hsnCode: true } } },
        });
        if (assets.length === 0) continue;
        const party = ctx.companies.find((x) => x.id === consignment.toCompanyId);
        if (!party) continue;
        const loc = (locs.get(party.id) ?? []).find((l) => l.id === consignment.toLocationId) ?? primary(party);
        const identity = await branchIdentity(consignment.branchId ?? HO.id);
        const at = capNow(consignment.dispatchedOn ?? workday(30));
        const deliveryState = stateCodeFromGstin(loc.gstNumber) ?? stateCodeFromName(loc.state);
        const REASON: Record<string, string> = { REPAIR_OUT: "Sent for repair", DEPLOYMENT: "Deployment at site", COLLECTION: "Collection from site", REPAIR_RETURN: "Returned after repair" };
        // Mirrors raiseDeliveryChallan: one line per asset, valued for identification, nothing charged.
        const doc = await app.$transaction(async (tx) => {
          const issueDate = dayOf(at);
          const docNumber = await nextDocumentNumber(tx, "DELIVERY_CHALLAN", issueDate, identity.branchId);
          const created = await tx.tradeDocument.create({
            data: {
              docNumber, docType: "DELIVERY_CHALLAN", direction: "SALES", status: "ISSUED", origin: "CONSIGNMENT",
              companyId: party.id, locationId: loc.id, issueDate, issuedAt: at, createdAt: at, createdById: consignment.createdById,
              branchId: identity.branchId, gstRegistrationId: identity.gstRegistrationId,
              dispatchFromAddress: formatDispatchAddress(identity),
              sellerGstin: identity.gstin, buyerGstin: loc.gstNumber, shippingSameAsBilling: true,
              shippingAttention: consignment.toContact?.name ?? party.name, shippingLine1: loc.address, shippingCity: loc.city, shippingState: loc.state,
              shippingStateCode: deliveryState, shippingPincode: loc.pincode, shippingPhone: consignment.toContact?.phone ?? null, shippingGstin: loc.gstNumber,
              placeOfSupplyCode: deliveryState,
              taxableValue: dec(0), cgstAmount: dec(0), sgstAmount: dec(0), igstAmount: dec(0), total: dec(0),
              notes: `${REASON[consignment.reason] ?? consignment.reason} — consignment ${consignment.consignmentNumber}. Not a supply; no tax charged.`,
              lines: {
                create: assets.map((a, i) => ({
                  name: `${a.assetTag} — ${a.name}`,
                  description: [a.make, a.model, a.serialNumber ? `S/N ${a.serialNumber}` : null].filter(Boolean).join(" · ") || null,
                  quantity: new Prisma.Decimal(1),
                  hsnCode: a.item?.hsnCode ?? null,
                  unitPrice: dec(Number(a.purchaseCost ?? 0)),
                  taxRatePercent: new Prisma.Decimal(0),
                  taxableValue: dec(0),
                  lineTotal: dec(0),
                  sortOrder: i,
                })),
              },
            },
            select: { id: true, docNumber: true },
          });
          await tx.consignment.update({ where: { id: consignment.id }, data: { documentId: created.id } });
          return created;
        }, TX);
        if (Number(consignment.declaredValue ?? 0) > 50000) {
          await ewayBill(
            { id: doc.id, total: Number(consignment.declaredValue), branchState: identity.stateCode, deliveryState, docNumber: doc.docNumber },
            { status: "GENERATED", at: plusHours(at, 1), by: pick(support.length ? support : execs), mode: raised === 0 ? "RAIL" : "ROAD", value: Number(consignment.declaredValue) },
          );
        }
        raised += 1;
        documentCount += 1;
      }
      // By hand: demo units out to a customer on loan; and one cancelled when the event was called off.
      for (const [daysBack, cancelled] of [[16, false], [27, true]] as const) {
        const p = nextCustomer();
        const doc = await raise({
          type: "DELIVERY_CHALLAN", party: p, loc: primary(p), branch: HO, at: workday(daysBack), origin: "MANUAL", by: pick(support.length ? support : execs), noTax: true,
          lines: [{ item: itemNamed("Rally Bar", goods), qty: 1, price: itemNamed("Rally Bar", goods).price, tax: 0, description: "Demo unit on loan for 15 days — returnable" }],
          notes: cancelled ? "For the customer's tech day — event postponed, unit never left the warehouse." : "Returnable demo unit. Not a supply; no tax charged.",
        });
        await issue(doc, controller, doc.at);
        if (cancelled) await cancel(doc, controller);
        else await ewayBill(ewayOf({ ...doc, total: itemNamed("Rally Bar", goods).price }), { status: "GENERATED", at: plusHours(doc.at, 1), by: controller, mode: "ROAD", value: itemNamed("Rally Bar", goods).price });
        documentCount += 1;
      }
    }

    // ── 21. E-way bills on goods the demo invoiced: one cancelled and raised again, by sea, by rail ─
    {
      const demoInvoices = await app.tradeDocument.findMany({
        where: { docType: "INVOICE", status: { in: ["ISSUED", "PAID", "PARTIALLY_PAID"] }, companyId: { in: customers.map((x) => x.id) }, ewayBills: { none: {} }, total: { gt: 60000 }, lines: { some: { item: { type: "GOOD" } } }, origin: "MANUAL", einvoiceStatus: "NOT_APPLICABLE" },
        orderBy: { issueDate: "desc" },
        take: 4,
        select: { id: true, docNumber: true, total: true, issueDate: true, placeOfSupplyCode: true, branchId: true },
      });
      for (const [i, d] of demoInvoices.entries()) {
        const at = indiaClock.at(d.issueDate.getUTCFullYear(), d.issueDate.getUTCMonth(), d.issueDate.getUTCDate(), 15, 30);
        const target = { id: d.id, total: Number(d.total), branchState: HO.state, deliveryState: d.placeOfSupplyCode, docNumber: d.docNumber };
        if (i === 0) {
          await ewayBill(target, { status: "CANCELLED", at, by: exec(), mode: "ROAD" });
          await ewayBill(target, { status: "GENERATED", at: plusHours(at, 12), by: exec(), mode: "ROAD" });
        } else {
          await ewayBill(target, { status: "GENERATED", at, by: exec(), mode: i === 1 ? "SHIP" : i === 2 ? "RAIL" : "ROAD" });
        }
      }
    }
    log("Documents", `${documentCount} raised through the app's numbering and posting, ${paymentsIn} receipts against them, ${await app.ewayBill.count()} e-way bills`);
  } else {
    log("Documents", "already there — skipped");
  }

  // ═══ Money out against the demo's own bills ═══════════════════════════════════════════════════
  {
    const unpaid = await app.tradeDocument.findMany({
      where: { docType: "BILL", status: { in: ["PAID", "ISSUED"] }, payments: { none: {} }, companyId: { in: vendors.map((v) => v.id) } },
      orderBy: { issueDate: "asc" },
      select: { id: true, companyId: true, branchId: true, currency: true, exchangeRate: true, total: true, status: true, issueDate: true, dueDate: true },
    });
    const methods: PaymentMethod[] = ["BANK_TRANSFER", "BANK_TRANSFER", "UPI", "CHEQUE", "CASH", "CARD", "OTHER"];
    let paid = 0;
    let openIssued = 0;
    // Run once: the demo marks bills PAID without any money against them, and this is what puts it there.
    const firstTime = unpaid.some((b) => b.status === "PAID");
    for (const [i, bill] of (firstTime ? unpaid : []).entries()) {
      const issued = indiaClock.at(bill.issueDate.getUTCFullYear(), bill.issueDate.getUTCMonth(), bill.issueDate.getUTCDate(), 11, 0);
      const due = bill.dueDate ? indiaClock.at(bill.dueDate.getUTCFullYear(), bill.dueDate.getUTCMonth(), bill.dueDate.getUTCDate(), 12, 0) : plusDays(issued, 30);
      const at = new Date(Math.min(due.getTime() + int(-6, 4) * DAY, Date.now() - DAY));
      if (at.getTime() <= issued.getTime()) continue;
      const s: Settles = { id: bill.id, companyId: bill.companyId, branchId: bill.branchId, currency: bill.currency, rate: Number(bill.exchangeRate), docType: "BILL" };
      const total = Number(bill.total);
      const method = methods[i % methods.length]!;
      const ref =
        method === "CASH" ? "Petty cash voucher PCV-" + int(100, 999)
        : method === "CARD" ? "Corporate card ••8812"
        : method === "OTHER" ? `Paid through the bank's vendor-finance facility — VF/${int(1000, 9999)}`
        : method === "CHEQUE" ? `Our chq ${int(100000, 999999)}`
        : `NEFT ${int(100000000, 999999999)}`;
      if (bill.status === "PAID") {
        await payBill(s, { amount: total, at, method, by: pick([controller, ...execs]), reference: ref, clearAfterDays: method === "CHEQUE" ? 3 : undefined });
        paid += 1;
      } else if (openIssued < 6) {
        // Of the ones still open: part paid, paid in full, or left for the payables list.
        const mode = openIssued % 3;
        if (mode === 0) await payBill(s, { amount: r2(total * 0.4), at, method: "BANK_TRANSFER", by: controller, reference: ref, notes: "First instalment — rest on delivery of the balance quantity" });
        if (mode === 1) await payBill(s, { amount: total, at, method: method === "CASH" ? "BANK_TRANSFER" : method, by: controller, reference: ref, clearAfterDays: method === "CHEQUE" ? 3 : undefined });
        openIssued += 1;
        if (mode !== 2) paid += 1;
      }
    }
    log("Vendor payments", `${paid} made against the demo's bills — ${await app.payment.count({ where: { direction: "PAID" } })} payments out in all`);
  }

  // Customers' cheques banked a week ago or more have cleared — out of cheques in hand, into the bank.
  {
    const waiting = await app.payment.findMany({
      // Only inside the company's life: the demo dates some receipts before it opened, and clearing those would date the bank entry there too.
      where: { method: "CHEQUE", clearedOn: null, direction: "RECEIVED", companyId: { in: ctx.companies.map((x) => x.id) }, paidOn: { gte: FOUNDED, lt: new Date(now.getTime() - 7 * DAY) } },
      orderBy: { paidOn: "asc" },
      select: { id: true, paidOn: true },
    });
    let cleared = 0;
    for (const p of waiting) {
      // The last one is still with the bank — a cheque in transit is what the reconciliation is for.
      if (cleared === waiting.length - 1) break;
      await clearCheque(p.id, plusDays(p.paidOn, int(2, 4)), exec());
      cleared += 1;
    }
    if (cleared) log("Cheques cleared", `${cleared} customer cheques out of cheques in hand and into the bank`);
  }

  // ═══ Vendor credits ═══════════════════════════════════════════════════════════════════════════
  {
    const openBill = await app.tradeDocument.findFirst({
      where: { docType: "BILL", status: { in: ["ISSUED", "PARTIALLY_PAID"] }, currency: "INR", companyId: { in: vendors.map((v) => v.id) }, total: { gt: 30000 } },
      orderBy: { issueDate: "desc" },
      select: { id: true, companyId: true, total: true, cgstAmount: true, payments: { select: { amount: true } }, vendorCredits: { select: { amount: true } } },
    });
    const credits: { vendorId: string; form: "CREDIT_NOTE" | "PAYOUT"; kind: "PRICE_DIFFERENCE" | "OTHER"; reference: string; daysBack: number; taxable: number; intra: boolean; billId?: string; cancel?: string }[] = [];
    if (openBill) {
      credits.push({ vendorId: openBill.companyId, form: "CREDIT_NOTE", kind: "PRICE_DIFFERENCE", reference: `CN/${int(1000, 9999)}/26-27`, daysBack: 9, taxable: 12000, intra: Number(openBill.cgstAmount) > 0, billId: openBill.id });
    }
    const oem = vendors.find((v) => v.relationship === "OEM") ?? vendors[0]!;
    credits.push({ vendorId: oem.id, form: "PAYOUT", kind: "OTHER", reference: `MDF-Q1-${int(1000, 9999)}`, daysBack: 41, taxable: 50000, intra: false });
    const distributor = vendors.find((v) => v.relationship === "DISTRIBUTOR") ?? vendors[1] ?? vendors[0]!;
    credits.push({ vendorId: distributor.id, form: "CREDIT_NOTE", kind: "OTHER", reference: `CN/${int(1000, 9999)}/DUP`, daysBack: 20, taxable: 8000, intra: distributor.stateCode === HO.state, cancel: "Recorded against the wrong distributor — their credit note was for the Pune branch account" });
    let made = 0;
    for (const v of credits) {
      if (await app.vendorCredit.findFirst({ where: { vendorId: v.vendorId, kind: v.kind, form: v.form }, select: { id: true } })) continue;
      const gst = v.form === "CREDIT_NOTE" ? r2(v.taxable * 0.18) : 0;
      const cgst = v.intra ? r2(gst / 2) : 0;
      const sgst = v.intra ? r2(gst - cgst) : 0;
      const igst = v.intra ? 0 : gst;
      const total = r2(v.taxable + gst);
      const date = dayOf(workday(v.daysBack));
      const by = controller;
      // Mirrors createVendorCredit: the credit, what it is set against, and its posting, together.
      const id = await app.$transaction(async (tx) => {
        const credit = await tx.vendorCredit.create({
          data: {
            vendorId: v.vendorId, form: v.form, kind: v.kind, reference: v.reference, date,
            taxableAmount: dec(v.taxable), cgstAmount: dec(cgst), sgstAmount: dec(sgst), igstAmount: dec(igst), total: dec(total),
            bankAccountId: v.form === "PAYOUT" ? (collectionsBank?.id ?? null) : null,
            notes: v.kind === "PRICE_DIFFERENCE" ? "Billed above the agreed deal price — difference credited." : v.form === "PAYOUT" ? "Marketing development funds for the joint webinar series, paid into the bank." : null,
            createdById: by.id,
            createdAt: plusHours(indiaClock.at(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 11, 0), 1),
          },
          select: { id: true },
        });
        if (v.billId) {
          const bill = await tx.tradeDocument.findUniqueOrThrow({ where: { id: v.billId }, select: { total: true, payments: { select: { amount: true } }, creditsReceived: { select: { amount: true } }, vendorCredits: { select: { amount: true } }, status: true } });
          const sum = (rows: { amount: Prisma.Decimal }[]) => rows.reduce((t, r) => t + Number(r.amount), 0);
          const balance = settleInvoice(Number(bill.total), sum(bill.payments), sum(bill.creditsReceived) + sum(bill.vendorCredits)).balance;
          const amount = r2(Math.min(total, balance));
          if (amount > 0) {
            await tx.vendorCreditApplication.create({ data: { vendorCreditId: credit.id, billId: v.billId, amount: dec(amount), createdById: by.id } });
            const after = settleInvoice(Number(bill.total), sum(bill.payments), sum(bill.creditsReceived) + sum(bill.vendorCredits) + amount);
            await tx.tradeDocument.update({ where: { id: v.billId }, data: { status: settledStatus(after) } });
          }
        }
        await postVendorCreditToLedger(tx, credit.id, by.id);
        return credit.id;
      }, TX);
      if (v.cancel) {
        // Mirrors cancelVendorCredit: undone where it was set, its posting reversed today.
        await app.$transaction(async (tx) => {
          await tx.vendorCreditApplication.deleteMany({ where: { vendorCreditId: id } });
          await reverseVendorCreditPosting(tx, id, by.id);
          await tx.vendorCredit.update({ where: { id }, data: { cancelledAt: capNow(new Date()), cancelledById: by.id, cancelReason: v.cancel } });
        }, TX);
      }
      made += 1;
    }
    log("Vendor credits", `${made} — a price difference set against a bill, funds paid into the bank, one cancelled`);
  }

  // ═══ Fixed assets ═════════════════════════════════════════════════════════════════════════════
  const departments = ctx.departments;
  const ASSETS: { tag: string; name: string; code: string; cost: number; method: "STRAIGHT_LINE" | "WRITTEN_DOWN_VALUE"; life: number; rate?: number; daysBack: number; dept: string; opening?: boolean; vendor?: boolean; custodian?: boolean; dispose?: { daysBack: number; proceeds: number; note: string } }[] = [
    { tag: "FA-1001", name: "Dell Latitude 5450 laptops (×12) — sales team", code: "1210", cost: 1140000, method: "WRITTEN_DOWN_VALUE", life: 3, rate: 40, daysBack: 365, dept: "Sales", opening: true },
    { tag: "FA-1002", name: "Cisco Catalyst core switches & FortiGate 100F", code: "1210", cost: 680000, method: "STRAIGHT_LINE", life: 5, daysBack: 300, dept: "Support", vendor: true },
    { tag: "FA-1003", name: "Conference room VC kit — Poly Studio X50", code: "1210", cost: 325000, method: "STRAIGHT_LINE", life: 5, daysBack: 236, dept: "Management", custodian: true },
    { tag: "FA-1004", name: "Modular workstations (×24) — Bengaluru office", code: "1220", cost: 860000, method: "STRAIGHT_LINE", life: 10, daysBack: 198, dept: "Sales", vendor: true },
    { tag: "FA-1005", name: "Toyota Innova Crysta — MH01 DE 4421", code: "1230", cost: 2150000, method: "STRAIGHT_LINE", life: 8, daysBack: 365, dept: "Management", opening: true, custodian: true },
    { tag: "FA-1006", name: "Hyundai Venue — sales pool car (MH02 FK 7710)", code: "1230", cost: 1040000, method: "STRAIGHT_LINE", life: 8, daysBack: 365, dept: "Sales", opening: true, dispose: { daysBack: 48, proceeds: 790000, note: "Sold to an employee at the valuer's price after the pool moved to leased cars." } },
    { tag: "FA-1007", name: "APC 20 kVA online UPS — server room", code: "1210", cost: 295000, method: "STRAIGHT_LINE", life: 7, daysBack: 121, dept: "Support", custodian: true },
    { tag: "FA-1008", name: "Ergonomic chairs (×40) — Andheri office", code: "1220", cost: 440000, method: "STRAIGHT_LINE", life: 10, daysBack: 62, dept: "HR & Admin", vendor: true },
  ];
  const assetIds = new Map<string, string>();
  for (const a of ASSETS) {
    const existing = await app.fixedAsset.findUnique({ where: { tag: a.tag }, select: { id: true } });
    if (existing) {
      assetIds.set(a.tag, existing.id);
      continue;
    }
    const accountId = accountsByCode.get(a.code);
    if (!accountId) continue;
    const purchased = a.opening ? dayOf(FOUNDED) : dayOf(workday(a.daysBack));
    const row = await app.fixedAsset.create({
      data: {
        tag: a.tag,
        name: a.name,
        purchasedOn: purchased,
        cost: dec(a.cost),
        salvageValue: dec(a.method === "STRAIGHT_LINE" ? Math.round(a.cost * 0.05) : 0),
        usefulLifeYears: a.life,
        method: a.method,
        ratePercent: a.rate ? new Prisma.Decimal(a.rate) : null,
        assetAccountId: accountId,
        vendorCompanyId: a.vendor ? pick(vendors).id : null,
        departmentId: departments.get(a.dept) ?? null,
        custodianUserId: a.custodian ? pick(people).id : null,
        createdById: controller.id,
        createdAt: a.opening ? FOUNDED : plusHours(indiaClock.at(purchased.getUTCFullYear(), purchased.getUTCMonth(), purchased.getUTCDate(), 12, 0), 2),
      },
      select: { id: true },
    });
    assetIds.set(a.tag, row.id);
  }

  // ═══ The books: opening balances and what was written by hand ═════════════════════════════════
  const accountId = async (key: (typeof SYSTEM_ACCOUNTS)[keyof typeof SYSTEM_ACCOUNTS]) =>
    (await resolveAccounts(app as unknown as Prisma.TransactionClient, [key])).get(key)!;
  /** Mirrors createManualJournal: one balanced entry through writeEntry, once. */
  const journal = async (o: {
    date: Date;
    narration: string;
    source?: "MANUAL" | "OPENING";
    by: Who;
    lines: { accountId: string; debit: number; credit: number; companyId?: string | null; branchId?: string | null; gstRegistrationId?: string | null; narration?: string | null; departmentId?: string | null }[];
    reversesId?: string | null;
  }) => {
    const found = await app.journalEntry.findFirst({ where: { narration: o.narration, source: o.source ?? "MANUAL" }, select: { id: true } });
    if (found) return found.id;
    const entry = await app.$transaction(
      (tx) =>
        writeEntry(tx, {
          date: o.date,
          narration: o.narration,
          source: o.source ?? "MANUAL",
          userId: o.by.id,
          lines: o.lines.filter((l) => l.debit !== 0 || l.credit !== 0).map((l) => ({ ...l, debit: r2(l.debit), credit: r2(l.credit) })),
          reversesId: o.reversesId ?? null,
        }),
      TX,
    );
    return entry.id;
  };

  // A workspace that already has opening balances keeps its own; the assets brought in at opening are then capitalised below.
  const OPENING_NARRATION = "Opening balances — bank, cash and the fixed assets brought into the books";
  const opening = await app.journalEntry.findFirst({ where: { source: "OPENING" }, select: { id: true } });
  if (!opening) {
    const openingDate = indiaClock.at(indiaClock.parts(FOUNDED).year, indiaClock.parts(FOUNDED).month, indiaClock.parts(FOUNDED).day, 10, 0);
    const cash = await accountId(SYSTEM_ACCOUNTS.CASH);
    const obe = await accountId(SYSTEM_ACCOUNTS.OPENING_BALANCE_EQUITY);
    const secondBank = banks.find((b) => b.id !== mainBank?.id)?.ledgerAccountId ?? null;
    const atOpening = ASSETS.filter((a) => a.opening && accountsByCode.get(a.code));
    const assetLines = atOpening.map((a) => ({ accountId: accountsByCode.get(a.code)!, debit: a.cost, credit: 0, narration: `${a.tag} ${a.name}` }));
    const lines = [
      { accountId: bankLedgerId, debit: 6500000, credit: 0, narration: "Balance as per bank certificate" },
      ...(secondBank ? [{ accountId: secondBank, debit: 1500000, credit: 0, narration: "Balance as per bank certificate" }] : []),
      { accountId: cash, debit: 85000, credit: 0, narration: "Cash counted at the office" },
      ...assetLines,
    ];
    const total = lines.reduce((t, l) => t + l.debit, 0);
    await journal({ date: openingDate, narration: OPENING_NARRATION, source: "OPENING", by: controller, lines: [...lines, { accountId: obe, debit: 0, credit: total }] });
    const capital = accountsByCode.get("3100");
    if (capital) {
      await journal({
        date: plusDays(openingDate, 1),
        narration: "Opening balance equity transferred to the proprietors' capital, as agreed with the auditors",
        by: controller,
        lines: [
          { accountId: obe, debit: total, credit: 0 },
          { accountId: capital, debit: 0, credit: total },
        ],
      });
    }
  }

  // Assets bought during the year come onto the books when they are paid for.
  // Only the demo's assets — this seed's, and the ones prisma/demo/finance.ts registers — never a workspace's own.
  const demoAssets = { OR: [{ tag: { in: ASSETS.map((a) => a.tag) } }, { createdById: { in: people.map((p) => p.id) } }] } satisfies Prisma.FixedAssetWhereInput;
  const openedWithAssets = Boolean(await app.journalEntry.findFirst({ where: { source: "OPENING", narration: OPENING_NARRATION }, select: { id: true } }));
  for (const a of await app.fixedAsset.findMany({ where: { disposedOn: null, ...demoAssets }, select: { id: true, tag: true, name: true, cost: true, purchasedOn: true, assetAccountId: true } })) {
    const spec = ASSETS.find((x) => x.tag === a.tag);
    if (spec?.opening && openedWithAssets) continue;
    const at = indiaClock.at(a.purchasedOn.getUTCFullYear(), a.purchasedOn.getUTCMonth(), a.purchasedOn.getUTCDate(), 13, 0);
    await journal({
      date: capNow(at),
      narration: `Capitalised ${a.tag} ${a.name} — paid from the bank`,
      by: controller,
      lines: [
        { accountId: a.assetAccountId, debit: Number(a.cost), credit: 0 },
        { accountId: bankLedgerId, debit: 0, credit: Number(a.cost) },
      ],
    });
  }

  // Rent, every month, at the head office and in Bengaluru; bank charges the bank took.
  {
    const rent = accountsByCode.get("5400");
    const other = await accountId(SYSTEM_ACCOUNTS.EXP_OTHER);
    let months = 0;
    for (const { year: y, month0: m } of indianMonths(FOUNDED, now).slice(1)) {
      const label = `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m]} ${y}`;
      const fifth = indiaClock.at(y, m, 5, 11, 0);
      if (fifth.getTime() > Date.now()) break;
      if (rent) {
        await journal({
          date: fifth,
          narration: `Office rent — ${label}, Andheri head office (standing instruction)`,
          by: exec(),
          lines: [
            { accountId: rent, debit: 185000, credit: 0, branchId: HO.id, departmentId: departments.get("HR & Admin") ?? null },
            { accountId: bankLedgerId, debit: 0, credit: 185000, branchId: HO.id },
          ],
        });
        await journal({
          date: fifth,
          narration: `Office rent — ${label}, Bengaluru (MG Road)`,
          by: exec(),
          lines: [
            { accountId: rent, debit: 68500, credit: 0, branchId: BLR.id },
            { accountId: bankLedgerId, debit: 0, credit: 68500, branchId: BLR.id },
          ],
        });
      }
      const lastDayOfMonth = indiaClock.at(y, m + 1, 0, 18, 0);
      if (lastDayOfMonth.getTime() < Date.now()) {
        const charges = r2(int(220, 1800) * 1.18);
        await journal({
          date: lastDayOfMonth,
          narration: `Bank charges — ${label} (NEFT/RTGS fees and GST on them, per statement)`,
          by: exec(),
          lines: [
            { accountId: other, debit: charges, credit: 0 },
            { accountId: bankLedgerId, debit: 0, credit: charges },
          ],
        });
      }
      months += 1;
    }

    // A courier bill keyed to Rent by mistake, and the reversal that undid it.
    if (rent) {
      const at = workday(26, 12);
      const wrong = await journal({
        date: at,
        narration: "Courier charges — Blue Dart, September consolidated bill",
        by: exec(),
        lines: [
          { accountId: rent, debit: 14280, credit: 0, branchId: HO.id },
          { accountId: bankLedgerId, debit: 0, credit: 14280, branchId: HO.id },
        ],
      });
      const original = await app.journalEntry.findUniqueOrThrow({ where: { id: wrong }, select: { entryNumber: true, companyId: true, reversedBy: { select: { id: true } }, lines: { orderBy: { sortOrder: "asc" }, select: reversibleLineSelect } } });
      if (!original.reversedBy) {
        await app.$transaction(
          (tx) =>
            writeEntry(tx, {
              date: plusDays(at, 2),
              narration: `Reversal of ${original.entryNumber} — posted to Rent instead of Courier & Postage`,
              source: "MANUAL",
              userId: controller.id,
              lines: reversedLines(original.lines),
              companyId: original.companyId,
              reversesId: wrong,
            }),
          TX,
        );
        const courier = await accountId(SYSTEM_ACCOUNTS.EXP_COURIER);
        await journal({
          date: plusDays(at, 2),
          narration: "Courier charges — Blue Dart, September consolidated bill (re-posted to Courier & Postage)",
          by: controller,
          lines: [
            { accountId: courier, debit: 14280, credit: 0, branchId: HO.id },
            { accountId: bankLedgerId, debit: 0, credit: 14280, branchId: HO.id },
          ],
        });
      }
    }
    log("Manual journals", `opening balances, ${months} months of rent and bank charges, capitalised assets, a reversal`);
  }

  // GST paid each month for the head office's registration: output set off against input, the rest by challan.
  if (HO.regId) {
    const keys = [SYSTEM_ACCOUNTS.OUTPUT_CGST, SYSTEM_ACCOUNTS.OUTPUT_SGST, SYSTEM_ACCOUNTS.OUTPUT_IGST, SYSTEM_ACCOUNTS.INPUT_CGST, SYSTEM_ACCOUNTS.INPUT_SGST, SYSTEM_ACCOUNTS.INPUT_IGST] as const;
    const ids = await resolveAccounts(app as unknown as Prisma.TransactionClient, [...keys]);
    let paid = 0;
    for (let back = 4; back >= 1; back--) {
      const p = indiaClock.parts(now);
      const from = indiaClock.at(p.year, p.month - back, 1, 0, 0);
      const to = indiaClock.at(p.year, p.month - back + 1, 1, 0, 0);
      const dueOn = indiaClock.at(p.year, p.month - back + 1, 20, 12, 0);
      if (dueOn.getTime() > Date.now()) continue;
      const label = `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][indiaClock.parts(from).month]} ${indiaClock.parts(from).year}`;
      const sums = await app.journalLine.groupBy({
        by: ["accountId"],
        where: { accountId: { in: [...ids.values()] }, gstRegistrationId: HO.regId, entry: { date: { gte: from, lt: to }, companyId: { in: ctx.companies.map((x) => x.id) } } },
        _sum: { debit: true, credit: true },
      });
      const net = (key: (typeof keys)[number]) => {
        const row = sums.find((s) => s.accountId === ids.get(key));
        const debit = Number(row?._sum.debit ?? 0);
        const credit = Number(row?._sum.credit ?? 0);
        return r2(key.startsWith("OUTPUT") ? credit - debit : debit - credit);
      };
      const outputs = keys.filter((k) => k.startsWith("OUTPUT")).map((k) => ({ k, v: net(k) })).filter((x) => x.v > 0);
      const inputs = keys.filter((k) => k.startsWith("INPUT")).map((k) => ({ k, v: net(k) })).filter((x) => x.v > 0);
      const out = r2(outputs.reduce((t, x) => t + x.v, 0));
      const inp = r2(inputs.reduce((t, x) => t + x.v, 0));
      if (out <= inp || out === 0) continue;
      await journal({
        date: dueOn,
        narration: `GST for ${label} — GSTR-3B (${HO.gstin}): input tax set off, the balance paid by challan`,
        by: controller,
        lines: [
          ...outputs.map((x) => ({ accountId: ids.get(x.k)!, debit: x.v, credit: 0, gstRegistrationId: HO.regId, branchId: HO.id })),
          ...inputs.map((x) => ({ accountId: ids.get(x.k)!, debit: 0, credit: x.v, gstRegistrationId: HO.regId, branchId: HO.id })),
          { accountId: bankLedgerId, debit: 0, credit: r2(out - inp), branchId: HO.id, narration: "Cash ledger — challan paid by net banking" },
        ],
      });
      paid += 1;
    }
    log("GST paid", `${paid} months set off and paid for ${HO.gstin}`);
  }

  // ═══ Depreciation, month by month, and the car that was sold ══════════════════════════════════
  {
    let charged = 0;
    const months: { year: number; month: number }[] = [];
    for (const { year: y, month0 } of indianMonths(FOUNDED, now).slice(0, -1)) {
      const m = month0 + 1;
      // A month is charged once it is over in India (runDepreciation's rule).
      if (indiaClock.midnight(y, m, 1).getTime() > Date.now()) break;
      months.push({ year: y, month: m });
    }
    const disposal = ASSETS.find((a) => a.dispose)!;
    const disposalAt = workday(disposal.dispose!.daysBack, 12);
    const disposalDay = dayOf(disposalAt);
    for (const { year, month } of months) {
      const periodEnd = endOfMonth(year, month);
      // The car went before this month ended: off the books first, and no charge for the month it left.
      const carId = assetIds.get(disposal.tag);
      if (carId && disposalDay.getTime() <= periodEnd.getTime()) {
        const car = await app.fixedAsset.findUnique({ where: { id: carId }, select: { disposedOn: true } });
        if (car && !car.disposedOn) {
          await app.$transaction(async (tx) => {
            const entry = await postAssetDisposalToLedger(tx, { assetId: carId, proceeds: disposal.dispose!.proceeds, disposedOn: disposalAt, userId: controller.id });
            await tx.fixedAsset.update({
              where: { id: carId },
              data: { disposedOn: disposalDay, disposalProceeds: dec(disposal.dispose!.proceeds), disposalNote: disposal.dispose!.note, disposalEntryId: entry?.id ?? null },
            });
          }, TX);
        }
      }
      const assets = await app.fixedAsset.findMany({ where: { purchasedOn: { lte: periodEnd }, ...demoAssets }, include: { charges: { select: { amount: true, toDate: true } } } });
      for (const a of assets) {
        if (a.charges.some((ch) => dayOf(ch.toDate).getTime() === dayOf(periodEnd).getTime())) continue;
        const accumulated = a.charges.reduce((t, ch) => t + Number(ch.amount), 0);
        const amount = monthlyCharge(
          { cost: Number(a.cost), salvageValue: Number(a.salvageValue), usefulLifeYears: a.usefulLifeYears, method: a.method, ratePercent: a.ratePercent ? Number(a.ratePercent) : null, purchasedOn: a.purchasedOn, disposedOn: a.disposedOn, accumulated },
          periodEnd,
        );
        if (amount <= 0) continue;
        await app.$transaction(
          (tx) => postDepreciationToLedger(tx, { assetId: a.id, amount, fromDate: startOfMonth(year, month), toDate: periodEnd, periodLabel: `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][month - 1]} ${year}`, userId: controller.id }),
          TX,
        );
        charged += 1;
      }
    }
    log("Fixed assets", `${await app.fixedAsset.count()} on the register, ${charged} monthly charges posted, one sold`);
  }

  // ═══ Prepaids and accruals ════════════════════════════════════════════════════════════════════
  {
    const lastMonth = lastCloseMonth(now);
    const monthKey = (back: number) => {
      const d = addCloseMonths(lastMonth, -back);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    };
    const fy = indiaClock.parts(now).month >= 3 ? indiaClock.parts(now).year : indiaClock.parts(now).year - 1;
    const purchases = await accountId(SYSTEM_ACCOUNTS.PURCHASES);
    const other = await accountId(SYSTEM_ACCOUNTS.EXP_OTHER);
    const marketing = await accountId(SYSTEM_ACCOUNTS.EXP_MARKETING);
    const software = await accountId(SYSTEM_ACCOUNTS.EXP_SOFTWARE_SUBSCRIPTION);
    const fees = await accountId(SYSTEM_ACCOUNTS.EXP_PROFESSIONAL_FEES);
    const prepaidBill = byRole.prepaidBill
      ? byRole.prepaidBill
      : null;
    const billRow = prepaidBill
      ? { id: prepaidBill.id, issueDate: prepaidBill.issueDate, companyId: prepaidBill.party.id }
      : await app.tradeDocument.findFirst({ where: { docType: "BILL", notes: { startsWith: "Prepaid for the year" } }, select: { id: true, issueDate: true, companyId: true } });
    const paidFirst = async (name: string, amount: number, account: string, monthKeyStr: string, vendor: string) => {
      const [y, m] = monthKeyStr.split("-").map(Number) as [number, number];
      await journal({
        date: capNow(indiaClock.at(y, m - 1, 1, 10, 30)),
        narration: `${name} — paid to ${vendor}`,
        by: exec(),
        lines: [
          { accountId: account, debit: amount, credit: 0 },
          { accountId: bankLedgerId, debit: 0, credit: amount },
        ],
      });
    };
    type Spec = { name: string; kind: "PREPAID" | "ACCRUAL"; account: string; amount: number; start: string; months: number; branch?: string | null; dept?: string; bill?: { id: string; companyId: string } | null; payee?: string; stop?: boolean; note?: string };
    const SPECS: Spec[] = [
      ...(billRow ? [{ name: "Annual OEM premium support", kind: "PREPAID" as const, account: purchases, amount: 240000, start: `${billRow.issueDate.getUTCFullYear()}-${String(billRow.issueDate.getUTCMonth() + 1).padStart(2, "0")}`, months: 12, branch: HO.id, dept: "Support", bill: billRow, note: "From the vendor's bill — expensed over the support year." }] : []),
      { name: `Office insurance — fire & burglary, FY ${fy}-${String((fy + 1) % 100).padStart(2, "0")}`, kind: "PREPAID", account: other, amount: 144000, start: `${fy}-04`, months: 12, branch: HO.id, dept: "HR & Admin", payee: "New India Assurance" },
      { name: "Trade fair stall — Convergence India", kind: "PREPAID", account: marketing, amount: 90000, start: monthKey(6), months: 3, branch: DEL.id, dept: "Sales", payee: "Exhibitions India Group" },
      { name: "LinkedIn Sales Navigator — 10 seats, annual", kind: "PREPAID", account: software, amount: 120000, start: monthKey(8), months: 12, branch: HO.id, dept: "Sales", payee: "LinkedIn Technology Information", stop: true },
      { name: `Statutory audit fee — FY ${fy}-${String((fy + 1) % 100).padStart(2, "0")}`, kind: "ACCRUAL", account: fees, amount: 300000, start: `${fy}-04`, months: 12, branch: HO.id, dept: "Accounts", note: "Engagement letter signed in April; the auditors bill after the year end." },
      { name: "Electricity — Bengaluru office (billed quarterly)", kind: "ACCRUAL", account: other, amount: 45000, start: monthKey(3), months: 3, branch: BLR.id, dept: "HR & Admin" },
    ];
    let made = 0;
    for (const s of SPECS) {
      if (await app.accountingSchedule.findFirst({ where: { name: s.name }, select: { id: true } })) continue;
      if (s.kind === "PREPAID" && !s.bill && s.payee) await paidFirst(s.name, s.amount, s.account, s.start, s.payee);
      const result = await createAccountingSchedule(
        {
          kind: s.kind,
          name: s.name,
          vendorCompanyId: s.bill?.companyId ?? null,
          expenseAccountId: s.account,
          amount: s.amount,
          startMonth: s.start,
          months: s.months,
          sourceDocumentId: s.bill?.id ?? null,
          branchId: s.branch ?? null,
          departmentId: s.dept ? (departments.get(s.dept) ?? null) : null,
          note: s.note ?? null,
        },
        controller.id,
        now,
      );
      if (!result.ok) {
        log("  schedule refused", `${s.name}: ${result.error}`);
        continue;
      }
      made += 1;
    }
    const run = await runAccountingSchedules({ throughMonth: lastMonth, actorId: controller.id, now });
    const toStop = await app.accountingSchedule.findFirst({ where: { name: { startsWith: "LinkedIn Sales Navigator" }, status: "ACTIVE" }, select: { id: true } });
    if (toStop) await stopAccountingSchedule(toStop.id, controller.id, now);
    log("Prepaids & accruals", `${made} schedules, ${run.months.length} month entries posted${run.skipped.length ? `, skipped: ${run.skipped.join("; ")}` : ""}`);
  }

  // ═══ Revenue & Close: deferred revenue opened, earned, credited, cancelled, re-planned ═════════
  {
    const lastMonth = lastRevenueMonth(now);
    const asAt = addRevenueMonths(lastMonth, -6);
    const automation = await automationUserId();
    const maker = execs[0]!;
    // Somebody else with Revenue & Close management approves what the maker made (mayApproveSchedule).
    const approverWho = maker.id === controller.id ? director : controller;
    const approver = { id: approverWho.id, isSuperAdmin: false, canManage: true };

    // Revenue invoiced before the add-on was switched on, moved into Deferred Revenue at a month end.
    if (!(await app.revenueSchedule.findFirst({ where: { opening: true }, select: { id: true } }))) {
      const candidates = await openingCandidates(app, { asAt, now, scope: { companyId: { in: ctx.companies.map((x) => x.id) } } });
      const picked = candidates
        .flatMap((cand) => cand.lines.map((l) => ({ cand, line: l })))
        .filter((x) => x.line.itemType === "SUBSCRIPTION" || x.line.itemType === "SERVICE")
        .slice(-6)
        .map(({ cand, line }) => {
          const from = line.from ?? cand.issueDate;
          const [y, m, d] = from.split("-").map(Number) as [number, number, number];
          const end = new Date(Date.UTC(y + 1, m - 1, d - 1));
          return { lineId: line.lineId, from, to: end.toISOString().slice(0, 10) };
        });
      if (picked.length) {
        const preview = await app.$transaction((tx) => previewOpening(tx, { asAt, lines: picked, now }), TX);
        const good = preview.lines.filter((l) => !l.problem).map((l) => ({ lineId: l.lineId, from: l.from, to: l.to }));
        if (good.length) {
          const opened = await app.$transaction((tx) => postOpening(tx, { asAt, lines: good, actorId: maker.id, now }), TX);
          for (const id of opened.scheduleIds) {
            await app.$transaction((tx) => approveRevenueSchedule(tx, { id, actor: approver, now }), TX);
          }
          log("Deferred revenue opened", `${opened.scheduleIds.length} lines, ${rupees(opened.total)} as at the end of ${asAt}, made by ${maker.name} and approved by ${approverWho.name}`);
        }
      }
    }

    // Every month that has come due, as the nightly job posts them.
    const first = await runRevenueRecognition({ throughMonth: lastMonth, actorId: automation });

    // An invoice whose months have started cancelled: what was recognised comes back out of Sales.
    const toCancel = byRole.toCancel ?? null;
    if (toCancel) await cancel(toCancel, controller);
    const later = byRole.cancelledLater ?? null;
    if (later) await cancel(later, controller);

    // A customer that moved to a perpetual licence: the rest of the schedule recognised at once.
    const handCancel = byRole.sub4 ? await app.revenueSchedule.findFirst({ where: { documentId: byRole.sub4.id, status: "ACTIVE" }, select: { id: true } }) : null;
    if (handCancel) {
      const reason = "Customer bought perpetual licences instead — no further service owed on this term";
      const ask = await app.$transaction((tx) => cancelRevenueSchedule(tx, { id: handCancel.id, reason, actorId: controller.id, now }), TX);
      if (!ask.done) await app.$transaction((tx) => cancelRevenueSchedule(tx, { id: handCancel.id, reason, actorId: controller.id, confirmAmount: ask.amount, now }), TX);
    }

    // The renewal's term stretched a month by hand — waiting for a second person to approve it.
    const renewalSchedule = byRole.renewal ? await app.revenueSchedule.findFirst({ where: { documentId: byRole.renewal.id, status: "ACTIVE" }, select: { id: true, endDate: true } }) : null;
    if (renewalSchedule?.endDate) {
      const end = new Date(Date.UTC(renewalSchedule.endDate.getUTCFullYear(), renewalSchedule.endDate.getUTCMonth() + 1, renewalSchedule.endDate.getUTCDate()));
      await app.$transaction(
        (tx) => editRevenueSchedule(tx, { id: renewalSchedule.id, patch: { endDate: end.toISOString().slice(0, 10), note: "One month free for renewing before the term ended — agreed by the head of sales." }, actorId: maker.id, now }),
        TX,
      );
    }
    const counts = await app.revenueSchedule.groupBy({ by: ["status"], _count: { _all: true } });
    log(
      "Revenue schedules",
      `${counts.map((c) => `${c._count._all} ${c.status.toLowerCase().replace("_", " ")}`).join(", ")} — ${first.months.length} month entries recognised${first.skipped.length ? ` (${first.skipped.map((s) => s.reason).join("; ")})` : ""}`,
    );
  }

  // ═══ Collections: what customers said about paying ════════════════════════════════════════════
  if ((await app.paymentFollowUp.count()) === 0) {
    const invoices = await app.tradeDocument.findMany({
      // Invoices from the company's own life — the demo dates a few before it opened.
      where: { docType: "INVOICE", status: { in: ["ISSUED", "PARTIALLY_PAID", "PAID"] }, companyId: { in: customers.map((x) => x.id) }, issueDate: { gte: FOUNDED } },
      orderBy: { issueDate: "asc" },
      select: {
        id: true, companyId: true, docNumber: true, total: true, issueDate: true, dueDate: true, status: true, currency: true,
        company: { select: { name: true, ownerUserId: true } },
        payments: { select: { amount: true, createdAt: true, payment: { select: { paidOn: true } } } },
        creditsReceived: { select: { amount: true } },
      },
    });
    const day = (d: Date) => indiaClock.calendarDate(d);
    const todayDay = day(now);
    const channels: FollowUpChannel[] = ["CALL", "WHATSAPP", "EMAIL", "VISIT", "MEETING", "OTHER"];
    let ch = 0;
    const nextChannel = () => channels[ch++ % channels.length]!;
    type FU = { companyId: string; documentId?: string | null; companyProductId?: string | null; by: string; at: Date; channel?: FollowUpChannel; remarks: string; promisedOn?: Date | null; promisedAmount?: number | null; next?: Date | null; label: string; companyName: string };
    const made: string[] = [];
    const log1 = async (f: FU) => {
      const at = capNow(f.at);
      const channel = f.channel ?? nextChannel();
      // A new promise replaces whatever on the same invoice or order was still open and not yet due (logFollowUp).
      if (f.promisedOn) {
        await app.paymentFollowUp.updateMany({
          where: { promiseStatus: "OPEN", promisedOn: { gte: day(at) }, ...(f.documentId ? { documentId: f.documentId } : { companyProductId: f.companyProductId }) },
          data: { promiseStatus: "SUPERSEDED", promiseResolvedAt: at },
        });
      }
      let taskId: string | null = null;
      if (f.next && f.next.getTime() >= todayDay.getTime()) {
        const task = await app.task.create({
          data: {
            title: `Follow up ${f.companyName} on ${f.label}`,
            description: `Payment follow-up. Last time (${channel.toLowerCase()}): ${f.remarks}`,
            dueDate: f.next,
            assignedToUserId: f.by,
            createdByUserId: f.by,
            companyId: f.companyId,
            createdAt: at,
          },
          select: { id: true },
        });
        taskId = task.id;
      }
      const row = await app.paymentFollowUp.create({
        data: {
          companyId: f.companyId,
          documentId: f.documentId ?? null,
          companyProductId: f.companyProductId ?? null,
          byUserId: f.by,
          channel,
          remarks: f.remarks.slice(0, 1000),
          promisedOn: f.promisedOn ?? null,
          promisedAmount: f.promisedAmount != null ? dec(f.promisedAmount) : null,
          promiseStatus: f.promisedOn ? "OPEN" : null,
          nextFollowUpOn: f.next ?? null,
          taskId,
          createdAt: at,
        },
        select: { id: true },
      });
      made.push(row.id);
    };
    const who = (inv: (typeof invoices)[number]) => (chance(0.65) ? (inv.company.ownerUserId ?? exec().id) : exec().id);
    const atDay = (d: Date, hour = int(10, 18)) => indiaClock.at(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, int(0, 59));

    const paid = invoices.filter((i) => i.status === "PAID" && i.payments.length > 0);
    const open = invoices.filter((i) => i.status === "ISSUED" && i.dueDate && i.dueDate.getTime() < todayDay.getTime() - 10 * DAY);
    const fresh = invoices.filter((i) => i.status === "ISSUED" && !open.includes(i));
    const part = invoices.filter((i) => i.status === "PARTIALLY_PAID" && i.payments.length > 0);

    // Kept: promised, and the money came in by the day.
    for (const inv of some(paid, Math.min(12, paid.length))) {
      const lastPaid = inv.payments.map((p) => p.payment.paidOn).sort((a, b) => b.getTime() - a.getTime())[0]!;
      const logged = new Date(Math.max(lastPaid.getTime() - int(3, 9) * DAY, inv.issueDate.getTime() + DAY));
      if (logged.getTime() >= lastPaid.getTime()) continue;
      const promised = addDay(day(lastPaid), int(0, 2));
      const amount = r2(inv.payments.reduce((t, p) => t + Number(p.amount), 0));
      const earlier = new Date(logged.getTime() - int(5, 10) * DAY);
      if (chance(0.4) && earlier.getTime() > inv.issueDate.getTime()) {
        await log1({ companyId: inv.companyId, documentId: inv.id, by: who(inv), at: atDay(day(earlier)), remarks: "Invoice is with their AP team for the three-way match; asked us to check back next week.", next: null, label: inv.docNumber, companyName: inv.company.name });
      }
      await log1({
        companyId: inv.companyId, documentId: inv.id, by: who(inv), at: atDay(day(logged)),
        remarks: pick(["Finance head confirmed the payment run on Friday includes this invoice.", "Spoke to their accounts manager — NEFT will go out once the CFO approves the batch.", "Customer confirmed on WhatsApp that the UTR will be shared by the promised date."]),
        promisedOn: promised, promisedAmount: inv.creditsReceived.length ? amount : chance(0.5) ? amount : null, label: inv.docNumber, companyName: inv.company.name,
      });
    }

    // Long overdue: promised and missed, chased again and missed again, and promised once more this week.
    for (const inv of some(open, Math.min(10, open.length))) {
      const first = addDay(inv.dueDate!, int(2, 6));
      const promised = addDay(first, int(5, 10));
      if (promised.getTime() >= todayDay.getTime() - 12 * DAY) continue;
      await log1({ companyId: inv.companyId, documentId: inv.id, by: who(inv), at: atDay(first), channel: "CALL", remarks: "Overdue reminder. They said the cheque is signed and will be couriered this week.", promisedOn: promised, promisedAmount: null, label: inv.docNumber, companyName: inv.company.name });
      const second = addDay(promised, int(2, 6));
      const secondPromise = addDay(second, int(7, 14));
      if (secondPromise.getTime() < todayDay.getTime() - 5 * DAY) {
        await log1({
          companyId: inv.companyId, documentId: inv.id, by: who(inv), at: atDay(second), channel: "EMAIL",
          remarks: "Promise missed. Sent the statement of account; they blamed a pending GST input mismatch on their side and gave a new date.",
          promisedOn: secondPromise, promisedAmount: null, label: inv.docNumber, companyName: inv.company.name,
        });
      }
      const latest = addDay(todayDay, -int(1, 8));
      const again = addDay(latest, int(4, 14));
      await log1({
        companyId: inv.companyId, documentId: inv.id, by: who(inv), at: atDay(latest), channel: pick(["WHATSAPP", "MEETING"] as const),
        remarks: "Escalated to their finance controller — new date given, part payment possible if the full amount isn't approved.",
        promisedOn: again, promisedAmount: chance(0.5) ? r2(Number(inv.total) * 0.5) : null, next: addDay(again, 1), label: inv.docNumber, companyName: inv.company.name,
      });
      if (chance(0.4)) {
        await log1({ companyId: inv.companyId, documentId: inv.id, by: exec().id, at: atDay(addDay(todayDay, -1), 16), channel: "VISIT", remarks: "Visited their office with the statement of account; they disputed nothing.", next: addDay(todayDay, int(3, 7)), label: inv.docNumber, companyName: inv.company.name });
      }
    }

    // A promise pushed back before it fell due: the first replaced by the second.
    // The ones issued long enough ago to have been chased twice this week.
    for (const inv of fresh.filter((i) => i.issueDate.getTime() < todayDay.getTime() - 6 * DAY).slice(0, 4)) {
      const first = new Date(Math.max(addDay(todayDay, -int(5, 8)).getTime(), addDay(day(inv.issueDate), 1).getTime()));
      await log1({ companyId: inv.companyId, documentId: inv.id, by: who(inv), at: atDay(first), channel: "EMAIL", remarks: "Sent the invoice copy and the delivery proof again on request.", promisedOn: addDay(todayDay, int(2, 5)), promisedAmount: null, label: inv.docNumber, companyName: inv.company.name });
      await log1({ companyId: inv.companyId, documentId: inv.id, by: who(inv), at: atDay(addDay(todayDay, -int(1, 3))), channel: "MEETING", remarks: "Met their purchase head — payment pushed to the next cycle because of their quarter-end freeze.", promisedOn: addDay(todayDay, int(8, 15)), promisedAmount: null, label: inv.docNumber, companyName: inv.company.name });
    }

    // Part paid: the part they promised came; the rest is still owed.
    for (const inv of some(part, Math.min(5, part.length))) {
      const firstPaid = inv.payments.map((p) => p.payment.paidOn).sort((a, b) => a.getTime() - b.getTime())[0]!;
      const logged = new Date(firstPaid.getTime() - int(2, 6) * DAY);
      if (logged.getTime() <= inv.issueDate.getTime()) continue;
      const amount = Number(inv.payments[0]!.amount);
      await log1({ companyId: inv.companyId, documentId: inv.id, by: who(inv), at: atDay(day(logged)), remarks: "Agreed to release part now and the balance after the project sign-off.", promisedOn: addDay(day(firstPaid), 1), promisedAmount: amount, label: inv.docNumber, companyName: inv.company.name });
      const balanceBy = addDay(day(firstPaid), int(20, 40));
      if (balanceBy.getTime() < todayDay.getTime()) {
        await log1({ companyId: inv.companyId, documentId: inv.id, by: who(inv), at: atDay(addDay(day(firstPaid), 3)), channel: "OTHER", remarks: "Balance promised through their vendor portal once the sign-off is uploaded.", promisedOn: balanceBy, promisedAmount: null, label: inv.docNumber, companyName: inv.company.name });
      }
    }

    // A promise on an invoice that was cancelled since: nothing left to pay, so it is set aside.
    const cancelled = await app.tradeDocument.findFirst({ where: { docType: "INVOICE", status: "CANCELLED", einvoiceStatus: "NOT_APPLICABLE", companyId: { in: customers.map((x) => x.id) } }, orderBy: { issueDate: "desc" }, select: { id: true, companyId: true, docNumber: true, issueDate: true, company: { select: { name: true, ownerUserId: true } } } });
    if (cancelled) {
      // Logged while it was still a live invoice — before the cancellation, with a day still to come.
      await app.paymentFollowUp.create({
        data: {
          companyId: cancelled.companyId, documentId: cancelled.id, byUserId: cancelled.company.ownerUserId ?? exec().id, channel: "CALL",
          remarks: "Customer asked to hold the invoice while they confirm the order internally; promised to pay once confirmed.",
          promisedOn: addDay(todayDay, 4), promiseStatus: "OPEN", createdAt: atDay(addDay(day(cancelled.issueDate), 2)),
        },
      });
    }

    // Orders nobody has invoiced yet: advances chased before the purchase goes out.
    const orders = await app.companyProduct.findMany({
      where: { companyId: { in: customers.map((x) => x.id) }, orderStatus: { in: ["APPROVED", "PROCESSING"] }, documentLines: { none: {} } },
      take: 4,
      select: { id: true, orderSeq: true, companyId: true, quantity: true, unitPrice: true, createdAt: true, addedByUserId: true, company: { select: { name: true } }, item: { select: { sellingPrice: true, taxRatePercent: true } } },
    });
    for (const [i, o] of orders.entries()) {
      const amount = r2(o.quantity * Number(o.unitPrice ?? o.item.sellingPrice) * (1 + Number(o.item.taxRatePercent ?? 18) / 100) * 0.5);
      const loggedDay = new Date(Math.max(day(o.createdAt).getTime() + 2 * DAY, todayDay.getTime() - 20 * DAY));
      const promised = i % 2 === 0 ? addDay(todayDay, int(3, 10)) : addDay(loggedDay, 5);
      if (loggedDay.getTime() >= todayDay.getTime()) continue;
      await log1({
        companyId: o.companyId, companyProductId: o.id, by: o.addedByUserId, at: atDay(loggedDay), channel: i % 2 === 0 ? "MEETING" : "WHATSAPP",
        remarks: "50% advance requested before we place the order with the distributor.",
        promisedOn: promised.getTime() > loggedDay.getTime() ? promised : addDay(loggedDay, 3), promisedAmount: amount, label: formatOrderId(o.orderSeq), companyName: o.company.name,
      });
    }

    // What the daily job would have decided by now, then dated when it would have decided it.
    const resolved = await resolvePromises(now);
    for (const id of resolved.broken) {
      const f = await app.paymentFollowUp.findUniqueOrThrow({ where: { id }, select: { promisedOn: true } });
      const decided = capNow(indiaClock.at(f.promisedOn!.getUTCFullYear(), f.promisedOn!.getUTCMonth(), f.promisedOn!.getUTCDate() + 1, 6, 30));
      await app.paymentFollowUp.update({ where: { id }, data: { promiseResolvedAt: decided, brokenNotifiedAt: decided } });
    }
    for (const id of resolved.kept) {
      const f = await app.paymentFollowUp.findUniqueOrThrow({ where: { id }, select: { promisedOn: true, createdAt: true, document: { select: { payments: { select: { payment: { select: { paidOn: true } } } } } } } });
      const paidOn = (f.document?.payments ?? []).map((p) => p.payment.paidOn).filter((d) => d.getTime() >= f.createdAt.getTime()).sort((a, b) => a.getTime() - b.getTime())[0];
      if (paidOn) await app.paymentFollowUp.update({ where: { id }, data: { promiseResolvedAt: plusHours(paidOn, 3) } });
    }
    const statuses = await app.paymentFollowUp.groupBy({ by: ["promiseStatus"], _count: { _all: true } });
    log("Collections", `${await app.paymentFollowUp.count()} follow-ups — ${statuses.map((s) => `${s._count._all} ${s.promiseStatus?.toLowerCase() ?? "without a promise"}`).join(", ")}`);
  }

  // ═══ Credit decisions ═════════════════════════════════════════════════════════════════════════
  if ((await app.creditDecision.count()) === 0) {
    type Assessment = NonNullable<Awaited<ReturnType<typeof assessCompany>>>;
    const cache = new Map<string, Assessment | null>();
    /** What the engine said about a customer on the day — what the person deciding was looking at. */
    const assessAt = async (companyId: string, at: Date) => {
      const key = `${companyId}|${dayOf(at).getTime()}`;
      if (!cache.has(key)) cache.set(key, await assessCompany(companyId, at));
      return cache.get(key) ?? null;
    };
    const used = new Set<string>();
    const days = [24, 47, 83, 131, 205].map((back) => workday(back));
    /** A customer the engine rated so on one of a handful of days, and that day. */
    let search = 0;
    const findRated = async (rating: Assessment["rating"]) => {
      // Each search starts on a different day, so the decisions spread over the months.
      search += 1;
      for (const at of [...days.slice(search % days.length), ...days.slice(0, search % days.length)]) {
        for (const party of customers) {
          if (used.has(party.id)) continue;
          const a = await assessAt(party.id, at);
          if (a?.rating !== rating) continue;
          used.add(party.id);
          return { party, a, at };
        }
      }
      return null;
    };
    const TERMS_ORDER: TermsKey[] = ["ADVANCE", "DUE_ON_RECEIPT", "NET_15", "NET_30", "NET_45", "NET_60"];
    let made = 0;
    const record = (o: { companyId: string; orderId?: string | null; kind: "TERMS" | "LIMIT" | "ORDER"; detail: string; reason: string; a: Assessment; by: Who; at: Date }) =>
      app.creditDecision.create({
        data: { companyId: o.companyId, orderId: o.orderId ?? null, kind: o.kind, detail: o.detail, reason: o.reason.trim(), rating: o.a.rating, score: o.a.score, decidedById: o.by.id, createdAt: capNow(o.at) },
      });

    // Default terms longer than the record supported on the day, with the reason that was given.
    const TERMS: [Assessment["rating"], Who, string][] = [
      ["RELIABLE", director, "Three-year contract signed with a bank guarantee covering two months of billing."],
      ["FAIR", controller, "Government undertaking: their treasury pays on a 45-day cycle whatever we ask for."],
      ["NEW", director, "Group company of an existing account that has paid on time for two years — the parent guarantees payment."],
      ["RISKY", controller, "Strategic logo for the healthcare vertical. Their overdue invoice is a disputed freight charge; approved in the account review."],
    ];
    for (const [rating, by, reason] of TERMS) {
      const found = await findRated(rating);
      if (!found) continue;
      const { party, a, at } = found;
      const given = TERMS_ORDER[Math.min(TERMS_ORDER.indexOf(a.recommendedTerms) + 2, TERMS_ORDER.length - 1)]! as PaymentTerms;
      if (!termsExceed(given as TermsKey, a.recommendedTerms)) continue;
      // The company form saves the terms, then records the decision it allowed (checkTerms, recordDecision).
      await app.company.update({ where: { id: party.id }, data: { paymentTerms: given } });
      await record({ companyId: party.id, kind: "TERMS", detail: `Default terms: ${paymentTermsLabels[given]} (suggested ${paymentTermsLabels[a.recommendedTerms]})`, reason, a, by, at });
      made += 1;
    }

    // Limits (setCreditLimit): raised above the suggestion, cut to nothing, and one set and later cleared.
    const describe = (a: Assessment) => (a.manualLimit !== null ? `${rupees(a.manualLimit)} set by hand` : `${rupees(a.suggestedLimit)} suggested`);
    // Cut to nothing first: only a customer the engine would give credit to has a limit worth cutting.
    const refused = (await findRated("FAIR")) ?? (await findRated("RELIABLE"));
    if (refused) {
      const { party, a, at } = refused;
      await app.company.update({ where: { id: party.id }, data: { creditLimit: dec(0) } });
      await record({ companyId: party.id, kind: "LIMIT", detail: `Credit limit set to ${rupees(0)} (was ${describe(a)})`, reason: "Two cheques returned unpaid in a month — advance only until the account is cleared and a fresh mandate is in place.", a, by: controller, at });
      made += 1;
    }
    const raisedFor = (await findRated("FAIR")) ?? (await findRated("RELIABLE")) ?? (await findRated("NEW"));
    if (raisedFor) {
      const { party, a, at } = raisedFor;
      const limit = Math.max(500000, Math.round((a.suggestedLimit * 2) / 50000) * 50000);
      await app.company.update({ where: { id: party.id }, data: { creditLimit: dec(limit) } });
      await record({ companyId: party.id, kind: "LIMIT", detail: `Credit limit set to ${rupees(limit)} (was ${describe(a)})`, reason: "Annual Azure commitment billed monthly — the limit has to carry three months of consumption.", a, by: controller, at });
      made += 1;
    }
    const seasonal = (await findRated("NEW")) ?? (await findRated("RISKY"));
    if (seasonal) {
      const { party, a, at } = seasonal;
      const raised = Math.max(300000, Math.round((a.suggestedLimit * 1.5) / 50000) * 50000);
      await record({ companyId: party.id, kind: "LIMIT", detail: `Credit limit set to ${rupees(raised)} (was ${describe(a)})`, reason: "Seasonal stock-up for their branch roll-out; to be reviewed after the quarter.", a, by: director, at });
      const clearedAt = capNow(new Date(at.getTime() + 75 * DAY));
      const later = (await assessAt(party.id, clearedAt)) ?? a;
      await record({ companyId: party.id, kind: "LIMIT", detail: `Credit limit cleared — back to the suggested ${rupees(later.suggestedLimit)} (was ${rupees(raised)} set by hand)`, reason: "Roll-out finished; back on the engine's figure as agreed at the quarterly review.", a: later, by: controller, at: clearedAt });
      await app.company.update({ where: { id: party.id }, data: { creditLimit: null } });
      made += 2;
    }

    // Orders approved although the credit record said otherwise — with what it said on the day.
    const approvedOrders = await app.companyProduct.findMany({
      where: { companyId: { in: customers.map((x) => x.id) }, orderStatus: { in: ["APPROVED", "PROCESSING", "FULFILLED"] } },
      orderBy: { orderSeq: "asc" },
      select: { id: true, orderSeq: true, companyId: true, quantity: true, unitPrice: true, paymentTerms: true, accountsApprovedAt: true, accountsApprovedByUserId: true, createdAt: true, item: { select: { sellingPrice: true, taxRatePercent: true } }, company: { select: { paymentTerms: true } } },
    });
    const ORDER_REASONS = [
      "Back-to-back with the distributor's 60-day credit, so our exposure is covered.",
      "Customer paid the last three invoices early; the overdue one is a disputed freight charge.",
      "Director approved on the call — the renewal is at risk if we insist on advance.",
      "Against a post-dated cheque for the full amount, deposited on the due date.",
    ];
    let orderDecisions = 0;
    for (const o of approvedOrders) {
      if (orderDecisions >= ORDER_REASONS.length) break;
      // Approved by accounts a day or two after it was punched.
      const at = new Date(Math.min((o.accountsApprovedAt ?? now).getTime(), o.createdAt.getTime() + int(1, 2) * DAY));
      if (at.getTime() < FOUNDED.getTime()) continue;
      const a = await assessAt(o.companyId, at);
      if (!a) continue;
      const terms = (o.paymentTerms ?? o.company.paymentTerms) as TermsKey;
      const amount = r2(o.quantity * Number(o.unitPrice ?? o.item.sellingPrice) * (1 + Number(o.item.taxRatePercent ?? 18) / 100));
      const concerns = creditConcerns(a, { terms, amount });
      if (concerns.length === 0) continue;
      await record({
        companyId: o.companyId, orderId: o.id, kind: "ORDER",
        detail: `Approved ${formatOrderId(o.orderSeq)} — ${concerns.map((x) => x.text).join("; ")}`,
        reason: ORDER_REASONS[orderDecisions]!,
        a, by: o.accountsApprovedByUserId ? { id: o.accountsApprovedByUserId, name: "" } : controller, at,
      });
      orderDecisions += 1;
      made += 1;
    }
    const ratings = new Map<string, number>();
    for (const d of await app.creditDecision.findMany({ select: { rating: true } })) ratings.set(d.rating, (ratings.get(d.rating) ?? 0) + 1);
    log("Credit decisions", `${made} — rated ${[...ratings].map(([r, n]) => `${RATING_LABELS[r as keyof typeof RATING_LABELS].split(" ")[0]!.toLowerCase()} ×${n}`).join(", ")} on the day`);
  }

  // The ratings the credit list filters and sorts on, stored as the scheduled tick stores them — for the
  // demo's own customers and prospects only.
  {
    const ids = ctx.companies.filter((c) => c.relationship === "CLIENT" || c.relationship === "RESELLER").map((c) => c.id);
    await cacheAssessments(await assessCompanies(ids, now), now);
    log("Credit ratings", `${ids.length} customers and prospects rated by the engine`);
  }

  // ═══ Petty cash ═══════════════════════════════════════════════════════════════════════════════
  /**
   * Cash claims and cash purchases are paid out of the office's cash box, and the box is topped up from
   * the bank at the start of each month — a self cheque, the contra entry every Indian ledger has. Worked
   * out from what the month actually spent, so Cash in Hand never goes below its float.
   */
  {
    const cash = await accountId(SYSTEM_ACCOUNTS.CASH);
    const FLOAT = 25000;
    let topUps = 0;
    for (const { year: y, month0: m } of indianMonths(FOUNDED, now)) {
      const from = indiaClock.at(y, m, 1, 0, 0);
      const to = indiaClock.at(y, m + 1, 1, 0, 0);
      const [before, during] = await Promise.all([
        app.journalLine.aggregate({ where: { accountId: cash, entry: { date: { lt: from } } }, _sum: { debit: true, credit: true } }),
        app.journalLine.aggregate({ where: { accountId: cash, entry: { date: { gte: from, lt: to } } }, _sum: { debit: true, credit: true } }),
      ]);
      const opening = Number(before._sum.debit ?? 0) - Number(before._sum.credit ?? 0);
      const closing = opening + Number(during._sum.debit ?? 0) - Number(during._sum.credit ?? 0);
      if (closing >= FLOAT) continue;
      const amount = Math.ceil((FLOAT - closing) / 10000) * 10000;
      const label = `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m]} ${y}`;
      await journal({
        date: capNow(new Date(Math.max(indiaClock.at(y, m, 1, 10, 30).getTime(), FOUNDED.getTime() + DAY))),
        narration: `Cash withdrawn for petty cash — ${label} (self cheque)`,
        by: exec(),
        lines: [
          { accountId: cash, debit: amount, credit: 0, branchId: HO.id },
          { accountId: bankLedgerId, debit: 0, credit: amount, branchId: HO.id },
        ],
      });
      topUps += 1;
    }
    if (topUps) log("Petty cash", `${topUps} monthly top-ups from the bank`);
  }

  // ═══ The month-end close ══════════════════════════════════════════════════════════════════════
  {
    await ensureDefaultTemplates(now);
    const OWNERS: Record<string, Who> = {
      "Bank accounts reconciled to month end": execs[0]!,
      "Every invoice for the month issued": execs[1 % execs.length]!,
      "Vendor bills entered; accruals for missing bills": purchaseMgr,
      "Revenue recognised": controller,
      "Prepaids amortised, accruals posted": controller,
      "Depreciation run": execs[0]!,
      "Payroll posted": hrManager,
      "Expense claims posted": execs[2 % execs.length]!,
      "Receivables tie to the ledger": execs[1 % execs.length]!,
      "Payables tie to the ledger": execs[2 % execs.length]!,
      "Delivered, not yet invoiced": gm,
      "GST returns prepared": controller,
      "TDS reconciled": execs[0]!,
      "Month-on-month changes explained": controller,
    };
    for (const t of await listTemplates({ includeInactive: true })) {
      const owner = OWNERS[t.title];
      if (!owner || t.ownerId) continue;
      await writeTemplate({ id: t.id, title: t.title, description: t.description, ownerId: owner.id, dueDay: t.title.startsWith("GST") ? 8 : t.dueDay, autoCheck: t.autoCheck, active: t.active });
    }
    const templates = await listTemplates({ includeInactive: true });
    if (!templates.some((t) => t.title === "Petty cash counted and agreed")) {
      await writeTemplate({ title: "Petty cash counted and agreed", description: "Count the petty cash box at the head office and agree it to Cash in Hand; vouchers filed.", ownerId: execs[0]!.id, dueDay: 2, autoCheck: null, active: true });
    }
    if (!templates.some((t) => t.title === "Stock count reconciled to the books")) {
      await writeTemplate({ title: "Stock count reconciled to the books", description: "Physical count of demo and spare stock agreed to the stock register. Paused while the warehouse moves.", ownerId: purchaseMgr.id, dueDay: 5, autoCheck: null, active: false });
    }

    const september = lastCloseMonth(now);
    const months = [addCloseMonths(september, -2), addCloseMonths(september, -1), september];
    const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? ctx.admin.name;
    const flagWords: Record<string, string> = {
      "4100": "Two annual Autodesk renewals and the Delhi data-centre refresh were invoiced this month; last month had none of that size.",
      "4110": "Credit note for the returned laptop and the released Creative Cloud seats.",
      "5100": "Server and UPS purchases for the Delhi refresh, billed by the distributor this month.",
      "5200": "Payroll run includes the annual increments effective this month.",
      "1110": "Customer collections from the quarter-end push landed in the main account.",
      "1111": "Customer collections from the quarter-end push landed in the main account.",
      "1112": "Export receipts in dollars credited to the collections account.",
      "1130": "Receivables up with the large invoices raised in the last week of the month.",
      "2110": "Vendor bills for the data-centre refresh are due next month.",
      "4950": "Exchange gain on the dollar receipt settled at a better rate than the invoice.",
      "5400": "One-off: a courier bill posted to Rent and reversed — see the journal.",
      "5600": "Statutory audit fee accrual started this month.",
      "5800": "Depreciation on the new switches and the Bengaluru workstations.",
    };
    let notes = 0;
    for (const [mi, month] of months.entries()) {
      const isLast = mi === months.length - 1;
      const nextMonthDay = (d: number, hour: number) => indiaClock.at(month.getUTCFullYear(), month.getUTCMonth() + 1, d, hour, int(0, 50));
      await quietly(() => generateTasks(month, { now: isLast ? now : nextMonthDay(1, 9) }));

      // Explanations for the big movements — all of them for the earlier months, most for the last.
      const flux = await fluxFor(month);
      // Once per month: a month somebody has already written explanations for keeps the ones it has.
      const flagged = flux.rows.some((r) => r.note) ? [] : flux.rows.filter((r) => r.flagged && !r.note);
      for (const [i, row] of flagged.entries()) {
        if (isLast && i >= Math.max(1, flagged.length - 2)) break;
        const words = flagWords[row.code] ?? `${row.name} ${row.changePrev > 0 ? "up" : "down"} ${rupees(Math.abs(row.changePrev))} on last month — traced to the documents behind it; nothing unusual.`;
        await writeFluxNote({ month, accountId: row.accountId, explanation: words.slice(0, 1000), userId: controller.id });
        notes += 1;
      }

      // The automatic checks, as the nightly job runs them early in the next month.
      await evaluateAutoChecks(month, { now: isLast ? now : nextMonthDay(3, 2) });

      // What people did with the rest: the earlier months worked through, the last one in progress.
      const tasks = await app.closeTask.findMany({ where: { month, status: "TODO" }, select: { id: true, title: true, ownerId: true, autoCheck: true, autoOk: true } });
      for (const t of tasks) {
        const verdict = closeVerdict(t, mi, isLast);
        if (!verdict) continue;
        const owner = t.ownerId ?? controller.id;
        const when = isLast ? capNow(new Date(now.getTime() - int(2, 40) * 3_600_000)) : nextMonthDay(int(2, 9), int(11, 18));
        await writeTaskStatus({ taskId: t.id, status: verdict.status, note: verdict.note, userId: owner, userName: nameOf(owner), now: when });
      }
      // The first of them was closed, and reopened when a late vendor bill turned up.
      if (mi === 0) {
        const row = await app.closeMonth.findUnique({ where: { month }, select: { closedAt: true } });
        if (row && !row.closedAt) {
          await app.closeMonth.update({
            where: { month },
            data: {
              closedAt: nextMonthDay(7, 17),
              closedById: controller.id,
              reopenedAt: nextMonthDay(12, 11),
              note: `Reopened: the distributor's bill for ${closeMonthLabel(month)} arrived after the close — entered, and the payables tie-out redone.`,
            },
          });
        }
      }
    }
    const taskStatuses = await app.closeTask.groupBy({ by: ["status"], _count: { _all: true } });
    log("Month-end close", `${months.length} months, ${taskStatuses.map((s) => `${s._count._all} ${s.status.toLowerCase().replace("_", " ")}`).join(", ")}; ${notes} flux explanations`);
  }

  // ═══ The books still balance ══════════════════════════════════════════════════════════════════
  const unbalanced = await app.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT "entryId" FROM journal_lines GROUP BY "entryId" HAVING sum(debit) <> sum(credit)
    ) x`;
  const totals = await app.journalLine.aggregate({ _sum: { debit: true, credit: true } });
  const sources = await app.journalEntry.groupBy({ by: ["source"], _count: { _all: true } });
  log(
    "Ledger",
    `${sources.map((s) => `${s._count._all} ${s.source.toLowerCase()}`).join(" · ")} — debits ${rupees(Number(totals._sum.debit ?? 0))}, credits ${rupees(Number(totals._sum.credit ?? 0))}, ${unbalanced[0]?.n ?? 0} unbalanced`,
  );
}
