"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { CircleAlert, CircleCheck, Loader2, Mail, Phone, Send, Video } from "lucide-react";
import { submitSupportRequest } from "@/actions/support";
import { ActionNotice } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { AttachmentPicker, discardStagedUpload, uploadToSupport, useSupportAttachments } from "@/components/support/attachment-picker";
import { RecordingBar } from "@/components/support/recording-bar";
import { RecordingConsent } from "@/components/support/recording-consent";
import { RecordingChip, RecordingPreview, type TakeUpload } from "@/components/support/recording-preview";
import {
  RECORDING_WARNING_MS,
  canRecordScreen,
  clientContext,
  formatClock,
  startScreenRecording,
  type RecordingResult,
  type ScreenRecorder,
} from "@/components/support/recorder";
import {
  DEFAULT_PRIORITY,
  LIMITS,
  MOBILE_PATTERN,
  PRIORITY_OPTIONS,
  supportRef,
  type LauncherState,
  type SupportPriorityKey,
  type SupportSubmitResult,
} from "@/lib/support/types";
import { cn } from "@/lib/utils";

/**
 * "How can we help you today?" — a request to the platform's support desk, from inside a workspace.
 * Not the workspace's own helpline (src/actions/help.ts): this goes to the SaaS vendor, is kept in
 * the control plane and answered by email from the console's Support page.
 *
 * Everything the person has put in lives in this component's state, not in the dialog's markup, and
 * this component stays mounted while the launcher does. That is what lets the dialog step aside for a
 * recording — hidden, the recording bar in its place — and come back with the draft, the uploads
 * (still running) and the new recording all where they were.
 *
 * The flow, in phases:
 *
 *   idle      the form (or, once sent, the confirmation);
 *   consent   the "Record screen & share feedback" dialog instead of the form;
 *   starting  the browser's share picker is up — the consent dialog waits, and can't be dismissed;
 *   recording no dialog at all, only the recording bar; stopping brings the form back with a player.
 *
 * Closing with anything in it asks first; sending is disabled while an upload is still running. The
 * server re-checks everything (src/actions/support.ts) — the checks here are for the person's sake.
 */

const DLP_BLOCKED = "Your organisation's security settings don't allow screen recording.";
const SETTING_BLOCKED = "Screen recording isn't available right now.";
const BROWSER_BLOCKED = "Your browser can't record the screen — attach a screenshot instead.";
const SEND_FAILED = "Your request couldn't be sent — check your connection and try again.";
const MOBILE_REFUSED = "That mobile number doesn't look right — digits, spaces, brackets, + and - only.";

type Phase = "idle" | "consent" | "starting" | "recording";
type Take = Omit<RecordingResult, "reason"> & {
  /** The recording's object URL, revoked when the take goes. */
  url: string;
  note: string | null;
  upload: TakeUpload | { state: "done"; uploadId: string };
};
type FieldErrors = { subject?: string; body?: string; mobile?: string };

/** Characters as the server counts them: code points, so an emoji is one. */
const chars = (text: string) => [...text].length;
const describedBy = (...ids: (string | false | null | undefined)[]) => ids.filter(Boolean).join(" ") || undefined;
/** After the render that puts the element back — a button that replaced the one just pressed. */
const focusSoon = (ref: RefObject<HTMLElement | null>) => window.setTimeout(() => ref.current?.focus(), 0);

/** Browser capability, read after mount only: the server can't know, and must not guess into the HTML. */
const subscribeNothing = () => () => {};
const unknownOnServer = () => null;

