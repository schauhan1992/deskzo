import type { JournalSource, Prisma, RevenueScheduleKind, RevenueScheduleStatus } from "@prisma/client";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/chart";
import { documentPostingSelect, revenueInRupees } from "@/lib/ledger/journal";
import { indiaClock } from "@/lib/time/zone";
import {
  addMonths,
  dayDate,
  firstDay,
  isMonthKey,
  lastDay,
  monthDate,
  monthKeyAt,
  monthKeyOfDate,
  monthsBetween,
  round2,
  type DayKey,
  type MonthKey,
} from "@/lib/revenue/periods";
import {
  NARRATION,
  recognisedOf,
  scheduleStateSelect,
  toState,
  unrecognisedOf,
  type ScheduleState,
} from "@/lib/revenue/state";

/**
 * What Revenue & Close's screens read (spec §3.8): the schedule list and one schedule, the deferred
 * revenue roll-forward, the waterfall of revenue still to come, and a customer's revenue.
 *
 * Plain functions over a client. The actions in src/actions/revenue.ts check who is asking and pass a
 * `scope` — the customers that person may see (`viaCompanyScope`) — for anything that lists customers.
 */

type Client = Pick<
  Prisma.TransactionClient,
  "revenueSchedule" | "journalLine" | "ledgerAccount" | "tradeDocument"
>;
type Scope = Prisma.RevenueScheduleWhereInput;

const sum = (values: number[]) => round2(values.reduce((t, v) => t + v, 0));
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** The month's instants in India, half-open — in every workspace, as the books keep India's calendar. */
function monthWindow(month: MonthKey): { from: Date; to: Date } {
  const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1];
  return { from: indiaClock.midnight(y, m, 1), to: indiaClock.midnight(y, m + 1, 1) };
}

// ─── The list and one schedule ───────────────────────────────────────────────────────────────────

const rowSelect = {
  ...scheduleStateSelect,
  itemId: true,
  createdAt: true,
  approvedAt: true,
  company: { select: { name: true } },
  document: { select: { docNumber: true, docType: true, status: true, issueDate: true } },
  line: { select: { name: true } },
  item: { select: { name: true } },
  createdBy: { select: { name: true } },
  approvedBy: { select: { id: true, name: true } },
} satisfies Prisma.RevenueScheduleSelect;

type Row = Prisma.RevenueScheduleGetPayload<{ select: typeof rowSelect }>;

export type ScheduleListRow = {
  id: string;
  kind: RevenueScheduleKind;
  status: RevenueScheduleStatus;
  opening: boolean;
  companyId: string;
  companyName: string;
  documentId: string | null;
  docNumber: string | null;
  lineId: string | null;
  lineName: string | null;
  itemId: string | null;
  itemName: string | null;
  startDate: DayKey | null;
  endDate: DayKey | null;
  amount: number;
  recognised: number;
  credited: number;
  /** Still in Deferred Revenue. */
  remaining: number;
  /** The first month still to be posted, if any. */
  nextMonth: MonthKey | null;
  createdById: string;
  createdByName: string;
  approvedById: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  createdAt: string;
};

function toRow(r: Row): ScheduleListRow {
  const s = toState(r);
  const next = s.status === "ACTIVE" || s.status === "PENDING_APPROVAL" ? s.lines.filter((l) => !l.posted).map((l) => l.month).sort()[0] ?? null : null;
  return {
    id: s.id,
    kind: s.kind,
    status: s.status,
    opening: s.opening,
    companyId: s.companyId,
    companyName: r.company.name,
    documentId: s.documentId,
    docNumber: r.document?.docNumber ?? null,
    lineId: s.lineId,
    lineName: r.line?.name ?? null,
    itemId: r.itemId ?? null,
    itemName: r.item?.name ?? null,
    startDate: s.startDate,
    endDate: s.endDate,
    amount: s.amount,
    recognised: recognisedOf(s),
    credited: s.credited,
    remaining: unrecognisedOf(s),
    nextMonth: next,
    createdById: s.createdById,
    createdByName: r.createdBy.name,
    approvedById: r.approvedBy?.id ?? null,
    approvedByName: r.approvedBy?.name ?? null,
    approvedAt: iso(r.approvedAt),
    createdAt: r.createdAt.toISOString(),
  };
}

