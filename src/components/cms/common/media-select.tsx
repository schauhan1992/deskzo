"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, Check, ImageOff, ImagePlus, LoaderCircle, RotateCw, Search, TriangleAlert } from "lucide-react";
import { cmsListMedia } from "@/actions/cms/media";
import { StatusPill } from "@/components/console/kit/status";
import { Skeleton } from "@/components/console/kit/skeleton";
import { ActionNotice } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { OutboundLink } from "@/components/ui/outbound-link";
import { CMS_ROUTES } from "@/lib/cms/nav";
import type { MediaRow } from "@/lib/cms/types";
import { cn } from "@/lib/utils";

/**
 * One image from the media library, for a settings field (the site's default sharing image): what is
 * chosen now, and a dialog that lists the library to choose another — searched by file name or alt
 * text, 48 at a time. The value is the image's "/media/<id>" address, which is the only kind of image
 * the site accepts. Uploading happens in the media library itself (a new tab, so nothing typed here
 * is lost); "Refresh" then shows the new image.
 *
 * The page editor's full picker is the media library's own (src/components/cms/media); this is the
 * small one the site settings need.
 */

function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Thumb({ src, alt, className }: { src: string; alt: string; className?: string }) {
  return (
    // A library image on this host (the proxy serves /media/<id> here too). Plain <img>: the bytes are
    // already sized and cached for a year, and next/image would only proxy them back to itself.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} loading="lazy" decoding="async" className={cn("block h-full w-full object-cover", className)} />
  );
}

