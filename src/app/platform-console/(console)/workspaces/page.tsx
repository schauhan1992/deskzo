import type { Metadata } from "next";
import Link from "next/link";
import { Building2, CircleCheck, Ticket } from "lucide-react";
import { consoleExportWorkspaces } from "@/actions/platform/console-directory";
import { Banner } from "@/components/console/kit/banner";
import { EmptyState } from "@/components/console/kit/empty-state";
import { ExportCsvButton } from "@/components/console/kit/export-button";
import { DateRangeFilter, SearchField, SelectFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips, ViewTabs } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { ClosedTable } from "@/components/console/workspaces/closed-table";
import { DirectoryTable } from "@/components/console/workspaces/directory-table";
import { Pagination } from "@/components/ui/pagination";
import { plural } from "@/lib/console-shared/format";
import { DIRECTORY_GATEWAY_LABELS, DIRECTORY_SORT_LABELS, DIRECTORY_VIEW_LABELS, TENANT_STATUS } from "@/lib/console-shared/labels";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import {
  DIRECTORY_GATEWAYS,
  DIRECTORY_PAGE_SIZES,
  DIRECTORY_SORTS,
  DIRECTORY_VIEWS,
  directoryChips,
  exportParams,
  parseDirectoryFilters,
  withParams,
  type DirectorySort,
  type DirectoryView,
} from "@/lib/console-shared/params";
import { capsFor } from "@/lib/console-shared/roles";
import { consoleStaff } from "@/lib/platform/console-page";
import { closedWorkspaces, directoryFacets, workspaceDirectory } from "@/lib/platform/workspace-directory";

export const metadata: Metadata = { title: "Workspaces" };

const PATH = "/workspaces";
const INTEGER = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/** A preset with nothing in it says so in its own words, rather than the generic "no match". */
const EMPTY_VIEW: Record<Exclude<DirectoryView, "all" | "closed">, { title: string; body: string }> = {
  attention: { title: "Nothing needs attention.", body: "No workspace is held, behind on its schema, past due or stuck in setup." },
  trials: { title: "No trials running.", body: "Workspaces on a trial are listed here with the days they have left." },
  "past-due": { title: "Nobody is past due.", body: "Workspaces behind on a payment, or whose trial has run out, are listed here." },
  held: { title: "No workspace is held.", body: "A workspace held for billing or by staff is listed here until it is reopened." },
  "setting-up": { title: "Nothing is being set up.", body: "New workspaces appear here while their database is being prepared." },
  behind: { title: "Every workspace is on the latest schema.", body: "A workspace a migration has not reached yet is listed here." },
};

/**
 * The workspace directory (spec §3.3): every customer workspace, its health in one row, and the
 * queues an operator works through as view presets. Filters live in the URL, so every list can be
 * shared or reloaded; the table, its row menus and the bulk bar are one client component fed plain
 * rows. Closed workspaces are a view of their own with different columns and no filters.
 */
