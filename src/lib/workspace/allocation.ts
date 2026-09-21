import type { CallerAllocationMethod } from "@prisma/client";

/**
 * Sharing a calling list out between callers.
 *
 * Pure on purpose: who gets which record is the thing people argue about, so it has to be readable
 * and checkable without a database. Every method returns the same records, only grouped differently
 * — nothing is ever dropped, which is the one property that actually matters.
 */
export type Allocatable = {
  id: string;
  /** Used by BY_ACCOUNT_OWNER; ignored by the rest. */
  ownerUserId?: string | null;
};

export type Allocation = { recordId: string; userId: string; sortOrder: number };

export const allocationMethodLabels: Record<CallerAllocationMethod, string> = {
  ROUND_ROBIN: "Round robin",
  BLOCKS: "Equal blocks",
  BY_ACCOUNT_OWNER: "To the account owner",
};

export const allocationMethodHints: Record<CallerAllocationMethod, string> = {
  ROUND_ROBIN: "One each in turn. The fairest split when the callers are interchangeable.",
  BLOCKS: "Contiguous blocks, so each caller works one stretch of the list end to end.",
  BY_ACCOUNT_OWNER:
    "Each record goes to whoever already owns that account. Anything unowned is shared round robin.",
};

/**
 * Splits `records` across `callerIds`.
 *
 * `sortOrder` is per caller and starts at zero, so everybody works a stable queue from the top
 * rather than seeing rows shuffle between sessions.
 */
export function allocate(
  records: Allocatable[],
  callerIds: string[],
  method: CallerAllocationMethod,
): Allocation[] {
  if (callerIds.length === 0 || records.length === 0) return [];

  const next: Record<string, number> = Object.fromEntries(callerIds.map((id) => [id, 0]));
  const take = (userId: string, recordId: string): Allocation => ({
    recordId,
    userId,
    sortOrder: next[userId]++,
  });

  if (method === "BLOCKS") {
    // The remainder is spread one-per-caller across the first few rather than dumped on the last,
    // so the biggest and smallest shares never differ by more than one.
    const base = Math.floor(records.length / callerIds.length);
    const extra = records.length % callerIds.length;
    const out: Allocation[] = [];
    let index = 0;
    callerIds.forEach((userId, position) => {
      const size = base + (position < extra ? 1 : 0);
      for (let i = 0; i < size; i++) out.push(take(userId, records[index++].id));
    });
    return out;
  }

  if (method === "BY_ACCOUNT_OWNER") {
    const eligible = new Set(callerIds);
    const out: Allocation[] = [];
    // Records without an owner — or owned by someone not on this activity — fall through to round
    // robin, which is the only honest thing to do with them.
    const leftovers: Allocatable[] = [];
    for (const record of records) {
      if (record.ownerUserId && eligible.has(record.ownerUserId)) out.push(take(record.ownerUserId, record.id));
      else leftovers.push(record);
    }
    leftovers.forEach((record, i) => out.push(take(callerIds[i % callerIds.length], record.id)));
    return out;
  }

  return records.map((record, i) => take(callerIds[i % callerIds.length], record.id));
}

/** How many each caller ends up with, for the confirmation before the work goes out. */
export function allocationPreview(total: number, callerCount: number, method: CallerAllocationMethod) {
  if (callerCount === 0 || total === 0) return [];
  const base = Math.floor(total / callerCount);
  const extra = total % callerCount;
  // Round robin and blocks produce the same counts, just a different order; by-owner can't be
  // predicted without the data, so the caller sees it as an estimate.
  return Array.from({ length: callerCount }, (_, i) => base + (i < extra ? 1 : 0)).map((count) => ({
    count,
    approximate: method === "BY_ACCOUNT_OWNER",
  }));
}

const HOUR = 3600;

/** Seconds as "1h 04m" or "4m 12s" — long enough to read at a glance, short enough for a table. */
export function formatSpan(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / HOUR);
  const m = Math.floor((seconds % HOUR) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/**
 * The gap between finishing one record and opening the next.
 *
 * Capped, because a caller who goes home at six and starts again at nine would otherwise register a
 * fifteen-hour "gap" that swamps every real figure. Anything past the cap is treated as a break
 * rather than idle time and reported separately.
 */
export const MAX_TRACKED_GAP_SECONDS = 30 * 60;

export function trackedGap(previousCompletedAt: Date | null, openedAt: Date) {
  if (!previousCompletedAt) return null;
  const seconds = Math.round((openedAt.getTime() - previousCompletedAt.getTime()) / 1000);
  if (seconds < 0) return null;
  return Math.min(seconds, MAX_TRACKED_GAP_SECONDS);
}
