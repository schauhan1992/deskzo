import type { Metadata } from "next";
import { ArrowUpRight, LifeBuoy } from "lucide-react";
import { EmptyState } from "@/components/console/kit/empty-state";
import { FilterBar, ViewTabs } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, RowLink, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { PageStatusPill } from "@/components/cms/common/status";
import { StartGuideButton } from "@/components/cms/guides/start-guide-button";
import { OutboundLink } from "@/components/ui/outbound-link";
import { withParams } from "@/lib/console-shared/params";
import { cmsPage } from "@/lib/cms/guard";
import { GUIDE_OUTLINE, listGuidePages, type GuideListRow } from "@/lib/cms/guides";
import { CMS_PAGE_ROLES, CMS_ROUTES } from "@/lib/cms/nav";
import { cmsCapsFor } from "@/lib/cms/types";
import { siteOrigin } from "@/lib/platform/site-content";

export const metadata: Metadata = { title: "Help guides" };

const PATH = CMS_ROUTES.helpGuides;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined);

type View = "all" | "review" | "published" | "missing";
const VIEWS: { key: View; label: string }[] = [
  { key: "all", label: "All modules" },
  { key: "review", label: "To review" },
  { key: "published", label: "Published" },
  { key: "missing", label: "No guide" },
];

function inView(row: GuideListRow, view: View): boolean {
  switch (view) {
    case "review":
      return !!row.page && (row.page.status !== "PUBLISHED" || row.page.changed);
    case "published":
      return row.page?.status === "PUBLISHED";
    case "missing":
      return !row.page;
    default:
      return true;
  }
}

/**
 * Help guides: every module in the app with its Help Center guide (src/lib/help/guides.ts) — none yet,
 * a draft to review, published, or published with changes waiting — in the menu's order. A guide is a
 * page under help/, so it opens in the Pages editor; writers can start one for a module that has none.
 */
export default async function CmsHelpGuidesPage({ searchParams }: PageProps<"/platform-cms/help-guides">) {
  const session = await cmsPage(CMS_PAGE_ROLES.helpGuides);
  const caps = cmsCapsFor(session.user.role);
  const sp = await searchParams;
  const viewRaw = one(sp.view);
  const view: View = VIEWS.some((v) => v.key === viewRaw) ? (viewRaw as View) : "all";
  const all = await listGuidePages();
  const rows = all.filter((r) => inView(r, view));
  const counts: Record<View, number> = { all: all.length, review: 0, published: 0, missing: 0 };
  for (const r of all) for (const v of ["review", "published", "missing"] as const) if (inView(r, v)) counts[v] += 1;
  const origin = siteOrigin();

  return (
    <>
      <PageHeader
        title="Help guides"
        subtitle={`${counts.published} of ${all.length} modules published · ${counts.review} to review · ${counts.missing} with no guide`}
        actions={
          <OutboundLink href={`${origin}/help`} className="inline-flex items-center gap-1 rounded-base px-2 py-1.5 text-sm font-medium text-muted hover:text-brand">
            The Help Center
            <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
            <span className="sr-only"> (opens in a new tab)</span>
          </OutboundLink>
        }
      />
      <p className="mb-4 max-w-3xl text-sm text-muted">
        One guide per module, each a page under help/ with the Module guide block. Every guide has the same sections: {GUIDE_OUTLINE.join(" · ")} — the last read from the product list. Publishing checks
        that the module, its permissions and any product it names exist. The app&apos;s Help panel opens a module&apos;s guide from its pages once it is published.
      </p>

      <FilterBar>
        <ViewTabs label="Guide state" items={VIEWS.map((v) => ({ key: v.key, label: v.label, href: withParams(PATH, sp, { view: v.key === "all" ? null : v.key }), active: view === v.key, count: counts[v.key] }))} />
      </FilterBar>

      {rows.length === 0 ? (
        <Panel padded={false}>
          <EmptyState icon={<LifeBuoy className="h-5 w-5" />} title="Nothing here" body={view === "missing" ? "Every module has a guide." : view === "review" ? "Every guide is published as it stands." : "No guide is published yet."} />
        </Panel>
      ) : (
        <Panel padded={false}>
          <DataTable caption="Modules and their guides" minWidth={820}>
            <THead>
              <Th>Module</Th>
              <Th>Guide</Th>
              <Th>State</Th>
              <Th>Last changed</Th>
              <Th srOnly>Actions</Th>
            </THead>
            <TBody>
              {rows.map((row) => (
                <Tr key={row.module} interactive={!!row.page}>
                  <Td>
                    <p className="font-medium text-text">{row.label}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {row.navGroup} · <span className="font-mono">{row.module}</span>
                    </p>
                  </Td>
                  <Td>
                    {row.page ? (
                      <>
                        <RowLink href={CMS_ROUTES.page(row.page.id)}>{row.page.title || "Untitled guide"}</RowLink>
                        <p className="mt-0.5 font-mono text-xs text-muted">{row.page.path}</p>
                        {row.others.length > 0 && (
                          <p className="mt-1 text-xs text-warning">
                            Also at {row.others.map((o) => o.path).join(", ")} — keep one.
                          </p>
                        )}
                      </>
                    ) : (
                      <span className="text-sm text-subtle">No guide yet</span>
                    )}
                  </Td>
                  <Td>{row.page ? <PageStatusPill status={row.page.status} changed={row.page.changed} /> : <StatusPill tone="neutral">Missing</StatusPill>}</Td>
                  <Td muted nowrap>
                    {row.page ? (
                      <>
                        <RelativeTime at={row.page.updatedAt} />
                        <span className="block text-xs text-subtle">{row.page.updatedBy}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <RowActionsCell>
                    {row.page?.status === "PUBLISHED" ? (
                      <OutboundLink href={`${origin}${row.page.path}`} className="inline-flex items-center gap-0.5 rounded-base px-1.5 py-1 text-xs font-medium text-muted hover:text-brand">
                        View
                        <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
                        <span className="sr-only"> {row.page.path} on the site (opens in a new tab)</span>
                      </OutboundLink>
                    ) : !row.page && caps.write ? (
                      <StartGuideButton moduleKey={row.module} label={row.label} />
                    ) : null}
                  </RowActionsCell>
                </Tr>
              ))}
            </TBody>
          </DataTable>
        </Panel>
      )}
    </>
  );
}