export default async function ConsoleWorkspacesPage({ searchParams }: PageProps<"/platform-console/workspaces">) {
  const staff = await consoleStaff(PAGE_ROLES.workspaces);
  const caps = capsFor(staff.role);
  const sp = await searchParams;
  const f = parseDirectoryFilters(sp);
  const closedView = f.view === "closed";
  const [facets, directory, closed] = await Promise.all([
    directoryFacets(),
    closedView ? null : workspaceDirectory(f),
    closedView ? closedWorkspaces() : null,
  ]);

  const openCount = facets.views.all;
  const chips = closedView ? [] : directoryChips(f);
  const planName = new Map(facets.plans.map((p) => [p.key, p.name]));
  const filtered = chips.length > 0;
  // "Clear filters" keeps the view and the sort — those are where you are, not what you narrowed.
  const clearHref = withParams(PATH, {}, { view: f.view === "all" ? null : f.view, sort: f.sort === "-created" ? null : f.sort });
  const exported = exportParams(sp);

  const sortTo = (sort: DirectorySort) => withParams(PATH, sp, { sort: sort === "-created" ? null : sort });
  const sortHrefs: Record<string, string> = {
    name: sortTo(f.sort === "name" ? "-created" : "name"),
    standing: sortTo(f.sort === "standing" ? "-created" : "standing"),
    seats: sortTo(f.sort === "-seats" ? "-created" : "-seats"),
    created: sortTo(f.sort === "-created" ? "created" : "-created"),
  };

  const newInvite = withParams("/invites", {}, { new: 1, note: f.q });
  const newInviteLink = (
    <Link
      href={newInvite}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-base bg-brand px-3 text-[13px] font-medium whitespace-nowrap text-brand-contrast shadow-sm hover:brightness-110"
    >
      <Ticket aria-hidden="true" className="h-4 w-4" />
      New invitation
    </Link>
  );

  const countries = facets.countries.length;
  const subtitle = `${plural(openCount, "open workspace")}${countries ? ` in ${plural(countries, "country", "countries")}` : ""} · ${INTEGER.format(facets.views.closed)} closed`;

  return (
    <>
      <PageHeader
        title={`Workspaces · ${INTEGER.format(openCount)}`}
        subtitle={subtitle}
        asOf={directory?.asOf ?? facets.asOf}
        actions={
          <>
            {caps.exportWorkspaces && <ExportCsvButton action={consoleExportWorkspaces.bind(null, exported)} />}
            {caps.manage && newInviteLink}
          </>
        }
      />

      <div className="mb-4">
        <ViewTabs
          label="Workspace views"
          items={DIRECTORY_VIEWS.map((view) => ({
            key: view,
            label: DIRECTORY_VIEW_LABELS[view],
            // Closed has its own columns and no filters; the other presets keep what is filtered.
            href: view === "closed" ? withParams(PATH, {}, { view }) : withParams(PATH, closedView ? {} : sp, { view: view === "all" ? null : view }),
            active: f.view === view,
            count: facets.views[view],
          }))}
        />
      </div>

      {closedView && closed ? (
        <ClosedTable rows={closed} />
      ) : (
        <>
          <FilterBar
            trailing={
              <SelectFilter
                param="sort"
                label="Sort"
                allLabel={DIRECTORY_SORT_LABELS["-created"]}
                options={DIRECTORY_SORTS.filter((s) => s !== "-created").map((s) => ({ value: s, label: DIRECTORY_SORT_LABELS[s] }))}
              />
            }
          >
            <SearchField label="Search workspaces" placeholder="Name, address, owner or billing email, customer id" />
            <SelectFilter
              param="status"
              label="Status"
              options={(["ACTIVE", "PROVISIONING", "SUSPENDED", "MIGRATING"] as const).map((s) => ({ value: s, label: TENANT_STATUS[s].label }))}
            />
            {facets.plans.length > 0 && <SelectFilter param="plan" label="Plan" options={facets.plans.map((p) => ({ value: p.key, label: p.name }))} />}
            <SelectFilter param="gateway" label="Pays" allLabel="Any" options={DIRECTORY_GATEWAYS.map((g) => ({ value: g, label: DIRECTORY_GATEWAY_LABELS[g] }))} />
            {facets.countries.length > 0 && (
              <SelectFilter
                param="country"
                label="Country"
                options={facets.countries.map((c) => ({ value: c.country, label: `${c.country} (${INTEGER.format(c.n)})` }))}
              />
            )}
            <SelectFilter
              param="schema"
              label="Schema"
              allLabel="Any"
              options={[
                { value: "behind", label: "Behind" },
                { value: "current", label: "Up to date" },
              ]}
            />
            <SelectFilter param="grant" label="Support access" allLabel="Any" options={[{ value: "live", label: "Granted now" }]} />
            {(f.view === "held" || f.status === "SUSPENDED" || f.heldFor) && (
              <SelectFilter
                param="heldFor"
                label="Held"
                allLabel="Either"
                options={[
                  { value: "BILLING", label: "For billing" },
                  { value: "STAFF", label: "By staff" },
                ]}
              />
            )}
            {facets.tags.length > 0 && (
              <SelectFilter param="tag" label="Tag" allLabel="Any" options={facets.tags.map((t) => ({ value: t.tag, label: `${t.tag} (${INTEGER.format(t.n)})` }))} />
            )}
            <DateRangeFilter label="Created" />
          </FilterBar>

          <FilterChips
            chips={chips.map((chip) => ({
              key: chip.key,
              label: chip.key === "plan" && f.plan ? `Plan: ${planName.get(f.plan) ?? f.plan}` : chip.label,
              removeHref: withParams(PATH, sp, { [chip.key]: null }),
            }))}
            clearHref={clearHref}
          />

          {directory?.capped && (
            <Banner tone="warning" title="Showing the first 10,000 matches — narrow the filters." className="mb-4">
              The counts and sorting on this page cover the newest 10,000 workspaces that match.
            </Banner>
          )}

          {directory && directory.rows.length > 0 ? (
            <>
              <DirectoryTable rows={directory.rows} caps={caps} asOf={directory.asOf} sortHrefs={sortHrefs} sort={f.sort} exportParams={exported} />
              <Pagination
                page={directory.page}
                pageSize={directory.pageSize}
                total={directory.total}
                totalPages={Math.max(1, Math.ceil(directory.total / directory.pageSize))}
                pageSizes={DIRECTORY_PAGE_SIZES}
                label={directory.total === 1 ? "workspace" : "workspaces"}
              />
            </>
          ) : (
            <Panel padded={false}>
              {filtered ? (
                <EmptyState variant="filtered" title="No workspace matches these filters." body="Try fewer filters, or search by another detail." clearHref={clearHref} />
              ) : f.view !== "all" && f.view !== "closed" ? (
                <EmptyState
                  icon={<CircleCheck className="h-5 w-5" />}
                  title={EMPTY_VIEW[f.view].title}
                  body={EMPTY_VIEW[f.view].body}
                  action={
                    <Link href={PATH} className="text-[13px] font-medium text-brand hover:underline">
                      Show all workspaces
                    </Link>
                  }
                />
              ) : (
                <EmptyState
                  icon={<Building2 className="h-5 w-5" />}
                  title="No workspaces yet."
                  body="Invite the first customer — their workspace is set up when they sign up with the invitation."
                  action={caps.manage ? newInviteLink : undefined}
                />
              )}
            </Panel>
          )}
        </>
      )}
    </>
  );
}
