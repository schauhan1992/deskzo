import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { getTradeDocument } from "@/actions/trade-document";
import { findTradeDocumentFor } from "@/lib/documents/load";
import { spendRenderGrant } from "@/lib/documents/render-grant";
import { can } from "@/lib/authz/resolve";
import { foreignCountry } from "@/lib/organisation";
import { branchIdentity, isMultiBranch } from "@/lib/branches/identity";
import { printedBankAccount } from "@/lib/banking/organisation-accounts";
import { getBranding } from "@/actions/branding";
import { PrintButton } from "@/components/documents/print-button";
import { formatCalendarDay, indiaClock } from "@/lib/time/zone";
import { formatMoney, formatRate, isBaseCurrency, toBase } from "@/lib/currency";
import { GST_STATE_CODES, amountInWords } from "@/lib/gst-engine";
import { documentDirection, tradeDocumentLabels } from "@/lib/trade-documents";
import { gstTreatmentLabels } from "@/lib/gst";
import { formatAddress } from "@/lib/document-draft";
import { approvalDocumentFor, approvalPolicyFor } from "@/lib/documents/approval-policy";
import { approvalRequirement } from "@/lib/documents/approval";
import { descriptionStatesPeriod, formatServicePeriod, showsServicePeriod } from "@/lib/documents/service-period";

/**
 * The page that becomes the PDF. It deliberately ignores the app's dark mode and semantic tokens —
 * an invoice is printed on white paper, and a document that renders differently depending on the
 * viewer's theme is not a document you can send to a customer.
 */
