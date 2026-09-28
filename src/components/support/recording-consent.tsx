"use client";

import { useId, useState } from "react";
import { Check, Info, Loader2, ShieldAlert, Video } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * Exactly what a recording collects — the recorder (src/components/support/recorder.ts) and the
 * submit action gather these and nothing else, so this list is a promise, not marketing. Change one
 * side and the other has to follow.
 */
const COLLECTED = [
  "Your IP address.",
  "Browser console messages (errors and warnings) generated during the recording.",
  "Device details: screen resolution, browser version and operating system.",
  "Page-load timings for the page you're on (how long it took to load).",
  "A recording of the window, tab or screen you choose. You can watch it and discard it before sending.",
  "Audio, only if you turn on your microphone. It's off unless you switch it on.",
];

/**
 * "Record screen & share feedback": what a recording collects, and the tick that agrees to it,
 * before the browser is ever asked to share a screen. Start recording stays disabled until the box is
 * ticked, and the tick is asked for again on every recording — agreeing once is agreeing to that one.
 *
 * `starting` is the moment between the click and the browser's picker being answered: the dialog
 * stays, says what to do, and can't be dismissed under the picker.
 */
export function RecordingConsent({
  open,
  brandName,
  microphone,
  onMicrophoneChange,
  starting,
  onStart,
  onCancel,
}: {
  open: boolean;
  brandName: string;
  microphone: boolean;
  onMicrophoneChange: (on: boolean) => void;
  starting: boolean;
  /** Called from the click itself — the browser only offers its picker to a click. */
  onStart: () => void;
  onCancel: () => void;
}) {
  const [agreed, setAgreed] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  const headingId = useId();
  const micLabelId = useId();
  const micHintId = useId();

  // Unticked each time it opens — adjusted during render, as the other dialogs here do.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setAgreed(false);
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        // Not while the browser's picker is up: the answer to it would arrive with nowhere to go.
        if (!starting) onCancel();
      }}
      title="Record screen & share feedback"
    >
      <div className="space-y-4">
        <section aria-labelledby={headingId} className="rounded-lg border border-info/30 bg-info-bg p-3.5">
          <h3 id={headingId} className="flex items-center gap-1.5 text-sm font-semibold text-info">
            <Info aria-hidden="true" className="h-4 w-4 shrink-0" />
            Provide consent for recording
          </h3>
          <p className="mt-1.5 text-[13px] leading-relaxed text-text">
            You can record your screen for up to 5 minutes. Once you click Start recording, you are consenting to allow us to collect the following details:
          </p>
          <ul className="mt-2.5 space-y-1.5">
            {COLLECTED.map((line) => (
              <li key={line} className="flex gap-2 text-[13px] leading-snug text-text">
                <Check aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </section>

        <label className="flex items-start gap-2.5 text-[13px] text-text">
          <input
            type="checkbox"
            checked={agreed}
            disabled={starting}
            onChange={(event) => setAgreed(event.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-line-strong accent-brand"
          />
          <span>I agree to allow {brandName} to collect the data mentioned above</span>
        </label>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p id={micLabelId} className="text-[13px] font-medium text-text">
              Include my microphone
            </p>
            <p id={micHintId} className="text-xs text-subtle">
              Off unless you switch it on. Your browser will ask first.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={microphone}
            aria-labelledby={micLabelId}
            aria-describedby={micHintId}
            disabled={starting}
            onClick={() => onMicrophoneChange(!microphone)}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${microphone ? "bg-brand" : "bg-line-strong"}`}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow transition-transform ${microphone ? "translate-x-5" : "translate-x-0.5"}`} />
          </button>
        </div>

        <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-bg px-3 py-2 text-xs leading-relaxed text-warning">
          <ShieldAlert aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>Close anything private first — the recording shows everything in what you share.</span>
        </p>

        {starting && (
          <p role="status" className="text-xs text-muted">
            Choose the window, tab or screen to share in your browser&apos;s prompt.
          </p>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" size="sm" disabled={starting} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={!agreed || starting} onClick={onStart}>
            {starting ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Video aria-hidden="true" className="h-3.5 w-3.5" />}
            Start recording
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
