import type { Metadata } from "next";
import { ArrowUpRight, FileText, Lock } from "lucide-react";
import { EmptyState } from "@/components/console/kit/empty-state";
import { SearchField } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips, ViewTabs } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { DataTable, RowActionsCell, RowLink, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { PageStatusPill } from "@/components/cms/common/status";
import { NewItemButton } from "@/components/cms/shell/new-menu";
import { OutboundLink } from "@/components/ui/outbound-link";
import { withParams } from "@/lib/console-shared/params";
import { listPages } from "@/lib/cms/content";
import { cmsPage } from "@/lib/cms/guard";
import { CMS_PAGE_ROLES, CMS_ROUTES } from "@/lib/cms/nav";
import { cmsCapsFor, type PageListRow } from "@/lib/cms/types";
import { consoleClock } from "@/lib/platform/console-clock";
import { siteOrigin } from "@/lib/platform/site-content";

export const metadata: Metadata = { title: "Pages" };

const PATH = CMS_ROUTES.pages;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined);

type View = "all" | "published" | "changed" | "drafts" | "default" | "archived";
const VIEWS: { key: View; label: string }[] = [
  { key: "all", label: "All" },
  { key: "published", label: "Published" },
  { key: "changed", label: "Changed since publish" },
  { key: "drafts", label: "Drafts" },
  { key: "default", label: "Default content" },
  { key: "archived", label: "Archived" },
];

function inView(row: PageListRow, view: View): boolean {
  switch (view) {
    case "published":
      return row.status === "PUBLISHED";
    case "changed":
      return row.status === "PUBLISHED" && row.changed;
    case "drafts":
      return row.status === "DRAFT";
    case "default":
      return row.status === "DEFAULT";
    default:
      return true;
  }
}

const EMPTY: Record<View, { title: string; body: string }> = {
  all: { title: "No pages", body: "" },
  published: { title: "Nothing is published from the CMS yet", body: "The site shows its built-in pages until one is published here." },
  changed: { title: "No page has unpublished changes", body: "Every published page shows its latest draft." },
  drafts: { title: "No drafts", body: "Pages that have never been published appear here." },
  default: { title: "Every built-in page has been saved", body: "Pages on their built-in content appear here." },
  archived: { title: "Nothing archived", body: "Archived pages are off the site and wait here to be restored or deleted." },
};

/**
 * Pages: the site's own pages (always there, on their built-in content until someone saves them)
 * and the pages the CMS added — with their state, when they last changed and who changed them, when
 * they were published, a search, and views by state. Writers get "New page".
 */
