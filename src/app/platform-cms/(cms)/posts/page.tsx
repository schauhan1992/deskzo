import type { Metadata } from "next";
import { ArrowUpRight, ImageIcon, Newspaper } from "lucide-react";
import { EmptyState } from "@/components/console/kit/empty-state";
import { SearchField, SelectFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips, ViewTabs } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { DataTable, RowActionsCell, RowLink, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { PostStatusPill } from "@/components/cms/common/status";
import { NewItemButton } from "@/components/cms/shell/new-menu";
import { OutboundLink } from "@/components/ui/outbound-link";
import { Pagination } from "@/components/ui/pagination";
import { withParams } from "@/lib/console-shared/params";
import { listPostTags, listPosts } from "@/lib/cms/content";
import { cmsPage } from "@/lib/cms/guard";
import { CMS_PAGE_ROLES, CMS_ROUTES } from "@/lib/cms/nav";
import { listCategories } from "@/lib/cms/taxonomy";
import { cmsCapsFor, type SitePostStatus } from "@/lib/cms/types";
import { listCmsUsers } from "@/lib/cms/users";
import { formatIstDateTime } from "@/lib/india-time";
import { siteOrigin } from "@/lib/platform/site-content";

export const metadata: Metadata = { title: "Posts" };

const PATH = CMS_ROUTES.posts;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined);

type View = "all" | "DRAFT" | "SCHEDULED" | "PUBLISHED" | "archived";
const VIEWS: { key: View; label: string }[] = [
  { key: "all", label: "All" },
  { key: "DRAFT", label: "Drafts" },
  { key: "SCHEDULED", label: "Scheduled" },
  { key: "PUBLISHED", label: "Published" },
  { key: "archived", label: "Archived" },
];

/**
 * Posts: the blog and news, newest change first, 30 at a time — with their state (a scheduled post
 * says when it goes live), author, categories, tags and cover. Views by state, filters by category,
 * tag and author, a search, all in the address. Writers get "New post".
 */
