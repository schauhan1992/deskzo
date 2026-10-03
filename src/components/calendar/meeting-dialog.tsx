"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import {
  colleaguesBusy,
  listMyEvents,
  meetingColleagues,
  meetingFormFor,
  meetingToEdit,
  rescheduleMeetingAction,
  scheduleMeetingAction,
  type BusyPerson,
  type CalendarSummary,
  type Colleague,
  type MeetingForm,
  type MyEvent,
} from "@/actions/calendar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";
import { CalendarNotice } from "@/components/calendar/calendar-notice";
import { BusyStrip, type BusyRow } from "@/components/calendar/busy-strip";
import type { MeetingRecordRef } from "@/lib/calendar/kinds";

const SERVICE = { MICROSOFT: "Teams", GOOGLE: "Google Meet", ZOHO: "Zoho Meeting" } as const;
const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];
const HALF_HOUR = 30 * 60_000;

export type MeetingDialogMode = { kind: "new"; record: MeetingRecordRef | null } | { kind: "edit"; eventId: string };

type Loaded = {
  calendar: CalendarSummary;
  record: MeetingForm["record"];
  colleagues: Colleague[];
  edit: { hasLink: boolean; noDirectContact: boolean } | null;
};

const lengthLabel = (m: number) => (m < 60 ? `${m} minutes` : m % 60 === 0 ? `${m / 60} hour${m === 60 ? "" : "s"}` : `${Math.floor(m / 60)} h ${m % 60} min`);

/**
 * Scheduling a meeting — or changing one — in the person's own calendar. Who is invited: people at the
 * customer the record is about, colleagues, anybody by address; when, with the day's busy times laid out
 * for them and every colleague invited, so a slot can be picked without asking around.
 */
