import Link from "next/link";
import type { TradeDocumentType, TradeDocumentStatus } from "@prisma/client";
import { listTradeDocuments, tradeDocumentSummary } from "@/actions/trade-document";
import { approvalDocumentsFor, approvalPolicyFor } from "@/lib/documents/approval-policy";
import { approvalRequirement } from "@/lib/documents/approval";
import { Button } from "@/components/ui/button";
import { DocumentRows } from "@/components/documents/document-rows";
import { DocumentSplitList } from "@/components/documents/document-split-list";
import { DocumentDetail } from "@/components/documents/document-detail";
import { DocumentPdfPreview } from "@/components/documents/document-pdf-preview";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { ColumnPicker } from "@/components/ui/table-columns";
import { documentTableKey } from "@/lib/tables/registry";
import { listAssignableUsers } from "@/actions/company";
import { isMultiBranch, listBranchChoices } from "@/lib/branches/identity";
import { branchLabel } from "@/lib/branches/format";
import { Pagination } from "@/components/ui/pagination";
import { SplitListShell, SplitListEmpty, SplitListPage, resolveSelected } from "@/components/ui/split-list";
import { ViewModeToggle } from "@/components/ui/view-mode-toggle";
import { getViewMode } from "@/actions/view-mode";
import { formatCurrency } from "@/lib/utils";
import { PAGE_SIZES, resolvePage, resolvePageSize } from "@/lib/pagination";
import {
  documentDirection,
  documentListPath,
  documentOriginLabels,
  isEInvoiceEligible,
  tradeDocumentLabels,
  tradeDocumentStatusLabels,
} from "@/lib/trade-documents";

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
  /** Issue-date window. */
  from?: string;
  to?: string;
  salesperson?: string;
  /** A `DocumentOrigin`, or "none" for documents that never recorded one. */
  origin?: string;
  /** One branch's documents (the head office's include those written before branches). */
  branch?: string;
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

  /**
   * The branch filter exists only where there is more than one branch, and so does its effect: a
   * `branch` left in a link from when there were two must not narrow a list with no control to undo it.
   */
  const multiBranchCheck = isMultiBranch();
  const [viewMode, { rows, total }, summary, approvalPolicy, users, multiBranch, branches] = await Promise.all([
    getViewMode("documents"),
    multiBranchCheck.then((multi) =>
      listTradeDocuments({
        docType,
        status,
        search: searchParams.q,
        from: searchParams.from,
        to: searchParams.to,
        salespersonId: searchParams.salesperson,
        origin: searchParams.origin,
        branchId: multi ? searchParams.branch || undefined : undefined,
        page,
        pageSize,
      }),
    ),
    tradeDocumentSummary(docType),
    // One answer for the whole list rather than per row: approval is configured per type.
    approvalPolicyFor(docType),
    listAssignableUsers(),
    multiBranchCheck,
    // The one filtered by stays nameable after it is deactivated, as a link to it may outlive it.
    multiBranchCheck.then((multi) => (multi ? listBranchChoices({ include: searchParams.branch ? [searchParams.branch] : [] }) : [])),
  ]);

  /**
   * Which of this page's documents need sign-off. The type may only need it above a value or a
   * discount, so the badge is decided per document — a ₹5,000 quote under the limit is not "Not
   * submitted", it is simply a quote.
   */
  const approvalFacts = approvalPolicy.enabled ? await approvalDocumentsFor(rows.map((r) => r.id)) : new Map();
  const approvalRequiredIds = rows
    .filter((r) => approvalPolicy.enabled && (!approvalFacts.has(r.id) || approvalRequirement(approvalPolicy, approvalFacts.get(r.id)!).required))
    .map((r) => r.id);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const basePath = documentListPath[docType];
  const eInvoiced = isEInvoiceEligible(docType);
  const isSales = documentDirection[docType] === "SALES";

  const draftCount = summary.find((s) => s.status === "DRAFT")?.count ?? 0;
  const issuedValue = summary
    .filter((s) => s.status !== "DRAFT" && s.status !== "CANCELLED")
    .reduce((sum, s) => sum + s.total, 0);

  /**
   * The current query with a few keys overridden.
   *
   * Everything that came in is carried through, rather than a hand-listed set of keys. The old
   * version named five params explicitly, which made it a whitelist: every filter added afterwards
   * would be silently dropped the moment somebody used one of these links, and the link would look
   * like it had cleared the filter on purpose.
   */
  function queryFor(overrides: Record<string, string | undefined>) {
    const next: Record<string, string | undefined> = { ...searchParams, ...overrides };
    return Object.fromEntries(Object.entries(next).filter(([, v]) => v)) as Record<string, string>;
  }

  const selected = viewMode === "split" ? resolveSelected(rows, searchParams.sel) : null;
  const pdfView = selected !== null && searchParams.view === "pdf";

  /**
   * One row, the way every other records list does it.
   *
   * This screen used to spend two bands on a single search box and nine status pills — 102px to
   * offer one filter. The pills read well but they do not scale: adding the four filters below
   * would have made three bands of chrome above a list somebody is trying to read. Each control
   * resets `page` itself, which is what the pills' `page: undefined` was doing by hand.
   *
   * Nothing resets `sel`: `resolveSelected` already falls back to the first row when the open
   * document is filtered out, so the split view heals itself.
   */
  const filters = (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <SearchParamInput paramName="q" placeholder="Search number, reference or party…" />
      <SelectParamFilter
        paramName="status"
        label="Status"
        allLabel="Any status"
        options={STATUS_VALUES.map((v) => ({ value: v, label: tradeDocumentStatusLabels[v] }))}
      />
      {/* Only where there is one to filter by: a purchase order's last column is whoever raised it,
          not a salesperson, and `listTradeDocuments` narrows on `salespersonId` either way. */}
      {isSales && (
        <SelectParamFilter
          paramName="salesperson"
          label="Salesperson"
          allLabel="Anyone"
          options={users.map((u) => ({ value: u.id, label: u.name }))}
        />
      )}
      {multiBranch && (
        <SelectParamFilter
          paramName="branch"
          label={isSales ? "Branch" : "Buying branch"}
          allLabel="All branches"
          options={branches.map((b) => ({ value: b.id, label: `${branchLabel(b)}${b.active ? "" : " (inactive)"}` }))}
        />
      )}
      <SelectParamFilter
        paramName="origin"
        label="Source"
        allLabel="Any source"
        options={[
          ...Object.entries(documentOriginLabels).map(([value, label]) => ({ value, label })),
          // A real answer rather than an absent filter — it finds what the back catalogue could
          // not place, which is the question the Source column raises.
          { value: "none", label: "Not recorded" },
        ]}
      />
      <DateRangePicker fromParam="from" toParam="to" label="Issued" />
      {/* Only in table view. The split list is a card list, not a table, so a picker there would
          offer choices that change nothing on screen. */}
      {viewMode === "list" && <ColumnPicker tableKey={documentTableKey(docType)} className="ml-auto" omit={multiBranch ? undefined : ["branch"]} />}
    </div>
  );

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      {/**
        * `min-w-0 flex-1` so the text column yields rather than shoving the actions onto their own
        * line. The subtitle grew when the summary cards were folded into it, and a flex child sized
        * to its content took the full width — which wrapped the toggle and the New button below the
        * heading and left-aligned them, reading as though they belonged to nothing.
        */}
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold text-text">{title}</h1>
        {/**
          * The three figures that used to be cards, on the subtitle line.
          *
          * "Shown" rather than "total" is load-bearing. `total` comes from the list query and *is*
          * narrowed by the search and the filters; `draftCount` and `issuedValue` come from
          * `tradeDocumentSummary`, which takes neither and always describes the whole book. In
          * separate bordered cards that difference was invisible; on one line, "12 total · 40 draft"
          * would read as a contradiction. Saying "shown" makes the narrowing explicit instead.
          */}
        <p className="mt-1 text-sm text-muted">
          {description} · {total} shown · {draftCount} draft ·{" "}
          {/* Labelled as an equivalent because the documents behind it may be in several
              currencies and this is their rupee total. */}
          {formatCurrency(issuedValue)} issued (₹ equivalent)
        </p>
      </div>
      {/* `ml-auto` as well as `justify-between`, so that on a screen narrow enough to wrap anyway
          these stay on the right rather than falling to the left margin. */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
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

      {filters}

      {viewMode === "split" ? (
        <SplitListShell
          countLabel={`${total} ${tradeDocumentLabels[docType].toLowerCase()}${total === 1 ? "" : "s"}`}
          listPane={
            <DocumentSplitList documents={rows} selectedId={selected} approvalEnabled={approvalPolicy.enabled} approvalRequiredIds={approvalRequiredIds} />
          }
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
          {/* mt-6 is what all seven peer list screens use. */}
          <div className="mt-6">
            <DocumentRows
              docType={docType}
              documents={rows}
              eInvoiced={eInvoiced}
              approvalEnabled={approvalPolicy.enabled}
              approvalRequiredIds={approvalRequiredIds}
              branchColumn={multiBranch}
            />
          </div>

          <Pagination page={page} pageSize={pageSize} total={total} totalPages={totalPages} pageSizes={PAGE_SIZES} />
        </>
      )}
    </SplitListPage>
  );
}
