import type { Metadata } from "next";
import { FolderTree } from "lucide-react";
import { EmptyState } from "@/components/console/kit/empty-state";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { CategoriesTable } from "@/components/cms/taxonomy/categories-table";
import { NewTermButton } from "@/components/cms/taxonomy/term-dialog";
import { cmsPage } from "@/lib/cms/guard";
import { getMediaRows } from "@/lib/cms/media";
import { CMS_PAGE_ROLES } from "@/lib/cms/nav";
import { listCategories } from "@/lib/cms/taxonomy";
import { cmsCapsFor } from "@/lib/cms/types";
import { siteOrigin } from "@/lib/platform/site-content";

export const metadata: Metadata = { title: "Categories" };

/**
 * Categories: the blog's curated sections, nested one level — each with its own page on the site
 * (/blog/category/<slug>, once a post in it is live), its description, and search and sharing
 * details. Everybody reads the list (the post editor offers the same tree); editors and admins add,
 * change, reorder and delete. Small enough to load whole.
 */
export default async function CmsCategoriesPage() {
  const session = await cmsPage(CMS_PAGE_ROLES.categories);
  const caps = cmsCapsFor(session.user.role);
  const tree = await listCategories();
  const all = tree.flatMap((top) => [top, ...top.children]);
  const imageIds = [...new Set(all.map((c) => c.seo?.imageMediaId).filter((id): id is string => !!id))];
  const images = imageIds.length ? await getMediaRows(imageIds) : [];
  const parents = tree.map((t) => ({ id: t.id, name: t.name }));
  const subcategories = all.length - tree.length;

  return (
    <>
      <PageHeader
        title="Categories"
        subtitle={
          all.length
            ? `${all.length.toLocaleString("en-IN")} ${all.length === 1 ? "category" : "categories"}${subcategories ? `, ${subcategories.toLocaleString("en-IN")} of them subcategories` : ""}. Each has a page on the blog once a post in it is live.`
            : "The blog's sections. Each has a page on the site once a post in it is live."
        }
        actions={caps.publish ? <NewTermButton kind="category" parents={parents} /> : undefined}
      />
      <Panel padded={tree.length === 0}>
        {tree.length === 0 ? (
          <EmptyState
            icon={<FolderTree className="h-5 w-5" />}
            title="No categories yet"
            body={
              caps.publish
                ? "Add the blog's sections — Product, Guides, Company news. Posts are filed under them, and each gets a page on the site."
                : "Editors and admins add the blog's sections here. Posts are filed under them."
            }
            action={caps.publish ? <NewTermButton kind="category" parents={parents} /> : undefined}
          />
        ) : (
          <CategoriesTable tree={tree} caps={caps} media={Object.fromEntries(images.map((m) => [m.id, m]))} siteOrigin={siteOrigin()} />
        )}
      </Panel>
    </>
  );
}
