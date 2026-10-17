import { createHash, randomBytes, randomInt } from "node:crypto";
import { cookies, headers } from "next/headers";
import { db } from "@/lib/db";
import { activeIpRules } from "@/lib/access/gate";
import { networkStanding } from "@/lib/access/decide";
import { companyLock, companyLockActive } from "@/lib/access/lock";
import { clientIpFrom } from "@/lib/client-ip";

/**
 * TV screens (owner, 17 Oct 2026): a TV on a wall shows a board — the sales floor's wins — without anybody
 * signing in on it. The TV opens /tv and shows a six-digit code; somebody who may put Deskzo on a TV
 * ("wins.tv") types the code into Deskzo, names the screen and picks its branch; the TV collects a secret
 * of its own and keeps it in a cookie scoped to /tv. That secret shows its board and nothing else: no
 * page outside /tv, no action, no API. Remove the screen and the secret stops working.
 *
 * Deliberately NOT a "use server" module — it reads and sets the TV's cookies for the actions and pages
 * that call it (src/actions/tv-public.ts, src/actions/tv.ts, src/app/(tv)).
 */

/** The screen's secret, on the TV. Scoped to /tv, so it is never sent with any other page. */
export const TV_COOKIE = "deskzo-tv";
/** The waiting TV's key, while its code is on the screen. */
export const TV_PAIR_COOKIE = "deskzo-tv-pair";
/** How long a code stays good. */
export const PAIRING_MINUTES = 10;
/**
 * How many TVs may wait with a code at once. /tv is open to anybody, so this is what stops a script from
 * filling the table with codes; a real office never has this many TVs waiting in the same ten minutes.
 */
export const MAX_WAITING = 30;
const SCREEN_COOKIE_DAYS = 400;

export const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");
const newSecret = () => randomBytes(32).toString("base64url");

async function secure(): Promise<boolean> {
  const h = await headers();
  return h.get("x-forwarded-proto") === "https" || (h.get("origin") ?? h.get("referer") ?? "").startsWith("https:");
}

async function setCookie(name: string, value: string, maxAgeSeconds: number) {
  (await cookies()).set(name, value, { httpOnly: true, sameSite: "lax", secure: await secure(), path: "/tv", maxAge: maxAgeSeconds });
}

/** A fresh six-digit code no live pairing holds. */
async function freeCode(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    if (!(await db.tvPairing.findUnique({ where: { code }, select: { id: true } }))) return code;
  }
  throw new Error("No free pairing code — try again.");
}

/**
 * The code this TV shows: the one it already has, while it's good; otherwise a new one. Spent codes are
 * cleared on the way, so the table only ever holds the few TVs waiting right now. Null when too many are
 * waiting already (MAX_WAITING).
 */
export async function pairingForThisTv(): Promise<{ code: string; expiresAt: Date } | null> {
  const now = new Date();
  await db.tvPairing.deleteMany({ where: { expiresAt: { lt: now }, screenId: null } });
  const key = (await cookies()).get(TV_PAIR_COOKIE)?.value;
  if (key) {
    const existing = await db.tvPairing.findUnique({ where: { deviceKeyHash: hashSecret(key) } });
    if (existing && existing.expiresAt > now && !existing.screenId) return { code: existing.code, expiresAt: existing.expiresAt };
  }
  if ((await db.tvPairing.count({ where: { screenId: null, expiresAt: { gt: now } } })) >= MAX_WAITING) return null;
  const deviceKey = newSecret();
  const expiresAt = new Date(now.getTime() + PAIRING_MINUTES * 60_000);
  const made = await db.tvPairing.create({ data: { code: await freeCode(), deviceKeyHash: hashSecret(deviceKey), expiresAt } });
  await setCookie(TV_PAIR_COOKIE, deviceKey, PAIRING_MINUTES * 60);
  return { code: made.code, expiresAt };
}

/** Whether this TV has been paired yet; when it has, it takes its secret and the pairing is gone. */
export async function collectPairing(): Promise<"PAIRED" | "WAITING" | "EXPIRED"> {
  const key = (await cookies()).get(TV_PAIR_COOKIE)?.value;
  if (!key) return "EXPIRED";
  const pairing = await db.tvPairing.findUnique({ where: { deviceKeyHash: hashSecret(key) } });
  if (!pairing) return "EXPIRED";
  if (pairing.screenId && pairing.secret) {
    await db.tvPairing.delete({ where: { id: pairing.id } });
    await setCookie(TV_COOKIE, pairing.secret, SCREEN_COOKIE_DAYS * 86_400);
    await setCookie(TV_PAIR_COOKIE, "", 0);
    return "PAIRED";
  }
  return pairing.expiresAt > new Date() ? "WAITING" : "EXPIRED";
}

/**
 * Pairs the TV showing `code` as a new screen. The caller has checked "wins.tv". Null when no TV is
 * showing that code now — a typo, or a code gone stale.
 */
export async function pairScreen(input: { code: string; name: string; branchId: string | null; pairedById: string }) {
  const pairing = await db.tvPairing.findUnique({ where: { code: input.code } });
  if (!pairing || pairing.screenId || pairing.expiresAt <= new Date()) return null;
  const secret = newSecret();
  return db.$transaction(async (tx) => {
    const screen = await tx.tvScreen.create({
      data: { name: input.name, branchId: input.branchId, tokenHash: hashSecret(secret), pairedById: input.pairedById },
      select: { id: true, name: true },
    });
    // Claimed only if nobody claimed it first — two people typing the same code pair it once.
    const claimed = await tx.tvPairing.updateMany({ where: { id: pairing.id, screenId: null }, data: { screenId: screen.id, secret } });
    if (claimed.count !== 1) throw new Error("That TV was paired a moment ago.");
    return screen;
  });
}

/**
 * Whether a TV may show its board from where it is: never from an address a rule blocks for everybody, and
 * not while the whole company is locked. A TV has no role, so a role's own rules don't reach it.
 */
export async function tvNetworkAllowed(ip: string | null): Promise<boolean> {
  const [rules, lock] = await Promise.all([activeIpRules(), companyLock()]);
  if (companyLockActive(lock)) return false;
  return networkStanding(ip, "", rules, new Date()).standing !== "BLOCKED";
}

export type TvViewer = { id: string; name: string; branchId: string | null; branchName: string | null; pairedById: string | null };

/**
 * The screen this TV is, from its cookie — null for a TV that isn't paired, or whose screen was removed,
 * or that is somewhere it may not show. Notes when it was last seen, at most once a minute.
 */
export async function screenForThisTv(): Promise<TvViewer | null> {
  const secret = (await cookies()).get(TV_COOKIE)?.value;
  if (!secret) return null;
  const screen = await db.tvScreen.findUnique({
    where: { tokenHash: hashSecret(secret) },
    select: { id: true, name: true, branchId: true, pairedById: true, lastSeenAt: true, branch: { select: { name: true } } },
  });
  if (!screen) return null;
  const ip = clientIpFrom(await headers());
  if (!(await tvNetworkAllowed(ip))) return null;
  if (!screen.lastSeenAt || Date.now() - screen.lastSeenAt.getTime() > 60_000) {
    await db.tvScreen.update({ where: { id: screen.id }, data: { lastSeenAt: new Date(), lastSeenIp: ip } }).catch(() => {});
  }
  return { id: screen.id, name: screen.name, branchId: screen.branchId, branchName: screen.branch?.name ?? null, pairedById: screen.pairedById };
}
