import type { Metadata } from "next";
import Link from "next/link";
import { fill } from "@/components/site/links";
import { Container, Eyebrow, buttonClasses } from "@/components/site/ui";
import { getPublishedPosts, getSiteSettings } from "@/lib/platform/site-content";
import { PostCard, blogContext } from "./post-article";

/** The blog: published posts, newest first, twelve a page — optionally one tag's (?tag=, ?page=). */

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSiteSettings();
  return {
    title: "Blog",
    description: `News, product updates and notes from ${settings.siteName}.`,
    alternates: { canonical: "/blog" },
    openGraph: { type: "website", title: "Blog", url: "/blog" },
  };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function BlogPage({ searchParams }: PageProps<"/platform-site/blog">) {
  const query = await searchParams;
  const [ctx, result] = await Promise.all([blogContext(query), getPublishedPosts({ tag: first(query.tag) ?? null, page: Number(first(query.page)) || 1 })]);
  const pageHref = (page: number) => {
    const params = new URLSearchParams();
    if (result.tag) params.set("tag", result.tag);
    if (page > 1) params.set("page", String(page));
    const qs = params.toString();
    return qs ? `/blog?${qs}` : "/blog";
  };
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
          {result.posts.length === 0 ? (
            <div className="mx-auto max-w-xl rounded-2xl border border-dashed border-line-strong bg-surface px-6 py-12 text-center">
              <h2 className="text-lg font-semibold text-text">{result.tag ? "No posts with that tag yet" : "No posts yet"}</h2>
              <p className="mt-2 text-sm text-muted">Check back soon.</p>
            </div>
          ) : (
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {result.posts.map((post) => (
                <PostCard key={post.slug} post={post} />
              ))}
            </div>
          )}
          {result.pages > 1 && (
            <nav aria-label="Pages of posts" className="mt-12 flex items-center justify-between gap-4">
              {result.page > 1 ? (
                <Link href={pageHref(result.page - 1)} className={buttonClasses("secondary")}>
                  Newer posts
                </Link>
              ) : (
                <span />
              )}
              <p className="text-sm text-muted">
                Page {result.page} of {result.pages}
              </p>
              {result.page < result.pages ? (
                <Link href={pageHref(result.page + 1)} className={buttonClasses("secondary")}>
                  Older posts
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </Container>
      </section>
    </>
  );
}
