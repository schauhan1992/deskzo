import { db } from "@/lib/db";

/**
 * When people are busy, between two instants: what their calendars show busy — synced from Outlook,
 * Google or Zoho, and Deskzo's own meetings, those they organise and those they're invited to (native.ts
 * keeps each invited address in lower case). Times only: never a title, never who with. Colleagues' busy
 * view and booking pages both ask here.
 */

export type BusySpan = { start: Date; end: Date };

export async function busyFor(people: { id: string; email: string | null }[], from: Date, to: Date): Promise<Map<string, BusySpan[]>> {
  const out = new Map<string, BusySpan[]>(people.map((p) => [p.id, []]));
  if (!people.length) return out;
  const byEmail = new Map(people.filter((p) => p.email?.trim()).map((p) => [p.email!.trim().toLowerCase(), p.id]));
  const rows = await db.calendarEvent.findMany({
    where: {
      busy: true,
      status: { not: "CANCELLED" },
      startsAt: { lt: to },
      endsAt: { gt: from },
      OR: [{ userId: { in: people.map((p) => p.id) } }, ...[...byEmail.keys()].map((email) => ({ provider: null, attendees: { array_contains: [{ email }] } }))],
    },
    orderBy: { startsAt: "asc" },
    take: 4000,
    select: { userId: true, provider: true, attendees: true, startsAt: true, endsAt: true },
  });
  for (const r of rows) {
    const whose = new Set<string>();
    if (out.has(r.userId)) whose.add(r.userId);
    if (!r.provider && Array.isArray(r.attendees)) {
      for (const a of r.attendees) {
        const id = byEmail.get(String((a as { email?: unknown })?.email ?? "").toLowerCase());
        if (id) whose.add(id);
      }
    }
    for (const id of whose) out.get(id)!.push({ start: r.startsAt, end: r.endsAt });
  }
  return out;
}