export default async function CmsPagesPage({ searchParams }: PageProps<"/platform-cms/pages">) {
  const session = await cmsPage(CMS_PAGE_ROLES.pages);
  const caps = cmsCapsFor(session.user.role);
  const sp = await searchParams;
  const q = (one(sp.q) ?? "").trim().slice(0, 100);
  const viewRaw = one(sp.view);
  const view: View = VIEWS.some((v) => v.key === viewRaw) ? (viewRaw as View) : "all";

  const [current, archived, clock] = await Promise.all([listPages({ q: q || undefined }), listPages({ q: q || undefined, archived: true }), consoleClock()]);
  const rows = view === "archived" ? archived : current.filter((r) => inView(r, view));
  const counts: Record<View, number> = {
    all: current.length,
    published: current.filter((r) => inView(r, "published")).length,
    changed: current.filter((r) => inView(r, "changed")).length,
    drafts: current.filter((r) => inView(r, "drafts")).length,
    default: current.filter((r) => inView(r, "default")).length,
    archived: archived.length,
  };
  const origin = siteOrigin();
  const siteHost = new URL(origin).host;
  const builtins = rows.filter((r) => r.builtin);
  const added = rows.filter((r) => !r.builtin);

  const table = (list: PageListRow[], caption: string) => (
    <DataTable caption={caption} minWidth={760}>
      <THead>
        <Th>Page</Th>
        <Th>State</Th>
        <Th>Last changed</Th>
        <Th>Published</Th>
        <Th srOnly>View on the site</Th>
      </THead>
      <TBody>
        {list.map((row) => (
          <Tr key={row.id} interactive>
            <Td>
              <div className="flex items-center gap-1.5">
                <RowLink href={CMS_ROUTES.page(row.id)}>{row.title || "Untitled page"}</RowLink>
                {row.builtin && <Lock aria-label="One of the site's own pages" className="h-3 w-3 shrink-0 text-subtle" />}
              </div>
              <p className="mt-0.5 font-mono text-xs text-muted">{row.path}</p>
            </Td>
            <Td>
              <PageStatusPill status={row.status} changed={row.changed} archived={row.archived} />
            </Td>
            <Td muted nowrap>
              {row.updatedAt ? (
                <>
                  <RelativeTime at={row.updatedAt} />
                  {row.updatedBy && <span className="block text-xs text-subtle">{row.updatedBy}</span>}
                </>
              ) : (
                <span className="text-subtle">Never edited</span>
              )}
            </Td>
            <Td muted nowrap>
              {row.publishedAt ? <time dateTime={row.publishedAt.toISOString()} title={clock.dateTime(row.publishedAt)}>{clock.date(row.publishedAt)}</time> : "—"}
            </Td>
            <RowActionsCell>
              {(row.status === "PUBLISHED" || row.status === "DEFAULT") && !row.archived && (
                <OutboundLink href={`${origin}${row.path}`} className="inline-flex items-center gap-0.5 rounded-base px-1.5 py-1 text-xs font-medium text-muted hover:text-brand">
                  View
                  <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
                  <span className="sr-only"> {row.path} on the site (opens in a new tab)</span>
                </OutboundLink>
              )}
            </RowActionsCell>
          </Tr>
        ))}
      </TBody>
    </DataTable>
  );

  return (
    <>
      <PageHeader
        title="Pages"
        subtitle={`${counts.published} published · ${counts.drafts} ${counts.drafts === 1 ? "draft" : "drafts"} · ${counts.default} on built-in content${counts.changed ? ` · ${counts.changed} with unpublished changes` : ""}`}
        actions={caps.write ? <NewItemButton kind="page" siteHost={siteHost} /> : undefined}
      />

      <FilterBar trailing={<SearchField label="Search pages by title or address" placeholder="Search by title or address" />}>
        <ViewTabs label="Page state" items={VIEWS.map((v) => ({ key: v.key, label: v.label, href: withParams(PATH, sp, { view: v.key === "all" ? null : v.key }), active: view === v.key, count: counts[v.key] }))} />
      </FilterBar>
      <FilterChips chips={q ? [{ key: "q", label: `Search: ${q}`, removeHref: withParams(PATH, sp, { q: null }) }] : []} clearHref={q ? withParams(PATH, sp, { q: null }) : undefined} />

      {rows.length === 0 ? (
        <Panel padded={false}>
          {q ? (
            <EmptyState variant="filtered" title={`No page matches “${q}”`} body="Search by another part of the title or the address." clearHref={withParams(PATH, sp, { q: null })} />
          ) : (
            <EmptyState icon={<FileText className="h-5 w-5" />} title={EMPTY[view].title} body={EMPTY[view].body} />
          )}
        </Panel>
      ) : (
        <div className="space-y-6">
          {builtins.length > 0 && (
            <Panel padded={false} title="The site's own pages" description="Always on the site: their built-in content until published from here. They can be edited and reset, never unpublished or deleted.">
              {table(builtins, "The site's own pages")}
            </Panel>
          )}
          {(added.length > 0 || view === "all") && (
            <Panel padded={false} title={view === "archived" ? "Archived pages" : "Added pages"} description={view === "archived" ? undefined : "Pages made in the CMS, most recently changed first."}>
              {added.length > 0 ? (
                table(added, view === "archived" ? "Archived pages" : "Added pages")
              ) : (
                <EmptyState
                  icon={<FileText className="h-5 w-5" />}
                  title="No pages added yet"
                  body="Add a page for anything the built-in ones don't cover — an about page, a solution, a campaign."
                  action={caps.write ? <NewItemButton kind="page" siteHost={siteHost} /> : undefined}
                />
              )}
            </Panel>
          )}
        </div>
      )}
    </>
  );
}
