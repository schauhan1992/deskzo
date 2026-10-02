import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";
import Link from "next/link";
import type { VisitStatus, VisitPurpose } from "@prisma/client";
import { listVisitsPaged, listVisitAssignees } from "@/actions/visit";
import { isModuleEnabled } from "@/actions/module";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { VisitsTable } from "@/components/visits/visits-table";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { visitPurposeValues, visitPurposeLabels, visitStatusValues, visitStatusLabels } from "@/lib/visits";

const asStatus = (v?: string) => (visitStatusValues.includes(v as VisitStatus) ? (v as VisitStatus) : undefined);
const asPurpose = (v?: string) => (visitPurposeValues.includes(v as VisitPurpose) ? (v as VisitPurpose) : undefined);

export default async function VisitsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    purpose?: string;
    rep?: string;
    q?: string;
    from?: string;
    to?: string;
    page?: string;
    pageSize?: string;
  }>;
}) {
  const enabled = await isModuleEnabled("visits");
  if (!enabled) return <ModuleDisabledNotice moduleKey="visits" />;

  const params = await searchParams;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);

  const [result, assignees] = await Promise.all([
    listVisitsPaged({
      status: asStatus(params.status),
      purpose: asPurpose(params.purpose),
      userId: params.rep,
      search: params.q,
      from: params.from,
      to: params.to,
      page,
      pageSize,
    }),
    listVisitAssignees(),
  ]);

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">{slot(await getWording(), "Field visits", "visit")}</h1>
          <p className="mt-1 text-sm text-muted">
            {result.total} visit(s)
            {result.openCount > 0 && ` · ${result.openCount} still open`}
          </p>
        </div>
        <Link href="/visits/new">
          <Button>{slot(await getWording(), "Plan visit", "visit", "Plan {one:lower}")}</Button>
        </Link>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search company, agenda or outcome…" />
        <SelectParamFilter
          paramName="status"
          label="Status"
          options={visitStatusValues.map((s) => ({ value: s, label: visitStatusLabels[s] }))}
        />
        <SelectParamFilter
          paramName="purpose"
          label="Purpose"
          options={visitPurposeValues.map((p) => ({ value: p, label: visitPurposeLabels[p] }))}
        />
        <SelectParamFilter
          paramName="rep"
          label="Rep"
          allLabel="Everyone visible"
          options={assignees.map((u) => ({ value: u.id, label: u.name }))}
        />
        <DateRangePicker fromParam="from" toParam="to" label="Scheduled" />
      </div>

      {result.total === 0 && !params.q && !params.status && (
        <Card className="mt-5 px-4 py-3 text-sm text-muted">
          Nothing planned yet. A visit records why you went, what came of it, and what it cost — plan one and the
          travel can be claimed straight against it.
        </Card>
      )}

      <div className="mt-5">
        <VisitsTable visits={result.rows} />
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
