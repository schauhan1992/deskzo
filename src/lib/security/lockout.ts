/**
 * Counting failed credential guesses, and refusing to keep answering.
 *
 * ## What this is for
 *
 * `checkCredentials` answers "is this password right?" without creating a session, so the login
 * form can decide whether to show the authenticator step. Useful, and until now it was also an
 * unlimited, unlogged password oracle: an attacker could put a credential-stuffing list through it
 * at whatever rate the server would take, get a truthful answer every time, and leave no trace —
 * the security screen showed a quiet night. Worse, a correct password was confirmed **even for an
 * account with an authenticator enrolled**, so two-factor protected the session and not the
 * credential, and the attacker learned exactly which harvested password was worth a phishing or
 * SIM-swap step.
 *
 * ## The trade-off, stated
 *
 * State is per process and does not survive a restart, the same trade-off `throttle` in this
 * directory already makes. Across several instances behind a load balancer an attacker gets one
 * budget per instance, and a deploy resets the counters. That is a real weakening and it is worth
 * saying out loud — but a shared store in the path of every sign-in is its own availability risk,
 * and the alternative on offer was no limit at all. If this ever runs multi-instance, move the
 * counter to Postgres or Redis rather than raising the limit.
 *
 * ## Why it counts two keys
 *
 * Per account, so one person's password cannot be ground down; and per caller, so a list of
 * thousands of accounts tried once each is also stopped. Either tripping is enough to refuse.
 */

type Bucket = { failures: number; first: number; lockedUntil: number };

const buckets = new Map<string, Bucket>();

/** Bounds a pathological spread of keys. A real attack is a handful; this is for the ten-thousandth. */
const MAX_TRACKED = 20_000;

export const MAX_FAILURES = 8;
export const WINDOW_MS = 10 * 60 * 1000;
export const LOCKOUT_MS = 15 * 60 * 1000;

function bucketFor(key: string, now: number): Bucket {
  const existing = buckets.get(key);
  if (existing && now - existing.first < WINDOW_MS) return existing;

  if (buckets.size >= MAX_TRACKED) {
    // Insertion-ordered, so this evicts the least recently created rather than sweeping.
    const oldest = buckets.keys().next().value;
    if (oldest !== undefined) buckets.delete(oldest);
  }
  const fresh: Bucket = { failures: 0, first: now, lockedUntil: 0 };
  buckets.set(key, fresh);
  return fresh;
}

export type LockoutState = { lockedOut: boolean; retryInSeconds: number; failures: number };

/** Whether any of these keys is currently locked out. Checked before the password is looked at. */
export function lockoutState(keys: string[], now: number = Date.now()): LockoutState {
  let worst: LockoutState = { lockedOut: false, retryInSeconds: 0, failures: 0 };
  for (const key of keys) {
    const bucket = buckets.get(key);
    if (!bucket) continue;
    if (bucket.lockedUntil > now) {
      const retryInSeconds = Math.ceil((bucket.lockedUntil - now) / 1000);
      if (retryInSeconds > worst.retryInSeconds) {
        worst = { lockedOut: true, retryInSeconds, failures: bucket.failures };
      }
    }
  }
  return worst;
}

/** Records a failure against every key, and locks them once the budget is spent. */
export function recordFailure(keys: string[], now: number = Date.now()): LockoutState {
  let locked = false;
  let retryInSeconds = 0;
  let failures = 0;

  for (const key of keys) {
    const bucket = bucketFor(key, now);
    bucket.failures += 1;
    failures = Math.max(failures, bucket.failures);
    if (bucket.failures >= MAX_FAILURES) {
      bucket.lockedUntil = now + LOCKOUT_MS;
      locked = true;
      retryInSeconds = Math.ceil(LOCKOUT_MS / 1000);
    }
  }

  return { lockedOut: locked, retryInSeconds, failures };
}

/**
 * Forgets the failures on a successful sign-in.
 *
 * Without this, somebody who mistypes their password seven times and then gets it right is still
 * one mistake away from a lockout for the rest of the window.
 */
export function clearFailures(keys: string[]) {
  for (const key of keys) buckets.delete(key);
}

/** Only for the check script — module state shared between tests is what makes them flaky. */
export function resetLockouts() {
  buckets.clear();
}
