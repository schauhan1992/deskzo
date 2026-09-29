import Link from "next/link";
import { ChevronRight, CornerDownRight } from "lucide-react";
import type { SiteRenderContext } from "@/components/site/blocks/types";
import { SiteBlocks } from "@/components/site/blocks/render";
import { safeSrc } from "@/components/site/links";
import { Container, buttonClasses } from "@/components/site/ui";
import { formatIstDate } from "@/lib/india-time";
import { getSiteSettings, siteStatus, workspaceSuffix, type SitePost, type SitePostSummary, type SiteTermLink } from "@/lib/platform/site-content";
import { shownUpdatedAt } from "@/lib/seo/schema";
import { cn } from "@/lib/utils";

/**
 * The blog's pieces, shared by /blog, /blog/<slug>, the archives (/blog/category/<slug>,
 * /blog/tag/<slug>) and a post's draft preview (/preview/<token>): the render context blocks need,
 * the breadcrumb, the chips, a post's card, the grid, the pages and a post's article. Not a route —
 * colocated with them.
 */

type Query = Record<string, string | string[] | undefined>;

/** What the site's blocks are rendered with, for this request. */
export async function blogContext(query: Query = {}): Promise<SiteRenderContext> {
  const [settings, status] = await Promise.all([getSiteSettings(), siteStatus()]);
  const searchParams = Object.fromEntries(Object.entries(query).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  return { settings, signupOpen: status.signupOpen, trialDays: status.trialDays, searchParams, workspaceSuffix: workspaceSuffix() };
}

export type Crumb = { name: string; href: string };

/** Where a page sits in the blog — "Blog › Guides › How-to" — the last one being this page, not a link. */
export function Breadcrumb({ trail, current, className }: { trail: Crumb[]; current: string; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
        {trail.map((crumb) => (
          <li key={crumb.href} className="flex min-w-0 max-w-full items-center gap-1.5">
            <Link href={crumb.href} className="truncate font-medium text-muted transition-colors hover:text-text">
              {crumb.name}
            </Link>
            <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-subtle" />
          </li>
        ))}
        <li className="min-w-0 max-w-full">
          <span aria-current="page" className="block truncate text-subtle">
            {current}
          </span>
        </li>
      </ol>
    </nav>
  );
}

const TERM_CHIP = "inline-flex max-w-full items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors";

/** A post's categories (the main one first) and its tags, each a link to its archive. */
export function PostTerms({ categories, tags, className }: { categories: SiteTermLink[]; tags: SiteTermLink[]; className?: string }) {
  if (!categories.length && !tags.length) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {categories.length > 0 && (
        <ul className="flex min-w-0 max-w-full flex-wrap gap-2" aria-label="Categories">
          {categories.map((category) => (
            <li key={category.slug} className="min-w-0 max-w-full">
              <Link href={category.path} aria-label={`Posts in ${category.name}`} className={cn(TERM_CHIP, "border-transparent bg-brand-subtle text-brand hover:border-brand")}>
                <span className="truncate">{category.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {tags.length > 0 && (
        <ul className="flex min-w-0 max-w-full flex-wrap gap-2" aria-label="Tags">
          {tags.map((tag) => (
            <li key={tag.slug} className="min-w-0 max-w-full">
              <Link href={tag.path} aria-label={`Posts tagged ${tag.name}`} className={cn(TERM_CHIP, "border-line bg-surface text-muted hover:border-line-strong hover:text-text")}>
                <span className="truncate">#{tag.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A chip in a row of them: a category to go to, with how many posts it has. */
export type Chip = {
  name: string;
  href: string;
  /** What a screen reader says: the name, and the count in words. */
  label: string;
  count?: number;
  /** A child category, drawn under its parent. */
  child?: boolean;
  /** The one being looked at. */
  current?: boolean;
};

/** A row of category chips — links, not a client-side filter. Nothing at all when there are none. */
export function ChipNav({ label, chips, className }: { label: string; chips: Chip[]; className?: string }) {
  if (!chips.length) return null;
  return (
    <nav aria-label={label} className={className}>
      <ul className="flex flex-wrap gap-2">
        {chips.map((chip) => (
          <li key={chip.href} className="min-w-0 max-w-full">
            <Link
              href={chip.href}
              aria-label={chip.label}
              aria-current={chip.current ? "true" : undefined}
              className={cn(
                "inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors",
                chip.current ? "border-brand bg-brand-subtle text-brand" : "border-line bg-surface text-muted hover:border-line-strong hover:text-text",
              )}
            >
              {chip.child && <CornerDownRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-subtle" />}
              <span className="truncate">{chip.name}</span>
              {chip.count !== undefined && (
                <span aria-hidden="true" className={cn("text-xs tabular-nums", chip.current ? "text-brand" : "text-subtle")}>
                  {chip.count}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** "1 post", "12 posts". */
export const postCount = (n: number) => `${n} ${n === 1 ? "post" : "posts"}`;

/** A post in the list: cover, date, author, title and excerpt — the whole card is the link. */
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

/** A page of posts, as cards: one column on a phone, two, then three. */
export function PostGrid({ posts }: { posts: SitePostSummary[] }) {
  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {posts.map((post) => (
        <PostCard key={post.slug} post={post} />
      ))}
    </div>
  );
}

/**
 * The page numbers to offer: every one up to seven pages, else the first and last, the current one
 * and its neighbours — at most seven places, a gap (null) standing for the pages left out. A gap of
 * a single page shows that page instead.
 */
export function pageNumbers(page: number, pages: number): (number | null)[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const shown = new Set([1, pages, page - 1, page, page + 1]);
  if (page <= 3) for (let n = 2; n <= 5; n++) shown.add(n);
  if (page >= pages - 2) for (let n = pages - 4; n < pages; n++) shown.add(n);
  const sorted = [...shown].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  sorted.forEach((n, i) => {
    const before = sorted[i - 1];
    if (before !== undefined && n - before === 2) out.push(n - 1);
    else if (before !== undefined && n - before > 2) out.push(null);
    out.push(n);
  });
  return out;
}

/**
 * Newer and older, and the page numbers between them. On a phone the two buttons share a row and the
 * numbers take the one below; from `sm` up, one row. Nothing when there is a single page.
 */
export function Pagination({ page, pages, href, label = "Pages of posts" }: { page: number; pages: number; href: (page: number) => string; label?: string }) {
  if (pages <= 1) return null;
  // Past the last page (the index shows "No posts yet" there), "newer" is the last page.
  const newer = Math.min(page - 1, pages);
  return (
    <nav aria-label={label} className="mt-12 flex flex-wrap items-center justify-between gap-4">
      {page > 1 ? (
        <Link href={href(newer)} rel="prev" aria-label={`Newer posts, page ${newer}`} className={buttonClasses("secondary")}>
          Newer posts
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}
      <ol className="order-last flex w-full flex-wrap items-center justify-center gap-1 sm:order-none sm:w-auto">
        {pageNumbers(page, pages).map((n, i) =>
          n === null ? (
            <li key={`gap-${i}`} aria-hidden="true" className="grid h-9 w-6 place-items-center text-sm text-subtle">
              …
            </li>
          ) : (
            <li key={n}>
              <Link
                href={href(n)}
                aria-label={n === page ? `Page ${n}, this page` : `Page ${n}`}
                aria-current={n === page ? "page" : undefined}
                className={cn(
                  "grid h-9 min-w-9 place-items-center rounded-base border px-2 text-sm font-medium tabular-nums transition-colors",
                  n === page ? "border-line-strong bg-surface text-text shadow-sm" : "border-transparent text-muted hover:bg-surface-sunken hover:text-text",
                )}
              >
                {n}
              </Link>
            </li>
          ),
        )}
      </ol>
      {page < pages ? (
        <Link href={href(page + 1)} rel="next" aria-label={`Older posts, page ${page + 1}`} className={buttonClasses("secondary")}>
          Older posts
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}
    </nav>
  );
}

/** A post, whole: the breadcrumb (Blog › its main category › it), its header, cover and body blocks. */
export async function PostArticle({ post, ctx }: { post: SitePost; ctx: SiteRenderContext }) {
  const cover = post.cover ? safeSrc(post.cover.src) : null;
  const main = post.categories[0];
  const trail: Crumb[] = [{ name: "Blog", href: "/blog" }, ...(main ? [{ name: main.name, href: main.path }] : [])];
  // Shown only when it falls on a later day than the post went live; the BlogPosting's dateModified is this same date.
  const updated = shownUpdatedAt(post.publishedAt, post.updatedAt);
  return (
    <article>
      <header className="border-b border-line">
        <Container className="py-12 sm:py-16">
          <div className="mx-auto max-w-3xl">
            <Breadcrumb trail={trail} current={post.title} />
            <h1 className="mt-6 text-4xl font-semibold tracking-tight text-text text-balance sm:text-5xl">{post.title}</h1>
            {post.excerpt && <p className="mt-5 text-lg leading-8 text-muted text-pretty">{post.excerpt}</p>}
            <p className="mt-6 text-sm text-subtle">
              <time dateTime={post.publishedAt.toISOString()}>{formatIstDate(post.publishedAt)}</time>
              {updated && (
                <>
                  <span aria-hidden="true"> · </span>
                  Updated <time dateTime={updated.toISOString()}>{formatIstDate(updated)}</time>
                </>
              )}
              <span aria-hidden="true"> · </span>
              {post.author}
            </p>
            <PostTerms categories={post.categories} tags={post.tagLinks} className="mt-4" />
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
