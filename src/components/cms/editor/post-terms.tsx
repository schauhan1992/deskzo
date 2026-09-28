"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { Plus, Star, X } from "lucide-react";
import { cmsSearchTags } from "@/actions/cms/tags";
import { tagProblem } from "@/components/cms/editor/checks";
import { IssueScope, useIssuesAt } from "@/components/cms/editor/editor-context";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Label } from "@/components/ui/input";
import { useComboboxKeyboard } from "@/components/ui/use-combobox-keyboard";
import { CMS_ROUTES } from "@/lib/cms/nav";
import { TERM_SLUG_MAX, type CategoryNode, type CmsTermRef } from "@/lib/cms/types";
import { slugify } from "@/lib/cms/validate";
import { cn } from "@/lib/utils";

/**
 * A post's categories and tags, in its editor.
 *
 *   · Tags are a token input: type to search the tags there are (cmsSearchTags), pick one, or press
 *     Enter (or a comma) to add what was typed — a name nobody has used yet becomes a new tag when the
 *     post is saved. The editor keeps an existing tag by its address and a new one by its name; the
 *     server matches either (src/lib/cms/taxonomy.ts planPostTerms).
 *   · Categories are a checklist of the curated tree, sent as ids; the first chosen is the post's main
 *     category (the site's breadcrumb), and any other can be made main.
 *
 * Read-only is the editor's `<fieldset disabled>` around them, as for every other field.
 */

export const MAX_TAGS = 10;
export const MAX_CATEGORIES = 10;
const SEARCH_LIMIT = 8;

/** Tag names by address, as the editor learns them: the post's own tags, then whatever a search finds. */
export type TagNames = Record<string, string>;

/** Every spelling a chosen tag answers to: its entry, its name and their addresses, lower-case. */
function tagKeys(values: string[], names: TagNames): Set<string> {
  const keys = new Set<string>();
  for (const v of values) {
    keys.add(v.toLowerCase());
    keys.add(slugify(v, TERM_SLUG_MAX));
    const name = names[v];
    if (name) {
      keys.add(name.toLowerCase());
      keys.add(slugify(name, TERM_SLUG_MAX));
    }
  }
  keys.delete("");
  return keys;
}

