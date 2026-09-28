import { Card } from "@/components/ui/card";
import { currentUser } from "@/lib/session";
import { auth } from "@/lib/auth";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listJournalEntries } from "@/actions/ledger-reports";
import { listAccounts } from "@/actions/ledger";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { JournalEntries } from "@/components/accounting/journal-entries";
import { NewJournalDialog } from "@/components/accounting/new-journal-dialog";
import { DateParamInput } from "@/components/accounting/date-param-input";
import { can } from "@/lib/authz/resolve";
import { listBranchChoices, listRegistrationChoices } from "@/lib/branches/identity";
import type { BranchChoice, RegistrationChoice } from "@/lib/branches/format";

export default async function JournalPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; source?: string; from?: string; to?: string; page?: string; pageSize?: string }>;
}) {
  const enabled = await isModuleEnabled("accounting");
  if (!enabled) return <ModuleDisabledNotice moduleKey="accounting" />;

  /**
   * The books are not a module-level read.
   *
   * Every statement on these pages is built from the same ledger, and the actions behind them
   * answered any signed-in session until this key existed. Refused in place rather than hidden, so
   * somebody who followed a link is told why.
   */
  const viewer = await currentUser();
  if (!viewer || !(await can(viewer.id, "ledger.viewReports"))) {
    return (
      <Card className="px-6 py-10 text-center text-sm text-muted">
        You don&rsquo;t have permission to see the books.
      </Card>
    );
  }

  const params = await searchParams;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);

  const [session, result, accounts] = await Promise.all([
    auth(),
    listJournalEntries({ page, pageSize, source: params.source, search: params.q, from: params.from, to: params.to }),
    listAccounts({ postableOnly: true }),
  ]);
  const isAdmin = session ? await can(session.user.id, "ledger.post") : false;
  // What a new entry's lines may be tagged with — only the dialog needs them, and only somebody who
  // may post sees it. Active ones only: a closed branch or a surrendered GSTIN takes no new lines.
  const [branches, registrations]: [BranchChoice[], RegistrationChoice[]] = isAdmin
    ? await Promise.all([listBranchChoices(), listRegistrationChoices().then((all) => all.filter((r) => r.active))])
    : [[], []];

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Journal</h1>
          <p className="mt-1 text-sm text-muted">
            {result.total} entr{result.total === 1 ? "y" : "ies"} — every posting, in the order it was made. Nothing
            here is edited or deleted; a mistake is corrected by a reversal.
          </p>
        </div>
        {isAdmin && <NewJournalDialog accounts={accounts} branches={branches} registrations={registrations} />}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search entry number or narration…" />
        <SelectParamFilter
          paramName="source"
          label="Source"
          allLabel="All"
          options={[
            { value: "INVOICE", label: "Invoice" },
            { value: "CREDIT_NOTE", label: "Credit note" },
            { value: "BILL", label: "Bill" },
            { value: "PAYMENT", label: "Payment" },
            { value: "EXPENSE", label: "Expense" },
            { value: "MANUAL", label: "Manual" },
            { value: "OPENING", label: "Opening" },
          ]}
        />
        <DateParamInput paramName="from" label="From" />
        <DateParamInput paramName="to" label="To" />
      </div>

      <div className="mt-5">
        <JournalEntries entries={result.rows} canReverse={isAdmin} />
      </div>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={result.total}
        totalPages={totalPages(result.total, pageSize)}
        pageSizes={PAGE_SIZES}
      />
    </div>
  );
}