export function MeetingDialog({ mode, onClose }: { mode: MeetingDialogMode; onClose: () => void }) {
  const router = useRouter();
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  const [title, setTitle] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [duration, setDuration] = useState(30);
  const [online, setOnline] = useState(true);
  const [location, setLocation] = useState("");
  const [agenda, setAgenda] = useState("");
  const [contactIds, setContactIds] = useState<string[]>([]);
  const [colleagueIds, setColleagueIds] = useState<string[]>([]);
  const [emails, setEmails] = useState<string[]>([]);
  const [typing, setTyping] = useState("");

  useEffect(() => {
    let gone = false;
    const nextSlot = () => clock.input(new Date(Math.ceil((Date.now() + 1) / HALF_HOUR) * HALF_HOUR));
    (async () => {
      const colleagues = await meetingColleagues();
      if (mode.kind === "edit") {
        const [form, editing] = await Promise.all([meetingFormFor({ record: null }), meetingToEdit({ eventId: mode.eventId })]);
        if (gone) return;
        if (!form.ok || !editing.ok) {
          setError(!form.ok ? form.error : !editing.ok ? editing.error : null);
          return;
        }
        const e = editing.data;
        setTitle(e.title);
        setStartsAt(e.startsAt);
        setDuration(e.durationMinutes);
        setOnline(e.online);
        setLocation(e.location ?? "");
        setAgenda(e.agenda ?? "");
        // Colleagues invited stay colleagues; everybody else is an address.
        const byEmail = new Map(colleagues.map((c) => [c.email.toLowerCase(), c.id]));
        setColleagueIds(e.emails.map((x) => byEmail.get(x.toLowerCase())).filter((x): x is string => !!x));
        setEmails(e.emails.filter((x) => !byEmail.has(x.toLowerCase())));
        setLoaded({ calendar: form.data.calendar, record: null, colleagues, edit: { hasLink: e.hasLink, noDirectContact: e.noDirectContact } });
        return;
      }
      const form = await meetingFormFor({ record: mode.record });
      if (gone) return;
      if (!form.ok) {
        setError(form.error);
        return;
      }
      const d = form.data.record?.defaults;
      setTitle(d?.title ?? "");
      setStartsAt(d?.startsAt ?? nextSlot());
      setDuration(d?.durationMinutes ?? 30);
      setOnline(d?.online ?? true);
      setLocation(d?.location ?? "");
      setAgenda(d?.agenda ?? "");
      setContactIds(form.data.record?.preferredContactIds ?? []);
      setLoaded({ calendar: form.data.calendar, record: form.data.record, colleagues, edit: null });
    })().catch(() => !gone && setError("The meeting form couldn't be loaded. Try again."));
    return () => {
      gone = true;
    };
    // The dialog opens once for one meeting; the clock does not change under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = useMemo(() => (startsAt ? clock.parseInput(startsAt) : null), [clock, startsAt]);
  const proposal = start ? { startsAt: start, endsAt: new Date(start.getTime() + duration * 60_000) } : null;
  const dayKey = start ? clock.dateKey(start) : null;

  // The day's busy times: the person's own, and each colleague invited.
  const [mine, setMine] = useState<MyEvent[]>([]);
  const [theirs, setTheirs] = useState<BusyPerson[]>([]);
  const ready = loaded?.calendar.state === "ready";
  const colleagueKey = colleagueIds.join(",");
  useEffect(() => {
    if (!ready || !dayKey) return;
    let gone = false;
    const from = clock.startOfDay(dayKey);
    const to = clock.endOfDay(dayKey);
    Promise.all([
      listMyEvents({ from: dayKey, to: dayKey }),
      colleagueKey && from && to ? colleaguesBusy({ userIds: colleagueKey.split(","), from: from.toISOString(), to: to.toISOString() }) : Promise.resolve([]),
    ]).then(([own, busy]) => {
      if (gone) return;
      setMine(own);
      setTheirs(busy);
    });
    return () => {
      gone = true;
    };
  }, [ready, dayKey, colleagueKey, clock]);

  const calendar = loaded?.calendar;
  const provider = calendar && "provider" in calendar ? calendar.provider : null;
  const record = loaded?.record ?? null;
  const noDirectContact = record?.noDirectContact || loaded?.edit?.noDirectContact || false;
  const colleagues = loaded?.colleagues ?? [];
  const chosen = colleagues.filter((c) => colleagueIds.includes(c.id));
  const editingId = mode.kind === "edit" ? mode.eventId : null;

  const rows: BusyRow[] = [
    {
      key: "me",
      label: "You",
      blocks: mine.filter((e) => e.status !== "CANCELLED" && e.id !== editingId).map((e) => ({ startsAt: e.startsAt, endsAt: e.endsAt })),
    },
    ...chosen.map((c) => {
      const busy = theirs.find((t) => t.userId === c.id);
      return { key: c.id, label: c.name, blocks: busy?.busy ?? [], note: c.hasCalendar ? null : "Calendar not connected" };
    }),
  ];

  function addTyped() {
    const parts = typing.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return;
    setEmails((now) => [...now, ...parts.filter((p) => !now.some((x) => x.toLowerCase() === p.toLowerCase()))]);
    setTyping("");
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const fields = { title, startsAt, durationMinutes: duration, online, location, agenda };
      const done =
        mode.kind === "edit"
          ? await rescheduleMeetingAction({ ...fields, eventId: mode.eventId, emails: [...chosen.map((c) => c.email), ...emails] })
          : await scheduleMeetingAction({ ...fields, record: mode.record, contactIds, colleagueIds, emails });
      if (!done.ok) {
        setError(done.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  const heading = mode.kind === "edit" ? "Change meeting" : record ? `Schedule a meeting — ${record.label}` : "Schedule a meeting";

  return (
    <Dialog open onClose={onClose} title={heading} wide fullScreenOnPhone>
      {!loaded ? (
        error ? <p className="text-sm text-danger">{error}</p> : <p className="py-6 text-center text-sm text-muted">Opening your calendar…</p>
      ) : !ready ? (
        <CalendarNotice summary={loaded.calendar} compact />
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div>
            <Label htmlFor="meeting-title">Title</Label>
            <Input id="meeting-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
          </div>

          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div>
              <Label htmlFor="meeting-start">Starts</Label>
              <Input id="meeting-start" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required />
            </div>
            <div>
              <Label htmlFor="meeting-length">Length</Label>
              <Select id="meeting-length" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                {[...new Set([...DURATIONS, duration])].sort((a, b) => a - b).map((m) => (
                  <option key={m} value={m}>
                    {lengthLabel(m)}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {proposal && <p className="-mt-2 text-xs text-subtle">{clock.dateTime(proposal.startsAt)} to {clock.time(proposal.endsAt)}</p>}

          {provider && (
            <label className="flex items-center gap-2 text-sm text-text">
              <input type="checkbox" checked={online} disabled={!!loaded.edit?.hasLink} onChange={(e) => setOnline(e.target.checked)} />
              {loaded.edit?.hasLink ? `Has a ${SERVICE[provider]} link` : `Add a ${SERVICE[provider]} link`}
            </label>
          )}

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-text">Who&apos;s invited</legend>
            {noDirectContact && <p className="text-xs text-warning">This customer belongs to a reseller — only colleagues can be invited from here.</p>}
            {record && !noDirectContact && record.contacts.length > 0 && (
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {record.contacts.map((c) => (
                  <label key={c.id} className="flex items-center gap-1.5 text-sm text-text">
                    <input
                      type="checkbox"
                      checked={contactIds.includes(c.id)}
                      onChange={(e) => setContactIds((now) => (e.target.checked ? [...now, c.id] : now.filter((x) => x !== c.id)))}
                    />
                    {c.name} <span className="text-xs text-subtle">{c.email}</span>
                  </label>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              {chosen.map((c) => (
                <span key={c.id} className="inline-flex items-center gap-1 rounded-full bg-brand-subtle px-2 py-0.5 text-xs text-brand">
                  {c.name}
                  <button type="button" aria-label={`Don't invite ${c.name}`} onClick={() => setColleagueIds((now) => now.filter((x) => x !== c.id))}>
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {emails.map((x) => (
                <span key={x} className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-text">
                  {x}
                  <button type="button" aria-label={`Don't invite ${x}`} onClick={() => setEmails((now) => now.filter((y) => y !== x))}>
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Select
                aria-label="Invite a colleague"
                value=""
                onChange={(e) => {
                  const id = e.target.value;
                  if (id) setColleagueIds((now) => (now.includes(id) ? now : [...now, id]));
                }}
              >
                <option value="">Invite a colleague…</option>
                {colleagues
                  .filter((c) => !colleagueIds.includes(c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.hasCalendar ? "" : " (no calendar)"}
                    </option>
                  ))}
              </Select>
              {!noDirectContact && (
                <Input
                  aria-label="Invite somebody by email"
                  placeholder="Or an email address — Enter to add"
                  value={typing}
                  onChange={(e) => setTyping(e.target.value)}
                  onBlur={addTyped}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addTyped();
                    }
                  }}
                />
              )}
            </div>
          </fieldset>

          {dayKey && (
            <div>
              <p className="mb-1.5 text-sm font-medium text-text">Busy that day</p>
              <BusyStrip dayKey={dayKey} rows={rows} proposal={proposal} />
              <p className="mt-1 text-[11px] text-subtle">Colleagues&apos; calendars show only when they&apos;re busy — never what with.</p>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="meeting-location">Where</Label>
              <Input id="meeting-location" value={location} onChange={(e) => setLocation(e.target.value)} maxLength={300} placeholder={online ? "Online" : "Address or room"} />
            </div>
            <div>
              <Label htmlFor="meeting-agenda">Agenda</Label>
              <Textarea id="meeting-agenda" value={agenda} onChange={(e) => setAgenda(e.target.value)} rows={2} maxLength={4000} />
            </div>
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button type="submit" disabled={pending || !title.trim() || !start}>
              {pending ? "Saving…" : mode.kind === "edit" ? "Save and tell everyone" : "Schedule and invite"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
