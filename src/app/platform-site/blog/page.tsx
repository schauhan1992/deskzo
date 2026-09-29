import type { Metadata } from "next";
import Link from "next/link";
import { fill } from "@/components/site/links";
import { Container, Eyebrow } from "@/components/site/ui";
import { blogCategories } from "@/lib/cms/taxonomy";
import { getPublishedPosts, getSiteSettings } from "@/lib/platform/site-content";
import { buildBlogIndexMetadata } from "@/lib/seo/metadata";
import { ChipNav, Pagination, PostGrid, blogContext, postCount, type Chip } from "./post-article";

/**
 * The blog: published posts, newest first, twelve a page — optionally one tag's (?tag=, ?page=; a
 * tag's own archive is /blog/tag/<slug>). Above the posts, the categories with posts on the site as
 * chips: links to their archives, not a filter held in the page. No categories, no chips.
 *
 * Its title and description are fixed in code (src/lib/seo/metadata.ts), and it carries no structured
 * data: owner decision S-D1 names none for the blog's index.
 */

export async function generateMetadata(): Promise<Metadata> {
  return buildBlogIndexMetadata(await getSiteSettings());
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function BlogPage({ searchParams }: PageProps<"/platform-site/blog">) {
  const query = await searchParams;
  const [ctx, result, categories] = await Promise.all([blogContext(query), getPublishedPosts({ tag: first(query.tag) ?? null, page: Number(first(query.page)) || 1 }), blogCategories()]);
  const pageHref = (page: number) => {
    const params = new URLSearchParams();
    if (result.tag) params.set("tag", result.tag);
    if (page > 1) params.set("page", String(page));
    const qs = params.toString();
    return qs ? `/blog?${qs}` : "/blog";
  };
  const names = new Map(categories.map((c) => [c.slug, c.name]));
  const chips: Chip[] = categories.length
    ? [
        { name: "All posts", href: "/blog", label: "All posts", current: !result.tag },
        ...categories.map((c) => {
          const parent = c.parentSlug ? names.get(c.parentSlug) : undefined;
          return { name: c.name, href: c.path, count: c.count, child: !!parent, label: `${c.name}${parent ? `, in ${parent}` : ""}, ${postCount(c.count)}` };
        }),
      ]
    : [];
  return (
    <>
      <section className="border-b border-line">
        <Container className="py-14 sm:py-20">
          <div className="max-w-3xl">
            <Eyebrow>{fill("{siteName}", ctx)}</Eyebrow>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-text text-balance sm:text-5xl">{result.tag ? `Posts tagged #${result.tag}` : "Blog"}</h1>
            <p className="mt-5 text-base leading-7 text-muted text-pretty sm:text-lg">
              {result.tag ? (
                <Link href="/blog" className="font-medium text-brand hover:underline">
                  See every post
                </Link>
              ) : (
                "News, product updates and notes from the team."
              )}
            </p>
          </div>
        </Container>
      </section>
      <section className="py-12 sm:py-16">
        <Container>
          <ChipNav label="Categories" chips={chips} className="mb-8" />
          {result.posts.length === 0 ? (
            <div className="mx-auto max-w-xl rounded-2xl border border-dashed border-line-strong bg-surface px-6 py-12 text-center">
              <h2 className="text-lg font-semibold text-text">{result.tag ? "No posts with that tag yet" : "No posts yet"}</h2>
              <p className="mt-2 text-sm text-muted">Check back soon.</p>
            </div>
          ) : (
            <PostGrid posts={result.posts} />
          )}
          <Pagination page={result.page} pages={result.pages} href={pageHref} />
        </Container>
      </section>
    </>
  );
}
