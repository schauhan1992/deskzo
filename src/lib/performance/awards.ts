import type { Clock } from "@/lib/time/zone";

/**
 * Most active of the fortnight — the arithmetic, with no database in it.
 *
 * ## What "active" means here
 *
 * Work done, not time logged in. Active time is a browser tab left visible (see
 * src/actions/activity-tracking.ts), which a person can run up by leaving the app open over lunch, so
 * it counts for a point an hour up to a small cap and no further — enough to separate two people who
 * did the same work, never enough to beat somebody who did more. Nobody wins on time alone: with no
 * work points you are not in the running.
 *
 * Each thing counted is something that leaves a trace a colleague could check:
 *
 *   · a record created — a lead, a contact, a quote, an order (every audited CREATE);
 *   · a record edited — once per record per day, so saving the same form ten times is one edit;
 *   · a call logged, a visit completed;
 *   · a ticket resolved, and more for one resolved inside its SLA;
 *   · a deal won, credited to whoever owns it.
 *
 * Calls and visits are not also counted as "records created" — the audit log records them too, and a
 * call is not worth more for being counted twice.
 *
 * ## The areas
 *
 * Beside the overall ranking, a leader for sales (calls, visits, deals) and one for support (tickets),
 * because a support engineer closing thirty tickets and a salesperson on the road all fortnight are
 * both the most active person in the building, and one list would only ever name one of them.
 */

export const POINTS = {
  recordCreated: 2,
  recordEdited: 1,
  call: 2,
  visit: 8,
  ticketResolved: 5,
  ticketInSla: 3,
  dealWon: 15,
  activeHour: 1,
} as const;

/** Most points active time can add in a fortnight. */
export const ACTIVE_HOURS_CAP = 10;

export type ActivityCounts = {
  created: number;
  edited: number;
  calls: number;
  visits: number;
  ticketsResolved: number;
  ticketsInSla: number;
  dealsWon: number;
  activeSeconds: number;
};

export const NO_ACTIVITY: ActivityCounts = {
  created: 0,
  edited: 0,
  calls: 0,
  visits: 0,
  ticketsResolved: 0,
  ticketsInSla: 0,
  dealsWon: 0,
  activeSeconds: 0,
};

export type Standing = {
  userId: string;
  name: string;
  /** Everything, time included — what the overall ranking is by. */
  points: number;
  /** Everything except time. Zero means not in the running. */
  work: number;
  time: number;
  sales: number;
  support: number;
  counts: ActivityCounts;
};

export function score(counts: ActivityCounts): Pick<Standing, "points" | "work" | "time" | "sales" | "support"> {
  const sales = counts.calls * POINTS.call + counts.visits * POINTS.visit + counts.dealsWon * POINTS.dealWon;
  const support = counts.ticketsResolved * POINTS.ticketResolved + counts.ticketsInSla * POINTS.ticketInSla;
  const records = counts.created * POINTS.recordCreated + counts.edited * POINTS.recordEdited;
  const work = sales + support + records;
  const time = Math.min(ACTIVE_HOURS_CAP, Math.floor(counts.activeSeconds / 3600)) * POINTS.activeHour;
  return { points: work + time, work, time, sales, support };
}

/**
 * Everybody with any work to their name, best first. Ties go to more work, then more time, then the
 * alphabet — never to whichever row the database returned first.
 */
export function rank(people: { userId: string; name: string; counts: ActivityCounts }[]): Standing[] {
  return people
    .map((p) => ({ userId: p.userId, name: p.name, counts: p.counts, ...score(p.counts) }))
    .filter((s) => s.work > 0)
    .sort(
      (a, b) =>
        b.points - a.points ||
        b.work - a.work ||
        b.counts.activeSeconds - a.counts.activeSeconds ||
        a.name.localeCompare(b.name) ||
        a.userId.localeCompare(b.userId),
    );
}

/** The leader of one area, or null when nobody did any of it. */
export function areaLeader(standings: Standing[], area: "sales" | "support"): Standing | null {
  const best = [...standings]
    .filter((s) => s[area] > 0)
    .sort((a, b) => b[area] - a[area] || b.points - a.points || a.name.localeCompare(b.name))[0];
  return best ?? null;
}

// ─── Fortnights ──────────────────────────────────────────────────────────────

export type Fortnight = {
  /** "2026-09-A" — the 1st to the 15th; "2026-09-B" — the 16th to the month's end. */
  key: string;
  label: string;
  /**
   * Midnight the fortnight begins, and midnight the next one begins, on the workspace's clock (passed
   * in — `workspaceClock()`). Half-open.
   */
  from: Date;
  to: Date;
  /** The same days as calendar dates, for date-only columns. Both inclusive. */
  firstDay: Date;
  lastDay: Date;
};

const MONTH = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", month: "long", year: "numeric" });
const SHORT_MONTH = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", month: "short" });

function fortnightOf(year: number, month: number, second: boolean, clock: Clock): Fortnight {
  // Normalise a month that ran off either end of the year.
  const norm = new Date(Date.UTC(year, month, 1));
  const y = norm.getUTCFullYear();
  const m = norm.getUTCMonth();
  const lastOfMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const startDay = second ? 16 : 1;
  const endDay = second ? lastOfMonth : 15;
  return {
    key: `${y}-${String(m + 1).padStart(2, "0")}-${second ? "B" : "A"}`,
    label: `${startDay}–${endDay} ${MONTH.format(new Date(Date.UTC(y, m, 15)))}`,
    from: clock.midnight(y, m, startDay),
    to: clock.midnight(y, m, endDay + 1),
    firstDay: new Date(Date.UTC(y, m, startDay)),
    lastDay: new Date(Date.UTC(y, m, endDay)),
  };
}

