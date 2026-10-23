import { db } from "@/lib/db";
import { partyDetails } from "@/lib/proposals/party";
import { tradeDocumentSchema } from "@/lib/validation/trade-document";
import { createDraftDocument } from "@/lib/documents/create-draft";
import { workspaceClock } from "@/lib/time/workspace";
import { formatMoney } from "@/lib/currency";
import { formatCalendarDay } from "@/lib/time/zone";
import { collectionConfig, msmeClaims } from "@/lib/collect/settings";
import { interestInputFor, msmeInterest } from "@/lib/collect/msme";
import type { ActionResult } from "@/actions/company";

const DAY = 86_400_000;
/** The line's name: how an earlier charge on the same invoice is found, so interest is never charged twice. */
export const INTEREST_LINE = "Interest on delayed payment";

/**
 * "Charge interest" (owner, 23 Oct 2026): a draft debit note against a late invoice for the MSMED Act
 * interest run up on it so far — never issued here; whoever raised it checks it and issues it.
 *
 * Interest on late payment is part of the supply's value (GST s.15(2)(d)), so it is taxed as the invoice
 * was: the line takes the HSN/SAC and rate of the invoice's largest line, with GST on top. The customer's
 * site, place of supply and GSTIN come from the invoice's own.
 */
export async function chargeInterestDraft(invoiceId: string, actorId: string): Promise<ActionResult<{ id: string }>> {
  const config = await collectionConfig();
  if (!msmeClaims(config)) return { ok: false, error: "Fill in your Udyam number, its category (micro or small) and the RBI bank rate under Settings › Payment collection first." };
  const facts = await interestInputFor(invoiceId);
  if (!facts) return { ok: false, error: "Interest is charged on an issued tax invoice." };
  const worked = msmeInterest(facts, new Date(), config.bankRate!);
  if (worked.interest < 1) return { ok: false, error: "No interest has run up on this invoice — it was paid on time, or isn't late yet." };
  // Charged before on a debit note still standing (drafts included): only what has run up since is charged now.
  // Named only once the workspace has debit notes (their migration runs after the deploy).
  const earlier = await db.tradeDocumentLine
    .findMany({
      where: { name: INTEREST_LINE, document: { docType: "DEBIT_NOTE", againstDocumentId: invoiceId, status: { not: "CANCELLED" } } },
      select: { taxableValue: true, document: { select: { docNumber: true, status: true } } },
    })
    .catch((err: unknown) => {
      if (/invalid input value for enum/i.test(err instanceof Error ? err.message : String(err))) return null;
      throw err;
    });
  if (earlier === null) return { ok: false, error: "This workspace is still being updated for debit notes. Try again in a few minutes." };
  const charged = earlier.reduce((t, l) => t + Number(l.taxableValue), 0);
  const due = Math.round((worked.interest - charged) * 100) / 100;
  if (due < 1) {
    const where = earlier.map((l) => l.document.docNumber ?? "a draft").join(", ");
    return { ok: false, error: `The interest so far is already on ${where}. More can be charged once more has run up.` };
  }

  const invoice = await db.tradeDocument.findUnique({
    where: { id: invoiceId },
    select: {
      docNumber: true,
      companyId: true,
      currency: true,
      salespersonId: true,
      company: { select: { name: true } },
      location: { select: { id: true, address: true, city: true, state: true, pincode: true, country: true, gstNumber: true, gstTreatment: true } },
      lines: { select: { hsnCode: true, taxRatePercent: true, taxableValue: true } },
    },
  });
  if (!invoice?.location) return { ok: false, error: "The invoice has no customer site to raise the debit note to." };
  if (invoice.currency !== "INR") return { ok: false, error: "MSMED Act interest is charged on rupee invoices." };
  const party = partyDetails(invoice.location, invoice.company.name);
  if (!party.ok) return party;
  // Taxed as the supply was: the invoice's largest line gives the code and the rate.
  const main = [...invoice.lines].sort((a, b) => Number(b.taxableValue) - Number(a.taxableValue))[0];
  const from = new Date(worked.lastDay.getTime() + DAY);
  const issueDate = (await workspaceClock()).today();

  const parsed = tradeDocumentSchema.safeParse({
    docType: "DEBIT_NOTE",
    companyId: invoice.companyId,
    locationId: party.data.locationId,
    docNumber: "",
    placeOfSupplyCode: party.data.placeOfSupplyCode,
    gstTreatment: party.data.gstTreatment,
    buyerGstin: party.data.gstin,
    reverseCharge: false,
    currency: "INR",
    exchangeRate: 1,
    issueDate,
    dueDate: "",
    validUntil: "",
    reference: `Against ${invoice.docNumber ?? "the invoice"}`.slice(0, 120),
    salespersonId: invoice.salespersonId ?? "",
    notes: `Interest under section 16 of the MSMED Act, 2006 (Udyam ${config.udyamNumber}), on invoice ${invoice.docNumber ?? ""}: compound interest with monthly rests at three times the RBI bank rate (${worked.rate}% a year), from ${formatCalendarDay(from)} for ${worked.days} days.`,
    terms: "",
    dispatchFromAddress: "",
    billing: party.data.address,
    shippingSameAsBilling: true,
    shipping: party.data.address,
    shippingGstin: "",
    shippingCharge: 0,
    shippingTaxRatePercent: 0,
    withholdingMode: "NONE",
    withholdingSection: "",
    withholdingRatePercent: 0,
    adjustmentLabel: "",
    adjustment: 0,
    sourceDocumentId: "",
    leadId: "",
    againstDocumentId: invoiceId,
    lines: [
      {
        itemId: "",
        companyProductId: "",
        name: INTEREST_LINE,
        description: `On ${invoice.docNumber ?? "the invoice"}${worked.unpaid > 0 ? ` (${formatMoney(worked.unpaid, "INR")} unpaid)` : ""}, ${worked.days} days from ${formatCalendarDay(from)} at ${worked.rate}% a year, MSMED Act s.16${charged > 0 ? `, less ${formatMoney(charged, "INR")} charged before` : ""}`,
        servicePeriodFrom: "",
        servicePeriodTo: "",
        hsnCode: main?.hsnCode ?? "",
        unit: "",
        quantity: 1,
        unitPrice: due,
        discountMode: "PERCENT",
        discountValue: 0,
        taxRatePercent: Number(main?.taxRatePercent ?? 18),
      },
    ],
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "The debit note didn't validate." };
  return createDraftDocument({ id: actorId }, parsed.data, "MANUAL");
}
