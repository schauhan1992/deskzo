import type { PrizeRace } from "@prisma/client";
import type { Clock } from "@/lib/time/zone";
import { fortnightByKey, fortnightContaining } from "@/lib/performance/awards";

/**
 * Prizes — what is up for grabs, for which race, in which period. No database in here.
 *
 * Two races: the most active of each fortnight (src/lib/performance) and the top sellers of each
 * month (the wins leaderboard). Each has slots — first, second, third, and for the most active the
 * leader in sales and in support — and each slot can hold a prize.
 *
 * ## Standing and planned
 *
 * A standing prize (period "") is given every period. A planned one names a period and replaces the
 * standing prize for that period only, slot by slot — plan a bigger first prize for October and the
 * standing second and third still apply. What a winner gets is decided when the result is announced,
 * and copied onto their hall-of-fame line then, so editing a prize never rewrites what somebody won.
 */

export type Slot = "1" | "2" | "3" | "sales" | "support";

export const SLOTS: Record<PrizeRace, { slot: Slot; label: string; who: string }[]> = {
  MOST_ACTIVE: [
    { slot: "1", label: "Most active", who: "the most active" },
    { slot: "2", label: "Second", who: "second" },
    { slot: "3", label: "Third", who: "third" },
    { slot: "sales", label: "Most active in sales", who: "the most active in sales" },
    { slot: "support", label: "Most active in support", who: "the most active in support" },
  ],
  TOP_SELLERS: [
    { slot: "1", label: "Top seller", who: "the top seller" },
    { slot: "2", label: "Second", who: "second" },
    { slot: "3", label: "Third", who: "third" },
  ],
};

export const RACE_LABEL: Record<PrizeRace, string> = { MOST_ACTIVE: "Most active of the fortnight", TOP_SELLERS: "Top sellers of the month" };

export function isSlot(race: PrizeRace, slot: string): slot is Slot {
  return SLOTS[race].some((s) => s.slot === slot);
}

export function slotLabel(race: PrizeRace, slot: string): string {
  return SLOTS[race].find((s) => s.slot === slot)?.label ?? `Place ${slot}`;
}

// ─── Periods ─────────────────────────────────────────────────────────────────

/** Months and fortnights on the workspace's clock (passed in — `workspaceClock()`), half-open. */
export type PrizePeriod = { key: string; label: string; from: Date; to: Date };

const MONTH = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", month: "long", year: "numeric" });

function monthOf(year: number, month: number, clock: Clock): PrizePeriod {
  const norm = new Date(Date.UTC(year, month, 1));
  const y = norm.getUTCFullYear();
  const m = norm.getUTCMonth();
  return {
    key: `${y}-${String(m + 1).padStart(2, "0")}`,
    label: MONTH.format(new Date(Date.UTC(y, m, 15))),
    from: clock.midnight(y, m, 1),
    to: clock.midnight(y, m + 1, 1),
  };
}

export function monthContaining(at: Date, clock: Clock): PrizePeriod {
  const { year, month } = clock.parts(at);
  return monthOf(year, month, clock);
}

/** The month or fortnight a race is being run for at this moment. */
export function currentPeriod(race: PrizeRace, at: Date, clock: Clock): PrizePeriod {
  if (race === "TOP_SELLERS") return monthContaining(at, clock);
  const f = fortnightContaining(at, clock);
  return { key: f.key, label: f.label, from: f.from, to: f.to };
}

/** The period a key names, or null when the key is not one of this race's. "" is the standing list. */
export function periodByKey(race: PrizeRace, key: string, clock: Clock): PrizePeriod | null {
  if (race === "MOST_ACTIVE") {
    const f = fortnightByKey(key, clock);
    return f ? { key: f.key, label: f.label, from: f.from, to: f.to } : null;
  }
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key);
  return m ? monthOf(Number(m[1]), Number(m[2]) - 1, clock) : null;
}

/** This period and the next few, for planning ahead. */
export function upcomingPeriods(race: PrizeRace, at: Date, clock: Clock, count = 6): PrizePeriod[] {
  const out: PrizePeriod[] = [];
  let cursor = currentPeriod(race, at, clock);
  for (let i = 0; i < count; i++) {
    out.push(cursor);
    cursor = currentPeriod(race, cursor.to, clock);
  }
  return out;
}

