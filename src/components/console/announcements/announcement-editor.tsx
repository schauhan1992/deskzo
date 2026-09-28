"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2, CircleAlert, Earth, Info, Layers, LoaderCircle, TriangleAlert, Users, X } from "lucide-react";
import { consoleAnnouncementReach, consoleSaveAnnouncement } from "@/actions/platform/console-announcements";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { InsetBlock, Panel } from "@/components/console/kit/panel";
import { TONE_TEXT } from "@/components/console/kit/status";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { AnnouncementBanner } from "@/components/platform/announcement-banner";
import { Checkbox } from "@/components/ui/bulk-select";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { OptionCombobox, type ComboOption } from "@/components/ui/option-combobox";
import { durationText, plural, when } from "@/lib/console-shared/format";
import { ANNOUNCEMENT_TONE } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import { istDateTimeInput, parseIstDateTime } from "@/lib/india-time";
import type { AnnouncementAudienceKey, AnnouncementRow, AnnouncementTargets, AnnouncementToneKey } from "@/lib/platform/announcements";
import { cn } from "@/lib/utils";

/**
 * The announcement editor (`/announcements/new`, `/announcements/[id]`): the form on the left, and on
 * the right the banner exactly as a workspace draws it (the same `AnnouncementBanner`) with how many
 * open workspaces it reaches and a few of their addresses.
 *
 * Reach is asked of the server (`consoleAnnouncementReach`) 400 ms after the audience last changed —
 * from the change handlers, not an effect — and a late answer for an audience since changed is
 * dropped. Saving is a T2 confirmation showing what goes up, where and when; an announcement to every
 * workspace, or a critical one nobody can dismiss, also needs "publish" typed, which the server checks
 * again. The checks here mirror the save's (src/lib/platform/announcements.ts `validateAnnouncement`)
 * only to point at the field early; the save's refusal is what the dialog shows.
 *
 * Times are India wall-clock `datetime-local` values; the server reads them as IST. Only managers are
 * given this component — everybody else gets the page's read-only view — and "All workspaces" is only
 * drawn for an owner.
 */

type Mode = "create" | "edit" | "duplicate";
type Field = "title" | "body" | "targets" | "startsAt" | "endsAt";
type Problem = { field: Field; message: string };

type Draft = {
  title: string;
  body: string;
  tone: AnnouncementToneKey;
  audience: AnnouncementAudienceKey;
  /** Each audience keeps its own picks, so trying another audience and coming back loses nothing. */
  countries: string[];
  plans: string[];
  tenants: string[];
  /** `yyyy-mm-ddThh:mm`, India time; "" for none. */
  startsAt: string;
  endsAt: string;
  dismissible: boolean;
};

type SaveInput = {
  id?: string;
  title: string;
  body: string;
  tone: AnnouncementToneKey;
  audience: AnnouncementAudienceKey;
  targets: string[];
  startsAt?: string;
  endsAt?: string;
  dismissible: boolean;
};

type Reach = { key: string; status: "loading" | "ready" | "error"; count: number; sample: string[] };

const TITLE_MIN = 3;
const TITLE_MAX = 120;
const BODY_MAX = 1000;
const TARGETS_MAX = 200;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WINDOW_MAX_MS = 90 * DAY_MS;
const REACH_DEBOUNCE_MS = 400;
const REACH_FAILED = "Couldn't count the workspaces just now — it will try again when the audience changes.";

const TONES: { value: AnnouncementToneKey; body: string; icon: ReactNode }[] = [
  { value: "INFO", body: "News, a new feature or a small change. People can dismiss it.", icon: <Info className="h-4 w-4" /> },
  { value: "WARNING", body: "Planned maintenance, or something to act on soon.", icon: <TriangleAlert className="h-4 w-4" /> },
  { value: "CRITICAL", body: "An outage or something urgent. It can't be dismissed and needs an end time.", icon: <CircleAlert className="h-4 w-4" /> },
];

const AUDIENCES: { value: AnnouncementAudienceKey; title: string; body: string; icon: ReactNode }[] = [
  { value: "ALL", title: "All workspaces", body: "Every open workspace.", icon: <Earth className="h-4 w-4" /> },
  { value: "COUNTRIES", title: "Countries", body: "Open workspaces in the countries you choose.", icon: <Building2 className="h-4 w-4" /> },
  { value: "PLANS", title: "Plans", body: "Open workspaces with a live subscription to a plan you choose.", icon: <Layers className="h-4 w-4" /> },
  { value: "TENANTS", title: "Specific workspaces", body: `Up to ${TARGETS_MAX}, chosen by name.`, icon: <Users className="h-4 w-4" /> },
];

const TARGET_WORD: Record<Exclude<AnnouncementAudienceKey, "ALL">, string> = { COUNTRIES: "country", PLANS: "plan", TENANTS: "workspace" };

/** Quick ends, counted from the start (or from now, for one that starts when published). */
const QUICK_ENDS: { label: string; ms: number }[] = [
  { label: "2 hours", ms: 2 * HOUR_MS },
  { label: "1 day", ms: DAY_MS },
  { label: "3 days", ms: 3 * DAY_MS },
  { label: "1 week", ms: 7 * DAY_MS },
];