export function SupportDialog({ state, open, onClose }: { state: LauncherState; open: boolean; onClose: () => void }) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [mobile, setMobile] = useState(state.phone ?? "");
  const [priority, setPriority] = useState<SupportPriorityKey>(DEFAULT_PRIORITY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<{ number: number; email: string } | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const files = useSupportAttachments();

  const [phase, setPhase] = useState<Phase>("idle");
  const [microphone, setMicrophone] = useState(false);
  const [controls, setControls] = useState({ hasMicrophone: false, canPause: false, paused: false, muted: false });
  const [elapsedMs, setElapsedMs] = useState(0);
  const [take, setTake] = useState<Take | null>(null);
  const [focusChip, setFocusChip] = useState(false);
  const [recordNotice, setRecordNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const recorderRef = useRef<ScreenRecorder | null>(null);
  const takeUrlRef = useRef<string | null>(null);
  const takeAbortRef = useRef<(() => void) | null>(null);
  const warnedRef = useRef(false);
  const aliveRef = useRef(true);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const mobileRef = useRef<HTMLInputElement>(null);
  const recordButtonRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const ids = {
    subject: useId(),
    subjectCount: useId(),
    subjectError: useId(),
    body: useId(),
    bodyCount: useId(),
    bodyError: useId(),
    attachments: useId(),
    record: useId(),
    recordHint: useId(),
    mobile: useId(),
    mobileHint: useId(),
    mobileError: useId(),
    priority: useId(),
    sendHint: useId(),
    sent: useId(),
  };

  const canRecord = useSyncExternalStore<boolean | null>(subscribeNothing, canRecordScreen, unknownOnServer);

  // Leaving the page mid-recording, or with a recording on screen: every track stopped, the console
  // handed back, the upload cancelled and the object URL revoked.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      recorderRef.current?.cancel();
      recorderRef.current = null;
      takeAbortRef.current?.();
      takeAbortRef.current = null;
      if (takeUrlRef.current) URL.revokeObjectURL(takeUrlRef.current);
      takeUrlRef.current = null;
    };
  }, []);

  // The platform's switch and the workspace's DLP come from the server; the browser's ability from here.
  const recordBlocked =
    state.recordingBlockedReason === "dlp"
      ? DLP_BLOCKED
      : state.recordingBlockedReason === "setting" || !state.recordingAllowed
        ? SETTING_BLOCKED
        : canRecord === false
          ? BROWSER_BLOCKED
          : null;

  const takeUploading = take?.upload.state === "uploading";
  const takeUnattached = !!take && take.upload.state !== "done";
  const uploading = files.busy || takeUploading;
  const sendBlocked = uploading || takeUnattached;
  const sendHint = uploading ? "Waiting for the uploads to finish…" : takeUnattached ? "Attach or discard your recording first." : null;
  const hasDraft = subject.trim() !== "" || body.trim() !== "" || files.items.length > 0 || take !== null;

  const subjectLength = chars(subject);
  const bodyLength = chars(body);
  const showSubjectCount = subjectLength > LIMITS.subject * 0.8;
  const showBodyCount = bodyLength > LIMITS.body * 0.8;

  // ─── The recording ──────────────────────────────────────────────────────────────────────────

  /** Throws the recording away — the upload stopped, a staged copy handed back when `handBack`, the URL revoked. */
  function dropTake(handBack: boolean) {
    takeAbortRef.current?.();
    takeAbortRef.current = null;
    if (handBack && take?.upload.state === "done") discardStagedUpload(take.upload.uploadId);
    if (takeUrlRef.current) URL.revokeObjectURL(takeUrlRef.current);
    takeUrlRef.current = null;
    setTake(null);
    setFocusChip(false);
  }

  function openConsent() {
    setRecordNotice(null);
    setConfirmingDiscard(false);
    setPhase("consent");
  }

  function onTick(ms: number) {
    // Whole seconds only, so the bar re-renders once a second rather than four times.
    setElapsedMs(Math.floor(ms / 1000) * 1000);
    if (!warnedRef.current && ms >= RECORDING_WARNING_MS) {
      warnedRef.current = true;
      setAnnouncement("One minute of recording left.");
    }
  }

  function recordingStopped(result: RecordingResult | null) {
    recorderRef.current = null;
    if (!aliveRef.current) return;
    setPhase("idle");
    if (!result) {
      setRecordNotice("Nothing was recorded. Try again, or attach a screenshot instead.");
      setAnnouncement("Recording stopped. Nothing was recorded.");
      return;
    }
    const { reason, ...recording } = result;
    const url = URL.createObjectURL(recording.blob);
    takeUrlRef.current = url;
    const note =
      reason === "limit" ? "It stopped itself at the 5-minute limit." : reason === "size" ? "It stopped itself before it grew too large to send." : null;
    setTake({ ...recording, url, note, upload: { state: "none" } });
    setAnnouncement(`Recording stopped at ${formatClock(recording.durationMs)}. Watch it, then attach it or discard it.`);
  }

  /** From the consent dialog's click: the share picker has to be asked for inside it. */
  async function beginRecording() {
    setPhase("starting");
    warnedRef.current = false;
    const outcome = await startScreenRecording({ microphone, onTick, onStop: recordingStopped });
    if (!outcome.ok) {
      if (!aliveRef.current) return;
      setPhase("idle");
      // Closing the picker, or saying no to it, is a choice — back to the form without a word.
      if (outcome.reason === "failed") {
        setRecordNotice("The screen couldn't be recorded. Attach a screenshot instead.");
        setAnnouncement("The screen couldn't be recorded.");
      }
      return;
    }
    if (!aliveRef.current) {
      outcome.recorder.cancel();
      return;
    }
    recorderRef.current = outcome.recorder;
    setElapsedMs(0);
    setControls({ hasMicrophone: outcome.recorder.hasMicrophone, canPause: outcome.recorder.canPause, paused: false, muted: false });
    setPhase("recording");
    setAnnouncement(
      outcome.microphoneRefused
        ? "Recording started, without the microphone — your browser didn't allow it. Stop it from the bar at the bottom of the screen."
        : "Recording started. Stop it from the bar at the bottom of the screen.",
    );
  }

  function pauseRecording() {
    if (recorderRef.current?.pause()) setControls((c) => ({ ...c, paused: true }));
  }

  function resumeRecording() {
    if (recorderRef.current?.resume()) setControls((c) => ({ ...c, paused: false }));
  }

  function toggleMute() {
    const muted = !controls.muted;
    recorderRef.current?.setMuted(muted);
    setControls((c) => ({ ...c, muted }));
  }

  function attachTake() {
    if (!take || take.upload.state === "uploading" || take.upload.state === "done") return;
    const { url, blob, mime } = take;
    let last = -1;
    setTake((t) => (t && t.url === url ? { ...t, upload: { state: "uploading", percent: 0 } } : t));
    const job = uploadToSupport(blob, `screen-recording.${mime.includes("mp4") ? "mp4" : "webm"}`, "recording", (fraction) => {
      const percent = Math.min(100, Math.floor(fraction * 100));
      if (percent === last) return;
      last = percent;
      setTake((t) => (t && t.url === url && t.upload.state === "uploading" ? { ...t, upload: { state: "uploading", percent } } : t));
    });
    takeAbortRef.current = job.abort;
    void job.done.then((outcome) => {
      if (takeUrlRef.current !== url) {
        // Discarded while it uploaded, and the upload finished first: hand the staged copy back.
        if (outcome.ok) discardStagedUpload(outcome.upload.uploadId);
        return;
      }
      takeAbortRef.current = null;
      if (outcome.ok) {
        // The Attach button is about to become the chip; if it had the focus, the chip takes it.
        const active = document.activeElement;
        setFocusChip(!active || active === document.body || !!previewRef.current?.contains(active));
      }
      setTake((t) => {
        if (!t || t.url !== url) return t;
        if (outcome.ok) return { ...t, upload: { state: "done", uploadId: outcome.upload.uploadId } };
        return { ...t, upload: outcome.aborted ? { state: "none" } : { state: "failed", error: outcome.error } };
      });
    });
  }

  function recordAgain() {
    dropTake(true);
    openConsent();
  }

  function removeTake() {
    dropTake(true);
    focusSoon(recordButtonRef);
  }

  // ─── The form ───────────────────────────────────────────────────────────────────────────────

  /** Back to a blank form. `discard`: the draft was thrown away, so staged uploads are handed back. */
  function resetAll(discard: boolean) {
    files.clear({ discard });
    dropTake(discard);
    setSubject("");
    setBody("");
    setMobile(state.phone ?? "");
    setPriority(DEFAULT_PRIORITY);
    // Off by default for every new request, as the consent dialog promises.
    setMicrophone(false);
    setErrors({});
    setFormError(null);
    setSent(null);
    setConfirmingDiscard(false);
    setRecordNotice(null);
  }

  /** The X, Escape, the backdrop and Cancel all come here. */
  function requestClose() {
    if (sending) return;
    if (sent || !hasDraft) {
      resetAll(false);
      onClose();
      return;
    }
    // Asked a second time while the question is showing: the safe reading is "keep editing".
    if (confirmingDiscard) {
      keepEditing();
      return;
    }
    setConfirmingDiscard(true);
  }

  function keepEditing() {
    setConfirmingDiscard(false);
    focusSoon(cancelRef);
  }

  function discardDraft() {
    resetAll(true);
    onClose();
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    // Portalled to <body>, but React still bubbles the submit up the component tree.
    event.stopPropagation();
    if (sending || sendBlocked) return;

    const next: FieldErrors = {};
    const cleanSubject = subject.trim();
    if (!cleanSubject) next.subject = "Give your request a subject.";
    else if (chars(cleanSubject) > LIMITS.subject) next.subject = `Keep the subject to ${LIMITS.subject} characters.`;
    const cleanBody = body.trim();
    if (!cleanBody) next.body = "Tell us in detail what's happening.";
    else if (chars(cleanBody) > LIMITS.body) next.body = `Keep the details to ${LIMITS.body.toLocaleString("en-IN")} characters.`;
    const cleanMobile = mobile.replace(/\s+/g, " ").trim();
    if (cleanMobile && !MOBILE_PATTERN.test(cleanMobile)) next.mobile = MOBILE_REFUSED;
    setErrors(next);
    if (next.subject || next.body || next.mobile) {
      // Onto the first field to fix, where its message is read out with it.
      (next.subject ? subjectRef : next.body ? bodyRef : mobileRef).current?.focus();
      return;
    }

    setSending(true);
    setFormError(null);
    let result: SupportSubmitResult;
    try {
      result = await submitSupportRequest({
        subject: cleanSubject,
        body,
        mobile: cleanMobile || undefined,
        priority,
        uploadIds: files.readyIds,
        // Only a recording made after the consent dialog exists here, so `consent` is what they ticked.
        recording:
          take && take.upload.state === "done"
            ? { uploadId: take.upload.uploadId, durationMs: take.durationMs, consent: true, consoleLog: take.consoleLog, perf: take.perf }
            : undefined,
        context: clientContext(),
      });
    } catch {
      result = { ok: false, error: SEND_FAILED };
    }
    if (!aliveRef.current) return;
    setSending(false);
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    setSent({ number: result.number, email: result.email });
  }

  const helpline = state.helpline?.trim() || null;
  const hours = state.hours?.trim() || null;

  return (
    <>
      <Dialog open={open && phase === "idle"} onClose={requestClose} title="How can we help you today?">
        {sent ? (
          <div className="flex flex-col items-center gap-3 px-2 py-6 text-center">
            <CircleCheck aria-hidden="true" className="h-10 w-10 text-success" />
            <p id={ids.sent} className="text-sm leading-relaxed text-text">
              <span className="font-medium">Request {supportRef(sent.number)} sent.</span> We&apos;ve emailed a copy to{" "}
              <strong className="font-medium">{sent.email}</strong>.
            </p>
            <Button type="button" size="sm" autoFocus aria-describedby={ids.sent} onClick={requestClose}>
              Close
            </Button>
          </div>
        ) : (
          <form onSubmit={send} noValidate className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <Label htmlFor={ids.subject}>
                  Subject <span aria-hidden="true" className="text-danger">*</span>
                </Label>
                {showSubjectCount && <Counter id={ids.subjectCount} length={subjectLength} max={LIMITS.subject} />}
              </div>
              <Input
                ref={subjectRef}
                id={ids.subject}
                value={subject}
                autoComplete="off"
                aria-required="true"
                aria-invalid={errors.subject ? true : undefined}
                aria-describedby={describedBy(errors.subject && ids.subjectError, showSubjectCount && ids.subjectCount)}
                onChange={(event) => {
                  setSubject(event.target.value);
                  if (errors.subject) setErrors((e) => ({ ...e, subject: undefined }));
                }}
              />
              {errors.subject && <FieldError id={ids.subjectError} message={errors.subject} />}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <Label htmlFor={ids.body}>
                  Tell us in detail <span aria-hidden="true" className="text-danger">*</span>
                </Label>
                {showBodyCount && <Counter id={ids.bodyCount} length={bodyLength} max={LIMITS.body} />}
              </div>
              <Textarea
                ref={bodyRef}
                id={ids.body}
                rows={6}
                value={body}
                placeholder="What were you trying to do, and what happened instead?"
                aria-required="true"
                aria-invalid={errors.body ? true : undefined}
                aria-describedby={describedBy(errors.body && ids.bodyError, showBodyCount && ids.bodyCount)}
                className="min-h-32 resize-y"
                onChange={(event) => {
                  setBody(event.target.value);
                  if (errors.body) setErrors((e) => ({ ...e, body: undefined }));
                }}
              />
              {errors.body && <FieldError id={ids.bodyError} message={errors.body} />}
            </div>

            <div className="space-y-1.5">
              <p id={ids.attachments} className="text-[13px] font-medium text-muted">
                Attachments
              </p>
              <AttachmentPicker items={files.items} refused={files.refused} onAdd={files.add} onRemove={files.remove} labelId={ids.attachments} />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={ids.mobile}>Mobile number</Label>
                <Input
                  ref={mobileRef}
                  id={ids.mobile}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  maxLength={24}
                  value={mobile}
                  aria-invalid={errors.mobile ? true : undefined}
                  aria-describedby={describedBy(errors.mobile ? ids.mobileError : ids.mobileHint)}
                  onChange={(event) => {
                    setMobile(event.target.value);
                    if (errors.mobile) setErrors((e) => ({ ...e, mobile: undefined }));
                  }}
                />
                {errors.mobile ? (
                  <FieldError id={ids.mobileError} message={errors.mobile} />
                ) : (
                  <p id={ids.mobileHint} className="text-xs text-subtle">
                    Optional — in case a call is quicker.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={ids.priority}>How critical is your request?</Label>
                <Select id={ids.priority} value={priority} onChange={(event) => setPriority(event.target.value as SupportPriorityKey)}>
                  {PRIORITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <div role="group" aria-labelledby={ids.record} className="space-y-1.5">
              <p id={ids.record} className="text-[13px] font-medium text-muted">
                Screen recording
              </p>
              {take ? (
                take.upload.state === "done" ? (
                  <RecordingChip url={take.url} durationMs={take.durationMs} size={take.blob.size} focusPlay={focusChip} onRemove={removeTake} />
                ) : (
                  <div ref={previewRef}>
                    <RecordingPreview
                      url={take.url}
                      durationMs={take.durationMs}
                      size={take.blob.size}
                      note={take.note}
                      upload={take.upload}
                      onAttach={attachTake}
                      onRedo={recordAgain}
                      onDiscard={removeTake}
                    />
                  </div>
                )
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    {/* The tooltip sits on a wrapper: a disabled button gets no hover, so its own title never shows. */}
                    <span title={recordBlocked ?? undefined} className="inline-flex">
                      <Button
                        ref={recordButtonRef}
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={!!recordBlocked}
                        aria-describedby={ids.recordHint}
                        onClick={openConsent}
                      >
                        <Video aria-hidden="true" className="h-3.5 w-3.5" />
                        Record screen
                      </Button>
                    </span>
                    <span id={ids.recordHint} className="text-xs text-subtle">
                      {recordBlocked ?? "Show us what's happening — up to 5 minutes, with your consent."}
                    </span>
                  </div>
                  {recordNotice && <p className="text-xs text-muted">{recordNotice}</p>}
                </>
              )}
            </div>

            <div className="space-y-1.5 rounded-lg bg-surface-sunken/60 px-3 py-2.5 text-xs text-muted">
              {(helpline || hours) && (
                <p className="flex items-start gap-1.5">
                  <Phone aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
                  <span>
                    Helpline:{" "}
                    {helpline && (
                      <a href={`tel:${helpline.replace(/[^\d+]/g, "")}`} className="font-medium text-text hover:text-brand">
                        {helpline}
                      </a>
                    )}
                    {helpline && hours && " · "}
                    {hours}
                  </span>
                </p>
              )}
              <p className="flex items-start gap-1.5">
                <Mail aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
                <span>
                  Our response will be sent to your email address <strong className="font-medium text-text">{state.email}</strong>.
                </span>
              </p>
            </div>
            <p className="text-[11px] leading-relaxed text-subtle">
              We&apos;ll include the page you were on and your browser and device details, to help us reproduce the problem.
            </p>

            {formError && <ActionNotice tone="error">{formError}</ActionNotice>}

            {confirmingDiscard ? (
              <div role="alert" className="rounded-lg border border-warning/40 bg-warning-bg p-3">
                <p className="text-sm font-medium text-text">Discard this request?</p>
                <p className="mt-0.5 text-xs text-muted">
                  What you&apos;ve written{files.items.length > 0 || take ? " and attached" : ""} will be lost.
                </p>
                <div className="mt-2.5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <Button type="button" variant="secondary" size="sm" autoFocus onClick={keepEditing}>
                    Keep editing
                  </Button>
                  <Button type="button" variant="danger" size="sm" onClick={discardDraft}>
                    Discard
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
                {sendHint && (
                  <p id={ids.sendHint} className="text-xs text-subtle sm:mr-auto">
                    {sendHint}
                  </p>
                )}
                <Button ref={cancelRef} type="button" variant="secondary" size="sm" onClick={requestClose}>
                  Cancel
                </Button>
                {/*
                  Disabled while something is still uploading; only aria-disabled while sending, so the
                  button that was just pressed keeps the keyboard focus instead of dropping it to <body>.
                */}
                <Button
                  type="submit"
                  size="sm"
                  disabled={sendBlocked && !sending}
                  aria-disabled={sending || undefined}
                  aria-describedby={sendHint ? ids.sendHint : undefined}
                >
                  {sending || uploading ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Send aria-hidden="true" className="h-3.5 w-3.5" />}
                  {sending ? "Sending…" : "Send"}
                </Button>
              </div>
            )}
          </form>
        )}
      </Dialog>

      <RecordingConsent
        open={open && (phase === "consent" || phase === "starting")}
        brandName={state.brandName}
        microphone={microphone}
        onMicrophoneChange={setMicrophone}
        starting={phase === "starting"}
        onStart={() => void beginRecording()}
        onCancel={() => setPhase("idle")}
      />

      {phase === "recording" && (
        <RecordingBar
          elapsedMs={elapsedMs}
          paused={controls.paused}
          canPause={controls.canPause}
          hasMicrophone={controls.hasMicrophone}
          muted={controls.muted}
          onPause={pauseRecording}
          onResume={resumeRecording}
          onToggleMute={toggleMute}
          onStop={() => recorderRef.current?.stop()}
        />
      )}

      {/*
        The start, the one-minute warning and the stop, read out. Always rendered, outside every
        dialog: a live region only announces changes to itself, and the recording bar that could
        have held it is gone by the time "stopped" needs saying.
      */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
    </>
  );
}

/** Shown near the limit: amber, then red past it. */
function Counter({ id, length, max }: { id: string; length: number; max: number }) {
  const over = length > max;
  return (
    <span id={id} className={cn("shrink-0 text-[11px] tabular-nums", over ? "font-medium text-danger" : "text-warning")}>
      {length.toLocaleString("en-IN")} / {max.toLocaleString("en-IN")}
      {over && <span className="sr-only"> — too long</span>}
    </span>
  );
}

function FieldError({ id, message }: { id: string; message: string }) {
  return (
    <p id={id} role="alert" className="flex items-start gap-1 text-xs text-danger">
      <CircleAlert aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
      <span>{message}</span>
    </p>
  );
}
