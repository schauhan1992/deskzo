import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { workspaceClock } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";
import { WEEKDAYS, channelSettings, type ChannelSettings, type InboxKind } from "@/lib/inbox/settings";
import { visibleWhere, type InboxViewer } from "@/lib/inbox/server";

/**
 * The Customer inbox's response times (owner, 24 Oct 2026): how quickly customers hear from a person, and
 * how much the bot handles alone.
 *
 *   · First response: from when the customer first needed a person — the bot handed over, or the
 *     conversation began without one (`Conversation.needsPersonAt`) — to the first reply by a person.
 *     Time with the bot isn't counted against the team.
 *   · Office hours: where a channel has them, only the time the team was in counts — a message at 11 at
 *     night answered at 9:15 is a 15-minute response. The clock time is shown beside it.
 *   · Every reply, not just the first: from the first customer message the team hadn't answered yet to
 *     the next reply by a person.
 *   · Medians and the 90th percentile rather than averages: one conversation left over a weekend
 *     shouldn't hide that the rest were answered in minutes.
 *
 * Over the conversations the person may see (src/lib/inbox/server.ts `visibleWhere`); who answered what
 * is shown only to those who see every conversation.
 */

export const REPORT_DAYS = [7, 30, 90] as const;
export type ReportDays = (typeof REPORT_DAYS)[number];

/** The targets a first response is measured against. */
export const TARGETS = [
  { ms: 5 * 60_000, label: "5 minutes" },
  { ms: 60 * 60_000, label: "an hour" },
  { ms: 24 * 60 * 60_000, label: "a day" },
] as const;

/** The nearest-rank percentile (p of 100); null for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

export const median = (values: readonly number[]) => percentile(values, 50);

/** The share of values at or under `limit`, 0–1; null for none. */
export function shareWithin(values: readonly number[], limit: number): number | null {
  return values.length ? values.filter((v) => v <= limit).length / values.length : null;
}

const minutesOf = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return { h: h ?? 0, m: m ?? 0 };
};

/**
 * The part of `start`→`end` that fell inside the office hours, as the workspace's clock reads them — or
 * the whole of it while office hours are off. Days are walked one by one (a year at most).
 */
export function officeMs(start: Date, end: Date, hours: ChannelSettings["hours"], clock: Clock): number {
  const whole = end.getTime() - start.getTime();
  if (whole <= 0) return 0;
  if (!hours.on) return whole;
  const first = clock.parts(start);
  let total = 0;
  for (let i = 0; i < 400; i += 1) {
    const midnight = clock.midnight(first.year, first.month, first.day + i);
    if (midnight.getTime() >= end.getTime()) break;
    const day = clock.parts(midnight);
    const span = hours.days[WEEKDAYS[(day.weekday + 6) % 7]!];
    if (!span) continue;
    const from = minutesOf(span.from);
    const to = minutesOf(span.to);
    const open = clock.at(day.year, day.month, day.day, from.h, from.m).getTime();
    const close = clock.at(day.year, day.month, day.day, to.h, to.m).getTime();
    total += Math.max(0, Math.min(close, end.getTime()) - Math.max(open, start.getTime()));
  }
  return total;
}

export type ReplyEvent = { conversationId: string; author: "CUSTOMER" | "AGENT"; userId: string | null; at: Date };
export type ReplyWait = { conversationId: string; userId: string | null; from: Date; at: Date };

/**
 * Every reply by a person, and how long the customer had waited for it: from the first customer message
 * since the team last wrote. A reply nobody was waiting for (a second one in a row) isn't a wait.
 * `events` in time order within each conversation.
 */
export function replyWaits(events: readonly ReplyEvent[]): ReplyWait[] {
  const waiting = new Map<string, Date>();
  const out: ReplyWait[] = [];
  for (const e of events) {
    if (e.author === "CUSTOMER") {
      if (!waiting.has(e.conversationId)) waiting.set(e.conversationId, e.at);
      continue;
    }
    const from = waiting.get(e.conversationId);
    if (from) out.push({ conversationId: e.conversationId, userId: e.userId, from, at: e.at });
    waiting.delete(e.conversationId);
  }
  return out;
}

