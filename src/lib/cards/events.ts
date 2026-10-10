/**
 * Deskzo Cards' events — the trade shows and conferences a team works — as plain rules, for the server
 * and the browser alike. Days are `yyyy-mm-dd` in the workspace's time zone; an event's dates are
 * @db.Date columns, compared by calendar day.
 */

/** How long after an event its team may still key in the cards they collected. */
export const CAPTURE_GRACE_DAYS = 7;

export type EventDays = { startsOn: string; endsOn: string };
export type EventState = "upcoming" | "live" | "ended";

/** A @db.Date as the day it holds. */
export function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `yyyy-mm-dd` plus some days. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function eventState(event: EventDays, today: string): EventState {
  if (today < event.startsOn) return "upcoming";
  if (today > event.endsOn) return "ended";
  return "live";
}

/** Whether the team may still add the people they met: while it runs, and for a week after. */
export function captureOpen(event: EventDays, today: string): boolean {
  return today >= event.startsOn && today <= addDays(event.endsOn, CAPTURE_GRACE_DAYS);
}

/** Every day an event runs, first to last. */
export function eventDays(event: EventDays): string[] {
  const out: string[] = [];
  for (let day = event.startsOn; day <= event.endsOn && out.length < 60; day = addDays(day, 1)) out.push(day);
  return out;
}

/** "12–14 Oct 2026", "30 Oct – 2 Nov 2026", "12 Oct 2026". */
export function eventDatesLabel(event: EventDays): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [sy, sm, sd] = event.startsOn.split("-").map(Number) as [number, number, number];
  const [ey, em, ed] = event.endsOn.split("-").map(Number) as [number, number, number];
  if (event.startsOn === event.endsOn) return `${sd} ${months[sm - 1]} ${sy}`;
  if (sy === ey && sm === em) return `${sd}–${ed} ${months[em - 1]} ${ey}`;
  if (sy === ey) return `${sd} ${months[sm - 1]} – ${ed} ${months[em - 1]} ${ey}`;
  return `${sd} ${months[sm - 1]} ${sy} – ${ed} ${months[em - 1]} ${ey}`;
}

// ── Reading a scanned QR ────────────────────────────────────────────────────────────────────────────

export type ScannedContact = { name: string; email: string; phone: string; company: string; jobTitle: string; link: string };

export type Scan =
  | { kind: "vcard"; contact: ScannedContact }
  | { kind: "card"; host: string; handle: string; url: string }
  | { kind: "url"; url: string }
  | { kind: "text"; text: string };

const BLANK: ScannedContact = { name: "", email: "", phone: "", company: "", jobTitle: "", link: "" };

/** RFC 6350 text, unescaped. */
function unescape(value: string): string {
  return value.replace(/\\([\\,;nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

/** A vCard (2.1, 3.0 or 4.0) read for what a contact needs; the first of each kind wins. */
export function parseVCard(text: string): ScannedContact | null {
  if (!/BEGIN:VCARD/i.test(text)) return null;
  // Folded lines carry on with a space or a tab.
  const lines = text.replace(/\r\n|\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const out = { ...BLANK };
  let family = "";
  let given = "";
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const head = line.slice(0, colon).toUpperCase();
    const value = line.slice(colon + 1).trim();
    const prop = head.split(";")[0]!.replace(/^ITEM\d+\./, "");
    if (prop === "FN" && !out.name) out.name = unescape(value);
    else if (prop === "N" && !family && !given) {
      const parts = value.split(";").map(unescape);
      family = parts[0] ?? "";
      given = parts[1] ?? "";
    } else if (prop === "EMAIL" && !out.email) out.email = unescape(value).toLowerCase();
    else if (prop === "TEL" && !out.phone) out.phone = unescape(value).replace(/^tel:/i, "");
    else if (prop === "ORG" && !out.company) out.company = unescape(value.split(";")[0] ?? "");
    else if (prop === "TITLE" && !out.jobTitle) out.jobTitle = unescape(value);
    else if (prop === "URL" && !out.link) out.link = unescape(value);
  }
  if (!out.name) out.name = [given, family].filter(Boolean).join(" ");
  for (const key of Object.keys(out) as (keyof ScannedContact)[]) out[key] = out[key].trim().slice(0, key === "link" ? 300 : 160);
  return out.name || out.email || out.phone ? out : null;
}

/** What a scanned QR holds: a contact, a Deskzo card's address, some other address, or plain text. */
export function readScan(raw: string): Scan {
  const text = raw.trim().slice(0, 4000);
  const contact = parseVCard(text);
  if (contact) return { kind: "vcard", contact };
  // A MECARD — what some phones and printed cards use instead.
  if (/^MECARD:/i.test(text)) {
    const field = (name: string) => new RegExp(`[:;]${name}:([^;]*)`, "i").exec(text)?.[1]?.trim() ?? "";
    const name = field("N").split(",").reverse().join(" ").trim();
    const mecard = { ...BLANK, name, email: field("EMAIL").toLowerCase(), phone: field("TEL"), company: field("ORG"), link: field("URL") };
    if (mecard.name || mecard.email || mecard.phone) return { kind: "vcard", contact: mecard };
  }
  try {
    const url = new URL(text);
    if (url.protocol === "https:" || url.protocol === "http:") {
      const match = /^\/c\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/.exec(url.pathname);
      if (match) return { kind: "card", host: url.host.toLowerCase(), handle: match[1]!, url: url.toString() };
      return { kind: "url", url: url.toString() };
    }
  } catch {
    // Not an address.
  }
  return { kind: "text", text };
}
