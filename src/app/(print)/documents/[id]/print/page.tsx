import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { getTradeDocument } from "@/actions/trade-document";
import { getOrganisation } from "@/lib/organisation";
import { getBranding } from "@/actions/branding";
import { PrintButton } from "@/components/documents/print-button";
import { formatDate } from "@/lib/utils";
import { formatMoney, formatRate, isBaseCurrency, toBase } from "@/lib/currency";
import { GST_STATE_CODES, amountInWords } from "@/lib/gst-engine";
import { documentDirection, tradeDocumentLabels } from "@/lib/trade-documents";
import { gstTreatmentLabels } from "@/lib/gst";
import { formatAddress } from "@/lib/document-draft";

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
  searchParams: Promise<{ embed?: string }>;
}) {
  const [{ id }, { embed }] = await Promise.all([params, searchParams]);
  const [document, org, branding] = await Promise.all([getTradeDocument(id), getOrganisation(), getBranding()]);
  if (!document) notFound();

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
  const qrDataUrl = document.signedQrCode
    ? await QRCode.toDataURL(document.signedQrCode, { margin: 1, width: 150 }).catch(() => null)
    : null;

  const placeOfSupplyLabel = document.placeOfSupplyCode
    ? `${GST_STATE_CODES[document.placeOfSupplyCode] ?? "Unknown"} (${document.placeOfSupplyCode})`
    : "Not set";

  const orgLines = [org.addressLine1, org.addressLine2, [org.city, org.pincode].filter(Boolean).join(" — "), org.state];
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
    name: document.company.name,
    gstin: isSales ? document.buyerGstin : document.sellerGstin,
    lines: billingLines.length > 0 ? billingLines : orgLines,
  };

  // A shipping address only earns its space when it actually differs from the billing one.
  const showShipping = !document.shippingSameAsBilling && shippingLines.length > 0;

  return (
    <div className="mx-auto max-w-[820px] bg-white p-8 text-[13px] text-neutral-900 print:p-0">
      {embed !== "1" && (
        <div className="mb-4 flex justify-end print:hidden">
          <PrintButton />
        </div>
      )}

      <div className="border border-neutral-300">
        <div className="flex items-start justify-between gap-6 border-b border-neutral-300 p-5">
          <div className="flex items-start gap-3">
            {branding.logoDataUrl && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={branding.logoDataUrl} alt="" className="h-12 w-auto object-contain" />
            )}
            <div>
              <div className="text-base font-semibold">{org.legalName || branding.appName}</div>
              {org.tradeName && <div className="text-neutral-600">{org.tradeName}</div>}
              <div className="mt-1 leading-5 text-neutral-600">
                {[org.addressLine1, org.addressLine2].filter(Boolean).join(", ")}
                {org.city && <div>{[org.city, org.state, org.pincode].filter(Boolean).join(", ")}</div>}
                {org.gstin && <div>GSTIN: {org.gstin}</div>}
                {org.phone && <div>{org.phone}</div>}
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-lg font-semibold uppercase tracking-wide">
              {tradeDocumentLabels[document.docType]}
            </div>
            <div className="mt-1 font-mono text-neutral-700">{document.docNumber}</div>
            <div className="text-neutral-600">Dated {formatDate(document.issueDate)}</div>
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
            {document.dueDate && <DetailRow label="Payment due" value={formatDate(document.dueDate)} />}
            {document.validUntil && <DetailRow label="Valid until" value={formatDate(document.validUntil)} />}
            <DetailRow label="GST treatment" value={gstTreatmentLabels[document.gstTreatment]} />
            <DetailRow label="Reverse charge" value={document.reverseCharge ? "Yes" : "No"} />
            {document.dispatchFromAddress && (
              <DetailRow label="Dispatch from" value={document.dispatchFromAddress.split("\n").join(", ")} />
            )}
            {document.againstDocument && (
              <DetailRow
                label="Against invoice"
                value={`${document.againstDocument.docNumber} — ${formatDate(document.againstDocument.issueDate)}`}
              />
            )}
          </div>
        </div>

        <table className="w-full">
          <thead className="border-b border-neutral-300 bg-neutral-100 text-left text-[11px] uppercase tracking-wide text-neutral-600">
            <tr>
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">Description</th>
              <th className="px-3 py-2">HSN/SAC</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Rate</th>
              <th className="px-3 py-2 text-right">Taxable</th>
              {isIntraState ? (
                <>
                  <th className="px-3 py-2 text-right">CGST</th>
                  <th className="px-3 py-2 text-right">SGST</th>
                </>
              ) : (
                <th className="px-3 py-2 text-right">IGST</th>
              )}
              <th className="px-3 py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {document.lines.map((line, index) => (
              <tr key={line.id} className="border-b border-neutral-200">
                <td className="px-3 py-2 text-neutral-500">{index + 1}</td>
                <td className="px-3 py-2">
                  {line.name}
                  {line.description && (
                    <div className="mt-0.5 whitespace-pre-line text-[11px] text-neutral-600">{line.description}</div>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-[11px]">{line.hsnCode ?? "—"}</td>
                <td className="px-3 py-2 text-right">
                  {line.quantity}
                  {line.unit ? ` ${line.unit}` : ""}
                </td>
                <td className="px-3 py-2 text-right">{money(line.unitPrice)}</td>
                <td className="px-3 py-2 text-right">
                  {money(line.taxableValue)}
                  {line.discountAmount > 0 && (
                    <div className="text-[10px] text-neutral-500">less {money(line.discountAmount)}</div>
                  )}
                </td>
                {isIntraState ? (
                  <>
                    <td className="px-3 py-2 text-right">
                      {money(line.cgstAmount)}
                      <div className="text-[10px] text-neutral-500">{line.taxRatePercent / 2}%</div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {money(line.sgstAmount)}
                      <div className="text-[10px] text-neutral-500">{line.taxRatePercent / 2}%</div>
                    </td>
                  </>
                ) : (
                  <td className="px-3 py-2 text-right">
                    {money(line.igstAmount)}
                    <div className="text-[10px] text-neutral-500">{line.taxRatePercent}%</div>
                  </td>
                )}
                <td className="px-3 py-2 text-right font-medium">{money(line.lineTotal)}</td>
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
                  <div>Ack date: {formatDate(document.ackDate)}</div>
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

            {(org.bankName || org.upiId) && isSales && (
              <div className="text-[11px] leading-5 text-neutral-600">
                <div className="text-[11px] uppercase tracking-wide text-neutral-500">Bank details</div>
                {org.bankName && <div>{org.bankName}{org.bankBranch ? ` — ${org.bankBranch}` : ""}</div>}
                {org.bankAccountNumber && <div>A/c: {org.bankAccountNumber}</div>}
                {org.bankIfsc && <div>IFSC: {org.bankIfsc}</div>}
                {org.upiId && <div>UPI: {org.upiId}</div>}
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
              {org.signatureDataUrl && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={org.signatureDataUrl} alt="" className="ml-auto h-14 w-auto object-contain" />
              )}
              <div className="mt-1">For {org.legalName || branding.appName}</div>
              <div className="mt-6 border-t border-neutral-300 pt-1">Authorised signatory</div>
            </div>
          </div>
        </div>

        {(document.notes || org.invoiceNotes) && (
          <div className="border-t border-neutral-300 px-5 py-3 text-[11px] leading-5 text-neutral-600">
            {document.notes && <div className="whitespace-pre-wrap">{document.notes}</div>}
            {org.invoiceNotes && <div className="mt-1 whitespace-pre-wrap">{org.invoiceNotes}</div>}
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
