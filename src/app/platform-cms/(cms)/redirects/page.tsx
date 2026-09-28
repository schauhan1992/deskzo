import type { Metadata } from "next";
import { Signpost } from "lucide-react";
import { EmptyState } from "@/components/console/kit/empty-state";
import { SearchField, SelectFilter, ToggleFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips, ViewTabs } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { StatusPill } from "@/components/console/kit/status";
import { ExportRedirectsButton, ImportRedirectsButton } from "@/components/cms/redirects/redirect-csv";
import { NewRedirectButton } from "@/components/cms/redirects/redirect-dialog";
import { RedirectsTable } from "@/components/cms/redirects/redirects-table";
import { Pagination } from "@/components/ui/pagination";
import { withParams } from "@/lib/console-shared/params";
import { cmsPage } from "@/lib/cms/guard";
import { CMS_PAGE_ROLES, CMS_ROUTES } from "@/lib/cms/nav";
import { listRedirects } from "@/lib/cms/redirects";
import { cmsCapsFor, type RedirectFilters } from "@/lib/cms/types";
import { siteOrigin } from "@/lib/platform/site-content";

export const metadata: Metadata = { title: "Redirects" };

const PATH = CMS_ROUTES.redirects;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined);

const STATES = [
  { key: "all", label: "All" },
  { key: "on", label: "Switched on" },
  { key: "off", label: "Switched off" },
] as const;
const SORTS = [
  { value: "from", label: "Old address, A–Z" },
  { value: "hits", label: "Most used" },
] as const;

/** The address's filters, whitelisted: on or off, made how, going where, which match, only chains, a search, the order. */
function parseFilters(sp: Record<string, string | string[] | undefined>) {
  const stateRaw = one(sp.state);
  const state = stateRaw === "on" || stateRaw === "off" ? stateRaw : "all";
  const kindRaw = one(sp.kind);
  const kind = kindRaw === "auto" || kindRaw === "manual" ? kindRaw : undefined;
  const targetRaw = one(sp.target);
  const target = targetRaw === "site" || targetRaw === "external" ? targetRaw : undefined;
  const matchRaw = one(sp.match);
  const match = matchRaw === "exact" || matchRaw === "prefix" ? matchRaw : undefined;
  const chained = one(sp.chained) === "1";
  const sortRaw = one(sp.sort);
  const sort = sortRaw === "from" || sortRaw === "hits" ? sortRaw : undefined;
  const q = (one(sp.q) ?? "").trim().slice(0, 100);
  const page = Math.min(1000, Math.max(1, Math.floor(Number(one(sp.page)) || 1)));
  const filters: RedirectFilters = {
    q: q || undefined,
    enabled: state === "all" ? undefined : state === "on",
    automatic: kind ? kind === "auto" : undefined,
    external: target ? target === "external" : undefined,
    match: match ? (match === "prefix" ? "PREFIX" : "EXACT") : undefined,
    chained: chained || undefined,
    sort: sort ?? "recent",
    page,
  };
  return { state, kind, target, match, chained, q, filters };
}

/**
 * Redirects (editors and admins): old addresses on the public site sent on to new ones — each with
 * how often it is used and when last, whether a slug change made it, and a flag when a visitor would
 * pass through two or three in a row. Filtered, searched and sorted from the address, 50 at a time;
 * "used N of 5,000" in the header. Add one, import a CSV (with a preview of every row) or export
 * them all. Another site's address is an admin's to choose.
 */
