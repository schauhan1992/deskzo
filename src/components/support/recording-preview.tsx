"use client";

import { useState } from "react";
import { ChevronUp, Loader2, Paperclip, Play, RotateCcw, Trash2, Video, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { formatBytes } from "@/components/support/attachment-picker";
import { formatClock } from "@/components/support/recorder";

/**
 * A recording before and after it is attached.
 *
 * Before: the player, so the person can watch exactly what they are about to send — there is no
 * masking editor, so watching it and choosing is the privacy control — then Attach, Record again or
 * Discard. After: a chip like the files' chips, with its length, a play button and remove.
 */

/**
 * Chrome writes WebM recordings without a duration, so the player shows no length and can't seek
 * until it has played to the end. Asking for a far-off time makes it read the whole file and learn
 * the length; the first time update then puts it back at the start.
 */
function learnDuration(event: React.SyntheticEvent<HTMLVideoElement>) {
  const video = event.currentTarget;
  if (video.duration !== Infinity) return;
  const rewind = () => {
    video.removeEventListener("timeupdate", rewind);
    video.currentTime = 0;
  };
  video.addEventListener("timeupdate", rewind);
  video.currentTime = Number.MAX_SAFE_INTEGER;
}

export type TakeUpload = { state: "none" } | { state: "uploading"; percent: number } | { state: "failed"; error: string };

export function RecordingPreview({
  url,
  durationMs,
  size,
  note,
  upload,
  onAttach,
  onRedo,
  onDiscard,
}: {
  /** The recording's object URL; the dialog makes it and revokes it. */
  url: string;
  durationMs: number;
  size: number;
  /** Why it stopped, when it stopped itself: the five-minute limit or the size cap. */
  note: string | null;
  upload: TakeUpload;
  onAttach: () => void;
  onRedo: () => void;
  onDiscard: () => void;
}) {
  const uploading = upload.state === "uploading";
  const percent = upload.state === "uploading" ? upload.percent : 0;

  return (
    <div className="space-y-2.5 rounded-lg border border-line bg-surface-sunken/60 p-3">
      <p className="flex flex-wrap items-center gap-x-1.5 text-[13px] font-medium text-text">
        <Video aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle" />
        Your recording
        <span className="font-normal tabular-nums text-subtle">
          · {formatClock(durationMs)} · {formatBytes(size)}
        </span>
      </p>
      {note && <p className="text-xs text-muted">{note}</p>}
      <video
        src={url}
        controls
        playsInline
        preload="metadata"
        aria-label="Your screen recording"
        onLoadedMetadata={learnDuration}
        className="aspect-video w-full rounded-md bg-black"
      />
      <p className="text-xs text-subtle">Watch it before you attach it: it shows everything that was on the screen you shared.</p>

      {uploading && (
        <div
          role="progressbar"
          aria-label="Attaching the recording"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-1 overflow-hidden rounded-full bg-line"
        >
          <div className="h-full rounded-full bg-brand transition-[width] duration-150" style={{ width: `${percent}%` }} />
        </div>
      )}
      {upload.state === "failed" && (
        <p role="alert" className="text-xs text-danger">
          {upload.error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {/* aria-disabled rather than disabled while it uploads: a disabled button drops the keyboard focus to <body>. */}
        <Button type="button" size="sm" aria-disabled={uploading || undefined} onClick={uploading ? undefined : onAttach}>
          {uploading ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Paperclip aria-hidden="true" className="h-3.5 w-3.5" />}
          {uploading ? (percent >= 100 ? "Checking…" : `Attaching… ${percent}%`) : upload.state === "failed" ? "Try attaching again" : "Attach recording"}
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={uploading} onClick={onRedo}>
          <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
          Record again
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDiscard}>
          <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
          Discard
        </Button>
      </div>
    </div>
  );
}

/**
 * An attached recording: its length and size, a player behind the play button, and remove.
 * `focusPlay`: the Attach button that had the focus has just been replaced by this chip, so the
 * focus lands here rather than falling back to the page.
 */
export function RecordingChip({
  url,
  durationMs,
  size,
  focusPlay = false,
  onRemove,
}: {
  url: string;
  durationMs: number;
  size: number;
  focusPlay?: boolean;
  onRemove: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  return (
    <div className="rounded-lg border border-line bg-surface-sunken/60 px-2.5 py-1.5">
      <div className="flex items-center gap-2.5">
        <Video aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-text">
          Screen recording
          <span className="ml-1.5 text-[11px] tabular-nums text-subtle">
            {formatClock(durationMs)} · {formatBytes(size)}
          </span>
        </span>
        <IconButton
          icon={playing ? ChevronUp : Play}
          label={playing ? "Hide the player" : "Play the recording"}
          aria-expanded={playing}
          autoFocus={focusPlay}
          onClick={() => setPlaying((on) => !on)}
        />
        <IconButton icon={X} label="Remove the recording" tone="danger" onClick={onRemove} />
      </div>
      {playing && (
        <video
          src={url}
          controls
          autoPlay
          playsInline
          aria-label="Your screen recording"
          onLoadedMetadata={learnDuration}
          className="mt-2 aspect-video w-full rounded-md bg-black"
        />
      )}
    </div>
  );
}
