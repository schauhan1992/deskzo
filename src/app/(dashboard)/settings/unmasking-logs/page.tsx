import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { listUnmaskEvents, type UnmaskLogFilters } from "@/actions/unmask-log";
import { resolvePage, resolvePageSize, totalPages, PAGE_SIZES } from "@/lib/pagination";
import { Badge, Card } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { UnmaskLogTable } from "@/components/settings/unmasking/unmask-log-table";

export const metadata = { title: "Unmasking logs" };

const RESULTS = [
  { value: "ALLOWED", label: "Unmasked" },
  { value: "REPEAT", label: "Opened again (no unit used)" },
  { value: "QUOTA_EXHAUSTED", label: "Daily limit reached" },
  { value: "DENIED", label: "Refused" },
];

/**
 * Settings › Staff › Unmasking logs — every attempt to unmask a lead's hidden fields, for
 * the workspace's super admin alone (src/actions/unmask-log.ts decides that, again, on every call).
 * Opens on `permissions.view` like the rest of Settings › Staff, and then only for the super admin
 * acting as themselves.
 */
export default async function UnmaskingLogsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const one = (key: string) => (Array.isArray(params[key]) ? params[key][0] : params[key]) as string | undefined;
  const user = await currentUser();
  const allowed = user !== null && (await can(user.id, "permissions.view")) && (await actingAsSuperAdmin(user.id));
  if (!allowed) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Unmasking logs</h1>
        <p className="mt-2 text-sm text-muted">Only the workspace&apos;s super admin can read the unmasking logs, and only as themselves.</p>
      </div>
    );
  }

  const filters: UnmaskLogFilters = { from: one("from"), to: one("to"), userId: one("userId"), lead: one("lead"), result: one("result") };
  const page = resolvePage(one("page"));
  const pageSize = resolvePageSize(one("pageSize"));
  const result = await listUnmaskEvents(filters, { page, pageSize });
  const data = result.ok ? result.data : { rows: [], total: 0, people: [] };

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold text-text">Unmasking logs</h1>
        <Badge tone="brand">Super Admin only</Badge>
      </div>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Every time somebody opened a lead whose fields are masked for them: whether it was unmasked, opened again the same day, stopped by the
        daily limit, or refused — with the fields concerned, never what they held. Nobody can change or remove a row.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <DateRangePicker fromParam="from" toParam="to" label="Date" />
        {data.people.length > 0 && (
          <SelectParamFilter paramName="userId" label="User" allLabel="All users" options={data.people.map((p) => ({ value: p.id, label: p.name }))} />
        )}
        <SearchParamInput paramName="lead" placeholder="Lead number (LEAD-000123)" label="Lead" />
        <SelectParamFilter paramName="result" label="Result" allLabel="Every result" options={RESULTS} />
      </div>

      <Card className="mt-4 overflow-hidden">
        {!result.ok ? (
          <p className="px-4 py-8 text-center text-sm text-danger">{result.error}</p>
        ) : (
          <UnmaskLogTable rows={data.rows} filters={filters} total={data.total} />
        )}
      </Card>

      {data.total > 0 && (
        <div className="mt-4">
          <Pagination page={page} pageSize={pageSize} total={data.total} totalPages={totalPages(data.total, pageSize)} pageSizes={PAGE_SIZES} label="attempts" />
        </div>
      )}
    </div>
  );
}
