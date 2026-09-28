"use client";

import { createPortal } from "react-dom";
import { Mic, MicOff, Pause, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { RECORDING_WARNING_MS, formatClock } from "@/components/support/recorder";
import { LIMITS } from "@/lib/support/types";

/**
 * The only thing on screen while a support recording runs: the support dialog is hidden (its draft
 * kept) so the person can show us the problem, and this bar at the bottom centre says a recording is
 * on and how to stop it.
 *
 * `z-[90]` puts it over the page and its menus, and under the DLP guard's toast (z-[96]) — a policy
 * notice still wins. Portalled to <body>, so no stacking context around the launcher can bury it.
 *
 * The timer changes every second, so it is a status that is *not* live: announcing it would read out
 * a number every second. The start, the one-minute warning and the stop are announced instead, from
 * the dialog's own live region, which outlives this bar.
 */
export function RecordingBar({
  elapsedMs,
  paused,
  canPause,
  hasMicrophone,
  muted,
  onPause,
  onResume,
  onToggleMute,
  onStop,
}: {
  elapsedMs: number;
  paused: boolean;
  canPause: boolean;
  hasMicrophone: boolean;
  muted: boolean;
  onPause: () => void;
  onResume: () => void;
  onToggleMute: () => void;
  onStop: () => void;
}) {
  const lastMinute = elapsedMs >= RECORDING_WARNING_MS;

  return createPortal(
    <section
      aria-label="Screen recording"
      className="fixed bottom-5 left-1/2 z-[90] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 animate-fade-in items-center gap-2 rounded-full border border-line bg-surface py-1.5 pl-3.5 pr-1.5 shadow-lg"
    >
      <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full bg-danger ${paused ? "opacity-50" : "animate-pulse"}`} />
      <span role="status" aria-live="off" className={`whitespace-nowrap text-[13px] font-medium tabular-nums ${lastMinute ? "text-danger" : "text-text"}`}>
        {paused ? "Paused" : "Recording"} {formatClock(elapsedMs)} / {formatClock(LIMITS.recordingMs)}
      </span>
      <div className="flex items-center gap-0.5">
        {canPause && (
          <IconButton icon={paused ? Play : Pause} label={paused ? "Resume recording" : "Pause recording"} onClick={paused ? onResume : onPause} className="h-8 w-8 rounded-full" />
        )}
        {hasMicrophone && (
          <IconButton icon={muted ? MicOff : Mic} label="Mute microphone" aria-pressed={muted} onClick={onToggleMute} className="h-8 w-8 rounded-full" />
        )}
        {/* Focused on arrival: a keyboard user's way out is one keypress away. */}
        <Button type="button" variant="danger" size="sm" autoFocus onClick={onStop} className="ml-1 rounded-full">
          <Square aria-hidden="true" className="h-3 w-3 fill-current" />
          Stop
        </Button>
      </div>
    </section>,
    document.body,
  );
}