export default async function CmsPostsPage({ searchParams }: PageProps<"/platform-cms/posts">) {
  const session = await cmsPage(CMS_PAGE_ROLES.posts);
  const caps = cmsCapsFor(session.user.role);
  const sp = await searchParams;
  const viewRaw = one(sp.view);
  const view: View = VIEWS.some((v) => v.key === viewRaw) ? (viewRaw as View) : "all";
  const q = (one(sp.q) ?? "").trim().slice(0, 100);
  const tag = (one(sp.tag) ?? "").trim().toLowerCase().slice(0, 60);
  const category = (one(sp.category) ?? "").trim().toLowerCase().slice(0, 60);
  const author = (one(sp.author) ?? "").trim().slice(0, 40);
  const page = Math.min(1000, Math.max(1, Math.floor(Number(one(sp.page)) || 1)));

  const [posts, tags, users, tree] = await Promise.all([
    listPosts({
      status: view !== "all" && view !== "archived" ? (view as SitePostStatus) : undefined,
      archived: view === "archived",
      tag: tag || undefined,
      category: category || undefined,
      authorId: author || undefined,
      q: q || undefined,
      page,
    }),
    listPostTags(),
    listCmsUsers(),
    listCategories(),
  ]);
  const categoryOptions = tree.flatMap((top) => [{ value: top.slug, label: top.name }, ...top.children.map((c) => ({ value: c.slug, label: `${top.name} › ${c.name}` }))]);
  const categoryName = category ? (categoryOptions.find((c) => c.value === category)?.label ?? category) : null;
  const origin = siteOrigin();
  const siteHost = new URL(origin).host;
  const totalPages = Math.max(1, Math.ceil(posts.total / posts.pageSize));
  const authorName = author ? (users.find((u) => u.id === author)?.name ?? "Somebody removed") : null;
  const chips = [
    ...(q ? [{ key: "q", label: `Search: ${q}`, removeHref: withParams(PATH, sp, { q: null }) }] : []),
    ...(categoryName ? [{ key: "category", label: `Category: ${categoryName}`, removeHref: withParams(PATH, sp, { category: null }) }] : []),
    ...(tag ? [{ key: "tag", label: `Tag: #${tag}`, removeHref: withParams(PATH, sp, { tag: null }) }] : []),
    ...(authorName ? [{ key: "author", label: `Author: ${authorName}`, removeHref: withParams(PATH, sp, { author: null }) }] : []),
  ];
  const filtered = chips.length > 0;

  return (
    <>
      <PageHeader title="Posts" subtitle={`The blog at ${siteHost}/blog. ${posts.total.toLocaleString("en-IN")} ${posts.total === 1 ? "post" : "posts"} ${view === "all" ? "in all" : "in this view"}${filtered ? " matching the filters" : ""}.`} actions={caps.write ? <NewItemButton kind="post" siteHost={siteHost} /> : undefined} />

      <FilterBar trailing={<SearchField label="Search posts by title or address" placeholder="Search by title or address" />}>
        <ViewTabs label="Post state" items={VIEWS.map((v) => ({ key: v.key, label: v.label, href: withParams(PATH, sp, { view: v.key === "all" ? null : v.key }), active: view === v.key }))} />
        {categoryOptions.length > 0 && <SelectFilter param="category" label="Category" allLabel="Any category" options={categoryOptions} />}
        {tags.length > 0 && <SelectFilter param="tag" label="Tag" allLabel="Any tag" options={tags.map((t) => ({ value: t, label: `#${t}` }))} />}
        <SelectFilter param="author" label="Author" allLabel="Anybody" options={users.map((u) => ({ value: u.id, label: u.active ? u.name : `${u.name} (switched off)` }))} />
      </FilterBar>
      <FilterChips chips={chips} clearHref={filtered ? withParams(PATH, sp, { q: null, category: null, tag: null, author: null }) : undefined} />

      {posts.rows.length === 0 ? (
        <Panel padded={false}>
          {filtered ? (
            <EmptyState variant="filtered" title="No post matches" body="Try another search, category, tag or author." clearHref={withParams(PATH, sp, { q: null, category: null, tag: null, author: null })} />
          ) : view === "archived" ? (
            <EmptyState icon={<Newspaper className="h-5 w-5" />} title="Nothing archived" body="Archived posts are off the site and wait here to be restored or deleted." />
          ) : (
            <EmptyState
              icon={<Newspaper className="h-5 w-5" />}
              title={view === "all" ? "No posts yet" : `No ${VIEWS.find((v) => v.key === view)?.label.toLowerCase()}`}
              body={view === "all" ? "The blog appears on the site once the first post is published." : undefined}
              action={caps.write && view === "all" ? <NewItemButton kind="post" siteHost={siteHost} /> : undefined}
            />
          )}
        </Panel>
      ) : (
        <>
          <Panel padded={false}>
            <DataTable caption="Posts" minWidth={860}>
              <THead>
                <Th>Post</Th>
                <Th>State</Th>
                <Th>Author</Th>
                <Th>Filed under</Th>
                <Th>Last changed</Th>
                <Th srOnly>View on the site</Th>
              </THead>
              <TBody>
                {posts.rows.map((post) => (
                  <Tr key={post.id} interactive>
                    <Td>
                      <div className="flex items-center gap-3">
                        <span className="grid h-10 w-14 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-surface-sunken">
                          {post.coverMediaId ? (
                            // A library image, served by the CMS host's /media route.
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={`/media/${post.coverMediaId}`} alt="" loading="lazy" className="h-full w-full object-cover" />
                          ) : (
                            <ImageIcon aria-hidden="true" className="h-4 w-4 text-subtle" />
                          )}
                        </span>
                        <div className="min-w-0">
                          <RowLink href={CMS_ROUTES.post(post.id)}>{post.title || "Untitled post"}</RowLink>
                          <p className="mt-0.5 truncate font-mono text-xs text-muted">{post.path}</p>
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <PostStatusPill status={post.status} live={post.live} archived={post.archived} />
                      {post.status === "SCHEDULED" && !post.live && post.publishAt && <span className="mt-0.5 block text-xs text-muted">{formatIstDateTime(post.publishAt)}</span>}
                      {post.live && post.publishAt && <span className="mt-0.5 block text-xs text-subtle">since {formatIstDateTime(post.publishAt)}</span>}
                    </Td>
                    <Td muted nowrap>
                      {post.author.name}
                    </Td>
                    <Td>
                      {post.categories.length || post.tagRefs.length ? (
                        <ul aria-label="Categories and tags" className="flex max-w-64 flex-wrap gap-1">
                          {post.categories.map((c, i) => (
                            <li key={c.id} className="rounded-full border border-line bg-brand-subtle px-1.5 text-[11px] text-brand" title={i === 0 ? "Main category" : "Category"}>
                              {c.name}
                            </li>
                          ))}
                          {post.tagRefs.map((t) => (
                            <li key={t.id} className="rounded-full border border-line bg-surface-sunken px-1.5 text-[11px] text-muted">
                              #{t.name}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-subtle">—</span>
                      )}
                    </Td>
                    <Td muted nowrap>
                      <RelativeTime at={post.updatedAt} />
                      <span className="block text-xs text-subtle">{post.updatedBy}</span>
                    </Td>
                    <RowActionsCell>
                      {post.live && (
                        <OutboundLink href={`${origin}${post.path}`} className="inline-flex items-center gap-0.5 rounded-base px-1.5 py-1 text-xs font-medium text-muted hover:text-brand">
                          View
                          <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
                          <span className="sr-only"> {post.path} on the site (opens in a new tab)</span>
                        </OutboundLink>
                      )}
                    </RowActionsCell>
                  </Tr>
                ))}
              </TBody>
            </DataTable>
          </Panel>
          {totalPages > 1 && <Pagination page={posts.page} pageSize={posts.pageSize} total={posts.total} totalPages={totalPages} pageSizes={[posts.pageSize]} label="posts" />}
        </>
      )}
    </>
  );
}
