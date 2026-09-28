"use client";

import { useEffect, useEffectEvent, useId, useState, useTransition } from "react";
import { Eye, History, LoaderCircle, RotateCcw } from "lucide-react";
import { cmsPageVersion, cmsPageVersions, cmsSavePageVersion } from "@/actions/cms/pages";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { SidePane } from "@/components/ui/side-pane";
import type { PageDocument, PageVersionRow } from "@/lib/cms/types";
import { formatIstDateTime } from "@/lib/india-time";

/**
 * A page's history: every published version and every version saved by hand, newest first, with who
 * and when and its note. Look at one in the preview, or restore it into the draft (nothing on the site
 * changes until the draft is published). "Save a version" keeps the current draft as a checkpoint.
 */
export function HistoryPanel({
  open,
  onClose,
  pageRef,
  canWrite,
  saved,
  onBeforeCheckpoint,
  onView,
  onRestore,
}: {
  open: boolean;
  onClose: () => void;
  pageRef: string;
  canWrite: boolean;
  /** The page has been saved at least once (a built-in page on its defaults has no history). */
  saved: boolean;
  /** Saves unsaved changes first, so the checkpoint is what is on screen. Resolves false to stop. */
  onBeforeCheckpoint: () => Promise<boolean>;
  onView: (version: PageVersionRow, doc: PageDocument) => void;
  onRestore: (version: PageVersionRow) => void;
}) {
  return (
    <SidePane open={open} onClose={onClose} title="Version history">
      {open && <HistoryBody pageRef={pageRef} canWrite={canWrite} saved={saved} onBeforeCheckpoint={onBeforeCheckpoint} onView={onView} onRestore={onRestore} />}
    </SidePane>
  );
}

function HistoryBody({
  pageRef,
  canWrite,
  saved,
  onBeforeCheckpoint,
  onView,
  onRestore,
}: {
  pageRef: string;
  canWrite: boolean;
  saved: boolean;
  onBeforeCheckpoint: () => Promise<boolean>;
  onView: (version: PageVersionRow, doc: PageDocument) => void;
  onRestore: (version: PageVersionRow) => void;
}) {
  const noteId = useId();
  const [rows, setRows] = useState<PageVersionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = () =>
    startTransition(async () => {
      try {
        const result = await cmsPageVersions(pageRef);
        if (result.ok) {
          setRows(result.data);
          setError(null);
        } else setError(result.error);
      } catch {
        setError("The history didn't load. Try again.");
      }
    });
  const firstLoad = useEffectEvent(() => load());
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => firstLoad());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const checkpoint = () =>
    startTransition(async () => {
      setMessage(null);
      if (!(await onBeforeCheckpoint())) {
        setError("Save the draft first — it has problems to fix, or didn't save.");
        return;
      }
      try {
        const result = await cmsSavePageVersion(pageRef, note);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setRows((prev) => [result.data, ...(prev ?? [])]);
        setNote("");
        setError(null);
        setMessage("Version saved.");
      } catch {
        setError("That didn't save. Try again.");
      }
    });

  const view = (row: PageVersionRow) => {
    setViewing(row.id);
    startTransition(async () => {
      try {
        const result = await cmsPageVersion(pageRef, row.id);
        if (result.ok) onView(row, result.data);
        else setError(result.error);
      } catch {
        setError("That version didn't load. Try again.");
      } finally {
        setViewing(null);
      }
    });
  };

  return (
    <div className="space-y-5">
      {canWrite && saved && (
        <div className="space-y-2 rounded-lg border border-line bg-surface-sunken p-3">
          <Label htmlFor={noteId}>Save the current draft as a version</Label>
          <Input id={noteId} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="A note: “Before the spring copy”" />
          <Button type="button" size="sm" onClick={checkpoint} disabled={pending}>
            {pending && <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
            Save a version
          </Button>
        </div>
      )}
      <div aria-live="polite" className="space-y-1">
        {message && <p className="text-xs text-success">{message}</p>}
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>

      {!saved ? (
        <p className="text-sm text-muted">This page still shows its built-in content. Versions appear here once it is saved or published.</p>
      ) : rows === null ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
          Loading the history…
        </p>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <History aria-hidden="true" className="h-6 w-6 text-subtle" />
          <p className="text-sm text-text">No versions yet</p>
          <p className="text-xs text-muted">Each publish keeps one, and so does “Save a version”.</p>
        </div>
      ) : (
        <ol className="space-y-2">
          {rows.map((row) => (
            <li key={row.id} className="rounded-lg border border-line p-3">
              <p className="text-sm font-medium text-text">{row.note || "No note"}</p>
              <p className="mt-0.5 text-xs text-muted">
                <RelativeTime at={row.createdAt} /> · {row.createdBy}
              </p>
              <p className="mt-0.5 text-xs text-subtle">
                {formatIstDateTime(row.createdAt)} · “{row.title}” · {row.blocks} {row.blocks === 1 ? "block" : "blocks"}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button type="button" variant="secondary" size="sm" onClick={() => view(row)} disabled={pending}>
                  {viewing === row.id ? <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Eye aria-hidden="true" className="h-3.5 w-3.5" />}
                  Look at it
                </Button>
                {canWrite && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => onRestore(row)} disabled={pending}>
                    <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                    Restore into draft
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
