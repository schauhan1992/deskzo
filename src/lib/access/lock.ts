import { tenantKey } from "@/lib/tenancy/cache";
import { db } from "@/lib/db";

/**
 * Administrator locks: somebody can still sign in, and sees nothing but a notice until the lock is
 * lifted. Either one person (anybody with `users.lock` can do it) or the whole company (only the
 * super admin can).
 *
 * The lock is a hold reason in the access gate (src/lib/access/gate.ts, `LOCKED`), not a screen laid
 * over the app. The gate already stands in front of every signed-in page, every server action (through
 * `requireUser`) and every API route that asks who is calling, and sends anybody it holds to /access.
 * A notice drawn over a working page can be removed with the browser's developer tools; a request the
 * server refuses cannot.
 *
 * The super admin is never locked — the gate exempts them from every hold — so whoever can lift a
 * company-wide lock is always able to. A lock with an end date lifts itself when it passes.
 */

import { DEFAULT_LOCK_MESSAGE } from "@/lib/access/lock-rules";
export { COMPANY_LOCK_PHRASE, DEFAULT_LOCK_MESSAGE, LOCK_MESSAGE_MAX } from "@/lib/access/lock-rules";

type PersonalLock = { lockedAt: Date | null; lockedUntil: Date | null };
type CompanyLockRow = { enabled: boolean; until: Date | null; message: string | null; lockedAt: Date | null; lockedById: string | null };

export function personalLockActive(user: PersonalLock, now = new Date()): boolean {
  return !!user.lockedAt && (!user.lockedUntil || user.lockedUntil.getTime() > now.getTime());
}

export function companyLockActive(lock: Pick<CompanyLockRow, "enabled" | "until"> | null, now = new Date()): boolean {
  return !!lock?.enabled && (!lock.until || lock.until.getTime() > now.getTime());
}

// ─── The company lock, read on every request, so cached ─────────────────────

const CACHE_MS = 15_000;
/** Per workspace — a lock is one company's, never every company's on the server. */
const cached = new Map<string, { row: CompanyLockRow | null; at: number }>();

/**
 * Set only by check:access-lock, so it can hold people with a company lock without writing one — a
 * real one would hold everybody using this server for as long as the test ran.
 */
let testLock: CompanyLockRow | null | undefined;
export function setTestCompanyLock(lock: CompanyLockRow | null | undefined) {
  testLock = lock;
  cached.clear();
}

export async function companyLock(): Promise<CompanyLockRow | null> {
  if (testLock !== undefined) return testLock;
  const now = Date.now();
  const key = await tenantKey();
  const hit = cached.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.row;
  try {
    const row = await db.companyLock.findUnique({
      where: { id: "global" },
      select: { enabled: true, until: true, message: true, lockedAt: true, lockedById: true },
    });
    cached.set(key, { row, at: now });
    return row;
  } catch {
    return hit?.row ?? null;
  }
}

export function forgetCompanyLock() {
  cached.clear();
}

// ─── What a locked person is shown ───────────────────────────────────────────

export type LockNotice = {
  scope: "user" | "company";
  message: string;
  until: Date | null;
  lockedAt: Date | null;
  lockedBy: string | null;
};

/** Why this person is locked, for the notice — their own lock first, then the company's. Null when they aren't. */
export async function lockNoticeFor(userId: string, now = new Date()): Promise<LockNotice | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { isSuperAdmin: true, lockedAt: true, lockedUntil: true, lockMessage: true, lockedBy: { select: { name: true } } },
  });
  if (!user || user.isSuperAdmin) return null;
  if (personalLockActive(user, now)) {
    return { scope: "user", message: user.lockMessage?.trim() || DEFAULT_LOCK_MESSAGE, until: user.lockedUntil, lockedAt: user.lockedAt, lockedBy: user.lockedBy?.name ?? null };
  }
  const company = await companyLock();
  if (company && companyLockActive(company, now)) {
    const by = company.lockedById ? await db.user.findUnique({ where: { id: company.lockedById }, select: { name: true } }) : null;
    return { scope: "company", message: company.message?.trim() || DEFAULT_LOCK_MESSAGE, until: company.until, lockedAt: company.lockedAt, lockedBy: by?.name ?? null };
  }
  return null;
}
