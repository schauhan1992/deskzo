import type { Metadata } from "next";
import Link from "next/link";
import { LayoutGrid, Rows3 } from "lucide-react";
import { SearchField, ToggleFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { MediaLibrary } from "@/components/cms/media/media-library";
import { Pagination } from "@/components/ui/pagination";
import { withParams } from "@/lib/console-shared/params";
import { cmsPage } from "@/lib/cms/guard";
import { getMedia, listMedia, mediaUsage } from "@/lib/cms/media";
import { CMS_PAGE_ROLES, CMS_ROUTES } from "@/lib/cms/nav";
import { cmsCapsFor } from "@/lib/cms/types";
import { siteOrigin } from "@/lib/platform/site-content";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Media" };

const PATH = CMS_ROUTES.media;
const ID = /^[a-z0-9]{20,40}$/;
type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined);

/** The address with some keys changed and the rest — the page number included — kept. */
function hrefWith(sp: Params, changes: Record<string, string | null>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (key in changes) continue;
    const v = one(value);
    if (v) params.set(key, v);
  }
  for (const [key, value] of Object.entries(changes)) if (value) params.set(key, value);
  const query = params.toString();
  return query ? `${PATH}?${query}` : PATH;
}

/**
 * The media library: every image pages, posts and the site's settings may use, newest first, 48 at
 * a time — searchable by file name or alt text, narrowed to the ones still missing alt text, as a grid
 * or a list. Writers upload (drop several at once); an image's details open beside the list at
 * /media?id=<id> — on this host /media/<id> is the image itself.
 */
export default async function CmsMediaPage({ searchParams }: PageProps<"/platform-cms/media">) {
  const session = await cmsPage(CMS_PAGE_ROLES.media);
  const caps = cmsCapsFor(session.user.role);
  const sp = await searchParams;
  const q = (one(sp.q) ?? "").trim().slice(0, 100);
  const needsAlt = one(sp.alt) === "1";
  const page = Math.min(1000, Math.max(1, Math.floor(Number(one(sp.page)) || 1)));
  const view = one(sp.view) === "list" ? "list" : "grid";
  const idRaw = one(sp.id) ?? "";
  const id = ID.test(idRaw) ? idRaw : null;

  const [listing, missingAlt, selected, usage] = await Promise.all([
    listMedia({ q: q || undefined, page, needsAlt }),
    listMedia({ needsAlt: true }),
    id ? getMedia(id) : Promise.resolve(null),
    id ? mediaUsage(id) : Promise.resolve([]),
  ]);
  const totalPages = Math.max(1, Math.ceil(listing.total / listing.pageSize));
  const hrefs = Object.fromEntries(listing.rows.map((row) => [row.id, hrefWith(sp, { id: row.id, upload: null })]));
  const chips = [
    ...(q ? [{ key: "q", label: `Search: ${q}`, removeHref: withParams(PATH, sp, { q: null, id: null }) }] : []),
    ...(needsAlt ? [{ key: "alt", label: "Missing alt text", removeHref: withParams(PATH, sp, { alt: null, id: null }) }] : []),
  ];

  const viewLink = (key: "grid" | "list", label: string, Icon: typeof Rows3) => (
    <Link
      href={hrefWith(sp, { view: key === "grid" ? null : key })}
      scroll={false}
      aria-current={view === key ? "true" : undefined}
      className={cn("inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-[13px] font-medium", view === key ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text")}
    >
      <Icon aria-hidden="true" className="h-4 w-4" />
      {label}
    </Link>
  );

  return (
    <>
      <PageHeader
        title="Media"
        subtitle={`${listing.total.toLocaleString("en-IN")} ${listing.total === 1 ? "image" : "images"}${q || needsAlt ? " match" : " in the library"}${missingAlt.total > 0 ? ` · ${missingAlt.total.toLocaleString("en-IN")} still need alt text before a page using them can be published` : ""}.`}
      />

      <FilterBar
        trailing={
          <>
            <SearchField label="Search images by file name or alt text" placeholder="Search file name or alt text" resetParams={["page", "id"]} />
            <nav aria-label="Library layout" className="inline-flex rounded-base border border-line bg-surface-sunken p-0.5">
              {viewLink("grid", "Grid", LayoutGrid)}
              {viewLink("list", "List", Rows3)}
            </nav>
          </>
        }
      >
        <ToggleFilter param="alt" label={`Only images without alt text${missingAlt.total ? ` (${missingAlt.total})` : ""}`} resetParams={["page", "id"]} />
      </FilterBar>
      <FilterChips chips={chips} clearHref={chips.length ? withParams(PATH, sp, { q: null, alt: null, id: null }) : undefined} />

      <MediaLibrary
        rows={listing.rows}
        view={view}
        hrefs={hrefs}
        closeHref={hrefWith(sp, { id: null, upload: null })}
        selected={selected}
        missing={!!idRaw && !selected}
        usage={usage}
        caps={caps}
        siteOrigin={siteOrigin()}
        uploadOpen={one(sp.upload) === "1"}
        filtered={!!q || needsAlt}
      />
      {totalPages > 1 && <Pagination page={listing.page} pageSize={listing.pageSize} total={listing.total} totalPages={totalPages} pageSizes={[listing.pageSize]} label="images" />}
    </>
  );
}
