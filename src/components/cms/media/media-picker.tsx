"use client";

import { useEffect, useEffectEvent, useId, useRef, useState, useTransition } from "react";
import { Check, ImageOff, LoaderCircle, Search, TriangleAlert } from "lucide-react";
import { cmsListMedia, cmsUpdateMediaAlt } from "@/actions/cms/media";
import { UploadZone } from "@/components/cms/media/upload-zone";
import { formatBytes, useUploads } from "@/components/cms/media/use-uploads";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import type { MediaRow } from "@/lib/cms/types";
import { cn } from "@/lib/utils";

/**
 * The media library in a dialog, for choosing an image: search it, page through it, upload new ones
 * (which are then chosen for you), see the chosen image's alt text — and, where the role allows, write
 * it on the spot, since nothing can be published with an image that has none.
 */
export function MediaPicker({ open, onClose, onPick, canUpload }: { open: boolean; onClose: () => void; onPick: (row: MediaRow) => void; canUpload: boolean }) {
  return (
    <Dialog open={open} onClose={onClose} title="Choose an image" wide>
      {open && <PickerBody onPick={onPick} canUpload={canUpload} />}
    </Dialog>
  );
}

type Listing = { rows: MediaRow[]; total: number; page: number; pageSize: number };

function PickerBody({ onPick, canUpload }: { onPick: (row: MediaRow) => void; canUpload: boolean }) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MediaRow | null>(null);
  const [loading, startLoading] = useTransition();
  const timer = useRef<number | undefined>(undefined);
  const request = useRef(0);

  const load = (q: string, page: number, append: boolean) => {
    const ticket = ++request.current;
    startLoading(async () => {
      try {
        const result = await cmsListMedia({ q, page });
        if (ticket !== request.current) return;
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setError(null);
        setListing((prev) => (append && prev ? { ...result.data, rows: [...prev.rows, ...result.data.rows.filter((r) => !prev.rows.some((p) => p.id === r.id))] } : result.data));
      } catch {
        if (ticket === request.current) setError("The library didn't load. Try again.");
      }
    });
  };

  // The first page, once, when the dialog opens.
  const firstLoad = useEffectEvent(() => load("", 1, false));
  useEffect(() => {
    const pending = timer;
    const frame = window.requestAnimationFrame(() => firstLoad());
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(pending.current);
    };
  }, []);

  const uploads = useUploads((rows) => {
    setListing((prev) => (prev ? { ...prev, rows: [...rows, ...prev.rows.filter((p) => !rows.some((r) => r.id === p.id))], total: prev.total + rows.length } : prev));
    setSelected(rows[rows.length - 1] ?? null);
  });

  const rows = listing?.rows ?? [];
  const more = listing ? listing.page * listing.pageSize < listing.total : false;

  return (
    <div className="grid gap-5 p-0.5 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="min-w-0 space-y-3">
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-subtle" />
          <Label htmlFor={searchId} className="sr-only">
            Search the library
          </Label>
          <Input
            id={searchId}
            type="search"
            value={query}
            placeholder="Search by file name or alt text"
            onChange={(e) => {
              const q = e.target.value;
              setQuery(q);
              window.clearTimeout(timer.current);
              timer.current = window.setTimeout(() => load(q.trim(), 1, false), 300);
            }}
            className="pl-8"
          />
        </div>

        {error && (
          <p role="alert" className="flex items-center gap-1.5 text-sm text-danger">
            <TriangleAlert aria-hidden="true" className="h-4 w-4" />
            {error}
          </p>
        )}

        {listing === null && !error ? (
          <div role="status" className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            <span className="sr-only">Loading the library…</span>
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} aria-hidden="true" className="aspect-square animate-pulse rounded-lg bg-surface-sunken" />
            ))}
          </div>
        ) : rows.length === 0 && !loading ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong px-6 py-10 text-center">
            <ImageOff aria-hidden="true" className="h-6 w-6 text-subtle" />
            <p className="text-sm text-text">{query.trim() ? `No image matches “${query.trim()}”.` : "The library is empty."}</p>
            {canUpload && <p className="text-xs text-muted">Upload one below.</p>}
          </div>
        ) : (
          <ul aria-label="Images" className="grid max-h-[46vh] grid-cols-3 gap-2 overflow-y-auto p-0.5 sm:grid-cols-4">
            {rows.map((row) => {
              const on = selected?.id === row.id;
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => setSelected(row)}
                    onDoubleClick={() => onPick(row)}
                    title={row.filename}
                    className={cn("group relative block aspect-square w-full overflow-hidden rounded-lg border bg-surface-sunken", on ? "border-brand ring-brand" : "border-line hover:border-line-strong")}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={row.url} alt={row.alt || row.filename} loading="lazy" className="h-full w-full object-contain" />
                    {row.needsAlt && (
                      <span className="absolute bottom-1 left-1 rounded-full bg-warning-bg px-1.5 py-px text-[10px] font-medium text-warning">No alt text</span>
                    )}
                    {on && (
                      <span aria-hidden="true" className="absolute top-1 right-1 grid h-5 w-5 place-items-center rounded-full bg-brand text-brand-contrast">
                        <Check className="h-3 w-3" />
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-subtle">{listing ? `${rows.length} of ${listing.total} shown` : ""}</p>
          {more && (
            <Button type="button" variant="secondary" size="sm" onClick={() => listing && load(query.trim(), listing.page + 1, true)} disabled={loading}>
              {loading && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
              Load more
            </Button>
          )}
        </div>

        {canUpload && <UploadZone compact items={uploads.items} busy={uploads.busy} onFiles={(files) => void uploads.start(files)} onClear={uploads.clearFinished} />}
      </div>

      <aside aria-label="Chosen image" className="min-w-0 space-y-3 lg:border-l lg:border-line lg:pl-5">
        {selected ? (
          <SelectedImage key={selected.id} row={selected} canEdit={canUpload} onPick={onPick} onChanged={(row) => {
            setSelected(row);
            setListing((prev) => (prev ? { ...prev, rows: prev.rows.map((r) => (r.id === row.id ? row : r)) } : prev));
          }} />
        ) : (
          <p className="text-sm text-muted">Choose an image to see it here. Double-click to use it straight away.</p>
        )}
      </aside>
    </div>
  );
}

function SelectedImage({ row, canEdit, onPick, onChanged }: { row: MediaRow; canEdit: boolean; onPick: (row: MediaRow) => void; onChanged: (row: MediaRow) => void }) {
  const altId = useId();
  const [alt, setAlt] = useState(row.alt);
  const [pending, startSaving] = useTransition();
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const saveAlt = () =>
    startSaving(async () => {
      try {
        const result = await cmsUpdateMediaAlt(row.id, alt);
        if (!result.ok) {
          setMessage({ tone: "error", text: result.error });
          return;
        }
        setMessage({ tone: "ok", text: "Alt text saved." });
        onChanged(result.data);
      } catch {
        setMessage({ tone: "error", text: "That didn't save. Try again." });
      }
    });

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-line bg-surface-sunken">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={row.url} alt={row.alt || row.filename} className="max-h-48 w-full object-contain" />
      </div>
      <div className="text-xs">
        <p className="font-medium break-all text-text">{row.filename}</p>
        <p className="mt-0.5 text-muted">
          {row.width && row.height ? `${row.width} × ${row.height} · ` : ""}
          {formatBytes(row.size)}
        </p>
      </div>
      {canEdit ? (
        <div className="space-y-1.5">
          <Label htmlFor={altId}>Alt text</Label>
          <Textarea id={altId} value={alt} rows={3} maxLength={300} onChange={(e) => setAlt(e.target.value)} placeholder="What the image shows" />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-subtle tabular-nums">{alt.length}/300</span>
            <Button type="button" variant="secondary" size="sm" onClick={saveAlt} disabled={pending || alt.trim() === row.alt}>
              {pending && <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
              Save alt text
            </Button>
          </div>
          {row.needsAlt && !message && <p className="text-xs text-warning">Needed before a page with this image can be published.</p>}
          {message && (
            <p role={message.tone === "error" ? "alert" : "status"} className={cn("text-xs", message.tone === "error" ? "text-danger" : "text-success")}>
              {message.text}
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted">{row.alt ? `Alt: ${row.alt}` : "No alt text yet."}</p>
      )}
      <Button type="button" className="w-full" onClick={() => onPick(row)}>
        Use this image
      </Button>
    </>
  );
}
