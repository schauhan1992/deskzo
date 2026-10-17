import type { Clock } from "@/lib/time/zone";
import { toEmailHtml } from "@/lib/documents/email-template";

/**
 * The email an invitation to one of Deskzo's own meetings goes in — pure, so the send and
 * `check:native-calendar` share it. The meeting itself travels in the attached iCalendar file (ics.ts),
 * which the recipient's calendar reads; the words say the same for whoever reads the email, at the
 * workspace's clock with its zone named, since the person invited may be anywhere.
 */

export type InviteKind = "new" | "changed" | "cancelled";

export type InviteMeeting = {
  title: string;
  startsAt: Date;
  endsAt: Date;
  location: string | null;
  description: string | null;
  organizer: { name: string; email: string };
  companyName: string;
};

/** "Mon, 2 Nov 2026, 10:00 am – 10:30 am (Asia/Kolkata, UTC+05:30)" */
export function meetingWhen(m: Pick<InviteMeeting, "startsAt" | "endsAt">, clock: Clock): string {
  const sameDay = clock.dateKey(m.startsAt) === clock.dateKey(new Date(m.endsAt.getTime() - 1));
  const end = sameDay ? clock.time(m.endsAt) : clock.dateTime(m.endsAt);
  return `${clock.dateTime(m.startsAt)} – ${end} (${clock.zone.replace(/_/g, " ")}, ${clock.offsetLabel(m.startsAt)})`;
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();

export function inviteWords(kind: InviteKind, m: InviteMeeting, clock: Clock, note: string | null = null): { subject: string; text: string; html: string } {
  const when = meetingWhen(m, clock);
  const title = oneLine(m.title).slice(0, 150);
  const subject =
    kind === "new" ? `Invitation: ${title} — ${clock.dateTime(m.startsAt)}` : kind === "changed" ? `Changed: ${title} — ${clock.dateTime(m.startsAt)}` : `Cancelled: ${title} — ${clock.dateTime(m.startsAt)}`;
  const by = m.companyName && m.companyName.toLowerCase() !== m.organizer.name.toLowerCase() ? `${m.organizer.name} of ${m.companyName}` : m.organizer.name;
  const opening =
    kind === "new"
      ? `${by} has invited you to a meeting.`
      : kind === "changed"
        ? `${by} has changed this meeting. The details below are the ones that stand now.`
        : `${by} has cancelled this meeting.`;
  const parts = [
    opening,
    [title, when, m.location ? `Where: ${oneLine(m.location)}` : null].filter(Boolean).join("\n"),
    kind === "cancelled" && note ? note.trim() : null,
    kind !== "cancelled" && m.description ? m.description.trim() : null,
    kind === "cancelled"
      ? "The attached file takes it out of your calendar."
      : `The meeting is attached — open it to add it to your calendar, or to accept or decline. Your reply goes to ${m.organizer.email}.`,
  ].filter((p): p is string => !!p);
  const text = parts.join("\n\n");
  return { subject, text, html: toEmailHtml(text) };
}
