import type { Metadata } from "next";
import { Tags } from "lucide-react";
import { EmptyState } from "@/components/console/kit/empty-state";
import { SearchField } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { TagsTable } from "@/components/cms/taxonomy/tags-table";
import { NewTermButton } from "@/components/cms/taxonomy/term-dialog";
import { Pagination } from "@/components/ui/pagination";
import { withParams } from "@/lib/console-shared/params";
import { cmsPage } from "@/lib/cms/guard";
import { getMediaRows } from "@/lib/cms/media";
import { CMS_PAGE_ROLES, CMS_ROUTES } from "@/lib/cms/nav";
import { listTags } from "@/lib/cms/taxonomy";
import { cmsCapsFor } from "@/lib/cms/types";
import { siteOrigin } from "@/lib/platform/site-content";

export const metadata: Metadata = { title: "Tags" };

const PATH = CMS_ROUTES.tags;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined);

/**
 * Tags: every tag on the blog, by name, 50 at a time, with how many posts carry it and how many of
 * those are live — searchable by name or address, in the address bar. Writers add tags as they write
 * posts; here editors and admins rename, merge and delete them. Everybody may read the list.
 */
export default async function CmsTagsPage({ searchParams }: PageProps<"/platform-cms/tags">) {
  const session = await cmsPage(CMS_PAGE_ROLES.tags);
  const caps = cmsCapsFor(session.user.role);
  const sp = await searchParams;
  const q = (one(sp.q) ?? "").trim().slice(0, 100);
  const page = Math.min(1000, Math.max(1, Math.floor(Number(one(sp.page)) || 1)));
  const tags = await listTags({ q: q || undefined, page });
  const imageIds = [...new Set(tags.rows.map((t) => t.seo?.imageMediaId).filter((id): id is string => !!id))];
  const images = imageIds.length ? await getMediaRows(imageIds) : [];
  const totalPages = Math.max(1, Math.ceil(tags.total / tags.pageSize));
  const chips = q ? [{ key: "q", label: `Search: ${q}`, removeHref: withParams(PATH, sp, { q: null }) }] : [];

  return (
    <>
      <PageHeader
        title="Tags"
        subtitle={`${tags.total.toLocaleString("en-IN")} ${tags.total === 1 ? "tag" : "tags"}${q ? " match" : " on the blog"}. Writers add them as they write; each has a page on the site once a post with it is live.`}
        actions={caps.publish ? <NewTermButton kind="tag" /> : undefined}
      />

      <FilterBar trailing={<SearchField label="Search tags by name or address" placeholder="Search tags" />}>
        <span className="text-sm text-muted">{caps.publish ? "Rename, merge and delete from each tag's menu." : "Editors and admins rename, merge and delete tags."}</span>
      </FilterBar>
      <FilterChips chips={chips} clearHref={q ? PATH : undefined} />

      <Panel padded={tags.rows.length === 0}>
        {tags.rows.length === 0 ? (
          q ? (
            <EmptyState variant="filtered" title="No tag matches that" body="Try part of the name, or clear the search." clearHref={PATH} />
          ) : (
            <EmptyState icon={<Tags className="h-5 w-5" />} title="No tags yet" body="Tags are added as posts are written — type one into a post's Tags field." />
          )
        ) : (
          <TagsTable rows={tags.rows} caps={caps} media={Object.fromEntries(images.map((m) => [m.id, m]))} siteOrigin={siteOrigin()} />
        )}
      </Panel>
      {totalPages > 1 && <Pagination page={tags.page} pageSize={tags.pageSize} total={tags.total} totalPages={totalPages} pageSizes={[tags.pageSize]} label="tags" />}
    </>
  );
}
