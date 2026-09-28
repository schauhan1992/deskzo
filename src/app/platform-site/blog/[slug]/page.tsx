import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { safeSrc } from "@/components/site/links";
import { getPublishedPost } from "@/lib/platform/site-content";
import { PostArticle, blogContext } from "../post-article";

/** One published post. A draft, an archived post, one scheduled for later, or no post at all: the site's 404. */

export async function generateMetadata({ params }: PageProps<"/platform-site/blog/[slug]">): Promise<Metadata> {
  const post = await getPublishedPost((await params).slug);
  if (!post) return { title: "Not found", robots: { index: false, follow: false } };
  const title = post.seo?.title || post.title;
  const description = post.seo?.description || post.excerpt || undefined;
  const image = safeSrc(post.seo?.ogImage ?? post.cover?.src);
  return {
    title,
    description,
    alternates: { canonical: post.path },
    openGraph: { type: "article", title, description, url: post.path, publishedTime: post.publishedAt.toISOString(), tags: post.tags, images: image ? [image] : undefined },
    twitter: { card: image ? "summary_large_image" : "summary", title, description },
    robots: post.seo?.noindex ? { index: false, follow: false } : undefined,
  };
}

export default async function BlogPostPage({ params }: PageProps<"/platform-site/blog/[slug]">) {
  const post = await getPublishedPost((await params).slug);
  if (!post) notFound();
  return <PostArticle post={post} ctx={await blogContext()} />;
}