export type ScheduleFilters = {
  status?: RevenueScheduleStatus;
  /** The review queue: PENDING_APPROVAL only. */
  pendingApproval?: boolean;
  kind?: RevenueScheduleKind;
  companyId?: string;
  itemId?: string;
  documentId?: string;
  opening?: boolean;
  /** Schedules whose period, or any month, falls in `from`–`to`. */
  from?: MonthKey;
  to?: MonthKey;
  /** Document number or customer name. */
  search?: string;
  take?: number;
  skip?: number;
};

/** The schedule list, newest first, with each one's recognised, credited and remaining figures. */
export async function listSchedules(
  client: Client,
  params: { filters?: ScheduleFilters; scope?: Scope },
): Promise<{ rows: ScheduleListRow[]; total: number }> {
  const f = params.filters ?? {};
  const and: Prisma.RevenueScheduleWhereInput[] = [params.scope ?? {}];
  if (f.status) and.push({ status: f.status });
  if (f.pendingApproval) and.push({ status: "PENDING_APPROVAL" });
  if (f.kind) and.push({ kind: f.kind });
  if (f.companyId) and.push({ companyId: f.companyId });
  if (f.itemId) and.push({ itemId: f.itemId });
  if (f.documentId) and.push({ documentId: f.documentId });
  if (f.opening !== undefined) and.push({ opening: f.opening });
  if (f.from || f.to) {
    const from = f.from && isMonthKey(f.from) ? f.from : "1900-01";
    const to = f.to && isMonthKey(f.to) ? f.to : "2999-12";
    and.push({
      OR: [
        { startDate: { lte: dayDate(lastDay(to)) }, endDate: { gte: dayDate(firstDay(from)) } },
        { lines: { some: { month: { gte: monthDate(from), lte: monthDate(to) } } } },
      ],
    });
  }
  const search = f.search?.trim();
  if (search) {
    and.push({
      OR: [
        { document: { docNumber: { contains: search, mode: "insensitive" } } },
        { company: { name: { contains: search, mode: "insensitive" } } },
        { line: { name: { contains: search, mode: "insensitive" } } },
      ],
    });
  }
  const where: Prisma.RevenueScheduleWhereInput = { AND: and };
  const take = Math.min(Math.max(f.take ?? 100, 1), 500);
  const [rows, total] = await Promise.all([
    client.revenueSchedule.findMany({ where, select: rowSelect, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take, skip: Math.max(f.skip ?? 0, 0) }),
    client.revenueSchedule.count({ where }),
  ]);
  return { rows: rows.map(toRow), total };
}

export type ScheduleDetail = ScheduleListRow & {
  note: string | null;
  spreadEvenly: boolean;
  document: { id: string; docNumber: string; docType: string; status: string; issueDate: string } | null;
  billingMilestone: { id: string; label: string; deliveryMilestone: { id: string; name: string; completedAt: string | null } | null } | null;
  months: {
    id: string;
    month: MonthKey;
    amount: number;
    posted: boolean;
    postedAt: string | null;
    catchUp: boolean;
    entry: { id: string; entryNumber: string; date: string } | null;
  }[];
  adjustments: { id: string; creditNoteId: string; docNumber: string; amount: number; createdAt: string; reversedAt: string | null }[];
};

/** One schedule with its months (each with the entry that posted it) and its credit notes. Null when out of scope. */
export async function getSchedule(client: Client, params: { id: string; scope?: Scope }): Promise<ScheduleDetail | null> {
  const row = await client.revenueSchedule.findFirst({
    where: { AND: [{ id: params.id }, params.scope ?? {}] },
    select: {
      ...rowSelect,
      document: { select: { id: true, docNumber: true, docType: true, status: true, issueDate: true } },
      billingMilestone: { select: { id: true, label: true, deliveryMilestone: { select: { id: true, name: true, completedAt: true } } } },
    },
  });
  if (!row) return null;
  const months = await client.revenueSchedule.findUnique({
    where: { id: row.id },
    select: {
      lines: {
        orderBy: { month: "asc" },
        select: { id: true, month: true, amount: true, postedAt: true, catchUp: true, entry: { select: { id: true, entryNumber: true, date: true } } },
      },
      adjustments: {
        orderBy: { createdAt: "asc" },
        select: { id: true, amount: true, createdAt: true, reversedAt: true, document: { select: { id: true, docNumber: true } } },
      },
    },
  });
  const base = toRow(row);
  return {
    ...base,
    note: row.note,
    spreadEvenly: row.spreadEvenly,
    document: row.document
      ? { id: row.document.id, docNumber: row.document.docNumber, docType: row.document.docType, status: row.document.status, issueDate: row.document.issueDate.toISOString() }
      : null,
    billingMilestone: row.billingMilestone
      ? {
          id: row.billingMilestone.id,
          label: row.billingMilestone.label,
          deliveryMilestone: row.billingMilestone.deliveryMilestone
            ? { id: row.billingMilestone.deliveryMilestone.id, name: row.billingMilestone.deliveryMilestone.name, completedAt: iso(row.billingMilestone.deliveryMilestone.completedAt) }
            : null,
        }
      : null,
    months: (months?.lines ?? []).map((l) => ({
      id: l.id,
      month: monthKeyOfDate(l.month),
      amount: Number(l.amount),
      posted: l.entry !== null,
      postedAt: iso(l.postedAt),
      catchUp: l.catchUp,
      entry: l.entry ? { id: l.entry.id, entryNumber: l.entry.entryNumber, date: l.entry.date.toISOString() } : null,
    })),
    adjustments: (months?.adjustments ?? []).map((a) => ({
      id: a.id,
      creditNoteId: a.document.id,
      docNumber: a.document.docNumber,
      amount: Number(a.amount),
      createdAt: a.createdAt.toISOString(),
      reversedAt: iso(a.reversedAt),
    })),
  };
}

