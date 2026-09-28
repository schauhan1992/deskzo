import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { editorEnvironment, mediaRowsFor } from "@/components/cms/editor/editor-data";
import { PostEditor } from "@/components/cms/editor/post-editor";
import { getPost, listPostTags } from "@/lib/cms/content";
import { cmsPage } from "@/lib/cms/guard";
import { CMS_PAGE_ROLES } from "@/lib/cms/nav";
import { CmsRefused, cmsCapsFor, type PostDetail } from "@/lib/cms/types";

export const metadata: Metadata = { title: "Edit post" };

/**
 * The post editor. Everybody may open a post; who may change it follows the role and, for authors,
 * whose post it is and whether it is still a draft (src/lib/cms/content.ts) — the editor shows the
 * controls that apply, and every action checks again.
 */
export default async function CmsPostEditorPage({ params }: PageProps<"/platform-cms/posts/[id]">) {
  const session = await cmsPage(CMS_PAGE_ROLES.posts);
  const caps = cmsCapsFor(session.user.role);
  const id = String((await params).id ?? "").slice(0, 40);

  let post: PostDetail;
  try {
    post = await getPost(id);
  } catch (err) {
    if (err instanceof CmsRefused) notFound();
    throw err;
  }

  const [env, media, tags] = await Promise.all([editorEnvironment(), mediaRowsFor({ body: post.body, seo: post.seo }, [post.coverMediaId]), listPostTags()]);

  return (
    <PostEditor
      key={post.id}
      post={post}
      caps={caps}
      me={{ id: session.user.id, name: session.user.name, email: session.user.email, role: session.user.role }}
      ctx={env.ctx}
      year={env.year}
      siteOrigin={env.siteOrigin}
      sitePaths={env.sitePaths}
      media={media}
      allTags={tags}
    />
  );
}
