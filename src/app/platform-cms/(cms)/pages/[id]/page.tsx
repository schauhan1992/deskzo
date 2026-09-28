import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { editorEnvironment, mediaRowsFor } from "@/components/cms/editor/editor-data";
import { PageEditor } from "@/components/cms/editor/page-editor";
import { getPage } from "@/lib/cms/content";
import { cmsPage } from "@/lib/cms/guard";
import { CMS_PAGE_ROLES } from "@/lib/cms/nav";
import { CmsRefused, cmsCapsFor, type PageDetail } from "@/lib/cms/types";

export const metadata: Metadata = { title: "Edit page" };

/**
 * The page editor. The address's segment is a page id, or "builtin-<slug>" for one of the site's
 * own pages whether it has been saved or not — the editor keeps calling every action with it, so the
 * first save of a built-in page never has to move the address (and lose what is being typed).
 *
 * Everybody may open it; what they may change follows their role (viewers read, authors save
 * drafts, editors and admins publish), and every action checks again.
 */
export default async function CmsPageEditorPage({ params }: PageProps<"/platform-cms/pages/[id]">) {
  const session = await cmsPage(CMS_PAGE_ROLES.pages);
  const caps = cmsCapsFor(session.user.role);
  const ref = String((await params).id ?? "").slice(0, 60);

  let page: PageDetail;
  try {
    page = await getPage(ref);
  } catch (err) {
    if (err instanceof CmsRefused) notFound();
    throw err;
  }

  const [env, media] = await Promise.all([editorEnvironment(), mediaRowsFor({ draft: page.draft, published: page.published })]);

  return <PageEditor key={page.slug} pageRef={ref} page={page} caps={caps} ctx={env.ctx} year={env.year} siteOrigin={env.siteOrigin} sitePaths={env.sitePaths} media={media} />;
}
