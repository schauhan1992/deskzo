"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, CircleCheck } from "lucide-react";
import { cmsDeleteTag, cmsMergeTags, cmsSearchTags } from "@/actions/cms/tags";
import { ConfirmBody, ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { RowMenu, type RowMenuItem } from "@/components/console/kit/row-menu";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useCmsAction } from "@/components/cms/common/use-cms-action";
import { TermDialog } from "@/components/cms/taxonomy/term-dialog";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { OutboundLink } from "@/components/ui/outbound-link";
import { useComboboxKeyboard } from "@/components/ui/use-combobox-keyboard";
import { plural } from "@/lib/console-shared/format";
import { CMS_ROUTES } from "@/lib/cms/nav";
import type { AutoRedirect, CmsCaps, CmsTermRef, MediaRow, TagRow } from "@/lib/cms/types";
import { cn } from "@/lib/utils";

/**
 * The blog's tags, a page at a time, with how many posts carry each and how many of those are live.
 * Everybody reads it; editors and admins rename or re-describe a tag, merge it into another (its
 * posts move, it goes, and its page redirects to the other's — the dialog shows that 301), and
 * delete one (its posts lose it).
 */

type Pending = { kind: "edit"; row: TagRow } | { kind: "merge"; row: TagRow } | { kind: "delete"; row: TagRow };

const postsHref = (slug: string) => `${CMS_ROUTES.posts}?tag=${encodeURIComponent(slug)}`;

export function TagsTable({ rows, caps, media, siteOrigin }: { rows: TagRow[]; caps: CmsCaps; media: Record<string, MediaRow>; siteOrigin: string }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const manage = caps.publish;

  function menuFor(row: TagRow): RowMenuItem[] {
    return [
      { key: "edit", label: "Edit…", onSelect: () => setPending({ kind: "edit", row }) },
      { key: "merge", label: "Merge into another tag…", onSelect: () => setPending({ kind: "merge", row }) },
      ...(row.livePosts > 0 ? [{ key: "view", label: "View its page on the site", href: `${siteOrigin}${row.path}`, external: true }] : []),
      { key: "sep", separator: true },
      { key: "delete", label: "Delete…", danger: true, onSelect: () => setPending({ kind: "delete", row }) },
    ];
  }

  return (
    <>
      <DataTable caption="Tags, by name" minWidth={720}>
        <THead>
          <Th>Tag</Th>
          <Th>Page</Th>
          <Th numeric>Posts</Th>
          <Th>Last changed</Th>
          {manage && <Th srOnly>Actions</Th>}
        </THead>
        <TBody>
          {rows.map((row) => (
            <Tr key={row.id}>
              <Td>
                <p className="font-medium text-text">#{row.name}</p>
                {row.description && <p className="mt-0.5 line-clamp-1 max-w-md text-xs text-muted">{row.description}</p>}
              </Td>
              <Td>
                <span className="block font-mono text-xs text-muted">{row.path}</span>
                {row.livePosts > 0 ? (
                  <OutboundLink href={`${siteOrigin}${row.path}`} className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] font-medium text-brand hover:underline">
                    On the site
                    <ArrowUpRight aria-hidden="true" className="h-3 w-3" />
                    <span className="sr-only">{` — open ${row.path} (a new tab)`}</span>
                  </OutboundLink>
                ) : (
                  <span className="mt-0.5 block text-[11px] text-subtle" title="A tag's page appears once a post with it is live.">
                    No page yet
                  </span>
                )}
              </Td>
              <Td numeric>
                {row.posts > 0 ? (
                  <Link href={postsHref(row.slug)} className="font-medium text-text hover:text-brand" aria-label={`${plural(row.posts, "post")} tagged ${row.name} — show them`}>
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
                  <RowMenu label={`Actions for the tag ${row.name}`} items={menuFor(row)} />
                </RowActionsCell>
              )}
            </Tr>
          ))}
        </TBody>
      </DataTable>

      {pending?.kind === "edit" && (
        <TermDialog kind="tag" row={pending.row} image={pending.row.seo?.imageMediaId ? (media[pending.row.seo.imageMediaId] ?? null) : null} onClose={() => setPending(null)} />
      )}
      {pending?.kind === "merge" && <MergeTagDialog source={pending.row} onClose={() => setPending(null)} />}
      {pending?.kind === "delete" && <DeleteTagDialog row={pending.row} onClose={() => setPending(null)} />}
    </>
  );
}

