/**
 * How much support a customer takes, set against what they pay — so somebody can judge it.
 *
 * Pure — the database side is `data.ts` — so `check:support-load` can assert on it directly.
 *
 * ## What counts as support
 *
 *   · Tickets, except demos, which are selling rather than supporting.
 *   · Calls about a ticket, and calls the customer made to us that were not about a lead. Our own
 *     sales and renewal calls are not support, however long they ran.
 *   · Visits for a support escalation or a delivery/installation — not sales meetings.
 *
 * Nothing here estimates time that was not recorded. Tickets carry no time log, so "hours" is only
 * ever talk time and time on site, and is labelled as recorded time.
 *
 * ## The comparison
 *
 * Raw counts mislead: a customer who pays ₹50 lakh a year and raises twenty tickets is not the
 * problem one paying ₹50,000 and raising ten is. So the measure is tickets per ₹1 lakh billed over
 * the same months, against the typical (median) customer's — the one number that answers "are they
 * taking more support than their business is worth?" A customer with support and nothing billed is
 * called out as such, because no ratio can describe it.
 */

export const SUPPORT_VISIT_PURPOSES = ["SUPPORT_ESCALATION", "DELIVERY_INSTALLATION"] as const;
/** Two to one either way before a customer is called heavy or light — less than that is noise. */
export const HEAVY_MULTIPLE = 2;
export const LIGHT_MULTIPLE = 0.5;
/** Customers needed before "typical" means anything. */
export const MIN_PEERS = 5;

export type SupportLevel = "HEAVY" | "NORMAL" | "LIGHT" | "UNBILLED" | "NONE";
export const LEVEL_LABELS: Record<SupportLevel, string> = {
  HEAVY: "Heavy support",
  NORMAL: "Normal support",
  LIGHT: "Light support",
  UNBILLED: "Support, nothing billed",
  NONE: "No support used",
};
export const LEVEL_TONE: Record<SupportLevel, "red" | "default" | "green" | "amber"> = {
  HEAVY: "red",
  NORMAL: "default",
  LIGHT: "green",
  UNBILLED: "amber",
  NONE: "default",
};

export type TicketFact = {
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  type: string;
  status: "OPEN" | "IN_PROGRESS" | "ON_HOLD" | "RESOLVED" | "CLOSED";
  createdAt: Date;
  resolvedAt: Date | null;
  replies: number;
  /** The product it was about, when one was named. */
  product: string | null;
  handler: string | null;
};
export type CallFact = { startedAt: Date; durationSeconds: number };
export type VisitFact = { scheduledFor: Date; checkInAt: Date | null; checkOutAt: Date | null; distanceKm: number | null; expenses: number };

export type SupportFacts = { tickets: TicketFact[]; calls: CallFact[]; visits: VisitFact[]; billed: number };

const SLA_HOURS = { URGENT: 4, HIGH: 24, MEDIUM: 72, LOW: 168 } as const;
const HOUR = 3_600_000;
const IST = 5.5 * HOUR;

