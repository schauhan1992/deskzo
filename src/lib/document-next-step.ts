import type { TradeDocumentType, TradeDocumentStatus } from "@prisma/client";
import { formatCurrency } from "@/lib/utils";
// A document's dates are typed days kept as their midnight UTC: shown as the day itself, in any zone.
import { formatCalendarDay } from "@/lib/time/zone";
import { daysOverdue } from "@/lib/receivables";

export type NextStep = {
  /** The short heading — what state the document is in. */
  headline: string;
  /** What the person looking at it should do about that, if anything. */
  detail: string;
  tone: "info" | "warning" | "success";
};

/**
 * "What's next?" — the one line that turns a document's status into the action it implies.
 *
 * A status badge says where a document is; it doesn't say what to do about it. A draft invoice and
 * an overdue one are both "just sitting there" as far as the badge is concerned, and the difference
 * is what actually matters to whoever opened it.
 */
export function nextStepFor({
  docType,
  status,
  dueDate,
  issueDate,
  validUntil,
  balance,
  creditRemaining,
  needsIrn,
  awaitingApproval,
  asOf,
}: {
  docType: TradeDocumentType;
  status: TradeDocumentStatus;
  dueDate: Date | string | null;
  issueDate: Date | string;
  validUntil: Date | string | null;
  /** Outstanding on an invoice, when one has been computed. */
  balance: number | null;
  /** Unapplied amount on a credit note, when one has been computed. */
  creditRemaining: number | null;
  /** An issued e-invoice-eligible document that the portal hasn't stamped yet. */
  needsIrn: boolean;
  /**
   * The document needs signing off and has not been.
   *
   * The approval banner says so in more detail and carries the buttons, so this one stands down
   * rather than stacking a second banner above the same document saying something less urgent.
   */
  awaitingApproval?: boolean;
  asOf: Date;
}): NextStep | null {
  if (status === "CANCELLED" || status === "REJECTED" || status === "EXPIRED") return null;
  if (awaitingApproval) return null;

  if (status === "DRAFT") {
    return {
      headline: "This is still a draft.",
      detail: "Nothing has gone to the other side yet, and the number isn't final. Issue it when you're ready.",
      tone: "info",
    };
  }

  if (needsIrn) {
    return {
      headline: "No IRN yet.",
      detail: "This invoice is issued but the government portal hasn't stamped it. Generate the IRN before sending it.",
      tone: "warning",
    };
  }

  switch (docType) {
    case "PROPOSAL":
      if (status === "ACCEPTED") {
        return {
          headline: "Accepted.",
          detail: "Convert it to a proforma invoice if they're paying in advance, or straight to a tax invoice.",
          tone: "success",
        };
      }
      return {
        headline: "Sent — waiting on the customer.",
        detail: validUntil
          ? `Mark it accepted or rejected as you hear back. It expires ${formatCalendarDay(validUntil)}.`
          : "Mark it accepted or rejected as you hear back.",
        tone: "info",
      };

    case "PROFORMA":
      return {
        headline: "Sent for advance payment.",
        detail: "Convert it to a tax invoice once the money lands or the order is confirmed.",
        tone: "info",
      };

    case "INVOICE": {
      if (balance !== null && balance <= 0) {
        return { headline: "Settled in full.", detail: "Nothing left to collect on this one.", tone: "success" };
      }
      const overdue = daysOverdue(dueDate, issueDate, asOf);
      const amount = balance !== null ? formatCurrency(balance) : "The balance";
      if (overdue > 0) {
        return {
          headline: `${amount} is overdue by ${overdue} day${overdue === 1 ? "" : "s"}.`,
          detail: "Chase the payment, or record it here if it has already come in.",
          tone: "warning",
        };
      }
      return {
        headline: `${amount} is outstanding.`,
        detail: dueDate ? `Due ${formatCalendarDay(dueDate)}. Record the payment when it arrives.` : "Record the payment when it arrives.",
        tone: "info",
      };
    }

    case "CREDIT_NOTE":
      if (creditRemaining !== null && creditRemaining > 0) {
        return {
          headline: `${formatCurrency(creditRemaining)} of this credit is unapplied.`,
          detail: "Apply it to an open invoice, or leave it sitting on the customer's account.",
          tone: "info",
        };
      }
      return { headline: "Fully applied.", detail: "This credit has been used up against invoices.", tone: "success" };

    case "PURCHASE_ORDER":
      return {
        headline: "Sent to the vendor.",
        detail: "Convert it to a bill when their invoice arrives, so the two stay linked.",
        tone: "info",
      };

    case "BILL":
      if (status === "PAID") return { headline: "Paid.", detail: "Settled with the vendor.", tone: "success" };
      return {
        headline: "Recorded, not yet paid.",
        detail: "Mark it paid once you've settled with the vendor.",
        tone: "info",
      };

    default:
      return null;
  }
}
