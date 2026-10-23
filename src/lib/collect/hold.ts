import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { settleInvoice } from "@/lib/receivables";
import { workspaceClock } from "@/lib/time/workspace";
import { collectionConfig } from "@/lib/collect/settings";
import { RECEIVABLE_DOC_TYPE } from "@/lib/trade-documents";

/**
 * Credit hold (owner, 23 Oct 2026): a customer with an invoice more than the set number of days overdue
 * (Settings › Payment collection, 60 unless changed) is on hold — their new orders need a credit override to
 * be approved (src/lib/credit/order.ts). Orders paid in advance aren't credit, so aren't held; quotes never are.
 */

export type CreditHold = { holdDays: number; oldestDays: number; overdue: number; invoices: number };

const DAY = 86_400_000;

export async function creditHoldFor(companyId: string, now: Date = new Date()): Promise<CreditHold | null> {
  const config = await collectionConfig();
  if (!config.creditHoldOn) return null;
  const today = (await workspaceClock()).calendarDate(now);
  const cutoff = new Date(today.getTime() - config.creditHoldDays * DAY);
  const late: Prisma.TradeDocumentWhereInput = { OR: [{ dueDate: { lt: cutoff } }, { dueDate: null, issueDate: { lt: cutoff } }] };
  const rows = await db.tradeDocument.findMany({
    where: { AND: [{ companyId, docType: RECEIVABLE_DOC_TYPE, status: { in: ["ISSUED", "PARTIALLY_PAID"] } }, late] },
    select: { issueDate: true, dueDate: true, total: true, paidBefore: true, payments: { select: { amount: true } }, creditsReceived: { select: { amount: true } } },
    take: 500,
  });
  const sum = (r: { amount: Prisma.Decimal }[]) => r.reduce((t, x) => t + Number(x.amount), 0);
  const open = rows
    .map((r) => ({ due: r.dueDate ?? r.issueDate, balance: settleInvoice(Number(r.total), sum(r.payments), sum(r.creditsReceived), Number(r.paidBefore)).balance }))
    .filter((r) => r.balance >= 1);
  if (open.length === 0) return null;
  const oldest = Math.min(...open.map((r) => r.due.getTime()));
  return {
    holdDays: config.creditHoldDays,
    oldestDays: Math.round((today.getTime() - oldest) / DAY),
    overdue: open.reduce((t, r) => t + r.balance, 0),
    invoices: open.length,
  };
}
