"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CircleCheck, FileText, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ACCEPTED_FILE_TYPES, LIMITS, UPLOAD_HEADERS, UPLOAD_URL, type SupportUploadKind, type UploadResponse } from "@/lib/support/types";

/**
 * Contact Support's attachments: each file uploads the moment it is chosen, to the staging route
 * (src/app/api/support/uploads/route.ts), so pressing Send only has to name what is already there.
 *
 * XMLHttpRequest rather than fetch, for one reason: upload progress. A 10 MB file on an office
 * connection takes long enough that a chip with no bar looks stuck.
 *
 * The type and size are checked here first so an .exe or a 40 MB video is refused at once; the
 * server checks again from the file's own bytes, and its answer is the one that counts.
 */

const UPLOAD_FAILED = "The upload didn't finish. Please try again.";
const TYPES_TEXT = "images, PDF, text, Office documents or .zip";
const EXTENSIONS = ACCEPTED_FILE_TYPES.split(",");
/** Images are sniffed whatever they are called, so a photo named .jfif still goes. */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type UploadOutcome = { ok: true; upload: UploadResponse } | { ok: false; aborted: boolean; error: string };

/**
 * One upload to the staging route: the raw bytes as the body, with the headers it asks for. The
 * browser adds the Origin the route checks. Resolves — never rejects — with the upload or the
 * route's own message; `abort` cancels it (resolving `aborted`).
 */
export function uploadToSupport(
  body: Blob,
  name: string,
  kind: SupportUploadKind,
  onProgress: (fraction: number) => void,
): { done: Promise<UploadOutcome>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<UploadOutcome>((resolve) => {
    xhr.open("POST", UPLOAD_URL);
    xhr.responseType = "json";
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader(UPLOAD_HEADERS.kind, kind);
    xhr.setRequestHeader(UPLOAD_HEADERS.fileName, encodeURIComponent(name));
    xhr.setRequestHeader(UPLOAD_HEADERS.marker, "1");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      const data = (xhr.response ?? null) as (Partial<UploadResponse> & { error?: unknown }) | null;
      if (xhr.status === 200 && data && typeof data.uploadId === "string") {
        resolve({
          ok: true,
          upload: { uploadId: data.uploadId, filename: String(data.filename ?? name), size: Number(data.size ?? body.size), mime: String(data.mime ?? "") },
        });
        return;
      }
      const said = data && typeof data.error === "string" && data.error ? data.error : null;
      const tooBig = kind === "recording" ? "That recording is over 80 MB." : "That file is over 10 MB.";
      resolve({ ok: false, aborted: false, error: said ?? (xhr.status === 413 ? tooBig : UPLOAD_FAILED) });
    };
    xhr.onerror = () => resolve({ ok: false, aborted: false, error: UPLOAD_FAILED });
    xhr.ontimeout = () => resolve({ ok: false, aborted: false, error: UPLOAD_FAILED });
    xhr.onabort = () => resolve({ ok: false, aborted: true, error: "" });
    xhr.send(body);
  });
  return { done, abort: () => xhr.abort() };
}

/**
 * Hands back a staged upload that won't be sent — a removed chip, a discarded draft — so it stops
 * counting against the person's staging room. A courtesy: the tick sweeps anything left after a day.
 */
