import type { Prisma } from "@prisma/client";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/chart";
import { documentPostingSelect, resolveAccounts, revenueInRupees, writeEntry } from "@/lib/ledger/journal";
import { indiaClock } from "@/lib/time/zone";
import {
  addMonths,
  asDayKey,
  dayDate,
  dayKeyAt,
  dayLabel,
  firstDay,
  isDayKey,
  isMonthKey,
  isMonthOpen,
  lastDay,
  lineRupees,
  monthDate,
  monthEntryDate,
  monthKeyAt,
  round2,
  spreadByDay,
  spreadEvenly,
  termDays,
  type DayKey,
  type MonthAmount,
  type MonthKey,
} from "@/lib/revenue/periods";
import { spreadEvenlySetting } from "@/lib/revenue/deferral";
import { MAX_PERIOD_DAYS, ScheduleRefusal } from "@/lib/revenue/schedules";
import { NARRATION, tagKey } from "@/lib/revenue/state";

/**
 * "Open deferred revenue as at <month end>" (spec §3.7, owner decision D4).
 *
 * Invoices issued before the add-on booked their whole revenue to Sales, and nothing restates them on
 * its own. This wizard lets somebody say what period each service or subscription line covered; the
 * part not yet earned at the month end moves from Sales to Deferred Revenue in one adjusting entry, and
 * a schedule per line recognises it from the following month. Those schedules were made by hand, so
 * they start PENDING_APPROVAL (D2) and a second person approves them.
 */

type Tx = Prisma.TransactionClient;
type Client = Pick<Tx, "tradeDocument" | "tradeDocumentLine" | "revenueCloseSettings">;

/** How far back the wizard looks: invoices from the 24 months up to the month end. */
export const OPENING_LOOKBACK_MONTHS = 24;
const OPENING_ITEM_TYPES = ["SERVICE", "SUBSCRIPTION"] as const;

export type OpeningCandidate = {
  documentId: string;
  docNumber: string;
  issueDate: DayKey;
  companyId: string;
  companyName: string;
  currency: string;
  lines: {
    lineId: string;
    name: string;
    itemType: string | null;
    /** The line's share of the invoice's revenue, in rupees at the invoice's rate. */
    amount: number;
    /** The period the line carries already, if any — a starting point for the form. */
    from: DayKey | null;
    to: DayKey | null;
  }[];
};

function checkAsAt(asAt: MonthKey, now: Date) {
  if (!isMonthKey(asAt)) throw new ScheduleRefusal("Choose the month end to open deferred revenue at.");
  if (asAt > monthKeyAt(now)) throw new ScheduleRefusal("Deferred revenue can't be opened at a month that hasn't started.");
}

/**
 * The instants an invoice must be issued between to be a candidate: the 24 months up to the month end.
 * India's months in every workspace: revenue is recognised in the books' months.
 */
function lookback(asAt: MonthKey) {
  const first = addMonths(asAt, -(OPENING_LOOKBACK_MONTHS - 1));
  const [fy, fm] = [Number(first.slice(0, 4)), Number(first.slice(5, 7)) - 1];
  const [ey, em] = [Number(asAt.slice(0, 4)), Number(asAt.slice(5, 7)) - 1];
  return { from: indiaClock.midnight(fy, fm, 1), to: indiaClock.midnight(ey, em + 1, 1) };
}

const invoiceSelect = {
  ...documentPostingSelect,
  status: true,
  company: { select: { name: true } },
  lines: {
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      taxableValue: true,
      servicePeriodFrom: true,
      servicePeriodTo: true,
      itemId: true,
      companyProductId: true,
      item: { select: { type: true } },
      revenueSchedule: { select: { id: true } },
    },
  },
} satisfies Prisma.TradeDocumentSelect;

type Invoice = Prisma.TradeDocumentGetPayload<{ select: typeof invoiceSelect }>;

const opensable = (line: Invoice["lines"][number]) =>
  !line.revenueSchedule && !!line.item && (OPENING_ITEM_TYPES as readonly string[]).includes(line.item.type);

/**
 * Issued invoices from the 24 months up to `asAt` with a service or subscription line that has no
 * schedule yet. `scope` narrows it to the customers the caller may see.
 */
