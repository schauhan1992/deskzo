/**
 * "Write the first one, count the rest."
 *
 * Every security log has the same failure mode: the events worth recording are the ones an
 * adversary can produce at will, so the log is also a way to fill the disk and bury the one row
 * that mattered in a hundred thousand identical ones. Both writers here — blocked crawlers and
 * client-reported DLP events — are exactly that shape.
 *
 * So a key is written once per window and repeats within it are counted, to be folded into the
 * next row as "(412 more since the last entry)". That is cheaper *and* more readable than the
 * alternative.
 *
 * State is per process and does not survive a restart. A deploy loses a pending count, which costs
 * one slightly low number in one row — much cheaper than putting a shared store in the path of
 * every request this is meant to protect against.
 */

type Entry = { count: number; writtenAt: number };

const entries = new Map<string, Entry>();

/** Bounds a pathological spread of distinct keys; a normal crawl is one or two entries. */
const MAX_TRACKED = 5_000;

export type ThrottleOutcome = {
  /** True when this occurrence should be written. */
  write: boolean;
  /** How many were swallowed since the last write — 0 on the first of a window. */
  suppressedSince: number;
};

export function throttle(key: string, windowMs: number, now: number = Date.now()): ThrottleOutcome {
  const entry = entries.get(key);

  if (!entry || now - entry.writtenAt >= windowMs) {
    if (entries.size >= MAX_TRACKED) {
      // Insertion-ordered, so this drops the least recently added — eviction rather than a sweep,
      // so there is no timer to own and nothing to clean up on the way out.
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    const suppressed = entry ? entry.count : 0;
    entries.set(key, { count: 0, writtenAt: now });
    return { write: true, suppressedSince: suppressed };
  }

  entry.count += 1;
  return { write: false, suppressedSince: entry.count };
}

/** Only for the check script — module state shared between tests is state that makes them flaky. */
export function resetThrottle() {
  entries.clear();
}
