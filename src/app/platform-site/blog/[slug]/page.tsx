import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { JsonLdScript, joinKeywords, jsonLdOf, requestOrigin, seoSiteContext } from "@/components/site/page-view";
import { getPublishedPost } from "@/lib/platform/site-content";
import { inputFromPost } from "@/lib/seo/extract";
import { buildPostMetadata } from "@/lib/seo/metadata";
import { PostArticle, blogContext } from "../post-article";

/**
 * One published post. A draft, an archived post, one scheduled for later, or no post at all: the site's 404.
 * Its structured data is a BlogPosting and its breadcrumb (owner decision S-D1), from what the post shows.
 */

export async function generateMetadata({ params }: PageProps<"/platform-site/blog/[slug]">): Promise<Metadata> {
  return joinKeywords(buildPostMetadata(await getPublishedPost((await params).slug)));
}

export default async function BlogPostPage({ params }: PageProps<"/platform-site/blog/[slug]">) {
  const post = await getPublishedPost((await params).slug);
  if (!post) notFound();
  const [ctx, origin] = await Promise.all([blogContext(), requestOrigin()]);
  return (
    <>
      <JsonLdScript data={jsonLdOf(() => inputFromPost(post, seoSiteContext(ctx, origin), new Date()))} />
      <PostArticle post={post} ctx={ctx} />
    </>
  );
}
