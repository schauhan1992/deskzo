import type { ReactNode } from "react";
import { Download, FileText, Lock, Paperclip, Video } from "lucide-react";
import { RecordingPlayer } from "@/components/console/support/recording-player";
import type { SupportAttachmentView } from "@/lib/support/types";
import { cn } from "@/lib/utils";

/**
 * What came with a request: the screen recording (played from the file route), images as thumbnails
 * that open full size in a new tab, and other files as downloads. Every one is served by
 * /support-files/<id>, which checks the role, answers with the type the bytes were sniffed as, never
 * lets the browser guess another, and audits the opening.
 *
 * Only the staff who act on requests may open files (`canOpen`); read-only staff see what was
 * attached — name, type, size — and nothing to click. A file removed by retention is listed, not
 * linked. Server-safe; the recording's player is the one client piece (recording-player.tsx).
 */

const UNITS = ["KB", "MB", "GB"] as const;

/** 2048 → "2 KB", 1_572_864 → "1.5 MB". */
export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${UNITS[unit]}`;
}

/** 133_000 → "2:13". */
export function clockDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The file route's address — written out here, not taken from elsewhere, so it can only ever be this route. */
const fileHref = (a: SupportAttachmentView) => `/support-files/${encodeURIComponent(a.id)}`;

export function AttachmentGallery({ attachments, canOpen }: { attachments: SupportAttachmentView[]; canOpen: boolean }) {
  if (attachments.length === 0) {
    return <p className="text-sm text-muted">Nothing was attached.</p>;
  }

  const recordings = attachments.filter((a) => a.kind === "RECORDING");
  const images = attachments.filter((a) => a.kind === "FILE" && a.mime.startsWith("image/"));
  const files = attachments.filter((a) => a.kind === "FILE" && !a.mime.startsWith("image/"));

  return (
    <div className="space-y-5">
      {!canOpen && (
        <p className="inline-flex items-center gap-1.5 text-xs text-muted">
          <Lock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          Opening attachments is for owners, admins and support staff.
        </p>
      )}

      {recordings.map((a) => {
        const length = clockDuration(a.durationMs);
        const caption = `Screen recording${length ? ` · ${length}` : ""} · ${fileSize(a.size)}`;
        return (
          <figure key={a.id} className="space-y-2">
            {canOpen && !a.purged ? (
              <RecordingPlayer src={fileHref(a)} label={`Screen recording${length ? `, ${length} long` : ""}`} />
            ) : (
              <Placeholder icon={<Video className="h-5 w-5" />} text={a.purged ? "Removed by retention" : "Screen recording"} />
            )}
            <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              <span>{caption}</span>
              {canOpen && !a.purged && (
                <a href={fileHref(a)} download={a.filename} className="inline-flex items-center gap-1 font-medium text-brand hover:underline">
                  <Download aria-hidden="true" className="h-3.5 w-3.5" />
                  Download
                </a>
              )}
            </figcaption>
          </figure>
        );
      })}

      {images.length > 0 && (
        <ul aria-label="Images" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {images.map((a) => (
            <li key={a.id} className="min-w-0">
              {canOpen && !a.purged ? (
                <a
                  href={`/support-files/${encodeURIComponent(a.id)}`}
                  target="_blank"
                  rel="noopener"
                  title={`Open ${a.filename} full size`}
                  className="block overflow-hidden rounded-lg border border-line bg-surface-sunken hover:border-line-strong"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- a private file from the console's own route, never optimised or cached */}
                  <img src={fileHref(a)} alt={a.filename} loading="lazy" className="h-28 w-full object-cover" />
                </a>
              ) : (
                <Placeholder icon={<Paperclip className="h-5 w-5" />} text={a.purged ? "Removed by retention" : "Image"} small />
              )}
              <p className="mt-1 truncate text-xs text-text" title={a.filename}>
                {a.filename}
              </p>
              <p className="text-[11px] text-subtle">{fileSize(a.size)}</p>
            </li>
          ))}
        </ul>
      )}

      {files.length > 0 && (
        <ul aria-label="Files" className="divide-y divide-line rounded-lg border border-line">
          {files.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-3 py-2">
              <FileText aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle" />
              <div className="min-w-0 flex-1">
                {canOpen && !a.purged ? (
                  <a href={fileHref(a)} download={a.filename} className="block truncate text-sm font-medium text-text hover:text-brand" title={`Download ${a.filename}`}>
                    {a.filename}
                  </a>
                ) : (
                  <p className="truncate text-sm text-text" title={a.filename}>
                    {a.filename}
                  </p>
                )}
                <p className="text-[11px] text-subtle">{`${a.mime} · ${fileSize(a.size)}${a.purged ? " · removed by retention" : ""}`}</p>
              </div>
              {canOpen && !a.purged && <Download aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Placeholder({ icon, text, small }: { icon: ReactNode; text: string; small?: boolean }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line bg-surface-sunken text-subtle", small ? "h-28" : "aspect-video")}>
      <span aria-hidden="true">{icon}</span>
      <span className="text-xs">{text}</span>
    </div>
  );
}