function DeleteTagDialog({ row, onClose }: { row: TagRow; onClose: () => void }) {
  const action = useCmsAction<null>();
  const close = () => {
    if (!action.pending) onClose();
  };
  return (
    <ConfirmDialog
      open
      onClose={close}
      title={`Delete the tag “${row.name}”`}
      tone="danger"
      confirmLabel="Delete tag"
      pending={action.pending}
      error={action.error}
      onConfirm={() => action.run(() => cmsDeleteTag(row.id), { success: `Deleted the tag “${row.name}”.`, onDone: onClose })}
    >
      <p>
        {row.posts > 0 ? `${plural(row.posts, "post")} lose${row.posts === 1 ? "s" : ""} it; the posts themselves stay. ` : "No post has it. "}
        {`Its page, ${row.path}, stops working.`}
      </p>
      {row.posts > 0 && <p className="text-xs text-muted">To keep its posts together under another tag — and its page redirecting there — merge it instead.</p>}
    </ConfirmDialog>
  );
}

type Merged = { tag: TagRow; moved: number; redirect: AutoRedirect | null };

/**
 * Merging a tag into another: pick the tag to keep (searched as you type), see what happens, merge.
 * Then the dialog says what was done — posts moved, and the 301 from the old tag's page.
 */
function MergeTagDialog({ source, onClose }: { source: TagRow; onClose: () => void }) {
  const action = useCmsAction<Merged>();
  const [target, setTarget] = useState<CmsTermRef | null>(null);
  const [done, setDone] = useState<Merged | null>(null);
  const close = () => {
    if (!action.pending) onClose();
  };

  return (
    <Dialog open onClose={close} title={done ? "Tags merged" : `Merge “${source.name}” into another tag`}>
      {done ? (
        <div className="space-y-4 p-0.5 text-sm">
          <p className="flex items-start gap-2 text-text">
            <CircleCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <span>{`“${source.name}” is merged into “${done.tag.name}”. ${done.moved ? `${plural(done.moved, "post")} moved to it.` : "It had no posts to move."}`}</span>
          </p>
          {done.redirect ? (
            <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2.5">
              <p className="text-xs font-medium text-muted">{done.redirect.created ? "A redirect was created" : "A redirect was updated"}</p>
              <p className="mt-1 font-mono text-[13px] break-all text-text">
                {done.redirect.from} → {done.redirect.to}
              </p>
              <p className="mt-1 text-xs text-muted">301, permanent: links to the old tag&apos;s page land on the one you kept.</p>
            </div>
          ) : (
            <p className="text-xs text-muted">{`No redirect was made from ${source.path} — add one in Redirects if people link to it.`}</p>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Link href={CMS_ROUTES.redirects} className="inline-flex h-9 items-center justify-center rounded-base px-3.5 text-sm font-medium text-brand hover:underline">
              See the redirects
            </Link>
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <ConfirmBody
          confirmLabel={target ? `Merge into “${target.name}”` : "Merge"}
          confirmDisabled={!target}
          pending={action.pending}
          error={action.error}
          onCancel={close}
          onConfirm={() => {
            if (!target) return;
            action.run(() => cmsMergeTags(source.id, target.id), {
              success: (d) => `Merged “${source.name}” into “${d.tag.name}”.${d.redirect ? ` ${d.redirect.from} now redirects to ${d.redirect.to}.` : ""}`,
              onDone: setDone,
            });
          }}
        >
          <TagPicker exclude={source.id} value={target} onChange={setTarget} disabled={action.pending} />
          <ul className="list-disc space-y-1 pl-5 text-sm text-text">
            <li>{source.posts ? `Its ${plural(source.posts, "post")} get${source.posts === 1 ? "s" : ""} the tag you keep (a post that has both keeps one).` : "It has no posts to move."}</li>
            <li>{`“${source.name}” is deleted.`}</li>
            <li>{`Its page, ${source.path}, redirects (301) to the kept tag's page.`}</li>
          </ul>
        </ConfirmBody>
      )}
    </Dialog>
  );
}

/** The tag to keep, searched as you type (never the tag being merged). */
function TagPicker({ exclude, value, onChange, disabled }: { exclude: string; value: CmsTermRef | null; onChange: (tag: CmsTermRef | null) => void; disabled: boolean }) {
  const id = useId();
  const anchorRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(value?.name ?? "");
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ results: CmsTermRef[]; loading: boolean; error: string | null }>({ results: [], loading: false, error: null });
  const ticket = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const pending = timer;
    return () => window.clearTimeout(pending.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (anchorRef.current?.contains(target)) return;
      if (target.closest?.("[data-tag-picker-panel]")) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function lookUp(q: string, delay = 200) {
    window.clearTimeout(timer.current);
    const mine = ++ticket.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    timer.current = window.setTimeout(() => {
      cmsSearchTags(q, 20).then(
        (r) => {
          if (mine !== ticket.current) return;
          setState(r.ok ? { results: r.data.filter((t) => t.id !== exclude), loading: false, error: null } : { results: [], loading: false, error: r.error });
        },
        () => {
          if (mine === ticket.current) setState({ results: [], loading: false, error: "The tags could not be searched. Try again." });
        },
      );
    }, delay);
  }

  function choose(tag: CmsTermRef) {
    onChange(tag);
    setQuery(tag.name);
    setOpen(false);
  }

  const results = state.results.slice(0, 8);
  const combobox = useComboboxKeyboard({
    label: "Tags",
    optionCount: results.length,
    isOpen: open && results.length > 0,
    setOpen,
    onChoose: (index) => {
      const tag = results[index];
      if (tag) choose(tag);
    },
    resetKey: results.map((t) => t.id).join(","),
  });

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Keep this tag</Label>
      <div ref={anchorRef}>
        <Input
          id={id}
          value={query}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value.slice(0, 60));
            setOpen(true);
            if (value) onChange(null);
            lookUp(e.target.value.trim());
          }}
          onFocus={() => {
            setOpen(true);
            if (!state.results.length && !state.loading) lookUp(query.trim(), 0);
          }}
          placeholder="Search the tags"
          autoComplete="off"
          data-1p-ignore=""
          data-lpignore="true"
          aria-describedby={`${id}-hint`}
          {...combobox.comboboxProps}
        />
      </div>
      <AnchoredPopover anchorRef={anchorRef} open={open && !disabled && (results.length > 0 || state.loading || !!state.error || query.trim() !== "")} maxHeight={260}>
        <div data-tag-picker-panel="" className="py-1">
          <div {...combobox.listboxProps}>
            {results.map((tag, index) => (
              <button
                key={tag.id}
                type="button"
                onClick={() => choose(tag)}
                {...combobox.optionProps(index)}
                className={cn("flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-sunken", combobox.activeIndex === index && "bg-surface-sunken")}
              >
                <span className="truncate text-text">#{tag.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-subtle">{tag.slug}</span>
              </button>
            ))}
          </div>
          {state.loading && results.length === 0 && <p className="px-3 py-1.5 text-xs text-subtle">Searching…</p>}
          {!state.loading && !state.error && results.length === 0 && <p className="px-3 py-1.5 text-xs text-subtle">No other tag matches that.</p>}
          {state.error && <p className="px-3 py-1.5 text-xs text-danger">{state.error}</p>}
        </div>
      </AnchoredPopover>
      <p id={`${id}-hint`} className="text-xs text-muted">
        {value ? `Chosen: #${value.name} (/blog/tag/${value.slug}).` : "Pick the tag its posts should have from now on."}
      </p>
    </div>
  );
}