function draftOf(initial: AnnouncementRow | null, mode: Mode, caps: Caps): Draft {
  if (!initial) {
    return { title: "", body: "", tone: "INFO", audience: caps.announceAll ? "ALL" : "COUNTRIES", countries: [], plans: [], tenants: [], startsAt: "", endsAt: "", dismissible: true };
  }
  const picks = (audience: AnnouncementAudienceKey) => (initial.audience === audience ? [...initial.targets] : []);
  return {
    title: initial.title,
    body: initial.body,
    tone: initial.tone,
    // Only an owner speaks to every workspace; anybody else copying such a one chooses a narrower audience.
    audience: initial.audience === "ALL" && !caps.announceAll ? "COUNTRIES" : initial.audience,
    countries: picks("COUNTRIES"),
    plans: picks("PLANS"),
    tenants: picks("TENANTS"),
    // A copy runs when it is told to: the original's window is usually over.
    startsAt: mode === "edit" ? istDateTimeInput(initial.startsAt) : "",
    endsAt: mode === "edit" ? istDateTimeInput(initial.endsAt) : "",
    dismissible: initial.tone !== "CRITICAL" && initial.dismissible,
  };
}

function targetsOf(d: Draft): string[] {
  switch (d.audience) {
    case "ALL":
      return [];
    case "COUNTRIES":
      return d.countries;
    case "PLANS":
      return d.plans;
    case "TENANTS":
      return d.tenants;
  }
}

/** Identifies an audience for the reach preview: the same picks in another order are the same audience. */
const reachKey = (audience: AnnouncementAudienceKey, targets: readonly string[]) => `${audience}:${[...targets].sort().join(",")}`;

/** Characters as the database counts them — an emoji is one. */
const charCount = (s: string) => [...s].length;
const oneLine = (s: string) => s.trim().replace(/\s+/g, " ");

function inputOf(d: Draft, id: string | undefined): SaveInput {
  return {
    ...(id ? { id } : {}),
    title: oneLine(d.title),
    body: d.body.replace(/\r\n?/g, "\n").trim(),
    tone: d.tone,
    audience: d.audience,
    targets: [...targetsOf(d)],
    startsAt: d.startsAt || undefined,
    endsAt: d.endsAt || undefined,
    dismissible: d.tone !== "CRITICAL" && d.dismissible,
  };
}

/** Order-free, so unticking a country and ticking it again is not a change. */
const signature = (input: SaveInput) => JSON.stringify({ ...input, targets: [...input.targets].sort() });

/**
 * What stops a save. `now` is the moment Save was pressed (state, never the render's clock): the
 * checks that need the time — an end already past, a window counted from "now" — wait for it.
 */
function problemsOf(d: Draft, savedStart: Date | null, now: number | null): Problem[] {
  const out: Problem[] = [];
  const title = charCount(oneLine(d.title));
  if (title < TITLE_MIN) out.push({ field: "title", message: `Give it a title of at least ${TITLE_MIN} characters.` });
  else if (title > TITLE_MAX) out.push({ field: "title", message: `Keep the title to ${TITLE_MAX} characters.` });
  const body = charCount(d.body.trim());
  if (body < 1) out.push({ field: "body", message: "Write what the announcement says." });
  else if (body > BODY_MAX) out.push({ field: "body", message: "Keep the message to 1,000 characters." });

  if (d.audience !== "ALL") {
    const n = targetsOf(d).length;
    const word = TARGET_WORD[d.audience];
    if (n === 0) out.push({ field: "targets", message: `Choose at least one ${word}.` });
    else if (n > TARGETS_MAX) out.push({ field: "targets", message: `Choose at most ${TARGETS_MAX} — use countries or plans for more.` });
  }

  const start = d.startsAt ? parseIstDateTime(d.startsAt) : null;
  const end = d.endsAt ? parseIstDateTime(d.endsAt) : null;
  if (d.startsAt && !start) out.push({ field: "startsAt", message: "Enter the start as a date and time." });
  if (d.endsAt && !end) out.push({ field: "endsAt", message: "Enter the end as a date and time." });
  if (d.tone === "CRITICAL" && !d.endsAt) out.push({ field: "endsAt", message: "A critical announcement can't be dismissed, so it needs an end time." });
  const from = d.startsAt ? start : (savedStart ?? (now === null ? null : new Date(now)));
  if (from && end) {
    if (end.getTime() <= from.getTime()) out.push({ field: "endsAt", message: "The end must be after the start." });
    else if (end.getTime() - from.getTime() > WINDOW_MAX_MS) out.push({ field: "endsAt", message: "An announcement can run for at most 90 days — choose an earlier end." });
    else if (now !== null && end.getTime() <= now) out.push({ field: "endsAt", message: "The end time has already passed — choose a later one." });
  }
  return out;
}

/** "Thu, 1 Oct 2026, 10:00 am" for a valid input value, else null. */
function stampOf(value: string): string | null {
  const at = value ? parseIstDateTime(value) : null;
  return at ? when(at) : null;
}

