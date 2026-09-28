"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ImageOff, ImageUp, TriangleAlert, X } from "lucide-react";
import { useConsoleNotice } from "@/components/console/kit/notice";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { MediaDetails } from "@/components/cms/media/media-details";
import { UploadZone } from "@/components/cms/media/upload-zone";
import { formatBytes, useUploads } from "@/components/cms/media/use-uploads";
import { Button } from "@/components/ui/button";
import type { CmsCaps, MediaRow, MediaUsage } from "@/lib/cms/types";
import { cn } from "@/lib/utils";

/**
 * The media library's body: the uploader (for writers; opened by "Upload images" or by arriving with
 * ?upload=1), the images as a grid or a list, and the details of the one in ?id= beside them. Every
 * link keeps the rest of the address, so the search, the page and the view survive opening an image.
 */
export function MediaLibrary({
  rows,
  view,
  hrefs,
  closeHref,
  selected,
  missing,
  usage,
  caps,
  siteOrigin,
  uploadOpen,
  filtered,
}: {
  rows: MediaRow[];
  view: "grid" | "list";
  /** The address that opens each image's details, by id. */
  hrefs: Record<string, string>;
  /** The address without ?id=. */
  closeHref: string;
  selected: MediaRow | null;
  /** ?id= named an image that is not there (deleted since the link was made). */
  missing: boolean;
  usage: MediaUsage[];
  caps: CmsCaps;
  siteOrigin: string;
  uploadOpen: boolean;
  filtered: boolean;
}) {
  const router = useRouter();
  const { show } = useConsoleNotice();
  const [uploading, setUploading] = useState(uploadOpen);
  const uploads = useUploads((done) => {
    show("success", done.length === 1 ? `“${done[0].filename}” is in the library.` : `${done.length} images are in the library.`);
    router.refresh();
  });
  const close = () => router.replace(closeHref, { scroll: false });

  return (
    <div className="space-y-4">
      {caps.write && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant={uploading ? "secondary" : "primary"} size="sm" onClick={() => setUploading((v) => !v)} aria-expanded={uploading} aria-controls="media-uploader">
            {uploading ? <X aria-hidden="true" className="h-4 w-4" /> : <ImageUp aria-hidden="true" className="h-4 w-4" />}
            {uploading ? "Close the uploader" : "Upload images"}
          </Button>
        </div>
      )}
      {caps.write && (
        <div id="media-uploader" hidden={!uploading}>
          <UploadZone items={uploads.items} busy={uploads.busy} onFiles={(files) => void uploads.start(files)} onClear={uploads.clearFinished} />
        </div>
      )}

      {missing && (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
          <TriangleAlert aria-hidden="true" className="h-4 w-4" />
          That image is no longer in the library.
        </p>
      )}

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong bg-surface px-6 py-14 text-center">
          <ImageOff aria-hidden="true" className="h-7 w-7 text-subtle" />
          <p className="text-sm font-medium text-text">{filtered ? "No image matches" : "The library is empty"}</p>
          <p className="max-w-sm text-xs text-muted">
            {filtered ? "Search by another part of the file name or the alt text." : caps.write ? "Upload the images pages and posts will use — logos, screenshots, photos. PNG, JPEG, WebP or GIF, up to 5 MB." : "Images uploaded by writers appear here."}
          </p>
          {!filtered && caps.write && !uploading && (
            <Button type="button" size="sm" className="mt-2" onClick={() => setUploading(true)}>
              <ImageUp aria-hidden="true" className="h-4 w-4" />
              Upload images
            </Button>
          )}
        </div>
      ) : view === "grid" ? (
        <ul aria-label="Images" className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                href={hrefs[row.id]}
                scroll={false}
                aria-current={selected?.id === row.id ? "true" : undefined}
                className={cn(
                  "group block overflow-hidden rounded-xl border bg-surface shadow-sm transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-md",
                  selected?.id === row.id ? "border-brand ring-brand" : "border-line",
                )}
              >
                <span className="relative block aspect-[4/3] bg-surface-sunken">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={row.url} alt={row.alt || ""} loading="lazy" className="h-full w-full object-contain" />
                  {row.needsAlt && <span className="absolute top-1.5 left-1.5 rounded-full bg-warning-bg px-1.5 py-px text-[10px] font-medium text-warning">No alt text</span>}
                </span>
                <span className="block border-t border-line px-2.5 py-2">
                  <span className="block truncate text-xs font-medium text-text">{row.filename}</span>
                  <span className="block text-[11px] text-subtle tabular-nums">
                    {row.width && row.height ? `${row.width}×${row.height} · ` : ""}
                    {formatBytes(row.size)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-xl border border-line bg-surface shadow-sm">
          <DataTable caption="Images" minWidth={720}>
            <THead>
              <Th>Image</Th>
              <Th>Alt text</Th>
              <Th numeric>Size</Th>
              <Th>Uploaded</Th>
            </THead>
            <TBody>
              {rows.map((row) => (
                <Tr key={row.id} interactive selected={selected?.id === row.id}>
                  <Td>
                    <div className="flex items-center gap-3">
                      <span className="grid h-10 w-14 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-surface-sunken">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={row.url} alt="" loading="lazy" className="h-full w-full object-contain" />
                      </span>
                      <div className="min-w-0">
                        <Link href={hrefs[row.id]} scroll={false} data-row-link="" className="block truncate font-medium text-text after:absolute after:inset-0 after:content-[''] hover:text-brand">
                          {row.filename}
                        </Link>
                        <span className="text-xs text-subtle tabular-nums">{row.width && row.height ? `${row.width} × ${row.height}` : "—"}</span>
                      </div>
                    </div>
                  </Td>
                  <Td muted>{row.needsAlt ? <span className="text-warning">Needs alt text</span> : <span className="line-clamp-2 max-w-72">{row.alt}</span>}</Td>
                  <Td numeric muted>
                    {formatBytes(row.size)}
                  </Td>
                  <Td muted nowrap>
                    <RelativeTime at={row.createdAt} />
                    <span className="block text-xs text-subtle">{row.createdBy}</span>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </DataTable>
        </div>
      )}

      <MediaDetails row={selected} usage={usage} caps={caps} siteOrigin={siteOrigin} onClose={close} />
    </div>
  );
}
