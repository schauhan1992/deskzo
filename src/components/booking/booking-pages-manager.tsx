"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { deleteBookingPage, saveBookingPage, type BookingRow, type ManagedBookingPage } from "@/actions/booking";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { BOOKING_LIMITS, DURATIONS, WEEKDAYS, WEEKDAY_NAMES, defaultHours, type WeekHours } from "@/lib/booking/rules";

type Draft = Omit<ManagedBookingPage, "upcoming" | "id"> & { id: string };

const slugFrom = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "meeting";

/**
 * Booking pages (src/actions/booking.ts): each page's address to share, how long a meeting is, who can be
 * booked and when; a dialog to make or change one; and what has been booked.
 */
export function BookingPagesManager({
  pages,
  hosts,
  pipelines,
  bookings,
  origin,
  zone,
}: {
  pages: ManagedBookingPage[];
  hosts: { id: string; name: string }[];
  pipelines: { id: string; name: string }[];
  bookings: (Omit<BookingRow, "startsAt"> & { startsAt: string; leadHref: string | null })[];
  origin: string;
  zone: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [slugTouched, setSlugTouched] = useState(false);
  const nameOf = (id: string) => hosts.find((h) => h.id === id)?.name ?? "someone without a calendar now";
  const when = (iso: string) => new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: zone }).format(new Date(iso));

  function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      after?.();
      router.refresh();
    });
  }

  const setDay = (day: (typeof WEEKDAYS)[number], open: boolean, from = "09:00", to = "17:00") =>
    draft && setDraft({ ...draft, hours: { ...draft.hours, [day]: open ? [[from, to]] : [] } as WeekHours });

  return (
    <div className="space-y-6">
      {error && !draft && (
        <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {hosts.length === 0 && (
        <p className="rounded-md bg-warning-bg px-3 py-2 text-sm text-warning">
          Nobody has a calendar connected yet. A host needs one — My profile → Calendar — so their free times can be offered and the meeting made in it.
        </p>
      )}
      <div className="flex justify-end">
        <Button
          type="button"
          disabled={isPending || hosts.length === 0}
          onClick={() => {
            setError(null);
            setSlugTouched(false);
            setDraft({
              id: "",
              slug: "",
              title: "",
              description: "",
              durationMinutes: 30,
              hostUserIds: hosts.slice(0, 1).map((h) => h.id),
              hours: defaultHours(),
              daysAhead: 14,
              minNoticeHours: 4,
              bufferMinutes: 0,
              online: true,
              pipelineId: pipelines[0]?.id ?? null,
              active: true,
            });
          }}
        >
          New booking page
        </Button>
      </div>

      {pages.length === 0 && <p className="text-sm text-muted">No booking pages yet.</p>}
      <div className="space-y-2">
        {pages.map((p) => (
          <Card key={p.id}>
            <CardContent className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm">
              <div className="min-w-0 space-y-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-text">{p.title}</span>
                  <Badge tone={p.active ? "green" : "default"}>{p.active ? "Taking bookings" : "Off"}</Badge>
                </p>
                <p className="break-all text-xs">
                  <a href={`${origin}/book/${p.slug}`} target="_blank" rel="noreferrer" className="text-brand underline">
                    {`${origin}/book/${p.slug}`}
                  </a>
                </p>
                <p className="text-xs text-subtle">
                  {p.durationMinutes} minutes with {p.hostUserIds.map(nameOf).join(", ")} · {p.upcoming} coming up
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isPending}
                  onClick={() => {
                    setError(null);
                    setSlugTouched(true);
                    setDraft({ ...p, description: p.description ?? "" });
                  }}
                >
                  Change
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={() => run(() => deleteBookingPage(p.id))}>
                  {p.upcoming > 0 ? "Switch off" : "Delete"}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <section className="space-y-2" aria-labelledby="bookings-heading">
        <h2 id="bookings-heading" className="text-sm font-semibold text-text">
          Bookings
        </h2>
        {bookings.length === 0 ? (
          <p className="text-sm text-muted">Nothing booked yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-subtle">
                <tr>
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">Who</th>
                  <th className="py-2 pr-3 font-medium">With</th>
                  <th className="py-2 pr-3 font-medium">Page</th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((b) => (
                  <tr key={b.id} className="border-t border-line">
                    <td className="py-2 pr-3 tabular-nums">{when(b.startsAt)}</td>
                    <td className="py-2 pr-3">
                      {b.leadHref ? (
                        <Link href={b.leadHref} className="text-brand underline">
                          {b.name}
                        </Link>
                      ) : (
                        b.name
                      )}
                      <span className="block text-xs text-subtle">{[b.companyName, b.email].filter(Boolean).join(" · ")}</span>
                    </td>
                    <td className="py-2 pr-3">{b.host}</td>
                    <td className="py-2 pr-3">
                      {b.page}
                      {b.status === "CANCELLED" && <span className="ml-1 text-xs text-danger">cancelled</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {draft && (
        <Dialog open onClose={() => setDraft(null)} title={draft.id ? `Change ${draft.title || "the page"}` : "New booking page"} wide>
          {error && (
            <p role="alert" className="mb-3 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="booking-title" className="text-xs">
                  Title
                </Label>
                <Input
                  id="booking-title"
                  placeholder="Product demo"
                  maxLength={BOOKING_LIMITS.title}
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value, ...(slugTouched ? {} : { slug: slugFrom(e.target.value) }) })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="booking-slug" className="text-xs">
                  Address
                </Label>
                <Input
                  id="booking-slug"
                  maxLength={41}
                  value={draft.slug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    setDraft({ ...draft, slug: e.target.value.toLowerCase() });
                  }}
                />
                <p className="break-all text-xs text-subtle">{`${origin}/book/${draft.slug || "…"}`}</p>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="booking-description" className="text-xs">
                What it is for
              </Label>
              <Textarea id="booking-description" rows={3} maxLength={BOOKING_LIMITS.description} value={draft.description ?? ""} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </div>
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="space-y-1">
                <Label htmlFor="booking-duration" className="text-xs">
                  Length
                </Label>
                <Select id="booking-duration" value={draft.durationMinutes} onChange={(e) => setDraft({ ...draft, durationMinutes: Number(e.target.value) })}>
                  {DURATIONS.map((d) => (
                    <option key={d} value={d}>
                      {d} minutes
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="booking-ahead" className="text-xs">
                  Days ahead
                </Label>
                <Input id="booking-ahead" type="number" min={1} max={90} value={draft.daysAhead} onChange={(e) => setDraft({ ...draft, daysAhead: Number(e.target.value) })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="booking-notice" className="text-xs">
                  Notice (hours)
                </Label>
                <Input id="booking-notice" type="number" min={0} max={336} value={draft.minNoticeHours} onChange={(e) => setDraft({ ...draft, minNoticeHours: Number(e.target.value) })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="booking-buffer" className="text-xs">
                  Gap between (minutes)
                </Label>
                <Input id="booking-buffer" type="number" min={0} max={120} value={draft.bufferMinutes} onChange={(e) => setDraft({ ...draft, bufferMinutes: Number(e.target.value) })} />
              </div>
            </div>
            <fieldset className="space-y-1">
              <legend className="text-xs font-medium text-text">Who customers can meet</legend>
              <div className="grid gap-1 sm:grid-cols-2">
                {hosts.map((h) => {
                  const on = draft.hostUserIds.includes(h.id);
                  return (
                    <label key={h.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!on && draft.hostUserIds.length >= BOOKING_LIMITS.hosts}
                        onChange={() => setDraft({ ...draft, hostUserIds: on ? draft.hostUserIds.filter((x) => x !== h.id) : [...draft.hostUserIds, h.id] })}
                      />
                      {h.name}
                    </label>
                  );
                })}
              </div>
              <p className="text-xs text-subtle">People with a calendar connected. A booking goes to whoever is free then, the least booked first.</p>
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="text-xs font-medium text-text">Hours ({zone.replace(/_/g, " ")})</legend>
              {WEEKDAYS.map((d) => {
                const range = draft.hours[d]?.[0];
                return (
                  <div key={d} className="flex flex-wrap items-center gap-2 text-sm">
                    <label className="flex w-32 items-center gap-2">
                      <input type="checkbox" checked={!!range} onChange={(e) => setDay(d, e.target.checked)} />
                      {WEEKDAY_NAMES[d]}
                    </label>
                    {range ? (
                      <>
                        <Input aria-label={`${WEEKDAY_NAMES[d]} from`} type="time" className="w-32" value={range[0]} onChange={(e) => setDay(d, true, e.target.value, range[1])} />
                        <span className="text-muted">to</span>
                        <Input aria-label={`${WEEKDAY_NAMES[d]} to`} type="time" className="w-32" value={range[1]} onChange={(e) => setDay(d, true, range[0], e.target.value)} />
                      </>
                    ) : (
                      <span className="text-xs text-subtle">Closed</span>
                    )}
                  </div>
                );
              })}
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              {/* No pipelines where the plan has no leads: a booking then adds only the company and contact. */}
              {pipelines.length > 0 && (
                <div className="space-y-1">
                  <Label htmlFor="booking-pipeline" className="text-xs">
                    Open a lead in
                  </Label>
                  <Select id="booking-pipeline" value={draft.pipelineId ?? ""} onChange={(e) => setDraft({ ...draft, pipelineId: e.target.value || null })}>
                    {pipelines.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
              <div className="space-y-2 pt-5">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={draft.online} onChange={(e) => setDraft({ ...draft, online: e.target.checked })} />
                  Add an online meeting link
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
                  Taking bookings
                </label>
              </div>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)} disabled={isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isPending || !draft.title.trim() || draft.hostUserIds.length === 0}
              onClick={() =>
                run(
                  () =>
                    saveBookingPage({
                      ...(draft.id ? { id: draft.id } : {}),
                      slug: draft.slug,
                      title: draft.title,
                      description: draft.description ?? "",
                      durationMinutes: draft.durationMinutes,
                      hostUserIds: draft.hostUserIds,
                      hours: draft.hours,
                      daysAhead: draft.daysAhead,
                      minNoticeHours: draft.minNoticeHours,
                      bufferMinutes: draft.bufferMinutes,
                      online: draft.online,
                      pipelineId: draft.pipelineId,
                      active: draft.active,
                    }),
                  () => setDraft(null),
                )
              }
            >
              {isPending ? "Saving…" : draft.id ? "Save" : "Make the page"}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