export function MediaSelect({
  label,
  description,
  value,
  onChange,
  initial,
  error,
  readOnly = false,
}: {
  label: string;
  description?: string;
  /** "/media/<id>", or "" for none. */
  value: string;
  onChange: (value: string) => void;
  /** The library row of the value the page loaded with, for its name and alt text. */
  initial: MediaRow | null;
  error?: string | null;
  readOnly?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<MediaRow | null>(null);
  const known = picked && picked.url === value ? picked : initial && initial.url === value ? initial : null;
  const descId = `${id}-desc`;
  const errorId = `${id}-error`;

  return (
    <div role="group" aria-labelledby={`${id}-label`} aria-describedby={[description ? descId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined} className="min-w-0 space-y-1.5">
      <p id={`${id}-label`} className="text-[13px] font-medium text-muted">
        {label}
      </p>
      {description && (
        <p id={descId} className="text-xs text-muted">
          {description}
        </p>
      )}
      <div className={cn("flex flex-wrap items-center gap-3 rounded-lg border p-3", error ? "border-danger" : "border-line")}>
        <div className="grid h-16 w-28 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-surface-sunken">
          {value ? <Thumb src={value} alt={known?.alt || "The chosen image"} /> : <ImageOff aria-hidden="true" className="h-5 w-5 text-subtle" />}
        </div>
        <div className="min-w-0 flex-1 text-xs">
          {value ? (
            <>
              <p className="truncate text-sm font-medium text-text">{known?.filename ?? "Library image"}</p>
              <p className="mt-0.5 text-muted">
                {known ? [known.width && known.height ? `${known.width} × ${known.height}` : null, sizeText(known.size)].filter(Boolean).join(" · ") : value}
              </p>
              {known?.needsAlt && (
                <p className="mt-1 inline-flex items-center gap-1 text-warning">
                  <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5" />
                  No alt text yet — add it in the media library before publishing.
                </p>
              )}
            </>
          ) : (
            <p className="text-muted">No image chosen.</p>
          )}
        </div>
        {!readOnly && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog">
              <ImagePlus aria-hidden="true" className="h-4 w-4" />
              {value ? "Change…" : "Choose image…"}
            </Button>
            {value && (
              <Button type="button" variant="ghost" size="sm" onClick={() => onChange("")}>
                Remove
              </Button>
            )}
          </div>
        )}
      </div>
      {error && (
        <p id={errorId} className="text-xs text-danger">
          {error}
        </p>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title={`Choose ${label.toLowerCase()}`} wide>
        {open && (
          <LibraryGrid
            current={value}
            onChoose={(row) => {
              setPicked(row);
              onChange(row.url);
              setOpen(false);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

type LoadState = { rows: MediaRow[]; total: number; page: number; loading: boolean; error: string | null; loaded: boolean };

/**
 * The library inside the dialog. Mounted while the dialog is open, so each opening starts fresh.
 * Exported for a dialog that picks an image in place (a category's or tag's sharing image), where a
 * second dialog on top of the first would fight it for the focus trap.
 */
export function LibraryGrid({ current, onChoose }: { current: string; onChoose: (row: MediaRow) => void }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<LoadState>({ rows: [], total: 0, page: 0, loading: true, error: null, loaded: false });
  /** Only the newest request's answer is shown: a slow page 1 for "log" must not land over "logo". */
  const ticket = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  /** Asks for one page; the answer lands in state when it arrives (never synchronously). */
  function fetchPage(q: string, page: number) {
    const mine = ++ticket.current;
    cmsListMedia({ q, page }).then(
      (r) => {
        if (mine !== ticket.current) return;
        if (!r.ok) {
          setState((s) => ({ ...s, loading: false, error: r.error }));
          return;
        }
        setState((s) => ({
          rows: page === 1 ? r.data.rows : [...s.rows, ...r.data.rows.filter((row) => !s.rows.some((x) => x.id === row.id))],
          total: r.data.total,
          page,
          loading: false,
          error: null,
          loaded: true,
        }));
      },
      () => {
        if (mine === ticket.current) setState((s) => ({ ...s, loading: false, error: "The library could not be reached. Try again." }));
      },
    );
  }

  function load(q: string, page: number) {
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchPage(q, page);
  }

  // The first page, once, when the dialog opens (the state starts as loading). The answer arrives
  // through the promise in fetchPage, never in this effect's own body.
  const started = useRef(false);
  useEffect(() => {
    const pending = timer;
    if (!started.current) {
      started.current = true;
      fetchPage("", 1);
    }
    return () => window.clearTimeout(pending.current);
  }, []);

  function onSearch(next: string) {
    setQuery(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => load(next.trim(), 1), 300);
  }

  const more = state.rows.length < state.total;
  const searchId = `${id}-search`;

  return (
    <div className="space-y-4 p-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={searchId} className="sr-only">
          Search the media library
        </label>
        <div className="relative min-w-0 flex-1">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-subtle" />
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(e) => onSearch(e.target.value.slice(0, 100))}
            placeholder="File name or alt text"
            autoComplete="off"
            data-1p-ignore=""
            className="h-9 w-full rounded-base border border-line-strong bg-surface pr-3 pl-8 text-sm text-text placeholder:text-subtle"
          />
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => load(query.trim(), 1)}>
          <RotateCw aria-hidden="true" className={cn("h-4 w-4", state.loading && "animate-spin")} />
          Refresh
        </Button>
        <OutboundLink href={CMS_ROUTES.mediaUpload} className="inline-flex h-8 items-center gap-1 rounded-base px-2 text-[13px] font-medium text-brand hover:underline">
          Upload in the library
          <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="sr-only"> (opens in a new tab)</span>
        </OutboundLink>
      </div>

      <div aria-live="polite" className="sr-only">
        {state.loaded && !state.loading ? `${state.total.toLocaleString("en-IN")} image${state.total === 1 ? "" : "s"}` : ""}
      </div>

      {state.error && <ActionNotice tone="error">{state.error}</ActionNotice>}

      {!state.loaded && state.loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="aspect-[4/3] w-full rounded-lg" />
          ))}
        </div>
      ) : state.rows.length === 0 && !state.error ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line px-6 py-10 text-center">
          <ImageOff aria-hidden="true" className="h-5 w-5 text-subtle" />
          <p className="text-sm font-medium text-text">{query.trim() ? "No image matches that" : "The library is empty"}</p>
          <p className="max-w-sm text-xs text-muted">{query.trim() ? "Try part of the file name, or clear the search." : "Upload an image in the media library, then refresh this list."}</p>
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {state.rows.map((row) => {
            const chosen = row.url === current;
            return (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => onChoose(row)}
                  aria-pressed={chosen}
                  aria-label={`Choose ${row.filename}${row.alt ? ` — ${row.alt}` : ""}${row.needsAlt ? " (no alt text yet)" : ""}`}
                  className={cn(
                    "group block w-full overflow-hidden rounded-lg border text-left transition-colors",
                    chosen ? "border-brand ring-2 ring-brand/30" : "border-line hover:border-line-strong",
                  )}
                >
                  <span className="relative block aspect-[4/3] bg-surface-sunken">
                    <Thumb src={row.url} alt="" />
                    {chosen && (
                      <span aria-hidden="true" className="absolute top-1.5 right-1.5 grid h-5 w-5 place-items-center rounded-full bg-brand text-brand-contrast">
                        <Check className="h-3 w-3" />
                      </span>
                    )}
                  </span>
                  <span className="block space-y-1 px-2 py-1.5">
                    <span className="block truncate text-xs font-medium text-text">{row.filename}</span>
                    {row.needsAlt ? (
                      <StatusPill tone="warning">No alt text</StatusPill>
                    ) : (
                      <span className="block truncate text-[11px] text-muted">{row.width && row.height ? `${row.width} × ${row.height}` : sizeText(row.size)}</span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {more && (
        <div className="flex justify-center">
          <Button type="button" variant="secondary" size="sm" onClick={() => {
              if (!state.loading) load(query.trim(), state.page + 1);
            }}
            aria-disabled={state.loading || undefined}
          >
            {state.loading && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
            Show more ({(state.total - state.rows.length).toLocaleString("en-IN")} left)
          </Button>
        </div>
      )}
    </div>
  );
}
