/**
 * When a message is actually allowed to go out.
 *
 * Pure, and worth checking, because every rule here fails politely rather than loudly: a campaign
 * that lands at 2am, on a Sunday, or on Diwali still *sends* — it just makes the company look like
 * it does not know what day it is. The one that costs money is the frequency cap, which is the only
 * thing standing between four separate campaigns and one customer hearing from us four times in a
 * morning.
 *
 * All arithmetic is done in explicit minutes-from-midnight at a fixed UTC offset rather than via
 * the server's local time. A container running UTC and an office running IST would otherwise
 * disagree about when 9am is, and only one of them would be right.
 */

/** India. The default rather than a constant, so this stays usable elsewhere. */
export const IST_OFFSET_MINUTES = 330;

export const DEFAULT_WEEK_OFFS = [0, 6]; // Sunday, Saturday

export type Window = { startMinute: number; endMinute: number };

export type ScheduleRules = {
  /** Nothing marketing goes out between these. Wraps midnight when start > end. */
  quiet: Window;
  /** An optional narrower window for one campaign — "only between 10 and 12". */
  window?: Window | null;
  skipNonWorkingDays: boolean;
  /** `yyyy-mm-dd` keys, from `closedDates()` in src/lib/hr/calendar.ts. */
  holidays?: Set<string>;
  weekOffs?: number[];
  offsetMinutes?: number;
};

const DAY = 86400000;

function localParts(at: Date, offsetMinutes: number) {
  const shifted = new Date(at.getTime() + offsetMinutes * 60000);
  return {
    dayKey: shifted.toISOString().slice(0, 10),
    weekday: shifted.getUTCDay(),
    minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    /** Midnight of that local day, as a real instant. */
    dayStart: new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - offsetMinutes * 60000),
  };
}

/**
 * The stretches of a day a message may go out in, worst case the whole day.
 *
 * Quiet hours that wrap midnight (20:00 to 09:00, the normal case) leave one allowed block in the
 * middle. Quiet hours that don't wrap leave two, one either side. Both are real configurations and
 * the second is easy to forget.
 */
export function allowedBlocks(rules: Pick<ScheduleRules, "quiet" | "window">): [number, number][] {
  const { startMinute: qs, endMinute: qe } = rules.quiet;
  let blocks: [number, number][];
  if (qs === qe) blocks = [[0, 1440]];
  else if (qs < qe) blocks = ([[0, qs], [qe, 1440]] as [number, number][]).filter(([a, b]) => b > a);
  else blocks = [[qe, qs]];

  const w = rules.window;
  if (!w || w.startMinute >= w.endMinute) return blocks;
  return blocks
    .map(([a, b]) => [Math.max(a, w.startMinute), Math.min(b, w.endMinute)] as [number, number])
    .filter(([a, b]) => b > a);
}

function isWorkingDay(dayKey: string, weekday: number, rules: ScheduleRules): boolean {
  if (!rules.skipNonWorkingDays) return true;
  const offs = rules.weekOffs ?? DEFAULT_WEEK_OFFS;
  if (offs.includes(weekday)) return false;
  return !rules.holidays?.has(dayKey);
}

/**
 * The first moment at or after `from` that satisfies every rule.
 *
 * Walks forward a day at a time and gives up after a fortnight rather than looping — a
 * configuration with no allowed window at all (quiet hours covering the clock, say) would otherwise
 * spin, and returning `from` unchanged makes that visible as an early send rather than a hang.
 */
export function nextSendTime(from: Date, rules: ScheduleRules): Date {
  const offset = rules.offsetMinutes ?? IST_OFFSET_MINUTES;
  const blocks = allowedBlocks(rules);
  if (blocks.length === 0) return from;

  for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
    const probe = new Date(from.getTime() + dayOffset * DAY);
    const { dayKey, weekday, dayStart } = localParts(probe, offset);
    if (!isWorkingDay(dayKey, weekday, rules)) continue;

    // Only the first day is constrained by the time we're starting from; later days start fresh.
    const floor = dayOffset === 0 ? localParts(from, offset).minute : 0;
    for (const [start, end] of blocks) {
      if (end <= floor) continue;
      return new Date(dayStart.getTime() + Math.max(start, floor) * 60000);
    }
  }
  return from;
}

/** Whether this instant is already inside an allowed stretch — the tick's own check. */
export function isSendableNow(at: Date, rules: ScheduleRules): boolean {
  const offset = rules.offsetMinutes ?? IST_OFFSET_MINUTES;
  const { dayKey, weekday, minute } = localParts(at, offset);
  if (!isWorkingDay(dayKey, weekday, rules)) return false;
  return allowedBlocks(rules).some(([a, b]) => minute >= a && minute < b);
}

/**
 * Whether one more message would breach the cap.
 *
 * Deliberately counts *sends*, not campaigns. Four campaigns each convinced they are the only one
 * running is exactly how a customer gets four emails in a morning, and each campaign on its own
 * looks perfectly reasonable.
 */
export function withinFrequencyCap(sentInLastWeek: number, maxPerWeek: number): boolean {
  if (maxPerWeek <= 0) return true; // 0 disables the cap rather than blocking everything.
  return sentInLastWeek < maxPerWeek;
}

/** For the settings screen: "9:00 am". */
export function formatMinute(minute: number): string {
  const m = ((Math.round(minute) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  const suffix = h < 12 ? "am" : "pm";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:${mm} ${suffix}`;
}
