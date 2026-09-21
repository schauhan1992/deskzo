import type { ActivityKind, ActivitySeverity } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { listActivity, activitySummary, activityUserOptions, type ActivityFilters } from "@/actions/activity";
import { ACTIVITY_GROUPS, ACTIVITY_KINDS, type ActivityGroup } from "@/lib/security/activity-kinds";
import { resolvePage, resolvePageSize, totalPages, PAGE_SIZES } from "@/lib/pagination";
import { Card, CardContent } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { ActivityTable } from "@/components/security/activity-table";

/**
 * The activity log.
 *
 * Everybody can open this and see their own; only `activity.viewAll` widens it to the company. The
 * scoping happens in the action, not here — a page that decides its own visibility is a page
 * somebody eventually links past.
 */

const GROUP_KEYS = ACTIVITY_GROUPS.map((g) => g.key) as string[];
const KIND_KEYS = ACTIVITY_KINDS.map((k) => k.key) as string[];
const SEVERITIES: ActivitySeverity[] = ["INFO", "NOTICE", "WARNING", "CRITICAL"];

function Figure({ label, value, tone }: { label: string; value: number; tone?: "danger" | "warning" }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div
        className={`mt-0.5 text-xl font-semibold tabular-nums ${
          tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-text"
        }`}
      >
        {value.toLocaleString("en-IN")}
      </div>
    </div>
  );
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (key: string) => (Array.isArray(params[key]) ? params[key][0] : params[key]) as string | undefined;

  const user = await requireUser();
  const canSeeAll = await hasEffectivePermission(user.id, "activity.viewAll");
  const canExport = await hasEffectivePermission(user.id, "activity.export");

  const kindParam = one("kind");
  const groupParam = one("group");
  const severityParam = one("severity");

  const filters: ActivityFilters = {
    // Validated against the registry rather than trusted: a hand-edited query string reaching
    // Prisma as an enum value it does not have is a 500, and as a `where` it never asked for is
    // worse.
    kinds: kindParam && KIND_KEYS.includes(kindParam) ? [kindParam as ActivityKind] : undefined,
    group: groupParam && GROUP_KEYS.includes(groupParam) ? (groupParam as ActivityGroup) : undefined,
    minSeverity:
      severityParam && SEVERITIES.includes(severityParam as ActivitySeverity)
        ? (severityParam as ActivitySeverity)
        : undefined,
    userId: one("userId"),
    from: one("from"),
    to: one("to"),
    search: one("q"),
    // Set by the "everything that happened to this record" link in an expanded row, so a single
    // company, order or subscription can be followed on its own without a page per record type.
    entityType: one("entityType"),
    entityId: one("entityId"),
    impersonatedOnly: one("impersonated") === "1",
  };

  const page = resolvePage(one("page"));
  const pageSize = resolvePageSize(one("pageSize"));

  const [result, summary, users] = await Promise.all([
    listActivity({ filters, page, pageSize }),
    activitySummary(filters),
    activityUserOptions(),
  ]);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Activity log</h1>
          <p className="mt-1 text-sm text-muted">
            {canSeeAll
              ? "Sign-ins, exports, refused permissions, blocked crawlers and every data-loss-prevention event."
              : "Everything your account has done. Worth a look if you ever see a sign-in you don't recognise."}
          </p>
        </div>
      </div>

      <Card className="mt-4">
        <CardContent className="grid grid-cols-2 gap-4 py-3 sm:grid-cols-5">
          <Figure label="Events" value={summary.total} />
          <Figure label="Critical" value={summary.critical} tone="danger" />
          <Figure label="Warning" value={summary.warning} tone="warning" />
          <Figure label="Notice" value={summary.notice} />
          <Figure label="Info" value={summary.info} />
        </CardContent>
      </Card>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search summary, user, page, address…" />
        <SelectParamFilter
          paramName="group"
          label="Area"
          allLabel="All areas"
          options={ACTIVITY_GROUPS.map((g) => ({ value: g.key, label: g.label }))}
        />
        <SelectParamFilter
          paramName="kind"
          label="Event"
          allLabel="All events"
          options={ACTIVITY_KINDS.map((k) => ({ value: k.key, label: k.label }))}
        />
        <SelectParamFilter
          paramName="severity"
          label="At least"
          allLabel="Any severity"
          options={SEVERITIES.map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))}
        />
        {canSeeAll && users.length > 0 && (
          <SelectParamFilter
            paramName="userId"
            label="Who"
            allLabel="Everyone"
            options={users.map((u) => ({ value: u.id, label: u.name }))}
          />
        )}
        <SelectParamFilter
          paramName="impersonated"
          label="View-as"
          allLabel="Include all"
          options={[{ value: "1", label: "Only while viewing as someone" }]}
        />
        <label className="flex items-center gap-2 text-sm text-muted">
          From
          <input
            type="date"
            name="from"
            defaultValue={filters.from}
            form="activity-dates"
            className="h-8 rounded-md border border-line-strong bg-surface px-2 text-sm text-text"
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          to
          <input
            type="date"
            name="to"
            defaultValue={filters.to}
            form="activity-dates"
            className="h-8 rounded-md border border-line-strong bg-surface px-2 text-sm text-text"
          />
        </label>
        {/* A plain GET form: the dates land in the query string like every other filter, so the
            view survives a reload and can be sent to somebody else as a link. */}
        <form id="activity-dates" className="contents">
          <button
            type="submit"
            className="h-8 rounded-md border border-line-strong px-3 text-sm font-medium text-muted hover:bg-surface-sunken"
          >
            Apply dates
          </button>
        </form>
      </div>

      <div className="mt-4">
        <ActivityTable rows={result.rows} filters={filters} canExport={canExport} scoped={result.scoped} />
      </div>

      <div className="mt-4">
        <Pagination
          page={page}
          pageSize={pageSize}
          total={result.total}
          totalPages={totalPages(result.total, pageSize)}
          pageSizes={PAGE_SIZES}
          label="events"
        />
      </div>
    </div>
  );
}
