"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, LoaderCircle, Trash2 } from "lucide-react";
import { cmsDeleteMedia, cmsUpdateMediaAlt } from "@/actions/cms/media";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { CopyField } from "@/components/console/kit/copy-field";
import { useConsoleNotice } from "@/components/console/kit/notice";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { useCmsAction } from "@/components/cms/common/use-cms-action";
import { formatBytes } from "@/components/cms/media/use-uploads";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";
import { SidePane } from "@/components/ui/side-pane";
import type { CmsCaps, MediaRow, MediaUsage } from "@/lib/cms/types";
import { formatIstDateTime } from "@/lib/india-time";

/**
 * One image's details, beside the library: the picture, its file name, type, size and dimensions,
 * who uploaded it and when, its address to copy, its alt text (writers change it here), where it is
 * used, and — for editors and admins — delete, which the server refuses while anything uses it.
 */
export function MediaDetails({ row, usage, caps, siteOrigin, onClose }: { row: MediaRow | null; usage: MediaUsage[]; caps: CmsCaps; siteOrigin: string; onClose: () => void }) {
  return (
    <SidePane open={!!row} onClose={onClose} title={row ? row.filename : "Image"}>
      {row && <DetailsBody key={row.id} row={row} usage={usage} caps={caps} siteOrigin={siteOrigin} onClose={onClose} />}
    </SidePane>
  );
}

function DetailsBody({ row, usage, caps, siteOrigin, onClose }: { row: MediaRow; usage: MediaUsage[]; caps: CmsCaps; siteOrigin: string; onClose: () => void }) {
  const router = useRouter();
  const { show } = useConsoleNotice();
  const [alt, setAlt] = useState(row.alt);
  const [confirming, setConfirming] = useState(false);
  const altAction = useCmsAction<MediaRow>();
  const deleteAction = useCmsAction<null>();
  const altChanged = alt.trim() !== row.alt;

  return (
    <div className="space-y-5">
      <div className="overflow-hidden rounded-lg border border-line bg-[repeating-conic-gradient(var(--surface-sunken)_0%_25%,var(--surface)_0%_50%)] bg-[length:16px_16px]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={row.url} alt={row.alt || ""} className="mx-auto max-h-72 w-auto object-contain" />
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div className="col-span-2">
          <dt className="text-xs text-muted">File</dt>
          <dd className="break-all text-text">{row.filename}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Type</dt>
          <dd className="text-text">{row.mime.replace("image/", "").toUpperCase()}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Size</dt>
          <dd className="text-text">{formatBytes(row.size)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Dimensions</dt>
          <dd className="text-text tabular-nums">{row.width && row.height ? `${row.width} × ${row.height} px` : "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Uploaded</dt>
          <dd className="text-text" title={formatIstDateTime(row.createdAt)}>
            <RelativeTime at={row.createdAt} />
            <span className="block text-xs text-muted">{row.createdBy}</span>
          </dd>
        </div>
      </dl>

      <div className="space-y-1.5">
        <p className="text-xs text-muted">Address</p>
        <CopyField value={row.url} label="the image's address on the site" />
        <CopyField value={`${siteOrigin}${row.url}`} label="the image's full address" href={`${siteOrigin}${row.url}`} hrefLabel="Open" />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="media-alt">Alt text</Label>
        {caps.write ? (
          <>
            <Textarea id="media-alt" value={alt} rows={3} maxLength={300} onChange={(e) => setAlt(e.target.value)} placeholder="What the image shows, for people who can't see it" aria-describedby="media-alt-hint" />
            <div className="flex items-center justify-between gap-2">
              <p id="media-alt-hint" className="text-xs text-subtle">
                {row.needsAlt ? "Needed before anything using this image can be published." : `${alt.length}/300 — used wherever a block doesn't give its own.`}
              </p>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={!altChanged || altAction.pending}
                onClick={() => altAction.run(() => cmsUpdateMediaAlt(row.id, alt), { success: "Alt text saved." })}
              >
                {altAction.pending && <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
                Save alt text
              </Button>
            </div>
            <ActionNoticeRegion notice={altAction.error ? { tone: "error", message: altAction.error } : null} />
          </>
        ) : (
          <p className="text-sm text-text">{row.alt || <span className="text-warning">No alt text yet.</span>}</p>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-xs text-muted">Used in</p>
        {usage.length === 0 ? (
          <p className="text-sm text-subtle">Nothing uses this image yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {usage.map((u) => (
              <li key={`${u.kind}-${u.id}-${u.where}`} className="flex items-center justify-between gap-2 text-sm">
                <Link href={u.href} className="inline-flex min-w-0 items-center gap-1 font-medium text-text hover:text-brand">
                  <span className="truncate">{u.kind === "settings" ? "Site settings" : `${u.kind === "page" ? "Page" : "Post"}: ${u.title}`}</span>
                  <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                </Link>
                <StatusPill tone={u.where === "published" ? "success" : "warning"}>{u.where === "published" ? "Published" : "Draft"}</StatusPill>
              </li>
            ))}
          </ul>
        )}
      </div>

      {caps.publish && (
        <div className="border-t border-line pt-4">
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)} className="text-danger hover:bg-danger-bg hover:text-danger">
            <Trash2 aria-hidden="true" className="h-4 w-4" />
            Delete image…
          </Button>
          {usage.length > 0 && <p className="mt-1 text-xs text-subtle">It is in use, so it can&apos;t be deleted until it is taken out of those places.</p>}
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
          deleteAction.reset();
        }}
        title="Delete this image"
        tone="danger"
        confirmLabel="Delete for good"
        pending={deleteAction.pending}
        error={deleteAction.error}
        onConfirm={() =>
          deleteAction.run(() => cmsDeleteMedia(row.id), {
            refresh: false,
            onDone: () => {
              setConfirming(false);
              show("success", `Deleted “${row.filename}”.`);
              onClose();
              router.refresh();
            },
          })
        }
      >
        <p>
          “{row.filename}” is removed from the library and from {siteOrigin}
          {row.url}. This cannot be undone.
        </p>
      </ConfirmDialog>
    </div>
  );
}
