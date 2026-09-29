"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpRight, CornerDownRight } from "lucide-react";
import { cmsDeleteCategory, cmsReorderCategories } from "@/actions/cms/categories";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { RowMenu, type RowMenuItem } from "@/components/console/kit/row-menu";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useCmsAction } from "@/components/cms/common/use-cms-action";
import { TermDialog } from "@/components/cms/taxonomy/term-dialog";
import { IconButton } from "@/components/ui/icon-button";
import { OutboundLink } from "@/components/ui/outbound-link";
import { plural } from "@/lib/console-shared/format";
import { CMS_ROUTES } from "@/lib/cms/nav";
import type { CategoryNode, CategoryRow, CmsCaps, MediaRow } from "@/lib/cms/types";
import { cn } from "@/lib/utils";

/**
 * The blog's categories as the tree they are: each top-level category, its subcategories under it,
 * in the order the site lists them. Everybody reads it; editors and admins add, change, reorder
 * (up and down among a category's siblings) and delete them. A category with subcategories can't
 * be deleted — the server says so, and its words are shown in the dialog that asked.
 */

type Pending =
  | { kind: "edit"; row: CategoryRow; hasChildren: boolean }
  | { kind: "child"; parent: CategoryNode }
  | { kind: "delete"; row: CategoryRow; children: number };

const postsHref = (slug: string) => `${CMS_ROUTES.posts}?category=${encodeURIComponent(slug)}`;

