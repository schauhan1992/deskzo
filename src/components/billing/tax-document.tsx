import type { TaxDocument } from "@/lib/billing/tax-invoice";

/**
 * One of Deskzo's own GST documents — a tax invoice or a credit note — as issued (src/lib/billing/
 * tax-invoice.ts keeps it frozen), laid out for A4: on screen at /invoice/<token>, and saved as a PDF
 * by the browser's print. Everything shown is the document's own; nothing is looked up again.
 */

const money = (paise: number) => (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "12 October 2026", as the document's own calendar day. */
function dayText(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
}

function Party({ title, party, extra }: { title: string; party: TaxDocument["buyer"] & { pan?: string | null }; extra?: string | null }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{title}</p>
      <p className="mt-1 font-semibold text-neutral-900">{party.name}</p>
      {party.address && <p className="whitespace-pre-line text-neutral-700">{party.address}</p>}
      <p className="text-neutral-700">
        {party.stateName} ({party.state})
      </p>
      <p className="text-neutral-700">{party.gstin ? `GSTIN ${party.gstin}` : "Unregistered — no GSTIN"}</p>
      {party.pan && <p className="text-neutral-700">PAN {party.pan}</p>}
      {extra && <p className="mt-1 text-neutral-700">{extra}</p>}
    </div>
  );
}

export function TaxDocumentView({ doc }: { doc: TaxDocument }) {
  const credit = doc.kind === "credit-note";
  const title = credit ? "Credit note" : "Tax invoice";
  return (
    <article className="mx-auto w-full max-w-[210mm] bg-white p-6 text-[13px] leading-5 text-neutral-900 shadow-sm ring-1 ring-neutral-200 print:p-0 print:shadow-none print:ring-0 sm:p-10">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-neutral-300 pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-neutral-700">
            No. <span className="font-semibold tabular-nums">{doc.number}</span> · {dayText(doc.issuedAt)}
          </p>
          {doc.against && (
            <p className="text-neutral-700">
              Against tax invoice <span className="font-semibold tabular-nums">{doc.against.number}</span> of {dayText(doc.against.issuedAt)}
            </p>
          )}
        </div>
        <div className="text-right text-neutral-700">
          <p>SAC {doc.sac}</p>
          <p>
            Place of supply: {doc.placeOfSupply.name} ({doc.placeOfSupply.code})
          </p>
          {doc.period && (
            <p>
              Period: {dayText(`${doc.period.from}T00:00:00+05:30`)} – {dayText(`${doc.period.to}T00:00:00+05:30`)}
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-6 border-b border-neutral-300 py-4 sm:grid-cols-2">
        <Party title="From" party={{ ...doc.seller, email: null }} />
        <Party title={credit ? "To" : "Billed to"} party={doc.buyer} extra={doc.endUser ? `For: ${doc.endUser.name} (${doc.endUser.host})` : null} />
      </div>

      <table className="mt-4 w-full border-collapse text-left">
        <caption className="sr-only">{`${title} ${doc.number}, its lines`}</caption>
        <thead>
          <tr className="border-b border-neutral-300 text-[11px] uppercase tracking-wider text-neutral-500">
            <th scope="col" className="py-2 pr-3 font-semibold">
              Description
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-semibold">
              Qty
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-semibold">
              Rate (₹)
            </th>
            <th scope="col" className="py-2 text-right font-semibold">
              Taxable value (₹)
            </th>
          </tr>
        </thead>
        <tbody>
          {doc.lines.map((l, i) => (
            <tr key={i} className="border-b border-neutral-200 align-top">
              <td className="py-2 pr-3">{l.description}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{l.quantity}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{money(l.unitPrice)}</td>
              <td className="py-2 text-right tabular-nums">{money(l.taxable)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="ml-auto mt-4 w-full max-w-72 space-y-1 tabular-nums">
        <div className="flex justify-between gap-4">
          <dt className="text-neutral-700">Taxable value</dt>
          <dd>₹{money(doc.taxable)}</dd>
        </div>
        {doc.supply === "intra" ? (
          <>
            <div className="flex justify-between gap-4">
              <dt className="text-neutral-700">CGST at {doc.ratePercent / 2}%</dt>
              <dd>₹{money(doc.cgst)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-neutral-700">SGST at {doc.ratePercent / 2}%</dt>
              <dd>₹{money(doc.sgst)}</dd>
            </div>
          </>
        ) : (
          <div className="flex justify-between gap-4">
            <dt className="text-neutral-700">IGST at {doc.ratePercent}%</dt>
            <dd>₹{money(doc.igst)}</dd>
          </div>
        )}
        <div className="flex justify-between gap-4 border-t border-neutral-300 pt-1 text-base font-semibold">
          <dt>{credit ? "Credited" : "Total"}</dt>
          <dd>₹{money(doc.total)}</dd>
        </div>
      </dl>
      <p className="mt-2 text-right text-neutral-700">{doc.amountInWords}</p>

      <div className="mt-6 space-y-1 border-t border-neutral-300 pt-4 text-neutral-700">
        {doc.reason && <p>Reason: {doc.reason}</p>}
        {doc.paid && <p>{doc.paid}.</p>}
        <p>Tax is not payable on reverse charge.</p>
        <p className="text-neutral-500">This is a computer-generated document and needs no signature.</p>
      </div>
    </article>
  );
}
