import Link from "next/link";
import type { TradeDocumentType, TradeDocumentStatus } from "@prisma/client";
import { listTradeDocuments, tradeDocumentSummary } from "@/actions/trade-document";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DocumentRows } from "@/components/documents/document-rows";
import { DocumentSplitList } from "@/components/documents/document-split-list";
import { DocumentDetail } from "@/components/documents/document-detail";
import { DocumentPdfPreview } from "@/components/documents/document-pdf-preview";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { Pagination } from "@/components/ui/pagination";
import { SplitListShell, SplitListEmpty, SplitListPage, resolveSelected } from "@/components/ui/split-list";
import { ViewModeToggle } from "@/components/ui/view-mode-toggle";
import { getViewMode } from "@/actions/view-mode";
import { formatCurrency } from "@/lib/utils";
import { PAGE_SIZES, resolvePage, resolvePageSize } from "@/lib/pagination";
import { documentListPath, isEInvoiceEligible, tradeDocumentLabels, tradeDocumentStatusLabels } from "@/lib/trade-documents";

const STATUS_VALUES: TradeDocumentStatus[] = [
  "DRAFT",
  "ISSUED",
  "ACCEPTED",
  "REJECTED",
  "PARTIALLY_PAID",
  "PAID",
  "CANCELLED",
  "EXPIRED",
];

export type DocumentListSearchParams = {
  status?: string;
  q?: string;
  page?: string;
  pageSize?: string;
  /** Which document is open beside the list. */
  sel?: string;
  /** "pdf" swaps the open document for a preview of what prints. */
  view?: string;
};

export async function DocumentList({
  docType,
  title,
  description,
  searchParams,
}: {
  docType: TradeDocumentType;
  title: string;
  description: string;
  searchParams: DocumentListSearchParams;
}) {
  const status = STATUS_VALUES.includes(searchParams.status as TradeDocumentStatus)
    ? (searchParams.status as TradeDocumentStatus)
    : undefined;
  const page = resolvePage(searchParams.page);
  const pageSize = resolvePageSize(searchParams.pageSize);

  const [viewMode, { rows, total }, summary] = await Promise.all([
    getViewMode("documents"),
    listTradeDocuments({ docType, status, search: searchParams.q, page, pageSize }),
    tradeDocumentSummary(docType),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const basePath = documentListPath[docType];
  const eInvoiced = isEInvoiceEligible(docType);

  const draftCount = summary.find((s) => s.status === "DRAFT")?.count ?? 0;
  const issuedValue = summary
    .filter((s) => s.status !== "DRAFT" && s.status !== "CANCELLED")
    .reduce((sum, s) => sum + s.total, 0);

  function queryFor(overrides: Record<string, string | undefined>) {
    const next = {
      status: searchParams.status,
      q: searchParams.q,
      pageSize: searchParams.pageSize,
      sel: searchParams.sel,
      view: searchParams.view,
      ...overrides,
    };
    return Object.fromEntries(Object.entries(next).filter(([, v]) => v)) as Record<string, string>;
  }

  const selected = viewMode === "split" ? resolveSelected(rows, searchParams.sel) : null;
  const pdfView = selected !== null && searchParams.view === "pdf";

  const filters = (
    <>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search number, reference or party…" />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {[
          { label: "All", value: undefined as TradeDocumentStatus | undefined },
          ...STATUS_VALUES.map((v) => ({ label: tradeDocumentStatusLabels[v], value: v })),
        ].map((f) => (
          <Link
            key={f.label}
            href={{ pathname: basePath, query: queryFor({ status: f.value, page: undefined }) }}
            className={`rounded-full px-3 py-1 text-sm transition-colors ${
              status === f.value || (!status && !f.value)
                ? "bg-brand text-brand-contrast"
                : "border border-line-strong bg-surface text-muted hover:text-text"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>
    </>
  );

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-text">{title}</h1>
        <p className="mt-1 text-sm text-muted">{description}</p>
      </div>
      <div className="flex items-center gap-2">
        <ViewModeToggle viewKey="documents" mode={viewMode} />
        <Link href={`/documents/new?type=${docType}`}>
          <Button>New {tradeDocumentLabels[docType].toLowerCase()}</Button>
        </Link>
      </div>
    </div>
  );

  return (
    <SplitListPage active={viewMode === "split"}>
      {header}

      {viewMode === "list" && (
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Card className="px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-subtle">Total</div>
            <div className="mt-1 text-lg font-semibold text-text">{total}</div>
          </Card>
          <Card className="px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-subtle">Drafts</div>
            <div className="mt-1 text-lg font-semibold text-text">{draftCount}</div>
          </Card>
          <Card className="px-4 py-3">
            {/* Labelled, because it is a converted figure: the documents behind it may be in
                several currencies and the total is their rupee equivalent. */}
            <div className="text-xs uppercase tracking-wide text-subtle">Issued value (₹)</div>
            <div className="mt-1 text-lg font-semibold text-text">{formatCurrency(issuedValue)}</div>
          </Card>
        </div>
      )}

      {filters}

      {viewMode === "split" ? (
        <SplitListShell
          countLabel={`${total} ${tradeDocumentLabels[docType].toLowerCase()}${total === 1 ? "" : "s"}`}
          listPane={<DocumentSplitList documents={rows} selectedId={selected} />}
        >
          {selected ? (
            <>
              {/* The same document two ways: the working view, and what the customer will receive. */}
              <div className="mb-3 flex rounded-base border border-line p-0.5 w-fit">
                {[
                  { label: "Details", value: undefined },
                  { label: "PDF", value: "pdf" },
                ].map((tab) => {
                  const active = (searchParams.view === "pdf") === (tab.value === "pdf");
                  return (
                    <Link
                      key={tab.label}
                      href={{ pathname: basePath, query: queryFor({ view: tab.value }) }}
                      scroll={false}
                      aria-current={active ? "page" : undefined}
                      className={`rounded-[5px] px-3 py-1 text-sm transition-colors ${
                        active ? "bg-brand text-brand-contrast" : "text-muted hover:text-text"
                      }`}
                    >
                      {tab.label}
                    </Link>
                  );
                })}
              </div>
              {pdfView ? (
                <DocumentPdfPreview key={selected} documentId={selected} />
              ) : (
                <DocumentDetail id={selected} embedded />
              )}
            </>
          ) : (
            <SplitListEmpty message="Nothing here yet." />
          )}
        </SplitListShell>
      ) : (
        <>
          <div className="mt-5">
            <DocumentRows docType={docType} documents={rows} eInvoiced={eInvoiced} />
          </div>

          <Pagination page={page} pageSize={pageSize} total={total} totalPages={totalPages} pageSizes={PAGE_SIZES} />
        </>
      )}
    </SplitListPage>
  );
}
