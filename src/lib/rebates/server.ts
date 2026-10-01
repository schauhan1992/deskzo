import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { OrderRebateInput } from "@/lib/validation/order";
import { expectedRebate, frontMargin, netMargin, rebateStanding, unitCostOf, type CostSource, type RebateBasisKey } from "@/lib/rebates/rules";

const num = (v: Prisma.Decimal | number | null | undefined) => (v === null || v === undefined ? null : Number(v));

/** One entered rebate, checked — its programme and its payer real — as the row to store. */
export async function resolveRebateInput(
  r: OrderRebateInput,
): Promise<
  | { ok: true; data: Omit<Prisma.OrderRebateUncheckedCreateInput, "companyProductId" | "createdById"> }
  | { ok: false; error: string }
> {
  if (r.programmeId) {
    const programme = await db.rebateProgramme.findUnique({ where: { id: r.programmeId }, select: { id: true } });
    if (!programme) return { ok: false, error: "That rebate programme no longer exists — pick another, or none." };
  }
  if (r.payerCompanyId) {
    const payer = await db.company.findUnique({ where: { id: r.payerCompanyId }, select: { id: true } });
    if (!payer) return { ok: false, error: "Pick who pays the rebate from the companies in the CRM, or leave it blank." };
  }
  const isAmount = r.basis === "AMOUNT";
  return {
    ok: true,
    data: {
      programmeId: r.programmeId || null,
      basis: r.basis,
      rate: isAmount ? null : new Prisma.Decimal(r.value),
      amount: isAmount ? new Prisma.Decimal(r.value) : null,
      payer: r.payer,
      payerCompanyId: r.payerCompanyId || null,
      settlement: r.settlement,
      note: r.note || null,
    },
  };
}

/** What an order's margin and rebates are worked out from. */
export const ORDER_REBATE_SELECT = {
  id: true,
  quantity: true,
  unitPrice: true,
  purchasePrice: true,
  dealPrice: true,
  quotedPurchasePrice: true,
  item: { select: { sellingPrice: true } },
  expenses: { select: { amount: true } },
  rebates: {
    orderBy: { createdAt: "asc" as const },
    select: {
      id: true,
      basis: true,
      rate: true,
      amount: true,
      payer: true,
      settlement: true,
      note: true,
      writtenOffAt: true,
      writeOffReason: true,
      programme: { select: { id: true, name: true } },
      payerCompany: { select: { id: true, name: true } },
      allocations: {
        where: { vendorCredit: { cancelledAt: null } },
        select: { amount: true, vendorCredit: { select: { id: true, reference: true, date: true, vendor: { select: { name: true } } } } },
      },
    },
  },
} satisfies Prisma.CompanyProductSelect;

export type OrderForRebates = Prisma.CompanyProductGetPayload<{ select: typeof ORDER_REBATE_SELECT }>;

/**
 * An order's rebates and margins as read: each rebate's expected amount worked out from the order's
 * current prices, what has come in against it, what is still to come; and the front and net margin.
 */
export function rebateSummary(order: OrderForRebates) {
  const unitPrice = num(order.unitPrice) ?? num(order.item.sellingPrice);
  const costOf = unitCostOf({ purchasePrice: num(order.purchasePrice), dealPrice: num(order.dealPrice), quotedPurchasePrice: num(order.quotedPurchasePrice) });
  const expenses = order.expenses.reduce((sum, e) => sum + Number(e.amount), 0);
  const front = frontMargin({ quantity: order.quantity, unitPrice, unitCost: costOf?.cost ?? null, expenses });
  const rebates = order.rebates.map((r) => {
    const expected = expectedRebate(
      { basis: r.basis as RebateBasisKey, rate: num(r.rate), amount: num(r.amount) },
      { quantity: order.quantity, unitPrice, unitCost: costOf?.cost ?? null },
    );
    const received = r.allocations.reduce((sum, a) => sum + Number(a.amount), 0);
    return {
      id: r.id,
      basis: r.basis as RebateBasisKey,
      rate: num(r.rate),
      amount: num(r.amount),
      payer: r.payer,
      settlement: r.settlement,
      note: r.note,
      programme: r.programme,
      payerCompany: r.payerCompany,
      writeOffReason: r.writeOffReason,
      allocations: r.allocations.map((a) => ({ amount: Number(a.amount), credit: a.vendorCredit })),
      ...rebateStanding(expected, received, !!r.writtenOffAt),
    };
  });
  const totals = rebates.reduce(
    (t, r) => ({ expected: t.expected + r.expected, received: t.received + r.received, outstanding: t.outstanding + r.outstanding }),
    { expected: 0, received: 0, outstanding: 0 },
  );
  return {
    unitPrice,
    unitCost: costOf?.cost ?? null,
    costFrom: (costOf?.from ?? null) as CostSource | null,
    expenses,
    front,
    net: netMargin(front, rebates),
    rebates,
    totals,
  };
}

export type RebateSummary = ReturnType<typeof rebateSummary>;
