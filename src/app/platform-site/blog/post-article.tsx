import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { SiteRenderContext } from "@/components/site/blocks/types";
import { SiteBlocks } from "@/components/site/blocks/render";
import { safeSrc } from "@/components/site/links";
import { Container } from "@/components/site/ui";
import { formatIstDate } from "@/lib/india-time";
import { getSiteSettings, siteStatus, workspaceSuffix, type SitePost, type SitePostSummary } from "@/lib/platform/site-content";

/**
 * The blog's pieces, shared by /blog, /blog/<slug> and a post's draft preview (/preview/<token>): the
 * render context blocks need, a post's card, and a post's article. Not a route — colocated with them.
 */

type Query = Record<string, string | string[] | undefined>;

/** What the site's blocks are rendered with, for this request. */
export async function blogContext(query: Query = {}): Promise<SiteRenderContext> {
  const [settings, status] = await Promise.all([getSiteSettings(), siteStatus()]);
  const searchParams = Object.fromEntries(Object.entries(query).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  return { settings, signupOpen: status.signupOpen, trialDays: status.trialDays, searchParams, workspaceSuffix: workspaceSuffix() };
}

export function TagList({ tags, className }: { tags: string[]; className?: string }) {
  if (!tags.length) return null;
  return (
    <ul className={className ?? "flex flex-wrap gap-2"} aria-label="Tags">
      {tags.map((tag) => (
        <li key={tag}>
          <Link href={`/blog?tag=${encodeURIComponent(tag)}`} className="inline-flex rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs font-medium text-muted hover:border-line-strong hover:text-text">
            #{tag}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** A post in the list: cover, date, title, excerpt, tags. */
export function PostCard({ post }: { post: SitePostSummary }) {
  const cover = post.cover ? safeSrc(post.cover.src) : null;
  return (
    <article className="group relative flex flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-sm transition-shadow hover:shadow-md">
      {cover && (
        // A library image served by this site's /media route: next/image would re-encode it for nothing.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={cover} alt={post.cover!.alt} width={post.cover!.width ?? undefined} height={post.cover!.height ?? undefined} loading="lazy" className="aspect-[16/9] w-full border-b border-line bg-surface-sunken object-cover" />
      )}
      <div className="flex flex-1 flex-col p-5">
        <p className="text-xs font-medium text-subtle">
          <time dateTime={post.publishedAt.toISOString()}>{formatIstDate(post.publishedAt)}</time>
          <span aria-hidden="true"> · </span>
          {post.author}
        </p>
        <h2 className="mt-2 text-lg font-semibold tracking-tight text-text text-balance">
          <Link href={post.path} className="after:absolute after:inset-0 focus-visible:outline-none group-focus-within:underline">
            {post.title}
          </Link>
        </h2>
        {post.excerpt && <p className="mt-2 line-clamp-3 text-sm leading-6 text-muted">{post.excerpt}</p>}
      </div>
    </article>
  );
}

/** A post, whole: its header, cover and body blocks. */
export async function PostArticle({ post, ctx }: { post: SitePost; ctx: SiteRenderContext }) {
  const cover = post.cover ? safeSrc(post.cover.src) : null;
  return (
    <article>
      <header className="border-b border-line">
        <Container className="py-12 sm:py-16">
          <div className="mx-auto max-w-3xl">
            <Link href="/blog" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-text">
              <ArrowLeft aria-hidden="true" className="h-4 w-4" />
              All posts
            </Link>
            <h1 className="mt-6 text-4xl font-semibold tracking-tight text-text text-balance sm:text-5xl">{post.title}</h1>
            {post.excerpt && <p className="mt-5 text-lg leading-8 text-muted text-pretty">{post.excerpt}</p>}
            <p className="mt-6 text-sm text-subtle">
              <time dateTime={post.publishedAt.toISOString()}>{formatIstDate(post.publishedAt)}</time>
              <span aria-hidden="true"> · </span>
              {post.author}
            </p>
            <TagList tags={post.tags} className="mt-4 flex flex-wrap gap-2" />
          </div>
        </Container>
      </header>
      {cover && (
        <Container className="pt-10">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={cover} alt={post.cover!.alt} width={post.cover!.width ?? undefined} height={post.cover!.height ?? undefined} className="mx-auto h-auto w-full max-w-4xl rounded-2xl border border-line bg-surface-sunken object-cover shadow-sm" />
        </Container>
      )}
      <SiteBlocks blocks={post.body} ctx={ctx} />
    </article>
  );
}