/** "2026-10-A" back into its fortnight, or null when it is not one. */
export function fortnightByKey(key: string, clock: Clock): Fortnight | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])-([AB])$/.exec(key);
  return m ? fortnightOf(Number(m[1]), Number(m[2]) - 1, m[3] === "B", clock) : null;
}

export function fortnightContaining(at: Date, clock: Clock): Fortnight {
  const { year, month, day } = clock.parts(at);
  return fortnightOf(year, month, day > 15, clock);
}

export function previousFortnight(at: Date, clock: Clock): Fortnight {
  const { year, month, day } = clock.parts(at);
  // In the second half, the first half of this month; in the first half, the second half of last.
  return day > 15 ? fortnightOf(year, month, false, clock) : fortnightOf(year, month - 1, true, clock);
}

/** "1–15 Sep" — for a notification title, where the year is noise. */
export function shortLabel(f: Pick<Fortnight, "firstDay" | "lastDay">): string {
  return `${f.firstDay.getUTCDate()}–${f.lastDay.getUTCDate()} ${SHORT_MONTH.format(f.lastDay)}`;
}

/**
 * When a closed fortnight is announced: from nine in the morning of the day after it closes, for four
 * days. Not at midnight — nobody should wake to a leaderboard — and not a week late either: switch the
 * awards on in the middle of a fortnight and the one that closed ten days ago stays unannounced
 * rather than turning up out of nowhere.
 */
export const ANNOUNCE_FROM_HOUR = 9;
export const ANNOUNCE_FOR_DAYS = 4;

export function announcementDue(now: Date, clock: Clock): Fortnight | null {
  const current = fortnightContaining(now, clock);
  // Nine on the workspace's clock, and midnight four days on — read off its calendar rather than
  // added as hours, which a clock change in between would move.
  const [y, m, d] = [current.firstDay.getUTCFullYear(), current.firstDay.getUTCMonth(), current.firstDay.getUTCDate()];
  const opens = clock.at(y, m, d, ANNOUNCE_FROM_HOUR).getTime();
  const closes = clock.midnight(y, m, d + ANNOUNCE_FOR_DAYS).getTime();
  if (now.getTime() < opens || now.getTime() >= closes) return null;
  return previousFortnight(now, clock);
}

// ─── Words ───────────────────────────────────────────────────────────────────

export type AwardEntry = { userId: string; name: string; points: number; sales: number; support: number };

export function entryOf(s: Standing): AwardEntry {
  return { userId: s.userId, name: s.name, points: s.points, sales: s.sales, support: s.support };
}

const ORDINAL = ["", "most active", "second most active", "third most active"];

function place(n: number): string {
  return ORDINAL[n] ?? `number ${n} for activity`;
}

/**
 * The prize each place carries, by slot: "1", "2", "3", "sales", "support". See src/lib/wins/prizes.ts.
 */
export type PrizeNames = Partial<Record<string, string>>;

/** What everybody is told — or, with the managers-only audience, what the managers are. */
export function announcementCopy(input: {
  label: string;
  winners: AwardEntry[];
  sales: AwardEntry | null;
  support: AwardEntry | null;
  prizes?: PrizeNames;
}): { title: string; message: string } {
  const prize = (slot: string) => input.prizes?.[slot];
  const [first, ...rest] = input.winners;
  const parts: string[] = [];
  if (first) parts.push(`${first.name} — ${first.points} points${prize("1") ? `, wins ${prize("1")}` : ""}.`);
  if (rest.length) parts.push(`Then ${rest.map((r, i) => `${r.name} (${r.points}${prize(String(i + 2)) ? `, ${prize(String(i + 2))}` : ""})`).join(", ")}.`);
  const areas = [
    input.sales ? `Sales: ${input.sales.name}${prize("sales") ? ` (${prize("sales")})` : ""}` : null,
    input.support ? `Support: ${input.support.name}${prize("support") ? ` (${prize("support")})` : ""}` : null,
  ].filter(Boolean);
  if (areas.length) parts.push(`${areas.join(". ")}.`);
  return {
    title: `Most active, ${input.label}: ${first?.name ?? "nobody yet"}`,
    message: parts.join(" "),
  };
}

/** The personal note to one winner — every place they earned, in one message. */
export function winnerCopy(input: {
  label: string;
  entry: AwardEntry;
  place: number | null;
  ledSales: boolean;
  ledSupport: boolean;
  /** What they win, one per place they earned that carries a prize. */
  prizes?: string[];
}): { title: string; message: string } {
  const what: string[] = [];
  if (input.place) what.push(`the ${place(input.place)} person`);
  if (input.ledSales) what.push("the most active in sales");
  if (input.ledSupport) what.push("the most active in support");
  const said = andList(what) || "among the most active";
  const won = input.prizes?.length ? ` You win ${andList(input.prizes)}.` : "";
  return {
    title: input.place === 1 ? `You were the most active, ${input.label}` : `Well done — ${input.label}`,
    message: `You were ${said} for ${input.label}, with ${input.entry.points} points.${won} Thank you.`,
  };
}

function andList(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : (items[0] ?? "");
}
