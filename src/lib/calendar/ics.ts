/**
 * iCalendar (RFC 5545) for Deskzo's own calendar — pure, so the invitations, the subscribe feed and
 * `check:native-calendar` share it:
 *
 *   · an invitation (`inviteIcs`): METHOD:REQUEST when a meeting is made or changed, METHOD:CANCEL when it
 *     is called off — one UID for the meeting's whole life (`uidFor`), its SEQUENCE one higher each time,
 *     so a calendar that took the first one updates it rather than adding another;
 *   · a feed (`feedIcs`): METHOD:PUBLISH, nobody named — busy times, or titles when the person chose them.
 *
 * Times are UTC ("…Z"), so whoever receives one sees it in their own zone. Text is escaped and every line
 * folded at 75 octets without splitting a character; lines end in CRLF.
 */

export type IcsPerson = { email: string; name: string | null };

export type IcsEvent = {
  uid: string;
  sequence: number;
  /** When this version was made (DTSTAMP). */
  stamp: Date;
  start: Date;
  end: Date;
  title: string;
  description: string | null;
  location: string | null;
  status: "CONFIRMED" | "CANCELLED";
};

const PRODID = "-//Deskzo//Deskzo Calendar//EN";

/** The meeting's identity in every calendar it reaches: its row's id, which never changes. */
export function uidFor(eventId: string): string {
  return `${eventId}@deskzo.com`;
}

/** 20261102T043000Z */
export function icsTime(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** A TEXT value: backslash, semicolon, comma and line breaks escaped; other control characters dropped. */
export function icsText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** A parameter value (CN=…): quoted, with nothing that could end the quote or the line. */
function icsParam(value: string): string {
  return `"${value.replace(/["\r\n\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()}"`;
}

/** An address as a calendar user: only what an address may hold. */
function mailto(email: string): string {
  return `mailto:${email.trim().replace(/[^A-Za-z0-9.!#$%&'*+/=?^_`{|}~@-]/g, "")}`;
}

/** One content line folded at 75 octets — continuation lines start with a space — never inside a character. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = "";
  let octets = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, "utf8");
    // The first line may hold 75 octets; each continuation 74 after its leading space.
    const room = out.length === 0 ? 75 : 74;
    if (octets + size > room) {
      out.push(current);
      current = "";
      octets = 0;
    }
    current += ch;
    octets += size;
  }
  out.push(current);
  return out.join("\r\n ");
}

const lines = (rows: (string | null | false)[]) => `${rows.filter((r): r is string => !!r).map(foldLine).join("\r\n")}\r\n`;

function eventLines(e: IcsEvent, extra: string[]): string[] {
  return [
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
    `SEQUENCE:${Math.max(0, Math.floor(e.sequence))}`,
    `DTSTAMP:${icsTime(e.stamp)}`,
    `DTSTART:${icsTime(e.start)}`,
    `DTEND:${icsTime(e.end)}`,
    `SUMMARY:${icsText(e.title)}`,
    ...(e.description ? [`DESCRIPTION:${icsText(e.description)}`] : []),
    ...(e.location ? [`LOCATION:${icsText(e.location)}`] : []),
    `STATUS:${e.status}`,
    "TRANSP:OPAQUE",
    ...extra,
    "END:VEVENT",
  ];
}

/**
 * The invitation attached to the email: the organiser, and everybody it goes to, asked to reply (to the
 * organiser's own address — Deskzo doesn't read the replies). A cancellation carries the same UID, a
 * higher SEQUENCE and STATUS:CANCELLED.
 */
export function inviteIcs(method: "REQUEST" | "CANCEL", e: IcsEvent, organizer: IcsPerson, attendees: IcsPerson[]): string {
  const who = [
    `ORGANIZER${organizer.name ? `;CN=${icsParam(organizer.name)}` : ""}:${mailto(organizer.email)}`,
    ...attendees.map((a) => `ATTENDEE${a.name ? `;CN=${icsParam(a.name)}` : ""};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:${mailto(a.email)}`),
  ];
  const event = { ...e, status: method === "CANCEL" ? ("CANCELLED" as const) : e.status };
  return lines(["BEGIN:VCALENDAR", `PRODID:${PRODID}`, "VERSION:2.0", "CALSCALE:GREGORIAN", `METHOD:${method}`, ...eventLines(event, who), "END:VCALENDAR"]);
}

/**
 * A subscribed calendar: the events as they are now, nobody named. `busyOnly` shows each as "Busy" with
 * nothing else — not its title, its place or what it's about.
 */
export function feedIcs(name: string, events: IcsEvent[], busyOnly: boolean): string {
  const body = events.flatMap((e) =>
    busyOnly ? eventLines({ ...e, title: "Busy", description: null, location: null }, ["CLASS:PRIVATE"]) : eventLines(e, []),
  );
  return lines([
    "BEGIN:VCALENDAR",
    `PRODID:${PRODID}`,
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(name)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    ...body,
    "END:VCALENDAR",
  ]);
}
