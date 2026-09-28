"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ImageOff, ImagePlus, LoaderCircle, Plus, TriangleAlert } from "lucide-react";
import { cmsCreateCategory, cmsUpdateCategory } from "@/actions/cms/categories";
import { cmsCreateTag, cmsUpdateTag } from "@/actions/cms/tags";
import { LibraryGrid } from "@/components/cms/common/media-select";
import { TextAreaField, TextField } from "@/components/cms/common/fields";
import { issuesByPath, useCmsAction } from "@/components/cms/common/use-cms-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label, Select } from "@/components/ui/input";
import {
  CATEGORY_NAME_MAX,
  TAG_NAME_MAX,
  TERM_DESCRIPTION_MAX,
  TERM_SLUG_MAX,
  type AutoRedirect,
  type CategoryInput,
  type CategoryRow,
  type MediaRow,
  type TagInput,
  type TagRow,
  type TermSeo,
} from "@/lib/cms/types";
import { slugify, TERM_SLUG } from "@/lib/cms/validate";
import { cn } from "@/lib/utils";

/**
 * Adding or changing a category or a tag: its name, its address (made from the name when left
 * blank), a description for its archive page, a parent (categories nest one level) and its own
 * search and sharing details — a title, a description and an image from the media library, picked
 * in this same dialog so no second dialog fights it for the keyboard.
 *
 * The browser checks what it can as you type (the same limits as src/lib/cms/taxonomy.ts); the
 * server checks everything again and its refusal lands on the field it names. A new address for an
 * archive with posts on the site leaves a 301 from the old one, and the notice says so.
 */

export type TermKind = "category" | "tag";

type TermRow = CategoryRow | TagRow;

type Draft = { name: string; slug: string; description: string; parentId: string; seoTitle: string; seoDescription: string; image: string };

const SEO_TITLE_MAX = 120;
const SEO_DESCRIPTION_MAX = 300;
const WORDS: Record<TermKind, { one: string; path: (slug: string) => string; nameMax: number }> = {
  category: { one: "category", path: (slug) => `/blog/category/${slug}`, nameMax: CATEGORY_NAME_MAX },
  tag: { one: "tag", path: (slug) => `/blog/tag/${slug}`, nameMax: TAG_NAME_MAX },
};

const draftOf = (row: TermRow | null, parentId: string | null): Draft => ({
  name: row?.name ?? "",
  slug: row?.slug ?? "",
  description: row?.description ?? "",
  parentId: (row && "parentId" in row ? row.parentId : parentId) ?? "",
  seoTitle: row?.seo?.title ?? "",
  seoDescription: row?.seo?.description ?? "",
  image: row?.seo?.imageMediaId ? `/media/${row.seo.imageMediaId}` : "",
});

