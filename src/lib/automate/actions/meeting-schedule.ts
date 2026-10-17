import { z } from "zod";
import { db } from "@/lib/db";
import { scheduleMeeting } from "@/lib/calendar/meetings";
import { meetingRecordFor } from "@/lib/calendar/records";
import type { MeetingDraft } from "@/lib/calendar/types";
import { ActionError, defineAction } from "@/lib/automate/action-types";
import { priorOutput, withOutsideEffect } from "@/lib/automate/effects";
import { byWorkflow, notReached, recordIdField } from "@/lib/automate/actions/shared";

/**
 * Schedule a meeting from a lead, customer, contact or ticket (Deskzo Automate, Phase 2) — in the
 * workflow owner's own calendar, as its organiser, the way the Schedule meeting dialog does it
 * (src/lib/calendar/meetings.ts): Outlook, Google or Zoho sends the invitations and the replies come back
 * to them — or, with none connected, Deskzo's own calendar, which emails them (src/lib/calendar/native.ts).
 * The record's contact is invited unless the step says not to, and never a reseller's customer;
 * colleagues may be added by id. Linked to the record, so it shows on its page.
 *
 * When it starts: `startsAt` (from the trigger, say a booking's time), or `inDays` days from today at
 * `at` on the workspace's clock. A time already gone is refused.
 */

type Output = { eventId: string; startsAt: string; invited: number };

const MAX_ATTENDEES = 50;
const addressOf = (email: string) => email.trim().toLowerCase();

const input = z
  .object({
    record: z.enum(["lead", "company", "contact", "ticket"]).default("lead"),
    recordId: recordIdField("record"),
    /** The record's own name for it when not given. */
    title: z.string().trim().min(1).max(200).optional(),
    startsAt: z.iso.datetime({ offset: true }).optional(),
    inDays: z.number().int().min(0).max(365).default(1),
    at: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "A time is HH:MM, in 24 hours.")
      .default("10:00"),
    durationMinutes: z.number().int().min(5).max(24 * 60).default(30),
    online: z.boolean().default(true),
    location: z.string().trim().max(300).optional(),
    agenda: z.string().trim().max(4000).optional(),
    inviteContact: z.boolean().default(true),
    colleagueIds: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  })
  .strict();

export const meetingSchedule = defineAction({
  key: "meeting.schedule",
  label: "Schedule a meeting",
  description: "Books a meeting in the workflow owner's calendar, from a lead, customer, contact or ticket, and invites its contact.",
  module: "calendar",
  permission: "meetings.schedule",
  risk: "irreversible",
  input,
  preview: (i) => `Would schedule a ${i.durationMinutes}-minute meeting ${i.startsAt ? `at ${i.startsAt}` : i.inDays === 0 ? `today at ${i.at}` : `in ${i.inDays} day${i.inDays === 1 ? "" : "s"} at ${i.at}`}.`,
  async run(ctx, i): Promise<Output> {
    // Sent on an earlier try: that stands, whatever has changed since.
    const done = await priorOutput<Output>(ctx);
    if (done) return done.output;

    const record = await meetingRecordFor(ctx.actorId, { kind: i.record, id: i.recordId });
    if (!record) throw notReached(i.record);
    const owner = await db.user.findUnique({ where: { id: ctx.actorId }, select: { email: true } });

    let startsAt: Date;
    if (i.startsAt) {
      startsAt = new Date(i.startsAt);
    } else {
      const today = ctx.clock.parts(new Date());
      const [hour, minute] = i.at.split(":").map(Number);
      startsAt = ctx.clock.at(today.year, today.month, today.day + i.inDays, hour, minute);
    }
    const endsAt = new Date(startsAt.getTime() + i.durationMinutes * 60_000);
    if (endsAt.getTime() < Date.now()) throw new ActionError("That time has already gone, so no meeting was booked.", "PERMANENT");

    const attendees: MeetingDraft["attendees"] = [];
    if (i.inviteContact && !record.noDirectContact) {
      for (const id of record.preferredContactIds) {
        const contact = record.contacts.find((c) => c.id === id);
        if (contact) attendees.push({ email: contact.email, name: contact.name });
      }
    }
    if (i.colleagueIds.length) {
      const colleagues = await db.user.findMany({ where: { id: { in: i.colleagueIds }, active: true }, select: { name: true, email: true } });
      if (colleagues.length !== new Set(i.colleagueIds).size) throw new ActionError("One of the colleagues to invite isn't an active user.", "PERMANENT");
      for (const c of colleagues) if (c.email) attendees.push({ email: c.email, name: c.name });
    }
    const me = addressOf(owner?.email ?? "");
    const seen = new Set<string>();
    const invited = attendees.filter((a) => {
      const key = addressOf(a.email);
      if (key === me || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (invited.length > MAX_ATTENDEES) throw new ActionError(`Invite at most ${MAX_ATTENDEES} people.`, "PERMANENT");

    const draft: MeetingDraft = {
      title: i.title ?? record.defaults.title,
      description: i.agenda ?? record.defaults.agenda,
      location: i.location ?? record.defaults.location,
      startsAt,
      endsAt,
      online: i.online,
      attendees: invited,
    };
    const { output } = await withOutsideEffect<Output>(ctx, async () => {
      const made = await scheduleMeeting(ctx.actorId, draft, record.links, `${record.label} — ${byWorkflow(ctx)}`);
      if (!made.ok) return { ok: false, error: `The meeting wasn't booked: ${made.error}`, kind: made.reconnect || made.lasting ? "PERMANENT" : "TRANSIENT" };
      return { ok: true, output: { eventId: made.eventId, startsAt: startsAt.toISOString(), invited: invited.length }, recordType: "calendarEvent", recordId: made.eventId };
    });
    return output;
  },
});