export function CategoriesTable({ tree, caps, media, siteOrigin }: { tree: CategoryNode[]; caps: CmsCaps; media: Record<string, MediaRow>; siteOrigin: string }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const reorder = useCmsAction<CategoryNode[]>();
  const parents = tree.map((t) => ({ id: t.id, name: t.name, slug: t.slug }));
  const manage = caps.publish;

  /** Moves one category up or down among its siblings — the whole sibling list is sent, in its new order. */
  function move(parentId: string | null, siblings: CategoryRow[], index: number, delta: -1 | 1) {
    const to = index + delta;
    if (to < 0 || to >= siblings.length) return;
    const ids = siblings.map((s) => s.id);
    [ids[index], ids[to]] = [ids[to]!, ids[index]!];
    const name = siblings[index]!.name;
    reorder.run(() => cmsReorderCategories(parentId, ids), { success: `“${name}” moved ${delta < 0 ? "up" : "down"}.` });
  }

  function menuFor(row: CategoryRow, node: CategoryNode | null, live: boolean): RowMenuItem[] {
    return [
      { key: "edit", label: "Edit…", onSelect: () => setPending({ kind: "edit", row, hasChildren: !!node?.children.length }) },
      ...(node ? [{ key: "child", label: "Add a subcategory…", onSelect: () => setPending({ kind: "child", parent: node }) }] : []),
      ...(live ? [{ key: "view", label: "View its page on the site", href: `${siteOrigin}${row.path}`, external: true }] : []),
      { key: "sep", separator: true },
      { key: "delete", label: "Delete…", danger: true, onSelect: () => setPending({ kind: "delete", row, children: node?.children.length ?? 0 }) },
    ];
  }

  const line = (row: CategoryRow, opts: { node: CategoryNode | null; parentId: string | null; siblings: CategoryRow[]; index: number; live: boolean }) => {
    const child = opts.parentId !== null;
    return (
      <Tr key={row.id}>
        <Td>
          <div className={cn("flex min-w-0 items-start gap-2", child && "pl-6")}>
            {child && <CornerDownRight aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />}
            <div className="min-w-0">
              <p className="font-medium text-text">
                {row.name}
                {child && <span className="sr-only">{`, a subcategory`}</span>}
              </p>
              {row.description && <p className="mt-0.5 line-clamp-1 max-w-md text-xs text-muted">{row.description}</p>}
              {opts.node && opts.node.children.length > 0 && <p className="mt-0.5 text-[11px] text-subtle">{plural(opts.node.children.length, "subcategory", "subcategories")}</p>}
            </div>
          </div>
        </Td>
        <Td>
          <span className="block font-mono text-xs text-muted">{row.path}</span>
          {opts.live ? (
            <OutboundLink href={`${siteOrigin}${row.path}`} className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] font-medium text-brand hover:underline">
              On the site
              <ArrowUpRight aria-hidden="true" className="h-3 w-3" />
              <span className="sr-only">{` — open ${row.path} (a new tab)`}</span>
            </OutboundLink>
          ) : (
            <span className="mt-0.5 block text-[11px] text-subtle" title="A category's page appears once a post in it (or in a subcategory) is live.">
              No page yet
            </span>
          )}
        </Td>
        <Td numeric>
          {row.posts > 0 ? (
            <Link href={postsHref(row.slug)} className="font-medium text-text hover:text-brand" aria-label={`${plural(row.posts, "post")} in ${row.name} — show them`}>
              {row.posts.toLocaleString("en-IN")}
            </Link>
          ) : (
            <span className="text-subtle">0</span>
          )}
          <span className="block text-[11px] text-subtle">{row.livePosts.toLocaleString("en-IN")} live</span>
        </Td>
        <Td muted nowrap>
          <RelativeTime at={row.updatedAt} />
          <span className="block text-xs text-subtle">{row.updatedBy}</span>
        </Td>
        {manage && (
          <RowActionsCell>
            <IconButton icon={ArrowUp} label={`Move ${row.name} up`} onClick={() => move(opts.parentId, opts.siblings, opts.index, -1)} disabled={reorder.pending || opts.index === 0} />
            <IconButton
              icon={ArrowDown}
              label={`Move ${row.name} down`}
              onClick={() => move(opts.parentId, opts.siblings, opts.index, 1)}
              disabled={reorder.pending || opts.index === opts.siblings.length - 1}
            />
            <RowMenu label={`Actions for ${row.name}`} items={menuFor(row, opts.node, opts.live)} />
          </RowActionsCell>
        )}
      </Tr>
    );
  };

  return (
    <>
      {reorder.error && (
        <p role="alert" className="border-b border-line bg-danger-bg px-5 py-2 text-xs text-danger">
          {reorder.error}
        </p>
      )}
      <DataTable caption="Categories, in the order the site lists them" minWidth={760}>
        <THead>
          <Th>Category</Th>
          <Th>Page</Th>
          <Th numeric>Posts</Th>
          <Th>Last changed</Th>
          {manage && <Th srOnly>Order and actions</Th>}
        </THead>
        <TBody>
          {tree.map((top, index) => {
            const live = top.livePosts + top.children.reduce((sum, c) => sum + c.livePosts, 0) > 0;
            return (
              <Fragment key={top.id}>
                {line(top, { node: top, parentId: null, siblings: tree, index, live })}
                {top.children.map((child, childIndex) => line(child, { node: null, parentId: top.id, siblings: top.children, index: childIndex, live: child.livePosts > 0 }))}
              </Fragment>
            );
          })}
        </TBody>
      </DataTable>

      {pending?.kind === "edit" && (
        <TermDialog
          kind="category"
          row={pending.row}
          parents={parents}
          hasChildren={pending.hasChildren}
          image={pending.row.seo?.imageMediaId ? (media[pending.row.seo.imageMediaId] ?? null) : null}
          onClose={() => setPending(null)}
        />
      )}
      {pending?.kind === "child" && <TermDialog kind="category" row={null} parentId={pending.parent.id} parents={parents} image={null} onClose={() => setPending(null)} />}
      {pending?.kind === "delete" && <DeleteCategoryDialog row={pending.row} subcategories={pending.children} onClose={() => setPending(null)} />}
    </>
  );
}

function DeleteCategoryDialog({ row, subcategories, onClose }: { row: CategoryRow; subcategories: number; onClose: () => void }) {
  const action = useCmsAction<null>();
  const close = () => {
    if (!action.pending) onClose();
  };
  return (
    <ConfirmDialog
      open
      onClose={close}
      title={`Delete the category “${row.name}”`}
      tone="danger"
      confirmLabel="Delete category"
      pending={action.pending}
      error={action.error}
      onConfirm={() => action.run(() => cmsDeleteCategory(row.id), { success: `Deleted the category “${row.name}”.`, onDone: onClose })}
    >
      <p>
        {row.posts > 0 ? `${plural(row.posts, "post")} lose${row.posts === 1 ? "s" : ""} this category; the posts themselves stay. ` : "No post is in it. "}
        {`Its page, ${row.path}, stops working${row.livePosts > 0 ? " — add a redirect if people link to it" : ""}.`}
      </p>
      {subcategories > 0 && <p className="text-xs text-muted">{`It has ${plural(subcategories, "subcategory", "subcategories")}: move or delete them first, or the delete is refused.`}</p>}
    </ConfirmDialog>
  );
}
