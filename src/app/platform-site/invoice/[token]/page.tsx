import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PrintButton } from "@/components/billing/print-button";
import { TaxDocumentView } from "@/components/billing/tax-document";
import { documentByToken } from "@/lib/billing/tax-invoice";

/**
 * One of Deskzo's own tax invoices or credit notes, by its private link (src/lib/billing/tax-invoice.ts
 * mails it): whoever has the link can read that one document — the workspace owner, or the distributor
 * it was made out to, who has no account to sign in with. Anything else is not found. Kept out of
 * search engines, and printed without the site's header and footer.
 */

export const metadata: Metadata = { title: "Tax invoice", robots: { index: false, follow: false } };

export default async function InvoicePage({ params }: PageProps<"/platform-site/invoice/[token]">) {
  const { token } = await params;
  const doc = await documentByToken(token);
  if (!doc) notFound();
  return (
    <div className="bg-neutral-100 px-4 py-8 print:bg-white print:p-0 sm:py-12">
      {/* Printed as the document alone: the site's own header and footer stay on screen. */}
      <style>{"@media print { header, footer, [data-print-hide] { display: none !important; } @page { size: A4; margin: 14mm; } }"}</style>
      <div data-print-hide className="mx-auto mb-4 flex max-w-[210mm] items-center justify-between gap-3">
        <p className="text-sm text-neutral-600">{doc.kind === "invoice" ? "Tax invoice" : "Credit note"} {doc.number}</p>
        <PrintButton />
      </div>
      <TaxDocumentView doc={doc} />
    </div>
  );
}
