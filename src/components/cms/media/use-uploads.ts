"use client";

import { useRef, useState } from "react";
import { cmsUploadMedia } from "@/actions/cms/media";
import { MEDIA_MAX_BYTES, MEDIA_TYPES, type MediaRow } from "@/lib/cms/types";

/**
 * Uploading images to the library, one server action per file (the action takes one), in order — so
 * each file has its own state and its own error, and one refusal does not stop the rest.
 *
 * The type and the size are checked here first, so a PDF or a 12 MB photo is refused at once rather
 * than after a round trip; the server checks again by the file's own bytes.
 */

export type UploadItem = {
  key: string;
  name: string;
  size: number;
  status: "waiting" | "uploading" | "done" | "failed";
  error?: string;
  row?: MediaRow;
  /** The library had these exact bytes already: this is the existing image. */
  duplicate?: boolean;
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function precheck(file: File): string | null {
  if (!(MEDIA_TYPES as readonly string[]).includes(file.type)) return "Only PNG, JPEG, WebP and GIF images can be uploaded.";
  if (file.size > MEDIA_MAX_BYTES) return `That image is ${formatBytes(file.size)} — over 5 MB. Make it smaller and try again.`;
  if (file.size === 0) return "That file is empty.";
  return null;
}

export function useUploads(onUploaded?: (rows: MediaRow[]) => void) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const running = useRef(false);
  const counter = useRef(0);
  // Files dropped while others are still going join the same run.
  const queue = useRef<{ file: File; key: string }[]>([]);

  const patch = (key: string, change: Partial<UploadItem>) => setItems((list) => list.map((item) => (item.key === key ? { ...item, ...change } : item)));

  const start = async (files: File[]) => {
    if (!files.length) return;
    const fresh = files.slice(0, 50).map((file) => {
      counter.current += 1;
      const problem = precheck(file);
      return { file, item: { key: `u${counter.current}`, name: file.name || "image", size: file.size, status: problem ? "failed" : "waiting", error: problem ?? undefined } as UploadItem };
    });
    setItems((list) => [...fresh.map((f) => f.item), ...list].slice(0, 100));
    for (const { file, item } of fresh) if (item.status !== "failed") queue.current.push({ file, key: item.key });
    if (running.current) return;
    running.current = true;
    const uploaded: MediaRow[] = [];
    try {
      while (queue.current.length) {
        const { file, key } = queue.current.shift()!;
        const item = { key };
        patch(item.key, { status: "uploading" });
        const form = new FormData();
        form.append("file", file);
        try {
          const result = await cmsUploadMedia(form);
          if (result.ok) {
            const { duplicate, ...row } = result.data;
            uploaded.push(row);
            patch(item.key, { status: "done", row, duplicate });
          } else {
            patch(item.key, { status: "failed", error: result.error });
          }
        } catch {
          patch(item.key, { status: "failed", error: "The upload didn't finish — check the connection and try again. Images over 5 MB are refused." });
        }
      }
    } finally {
      running.current = false;
    }
    if (uploaded.length) onUploaded?.(uploaded);
  };

  const clearFinished = () => setItems((list) => list.filter((i) => i.status === "uploading" || i.status === "waiting"));

  const busy = items.some((i) => i.status === "uploading" || i.status === "waiting");
  return { items, start, clearFinished, busy };
}