export default async function CmsRedirectsPage({ searchParams }: PageProps<"/platform-cms/redirects">) {
  const session = await cmsPage(CMS_PAGE_ROLES.redirects);
  const caps = cmsCapsFor(session.user.role);
  const sp = await searchParams;
  const f = parseFilters(sp);
  const list = await listRedirects(f.filters);
  const origin = siteOrigin();
  const siteHost = new URL(origin).host;
  const totalPages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const full = list.used >= list.max;
  const nearlyFull = !full && list.used >= list.max * 0.9;

  const chips = [
    ...(f.q ? [{ key: "q", label: `Search: ${f.q}`, removeHref: withParams(PATH, sp, { q: null }) }] : []),
    ...(f.kind ? [{ key: "kind", label: f.kind === "auto" ? "Made automatically" : "Made by hand", removeHref: withParams(PATH, sp, { kind: null }) }] : []),
    ...(f.target ? [{ key: "target", label: f.target === "external" ? "To another site" : "To this site", removeHref: withParams(PATH, sp, { target: null }) }] : []),
    ...(f.match ? [{ key: "match", label: f.match === "prefix" ? "Everything under an address" : "One address", removeHref: withParams(PATH, sp, { match: null }) }] : []),
    ...(f.chained ? [{ key: "chained", label: "Chains only", removeHref: withParams(PATH, sp, { chained: null }) }] : []),
  ];
  const filtered = chips.length > 0 || f.state !== "all";
  const clearHref = withParams(PATH, sp, { q: null, kind: null, target: null, match: null, chained: null, state: null });

  return (
    <>
      <PageHeader
        title="Redirects"
        chips={
          <StatusPill tone={full ? "danger" : nearlyFull ? "warning" : "neutral"} title={`At most ${list.max.toLocaleString("en-IN")} redirects`}>
            {`Used ${list.used.toLocaleString("en-IN")} of ${list.max.toLocaleString("en-IN")}`}
          </StatusPill>
        }
        subtitle={`Old addresses on ${siteHost} sent on to new ones. A page's or post's new address adds one automatically.`}
        actions={
          <>
            <ImportRedirectsButton />
            <ExportRedirectsButton />
            <NewRedirectButton admin={caps.admin} siteHost={siteHost} used={list.used} />
          </>
        }
      />

      <FilterBar trailing={<SearchField label="Search redirects by address or note" placeholder="Search address or note" />}>
        <ViewTabs label="Switched on or off" items={STATES.map((s) => ({ key: s.key, label: s.label, href: withParams(PATH, sp, { state: s.key === "all" ? null : s.key }), active: f.state === s.key }))} />
        <SelectFilter
          param="kind"
          label="Made"
          allLabel="Any way"
          options={[
            { value: "auto", label: "Automatically" },
            { value: "manual", label: "By hand" },
          ]}
        />
        <SelectFilter
          param="target"
          label="Goes to"
          allLabel="Anywhere"
          options={[
            { value: "site", label: "This site" },
            { value: "external", label: "Another site" },
          ]}
        />
        <SelectFilter
          param="match"
          label="Match"
          allLabel="Any"
          options={[
            { value: "exact", label: "One address" },
            { value: "prefix", label: "Everything under it" },
          ]}
        />
        <ToggleFilter param="chained" label="Chains only" />
        <SelectFilter param="sort" label="Order" allLabel="Last changed" options={SORTS.map((s) => ({ value: s.value, label: s.label }))} />
      </FilterBar>
      <FilterChips chips={chips} clearHref={filtered ? clearHref : undefined} />

      <Panel padded={list.rows.length === 0}>
        {list.rows.length === 0 ? (
          filtered ? (
            <EmptyState variant="filtered" title="No redirect matches" body="Try another search or filter." clearHref={clearHref} />
          ) : (
            <EmptyState
              icon={<Signpost className="h-5 w-5" />}
              title="No redirects yet"
              body="When a page or post that is on the site gets a new address, a redirect from the old one appears here by itself. Add your own for old links, campaigns or a previous site."
              action={<NewRedirectButton admin={caps.admin} siteHost={siteHost} used={list.used} />}
            />
          )
        ) : (
          <RedirectsTable rows={list.rows} admin={caps.admin} siteOrigin={origin} used={list.used} />
        )}
      </Panel>
      {totalPages > 1 && <Pagination page={list.page} pageSize={list.pageSize} total={list.total} totalPages={totalPages} pageSizes={[list.pageSize]} label="redirects" />}
    </>
  );
}