function seoOf(d: Draft): TermSeo | null {
  const seo: TermSeo = {};
  if (d.seoTitle.trim()) seo.title = d.seoTitle.trim();
  if (d.seoDescription.trim()) seo.description = d.seoDescription.trim();
  const id = d.image.replace(/^\/media\//, "");
  if (id) seo.imageMediaId = id;
  return Object.keys(seo).length ? seo : null;
}

/** "a redirect was created from …" — said after a save that moved an archive with posts on the site. */
export function redirectSentence(redirect: AutoRedirect | null): string {
  return redirect ? ` A redirect was created from ${redirect.from} to ${redirect.to}, so old links still work.` : "";
}

export function TermDialog({
  kind,
  row,
  parentId = null,
  parents = [],
  hasChildren = false,
  image,
  onClose,
}: {
  kind: TermKind;
  /** The one being changed; null to add one. */
  row: TermRow | null;
  /** A new category's parent, when it is added as a subcategory. */
  parentId?: string | null;
  /** Top-level categories a category may sit under. */
  parents?: { id: string; name: string }[];
  /** The category has subcategories, so it stays at the top level. */
  hasChildren?: boolean;
  /** The library row of its sharing image now, for its name and size. */
  image: MediaRow | null;
  onClose: () => void;
}) {
  const words = WORDS[kind];
  const action = useCmsAction<TermRow & { redirect?: AutoRedirect | null }>();
  const [draft, setDraft] = useState<Draft>(() => draftOf(row, parentId));
  const [picked, setPicked] = useState<MediaRow | null>(null);
  const [picking, setPicking] = useState(false);
  const [tried, setTried] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const parentFieldId = useId();

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => nameRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const server = issuesByPath(action.issues);
  const name = draft.name.replace(/\s+/g, " ").trim();
  const typedSlug = draft.slug.trim().toLowerCase();
  // A blank address on a new one is made from the name; on one that exists it keeps the address it has.
  const slug = typedSlug || (row ? row.slug : slugify(name, TERM_SLUG_MAX));
  const nameProblem = !name ? (tried ? "Give it a name." : null) : name.length > words.nameMax ? `Keep the name to ${words.nameMax} characters.` : null;
  const slugProblem = typedSlug && (typedSlug.length > TERM_SLUG_MAX || !TERM_SLUG.test(typedSlug)) ? `Lower-case letters, digits and hyphens (at most ${TERM_SLUG_MAX}).` : null;
  const moving = !!row && slug !== row.slug;
  const knownImage = picked && picked.url === draft.image ? picked : image && image.url === draft.image ? image : null;
  const close = () => {
    if (!action.pending) onClose();
  };
  /** Between the form and the library, focus goes with the view — never back to the page behind. */
  const showLibrary = (on: boolean) => {
    setPicking(on);
    window.requestAnimationFrame(() => (on ? backRef : chooseRef).current?.focus());
  };

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTried(true);
    if (!name || nameProblem || slugProblem || action.pending) return;
    const seo = seoOf(draft);
    const before = row ? draftOf(row, null) : null;
    const done = (saved: TermRow & { redirect?: AutoRedirect | null }) => `${row ? "Saved" : "Added"} “${saved.name}”.${redirectSentence(saved.redirect ?? null)}`;
    if (kind === "category") {
      const input: CategoryInput = { name, slug: typedSlug || undefined, description: draft.description.trim() || null, parentId: draft.parentId || null, seo };
      if (!row) action.run(() => cmsCreateCategory(input), { success: done, onDone: onClose });
      else {
        const changes: Partial<CategoryInput> = {};
        if (name !== row.name) changes.name = name;
        if (typedSlug && typedSlug !== row.slug) changes.slug = typedSlug;
        if (draft.description !== before!.description) changes.description = input.description;
        if (draft.parentId !== before!.parentId) changes.parentId = input.parentId;
        if (JSON.stringify(seo) !== JSON.stringify(seoOf(before!))) changes.seo = seo;
        action.run(() => cmsUpdateCategory(row.id, changes), { success: done, onDone: onClose });
      }
    } else {
      const input: TagInput = { name, slug: typedSlug || undefined, description: draft.description.trim() || null, seo };
      if (!row) action.run(() => cmsCreateTag(input), { success: done, onDone: onClose });
      else {
        const changes: Partial<TagInput> = {};
        if (name !== row.name) changes.name = name;
        if (typedSlug && typedSlug !== row.slug) changes.slug = typedSlug;
        if (draft.description !== before!.description) changes.description = input.description;
        if (JSON.stringify(seo) !== JSON.stringify(seoOf(before!))) changes.seo = seo;
        action.run(() => cmsUpdateTag(row.id, changes), { success: done, onDone: onClose });
      }
    }
  }

  const title = picking ? "Choose a sharing image" : row ? `Edit the ${words.one} “${row.name}”` : parentId ? "Add a subcategory" : `Add a ${words.one}`;

  return (
    <Dialog open onClose={close} title={title} large>
      {picking ? (
        <div className="space-y-3">
          <Button ref={backRef} type="button" variant="ghost" size="sm" onClick={() => showLibrary(false)}>
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
            Back to the {words.one}
          </Button>
          <LibraryGrid
            current={draft.image}
            onChoose={(media) => {
              setPicked(media);
              set("image", media.url);
              showLibrary(false);
            }}
          />
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="space-y-5 p-0.5" aria-busy={action.pending || undefined}>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              inputRef={nameRef}
              label="Name"
              value={draft.name}
              onChange={(v) => set("name", v)}
              max={words.nameMax}
              required
              readOnly={action.pending}
              placeholder={kind === "category" ? "Product updates" : "Payroll"}
              error={nameProblem ?? server.name}
            />
            <TextField
              label="Address"
              value={draft.slug}
              onChange={(v) => set("slug", v.toLowerCase().replace(/\s+/g, "-"))}
              max={TERM_SLUG_MAX}
              mono
              readOnly={action.pending}
              placeholder={row ? row.slug : slugify(name, TERM_SLUG_MAX) || (kind === "category" ? "product-updates" : "payroll")}
              error={slugProblem ?? server.slug}
              hint={row ? `Its page: ${words.path(slug)}` : `Left blank, it is made from the name: ${words.path(slug || "…")}`}
            />
          </div>
          {moving && row && row.livePosts > 0 && (
            <p className="flex items-start gap-1.5 rounded-lg border border-info/30 bg-info-bg px-3 py-2 text-xs text-info">
              <TriangleAlert aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>{`Its page moves from ${words.path(row.slug)} to ${words.path(slug)}. A redirect from the old address is made for you, so links to it keep working.`}</span>
            </p>
          )}
          <TextAreaField
            label="Description"
            value={draft.description}
            onChange={(v) => set("description", v)}
            max={TERM_DESCRIPTION_MAX}
            rows={3}
            readOnly={action.pending}
            error={server.description}
            hint={`Plain text, shown at the top of its page on the site${kind === "category" ? " and under its name here" : ""}.`}
          />
          {kind === "category" && (
            <div className="space-y-1.5">
              <Label htmlFor={parentFieldId}>Parent</Label>
              <Select
                id={parentFieldId}
                value={draft.parentId}
                onChange={(e) => set("parentId", e.target.value)}
                disabled={action.pending || hasChildren}
                aria-invalid={server.parentId ? true : undefined}
                aria-describedby={`${parentFieldId}-hint`}
                className={cn(server.parentId && "border-danger")}
              >
                <option value="">None — a top-level category</option>
                {parents
                  .filter((p) => p.id !== row?.id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </Select>
              <p id={`${parentFieldId}-hint`} className={cn("text-xs", server.parentId ? "text-danger" : "text-muted")}>
                {server.parentId ??
                  (hasChildren
                    ? "It has subcategories of its own, so it stays at the top level — categories nest one level."
                    : "Categories nest one level. A parent's page lists its subcategories' posts too.")}
              </p>
            </div>
          )}

          <fieldset className="space-y-4 border-t border-line pt-4">
            <legend className="sr-only">Search and sharing</legend>
            <div>
              <h3 className="text-sm font-semibold text-text">Search and sharing</h3>
              <p className="mt-0.5 text-xs text-muted">For its page on the site. Left blank, the name and the description are used.</p>
            </div>
            <TextField
              label="Search title"
              value={draft.seoTitle}
              onChange={(v) => set("seoTitle", v)}
              max={SEO_TITLE_MAX}
              readOnly={action.pending}
              placeholder={name || undefined}
              error={server["seo.title"]}
            />
            <TextAreaField
              label="Search description"
              value={draft.seoDescription}
              onChange={(v) => set("seoDescription", v)}
              max={SEO_DESCRIPTION_MAX}
              rows={2}
              readOnly={action.pending}
              placeholder={draft.description.trim() ? draft.description.trim().slice(0, 160) : undefined}
              error={server["seo.description"]}
            />
            <div role="group" aria-labelledby={`${parentFieldId}-image`} className="space-y-1.5">
              <p id={`${parentFieldId}-image`} className="text-[13px] font-medium text-muted">
                Sharing image
              </p>
              <div className={cn("flex flex-wrap items-center gap-3 rounded-lg border p-3", server["seo.imageMediaId"] ? "border-danger" : "border-line")}>
                <div className="grid h-14 w-24 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-surface-sunken">
                  {draft.image ? (
                    // A library image on this host (the proxy serves /media/<id> here too).
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={draft.image} alt={knownImage?.alt || "The chosen image"} className="h-full w-full object-cover" />
                  ) : (
                    <ImageOff aria-hidden="true" className="h-5 w-5 text-subtle" />
                  )}
                </div>
                <div className="min-w-0 flex-1 text-xs">
                  {draft.image ? (
                    <>
                      <p className="truncate text-sm font-medium text-text">{knownImage?.filename ?? "Library image"}</p>
                      {knownImage?.width && knownImage.height ? <p className="text-muted">{`${knownImage.width} × ${knownImage.height}`}</p> : null}
                    </>
                  ) : (
                    <p className="text-muted">None — the site&apos;s default sharing image is used.</p>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button ref={chooseRef} type="button" variant="secondary" size="sm" onClick={() => showLibrary(true)} disabled={action.pending}>
                    <ImagePlus aria-hidden="true" className="h-4 w-4" />
                    {draft.image ? "Change…" : "Choose image…"}
                  </Button>
                  {draft.image && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => set("image", "")} disabled={action.pending}>
                      Remove
                    </Button>
                  )}
                </div>
              </div>
              {server["seo.imageMediaId"] && <p className="text-xs text-danger">{server["seo.imageMediaId"]}</p>}
            </div>
          </fieldset>

          <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
          <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="secondary" onClick={close} disabled={action.pending}>
              Cancel
            </Button>
            <Button type="submit" aria-disabled={action.pending || undefined} aria-busy={action.pending || undefined} className={action.pending ? "cursor-wait opacity-70" : undefined}>
              {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
              {row ? "Save" : `Add ${words.one}`}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** "New category" / "New tag", for the page header: the dialog is mounted while open, so each opening starts clean. */
export function NewTermButton({ kind, parents = [] }: { kind: TermKind; parents?: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <Plus aria-hidden="true" className="h-4 w-4" />
        {kind === "category" ? "New category" : "New tag"}
      </Button>
      {open && <TermDialog kind={kind} row={null} parents={parents} image={null} onClose={() => setOpen(false)} />}
    </>
  );
}
