import type { Metadata } from "next";
import Link from "next/link";
import { History } from "lucide-react";
import { consoleExportAudit } from "@/actions/platform/console-admin";
import { AuditLogTable } from "@/components/console/audit/audit-table";
import { EmptyState } from "@/components/console/kit/empty-state";
import { ExportCsvButton } from "@/components/console/kit/export-button";
import { DateRangeFilter, SearchField, SelectFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { CursorPager } from "@/components/console/kit/pager";
import { Panel } from "@/components/console/kit/panel";
import { PersonParamFilter } from "@/components/ui/person-param-filter";
import { dayKeyLabel, plural } from "@/lib/console-shared/format";
import { AUDIT_CATEGORIES, auditLabel } from "@/lib/console-shared/labels";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { exportParams, parseAuditFilters, withParams, type AuditFilters, type RawParams } from "@/lib/console-shared/params";
import { capsFor } from "@/lib/console-shared/roles";
import { auditFacets, auditQuery } from "@/lib/platform/audit-query";
import { consoleStaff } from "@/lib/platform/console-page";

export const metadata: Metadata = { title: "Audit log" };

const PATH = "/audit";
const PAGING = ["page", "cursor"];
const INTEGER = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

const ACTOR_KINDS: { value: NonNullable<AuditFilters["actorKind"]>; label: string }[] = [
  { value: "STAFF", label: "Staff" },
  { value: "SCRIPT", label: "Scripts" },
  { value: "SYSTEM", label: "The platform" },
];

/**
 * The platform's audit trail (spec §3.17): everything staff did from the console, what scripts did on
 * the server and what the platform did by itself — newest first, grouped by Indian day, 50 a page.
 *
 * Every filter is in the URL, so an investigation can be shared as a link. The search box also finds
 * staff by name or email (the log keeps their ids; the loader turns the name into ids first). Paging
 * is by cursor: the log keeps growing above the page being read, and a page never repeats or skips a
 * row because of it. Export writes the whole filtered log, not the page — for managers only, since
 * the details hold email addresses.
 */
export default async function ConsoleAuditPage({ searchParams }: PageProps<"/platform-console/audit">) {
  // First, before the query is touched: signed out, the page ends here with a redirect to /login.
  const staff = await consoleStaff(PAGE_ROLES.audit);
  const caps = capsFor(staff.role);
  const sp: RawParams = (await searchParams) ?? {};
  const f = parseAuditFilters(sp);
  const [log, facets] = await Promise.all([auditQuery(f), auditFacets()]);

  const chips = filterChips(f, sp, facets.staff);
  const filtered = chips.length > 0;
  const first = withParams(PATH, sp, { cursor: null });
  const newerHref = log.newerCursor !== null ? withParams(PATH, sp, { cursor: log.newerCursor || null }) : null;
  const olderHref = log.nextCursor ? withParams(PATH, sp, { cursor: log.nextCursor }) : null;

  // The actions the log holds, by what they read as — with how often each happened.
  const actionOptions = facets.actions
    .map((a) => ({ value: a.action, label: `${auditLabel(a.action, null).title} · ${INTEGER.format(a.n)}` }))
    .sort((a, b) => a.label.localeCompare(b.label, "en-IN"));

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="What staff, scripts on the server and the platform itself did — newest first, in India time."
        actions={caps.exportAudit ? <ExportCsvButton action={consoleExportAudit.bind(null, exportParams(sp))} /> : undefined}
      />

      <FilterBar>
        <SearchField label="Search the audit log" placeholder="Action, workspace, or a staff member's name" />
        <SelectFilter param="category" label="Category" options={AUDIT_CATEGORIES.map((c) => ({ value: c.key, label: c.label }))} />
        {actionOptions.length > 0 && <SelectFilter param="action" label="Action" allLabel="Any" options={actionOptions} />}
        <SelectFilter param="kind" label="Done by" allLabel="Anyone" options={ACTOR_KINDS} />
        {facets.staff.length > 0 && (
          // Typed rather than scrolled: every staff member who ever was, switched-off ones included — old entries name them.
          <PersonParamFilter paramName="staff" people={facets.staff} label="Staff member" placeholder="Any staff member" resetParams={PAGING} />
        )}
        <SearchField param="tenant" label="Workspace address" placeholder="Workspace address" className="sm:w-48" />
        <DateRangeFilter label="Date" />
      </FilterBar>
      <FilterChips chips={chips} clearHref={filtered ? PATH : undefined} />

      {log.rows.length > 0 ? (
        <>
          <Panel padded={false}>
            <AuditLogTable rows={log.rows} todayKey={log.todayKey} />
          </Panel>
          <CursorPager newerHref={newerHref} olderHref={olderHref} summary={`Showing ${plural(log.rows.length, "entry", "entries")}`} />
        </>
      ) : (
        <Panel padded={false}>
          {f.cursor ? (
            <EmptyState
              icon={<History className="h-5 w-5" />}
              title="No older entries."
              body="This is as far back as the log goes for these filters."
              action={
                <Link href={first} className="text-[13px] font-medium text-brand hover:underline">
                  Back to the newest
                </Link>
              }
            />
          ) : filtered ? (
            <EmptyState
              variant="filtered"
              title="No audit entries match."
              body="Try a wider date range or another category, or search for part of a name or an address."
              clearHref={PATH}
            />
          ) : (
            <EmptyState title="Nothing recorded yet." body="Every change made from the console, by a script on the server or by the platform itself is written here." />
          )}
        </Panel>
      )}
    </>
  );
}

/** What the log is narrowed by, in words — each removable on its own (which also goes back to the newest page). */
function filterChips(f: AuditFilters, sp: RawParams, staff: { id: string; name: string }[]): { key: string; label: string; removeHref: string }[] {
  const chip = (key: string, label: string, remove: Record<string, null> = { [key]: null }) => ({ key, label, removeHref: withParams(PATH, sp, remove) });
  const chips: { key: string; label: string; removeHref: string }[] = [];
  if (f.q) chips.push(chip("q", `Search: ${f.q}`));
  if (f.who) chips.push(chip("who", `Name or email: ${f.who}`));
  if (f.category) chips.push(chip("category", `Category: ${AUDIT_CATEGORIES.find((c) => c.key === f.category)?.label ?? f.category}`));
  if (f.action) chips.push(chip("action", `Action: ${auditLabel(f.action, null).title}`));
  if (f.actorKind) chips.push(chip("kind", `Done by: ${ACTOR_KINDS.find((k) => k.value === f.actorKind)?.label ?? f.actorKind}`));
  if (f.staff) chips.push(chip("staff", `Staff member: ${staff.find((s) => s.id === f.staff)?.name ?? "a former staff member"}`));
  if (f.tenant) chips.push(chip("tenant", `Workspace: ${f.tenant}`));
  if (f.from || f.to) {
    const label = f.from && f.to ? `${dayKeyLabel(f.from)} – ${dayKeyLabel(f.to)}` : f.from ? `From ${dayKeyLabel(f.from)}` : `Until ${dayKeyLabel(f.to ?? "")}`;
    chips.push(chip("dates", label, { from: null, to: null }));
  }
  return chips;
}