export default async function PrintDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /** `embed=1` drops the print button — the preview pane has its own, and a button inside a
   *  preview of a printed page is one more thing that isn't on the printed page. */
  searchParams: Promise<{ embed?: string; render?: string }>;
}) {
  const [{ id }, { embed, render }] = await Promise.all([params, searchParams]);
  const [document, branding] = await Promise.all([loadForPrint(id, render), getBranding()]);
  if (!document) notFound();

  /**
   * Who "we" are on this paper: the branch it was raised from (or, on a purchase, bought by), with
   * whatever the branch leaves blank taken from the organisation. A null branch — a document written
   * before branches — is the head office, which with every override blank prints what the company
   * always printed. Neither read throws: a page that cannot find its branch still prints the company.
   */
  const [identity, multiBranch] = await Promise.all([
    branchIdentity(document.branchId),
    isMultiBranch().catch(() => false),
  ]);

  /**
   * Every figure on the page, in the currency the customer agreed to pay in.
   *
   * The whole document is stored in that currency — lines, tax and total alike — so this is a
   * relabelling, not a conversion. The conversion is the block below the total.
   */
  const money = (value: number | string | null | undefined) => formatMoney(value, document.currency);

  /**
   * The rupee equivalents, for a document written in anything else.
   *
   * Not decoration. The books post in rupees at the document's own rate, and an Indian export
   * invoice is expected to carry the rate and the rupee value it was converted at — so the figure
   * the ledger holds should be legible on the document itself rather than only in the system that
   * produced it. Converted at the rate stored on the document, never a live one: reprinting a
   * six-month-old invoice must produce the same paper it produced the first time.
   */
  const foreign = !isBaseCurrency(document.currency);
  const rate = Number(document.exchangeRate) || 1;
  const inr = {
    taxableValue: toBase(document.taxableValue, rate),
    tax: toBase(document.cgstAmount + document.sgstAmount + document.igstAmount, rate),
    total: toBase(document.total, rate),
  };

  /**
   * Who the recipient rings about this document.
   *
   * Falls back to the account owner when nobody was named, because that is exactly what the form's
   * blank option says it will do and what `createTradeDocument` already resolves it to — a document
   * that prints no contact when the form promised one is the form telling a lie.
   *
   * The phone is printed only when the person has entered one. That is the arrangement their own
   * profile page states: the number is optional, and leaving it blank gives the customer the email
   * alone rather than exposing a mobile nobody chose to publish.
   */
  const contact = document.salesperson ?? document.company.owner;

  const isIntraState = document.cgstAmount > 0 || document.sgstAmount > 0;
  const isSales = documentDirection[document.docType] === "SALES";
  // The document's own pick, else its branch's default, else the organisation's primary. Sales only:
  // a purchase order printing our account would invite the vendor to pay us.
  const bank = isSales ? await printedBankAccount(document.id, identity) : null;
  const qrDataUrl = document.signedQrCode
    ? await QRCode.toDataURL(document.signedQrCode, { margin: 1, width: 150 }).catch(() => null)
    : null;

  const placeOfSupplyLabel = document.placeOfSupplyCode
    ? `${GST_STATE_CODES[document.placeOfSupplyCode] ?? "Unknown"} (${document.placeOfSupplyCode})`
    : "Not set";

  /**
   * Our GSTIN as the document recorded it — `sellerGstin` on a sale, `buyerGstin` on a purchase — not
   * the registration's value today. A GSTIN is replaced or a branch moves to another registration,
   * and an invoice reprinted afterwards must still carry the number it was issued under. The live one
   * only fills in for a document that recorded none.
   */
  const ourGstin = (isSales ? document.sellerGstin : document.buyerGstin) || identity.gstin;
  // One quiet line saying which branch this is, where there is more than one to tell apart. The head
  // office goes unnamed, so a single-branch company's paper reads exactly as it always has.
  const branchLine = multiBranch && !identity.isHeadOffice ? `Branch: ${identity.name}` : null;
  // The branch's own logo when it has one; otherwise the app's, as every document printed before.
  const logoDataUrl = identity.logoDataUrl ?? branding.logoDataUrl;

  const ourLines = [
    identity.addressLine1,
    identity.addressLine2,
    [identity.city, identity.pincode].filter(Boolean).join(" — "),
    identity.state,
    foreignCountry(identity),
  ];
  const billingLines = formatAddress({
    attention: document.billingAttention,
    line1: document.billingLine1,
    line2: document.billingLine2,
    city: document.billingCity,
    state: document.billingState,
    pincode: document.billingPincode,
    country: document.billingCountry,
  });
  const shippingLines = formatAddress({
    attention: document.shippingAttention,
    line1: document.shippingLine1,
    line2: document.shippingLine2,
    city: document.shippingCity,
    state: document.shippingState,
    pincode: document.shippingPincode,
    country: document.shippingCountry,
  });

  const counterparty = {
    // The name it was issued under, if the party has since been merged into another company.
    name: document.partyName ?? document.company.name,
    gstin: isSales ? document.buyerGstin : document.sellerGstin,
    lines: billingLines.length > 0 ? billingLines : ourLines,
  };

  // A shipping address only earns its space when it actually differs from the billing one.
  const showShipping = !document.shippingSameAsBilling && shippingLines.length > 0;

  /**
   * The watermark, where this document has not been signed off.
   *
   * Only for types that actually require approval — a watermark on every draft would be noise, and
   * noise on a document is worse than nothing because people stop reading it.
   *
   * It is printed, not merely shown. The risk is entirely in the saved PDF: somebody previews an
   * unapproved quotation, saves it and emails it, and the customer holds a price nobody signed off.
   * A `print:hidden` watermark would vanish at exactly the moment it mattered.
   */
  // And only on a document that needs it: a quote under the approval limit is not waiting for anybody.
  const [approvalPolicy, approvalFacts] = await Promise.all([approvalPolicyFor(document.docType), approvalDocumentFor(document.id)]);
  const needsSignOff = approvalFacts ? approvalRequirement(approvalPolicy, approvalFacts).required : approvalPolicy.enabled;
  const watermark =
    needsSignOff && document.approvalStatus !== "APPROVED"
      ? document.approvalStatus === "REJECTED"
        ? "Not Approved"
        : "Yet to be Approved"
      : null;

  return (
    <div className="relative mx-auto max-w-[820px] bg-white p-8 text-[13px] text-neutral-900 print:max-w-none print:p-0">
      {embed !== "1" && (
        <div className="mb-4 flex justify-end print:hidden">
          <PrintButton />
        </div>
      )}

      {watermark && (
        /**
         * Across the page, behind the content.
         *
         * `pointer-events-none` so it never blocks selecting or clicking the document underneath,
         * and `print-color-adjust` because browsers drop background and faint colour when printing
         * unless told not to — without it the watermark is on screen and missing from the paper,
         * which is the one place it has to be.
         */
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden"
          style={{ WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" }}
        >
          <span
            className="select-none whitespace-nowrap text-[68px] font-bold uppercase tracking-[0.12em] text-neutral-400"
            style={{ transform: "rotate(-30deg)", opacity: 0.22 }}
          >
            {watermark}
          </span>
        </div>
      )}

      {/* Clips nothing in practice — every part keeps to the frame — but a long word never draws past its border. */}
      <div className="relative z-0 overflow-hidden border border-neutral-300">
        <div className="flex items-start justify-between gap-6 border-b border-neutral-300 p-5">
          <div className="flex items-start gap-3">
            {logoDataUrl && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={logoDataUrl} alt="" className="h-12 w-auto object-contain" />
            )}
            <div>
              <div className="text-base font-semibold">{identity.legalName || branding.appName}</div>
              {identity.tradeName && <div className="text-neutral-600">{identity.tradeName}</div>}
              <div className="mt-1 leading-5 text-neutral-600">
                {[identity.addressLine1, identity.addressLine2].filter(Boolean).join(", ")}
                {identity.city && (
                  <div>{[identity.city, identity.state, identity.pincode, foreignCountry(identity)].filter(Boolean).join(", ")}</div>
                )}
                {branchLine && <div className="text-[11px] text-neutral-500">{branchLine}</div>}
                {ourGstin && <div>GSTIN: {ourGstin}</div>}
                {identity.phone && <div>{identity.phone}</div>}
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-lg font-semibold uppercase tracking-wide">
              {tradeDocumentLabels[document.docType]}
            </div>
            <div className="mt-1 font-mono text-neutral-700">{document.docNumber}</div>
            {/* A document's dates are typed days, kept as their midnight UTC: the day itself, in any zone. */}
            <div className="text-neutral-600">Dated {formatCalendarDay(document.issueDate)}</div>
            {/**
              * A draft says so, on the paper.
              *
              * This page is reachable before a document is issued, which is the point — you read it
              * over before committing to it. But it otherwise renders exactly like the finished
              * article, and the number on it is not final: issuing assigns the real one. Without
              * this, the obvious next step after previewing is to save the PDF and send it, and the
              * customer receives a quote carrying a number that will belong to a different document.
              *
              * Deliberately not `print:hidden` — the whole risk is the printed copy.
              */}
            {document.status === "DRAFT" && (
              <div className="mt-2 inline-block border border-neutral-400 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                Draft — not issued
              </div>
            )}
          </div>
        </div>

        {/* On a sales document the letterhead above already is the supplier, so the remaining boxes
            carry the counterparty, where it ships, and the document's own details. */}
        <div className={`grid border-b border-neutral-300 ${showShipping ? "grid-cols-3" : "grid-cols-2"}`}>
          <Party
            title={isSales ? "Bill to" : "Vendor"}
            party={counterparty}
            className="border-r border-neutral-300"
          />
          {showShipping && (
            <Party
              title="Ship to"
              party={{ name: "", gstin: document.shippingGstin, lines: shippingLines }}
              className="border-r border-neutral-300"
            />
          )}
          <div className="space-y-1 p-5">
            <div className="text-[11px] uppercase tracking-wide text-neutral-500">Details</div>
            <DetailRow label="Place of supply" value={placeOfSupplyLabel} />
            {document.reference && <DetailRow label={isSales ? "Your reference" : "Our reference"} value={document.reference} />}
            {document.dueDate && <DetailRow label="Payment due" value={formatCalendarDay(document.dueDate)} />}
            {document.validUntil && <DetailRow label="Valid until" value={formatCalendarDay(document.validUntil)} />}
            <DetailRow label="GST treatment" value={gstTreatmentLabels[document.gstTreatment]} />
            <DetailRow label="Reverse charge" value={document.reverseCharge ? "Yes" : "No"} />
            {document.dispatchFromAddress && (
              <DetailRow label="Dispatch from" value={document.dispatchFromAddress.split("\n").join(", ")} />
            )}
            {document.againstDocument && (
              <DetailRow
                label="Against invoice"
                value={`${document.againstDocument.docNumber} — ${formatCalendarDay(document.againstDocument.issueDate)}`}
              />
            )}
          </div>
        </div>

        {/*
          Fixed columns (owner, 8 Oct 2026): an automatic table grew past the bordered frame whenever its
          amounts needed more room than the page had — on A4 in the PDF above all — and its borders no
          longer met the frame's. The amounts keep their own widths on one line; the description takes what
          is left and wraps.
        */}
        <table className="w-full table-fixed">
          <colgroup>
            <col className="w-7" />
            <col />
            <col className="w-16" />
            <col className="w-12" />
            <col className="w-[5.5rem]" />
            <col className="w-[5.75rem]" />
            {isIntraState ? (
              <>
                <col className="w-[4.75rem]" />
                <col className="w-[4.75rem]" />
              </>
            ) : (
              <col className="w-[5.25rem]" />
            )}
            <col className="w-24" />
          </colgroup>
          <thead className="border-b border-neutral-300 bg-neutral-100 text-left text-[10px] uppercase tracking-wide text-neutral-600">
            <tr>
              <th className="px-2 py-2">#</th>
              <th className="px-2 py-2">Description</th>
              <th className="px-2 py-2">HSN/SAC</th>
              <th className="px-2 py-2 text-right">Qty</th>
              <th className="px-2 py-2 text-right">Rate</th>
              <th className="px-2 py-2 text-right">Taxable</th>
              {isIntraState ? (
                <>
                  <th className="px-2 py-2 text-right">CGST</th>
                  <th className="px-2 py-2 text-right">SGST</th>
                </>
              ) : (
                <th className="px-2 py-2 text-right">IGST</th>
              )}
              <th className="px-2 py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody className="text-[12px]">
            {document.lines.map((line, index) => (
              <tr key={line.id} className="border-b border-neutral-200 align-top">
                <td className="px-2 py-2 text-neutral-500">{index + 1}</td>
                <td className="break-words px-2 py-2">
                  {line.name}
                  {line.description && (
                    <div className="mt-0.5 whitespace-pre-line text-[11px] text-neutral-600">{line.description}</div>
                  )}
                  {/* The period the customer is paying for, unless the description already says it. */}
                  {showsServicePeriod(document.docType) &&
                    line.servicePeriodFrom &&
                    line.servicePeriodTo &&
                    !descriptionStatesPeriod(line.description, line.servicePeriodFrom, line.servicePeriodTo) && (
                      <div className="mt-0.5 text-[11px] text-neutral-600">
                        Service period: {formatServicePeriod(line.servicePeriodFrom, line.servicePeriodTo)}
                      </div>
                    )}
                </td>
                <td className="break-all px-2 py-2 font-mono text-[10px]">{line.hsnCode ?? "—"}</td>
                <td className="break-words px-2 py-2 text-right">
                  {line.quantity}
                  {line.unit ? ` ${line.unit}` : ""}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right text-[11px]">{money(line.unitPrice)}</td>
                <td className="whitespace-nowrap px-2 py-2 text-right text-[11px]">
                  {money(line.taxableValue)}
                  {line.discountAmount > 0 && (
                    <div className="text-[10px] text-neutral-500">less {money(line.discountAmount)}</div>
                  )}
                </td>
                {isIntraState ? (
                  <>
                    <td className="whitespace-nowrap px-2 py-2 text-right text-[11px]">
                      {money(line.cgstAmount)}
                      <div className="text-[10px] text-neutral-500">{line.taxRatePercent / 2}%</div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right text-[11px]">
                      {money(line.sgstAmount)}
                      <div className="text-[10px] text-neutral-500">{line.taxRatePercent / 2}%</div>
                    </td>
                  </>
                ) : (
                  <td className="whitespace-nowrap px-2 py-2 text-right text-[11px]">
                    {money(line.igstAmount)}
                    <div className="text-[10px] text-neutral-500">{line.taxRatePercent}%</div>
                  </td>
                )}
                <td className="whitespace-nowrap px-2 py-2 text-right text-[11px] font-medium">{money(line.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="grid grid-cols-[1fr_280px] border-t border-neutral-300">
          <div className="space-y-3 border-r border-neutral-300 p-5">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-neutral-500">Amount in words</div>
              <div className="font-medium">{amountInWords(document.total, document.currency)}</div>
            </div>

            {qrDataUrl && (
              <div className="flex items-start gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qrDataUrl} alt="Signed e-invoice QR code" className="h-[110px] w-[110px]" />
                <div className="text-[11px] leading-5 text-neutral-600">
                  <div className="font-medium text-neutral-800">e-Invoice</div>
                  <div className="break-all">IRN: {document.irn}</div>
                  <div>Ack no: {document.ackNo}</div>
                  {/* The IRP's acknowledgement: an e-invoice date, so India's (statutory, every workspace). */}
                  <div>Ack date: {indiaClock.date(document.ackDate)}</div>
                </div>
              </div>
            )}

            {contact && (
              <div className="text-[11px] leading-5 text-neutral-600">
                <div className="text-[11px] uppercase tracking-wide text-neutral-500">Your contact</div>
                <div className="font-medium text-neutral-800">{contact.name}</div>
                {contact.email && <div>{contact.email}</div>}
                {contact.phone && <div>{contact.phone}</div>}
              </div>
            )}

            {/* One account, whole — never one account's IFSC under another's number. */}
            {bank && (
              <div className="text-[11px] leading-5 text-neutral-600">
                <div className="text-[11px] uppercase tracking-wide text-neutral-500">Bank details</div>
                {bank.accountHolderName && <div>{bank.accountHolderName}</div>}
                {bank.bankName && <div>{bank.bankName}{bank.branchName ? ` — ${bank.branchName}` : ""}</div>}
                {bank.accountNumber && <div>A/c: {bank.accountNumber}</div>}
                {bank.ifsc && <div>IFSC: {bank.ifsc}</div>}
                {bank.swift && <div>SWIFT: {bank.swift}</div>}
                {bank.upiId && <div>UPI: {bank.upiId}</div>}
              </div>
            )}

            {document.terms && (
              <div className="text-[11px] leading-5 text-neutral-600">
                <div className="text-[11px] uppercase tracking-wide text-neutral-500">Terms</div>
                <div className="whitespace-pre-wrap">{document.terms}</div>
              </div>
            )}
          </div>

          <div className="p-5">
            <PrintRow label="Subtotal" value={money(document.subtotal)} />
            {document.discountTotal > 0 && <PrintRow label="Discount" value={`− ${money(document.discountTotal)}`} />}
            {document.shippingCharge > 0 && (
              <PrintRow label="Shipping charges" value={money(document.shippingCharge)} />
            )}
            <PrintRow label="Taxable value" value={money(document.taxableValue)} />
            {isIntraState ? (
              <>
                <PrintRow label="CGST" value={money(document.cgstAmount)} />
                <PrintRow label="SGST" value={money(document.sgstAmount)} />
              </>
            ) : (
              <PrintRow label="IGST" value={money(document.igstAmount)} />
            )}
            {document.withholdingMode !== "NONE" && (
              <PrintRow
                label={`${document.withholdingMode}${document.withholdingSection ? ` (${document.withholdingSection})` : ""} @ ${document.withholdingRatePercent}%`}
                value={`${document.withholdingAmount < 0 ? "− " : "+ "}${money(Math.abs(document.withholdingAmount))}`}
              />
            )}
            {document.adjustment !== 0 && (
              <PrintRow
                label={document.adjustmentLabel || "Adjustment"}
                value={money(document.adjustment)}
              />
            )}
            {document.roundOff !== 0 && <PrintRow label="Round off" value={money(document.roundOff)} />}
            <div className="mt-2 flex items-center justify-between border-t border-neutral-300 pt-2 text-[15px] font-semibold">
              <span>Total{foreign ? ` (${document.currency})` : ""}</span>
              <span>{money(document.total)}</span>
            </div>

            {foreign && (
              <div className="mt-2 space-y-1 border-t border-neutral-200 pt-2 text-[11px] leading-5 text-neutral-600">
                <div>Exchange rate: 1 {document.currency} = {formatRate(rate)}</div>
                <PrintRow label="Taxable value (INR)" value={formatMoney(inr.taxableValue, "INR")} />
                {inr.tax > 0 && <PrintRow label="Tax (INR)" value={formatMoney(inr.tax, "INR")} />}
                <div className="flex items-center justify-between font-semibold text-neutral-800">
                  <span>Total (INR)</span>
                  <span>{formatMoney(inr.total, "INR")}</span>
                </div>
              </div>
            )}

            <div className="mt-10 text-right text-[11px] text-neutral-600">
              {identity.signatureDataUrl && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={identity.signatureDataUrl} alt="" className="ml-auto h-14 w-auto object-contain" />
              )}
              <div className="mt-1">For {identity.legalName || branding.appName}</div>
              <div className="mt-6 border-t border-neutral-300 pt-1">Authorised signatory</div>
            </div>
          </div>
        </div>

        {(document.notes || identity.invoiceNotes) && (
          <div className="border-t border-neutral-300 px-5 py-3 text-[11px] leading-5 text-neutral-600">
            {document.notes && <div className="whitespace-pre-wrap">{document.notes}</div>}
            {identity.invoiceNotes && <div className="mt-1 whitespace-pre-wrap">{identity.invoiceNotes}</div>}
          </div>
        )}
      </div>

      <p className="mt-3 text-center text-[11px] text-neutral-500">
        This is a computer-generated {tradeDocumentLabels[document.docType].toLowerCase()}.
      </p>
    </div>
  );
}

function Party({
  title,
  party,
  className,
}: {
  title: string;
  party: { name: string; gstin: string | null; lines: (string | null | undefined)[]; extra?: (string | null | undefined)[] };
  className?: string;
}) {
  return (
    <div className={`p-5 ${className ?? ""}`}>
      <div className="text-[11px] uppercase tracking-wide text-neutral-500">{title}</div>
      {party.name && <div className="mt-1 font-semibold">{party.name}</div>}
      <div className="leading-5 text-neutral-600">
        {party.lines.filter(Boolean).map((line, index) => (
          <div key={index}>{line}</div>
        ))}
        {party.extra?.filter(Boolean).map((line, index) => (
          <div key={`extra-${index}`}>{line}</div>
        ))}
        <div className="mt-1">GSTIN: {party.gstin ?? "Unregistered"}</div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 leading-5">
      <span className="w-28 shrink-0 text-neutral-500">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function PrintRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-0.5 text-neutral-700">
      <span>{label}</span>
      <span className="text-neutral-900">{value}</span>
    </div>
  );
}

/**
 * The document, for whoever is looking.
 *
 * Normally that is the person signed in. When the server's own browser is printing it for an email,
 * there is no session, only a render pass (src/lib/documents/render-grant.ts): spent here, once, it
 * names the person who pressed send, and the document is loaded as they would see it — their
 * permission and their accounts, checked again now rather than trusted from a minute ago.
 */
async function loadForPrint(id: string, render: string | undefined) {
  if (!render) return getTradeDocument(id);
  const userId = await spendRenderGrant(render, id);
  if (!userId || !(await can(userId, "documents.view"))) return null;
  return findTradeDocumentFor(userId, id);
}
