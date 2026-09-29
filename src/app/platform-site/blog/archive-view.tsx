import type { Metadata } from "next";
import { JsonLdScript, joinKeywords, jsonLdOf, requestOrigin, seoSiteContext } from "@/components/site/page-view";
import { Container, Eyebrow } from "@/components/site/ui";
import { categoryArchive, tagArchive, type CategoryArchive, type TagArchive } from "@/lib/cms/taxonomy";
import { getSiteSettings } from "@/lib/platform/site-content";
import { inputFromArchive } from "@/lib/seo/extract";
import { buildArchiveMetadata } from "@/lib/seo/metadata";
import type { JsonLd } from "@/lib/seo/types";
import { Breadcrumb, ChipNav, Pagination, PostGrid, blogContext, postCount, type Crumb } from "./post-article";

/**
 * A category's or a tag's archive (/blog/category/<slug>, /blog/tag/<slug>): its live posts, 12 a
 * page (`?page=`), newest first — the loaders are src/lib/cms/taxonomy.ts. Shared by the two routes;
 * not a route itself. An archive with nothing live, or a page past the last, is the site's 404: the
 * loaders return null and the routes call notFound(). Its structured data is a CollectionPage and
 * its breadcrumb (owner decision S-D1).
 */

type Query = Record<string, string | string[] | undefined>;
export type Archive = CategoryArchive | TagArchive;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The archive at this address and `?page=`, or null. Cached with the site's content, so metadata and page share one read. */
export function loadArchive(kind: Archive["kind"], slug: string, query: Query): Promise<Archive | null> {
  const page = first(query.page) ?? 1;
  return kind === "category" ? categoryArchive(slug, page) : tagArchive(slug, page);
}

/** An archive page's address with `?page=` — none for the first, as its canonical has none. */
const pageHref = (path: string, page: number) => (page <= 1 ? path : `${path}?page=${page}`);

/**
 * Title, description, keywords, canonical and sharing card: the archive's own SEO (else its name and
 * description), its image from the media library (else the site's). `?page=1` is canonicalised to the
 * bare path; later pages are their own, and say which page they are in the title.
 */
export async function archiveMetadata(archive: Archive | null): Promise<Metadata> {
  return joinKeywords(buildArchiveMetadata(archive, await getSiteSettings()));
}

/** The archive's structured data, from what its page shows: its name, description, breadcrumb and posts. */
export async function archiveJsonLd(archive: Archive): Promise<JsonLd[]> {
  const [ctx, origin] = await Promise.all([blogContext(), requestOrigin()]);
  return jsonLdOf(() =>
    inputFromArchive(
      {
        kind: archive.kind,
        slug: archive.slug,
        name: archive.name,
        description: archive.description,
        seo: archive.seo,
        image: archive.seo.image,
        posts: archive.posts,
        total: archive.total,
        page: archive.page,
        pages: archive.pages,
        parent: archive.kind === "category" ? archive.parent : null,
      },
      seoSiteContext(ctx, origin),
      new Date(),
    ),
  );
}

/** The archive: breadcrumb, heading, description, a parent's subcategories, the posts and the pages — and its structured data. */
export function ArchiveView({ archive, jsonLd = [] }: { archive: Archive; jsonLd?: readonly JsonLd[] }) {
  const parent = archive.kind === "category" ? archive.parent : null;
  const children = archive.kind === "category" ? archive.children : [];
  const trail: Crumb[] = [{ name: "Blog", href: "/blog" }, ...(parent ? [{ name: parent.name, href: parent.path }] : [])];
  const noun = archive.kind === "category" ? "Category" : "Tag";
  return (
    <>
      <JsonLdScript data={jsonLd} />
      <section className="border-b border-line">
        <Container className="py-14 sm:py-20">
          <Breadcrumb trail={trail} current={archive.kind === "tag" ? `#${archive.name}` : archive.name} />
          <div className="mt-6 max-w-3xl">
            <Eyebrow>{noun}</Eyebrow>
            <h1 className="mt-3 break-words text-4xl font-semibold tracking-tight text-text text-balance sm:text-5xl">{archive.name}</h1>
            {archive.description && <p className="mt-5 whitespace-pre-line break-words text-base leading-7 text-muted text-pretty sm:text-lg">{archive.description}</p>}
            <p className="mt-4 text-sm text-subtle">
              {postCount(archive.total)}
              {archive.pages > 1 && (
                <>
                  <span aria-hidden="true"> · </span>
                  Page {archive.page} of {archive.pages}
                </>
              )}
            </p>
          </div>
          {children.length > 0 && (
            <div className="mt-8">
              <p className="text-sm font-medium text-text">Subcategories</p>
              <ChipNav
                label={`Subcategories of ${archive.name}`}
                className="mt-3"
                chips={children.map((child) => ({ name: child.name, href: child.path, count: child.count, label: `${child.name}, ${postCount(child.count)}` }))}
              />
            </div>
          )}
        </Container>
      </section>
      <section className="py-12 sm:py-16">
        <Container>
          <PostGrid posts={archive.posts} />
          <Pagination page={archive.page} pages={archive.pages} href={(n) => pageHref(archive.path, n)} label={`Pages of ${archive.kind === "tag" ? `#${archive.name}` : archive.name}`} />
        </Container>
      </section>
    </>
  );
}