export async function openingCandidates(
  client: Client,
  params: { asAt: MonthKey; scope?: Prisma.TradeDocumentWhereInput; now?: Date },
): Promise<OpeningCandidate[]> {
  checkAsAt(params.asAt, params.now ?? new Date());
  const window = lookback(params.asAt);
  const invoices = await client.tradeDocument.findMany({
    where: {
      ...(params.scope ?? {}),
      docType: "INVOICE",
      status: { notIn: ["DRAFT", "CANCELLED"] },
      issueDate: { gte: window.from, lt: window.to },
      lines: { some: { revenueSchedule: { is: null }, item: { type: { in: [...OPENING_ITEM_TYPES] } } } },
    },
    orderBy: [{ issueDate: "asc" }, { docNumber: "asc" }],
    select: invoiceSelect,
  });
  return invoices.map((doc) => {
    const shares = lineRupees(revenueInRupees(doc), doc.lines.map((l) => Number(l.taxableValue)));
    return {
      documentId: doc.id,
      docNumber: doc.docNumber,
      issueDate: dayKeyAt(doc.issueDate),
      companyId: doc.companyId,
      companyName: doc.company.name,
      currency: doc.currency,
      lines: doc.lines
        .map((l, i) => ({ line: l, amount: shares[i] }))
        .filter(({ line, amount }) => opensable(line) && amount > 0)
        .map(({ line, amount }) => ({
          lineId: line.id,
          name: line.name,
          itemType: line.item?.type ?? null,
          amount,
          from: line.servicePeriodFrom ? asDayKey(line.servicePeriodFrom) : null,
          to: line.servicePeriodTo ? asDayKey(line.servicePeriodTo) : null,
        })),
    };
  });
}

export type OpeningLineInput = { lineId: string; from: DayKey; to: DayKey };

export type OpeningPreviewLine = {
  lineId: string;
  documentId: string | null;
  docNumber: string | null;
  name: string | null;
  /** The line's revenue in rupees. */
  amount: number;
  /** The period as entered. */
  from: DayKey;
  to: DayKey;
  /** Where the schedule starts: the day after the month end, or the period's start when that is later. */
  scheduleFrom: DayKey;
  /** What is not yet earned at the month end — the schedule's amount. */
  unearned: number;
  /** The months it will be recognised in, from the month after the month end. */
  months: MonthAmount[];
  /** Why this line can't be opened, when it can't. */
  problem: string | null;
  // For posting:
  companyId: string | null;
  itemId: string | null;
  companyProductId: string | null;
  branchId: string | null;
  gstRegistrationId: string | null;
};

/**
 * What each line would open with at the end of `asAt`: its revenue spread over the period entered
 * (by day, or evenly when that is the setting), and the months after `asAt` — the unearned part, and
 * the months the schedule will hold. Lines that can't be opened say why.
 */
export async function previewOpening(
  client: Client & Pick<Tx, "branch">,
  params: { asAt: MonthKey; lines: OpeningLineInput[]; now?: Date },
): Promise<{ asAt: MonthKey; lines: OpeningPreviewLine[]; total: number }> {
  const now = params.now ?? new Date();
  checkAsAt(params.asAt, now);
  if (params.lines.length === 0) throw new ScheduleRefusal("Choose at least one line.");
  const lineIds = [...new Set(params.lines.map((l) => l.lineId))];
  if (lineIds.length !== params.lines.length) throw new ScheduleRefusal("A line is listed twice.");

  const window = lookback(params.asAt);
  const docs = await client.tradeDocument.findMany({ where: { lines: { some: { id: { in: lineIds } } } }, select: invoiceSelect });
  const evenly = await spreadEvenlySetting(client);
  const headOffice = await client.branch.findFirst({ where: { isHeadOffice: true }, select: { id: true } });
  const after = firstDay(addMonths(params.asAt, 1));

  const lines = params.lines.map((input): OpeningPreviewLine => {
    const doc = docs.find((d) => d.lines.some((l) => l.id === input.lineId));
    const index = doc ? doc.lines.findIndex((l) => l.id === input.lineId) : -1;
    const line = doc && index >= 0 ? doc.lines[index] : null;
    const amount = doc && line ? lineRupees(revenueInRupees(doc), doc.lines.map((l) => Number(l.taxableValue)))[index] : 0;
    const base: OpeningPreviewLine = {
      lineId: input.lineId,
      documentId: doc?.id ?? null,
      docNumber: doc?.docNumber ?? null,
      name: line?.name ?? null,
      amount,
      from: input.from,
      to: input.to,
      scheduleFrom: input.from > after ? input.from : after,
      unearned: 0,
      months: [],
      problem: null,
      companyId: doc?.companyId ?? null,
      itemId: line?.itemId ?? null,
      companyProductId: line?.companyProductId ?? null,
      branchId: doc ? (doc.branchId ?? headOffice?.id ?? null) : null,
      gstRegistrationId: doc?.gstRegistrationId ?? null,
    };
    const problem = (why: string) => ({ ...base, problem: why });
    if (!doc || !line) return problem("That invoice line no longer exists.");
    if (doc.docType !== "INVOICE" || doc.status === "DRAFT" || doc.status === "CANCELLED") return problem(`${doc.docNumber} isn't an issued invoice.`);
    if (doc.issueDate < window.from || doc.issueDate >= window.to) {
      return problem(`${doc.docNumber} wasn't issued in the ${OPENING_LOOKBACK_MONTHS} months up to the end of ${params.asAt}.`);
    }
    if (line.revenueSchedule) return problem("This line already has a revenue schedule.");
    if (!opensable(line)) return problem("Only service and subscription lines are opened.");
    if (!(amount > 0)) return problem("This line has no revenue to defer.");
    if (!isDayKey(input.from) || !isDayKey(input.to)) return problem("Enter the period as two dates.");
    if (input.to < input.from) return problem("The period can't end before it starts.");
    if (termDays(input.from, input.to) > MAX_PERIOD_DAYS) return problem("A service period can be ten years at most.");
    const spread = (evenly ? spreadEvenly : spreadByDay)(amount, input.from, input.to);
    const months = spread.filter((m) => m.month > params.asAt && m.amount > 0);
    const unearned = round2(months.reduce((t, m) => t + m.amount, 0));
    if (unearned <= 0) return problem(`All of it was earned by ${dayLabel(lastDay(params.asAt))}: there is nothing to defer.`);
    return { ...base, unearned, months };
  });
  const total = round2(lines.filter((l) => !l.problem).reduce((t, l) => t + l.unearned, 0));
  return { asAt: params.asAt, lines, total };
}

