import type { CallDirection, CallOutcome, CallSource } from "@prisma/client";
import { isConnected } from "@/lib/calls";
import type { Clock } from "@/lib/time/zone";

/**
 * The calling team's report (owner, 18 Oct 2026) — what each person's phone did in a period, worked out
 * here from the rows src/actions/call-report.ts reads within the viewer's reach. Pure, so a suite can feed
 * it rows and check the sums.
 *
 *   · Calls, connected, connect rate, talk time and the average connected call — a call logged by hand on an
 *     iPhone, whose length isn't known, counts as a call but not towards the average (owner, 22 Oct 2026).
 *   · When the day's calling starts and stops: the first and last call of each day they called, in the
 *     workspace's time — the middle value across the period's days, so one early morning doesn't move it.
 *   · How much the Deskzo app logged, and how much of that is still waiting for a word.
 *   · Callbacks promised in the period, and those owed now and past their time.
 *   · Speed to lead: for leads they own that came in during the period, how long until the first call.
 */

export const REPORT_MAX_DAYS = 92;

export type ReportCall = {
  userId: string;
  direction: CallDirection;
  outcome: CallOutcome;
  durationSeconds: number;
  /** Logged by hand on an iPhone: its 0 seconds aren't a length. */
  lengthUnknown?: boolean;
  startedAt: Date;
  source: CallSource;
  reviewedAt: Date | null;
  followUpAt: Date | null;
};

export type ReportLead = { id: string; ownerUserId: string; createdAt: Date; firstCallAt: Date | null };

export type LeadSpeed = { new: number; called: number; withinHour: number; notCalled: number; medianMinutes: number | null };

export type CallReportRow = {
  userId: string;
  name: string;
  calls: number;
  outgoing: number;
  incoming: number;
  connected: number;
  connectRate: number;
  talkSeconds: number;
  averageSeconds: number;
  /** Minutes after midnight in the workspace's time — the middle value across the days they called. */
  firstCallMinute: number | null;
  lastCallMinute: number | null;
  daysCalling: number;
  fromApp: number;
  waitingForWord: number;
  callbacksPromised: number;
  callbacksOverdue: number;
  leads: LeadSpeed | null;
};

export type CallReport = {
  rows: CallReportRow[];
  totals: Omit<CallReportRow, "userId" | "name" | "firstCallMinute" | "lastCallMinute" | "daysCalling">;
  days: { day: string; calls: number; connected: number }[];
};

/** The average connected call, over the calls whose length is known. */
function averageOf(connected: ReportCall[]): number {
  const timed = connected.filter((c) => !c.lengthUnknown);
  return timed.length ? Math.round(timed.reduce((t, c) => t + c.durationSeconds, 0) / timed.length) : 0;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function leadSpeed(leads: ReportLead[]): LeadSpeed {
  const minutes = leads.filter((l) => l.firstCallAt).map((l) => Math.max(0, Math.round((l.firstCallAt!.getTime() - l.createdAt.getTime()) / 60_000)));
  return {
    new: leads.length,
    called: minutes.length,
    withinHour: minutes.filter((m) => m <= 60).length,
    notCalled: leads.length - minutes.length,
    medianMinutes: median(minutes),
  };
}

/**
 * The report from its rows. `people` are the rows to show, in no order (everyone with calls in the period
 * is added); `dayKeys` the period's days here, oldest first; `leads` null where leads aren't the viewer's.
 */
export function buildCallReport(input: {
  clock: Clock;
  people: { id: string; name: string }[];
  calls: ReportCall[];
  overdue: { userId: string; count: number }[];
  leads: ReportLead[] | null;
  dayKeys: string[];
}): CallReport {
  const { clock } = input;
  const names = new Map(input.people.map((p) => [p.id, p.name]));
  const byPerson = new Map<string, ReportCall[]>();
  for (const call of input.calls) byPerson.set(call.userId, [...(byPerson.get(call.userId) ?? []), call]);
  const overdue = new Map(input.overdue.map((o) => [o.userId, o.count]));
  const ids = new Set([...names.keys(), ...byPerson.keys(), ...overdue.keys(), ...(input.leads ?? []).map((l) => l.ownerUserId)]);

  const rows: CallReportRow[] = [...ids].map((userId) => {
    const calls = byPerson.get(userId) ?? [];
    const connected = calls.filter((c) => isConnected(c.outcome));
    const talk = calls.reduce((t, c) => t + c.durationSeconds, 0);

    // Each day's first and last call, in minutes after midnight here.
    const days = new Map<string, number[]>();
    for (const c of calls) {
      const p = clock.parts(c.startedAt);
      const key = clock.dateKey(c.startedAt);
      days.set(key, [...(days.get(key) ?? []), p.hour * 60 + p.minute]);
    }
    const firsts = [...days.values()].map((m) => Math.min(...m));
    const lasts = [...days.values()].map((m) => Math.max(...m));
    const app = calls.filter((c) => c.source === "PHONE");

    return {
      userId,
      name: names.get(userId) ?? "Someone",
      calls: calls.length,
      outgoing: calls.filter((c) => c.direction === "OUTBOUND").length,
      incoming: calls.filter((c) => c.direction === "INBOUND").length,
      connected: connected.length,
      connectRate: calls.length ? Math.round((connected.length / calls.length) * 100) : 0,
      talkSeconds: talk,
      averageSeconds: averageOf(connected),
      firstCallMinute: median(firsts),
      lastCallMinute: median(lasts),
      daysCalling: days.size,
      fromApp: app.length,
      waitingForWord: app.filter((c) => !c.reviewedAt).length,
      callbacksPromised: calls.filter((c) => c.followUpAt).length,
      callbacksOverdue: overdue.get(userId) ?? 0,
      leads: input.leads ? leadSpeed(input.leads.filter((l) => l.ownerUserId === userId)) : null,
    };
  });
  rows.sort((a, b) => b.calls - a.calls || b.talkSeconds - a.talkSeconds || a.name.localeCompare(b.name));

  const all = input.calls;
  const connectedAll = all.filter((c) => isConnected(c.outcome));
  const appAll = all.filter((c) => c.source === "PHONE");
  const totals: CallReport["totals"] = {
    calls: all.length,
    outgoing: all.filter((c) => c.direction === "OUTBOUND").length,
    incoming: all.filter((c) => c.direction === "INBOUND").length,
    connected: connectedAll.length,
    connectRate: all.length ? Math.round((connectedAll.length / all.length) * 100) : 0,
    talkSeconds: all.reduce((t, c) => t + c.durationSeconds, 0),
    averageSeconds: averageOf(connectedAll),
    fromApp: appAll.length,
    waitingForWord: appAll.filter((c) => !c.reviewedAt).length,
    callbacksPromised: all.filter((c) => c.followUpAt).length,
    callbacksOverdue: [...overdue.values()].reduce((t, n) => t + n, 0),
    leads: input.leads ? leadSpeed(input.leads) : null,
  };

  const perDay = new Map(input.dayKeys.map((d) => [d, { day: d, calls: 0, connected: 0 }]));
  for (const c of all) {
    const day = perDay.get(clock.dateKey(c.startedAt));
    if (!day) continue;
    day.calls += 1;
    if (isConnected(c.outcome)) day.connected += 1;
  }

  return { rows, totals, days: [...perDay.values()] };
}

/** "9:42 am" from minutes after midnight. */
export function minuteOfDay(minute: number | null): string {
  if (minute === null) return "—";
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/** "45 min", "3 h 10 min", "2 days" — how long a lead waited. */
export function waited(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  return `${Math.round(minutes / 1440)} days`;
}
