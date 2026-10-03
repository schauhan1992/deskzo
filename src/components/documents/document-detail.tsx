import Link from "next/link";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { getTradeDocument } from "@/actions/trade-document";
import {
  getInvoiceSettlement,
  getCreditNoteBalance,
  listAvailableCredits,
  listOpenInvoices,
} from "@/actions/receivable";
import { hasEffectivePermission } from "@/actions/permission";
import { isModuleEntitled } from "@/lib/modules-access";
import { auth } from "@/lib/auth";
import { getOrganisation } from "@/lib/organisation";
import { isMultiBranch } from "@/lib/branches/identity";
import { branchLabel } from "@/lib/branches/format";
import { Card, CardContent, CardHeader, Badge } from "@/components/ui/card";
import { DocumentActions } from "@/components/documents/document-actions";
import { DocumentEmailHistory } from "@/components/documents/document-email-history";
import { viewerHas } from "@/actions/permission";
import { isEmailable } from "@/lib/documents/email-template";
import { DocumentApprovalBar } from "@/components/documents/document-approval-bar";
import { approvalContext } from "@/actions/document-approval";
import { InvoiceSettlementPanel, CreditNoteApplications } from "@/components/documents/invoice-settlement";
import { BillSettlementPanel } from "@/components/documents/bill-settlement";
import { followUpPanel } from "@/actions/collections";
import { FollowUpPanel } from "@/components/collections/follow-up-panel";
import { getBillSettlement } from "@/actions/payable";
import { formatCalendarDay, indiaClock } from "@/lib/time/zone";
import { workspaceClock } from "@/lib/time/workspace";
import { formatMoney, formatRate, isBaseCurrency, toBase } from "@/lib/currency";
import { GST_STATE_CODES, amountInWords } from "@/lib/gst-engine";
import { gstTreatmentLabels } from "@/lib/gst";
import { isDraftNumber } from "@/lib/document-numbering";
import { isWithinCancellationWindow } from "@/lib/einvoice/provider";
import { ewayForDocument } from "@/actions/eway";
import { carriesGoods } from "@/lib/eway/documents";
import { transporterOptions } from "@/actions/transporter";
import { EwayPanel } from "@/components/logistics/eway-panel";
import { nextStepFor } from "@/lib/document-next-step";
import { descriptionStatesPeriod, formatServicePeriod, showsServicePeriod } from "@/lib/documents/service-period";
import { isModuleEnabled } from "@/actions/module";
import { listSchedules } from "@/actions/revenue";
import { ScheduleLineNote } from "@/components/revenue/schedule-line-note";
import {
  documentDirection,
  documentListPath,
  isEInvoiceEligible,
  statusTone,
  tradeDocumentLabels,
  tradeDocumentStatusLabels,
} from "@/lib/trade-documents";

/**
 * A document's full detail. Rendered on its own page and again inside the split view on a document
 * list, so the two can't drift apart — `embedded` only drops the chrome that the split view
 * already provides.
 */