/**
 * Opens deferred revenue at the end of `asAt`: one adjusting entry — Dr Sales, Cr Deferred Revenue,
 * per branch, GSTIN and customer — dated that month end, which must be open; and a schedule per line,
 * `opening`, PENDING_APPROVAL, holding the unearned months. Refused whole if any line can't be opened.
 *
 * Each schedule's period is what is left of the line's period after the month end, so a later
 * re-plan spreads over those months only and never back into months already booked to Sales.
 */
export async function postOpening(
  tx: Tx,
  params: { asAt: MonthKey; lines: OpeningLineInput[]; actorId: string; now?: Date },
): Promise<{ entry: { id: string; entryNumber: string }; scheduleIds: string[]; total: number }> {
  const preview = await previewOpening(tx, params);
  const refused = preview.lines.find((l) => l.problem);
  if (refused) throw new ScheduleRefusal(`${refused.docNumber ?? "A line"}${refused.name ? ` · ${refused.name}` : ""}: ${refused.problem}`);

  const lock = await tx.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
  if (!isMonthOpen(params.asAt, lock?.lockedUntil)) {
    throw new ScheduleRefusal(`The books are closed to ${lock!.lockedUntil!.toISOString().slice(0, 10)}, so deferred revenue can't be opened at the end of ${params.asAt}. Choose an open month.`);
  }

  const groups = new Map<string, { branchId: string | null; gstRegistrationId: string | null; companyId: string; amount: number }>();
  for (const l of preview.lines) {
    const tags = { branchId: l.branchId, gstRegistrationId: l.gstRegistrationId, companyId: l.companyId! };
    const g = groups.get(tagKey(tags)) ?? { ...tags, amount: 0 };
    g.amount = round2(g.amount + l.unearned);
    groups.set(tagKey(tags), g);
  }
  const accounts = await resolveAccounts(tx, [SYSTEM_ACCOUNTS.SALES, SYSTEM_ACCOUNTS.DEFERRED_REVENUE]);
  const n = preview.lines.length;
  const entry = await writeEntry(tx, {
    date: monthEntryDate(params.asAt),
    narration: `${NARRATION.opening}as at ${dayLabel(lastDay(params.asAt))} (${n} line${n === 1 ? "" : "s"})`,
    source: "REVENUE",
    userId: params.actorId,
    companyId: groups.size === 1 ? [...groups.values()][0].companyId : null,
    lines: [...groups.values()].flatMap((g) => [
      { accountId: accounts.get(SYSTEM_ACCOUNTS.SALES)!, debit: g.amount, credit: 0, companyId: g.companyId, branchId: g.branchId, gstRegistrationId: g.gstRegistrationId },
      { accountId: accounts.get(SYSTEM_ACCOUNTS.DEFERRED_REVENUE)!, debit: 0, credit: g.amount, companyId: g.companyId, branchId: g.branchId, gstRegistrationId: g.gstRegistrationId },
    ]),
  });

  const evenly = await spreadEvenlySetting(tx);
  const scheduleIds: string[] = [];
  for (const l of preview.lines) {
    const created = await tx.revenueSchedule.create({
      data: {
        documentId: l.documentId,
        lineId: l.lineId,
        companyId: l.companyId!,
        itemId: l.itemId,
        companyProductId: l.companyProductId,
        kind: "RATABLE",
        status: "PENDING_APPROVAL",
        amount: l.unearned,
        startDate: dayDate(l.scheduleFrom),
        endDate: dayDate(l.to),
        spreadEvenly: evenly,
        opening: true,
        branchId: l.branchId,
        gstRegistrationId: l.gstRegistrationId,
        createdById: params.actorId,
        note: `Opened as at ${dayLabel(lastDay(params.asAt))} (${entry.entryNumber})`,
        lines: { create: l.months.map((m) => ({ month: monthDate(m.month), amount: m.amount })) },
      },
      select: { id: true },
    });
    scheduleIds.push(created.id);
  }
  return { entry, scheduleIds, total: preview.total };
}