export type ResponseFigures = { count: number; median: number | null; p90: number | null; clockMedian: number | null; within: { label: string; share: number | null }[] };

function figures(office: number[], clock: number[]): ResponseFigures {
  return { count: office.length, median: median(office), p90: percentile(office, 90), clockMedian: median(clock), within: TARGETS.map((t) => ({ label: t.label, share: shareWithin(office, t.ms) })) };
}

export type InboxReport = {
  days: ReportDays;
  from: string;
  /** Whether office hours shaped any figure, so the page says so. */
  officeHours: boolean;
  totals: {
    started: number;
    neededPerson: number;
    botOnly: number;
    answered: number;
    leads: number;
    tickets: number;
    firstResponse: ResponseFigures;
    replies: ResponseFigures;
    waitingNow: number;
    oldestWaitMs: number | null;
  };
  byChannel: { id: string; name: string; kind: InboxKind; started: number; neededPerson: number; botOnly: number; firstMedian: number | null; withinHour: number | null }[];
  /** Who answered what — only for those who see every conversation. */
  byPerson: { id: string; name: string; firstResponses: number; firstMedian: number | null; replies: number; replyMedian: number | null }[] | null;
  byDay: { date: string; started: number; neededPerson: number; firstMedian: number | null }[];
};

/** The report for the last `days` days (today included), as this person may see it. */
export async function inboxReport(viewer: InboxViewer, input: { days: ReportDays; channelId?: string | null }, now = new Date()): Promise<InboxReport> {
  const clock = await workspaceClock();
  const today = clock.parts(now);
  const fromDate = clock.midnight(today.year, today.month, today.day - (input.days - 1));
  const channelFilter: Prisma.ConversationWhereInput = input.channelId ? { channelId: input.channelId } : {};
  const scope: Prisma.ConversationWhereInput = { AND: [visibleWhere(viewer), channelFilter] };

  const channels = await db.inboxChannel.findMany({ select: { id: true, name: true, kind: true, settings: true } });
  const hoursOf = new Map(channels.map((c) => [c.id, channelSettings(c.settings, c.kind as InboxKind).hours]));
  const officeHours = channels.some((c) => (!input.channelId || c.id === input.channelId) && hoursOf.get(c.id)?.on);

  const conversations = await db.conversation.findMany({
    where: { AND: [scope, { createdAt: { gte: fromDate, lte: now } }] },
    select: {
      id: true,
      channelId: true,
      createdAt: true,
      needsPersonAt: true,
      firstResponseAt: true,
      leadId: true,
      ticketId: true,
      messages: { where: { author: "AGENT" }, orderBy: { createdAt: "asc" }, take: 1, select: { userId: true } },
    },
    take: 20_000,
  });

  type Answer = { channelId: string; userId: string | null; office: number; clock: number; day: string };
  const answers: Answer[] = [];
  for (const c of conversations) {
    if (!c.firstResponseAt) continue;
    const start = c.needsPersonAt ?? c.createdAt;
    const hours = hoursOf.get(c.channelId);
    const clockMs = Math.max(0, c.firstResponseAt.getTime() - start.getTime());
    answers.push({ channelId: c.channelId, userId: c.messages[0]?.userId ?? null, office: hours ? officeMs(start, c.firstResponseAt, hours, clock) : clockMs, clock: clockMs, day: clock.dateKey(c.createdAt) });
  }

  // Every reply in the period: the conversations' messages from a little before it, so a wait that began
  // the day before still has its start.
  const events = await db.conversationMessage.findMany({
    where: { author: { in: ["CUSTOMER", "AGENT"] }, createdAt: { gte: new Date(fromDate.getTime() - 3 * 86_400_000), lte: now }, conversation: scope },
    orderBy: [{ conversationId: "asc" }, { createdAt: "asc" }],
    select: { conversationId: true, author: true, userId: true, createdAt: true, conversation: { select: { channelId: true } } },
    take: 100_000,
  });
  const channelOfConversation = new Map(events.map((e) => [e.conversationId, e.conversation.channelId]));
  const waits = replyWaits(events.map((e) => ({ conversationId: e.conversationId, author: e.author as "CUSTOMER" | "AGENT", userId: e.userId, at: e.createdAt }))).filter((w) => w.at >= fromDate);
  const waitOffice = (w: ReplyWait) => {
    const hours = hoursOf.get(channelOfConversation.get(w.conversationId) ?? "");
    return hours ? officeMs(w.from, w.at, hours, clock) : w.at.getTime() - w.from.getTime();
  };

  const waitingRows = await db.conversation.findMany({ where: { AND: [scope, { status: "OPEN", firstResponseAt: null, needsPersonAt: { not: null } }] }, select: { needsPersonAt: true }, take: 5_000 });
  const oldest = waitingRows.reduce<number | null>((min, r) => (r.needsPersonAt && (min === null || r.needsPersonAt.getTime() < min) ? r.needsPersonAt.getTime() : min), null);

  const needed = (c: (typeof conversations)[number]) => !!c.needsPersonAt || !!c.firstResponseAt;
  const byChannel = channels
    .filter((ch) => !input.channelId || ch.id === input.channelId)
    .map((ch) => {
      const mine = conversations.filter((c) => c.channelId === ch.id);
      const office = answers.filter((a) => a.channelId === ch.id).map((a) => a.office);
      return {
        id: ch.id,
        name: ch.name,
        kind: ch.kind as InboxKind,
        started: mine.length,
        neededPerson: mine.filter(needed).length,
        botOnly: mine.filter((c) => !needed(c)).length,
        firstMedian: median(office),
        withinHour: shareWithin(office, 60 * 60_000),
      };
    })
    .filter((row) => row.started > 0 || !!input.channelId);

  let byPerson: InboxReport["byPerson"] = null;
  if (viewer.viewAll) {
    const ids = [...new Set([...answers.map((a) => a.userId), ...waits.map((w) => w.userId)].filter((v): v is string => !!v))];
    const people = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    byPerson = people
      .map((p) => {
        const firsts = answers.filter((a) => a.userId === p.id).map((a) => a.office);
        const replies = waits.filter((w) => w.userId === p.id).map(waitOffice);
        return { id: p.id, name: p.name, firstResponses: firsts.length, firstMedian: median(firsts), replies: replies.length, replyMedian: median(replies) };
      })
      .sort((a, b) => b.replies - a.replies || a.name.localeCompare(b.name));
  }

  const byDay: InboxReport["byDay"] = [];
  for (let i = 0; i < input.days; i += 1) {
    const date = clock.dateKey(clock.midnight(today.year, today.month, today.day - (input.days - 1) + i));
    const started = conversations.filter((c) => clock.dateKey(c.createdAt) === date);
    byDay.push({ date, started: started.length, neededPerson: started.filter(needed).length, firstMedian: median(answers.filter((a) => a.day === date).map((a) => a.office)) });
  }

  return {
    days: input.days,
    from: clock.dateKey(fromDate),
    officeHours,
    totals: {
      started: conversations.length,
      neededPerson: conversations.filter(needed).length,
      botOnly: conversations.filter((c) => !needed(c)).length,
      answered: answers.length,
      leads: conversations.filter((c) => c.leadId).length,
      tickets: conversations.filter((c) => c.ticketId).length,
      firstResponse: figures(
        answers.map((a) => a.office),
        answers.map((a) => a.clock),
      ),
      replies: figures(
        waits.map(waitOffice),
        waits.map((w) => w.at.getTime() - w.from.getTime()),
      ),
      waitingNow: waitingRows.length,
      oldestWaitMs: oldest === null ? null : now.getTime() - oldest,
    },
    byChannel,
    byPerson,
    byDay,
  };
}

/** "45 s", "12 min", "3 h 5 min", "2 d 4 h" — a duration as people say it; "—" for none. */
export function durationText(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** "84%"; "—" for none. */
export const shareText = (share: number | null) => (share === null ? "—" : `${Math.round(share * 100)}%`);