// ─── The roll-forward ────────────────────────────────────────────────────────────────────────────

export type RollForwardBucket = "deferred" | "recognised" | "credited" | "opening" | "cancelled";

/**
 * Which part of the roll-forward an entry's Deferred Revenue line belongs to, or null when the entry
 * is not the engine's own — a hand-written journal, a reversal typed in by somebody — which is what
 * makes the roll-forward disagree with the ledger.
 */
export function bucketOf(entry: { source: JournalSource; narration: string; reverses: { source: JournalSource } | null }): RollForwardBucket | null {
  switch (entry.source) {
    case "INVOICE":
      return "deferred";
    case "CREDIT_NOTE":
      return "credited";
    case "MANUAL":
      // A cancelled document's reversal (journal.ts `reverseDocumentPosting`, and the FX repair's).
      if (entry.reverses?.source === "INVOICE") return "cancelled";
      if (entry.reverses?.source === "CREDIT_NOTE") return "credited";
      return null;
    case "REVENUE": {
      const n = entry.narration;
      if (n.startsWith(NARRATION.recognised) || n.startsWith(NARRATION.scheduleCancelled) || n.startsWith(NARRATION.remeasured) || n.startsWith(NARRATION.restoredRecognised)) {
        return "recognised";
      }
      if (n.startsWith(NARRATION.opening)) return "opening";
      if (n.startsWith(NARRATION.invoiceCancelled)) return "cancelled";
      if (n.startsWith(NARRATION.creditRestored)) return "credited";
      return null;
    }
    default:
      return null;
  }
}

export type RollForward = {
  month: MonthKey;
  /** The engine's balance at the start of the month. */
  opening: number;
  /** Credited by invoices issued in the month. */
  deferredFromInvoices: number;
  /** Moved into Sales: the runs, schedules cancelled or re-measured by hand. */
  recognised: number;
  /** Taken off by credit notes (net of credit notes cancelled). */
  credited: number;
  /** Put in by the "Open deferred revenue" wizard. */
  openingAdjustments: number;
  /** Taken out by invoices cancelled in the month (net of what their schedules had recognised). */
  cancelled: number;
  /** opening + deferred − recognised − credited + opening adjustments − cancelled. */
  closing: number;
  /** The ledger's Deferred Revenue balance at the month end. */
  ledger: number;
  /** ledger − closing: movements on Deferred Revenue the engine didn't make. Nil when all is well. */
  difference: number;
  /** Those movements, before the month and in it (credit positive). */
  unexplained: { before: number; inMonth: number };
};

/**
 * The deferred revenue roll-forward for a month (spec §3.8), built from the ledger's Deferred Revenue
 * lines: each is put in the part of the roll-forward the engine entry that wrote it belongs to, so the
 * closing figure is what the engine alone would leave there. The ledger's own balance sits beside it;
 * a difference is a journal somebody posted to Deferred Revenue by hand.
 */