export async function DocumentDetail({ id, embedded = false }: { id: string; embedded?: boolean }) {
  const [document, org, session, multiBranch, clock] = await Promise.all([
    getTradeDocument(id),
    getOrganisation(),
    auth(),
    isMultiBranch(),
    workspaceClock(),
  ]);
  if (!document) notFound();

  /**
   * Which of the two GSTIN snapshots is ours. On a sale we are the seller; on a purchase we are the
   * buyer and the vendor's GSTIN is the seller's (spec §5.2) — so "seller" and "buyer" would name
   * the right numbers only half the time.
   */
  const isSales = document.direction === "SALES";
  const ourGstin = isSales ? document.sellerGstin : document.buyerGstin;
  const partyGstin = isSales ? document.buyerGstin : document.sellerGstin;
  // Named only where it tells somebody something: a single-branch company raises everything from its
  // head office. A null branch is a document written before branches — the head office's.
  const showBranch = multiBranch || (document.branch !== null && !document.branch.isHeadOffice);

  // Settlement only exists for an issued invoice or credit note — a quote has nothing to settle.
  const isOpenInvoice = document.docType === "INVOICE" && document.status !== "DRAFT" && document.status !== "CANCELLED";
  const isOpenCreditNote = document.docType === "CREDIT_NOTE" && document.status !== "DRAFT" && document.status !== "CANCELLED";
  // The other side of the ledger, which had no way to be settled at all — see bill-settlement.tsx.
  const isOpenBill = document.docType === "BILL" && document.status !== "DRAFT" && document.status !== "CANCELLED";
  // Settling is Receivables' and Payables' work: a plan without them shows the document alone.
  const [receivablesInPlan, payablesInPlan] = await Promise.all([isModuleEntitled("receivables"), isModuleEntitled("payables")]);
  const settleInvoice = isOpenInvoice && receivablesInPlan;
  const settleCreditNote = isOpenCreditNote && receivablesInPlan;
  const [settlement, billSettlement, availableCredits, creditBalance, openInvoices, canRecord, canRemove] = await Promise.all([
    settleInvoice ? getInvoiceSettlement(document.id) : Promise.resolve(null),
    isOpenBill && payablesInPlan ? getBillSettlement(document.id) : Promise.resolve(null),
    settleInvoice ? listAvailableCredits(document.companyId) : Promise.resolve([]),
    settleCreditNote ? getCreditNoteBalance(document.id) : Promise.resolve(null),
    settleCreditNote ? listOpenInvoices(document.companyId) : Promise.resolve([]),
    hasEffectivePermission(session!.user.id, "payments.record"),
    hasEffectivePermission(session!.user.id, "payments.delete"),
  ]);

  // Only asked for once the document is loaded, because it needs the type to find the policy.
  const approval = await approvalContext(document.id);

  // Collections: what sales and accounts have said to the customer about paying this invoice, and any
  // promise — for anybody who can see the account's money (null otherwise). Receivables' own, so only
  // where the plan has it.
  const followUps =
    document.docType === "INVOICE" && document.status !== "DRAFT" && receivablesInPlan ? await followUpPanel({ documentId: document.id }) : null;

  // Revenue & Close: an issued invoice's deferring lines each link to their revenue schedule — where
  // the add-on is available, and for somebody who may read revenue (the link would refuse anyone else).
  const lineSchedules =
    document.docType === "INVOICE" &&
    document.status !== "DRAFT" &&
    (await isModuleEnabled("revenue_close")) &&
    ((await viewerHas("revenue.viewReports")) || (await viewerHas("revenue.manage")))
      ? new Map((await listSchedules({ documentId: document.id, take: 500 })).rows.map((s) => [s.lineId, s]))
      : null;

  /** Every figure on screen, in the currency the document was written in — see the print page. */
  const money = (value: number | string | null | undefined) => formatMoney(value, document.currency);
  const foreign = !isBaseCurrency(document.currency);
  const rate = Number(document.exchangeRate) || 1;

  const isIntraState = document.cgstAmount > 0 || document.sgstAmount > 0;
  const eligible = isEInvoiceEligible(document.docType);
  /**
   * The e-way bill, for the documents goods actually travel on.
   *
   * A refusal is treated as "not your business" rather than an error — somebody who can read an
   * invoice but not despatch against it has no use for a panel of portal buttons. Nothing is
   * fetched at all for a proposal or a proforma, which move no goods.
   */
  const eway = carriesGoods(document.docType, document.status) ? await ewayForDocument(document.id) : null;
  const transporters = eway?.ok ? await transporterOptions() : null;

  const qrDataUrl = document.signedQrCode
    ? await QRCode.toDataURL(document.signedQrCode, { margin: 1, width: 160 }).catch(() => null)
    : null;

  const awaitingApproval = Boolean(approval?.required) && document.approvalStatus !== "APPROVED";
  const nextStep = nextStepFor({
    awaitingApproval,
    docType: document.docType,
    status: document.status,
    dueDate: document.dueDate,
    issueDate: document.issueDate,
    validUntil: document.validUntil,
    balance: settlement?.balance ?? null,
    creditRemaining: creditBalance?.remaining ?? null,
    needsIrn: eligible && org.einvoiceEnabled && document.status !== "DRAFT" && !document.irn && document.einvoiceStatus !== "CANCELLED",
    asOf: new Date(),
  });

  const related = [
    ...(document.sourceDocument ? [{ ...document.sourceDocument, relation: "Converted from" as const }] : []),
    ...(document.againstDocument ? [{ ...document.againstDocument, relation: "Raised against" as const }] : []),
    ...document.conversions.map((d) => ({ ...d, relation: "Converted to" as const })),
    ...document.creditNotes.map((d) => ({ ...d, relation: "Credit note" as const })),
  ];

  return (
    <div className={`@container ${embedded ? "" : "animate-fade-rise"}`}>
      {!embedded && (
        <Link href={documentListPath[document.docType]} className="text-sm text-muted hover:text-text">
          ← {tradeDocumentLabels[document.docType]}s
        </Link>
      )}

      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-text">
              {isDraftNumber(document.docNumber)
                ? `Draft ${tradeDocumentLabels[document.docType].toLowerCase()}`
                : document.docNumber}
            </h1>
            <Badge tone={statusTone[document.status]}>{tradeDocumentStatusLabels[document.status]}</Badge>
            {document.reverseCharge && <Badge tone="amber">Reverse charge</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">
            <Link href={`/companies/${document.company.id}`} className="hover:underline">
              {document.company.name}
            </Link>
            {" · "}
            {formatCalendarDay(document.issueDate)}
            {document.reference ? ` · Ref ${document.reference}` : ""}
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold text-text">{money(document.total)}</div>
          <div className="text-xs text-subtle">{isIntraState ? "CGST + SGST" : "IGST"}</div>
        </div>
      </div>

      {/* Where the "What's next?" banner would be, and instead of it while sign-off is outstanding. */}
      {/* Approval is on for the type, but this one is under its limits — say so, once, and quietly. */}
      {approval?.enabled && !approval.required && document.status === "DRAFT" && (
        <p className="mt-4 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-xs text-muted">{approval.why}</p>
      )}

      {approval?.required && (
        <DocumentApprovalBar
          id={document.id}
          status={document.approvalStatus}
          submittedBy={document.submittedBy?.name ?? null}
          submittedAt={document.submittedAt}
          approvedBy={document.approvedBy?.name ?? null}
          approvedAt={document.approvedAt}
          note={document.approvalNote}
          mayApprove={approval.mayApprove}
          maySubmit={approval.maySubmit}
        />
      )}

      {nextStep && (
        <div
          className={`mt-5 rounded-xl border px-4 py-3 ${
            nextStep.tone === "warning"
              ? "border-warning/40 bg-warning-bg"
              : nextStep.tone === "success"
                ? "border-success/40 bg-success-bg"
                : "border-line bg-surface-sunken"
          }`}
        >
          <div className="text-xs uppercase tracking-wide text-subtle">What&apos;s next?</div>
          <p className="mt-1 text-sm text-text">
            <span className="font-medium">{nextStep.headline}</span>{" "}
            <span className="text-muted">{nextStep.detail}</span>
          </p>
        </div>
      )}

      <Card className="mt-4">
        <CardContent>
          <DocumentActions
            id={document.id}
            docType={document.docType}
            status={document.status}
            einvoiceStatus={document.einvoiceStatus}
            hasIrn={!!document.irn}
            einvoiceEnabled={org.einvoiceEnabled}
            canCancelIrn={isWithinCancellationWindow(document.ackDate)}
            canEmail={
              isEmailable(document.docType) &&
              document.status !== "DRAFT" &&
              document.status !== "CANCELLED" &&
              (await viewerHas("documents.send"))
            }
          />
        </CardContent>
      </Card>

      {isEmailable(document.docType) && <DocumentEmailHistory documentId={document.id} />}

      {eligible && document.einvoiceStatus === "FAILED" && document.einvoiceError && (
        <Card className="mt-4 border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">
          <span className="font-medium">The portal rejected this invoice:</span> {document.einvoiceError}
        </Card>
      )}

      {eway?.ok && (
        <div className="mt-4">
          <EwayPanel view={eway.data} transporters={transporters?.ok ? transporters.data : []} />
        </div>
      )}

      {billSettlement && (
        <div className="mt-4">
          <BillSettlementPanel billId={document.id} settlement={billSettlement} canRecord={canRecord} />
        </div>
      )}

      {settlement && (
        <div className="mt-4">
          <InvoiceSettlementPanel
            invoiceId={document.id}
            settlement={settlement}
            availableCredits={availableCredits}
            canRecord={canRecord}
            canRemove={canRemove}
          />
        </div>
      )}

      {/* Nothing to say on a settled invoice nobody chased: the card appears with a history or a debt. */}
      {followUps && (followUps.history.length > 0 || followUps.canLog) && (
        <div className="mt-4">
          <FollowUpPanel panel={followUps} />
        </div>
      )}

      {creditBalance && (
        <div className="mt-4">
          <CreditNoteApplications
            creditNoteId={document.id}
            balance={creditBalance}
            openInvoices={openInvoices}
            canRecord={canRecord}
          />
        </div>
      )}

      <div className="mt-5 grid grid-cols-1 gap-5 @4xl:grid-cols-3">
        <div className="space-y-5 @4xl:col-span-2">
          <Card className="@container p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="py-2.5 pl-4 pr-2">#</th>
                  <th className="px-2 py-2.5">Description</th>
                  <th className="hidden px-2 py-2.5 @2xl:table-cell">HSN</th>
                  <th className="px-2 py-2.5 text-right">Qty</th>
                  <th className="px-2 py-2.5 text-right">Rate</th>
                  <th className="hidden px-2 py-2.5 text-right @2xl:table-cell">Taxable</th>
                  <th className="px-2 py-2.5 text-right">GST</th>
                  <th className="py-2.5 pl-2 pr-4 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {document.lines.map((line, index) => (
                  <tr key={line.id} className="border-b border-line last:border-0">
                    <td className="py-2.5 pl-4 pr-2 align-top text-subtle">{index + 1}</td>
                    <td className="px-2 py-2.5 align-top text-text">
                      {line.name}
                      {line.description && (
                        <div className="mt-0.5 whitespace-pre-line text-xs text-muted">{line.description}</div>
                      )}
                      {/* Unless the description already says it, as a renewal quote's does. */}
                      {showsServicePeriod(document.docType) &&
                        line.servicePeriodFrom &&
                        line.servicePeriodTo &&
                        !descriptionStatesPeriod(line.description, line.servicePeriodFrom, line.servicePeriodTo) && (
                          <div className="mt-0.5 text-xs text-muted">
                            Service period: {formatServicePeriod(line.servicePeriodFrom, line.servicePeriodTo)}
                          </div>
                        )}
                      {lineSchedules?.get(line.id) && <ScheduleLineNote schedule={lineSchedules.get(line.id)!} />}
                      {line.hsnCode && (
                        <div className="font-mono text-xs text-subtle @2xl:hidden">HSN {line.hsnCode}</div>
                      )}
                    </td>
                    <td className="hidden px-2 py-2.5 align-top font-mono text-xs text-muted @2xl:table-cell">
                      {line.hsnCode ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-right align-top text-muted">
                      {line.quantity}
                      {line.unit ? ` ${line.unit}` : ""}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-right align-top text-muted">
                      {money(line.unitPrice)}
                    </td>
                    <td className="hidden whitespace-nowrap px-2 py-2.5 text-right align-top text-muted @2xl:table-cell">
                      {money(line.taxableValue)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-right align-top text-muted">
                      {line.taxRatePercent}%
                      <div className="text-xs text-subtle">
                        {money(line.cgstAmount + line.sgstAmount + line.igstAmount)}
                      </div>
                    </td>
                    <td className="whitespace-nowrap py-2.5 pl-2 pr-4 text-right align-top font-medium text-text">
                      {money(line.lineTotal)}
                      <div className="text-xs font-normal text-subtle @2xl:hidden">
                        {money(line.taxableValue)} + GST
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {(document.notes || document.terms) && (
            <Card>
              <CardContent className="space-y-3 text-sm">
                {document.notes && (
                  <div>
                    <div className="text-xs uppercase tracking-wide text-subtle">Notes</div>
                    <p className="mt-1 whitespace-pre-wrap text-muted">{document.notes}</p>
                  </div>
                )}
                {document.terms && (
                  <div>
                    <div className="text-xs uppercase tracking-wide text-subtle">Terms</div>
                    <p className="mt-1 whitespace-pre-wrap text-muted">{document.terms}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {document.lead && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Raised from</CardHeader>
              <CardContent className="flex flex-wrap items-center justify-between gap-2 py-3">
                <Link href={`/leads/${document.lead.id}`} className="text-sm text-text hover:underline">
                  {document.lead.title}
                </Link>
                <Badge tone="default">{document.lead.status.replaceAll("_", " ")}</Badge>
              </CardContent>
            </Card>
          )}

          {related.length > 0 && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Related documents</CardHeader>
              <CardContent className="divide-y divide-line">
                {related.map((rel) => (
                  <div key={`${rel.relation}-${rel.id}`} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-subtle">{rel.relation}</div>
                      <Link href={`/documents/${rel.id}`} className="text-sm text-text hover:underline">
                        {isDraftNumber(rel.docNumber) ? `Draft ${tradeDocumentLabels[rel.docType].toLowerCase()}` : rel.docNumber}
                      </Link>
                    </div>
                    <Badge tone="default">{tradeDocumentLabels[rel.docType]}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader className="text-sm font-medium text-text">Summary</CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Subtotal" value={money(document.subtotal)} />
              {document.discountTotal > 0 && <Row label="Discount" value={`− ${money(document.discountTotal)}`} />}
              {document.shippingCharge > 0 && (
                <Row label="Shipping charges" value={money(document.shippingCharge)} />
              )}
              <Row label="Taxable value" value={money(document.taxableValue)} />
              {isIntraState ? (
                <>
                  <Row label="CGST" value={money(document.cgstAmount)} />
                  <Row label="SGST" value={money(document.sgstAmount)} />
                </>
              ) : (
                <Row label="IGST" value={money(document.igstAmount)} />
              )}
              {document.withholdingMode !== "NONE" && (
                <Row
                  label={`${document.withholdingMode}${document.withholdingSection ? ` (${document.withholdingSection})` : ""} @ ${document.withholdingRatePercent}%`}
                  value={`${document.withholdingAmount < 0 ? "− " : "+ "}${money(Math.abs(document.withholdingAmount))}`}
                />
              )}
              {document.adjustment !== 0 && (
                <Row label={document.adjustmentLabel || "Adjustment"} value={money(document.adjustment)} />
              )}
              {document.roundOff !== 0 && <Row label="Round off" value={money(document.roundOff)} />}
              <div className="flex items-center justify-between border-t border-line pt-2 text-base font-semibold text-text">
                <span>Total{foreign ? ` (${document.currency})` : ""}</span>
                <span>{money(document.total)}</span>
              </div>
              {foreign && (
                <div className="flex items-center justify-between text-xs text-subtle">
                  <span>1 {document.currency} = {formatRate(rate)}</span>
                  <span>{formatMoney(toBase(document.total, rate), "INR")}</span>
                </div>
              )}
              <p className="pt-1 text-xs text-subtle">{amountInWords(document.total, document.currency)}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="text-sm font-medium text-text">GST details</CardHeader>
            <CardContent className="space-y-2 text-sm">
              {showBranch && (
                <Row
                  label={isSales ? "Branch" : "Buying branch"}
                  value={
                    <>
                      {document.branch ? branchLabel(document.branch) : "Head office"}
                      {document.branch && !document.branch.active && (
                        <Badge tone="default" className="ml-2">
                          Inactive
                        </Badge>
                      )}
                    </>
                  }
                />
              )}
              <Row label="Our GSTIN" value={ourGstin ?? "—"} />
              <Row label="Party GSTIN" value={partyGstin ?? "Unregistered"} />
              <Row
                label="Place of supply"
                value={
                  document.placeOfSupplyCode
                    ? `${document.placeOfSupplyCode} — ${GST_STATE_CODES[document.placeOfSupplyCode] ?? "Unknown"}`
                    : "Not set"
                }
              />
              <Row label="Supply type" value={isIntraState ? "Intra-state" : "Inter-state"} />
              <Row label="GST treatment" value={gstTreatmentLabels[document.gstTreatment]} />
            </CardContent>
          </Card>

          {eligible && document.irn && (
            <Card>
              <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
                <span>e-Invoice</span>
                <Badge tone={document.einvoiceStatus === "CANCELLED" ? "default" : "green"}>
                  {document.einvoiceStatus === "CANCELLED" ? "Cancelled" : "Registered"}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {qrDataUrl && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={qrDataUrl} alt="Signed e-invoice QR code" className="rounded-base border border-line bg-white p-1" />
                )}
                <div>
                  <div className="text-xs uppercase tracking-wide text-subtle">IRN</div>
                  <p className="mt-0.5 break-all font-mono text-xs text-muted">{document.irn}</p>
                </div>
                <Row label="Ack no." value={document.ackNo ?? "—"} />
                {/* The IRP's dates are statutory: India's, in every workspace. */}
                <Row label="Ack date" value={indiaClock.date(document.ackDate)} />
                {document.einvoiceCancelledAt && (
                  <>
                    <Row label="Cancelled" value={indiaClock.date(document.einvoiceCancelledAt)} />
                    {document.einvoiceCancelReason && (
                      <p className="text-xs text-subtle">{document.einvoiceCancelReason}</p>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="text-sm font-medium text-text">Record</CardHeader>
            <CardContent className="space-y-2 text-sm">
              {/* Named the way the printed document resolves it, not the way the column reads.
                  "Unassigned" beside a quote that went out carrying the account owner's phone
                  number tells whoever is looking the opposite of what the customer received. */}
              {documentDirection[document.docType] === "SALES" && (
                <Row
                  label="Salesperson"
                  value={
                    document.salesperson?.name ??
                    (document.company.owner ? `${document.company.owner.name} — account owner` : "Unassigned")
                  }
                />
              )}
              <Row label="Created by" value={document.createdBy.name} />
              <Row label="Created" value={clock.date(document.createdAt)} />
              <Row label="Issued" value={document.issuedAt ? clock.date(document.issuedAt) : "Not yet issued"} />
              {/* The days typed on the document, held as midnight UTC. */}
              {document.dueDate && <Row label="Due" value={formatCalendarDay(document.dueDate)} />}
              {document.validUntil && <Row label="Valid until" value={formatCalendarDay(document.validUntil)} />}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-muted">
      <span className="shrink-0">{label}</span>
      <span className="min-w-0 break-words text-text">{value}</span>
    </div>
  );
}
