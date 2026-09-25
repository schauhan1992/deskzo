import { db } from "@/lib/db";
import { calculateOrderAmount } from "@/lib/gst";
import { isCustomerRelationshipType } from "@/lib/validation/company";
import { creditConcerns, type CreditAssessment, type CreditConcern, type TermsKey } from "@/lib/credit/engine";
import { assessCompany } from "@/lib/credit/load";

export type OrderCreditPosition = {
  assessment: CreditAssessment;
  /** What the order bills, with GST. */
  amount: number;
  /** Its own terms, or the customer's default. */
  terms: TermsKey;
  concerns: CreditConcern[];
  /** An override recorded against this order when it was punched. */
  termsDecided: boolean;
};

/**
 * Where one order stands on credit — for the approval action, and the order page that shows it.
 *
 * One function for both so the page never shows an approver a different answer from the one the
 * action will enforce. Null for anything that isn't a customer's order (nothing to weigh) or that
 * no longer exists.
 *
 * The terms concern is dropped when this order already carries a recorded override from when it
 * was punched — that was decided, by someone allowed to. The limit is always weighed as of now.
 */
export async function orderCreditPosition(orderId: string): Promise<OrderCreditPosition | null> {
  const order = await db.companyProduct.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      companyId: true,
      quantity: true,
      unitPrice: true,
      paymentTerms: true,
      item: { select: { sellingPrice: true, taxRatePercent: true } },
      company: { select: { paymentTerms: true, relationshipType: true } },
    },
  });
  if (!order || !isCustomerRelationshipType(order.company.relationshipType)) return null;

  const assessment = await assessCompany(order.companyId);
  if (!assessment) return null;
  const { total } = calculateOrderAmount({
    quantity: order.quantity,
    unitPrice: Number(order.unitPrice ?? order.item.sellingPrice),
    taxRatePercent: order.item.taxRatePercent ? Number(order.item.taxRatePercent) : null,
  });
  const terms = order.paymentTerms ?? order.company.paymentTerms;
  const termsDecided = (await db.creditDecision.count({ where: { orderId } })) > 0;
  const concerns = creditConcerns(assessment, { terms, amount: total }).filter((c) => !(termsDecided && c.kind === "TERMS"));
  return { assessment, amount: total, terms, concerns, termsDecided };
}