export async function rollForward(client: Client, month: MonthKey): Promise<RollForward> {
  if (!isMonthKey(month)) throw new RangeError(`"${month}" is not a month (yyyy-mm).`);
  const window = monthWindow(month);
  const account = await client.ledgerAccount.findFirst({ where: { systemKey: SYSTEM_ACCOUNTS.DEFERRED_REVENUE }, select: { id: true } });
  const lines = account
    ? await client.journalLine.findMany({
        where: { accountId: account.id, entry: { date: { lt: window.to } } },
        select: { debit: true, credit: true, entry: { select: { date: true, source: true, narration: true, reverses: { select: { source: true } } } } },
      })
    : [];

  const movement = { deferred: 0, recognised: 0, credited: 0, opening: 0, cancelled: 0 } as Record<RollForwardBucket, number>;
  let openingBalance = 0;
  let ledger = 0;
  const unexplained = { before: 0, inMonth: 0 };
  for (const l of lines) {
    const net = Number(l.credit) - Number(l.debit);
    ledger += net;
    const bucket = bucketOf(l.entry);
    const inMonth = l.entry.date >= window.from;
    if (!bucket) {
      if (inMonth) unexplained.inMonth += net;
      else unexplained.before += net;
      continue;
    }
    if (inMonth) movement[bucket] += net;
    else openingBalance += net;
  }
  const opening = round2(openingBalance);
  const deferredFromInvoices = round2(movement.deferred);
  const recognised = round2(-movement.recognised);
  const credited = round2(-movement.credited);
  const openingAdjustments = round2(movement.opening);
  const cancelled = round2(-movement.cancelled);
  const closing = round2(opening + deferredFromInvoices - recognised - credited + openingAdjustments - cancelled);
  const ledgerBalance = round2(ledger);
  return {
    month,
    opening,
    deferredFromInvoices,
    recognised,
    credited,
    openingAdjustments,
    cancelled,
    closing,
    ledger: ledgerBalance,
    difference: round2(ledgerBalance - closing),
    unexplained: { before: round2(unexplained.before), inMonth: round2(unexplained.inMonth) },
  };
}

/**
 * The schedules against the ledger, now: what every live schedule has left to recognise, and what
 * Deferred Revenue holds. They agree unless something moved one without the other.
 */
export async function deferredTieOut(client: Client): Promise<{ schedules: number; ledger: number; difference: number }> {
  const [rows, account] = await Promise.all([
    client.revenueSchedule.findMany({ where: { status: { in: ["ACTIVE", "PENDING_APPROVAL"] } }, select: scheduleStateSelect }),
    client.ledgerAccount.findFirst({ where: { systemKey: SYSTEM_ACCOUNTS.DEFERRED_REVENUE }, select: { id: true } }),
  ]);
  const schedules = sum(rows.map((r) => unrecognisedOf(toState(r))));
  const totals = account ? await client.journalLine.aggregate({ where: { accountId: account.id }, _sum: { debit: true, credit: true } }) : null;
  const ledger = round2(Number(totals?._sum.credit ?? 0) - Number(totals?._sum.debit ?? 0));
  return { schedules, ledger, difference: round2(ledger - schedules) };
}

// ─── The waterfall ───────────────────────────────────────────────────────────────────────────────

export type WaterfallRow = {
  key: string;
  label: string;
  /** Unposted months before the first column — overdue, recognised by the next run. */
  pastDue: number;
  byMonth: number[];
  /** Months after the last column. */
  later: number;
  /** Milestone revenue waiting on its delivery, with no month yet. */
  unscheduled: number;
  /** All of it: the remaining performance obligation. */
  total: number;
  schedules: number;
  pending: number;
};

export type Waterfall = { by: "customer" | "item"; months: MonthKey[]; rows: WaterfallRow[]; totals: WaterfallRow };

/**
 * Revenue still to be recognised, by customer or by item, month by month from the current one for
 * 12 or 24 months (spec §3.8). Live schedules only — ACTIVE, and PENDING_APPROVAL ones, whose revenue
 * is contracted all the same. The totals are the remaining performance obligation.
 */