const clean = (raw: string) => raw.replace(/^#+/, "").replace(/\s+/g, " ").trim();

/** Whether a tag the editor holds is one the site has (its address is known) or a name that becomes a new tag on save. */
function isKnownTag(value: string, names: TagNames): boolean {
  if (names[value]) return true;
  const lower = value.toLowerCase();
  return Object.entries(names).some(([slug, name]) => slug === lower || name.toLowerCase() === lower);
}

type SearchState = { query: string; results: CmsTermRef[]; loading: boolean; error: string | null };

export function TagsTokenField({
  value,
  onChange,
  names,
  onLearn,
}: {
  /** Existing tags' addresses and new tags' names, in order. */
  value: string[];
  onChange: (next: string[]) => void;
  names: TagNames;
  /** Tags a search found or the person picked — so their chips show names. */
  onLearn: (refs: CmsTermRef[]) => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const anchorRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState<SearchState>({ query: "", results: [], loading: false, error: null });
  /** Only the newest request's answer is shown: a slow "pro" must not land over "product". */
  const ticket = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const full = value.length >= MAX_TAGS;

  useEffect(() => {
    const pending = timer;
    return () => window.clearTimeout(pending.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (anchorRef.current?.contains(target)) return;
      if (target.closest?.("[data-tag-token-panel]")) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  /** Asks for the tags matching `query` after a pause in the typing; the answer lands in state when it arrives. */
  function lookUp(query: string, delay = 200) {
    window.clearTimeout(timer.current);
    const mine = ++ticket.current;
    setSearch((s) => ({ ...s, loading: true, error: null }));
    timer.current = window.setTimeout(() => {
      cmsSearchTags(query, SEARCH_LIMIT + MAX_TAGS).then(
        (r) => {
          if (mine !== ticket.current) return;
          if (!r.ok) setSearch({ query, results: [], loading: false, error: r.error });
          else {
            setSearch({ query, results: r.data, loading: false, error: null });
            onLearn(r.data);
          }
        },
        () => {
          if (mine === ticket.current) setSearch({ query, results: [], loading: false, error: "The tags could not be searched. Type the tag and press Enter." });
        },
      );
    }, delay);
  }

  const chosen = tagKeys(value, names);
  const typed = clean(text);
  const typedLower = typed.toLowerCase();
  const typedSlug = slugify(typed, TERM_SLUG_MAX);
  const results = search.results.filter((t) => !chosen.has(t.slug) && !chosen.has(t.name.toLowerCase())).slice(0, SEARCH_LIMIT);
  const exact = typed ? search.results.find((t) => t.name.toLowerCase() === typedLower || t.slug === typedLower || (typedSlug && t.slug === typedSlug)) : undefined;
  const alreadyChosen = typed !== "" && (chosen.has(typedLower) || (typedSlug !== "" && chosen.has(typedSlug)));
  const typedProblem = typed ? tagProblem(typed) : null;
  const offerNew = typed !== "" && !exact && !alreadyChosen && !typedProblem;
  const optionCount = results.length + (offerNew ? 1 : 0);

  /** Adds an existing tag (by its address) or a new name — once, and never an eleventh. */
  function add(entry: string) {
    const next = clean(entry);
    if (!next || full) return;
    const keys = tagKeys(value, names);
    if (keys.has(next.toLowerCase()) || keys.has(slugify(next, TERM_SLUG_MAX))) return;
    onChange([...value, next]);
  }

  function pick(tag: CmsTermRef) {
    onLearn([tag]);
    add(tag.slug);
    setText("");
    setOpen(false);
  }

  /** What Enter or a comma does with the typed text: the tag it names if there is one, else a new tag. */
  function commitTyped(raw: string) {
    const entry = clean(raw);
    if (!entry) return;
    const lower = entry.toLowerCase();
    const slug = slugify(entry, TERM_SLUG_MAX);
    const match = search.results.find((t) => t.name.toLowerCase() === lower || t.slug === lower || (slug && t.slug === slug));
    if (match) {
      pick(match);
      return;
    }
    add(entry);
    setText("");
    setOpen(false);
  }

  const combobox = useComboboxKeyboard({
    label: "Tags",
    optionCount,
    isOpen: open && optionCount > 0,
    setOpen,
    onChoose: (index) => {
      if (index < results.length) pick(results[index]!);
      else commitTyped(text);
    },
    resetKey: `${search.query}|${results.map((r) => r.id).join(",")}|${offerNew}`,
  });

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    combobox.comboboxProps.onKeyDown(e);
    if (e.defaultPrevented) return;
    if ((e.key === "Enter" || e.key === ",") && typed) {
      e.preventDefault();
      commitTyped(text);
    } else if (e.key === "Enter") {
      // An empty Enter never submits anything from here.
      e.preventDefault();
    } else if (e.key === "Backspace" && !text && value.length) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  }

  const topMessages = useIssuesAt("tags");

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <Label htmlFor={id}>
          Tags<span className="font-normal text-subtle"> (optional)</span>
        </Label>
        <span className="text-[11px] text-subtle tabular-nums">
          {value.length}/{MAX_TAGS}
          <span className="sr-only"> tags</span>
        </span>
      </div>
      <div
        ref={anchorRef}
        className={cn(
          "flex min-h-9 flex-wrap items-center gap-1.5 rounded-base border bg-surface px-2 py-1.5 shadow-sm",
          topMessages.length ? "border-danger" : "border-line-strong",
        )}
      >
        <IssueScope prefix="tags">
          <ul aria-label="Tags on this post" className="contents">
            {value.map((tag, index) => (
              <TagChip key={tag} index={index} tag={tag} name={names[tag] ?? tag} isNew={!isKnownTag(tag, names)} onRemove={() => onChange(value.filter((t) => t !== tag))} />
            ))}
          </ul>
        </IssueScope>
        <input
          id={id}
          value={text}
          onChange={(e) => {
            const next = e.target.value;
            if (next.endsWith(",")) {
              commitTyped(next.slice(0, -1));
              return;
            }
            setText(next.slice(0, 80));
            setOpen(true);
            lookUp(clean(next));
          }}
          onFocus={() => {
            setOpen(true);
            if (search.query !== typed || (!search.results.length && !search.loading)) lookUp(typed, 0);
          }}
          placeholder={value.length ? "" : "Search tags, or type a new one"}
          disabled={full}
          autoComplete="off"
          autoCapitalize="off"
          data-1p-ignore=""
          data-lpignore="true"
          aria-describedby={hintId}
          {...combobox.comboboxProps}
          onKeyDown={onKeyDown}
          className="min-w-32 flex-1 rounded-sm bg-transparent text-sm text-text placeholder:text-subtle focus-visible:outline-offset-1"
        />
      </div>
      <AnchoredPopover anchorRef={anchorRef} open={open && !full && (optionCount > 0 || search.loading || !!search.error)} maxHeight={280}>
        <div data-tag-token-panel="" className="py-1">
          <div {...combobox.listboxProps}>
            {results.map((tag, index) => (
              <button
                key={tag.id}
                type="button"
                onClick={() => pick(tag)}
                {...combobox.optionProps(index)}
                className={cn("flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-sunken", combobox.activeIndex === index && "bg-surface-sunken")}
              >
                <span className="truncate text-text">#{tag.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-subtle">{tag.slug}</span>
              </button>
            ))}
            {offerNew && (
              <button
                type="button"
                onClick={() => commitTyped(text)}
                {...combobox.optionProps(results.length)}
                className={cn(
                  "flex w-full items-center gap-2 border-t border-line px-3 py-1.5 text-left text-sm text-brand hover:bg-surface-sunken",
                  combobox.activeIndex === results.length && "bg-surface-sunken",
                )}
              >
                <Plus aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">Add “{typed}” as a new tag</span>
              </button>
            )}
          </div>
          {search.loading && optionCount === 0 && <p className="px-3 py-1.5 text-xs text-subtle">Searching…</p>}
          {search.error && <p className="px-3 py-1.5 text-xs text-danger">{search.error}</p>}
        </div>
      </AnchoredPopover>
      <p id={hintId} className="text-xs text-subtle">
        {full
          ? `That's the most a post can have. Remove one to add another.`
          : "Pick a tag, or type a new one and press Enter or a comma. New tags are added to the site when the post is saved."}
      </p>
      {typedProblem && <p className="text-xs text-danger">{typedProblem}</p>}
      {topMessages.map((m, i) => (
        <p key={i} className="text-xs text-danger">
          {m}
        </p>
      ))}
    </div>
  );
}

/** One chosen tag, with its own problems (from the check as you type, or from the server's save). */
function TagChip({ index, tag, name, isNew, onRemove }: { index: number; tag: string; name: string; isNew: boolean; onRemove: () => void }) {
  const messages = useIssuesAt(`[${index}]`);
  const bad = messages.length > 0;
  return (
    <li
      title={bad ? messages.join(" ") : isNew ? "A new tag: it is added when the post is saved." : `/blog/tag/${tag}`}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
        bad ? "border-danger/40 bg-danger-bg text-danger" : isNew ? "border-brand/40 bg-brand-subtle text-brand" : "border-line bg-surface-sunken text-text",
      )}
    >
      <span className="truncate">#{name}</span>
      {isNew && !bad && <span className="text-[10px] font-medium tracking-wide uppercase">new</span>}
      {bad && <span className="sr-only">{`: ${messages.join(" ")}`}</span>}
      <button type="button" onClick={onRemove} aria-label={`Remove the tag ${name}`} className="rounded-full text-subtle hover:text-text">
        <X aria-hidden="true" className="h-3 w-3" />
      </button>
    </li>
  );
}

/**
 * The post's categories: the curated tree as a checklist (children under their parent), and the
 * chosen ones in order — the first is the main one, which the site's breadcrumb shows.
 */
export function CategoriesField({ value, onChange, categories, canManage }: { value: string[]; onChange: (next: string[]) => void; categories: CategoryNode[]; canManage: boolean }) {
  const id = useId();
  const messages = useIssuesAt("categories");
  const byId = new Map<string, { name: string; parent: string | null }>();
  for (const top of categories) {
    byId.set(top.id, { name: top.name, parent: null });
    for (const child of top.children) byId.set(child.id, { name: child.name, parent: top.name });
  }
  const full = value.length >= MAX_CATEGORIES;

  function toggle(categoryId: string, on: boolean) {
    if (on) {
      if (!value.includes(categoryId) && !full) onChange([...value, categoryId]);
    } else onChange(value.filter((v) => v !== categoryId));
  }

  function makeMain(categoryId: string) {
    onChange([categoryId, ...value.filter((v) => v !== categoryId)]);
  }

  const checkbox = (categoryId: string, name: string, child: boolean) => {
    const checked = value.includes(categoryId);
    return (
      <li key={categoryId} className={cn(child && "pl-6")}>
        <label className="flex cursor-pointer items-center gap-2 rounded-base px-2 py-1 text-sm text-text hover:bg-surface-sunken">
          <input type="checkbox" checked={checked} disabled={!checked && full} onChange={(e) => toggle(categoryId, e.target.checked)} className="h-4 w-4 shrink-0 accent-brand" />
          <span className="truncate">{name}</span>
          {checked && value[0] === categoryId && <span className="ml-auto shrink-0 text-[11px] font-medium text-brand">Main</span>}
        </label>
      </li>
    );
  };

  return (
    <fieldset className="min-w-0 space-y-1.5" aria-describedby={`${id}-hint`}>
      <legend className="mb-1.5 w-full text-[13px] font-medium text-muted">
        Categories<span className="font-normal text-subtle"> (optional)</span>
        <span className="float-right text-[11px] font-normal text-subtle tabular-nums">
          {value.length}/{MAX_CATEGORIES}
          <span className="sr-only"> chosen</span>
        </span>
      </legend>

      {value.length > 0 && (
        <ol aria-label="Chosen categories, the main one first" className="flex flex-wrap gap-1.5">
          {value.map((categoryId, index) => {
            const known = byId.get(categoryId);
            const name = known ? (known.parent ? `${known.parent} › ${known.name}` : known.name) : "A deleted category";
            return (
              <li key={categoryId} className={cn("inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs", index === 0 ? "border-brand/40 bg-brand-subtle text-brand" : known ? "border-line bg-surface-sunken text-text" : "border-danger/40 bg-danger-bg text-danger")}>
                {index === 0 && <Star aria-hidden="true" className="h-3 w-3 shrink-0" />}
                <span className="truncate">{name}</span>
                {index === 0 ? (
                  <span className="sr-only"> (main category)</span>
                ) : (
                  <button type="button" onClick={() => makeMain(categoryId)} aria-label={`Make ${name} the main category`} className="rounded-full px-1 text-[11px] font-medium text-brand hover:underline">
                    Make main
                  </button>
                )}
                <button type="button" onClick={() => toggle(categoryId, false)} aria-label={`Remove the category ${name}`} className="rounded-full text-subtle hover:text-text">
                  <X aria-hidden="true" className="h-3 w-3" />
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {categories.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3 py-3 text-xs text-muted">
          There are no categories yet.{" "}
          {canManage ? (
            <Link href={CMS_ROUTES.categories} className="font-medium text-brand hover:underline">
              Add some in Categories
            </Link>
          ) : (
            "An editor or admin adds them."
          )}
        </p>
      ) : (
        <ul aria-label="Categories" className="max-h-52 space-y-0.5 overflow-y-auto rounded-lg border border-line p-1">
          {categories.map((top) => [checkbox(top.id, top.name, false), ...top.children.map((child) => checkbox(child.id, child.name, true))])}
        </ul>
      )}
      <p id={`${id}-hint`} className="text-xs text-subtle">
        The first is the post&apos;s main category — the site shows it in the breadcrumb. A category&apos;s page lists its subcategories&apos; posts too.
      </p>
      {messages.map((m, i) => (
        <p key={i} className="text-xs text-danger">
          {m}
        </p>
      ))}
      <IssueScope prefix="categories">
        <CategoryIssues count={value.length} />
      </IssueScope>
    </fieldset>
  );
}

/** The server's word on one chosen category ("That category no longer exists."), for the ones it names. */
function CategoryIssues({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: Math.min(count, MAX_CATEGORIES + 5) }, (_, i) => (
        <CategoryIssue key={i} index={i} />
      ))}
    </>
  );
}

function CategoryIssue({ index }: { index: number }) {
  const messages = useIssuesAt(`[${index}]`);
  if (!messages.length) return null;
  return <p className="text-xs text-danger">{`Category ${index + 1}: ${messages.join(" ")}`}</p>;
}