/** The wall clock — for event handlers only; a render reads the time Save was pressed from state. */
function clockNow(): number {
  return Date.now();
}

/** "3 days", "1 day 4 h", "2 h 30 min" — how long it runs. */
function spanText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days === 0) return durationText(ms);
  return hours ? `${plural(days, "day")} ${hours} h` : plural(days, "day");
}

/** How many open workspaces an audience reaches now, as the reach panel shows it. Never throws. */
async function askReach(audience: AnnouncementAudienceKey, targets: string[], key: string): Promise<Reach> {
  try {
    const result = await consoleAnnouncementReach(audience, targets);
    return result.ok ? { key, status: "ready", count: result.data.count, sample: result.data.sample } : { key, status: "error", count: 0, sample: [] };
  } catch {
    return { key, status: "error", count: 0, sample: [] };
  }
}

export function AnnouncementEditor({
  initial,
  targets,
  caps,
  mode,
}: {
  initial: AnnouncementRow | null;
  targets: AnnouncementTargets;
  caps: Caps;
  mode: Mode;
}) {
  const router = useRouter();
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  /** The draft the page came with, and its audience as the reach preview identifies it — never set again. */
  const [opening] = useState(() => {
    const first = draftOf(initial, mode, caps);
    const list = targetsOf(first);
    return { draft: first, audience: first.audience, targets: list, key: reachKey(first.audience, list), counts: first.audience === "ALL" || list.length > 0 };
  });
  const [draft, setDraft] = useState<Draft>(opening.draft);
  /** When Save was last pressed — the clock the time checks use; null until then. */
  const [attemptedAt, setAttemptedAt] = useState<number | null>(null);

  const editId = mode === "edit" && initial ? initial.id : undefined;
  const savedStart = mode === "edit" && initial ? initial.startsAt : null;
  const initialInput = useMemo(() => inputOf(opening.draft, editId), [opening, editId]);
  const input = inputOf(draft, editId);
  const dirty = mode !== "edit" || signature(input) !== signature(initialInput);
  const problems = problemsOf(draft, savedStart, attemptedAt);
  const errors: Partial<Record<Field, string>> = {};
  if (attemptedAt !== null) for (const p of problems) errors[p.field] ??= p.message;

  const critical = draft.tone === "CRITICAL";
  const needsTyped = draft.audience === "ALL" || critical;
  const lostAll = initial?.audience === "ALL" && !caps.announceAll;

  // ─── Reach ─────────────────────────────────────────────────────────────────────────────────────
  const [reach, setReach] = useState<Reach>({ key: opening.key, status: opening.counts ? "loading" : "ready", count: 0, sample: [] });
  const reachTimer = useRef<number | undefined>(undefined);
  /** Bumped by every request; an answer carrying an older ticket is for an audience since changed. */
  const reachTicket = useRef(0);

  // The first count, for an audience that came with the page (an edit, a copy, or "All" for an
  // owner). The state is set when the answer arrives, never in the effect's own body.
  useEffect(() => {
    if (!opening.counts) return;
    const ticket = ++reachTicket.current;
    const timer = window.setTimeout(async () => {
      const answer = await askReach(opening.audience, opening.targets, opening.key);
      if (ticket === reachTicket.current) setReach(answer);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [opening]);

  // A count still waiting to be asked for is not asked for once the editor has gone.
  useEffect(() => {
    const timers = reachTimer;
    return () => window.clearTimeout(timers.current);
  }, []);

  /** Called by every handler that changes the audience or its picks: count again, 400 ms after the last change. */
  function recount(next: Draft) {
    const list = [...targetsOf(next)];
    const key = reachKey(next.audience, list);
    if (key === reach.key && reach.status !== "error") return;
    window.clearTimeout(reachTimer.current);
    const ticket = ++reachTicket.current;
    if (next.audience !== "ALL" && list.length === 0) {
      setReach({ key, status: "ready", count: 0, sample: [] });
      return;
    }
    setReach((r) => ({ key, status: "loading", count: r.count, sample: r.sample }));
    reachTimer.current = window.setTimeout(async () => {
      const answer = await askReach(next.audience, list, key);
      if (ticket === reachTicket.current) setReach(answer);
    }, REACH_DEBOUNCE_MS);
  }

  function update<K extends keyof Draft>(field: K, value: Draft[K]) {
    const next = { ...draft, [field]: value };
    // A critical announcement is never dismissible; the box stays off until the tone changes back.
    if (field === "tone" && value === "CRITICAL") next.dismissible = false;
    if (field === "tone" && value !== "CRITICAL" && draft.tone === "CRITICAL") next.dismissible = true;
    setDraft(next);
    if (field === "audience" || field === "countries" || field === "plans" || field === "tenants") recount(next);
  }

  function toggle(field: "countries" | "plans" | "tenants", value: string, on: boolean) {
    const list = draft[field];
    update(field, on ? (list.includes(value) ? list : [...list, value]) : list.filter((v) => v !== value));
  }

  /** "End after 1 day": counted from the start typed, or from now for one that starts when published. */
  function quickEnd(ms: number) {
    const start = draft.startsAt ? parseIstDateTime(draft.startsAt) : savedStart;
    const from = start ? start.getTime() : clockNow();
    update("endsAt", istDateTimeInput(new Date(from + ms)));
  }

  // ─── Saving ────────────────────────────────────────────────────────────────────────────────────
  const [saveOpen, setSaveOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<{ input: SaveInput; scheduled: boolean; startText: string } | null>(null);
  const save = useConsoleAction<{ id: string }>();

  function requestSave() {
    const now = clockNow();
    setAttemptedAt(now);
    const found = problemsOf(draft, savedStart, now);
    if (found.length > 0) {
      rootRef.current?.querySelector<HTMLElement>(`[data-announcement-field="${found[0]!.field}"]`)?.focus();
      return;
    }
    const start = draft.startsAt ? parseIstDateTime(draft.startsAt) : savedStart;
    const scheduled = start !== null && start.getTime() > now;
    save.reset();
    setSnapshot({ input, scheduled, startText: start && scheduled ? when(start) : "" });
    setSaveOpen(true);
  }

  function confirmSave({ typed }: { typed: string; reason: string }) {
    if (!snapshot) return;
    const sent = snapshot;
    const typedNeeded = sent.input.audience === "ALL" || sent.input.tone === "CRITICAL";
    save.run(() => consoleSaveAnnouncement({ ...sent.input, ...(typedNeeded ? { confirm: typed } : {}) }), {
      success: mode === "edit" ? "Announcement saved." : sent.scheduled ? "Announcement scheduled." : "Announcement published.",
      // Leaving for the list, which loads fresh; refreshing this page first would only redraw it.
      refresh: false,
      onDone: () => {
        setSaveOpen(false);
        router.push(sent.scheduled ? "/announcements?tab=scheduled" : "/announcements");
      },
    });
  }

  function discard() {
    setDraft(opening.draft);
    setAttemptedAt(null);
    recount(opening.draft);
  }

  const confirmLabel = mode === "edit" ? "Save changes" : snapshot?.scheduled ? "Schedule" : "Publish";
  const saveLabel = mode === "edit" ? "Save changes" : "Publish…";

  // ─── Field ids ─────────────────────────────────────────────────────────────────────────────────
  const ids = {
    title: `${uid}-title`,
    titleHint: `${uid}-title-hint`,
    body: `${uid}-body`,
    bodyHint: `${uid}-body-hint`,
    starts: `${uid}-starts`,
    startsHint: `${uid}-starts-hint`,
    ends: `${uid}-ends`,
    endsHint: `${uid}-ends-hint`,
    workspace: `${uid}-workspace`,
    tone: `${uid}-tone`,
    audience: `${uid}-audience`,
  };

  const titleCount = charCount(oneLine(draft.title));
  const bodyCount = charCount(draft.body.trim());
  const startText = stampOf(draft.startsAt);
  const endText = stampOf(draft.endsAt);
  const startAt = draft.startsAt ? parseIstDateTime(draft.startsAt) : savedStart;
  const endAt = draft.endsAt ? parseIstDateTime(draft.endsAt) : null;
  const span = startAt && endAt && endAt.getTime() > startAt.getTime() ? spanText(endAt.getTime() - startAt.getTime()) : null;

  const savedStartText = mode === "edit" && savedStart ? when(savedStart) : null;
  const shows = startText ? `${startText} IST` : savedStartText ? `${savedStartText} IST` : "As soon as it's published";
  const until = endText ? `${endText} IST` : "Until someone ends it";

  return (
    <div ref={rootRef} className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        {/* ─── The form ─── */}
        <div className="min-w-0 space-y-6">
          <Panel title="Message" description="Plain text: line breaks are kept; links, markdown and HTML are not.">
            <div className="space-y-5">
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <Label htmlFor={ids.title}>Title</Label>
                  <span className={cn("text-[11px] tabular-nums", titleCount > TITLE_MAX ? "text-danger" : "text-subtle")}>{`${titleCount} / ${TITLE_MAX}`}</span>
                </div>
                <Input
                  id={ids.title}
                  data-announcement-field="title"
                  value={draft.title}
                  onChange={(e) => update("title", e.target.value)}
                  placeholder="Scheduled maintenance on Sunday night"
                  autoComplete="off"
                  aria-invalid={errors.title ? true : undefined}
                  aria-describedby={errors.title ? ids.titleHint : undefined}
                />
                <FieldError id={ids.titleHint} message={errors.title} />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <Label htmlFor={ids.body}>Message</Label>
                  <span className={cn("text-[11px] tabular-nums", bodyCount > BODY_MAX ? "text-danger" : "text-subtle")}>{`${bodyCount} / ${BODY_MAX}`}</span>
                </div>
                <Textarea
                  id={ids.body}
                  data-announcement-field="body"
                  value={draft.body}
                  onChange={(e) => update("body", e.target.value)}
                  rows={5}
                  placeholder="Workspaces will be unavailable for about 30 minutes while we upgrade the database. Nothing is lost; save your work before 11 pm."
                  aria-invalid={errors.body ? true : undefined}
                  aria-describedby={ids.bodyHint}
                />
                {errors.body ? (
                  <FieldError id={ids.bodyHint} message={errors.body} />
                ) : (
                  <Hint id={ids.bodyHint}>Shown in full under the title. Keep it to what people need to do, and when.</Hint>
                )}
              </div>

              <fieldset className="space-y-2">
                <legend className="text-[13px] font-medium text-muted">Tone</legend>
                <div className="grid gap-2 sm:grid-cols-3">
                  {TONES.map((t) => {
                    const chosen = draft.tone === t.value;
                    const label = ANNOUNCEMENT_TONE[t.value];
                    return (
                      <label
                        key={t.value}
                        className={cn(
                          "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5",
                          chosen ? "border-brand bg-brand-subtle" : "border-line hover:bg-surface-sunken",
                        )}
                      >
                        <input
                          type="radio"
                          name={ids.tone}
                          value={t.value}
                          checked={chosen}
                          onChange={() => update("tone", t.value)}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand)]"
                        />
                        <span className="min-w-0">
                          <span className={cn("flex items-center gap-1.5 text-sm font-medium", TONE_TEXT[label.tone])}>
                            <span aria-hidden="true" className="inline-flex">
                              {t.icon}
                            </span>
                            {label.label}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted">{t.body}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            </div>
          </Panel>

          <Panel title="Audience" description="Who sees it. Only open workspaces are shown announcements.">
            <div className="space-y-4">
              {lostAll && (
                <InsetBlock className="text-xs text-muted">
                  The original went to every workspace — only an owner can announce to all of them. Choose who this one is for.
                </InsetBlock>
              )}
              <fieldset className="space-y-2">
                <legend className="sr-only">Who it is for</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {AUDIENCES.filter((a) => a.value !== "ALL" || caps.announceAll).map((a) => {
                    const chosen = draft.audience === a.value;
                    return (
                      <label
                        key={a.value}
                        className={cn(
                          "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5",
                          chosen ? "border-brand bg-brand-subtle" : "border-line hover:bg-surface-sunken",
                        )}
                      >
                        <input
                          type="radio"
                          name={ids.audience}
                          value={a.value}
                          checked={chosen}
                          onChange={() => update("audience", a.value)}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand)]"
                        />
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5 text-sm font-medium text-text">
                            <span aria-hidden="true" className="inline-flex text-subtle">
                              {a.icon}
                            </span>
                            {a.title}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted">{a.body}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              {draft.audience === "COUNTRIES" && (
                <CountryPicker available={targets.countries} chosen={draft.countries} error={errors.targets} onToggle={(code, on) => toggle("countries", code, on)} onClear={() => update("countries", [])} />
              )}
              {draft.audience === "PLANS" && (
                <PlanPicker available={targets.plans} chosen={draft.plans} error={errors.targets} onToggle={(key, on) => toggle("plans", key, on)} onClear={() => update("plans", [])} />
              )}
              {draft.audience === "TENANTS" && (
                <WorkspacePicker
                  inputId={ids.workspace}
                  available={targets.tenants}
                  chosen={draft.tenants}
                  error={errors.targets}
                  onAdd={(id) => toggle("tenants", id, true)}
                  onRemove={(id) => toggle("tenants", id, false)}
                  onClear={() => update("tenants", [])}
                />
              )}
            </div>
          </Panel>

          <Panel title="Schedule" description="India time (IST). An announcement runs for at most 90 days.">
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={ids.starts}>Starts</Label>
                  <Input
                    id={ids.starts}
                    data-announcement-field="startsAt"
                    type="datetime-local"
                    value={draft.startsAt}
                    onChange={(e) => update("startsAt", e.target.value)}
                    aria-invalid={errors.startsAt ? true : undefined}
                    aria-describedby={ids.startsHint}
                    className="tabular-nums"
                  />
                  {errors.startsAt ? (
                    <FieldError id={ids.startsHint} message={errors.startsAt} />
                  ) : (
                    <Hint id={ids.startsHint}>{mode === "edit" ? "Leave empty to keep the current start." : "Leave empty to start as soon as it's published."}</Hint>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={ids.ends}>Ends{critical ? " (required)" : ""}</Label>
                  <Input
                    id={ids.ends}
                    data-announcement-field="endsAt"
                    type="datetime-local"
                    value={draft.endsAt}
                    onChange={(e) => update("endsAt", e.target.value)}
                    aria-invalid={errors.endsAt ? true : undefined}
                    aria-required={critical || undefined}
                    aria-describedby={ids.endsHint}
                    className="tabular-nums"
                  />
                  {errors.endsAt ? (
                    <FieldError id={ids.endsHint} message={errors.endsAt} />
                  ) : (
                    <Hint id={ids.endsHint}>{critical ? "A critical announcement stays up until it ends." : "Leave empty to keep it up until someone ends it."}</Hint>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs text-muted">End after</span>
                {QUICK_ENDS.map((q) => (
                  <Button key={q.label} type="button" variant="secondary" size="sm" className="h-7 px-2.5 text-xs" onClick={() => quickEnd(q.ms)}>
                    {q.label}
                  </Button>
                ))}
                {draft.endsAt && !critical && (
                  <Button type="button" variant="ghost" size="sm" className="h-7 px-2.5 text-xs" onClick={() => update("endsAt", "")}>
                    No end
                  </Button>
                )}
              </div>

              <label className={cn("flex items-start gap-3 rounded-lg border border-line px-4 py-3", critical ? "cursor-not-allowed bg-surface-sunken" : "cursor-pointer")}>
                <Checkbox
                  checked={!critical && draft.dismissible}
                  disabled={critical}
                  onChange={(e) => update("dismissible", e.target.checked)}
                  className="mt-0.5 shrink-0 disabled:cursor-not-allowed"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-text">People can dismiss it</span>
                  <span className="block text-xs text-muted">
                    {critical
                      ? "A critical announcement can't be dismissed — it stays across the top of every page until it ends."
                      : "A dismissed banner stays hidden in that browser. Untick to keep it up for everyone until it ends."}
                  </span>
                </span>
              </label>
            </div>
          </Panel>
        </div>

        {/* ─── What it looks like, and who sees it ─── */}
        <div className="min-w-0 space-y-6 lg:sticky lg:top-20">
          <Panel title="Preview" description="Across the top of every page in a workspace it reaches.">
            <div aria-label="Preview of the banner" role="group" className="rounded-lg border border-line bg-bg p-3">
              <AnnouncementBanner
                title={oneLine(draft.title) || "Your title"}
                body={draft.body.trim() || "What the announcement says appears here."}
                tone={draft.tone}
                dismissAction={
                  !critical && draft.dismissible ? (
                    <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-base text-subtle" title="People can dismiss it">
                      <X className="h-4 w-4" />
                    </span>
                  ) : undefined
                }
              />
              {/* A suggestion of the page underneath, so the banner is seen in place. */}
              <div aria-hidden="true" className="mt-3 space-y-2 px-1 pb-1">
                <div className="h-2.5 w-1/3 rounded-full bg-line" />
                <div className="h-2 w-5/6 rounded-full bg-surface-sunken" />
                <div className="h-2 w-2/3 rounded-full bg-surface-sunken" />
              </div>
            </div>
          </Panel>

          <Panel title="Reach" description="Open workspaces it would show in, counted now.">
            <ReachSummary reach={reach} audience={draft.audience} hasTargets={targetsOf(draft).length > 0} />
          </Panel>

          <Panel title="When">
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-xs text-muted">Shows from</dt>
                <dd className="mt-0.5 text-sm break-words text-text">{shows}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted">Until</dt>
                <dd className="mt-0.5 text-sm break-words text-text">{until}</dd>
              </div>
              {span && (
                <div className="min-w-0 sm:col-span-full">
                  <dt className="text-xs text-muted">For</dt>
                  <dd className="mt-0.5 text-sm text-text tabular-nums">{span}</dd>
                </div>
              )}
            </dl>
          </Panel>
        </div>
      </div>

      {/* Above the lifted table actions (z-[1]–z-[3]) and below the top bar (z-20), as the plan editor's. */}
      <div className="sticky bottom-4 z-[4] rounded-xl border border-line bg-surface/95 px-4 py-3 shadow-lg backdrop-blur-md">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 text-xs" aria-live="polite">
            {attemptedAt !== null && problems.length > 0 ? (
              <p className="text-danger">
                <span className="font-medium">{plural(problems.length, "thing")} to fix before saving.</span> {problems[0]!.message}
              </p>
            ) : mode === "edit" ? (
              dirty ? (
                <p className="flex items-center gap-2 text-text">
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-warning" />
                  Unsaved changes — workspaces see them within a minute of saving.
                </p>
              ) : (
                <p className="text-muted">No changes yet.</p>
              )
            ) : (
              <p className="text-muted">Nothing is shown to any workspace until you publish.</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {mode === "edit" && dirty ? (
              <Button type="button" variant="ghost" size="sm" onClick={discard}>
                Discard changes
              </Button>
            ) : (
              <Link href="/announcements" className="inline-flex h-8 items-center rounded-base px-3 text-[13px] font-medium text-muted hover:bg-surface-sunken hover:text-text">
                Cancel
              </Link>
            )}
            <Button type="button" size="sm" onClick={requestSave} disabled={!dirty}>
              {saveLabel}
            </Button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title={mode === "edit" ? "Save announcement" : snapshot?.scheduled ? "Schedule announcement" : "Publish announcement"}
        confirmLabel={confirmLabel}
        tone={critical ? "danger" : "primary"}
        typed={needsTyped ? "publish" : undefined}
        pending={save.pending}
        error={save.error}
        confirmDisabled={reach.status === "loading"}
        wide
        onConfirm={confirmSave}
      >
        {snapshot && (
          <>
            <p>
              {mode === "edit"
                ? "Workspaces it reaches see the change on their next page."
                : snapshot.scheduled
                  ? `It goes up ${snapshot.startText} IST.`
                  : "It goes up as soon as you publish."}{" "}
              Other servers pick it up within a minute.
            </p>
            <ImpactList
              items={[
                { label: "Tone", value: ANNOUNCEMENT_TONE[snapshot.input.tone].label, tone: ANNOUNCEMENT_TONE[snapshot.input.tone].tone },
                { label: "Audience", value: audienceSummary(draft, targets) },
                {
                  label: "Reaches",
                  value: reach.status === "ready" ? plural(reach.count, "open workspace") : reach.status === "loading" ? "Counting…" : "Couldn't count",
                  tone: reach.status === "ready" && reach.count === 0 ? "warning" : undefined,
                },
                { label: "Shows from", value: shows },
                { label: "Until", value: until },
                { label: "Can be dismissed", value: snapshot.input.dismissible ? "Yes" : "No" },
              ]}
            />
            <AnnouncementBanner title={snapshot.input.title} body={snapshot.input.body} tone={snapshot.input.tone} />
            {reach.status === "ready" && reach.count === 0 && (
              <p className="text-xs text-warning">No open workspace is in this audience right now — it will show only in ones that join it while it runs.</p>
            )}
            {needsTyped && (
              <p className="text-xs text-muted">
                {draft.audience === "ALL" ? "This goes to every open workspace" : "Nobody can dismiss a critical announcement"}, so it needs{" "}
                <span className="font-mono text-text">publish</span> typed below.
              </p>
            )}
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}

/** "All workspaces", "IN, AE", "Plans: CRM Starter, Sales", "3 workspaces: acme, globex, initech". */
function audienceSummary(d: Draft, targets: AnnouncementTargets): string {
  const names = (list: string[], nameOf: (v: string) => string, max = 3) => {
    const shown = list.slice(0, max).map(nameOf).join(", ");
    return list.length > max ? `${shown} and ${list.length - max} more` : shown;
  };
  switch (d.audience) {
    case "ALL":
      return "All workspaces";
    case "COUNTRIES":
      return names(d.countries, (c) => c, 6);
    case "PLANS": {
      const byKey = new Map(targets.plans.map((p) => [p.key, p.name]));
      return `${d.plans.length === 1 ? "Plan" : "Plans"}: ${names(d.plans, (k) => byKey.get(k) ?? k)}`;
    }
    case "TENANTS": {
      const bySlug = new Map(targets.tenants.map((t) => [t.id, t.slug]));
      return `${plural(d.tenants.length, "workspace")}: ${names(d.tenants, (id) => bySlug.get(id) ?? "a closed workspace")}`;
    }
  }
}

// ─── Pieces ──────────────────────────────────────────────────────────────────────────────────────

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-xs text-danger">
      {message}
    </p>
  );
}

function Hint({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="text-xs text-muted">
      {children}
    </p>
  );
}

/** The chosen count and a way to clear it, above each picker. */
function PickerHead({ label, count, onClear }: { label: string; count: number; onClear: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-[13px] font-medium text-muted">{label}</p>
      <div className="flex items-center gap-2 text-xs text-muted tabular-nums">
        {count > 0 ? `${count} chosen` : "None chosen"}
        {count > 0 && (
          <button type="button" onClick={onClear} className="rounded-base font-medium text-brand hover:underline">
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function CountryPicker({
  available,
  chosen,
  error,
  onToggle,
  onClear,
}: {
  available: string[];
  chosen: string[];
  error?: string;
  onToggle: (code: string, on: boolean) => void;
  onClear: () => void;
}) {
  // A country chosen before that no open workspace is in any more stays listed, so it can be unticked.
  const codes = [...new Set([...available, ...chosen])].sort();
  return (
    <fieldset className="space-y-2" data-announcement-field="targets" tabIndex={-1}>
      <legend className="sr-only">Countries</legend>
      <PickerHead label="Countries" count={chosen.length} onClear={onClear} />
      {codes.length === 0 ? (
        <InsetBlock className="text-xs text-muted">No open workspace has a country yet.</InsetBlock>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {codes.map((code) => {
            const on = chosen.includes(code);
            return (
              <label
                key={code}
                className={cn(
                  "inline-flex h-8 cursor-pointer items-center gap-2 rounded-full border pr-3 pl-2.5 text-xs font-medium",
                  on ? "border-brand bg-brand-subtle text-brand" : "border-line bg-surface text-text hover:bg-surface-sunken",
                )}
              >
                <Checkbox checked={on} onChange={(e) => onToggle(code, e.target.checked)} className="h-3.5 w-3.5 shrink-0" />
                <span className="font-mono">{code}</span>
                {!available.includes(code) && <span className="font-normal text-muted">no open workspaces</span>}
              </label>
            );
          })}
        </div>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </fieldset>
  );
}

function PlanPicker({
  available,
  chosen,
  error,
  onToggle,
  onClear,
}: {
  available: { key: string; name: string }[];
  chosen: string[];
  error?: string;
  onToggle: (key: string, on: boolean) => void;
  onClear: () => void;
}) {
  const known = new Set(available.map((p) => p.key));
  const plans = [...available, ...chosen.filter((k) => !known.has(k)).map((k) => ({ key: k, name: k }))];
  return (
    <fieldset className="space-y-2" data-announcement-field="targets" tabIndex={-1}>
      <legend className="sr-only">Plans</legend>
      <PickerHead label="Plans" count={chosen.length} onClear={onClear} />
      {plans.length === 0 ? (
        <InsetBlock className="text-xs text-muted">There are no plans yet.</InsetBlock>
      ) : (
        <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {plans.map((p) => {
            const on = chosen.includes(p.key);
            return (
              <li key={p.key}>
                <label className={cn("flex cursor-pointer items-center gap-3 px-3 py-2", on ? "bg-brand-subtle" : "hover:bg-surface-sunken")}>
                  <Checkbox checked={on} onChange={(e) => onToggle(p.key, e.target.checked)} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-sm text-text">{p.name}</span>
                  <span className="shrink-0 font-mono text-xs text-muted">{p.key}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </fieldset>
  );
}

function WorkspacePicker({
  inputId,
  available,
  chosen,
  error,
  onAdd,
  onRemove,
  onClear,
}: {
  inputId: string;
  available: { id: string; slug: string; name: string }[];
  chosen: string[];
  error?: string;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const byId = useMemo(() => new Map(available.map((t) => [t.id, t])), [available]);
  const picked = new Set(chosen);
  const options: ComboOption[] = available.filter((t) => !picked.has(t.id)).map((t) => ({ id: t.id, name: t.name, hint: t.slug }));
  const full = chosen.length >= TARGETS_MAX;
  return (
    <div className="space-y-2">
      <PickerHead label="Workspaces" count={chosen.length} onClear={onClear} />
      <div className="space-y-1.5" data-announcement-field="targets" tabIndex={-1}>
        <Label htmlFor={inputId}>Add a workspace</Label>
        {/* Always empty: a choice becomes a chip below and the box clears for the next one. */}
        <OptionCombobox
          id={inputId}
          options={options}
          value=""
          onSelect={(option) => {
            if (option) onAdd(option.id);
          }}
          listLabel="Open workspaces"
          placeholder={full ? `${TARGETS_MAX} chosen — the most there can be` : "Search by name or address…"}
          emptyText="No open workspace matches that."
          disabled={full}
        />
        <p className="text-xs text-muted">
          {available.length >= 2000 ? "Only open workspaces are listed — the first 2,000 by name." : "Only open workspaces are listed."}
        </p>
      </div>
      {chosen.length > 0 && (
        <ul aria-label="Chosen workspaces" className="flex flex-wrap gap-1.5">
          {chosen.map((id) => {
            const t = byId.get(id);
            const label = t ? t.slug : "Workspace no longer open";
            return (
              <li key={id} className="inline-flex h-7 max-w-full items-center gap-0.5 rounded-full border border-line bg-surface-sunken pl-2.5 text-xs text-text" title={t?.name}>
                <span className={cn("truncate", t ? "font-mono" : "text-muted")}>{label}</span>
                <IconButton icon={X} label={`Remove ${label}`} onClick={() => onRemove(id)} className="h-6 w-6 rounded-full [&_svg]:h-3 [&_svg]:w-3" />
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

function ReachSummary({ reach, audience, hasTargets }: { reach: Reach; audience: AnnouncementAudienceKey; hasTargets: boolean }) {
  if (audience !== "ALL" && !hasTargets) {
    return <p className="text-sm text-muted">Choose who it is for to see how many workspaces it reaches.</p>;
  }
  if (reach.status === "error") {
    return (
      <p role="status" className="text-sm text-muted">
        {REACH_FAILED}
      </p>
    );
  }
  const loading = reach.status === "loading";
  const more = reach.count - reach.sample.length;
  return (
    <div className="space-y-3">
      <p role="status" className="flex items-baseline gap-2">
        <span className={cn("text-2xl font-semibold tracking-tight text-text tabular-nums", loading && "opacity-50")}>{reach.count.toLocaleString("en-IN")}</span>
        <span className="text-sm text-muted">{reach.count === 1 ? "open workspace" : "open workspaces"}</span>
        {loading && (
          <span className="inline-flex items-center gap-1 text-xs text-subtle">
            <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
            Counting…
          </span>
        )}
      </p>
      {reach.sample.length > 0 && (
        <div className={cn(loading && "opacity-50")}>
          <p className="mb-1.5 text-xs text-muted">Including</p>
          <ul className="flex flex-wrap gap-1.5">
            {reach.sample.map((slug) => (
              <li key={slug} className="inline-flex h-6 items-center rounded-full border border-line bg-surface-sunken px-2 font-mono text-xs text-text">
                {slug}
              </li>
            ))}
            {more > 0 && <li className="inline-flex h-6 items-center px-1 text-xs text-muted tabular-nums">{`and ${more.toLocaleString("en-IN")} more`}</li>}
          </ul>
        </div>
      )}
      {!loading && reach.count === 0 && <p className="text-xs text-warning">No open workspace is in this audience right now.</p>}
    </div>
  );
}