/** "2026-09" for the Indian month an instant falls in. */
export function monthKey(at: Date): string {
  const d = new Date(at.getTime() + IST);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The last `months` Indian months ending with the one `asOf` is in, oldest first. */
export function monthKeys(asOf: Date, months: number): string[] {
  const d = new Date(asOf.getTime() + IST);
  const keys: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    keys.push(`${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return keys;
}

/** A multiple as people say it — "3.2×", and "under 0.1×" rather than a rounded-down "0×". */
export function multipleText(m: number): string {
  return m < 0.1 ? "under 0.1×" : `${m}×`;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const top = (names: (string | null)[], n: number) => {
  const counts = new Map<string, number>();
  for (const name of names) if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([name, count]) => ({ name, count }));
};

export type SupportSummary = ReturnType<typeof summariseSupport>;

export function summariseSupport(facts: SupportFacts, opts: { asOf: Date; months: number }) {
  const { tickets, calls, visits } = facts;
  const open = tickets.filter((t) => t.status !== "RESOLVED" && t.status !== "CLOSED");
  const pastDue = (t: TicketFact) => (t.resolvedAt ?? opts.asOf).getTime() - t.createdAt.getTime() > SLA_HOURS[t.priority] * HOUR;
  const resolved = tickets.filter((t) => t.resolvedAt);
  const resolutionHours = median(resolved.map((t) => (t.resolvedAt!.getTime() - t.createdAt.getTime()) / HOUR));
  const talkMinutes = Math.round(calls.reduce((m, c) => m + c.durationSeconds, 0) / 60);
  const onSiteHours =
    Math.round(
      visits.reduce((h, v) => h + (v.checkInAt && v.checkOutAt ? Math.max(0, v.checkOutAt.getTime() - v.checkInAt.getTime()) / HOUR : 0), 0) * 10,
    ) / 10;
  const months = monthKeys(opts.asOf, opts.months);
  const perMonth = new Map(months.map((k) => [k, 0]));
  for (const t of tickets) {
    const k = monthKey(t.createdAt);
    if (perMonth.has(k)) perMonth.set(k, perMonth.get(k)! + 1);
  }
  const lakhs = facts.billed / 100_000;

  return {
    tickets: tickets.length,
    urgent: tickets.filter((t) => t.priority === "URGENT").length,
    high: tickets.filter((t) => t.priority === "HIGH").length,
    open: open.length,
    openPastDue: open.filter(pastDue).length,
    /** Resolved later than the priority's service deadline, or still open past it. */
    pastDeadline: tickets.filter(pastDue).length,
    medianResolutionHours: resolutionHours === null ? null : Math.round(resolutionHours * 10) / 10,
    replies: tickets.reduce((n, t) => n + t.replies, 0),
    calls: calls.length,
    talkMinutes,
    visits: visits.length,
    onSiteHours,
    distanceKm: Math.round(visits.reduce((k, v) => k + (v.distanceKm ?? 0), 0)),
    visitExpenses: Math.round(visits.reduce((e, v) => e + v.expenses, 0)),
    /** Talk time and time on site — what was actually recorded, not an estimate. */
    recordedHours: Math.round((talkMinutes / 60 + onSiteHours) * 10) / 10,
    billed: Math.round(facts.billed),
    ticketsPerLakh: lakhs > 0 ? Math.round((tickets.length / lakhs) * 100) / 100 : null,
    byMonth: months.map((k) => ({ month: k, tickets: perMonth.get(k)! })),
    topProducts: top(tickets.map((t) => t.product), 3),
    topHandlers: top(tickets.map((t) => t.handler), 3),
  };
}

/**
 * Where a customer's support sits against everybody else's.
 *
 * `peerRatios` is tickets per ₹1 lakh for every customer who was both billed and raised a ticket in
 * the same months; `peerTicketCounts` is the ticket count of every customer who raised one.
 */
export function compareToPeers(
  s: Pick<SupportSummary, "tickets" | "calls" | "visits" | "ticketsPerLakh" | "billed">,
  peers: { peerRatios: number[]; peerTicketCounts: number[] },
) {
  const typical = peers.peerRatios.length >= MIN_PEERS ? median(peers.peerRatios) : null;
  // Judged on the exact ratio; rounded only for showing — 0.54× must not round its way into "light".
  const exact = typical && s.ticketsPerLakh !== null ? s.ticketsPerLakh / typical : null;
  const multiple = exact === null ? null : Math.round(exact * 10) / 10;
  const usedAny = s.tickets + s.calls + s.visits > 0;
  const level: SupportLevel = !usedAny
    ? "NONE"
    : s.billed <= 0
      ? "UNBILLED"
      : exact === null
        ? "NORMAL"
        : exact >= HEAVY_MULTIPLE
          ? "HEAVY"
          : exact <= LIGHT_MULTIPLE
            ? "LIGHT"
            : "NORMAL";
  // Rank by tickets among customers who raised any: 1 is the most.
  const rank = s.tickets > 0 ? peers.peerTicketCounts.filter((n) => n > s.tickets).length + 1 : null;
  return { level, typicalTicketsPerLakh: typical, multiple, rank, rankedOf: peers.peerTicketCounts.length };
}
