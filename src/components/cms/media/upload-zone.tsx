"use client";

import { useId, useRef, useState, type DragEvent } from "react";
import { CircleAlert, CircleCheck, ImageUp, LoaderCircle } from "lucide-react";
import { formatBytes, type UploadItem } from "@/components/cms/media/use-uploads";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Where images go in: drop them on the zone or choose them with the button (several at once), then
 * watch each one's own line — waiting, uploading, done (or "already in the library"), or refused and
 * why. The file input is the real control; the zone is a larger target for a drop.
 */
export function UploadZone({ items, busy, onFiles, onClear, compact = false }: { items: UploadItem[]; busy: boolean; onFiles: (files: File[]) => void; onClear: () => void; compact?: boolean }) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length) onFiles(files);
  };

  const done = items.filter((i) => i.status === "done").length;
  const failed = items.filter((i) => i.status === "failed").length;
  const total = items.length;

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed text-center transition-colors",
          compact ? "px-4 py-5" : "px-6 py-10",
          over ? "border-brand bg-brand-subtle" : "border-line-strong bg-surface",
        )}
      >
        <ImageUp aria-hidden="true" className={cn("text-subtle", compact ? "h-6 w-6" : "h-8 w-8")} />
        <p className="text-sm text-text">
          <span className="font-medium">Drop images here</span> or
        </p>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length) onFiles(files);
          }}
          className="hidden"
        />
        <Button type="button" variant="secondary" size="sm" onClick={() => inputRef.current?.click()}>
          Choose images…
        </Button>
        <p className="text-xs text-subtle">PNG, JPEG, WebP or GIF, up to 5 MB each.</p>
      </div>

      {total > 0 && (
        <div className="rounded-lg border border-line bg-surface">
          <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
            <p role="status" className="text-xs text-muted">
              {busy ? `Uploading — ${done} of ${total - failed} done` : `${done} uploaded${failed ? `, ${failed} refused` : ""}`}
            </p>
            {!busy && (
              <Button type="button" variant="ghost" size="sm" onClick={onClear}>
                Clear
              </Button>
            )}
          </div>
          {busy && (
            <div className="h-1 bg-surface-sunken" aria-hidden="true">
              <div className="h-1 bg-brand transition-[width]" style={{ width: `${Math.round(((done + failed) / Math.max(1, total)) * 100)}%` }} />
            </div>
          )}
          <ul className="max-h-48 divide-y divide-line overflow-y-auto">
            {items.map((item) => (
              <li key={item.key} className="flex items-start gap-2 px-3 py-2 text-xs">
                {item.status === "done" ? (
                  <CircleCheck aria-hidden="true" className="mt-px h-4 w-4 shrink-0 text-success" />
                ) : item.status === "failed" ? (
                  <CircleAlert aria-hidden="true" className="mt-px h-4 w-4 shrink-0 text-danger" />
                ) : (
                  <LoaderCircle aria-hidden="true" className={cn("mt-px h-4 w-4 shrink-0 text-subtle", item.status === "uploading" && "animate-spin")} />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-text">
                    {item.name} <span className="font-normal text-subtle">· {formatBytes(item.size)}</span>
                  </p>
                  <p className={cn(item.status === "failed" ? "text-danger" : "text-muted")}>
                    {item.status === "waiting" && "Waiting…"}
                    {item.status === "uploading" && "Uploading…"}
                    {item.status === "done" && (item.duplicate ? "Already in the library — using that one." : item.row?.needsAlt ? "Uploaded. Add alt text before it goes on a page." : "Uploaded.")}
                    {item.status === "failed" && item.error}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
