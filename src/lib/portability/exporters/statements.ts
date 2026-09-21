import { db } from "@/lib/db";
import { ownScope, type Exporter } from "./types";

/**
 * What each account was invoiced, what they have paid, and what is still outstanding.
 *
 * ## Why this is computed rather than read
 *
 * There is no statement table, and there should not be one. A statement is the arithmetic on
 * invoices, credit notes and receipts at the moment somebody asks — store it and it is wrong by the
 * next payment, and then there are two answers to "what does Acme owe" with nothing to say which is
 * right. That is also why the area refuses import: there is nothing to import into. Import the
 * invoices and the payments, and the statement follows.
 *
 * ## What counts
 *
 * Only issued sales documents. A draft invoice is a piece of work in progress, not a debt, and a
 * cancelled one is a debt that was withdrawn — including either would overstate what a customer
 * owes, which is the one direction a statement must never be wrong in. Credit notes reduce the
 * invoiced total rather than appearing as a payment, because a credit note is not money received.
 */

const COUNTED = ["ISSUED", "PARTIALLY_PAID", "PAID"] as const;

export const statementsExporter: Exporter = async (scope) => {
  const companies = await db.company.findMany({
    where: ownScope(scope),
    select: { id: true, name: true, normalizedName: true, owner: { select: { name: true } } },
    orderBy: { name: "asc" },
  });
  if (companies.length === 0) return [];

  const ids = companies.map((c) => c.id);

  const documents = await db.tradeDocument.groupBy({
    by: ["companyId", "docType"],
    where: { companyId: { in: ids }, direction: "SALES", status: { in: [...COUNTED] }, docType: { in: ["INVOICE", "CREDIT_NOTE"] } },
    _sum: { total: true },
    _count: { _all: true },
  });

  const receipts = await db.payment.groupBy({
    by: ["companyId"],
    where: { companyId: { in: ids } },
    _sum: { amount: true },
  });

  // The oldest unsettled invoice is the number somebody actually chases on, and it is the one thing
  // a total cannot tell you: ₹4 lakh outstanding is routine at thirty days and a problem at two
  // hundred.
  const oldestOpen = await db.tradeDocument.groupBy({
    by: ["companyId"],
    where: { companyId: { in: ids }, direction: "SALES", docType: "INVOICE", status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
    _min: { issueDate: true },
  });

  const sum = (companyId: string, docType: string) =>
    Number(documents.find((d) => d.companyId === companyId && d.docType === docType)?._sum.total ?? 0);
  const count = (companyId: string, docType: string) =>
    documents.find((d) => d.companyId === companyId && d.docType === docType)?._count._all ?? 0;

  const today = new Date();

  return companies.map((c) => {
    const invoiced = sum(c.id, "INVOICE");
    const credited = sum(c.id, "CREDIT_NOTE");
    const received = Number(receipts.find((r) => r.companyId === c.id)?._sum.amount ?? 0);
    const since = oldestOpen.find((o) => o.companyId === c.id)?._min.issueDate ?? null;

    return {
      Key: c.normalizedName,
      Company: c.name,
      "Account manager": c.owner?.name ?? "",
      Invoices: count(c.id, "INVOICE"),
      Invoiced: invoiced,
      "Credit notes": credited,
      Received: received,
      Outstanding: invoiced - credited - received,
      "Oldest unpaid invoice": since,
      "Days outstanding": since ? Math.floor((today.getTime() - since.getTime()) / 86_400_000) : null,
    };
  });
};