export function discardStagedUpload(uploadId: string): void {
  try {
    void fetch(`${UPLOAD_URL}?id=${encodeURIComponent(uploadId)}`, {
      method: "DELETE",
      headers: { [UPLOAD_HEADERS.marker]: "1" },
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Nothing to do: the sweep has it.
  }
}

export type AttachmentItem = {
  key: string;
  name: string;
  size: number;
  status: "uploading" | "done" | "failed";
  /** 0–100; at 100 while still "uploading", the server is checking the file. */
  percent: number;
  uploadId?: string;
  error?: string;
};

function precheck(file: File): string | null {
  const name = file.name || "That file";
  if (file.size === 0) return `${name} is empty.`;
  if (file.size > LIMITS.fileBytes) return `${name} is over 10 MB.`;
  const lower = file.name.toLowerCase();
  if (!EXTENSIONS.some((ext) => lower.endsWith(ext)) && !IMAGE_TYPES.includes(file.type)) return `${name} can't be attached — ${TYPES_TEXT} only.`;
  return null;
}

/**
 * The attachments' state, kept by the support dialog itself — so it outlives the dialog being hidden
 * while a recording runs, and an upload in flight keeps going.
 */
export function useSupportAttachments() {
  const [items, setItems] = useState<AttachmentItem[]>([]);
  const [refused, setRefused] = useState<string[]>([]);
  const counter = useRef(0);
  const jobs = useRef(new Map<string, () => void>());

  // Leaving the page mid-upload: nothing keeps sending on behalf of a dialog that is gone.
  useEffect(() => {
    const running = jobs.current;
    return () => {
      for (const abort of running.values()) abort();
      running.clear();
    };
  }, []);

  const patch = (key: string, change: Partial<AttachmentItem>) =>
    setItems((list) => list.map((item) => (item.key === key ? { ...item, ...change } : item)));

  function begin(key: string, file: File) {
    let last = -1;
    const job = uploadToSupport(file, file.name, "file", (fraction) => {
      const percent = Math.min(100, Math.floor(fraction * 100));
      if (percent === last) return;
      last = percent;
      patch(key, { percent });
    });
    jobs.current.set(key, job.abort);
    void job.done.then((outcome) => {
      jobs.current.delete(key);
      if (outcome.ok) patch(key, { status: "done", percent: 100, uploadId: outcome.upload.uploadId });
      // Aborted means removed (or the page left): the chip is already gone.
      else if (!outcome.aborted) patch(key, { status: "failed", error: outcome.error });
    });
  }

  function add(files: File[]) {
    const problems: string[] = [];
    const fresh: { item: AttachmentItem; file: File }[] = [];
    let room = LIMITS.files - items.filter((item) => item.status !== "failed").length;
    let skipped = 0;
    for (const file of files) {
      const problem = precheck(file);
      if (problem) {
        problems.push(problem);
        continue;
      }
      if (room <= 0) {
        skipped += 1;
        continue;
      }
      room -= 1;
      counter.current += 1;
      fresh.push({ file, item: { key: `f${counter.current}`, name: file.name || "file", size: file.size, status: "uploading", percent: 0 } });
    }
    if (skipped) problems.push(`You can attach up to ${LIMITS.files} files — ${skipped === 1 ? "one wasn't" : `${skipped} weren't`} added.`);
    setRefused(problems);
    if (!fresh.length) return;
    setItems((list) => [...list, ...fresh.map((f) => f.item)]);
    for (const { item, file } of fresh) begin(item.key, file);
  }

  function remove(key: string) {
    const item = items.find((i) => i.key === key);
    jobs.current.get(key)?.();
    jobs.current.delete(key);
    if (item?.uploadId) discardStagedUpload(item.uploadId);
    setItems((list) => list.filter((i) => i.key !== key));
    setRefused([]);
  }

  /** Empties the list. `discard`: the draft was thrown away, so its staged files are handed back too. */
  function clear({ discard }: { discard: boolean }) {
    for (const abort of jobs.current.values()) abort();
    jobs.current.clear();
    if (discard) for (const item of items) if (item.uploadId) discardStagedUpload(item.uploadId);
    setItems([]);
    setRefused([]);
  }

  return {
    items,
    refused,
    add,
    remove,
    clear,
    busy: items.some((item) => item.status === "uploading"),
    readyIds: items.flatMap((item) => (item.status === "done" && item.uploadId ? [item.uploadId] : [])),
  };
}

/** "Add files", the accepted types, and a chip per file with its progress and a remove button. */
export function AttachmentPicker({
  items,
  refused,
  onAdd,
  onRemove,
  disabled = false,
  labelId,
}: {
  items: AttachmentItem[];
  refused: string[];
  onAdd: (files: File[]) => void;
  onRemove: (key: string) => void;
  disabled?: boolean;
  /** The id of the heading that names this group. */
  labelId: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const full = items.filter((item) => item.status !== "failed").length >= LIMITS.files;

  return (
    <div role="group" aria-labelledby={labelId} className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button type="button" variant="secondary" size="sm" disabled={disabled || full} aria-describedby={hintId} onClick={() => inputRef.current?.click()}>
          <Paperclip aria-hidden="true" className="h-3.5 w-3.5" />
          Add files
        </Button>
        {/* Clicked by the button above; `hidden` keeps it out of the tab order and the accessibility tree. */}
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED_FILE_TYPES}
          className="hidden"
          tabIndex={-1}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            // Cleared, so choosing the same file again after removing it still fires a change.
            event.target.value = "";
            if (files.length) onAdd(files);
          }}
        />
        <span id={hintId} className="text-xs text-subtle">
          {full ? `That's the most — ${LIMITS.files} files.` : `Up to ${LIMITS.files} files, 10 MB each: ${TYPES_TEXT}.`}
        </span>
      </div>

      {refused.length > 0 && (
        <div role="alert" className="rounded-base border border-danger/40 bg-danger/5 px-2.5 py-1.5 text-xs text-danger">
          <ul className="space-y-0.5">
            {refused.map((problem, index) => (
              <li key={`${index}-${problem}`}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      {items.length > 0 && (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <AttachmentChip key={item.key} item={item} onRemove={() => onRemove(item.key)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AttachmentChip({ item, onRemove }: { item: AttachmentItem; onRemove: () => void }) {
  const checking = item.status === "uploading" && item.percent >= 100;
  return (
    <li
      className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5 ${item.status === "failed" ? "border-danger/40 bg-danger/5" : "border-line bg-surface-sunken/60"}`}
    >
      <FileText aria-hidden="true" className={`h-4 w-4 shrink-0 ${item.status === "failed" ? "text-danger" : "text-subtle"}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[13px] text-text" title={item.name}>
            {item.name}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-subtle">
            {item.status === "uploading" ? `${checking ? "Checking…" : `${item.percent}%`} · ${formatBytes(item.size)}` : formatBytes(item.size)}
          </span>
        </div>
        {item.status === "uploading" && (
          <div
            role="progressbar"
            aria-label={`Uploading ${item.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={item.percent}
            className="mt-1 h-1 overflow-hidden rounded-full bg-line"
          >
            <div className="h-full rounded-full bg-brand transition-[width] duration-150" style={{ width: `${item.percent}%` }} />
          </div>
        )}
        {item.status === "failed" && (
          <p role="alert" className="mt-0.5 text-[11px] text-danger">
            {item.error}
          </p>
        )}
      </div>
      {item.status === "done" && (
        <span className="shrink-0 text-success">
          <CircleCheck aria-hidden="true" className="h-4 w-4" />
          <span className="sr-only">Uploaded</span>
        </span>
      )}
      <IconButton icon={X} label={item.status === "uploading" ? `Cancel uploading ${item.name}` : `Remove ${item.name}`} tone="danger" onClick={onRemove} />
    </li>
  );
}
