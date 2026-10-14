"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { CalendarCheck, Clock, Video } from "lucide-react";
import { makeBooking } from "@/actions/booking-public";
import type { PublicBookingPage } from "@/lib/booking/server";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";

/**
 * The public side of a booking page (src/lib/booking): the days with free times, a day's times, then who
 * is booking. Times are shown in the workspace's zone, and said to be. A field no person sees, and how
 * long the page was open, are sent so a robot is thanked and dropped (src/actions/booking-public.ts).
 */
export function BookingWidget({ page }: { page: PublicBookingPage }) {
  const opened = useRef<number | null>(null);
  const [isPending, startTransition] = useTransition();
  const [day, setDay] = useState(page.days[0]?.day ?? "");
  const [slot, setSlot] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", email: "", phone: "", company: "", notes: "", website: "" });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ when: string; host: string; invited: boolean } | null>(null);
  const zone = page.zone;
  const dayLabel = (iso: string) => new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: zone }).format(new Date(iso));
  const timeLabel = (iso: string) => new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: zone }).format(new Date(iso));
  const slots = page.days.find((d) => d.day === day)?.slots ?? [];

  useEffect(() => {
    opened.current = Date.now();
  }, []);

  if (done) {
    return (
      <Card className="mx-auto max-w-lg">
        <CardContent className="space-y-2 py-10 text-center">
          <CalendarCheck className="mx-auto h-8 w-8 text-success" aria-hidden="true" />
          <h1 className="text-lg font-semibold text-text">You&apos;re booked</h1>
          {done.when ? (
            <p className="text-sm text-muted">
              {page.title} with {done.host}, {done.when}.{" "}
              {done.invited ? `An invitation is on its way to ${form.email}.` : `${done.host} will send you an invitation.`}
            </p>
          ) : (
            <p className="text-sm text-muted">Thank you.</p>
          )}
        </CardContent>
      </Card>
    );
  }

  function book() {
    if (!slot) return;
    setError(null);
    startTransition(async () => {
      const result = await makeBooking(page.slug, { start: slot, ...form, elapsedMs: opened.current === null ? undefined : Date.now() - opened.current });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone(result.data);
    });
  }

  return (
    <Card className="mx-auto max-w-2xl">
      <CardContent className="space-y-6 py-6">
        <header className="space-y-2">
          <p className="text-sm text-muted">{page.ourName}</p>
          <h1 className="text-xl font-semibold text-text">{page.title}</h1>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-4 w-4" aria-hidden="true" />
              {page.durationMinutes} minutes
            </span>
            {page.online && (
              <span className="inline-flex items-center gap-1.5">
                <Video className="h-4 w-4" aria-hidden="true" />
                Online meeting — the link comes with the invitation
              </span>
            )}
          </p>
          {page.description && <p className="whitespace-pre-line text-sm text-text">{page.description}</p>}
        </header>

        {page.days.length === 0 ? (
          <p className="rounded-md bg-surface-sunken px-3 py-4 text-sm text-muted">No times are free just now. Try again in a day or two.</p>
        ) : (
          <>
            <section aria-labelledby="booking-days" className="space-y-2">
              <h2 id="booking-days" className="text-sm font-medium text-text">
                Choose a day
              </h2>
              <div className="flex flex-wrap gap-2">
                {page.days.map((d) => (
                  <button
                    key={d.day}
                    type="button"
                    aria-pressed={d.day === day}
                    onClick={() => {
                      setDay(d.day);
                      setSlot(null);
                    }}
                    className={`rounded-md border px-3 py-1.5 text-sm ${d.day === day ? "border-brand bg-brand-subtle font-medium text-brand" : "border-line text-text hover:border-brand"}`}
                  >
                    {dayLabel(d.slots[0]!)}
                  </button>
                ))}
              </div>
            </section>
            <section aria-labelledby="booking-times" className="space-y-2">
              <h2 id="booking-times" className="text-sm font-medium text-text">
                Choose a time
              </h2>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {slots.map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={s === slot}
                    onClick={() => setSlot(s)}
                    className={`rounded-md border px-2 py-1.5 text-sm tabular-nums ${s === slot ? "border-brand bg-brand-subtle font-medium text-brand" : "border-line text-text hover:border-brand"}`}
                  >
                    {timeLabel(s)}
                  </button>
                ))}
              </div>
              <p className="text-xs text-subtle">Times are in {zone.replace(/_/g, " ")}.</p>
            </section>
          </>
        )}

        {slot && (
          <form
            className="space-y-3 border-t border-line pt-5"
            onSubmit={(e) => {
              e.preventDefault();
              book();
            }}
          >
            <p className="text-sm text-text">
              {dayLabel(slot)}, {timeLabel(slot)}
            </p>
            {error && (
              <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="booking-name" className="text-xs">
                  Your name *
                </Label>
                <Input id="booking-name" required maxLength={120} autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="booking-email" className="text-xs">
                  Email *
                </Label>
                <Input id="booking-email" type="email" required maxLength={254} autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="booking-company" className="text-xs">
                  Company
                </Label>
                <Input id="booking-company" maxLength={200} autoComplete="organization" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="booking-phone" className="text-xs">
                  Phone
                </Label>
                <Input id="booking-phone" type="tel" maxLength={40} autoComplete="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="booking-notes" className="text-xs">
                Anything we should know?
              </Label>
              <Textarea id="booking-notes" rows={3} maxLength={1000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            {/* Left empty by people, who never see it. */}
            <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
              <label htmlFor="booking-website">Website</label>
              <input id="booking-website" tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={isPending || !form.name.trim() || !form.email.trim()}>
                {isPending ? "Booking…" : "Book"}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