export async function waterfall(
  client: Client,
  params: { by: "customer" | "item"; months: 12 | 24; now?: Date; scope?: Scope },
): Promise<Waterfall> {
  const start = monthKeyAt(params.now ?? new Date());
  const columns = monthsBetween(start, addMonths(start, params.months - 1));
  const index = new Map(columns.map((m, i) => [m, i]));
  const rows = await client.revenueSchedule.findMany({
    where: { AND: [params.scope ?? {}, { status: { in: ["ACTIVE", "PENDING_APPROVAL"] } }] },
    select: { ...scheduleStateSelect, itemId: true, company: { select: { name: true } }, item: { select: { name: true } } },
  });

  const blank = (key: string, label: string): WaterfallRow => ({
    key, label, pastDue: 0, byMonth: columns.map(() => 0), later: 0, unscheduled: 0, total: 0, schedules: 0, pending: 0,
  });
  const out = new Map<string, WaterfallRow>();
  const totals = blank("total", "Total");
  for (const r of rows) {
    const s = toState(r);
    const key = params.by === "customer" ? s.companyId : (r.itemId ?? "none");
    const label = params.by === "customer" ? r.company.name : (r.item?.name ?? "No item");
    const row = out.get(key) ?? blank(key, label);
    row.schedules += 1;
    totals.schedules += 1;
    if (s.status === "PENDING_APPROVAL") {
      row.pending += 1;
      totals.pending += 1;
    }
    const add = (target: "pastDue" | "later" | "unscheduled" | number, amount: number) => {
      for (const x of [row, totals]) {
        if (typeof target === "number") x.byMonth[target] = round2(x.byMonth[target] + amount);
        else x[target] = round2(x[target] + amount);
        x.total = round2(x.total + amount);
      }
    };
    if (s.kind === "MILESTONE" && s.lines.length === 0) {
      add("unscheduled", unrecognisedOf(s));
    } else {
      for (const l of s.lines) {
        if (l.posted) continue;
        const i = index.get(l.month);
        add(i !== undefined ? i : l.month < start ? "pastDue" : "later", l.amount);
      }
    }
    out.set(key, row);
  }
  return {
    by: params.by,
    months: columns,
    rows: [...out.values()].filter((r) => r.total !== 0).sort((a, b) => b.total - a.total || a.label.localeCompare(b.label)),
    totals,
  };
}

// ─── A customer's revenue ────────────────────────────────────────────────────────────────────────

export type CustomerRevenue = {
  companyId: string;
  month: MonthKey;
  /** Revenue on issued invoices, in rupees at each one's rate — freight and tax excluded. */
  invoiced: number;
  /** Less issued credit notes. */
  credited: number;
  /** Earned so far: invoiced − credited − deferred. */
  recognised: number;
  /** Still in Deferred Revenue. */
  deferred: number;
  /** Scheduled for the next 12 months, this one included. */
  next12Months: number;
  /** This month's RATABLE recognition. */
  mrr: number;
  schedules: { active: number; pending: number; completed: number; cancelled: number };
};

/** The customer card on the company page (spec §3.8). The action checks the company is in the caller's scope. */
export async function customerRevenue(client: Client, params: { companyId: string; now?: Date }): Promise<CustomerRevenue> {
  const month = monthKeyAt(params.now ?? new Date());
  const horizon = addMonths(month, 11);
  const issued = { companyId: params.companyId, status: { notIn: ["DRAFT", "CANCELLED"] as ("DRAFT" | "CANCELLED")[] } };
  const [invoices, credits, rows] = await Promise.all([
    client.tradeDocument.findMany({ where: { ...issued, docType: "INVOICE" }, select: documentPostingSelect }),
    client.tradeDocument.findMany({ where: { ...issued, docType: "CREDIT_NOTE" }, select: documentPostingSelect }),
    client.revenueSchedule.findMany({ where: { companyId: params.companyId }, select: scheduleStateSelect }),
  ]);
  const states: ScheduleState[] = rows.map(toState);
  const invoiced = sum(invoices.map(revenueInRupees));
  const credited = sum(credits.map(revenueInRupees));
  const deferred = sum(states.map(unrecognisedOf));
  const live = states.filter((s) => s.status === "ACTIVE" || s.status === "PENDING_APPROVAL");
  const next12Months = sum(live.flatMap((s) => s.lines.filter((l) => !l.posted && l.month >= month && l.month <= horizon).map((l) => l.amount)));
  const mrr = sum(
    states
      .filter((s) => s.kind === "RATABLE" && (s.status === "ACTIVE" || s.status === "COMPLETED"))
      .flatMap((s) => s.lines.filter((l) => l.month === month).map((l) => l.amount)),
  );
  const count = (status: RevenueScheduleStatus) => states.filter((s) => s.status === status).length;
  return {
    companyId: params.companyId,
    month,
    invoiced,
    credited,
    recognised: round2(invoiced - credited - deferred),
    deferred,
    next12Months,
    mrr,
    schedules: { active: count("ACTIVE"), pending: count("PENDING_APPROVAL"), completed: count("COMPLETED"), cancelled: count("CANCELLED") },
  };
}
