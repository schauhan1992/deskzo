import type { FollowUpChannel, Prisma, PromiseStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { accountScopeIds } from "@/lib/authz/company-scope";
import { can } from "@/lib/authz/resolve";
import { computeOrderFinancials } from "@/lib/orders/financials";
import { settleInvoice, agingBucket, daysOverdue, type AgingBucket } from "@/lib/receivables";
import { bookingRate } from "@/lib/ledger/posting";
import { TERMS_DAYS } from "@/lib/credit/engine";
import { formatOrderId } from "@/lib/order-id";
import { STALE_DAYS, dayKey, inWeek, promiseState, type PromiseState } from "@/lib/collections/rules";
import { workspaceClock } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";

/**
 * What a person may chase, and what has been said about it — the database side of Collections.
 *
 * A plain module, not `"use server"`: it answers for whoever it is handed, so it is reached only through
 * src/actions/collections.ts (and receivable.ts), which have already checked who is asking.
 *
 * ## The scope (owner decision C-D1)
 *
 * The dues on the accounts somebody manages — `accountScopeIds`, so a manager's include their team's —
 * **plus** any order they punched on somebody else's account, and the invoices billing those orders. For
 * a manager, "they" is the same set of people as the account rule: an order a report punched on another
 * account is in the manager's list, as that report's accounts are. `companies.viewAll` sees everything.
 * Nothing else widens it: the where clauses below are the only way a row gets in.
 */

const DAY = 86_400_000;
/** Invoice states still owed on — as the ageing report reads them. */
const OPEN_INVOICE = { notIn: ["DRAFT", "CANCELLED", "PAID"] } as Prisma.EnumTradeDocumentStatusFilter;
/** An order is billed once an invoice in one of these states carries it (as the credit engine reads it). */
const BILLED_INVOICE = ["ISSUED", "PARTIALLY_PAID", "PAID"] as const;
/** The orders that owe money in their own right: approved and not cancelled (the credit engine's rule). */
const CHASED_ORDER = ["APPROVED", "PROCESSING", "FULFILLED"] as const;

/** Whose accounts and whose punched orders a person's collections cover: `null` for everyone's. */
export async function collectionsScopeIds(userId: string): Promise<string[] | null> {
  return accountScopeIds(userId);
}

/**
 * Who may open Collections and log a follow-up: `collections.followUp` (off by default, granted by the
 * admin) or `payments.record` (accounts) — with the Receivables module's own view permission, as every
 * money screen needs.
 */
export async function mayLogFollowUps(userId: string): Promise<boolean> {
  if (!(await can(userId, "payments.view"))) return false;
  return (await can(userId, "collections.followUp")) || (await can(userId, "payments.record"));
}

/** The invoices in a person's collections scope. */
export function invoiceScope(ids: string[] | null): Prisma.TradeDocumentWhereInput {
  if (ids === null) return {};
  return {
    OR: [{ company: { ownerUserId: { in: ids } } }, { lines: { some: { companyProduct: { addedByUserId: { in: ids } } } } }],
  };
}

/** The orders in a person's collections scope. */
export function orderScope(ids: string[] | null): Prisma.CompanyProductWhereInput {
  if (ids === null) return {};
  return { OR: [{ company: { ownerUserId: { in: ids } } }, { addedByUserId: { in: ids } }] };
}

/**
 * Whether one invoice or order is in a person's collections scope — for logging a follow-up, which must
 * refuse rather than filter.
 */
export async function inCollectionsScope(userId: string, target: { documentId?: string | null; companyProductId?: string | null }) {
  const ids = await collectionsScopeIds(userId);
  if (ids === null) return true;
  if (target.documentId) {
    return (await db.tradeDocument.count({ where: { AND: [{ id: target.documentId }, invoiceScope(ids)] } })) === 1;
  }
  if (target.companyProductId) {
    return (await db.companyProduct.count({ where: { AND: [{ id: target.companyProductId }, orderScope(ids)] } })) === 1;
  }
  return false;
}

// ── Follow-ups, as every screen shows them ────────────────────────────────────────────────────────

export const followUpSelect = {
  id: true,
  createdAt: true,
  channel: true,
  remarks: true,
  promisedOn: true,
  promisedAmount: true,
  promiseStatus: true,
  nextFollowUpOn: true,
  documentId: true,
  companyProductId: true,
  byUser: { select: { id: true, name: true } },
  document: { select: { docNumber: true, currency: true } },
  companyProduct: { select: { orderSeq: true } },
} as const satisfies Prisma.PaymentFollowUpSelect;

type FollowUpRow = Prisma.PaymentFollowUpGetPayload<{ select: typeof followUpSelect }>;

export type FollowUpView = {
  id: string;
  createdAt: Date;
  byName: string | null;
  channel: FollowUpChannel;
  remarks: string;
  /** `yyyy-mm-dd`, the promised day (a calendar day, the workspace's). */
  promisedOn: string | null;
  promisedAmount: number | null;
  /** The promised amount's currency: the invoice's when an invoice is chased, otherwise rupees. */
  currency: string;
  promiseStatus: PromiseStatus | null;
  /** How the promise reads today, in words and a tone. */
  promise: PromiseState | null;
  nextFollowUpOn: string | null;
  /** "INV-0012" or "ORD-000034" — what it was about. */
  targetLabel: string | null;
};

/** `clock` is the workspace's (`workspaceClock()`): a promise is due or broken by its today. */
export function toFollowUpView(row: FollowUpRow, clock: Clock, now: Date = new Date()): FollowUpView {
  return {
    id: row.id,
    createdAt: row.createdAt,
    byName: row.byUser?.name ?? null,
    channel: row.channel,
    remarks: row.remarks,
    promisedOn: row.promisedOn ? dayKey(row.promisedOn) : null,
    promisedAmount: row.promisedAmount === null ? null : Number(row.promisedAmount),
    currency: row.document?.currency ?? "INR",
    promiseStatus: row.promiseStatus,
    promise: row.promisedOn && row.promiseStatus ? promiseState({ promiseStatus: row.promiseStatus, promisedOn: row.promisedOn }, clock, now) : null,
    nextFollowUpOn: row.nextFollowUpOn ? dayKey(row.nextFollowUpOn) : null,
    targetLabel: row.document ? row.document.docNumber : row.companyProduct ? formatOrderId(row.companyProduct.orderSeq) : null,
  };
}

/** Follow-ups matching a where clause, newest first, as the screens show them. */
export async function loadFollowUps(where: Prisma.PaymentFollowUpWhereInput, now: Date = new Date(), take = 200): Promise<FollowUpView[]> {
  const [rows, clock] = await Promise.all([
    db.paymentFollowUp.findMany({ where, orderBy: { createdAt: "desc" }, take, select: followUpSelect }),
    workspaceClock(),
  ]);
  return rows.map((r) => toFollowUpView(r, clock, now));
}

/**
 * For the Receivables ageing list: each customer's last follow-up, and the promise that matters most
 * on their open invoices — a broken one first, then the soonest due. A promise made on an order before
 * it was invoiced counts as the invoice's, as it does on the Collections page.
 *
 * The caller has already scoped the customers and invoices; this only reads their follow-ups.
 */
export async function receivableFollowUps(
  invoices: { id: string; companyId: string; orderIds: string[] }[],
  now: Date = new Date(),
): Promise<Map<string, { lastFollowUp: FollowUpView | null; promise: FollowUpView | null; broken: boolean; promisedThisWeek: boolean }>> {
  const out = new Map<string, { lastFollowUp: FollowUpView | null; promise: FollowUpView | null; broken: boolean; promisedThisWeek: boolean }>();
  if (invoices.length === 0) return out;
  const companyIds = [...new Set(invoices.map((i) => i.companyId))];
  const invoiceOfOrder = new Map(invoices.flatMap((i) => i.orderIds.map((o) => [o, i.id] as const)));
  const companyOfInvoice = new Map(invoices.map((i) => [i.id, i.companyId]));
  const [latest, promises] = await Promise.all([
    db.paymentFollowUp.findMany({ where: { companyId: { in: companyIds } }, orderBy: { createdAt: "desc" }, distinct: ["companyId"], select: { ...followUpSelect, companyId: true } }),
    db.paymentFollowUp.findMany({
      where: {
        promiseStatus: { not: null },
        OR: [{ documentId: { in: invoices.map((i) => i.id) } }, ...(invoiceOfOrder.size ? [{ companyProductId: { in: [...invoiceOfOrder.keys()] } }] : [])],
      },
      orderBy: { createdAt: "desc" },
      select: followUpSelect,
    }),
  ]);
  const clock = await workspaceClock();
  for (const id of companyIds) out.set(id, { lastFollowUp: null, promise: null, broken: false, promisedThisWeek: false });
  for (const f of latest) out.get(f.companyId)!.lastFollowUp = toFollowUpView(f, clock, now);

  // The latest promise on each invoice is the one in play.
  const seen = new Set<string>();
  for (const f of promises) {
    const invoiceId = f.documentId ?? (f.companyProductId ? invoiceOfOrder.get(f.companyProductId) : undefined);
    if (!invoiceId || seen.has(invoiceId)) continue;
    seen.add(invoiceId);
    const view = toFollowUpView(f, clock, now);
    if (!view.promise || view.promiseStatus === "SUPERSEDED" || view.promiseStatus === "KEPT") continue;
    const entry = out.get(companyOfInvoice.get(invoiceId)!);
    if (!entry) continue;
    const broken = view.promise.state === "broken";
    const thisWeek = view.promiseStatus === "OPEN" && !broken && inWeek(new Date(`${view.promisedOn}T00:00:00Z`), clock, now);
    entry.broken ||= broken;
    entry.promisedThisWeek ||= thisWeek;
    // Broken beats due; of two due, the sooner.
    const current = entry.promise;
    const better =
      !current ||
      (broken && current.promise?.state !== "broken") ||
      (!broken && current.promise?.state !== "broken" && (view.promisedOn ?? "") < (current.promisedOn ?? ""));
    if (better) entry.promise = view;
  }
  return out;
}

// ── The dues ──────────────────────────────────────────────────────────────────────────────────────

export type DueRow = {
  key: string;
  kind: "invoice" | "order";
  id: string;
  /** INV-0012 / ORD-000034. */
  label: string;
  companyId: string;
  companySeq: number;
  companyName: string;
  /** The account manager's name, when there is one. */
  ownerName: string | null;
  /** In the viewer's own account scope — the invoice or order page will open for them. */
  onTheirAccount: boolean;
  /** Who punched it, for an order (or the orders an invoice bills) — "your order" on another's account. */
  punchedBy: string | null;
  issuedOn: Date;
  dueOn: Date;
  daysOverdue: number;
  bucket: AgingBucket;
  /** Outstanding, in its own currency. */
  balance: number;
  currency: string;
  /** Outstanding in rupees, at the invoice's own rate — for totals. */
  balanceInr: number;
  rate: number;
  history: FollowUpView[];
  lastFollowUp: FollowUpView | null;
  /** The latest promise, if it is still in play or was kept: OPEN, BROKEN or KEPT. */
  promise: FollowUpView | null;
  nextFollowUpOn: string | null;
  /** Nobody has followed this up in 14 days (or ever). */
  stale: boolean;
  broken: boolean;
  promisedThisWeek: boolean;
};

/**
 * Every due in a person's collections scope: unpaid invoices (in their own currency, with how overdue),
 * and the balances of orders nobody has invoiced — each with what has been said about it.
 */
export async function loadDues(userId: string, opts: { search?: string; now?: Date } = {}): Promise<{ restricted: boolean; ids: string[] | null; rows: DueRow[] }> {
  const now = opts.now ?? new Date();
  const ids = await collectionsScopeIds(userId);
  const search = opts.search?.trim();
  const byName: Prisma.CompanyWhereInput | null = search ? { name: { contains: search, mode: "insensitive" } } : null;

  const [invoices, orders] = await Promise.all([
    db.tradeDocument.findMany({
      where: {
        // The scope and the search both reach the company, so they are separate AND terms — two spreads
        // into one object keep only the last `company` key, and the one lost would be the scope.
        AND: [{ docType: "INVOICE", status: OPEN_INVOICE }, invoiceScope(ids), ...(byName ? [{ company: byName }] : [])],
      },
      select: {
        id: true,
        docNumber: true,
        issueDate: true,
        dueDate: true,
        total: true,
        currency: true,
        exchangeRate: true,
        company: { select: { id: true, companySeq: true, name: true, ownerUserId: true, owner: { select: { name: true } } } },
        payments: { select: { amount: true } },
        creditsReceived: { select: { amount: true } },
        lines: { where: { companyProductId: { not: null } }, select: { companyProductId: true, companyProduct: { select: { addedBy: { select: { id: true, name: true } } } } } },
      },
    }),
    db.companyProduct.findMany({
      where: {
        AND: [
          {
            orderStatus: { in: [...CHASED_ORDER] },
            // Not billed: once an invoice carries it, the invoice is what is chased.
            documentLines: { none: { document: { docType: "INVOICE", status: { in: [...BILLED_INVOICE] } } } },
          },
          orderScope(ids),
          ...(byName ? [{ company: byName }] : []),
        ],
      },
      select: {
        id: true,
        orderSeq: true,
        quantity: true,
        unitPrice: true,
        paymentTerms: true,
        accountsApprovedAt: true,
        createdAt: true,
        item: { select: { name: true, sellingPrice: true, taxRatePercent: true } },
        allocations: { select: { amount: true } },
        addedBy: { select: { id: true, name: true } },
        company: { select: { id: true, companySeq: true, name: true, ownerUserId: true, paymentTerms: true, owner: { select: { name: true } } } },
      },
    }),
  ]);

  const onTheirAccount = (ownerUserId: string | null) => ids === null || (ownerUserId !== null && ids.includes(ownerUserId));
  const rows: DueRow[] = [];

  for (const inv of invoices) {
    const settlement = settleInvoice(
      Number(inv.total),
      inv.payments.reduce((t, p) => t + Number(p.amount), 0),
      inv.creditsReceived.reduce((t, c) => t + Number(c.amount), 0),
    );
    if (settlement.balance < 0.01) continue;
    const rate = bookingRate(inv);
    const due = inv.dueDate ?? inv.issueDate;
    // Who in the viewer's scope punched an order this invoice bills — why it is in their list at all
    // when the account is somebody else's.
    const puncher = inv.lines.map((l) => l.companyProduct?.addedBy).find((u) => !!u && (ids === null || ids.includes(u.id)));
    rows.push({
      key: `invoice:${inv.id}`,
      kind: "invoice",
      id: inv.id,
      label: inv.docNumber,
      companyId: inv.company.id,
      companySeq: inv.company.companySeq,
      companyName: inv.company.name,
      ownerName: inv.company.owner?.name ?? null,
      onTheirAccount: onTheirAccount(inv.company.ownerUserId),
      punchedBy: puncher?.name ?? null,
      issuedOn: inv.issueDate,
      dueOn: due,
      daysOverdue: daysOverdue(inv.dueDate, inv.issueDate, now),
      bucket: agingBucket(inv.dueDate, inv.issueDate, now),
      balance: settlement.balance,
      currency: inv.currency,
      rate,
      balanceInr: Math.round(settlement.balance * rate * 100) / 100,
      history: [],
      lastFollowUp: null,
      promise: null,
      nextFollowUpOn: null,
      stale: true,
      broken: false,
      promisedThisWeek: false,
    });
  }

  for (const order of orders) {
    const { balance } = computeOrderFinancials(order);
    if (balance < 0.01) continue;
    // Billed when accounts approved it, due its own terms after that — as the credit engine dates it.
    const issuedOn = order.accountsApprovedAt ?? order.createdAt;
    const terms = order.paymentTerms ?? order.company.paymentTerms;
    const dueOn = new Date(issuedOn.getTime() + TERMS_DAYS[terms] * DAY);
    rows.push({
      key: `order:${order.id}`,
      kind: "order",
      id: order.id,
      label: formatOrderId(order.orderSeq),
      companyId: order.company.id,
      companySeq: order.company.companySeq,
      companyName: order.company.name,
      ownerName: order.company.owner?.name ?? null,
      onTheirAccount: onTheirAccount(order.company.ownerUserId),
      punchedBy: order.addedBy.name,
      issuedOn,
      dueOn,
      daysOverdue: daysOverdue(dueOn, issuedOn, now),
      bucket: agingBucket(dueOn, issuedOn, now),
      balance,
      currency: "INR",
      rate: 1,
      balanceInr: balance,
      history: [],
      lastFollowUp: null,
      promise: null,
      nextFollowUpOn: null,
      stale: true,
      broken: false,
      promisedThisWeek: false,
    });
  }

  await attachFollowUps(rows, invoices.flatMap((i) => i.lines.map((l) => ({ invoiceId: i.id, orderId: l.companyProductId! }))), now);
  return { restricted: ids !== null, ids, rows };
}

/**
 * Hangs each due's follow-ups on it: its own, and — for an invoice — those made on the orders it bills
 * before it was raised, so the story of a debt doesn't start again when the order is invoiced.
 */
async function attachFollowUps(rows: DueRow[], billed: { invoiceId: string; orderId: string }[], now: Date) {
  if (rows.length === 0) return;
  const invoiceIds = rows.filter((r) => r.kind === "invoice").map((r) => r.id);
  const orderIds = [...rows.filter((r) => r.kind === "order").map((r) => r.id), ...billed.map((b) => b.orderId)];
  const followUps = await db.paymentFollowUp.findMany({
    where: { OR: [{ documentId: { in: invoiceIds } }, { companyProductId: { in: orderIds } }] },
    orderBy: { createdAt: "desc" },
    select: followUpSelect,
  });
  const invoiceOfOrder = new Map(billed.map((b) => [b.orderId, b.invoiceId]));
  const clock = await workspaceClock();
  const byKey = new Map<string, FollowUpView[]>();
  for (const f of followUps) {
    const key = f.documentId
      ? `invoice:${f.documentId}`
      : f.companyProductId && invoiceOfOrder.has(f.companyProductId)
        ? `invoice:${invoiceOfOrder.get(f.companyProductId)}`
        : `order:${f.companyProductId}`;
    const list = byKey.get(key) ?? [];
    list.push(toFollowUpView(f, clock, now));
    byKey.set(key, list);
  }
  const staleBefore = now.getTime() - STALE_DAYS * DAY;
  for (const row of rows) {
    const history = byKey.get(row.key) ?? [];
    row.history = history;
    row.lastFollowUp = history[0] ?? null;
    const latestPromise = history.find((h) => h.promiseStatus !== null) ?? null;
    row.promise = latestPromise && latestPromise.promiseStatus !== "SUPERSEDED" ? latestPromise : null;
    // The plan made at the latest follow-up: a later call that set no date means nothing is planned.
    row.nextFollowUpOn = row.lastFollowUp?.nextFollowUpOn ?? null;
    row.stale = !row.lastFollowUp || row.lastFollowUp.createdAt.getTime() < staleBefore;
    row.broken = row.promise?.promise?.state === "broken";
    row.promisedThisWeek =
      row.promise?.promiseStatus === "OPEN" && row.promise.promisedOn !== null && inWeek(new Date(`${row.promise.promisedOn}T00:00:00Z`), clock, now);
  }
}