/**
 * When a period's prizes are told to everybody on their own: from nine in the morning of its first
 * day, for four days — the same window the results use, so the morning a fortnight closes is also the
 * morning the next one's prizes are announced.
 */
export const PRIZES_FROM_HOUR = 9;
export const PRIZES_FOR_DAYS = 4;

export function prizeAnnouncementDue(race: PrizeRace, now: Date, clock: Clock): PrizePeriod | null {
  const p = currentPeriod(race, now, clock);
  // Nine on the workspace's clock, and midnight four days on — read off its calendar rather than
  // added as hours, which a clock change in between would move.
  const { year, month, day } = clock.parts(p.from);
  const opens = clock.at(year, month, day, PRIZES_FROM_HOUR).getTime();
  const closes = clock.midnight(year, month, day + PRIZES_FOR_DAYS).getTime();
  return now.getTime() >= opens && now.getTime() < closes ? p : null;
}

// ─── Which prize ─────────────────────────────────────────────────────────────

export type PrizeLike = { race: PrizeRace; period: string; slot: string; name: string; note: string | null; imageDataUrl: string | null };

/** Every slot's prize for a period: the one planned for it, or else the standing one. */
export function prizesFor<T extends PrizeLike>(race: PrizeRace, period: string, prizes: T[]): Map<Slot, T> {
  const out = new Map<Slot, T>();
  for (const { slot } of SLOTS[race]) {
    const planned = period ? prizes.find((p) => p.race === race && p.period === period && p.slot === slot) : undefined;
    const standing = prizes.find((p) => p.race === race && p.period === "" && p.slot === slot);
    const chosen = planned ?? standing;
    if (chosen) out.set(slot, chosen);
  }
  return out;
}

// ─── Words ───────────────────────────────────────────────────────────────────

/** "Up for grabs" — what everybody is told as a period opens, or when the button is pressed. */
export function upForGrabsCopy(race: PrizeRace, periodLabel: string, prizes: Map<Slot, { name: string }>): { title: string; message: string } {
  const lines = SLOTS[race].flatMap(({ slot, label, who }) => {
    const p = prizes.get(slot);
    if (!p) return [];
    return slot === "1" ? [`${who[0]!.toUpperCase()}${who.slice(1)} wins ${p.name}.`] : [`${label}: ${p.name}.`];
  });
  const headline = prizes.get("1")?.name ?? [...prizes.values()][0]?.name ?? "";
  return {
    title: `Up for grabs, ${periodLabel}: ${headline}`,
    message: `${RACE_LABEL[race]}. ${lines.join(" ")}`,
  };
}

/** The one line to a top seller who won — the most active have theirs in src/lib/performance. */
export function topSellerNote(input: { monthLabel: string; place: number; booked: string; prize: string | null }): { title: string; message: string } {
  const where = input.place === 1 ? "the top seller" : input.place === 2 ? "the second-best seller" : input.place === 3 ? "the third-best seller" : `number ${input.place} on the leaderboard`;
  return {
    title: input.place === 1 ? `You were the top seller, ${input.monthLabel}` : `Well done — ${input.monthLabel}`,
    message: `You were ${where} for ${input.monthLabel}, with ${input.booked} booked.${input.prize ? ` You win ${input.prize}.` : ""} Thank you.`,
  };
}

// ─── Pictures ────────────────────────────────────────────────────────────────

/** A shrunk photo is ~100 KB; this leaves room for a PNG with a transparent background. */
export const MAX_PRIZE_IMAGE_BYTES = 600 * 1024;

export function checkPrizeImage(dataUrl: string): { ok: true } | { ok: false; error: string } {
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) return { ok: false, error: "The picture has to be a JPEG, PNG or WebP image." };
  const bytes = Math.floor(((dataUrl.length - dataUrl.indexOf(",") - 1) * 3) / 4);
  if (bytes > MAX_PRIZE_IMAGE_BYTES) return { ok: false, error: `That picture is ${Math.round(bytes / 1024)} KB even after shrinking. Try a smaller one.` };
  return { ok: true };
}
