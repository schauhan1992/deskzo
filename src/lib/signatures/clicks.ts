import { timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { digestSecret } from "@/lib/crypto";
import { tenantKey } from "@/lib/tenancy/cache";
import { classifyUserAgent } from "@/lib/security/bots";
import { workspaceClock } from "@/lib/time/workspace";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { safeUrl } from "@/lib/signatures/render";
import { readSignatureSettings } from "@/lib/signatures/sync";

/**
 * Counting clicks on a signature's banner and button. While a company counts them (on by default), the
 * banner's link and the button's link in each person's signature are the workspace's own short address
 * — /s/<what>.<whose>.<MAC> — which counts the click and sends the reader on to where it goes. The MAC,
 * under the workspace's key, means nobody can make up an address to count against somebody else.
 *
 * What is counted: clicks per banner or button, per person whose signature it was, per day. Who clicked
 * is never known or kept — an email's reader is nobody's account. Mail programs that check links before
 * the reader sees them (Outlook's Safe Links, Gmail's scanner and the like) are left out where they can
 * be told apart: a known automated agent, a prefetch, a HEAD, and the same address from the same place
 * again within ten minutes. They can't all be told apart, so the count leans high, never low.
 *
 * The logo, website and social profiles link straight to where they go: those are the addresses a reader
 * checks before trusting an email, and a signature full of redirects reads like spam to filters too.
 */

export type ClickKind = "BANNER" | "BUTTON";
const LETTER: Record<ClickKind, string> = { BANNER: "b", BUTTON: "c" };
const KIND_OF: Record<string, ClickKind> = { b: "BANNER", c: "BUTTON" };

/** The proxy rewrites /s/<token> to the click route (src/app/api/signatures/click/[token]). */
export const CLICK_PREFIX = "/s/";

async function clickMac(kind: ClickKind, refId: string, userId: string): Promise<string> {
  return (await digestSecret(`signature-click:${kind}:${refId}:${userId}`)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 16);
}

/** The address a person's banner or button links to while clicks are counted. */
export async function clickLink(origin: string, kind: ClickKind, refId: string, userId: string): Promise<string> {
  return `${origin.replace(/\/+$/, "")}${CLICK_PREFIX}${LETTER[kind]}${refId}.${userId}.${await clickMac(kind, refId, userId)}`;
}

/** What a click address names, when its MAC is right. */
export async function readClickToken(token: string): Promise<{ kind: ClickKind; refId: string; userId: string } | null> {
  const m = /^([bc])([a-z0-9]{10,40})\.([a-z0-9]{10,40})\.([A-Za-z0-9_-]{16})$/.exec(token);
  if (!m) return null;
  const kind = KIND_OF[m[1]!]!;
  const expected = Buffer.from(await clickMac(kind, m[2]!, m[3]!));
  const given = Buffer.from(m[4]!);
  return expected.length === given.length && timingSafeEqual(expected, given) ? { kind, refId: m[2]!, userId: m[3]! } : null;
}

// ── A click ─────────────────────────────────────────────────────────────────────────────────────────

/** The same address from the same place within this long is one click — a scanner and its retries, or a double-click. */
const REPEAT_MS = 10 * 60_000;
const MAX_TRACKED = 10_000;
/** When each address was last counted from each place, per workspace. */
const recent = new Map<string, number>();

/** Only for the check script. */
export function resetClickMemory() {
  recent.clear();
}

/** Where a banner or button sends the reader now — its current link, https only. A deleted template's button goes where the default's does. */
async function targetOf(kind: ClickKind, refId: string): Promise<string | null> {
  if (kind === "BANNER") {
    const banner = await db.signatureBanner.findUnique({ where: { id: refId }, select: { linkUrl: true } });
    return banner?.linkUrl ? safeUrl(banner.linkUrl) : null;
  }
  const template =
    (await db.signatureTemplate.findUnique({ where: { id: refId }, select: { ctaUrl: true } })) ??
    (await db.signatureTemplate.findFirst({ where: { isDefault: true }, select: { ctaUrl: true } }));
  return template?.ctaUrl ? safeUrl(template.ctaUrl) : null;
}

export type ClickRequest = {
  token: string;
  method: string;
  userAgent: string | null;
  /** Purpose / Sec-Purpose: a browser fetching ahead of a click that may never come. */
  purpose: string | null;
  /** The caller's address as our proxy saw it (src/lib/client-ip.ts), or null. */
  ip: string | null;
  now?: number;
};

export type ClickOutcome = { target: string | null; counted: boolean };

/**
 * A click on a signature's banner or button: where to send the reader, and whether it was counted. The
 * reader is always sent on while the thing still has a link — counting off, an automated agent, a
 * repeat, all included; only a forged address or a link that is gone has nowhere to go.
 */
export async function recordClick(req: ClickRequest): Promise<ClickOutcome> {
  if (!(await moduleAvailableForTenant("signatures"))) return { target: null, counted: false };
  const named = await readClickToken(req.token);
  if (!named) return { target: null, counted: false };
  const target = await targetOf(named.kind, named.refId);
  if (!target) return { target: null, counted: false };

  const settings = await readSignatureSettings();
  const automated = req.method !== "GET" || classifyUserAgent(req.userAgent) !== null || /prefetch|prerender/i.test(req.purpose ?? "");
  if (settings?.trackClicks === false || automated) return { target, counted: false };

  const now = req.now ?? Date.now();
  const key = `${await tenantKey()}|${named.kind}|${named.refId}|${named.userId}|${req.ip ?? "unknown"}`;
  const last = recent.get(key);
  if (last !== undefined && now - last < REPEAT_MS) return { target, counted: false };
  if (last === undefined && recent.size >= MAX_TRACKED) {
    const oldest = recent.keys().next().value;
    if (oldest !== undefined) recent.delete(oldest);
  }
  recent.delete(key);
  recent.set(key, now);

  const day = new Date(`${(await workspaceClock()).today(new Date(now))}T00:00:00.000Z`);
  const id = { kind: named.kind, refId: named.refId, userId: named.userId, day };
  await db.signatureClick.upsert({ where: { kind_refId_userId_day: id }, create: { ...id, clicks: 1 }, update: { clicks: { increment: 1 } } });
  return { target, counted: true };
}

// ── The report ──────────────────────────────────────────────────────────────────────────────────────

export const CLICK_PERIODS = [7, 30, 90] as const;
export type ClickPeriod = (typeof CLICK_PERIODS)[number];

/** The first and last day of a period ending today, in the workspace's calendar. */
export async function periodDays(days: number): Promise<{ from: Date; to: Date; keys: string[] }> {
  const today = (await workspaceClock()).today();
  const to = new Date(`${today}T00:00:00.000Z`);
  const keys = Array.from({ length: days }, (_, i) => new Date(to.getTime() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
  return { from: new Date(`${keys[0]}T00:00:00.000Z`), to, keys };
}

export type ClickItem = { key: string; kind: ClickKind; refId: string; label: string; note: string | null; clicks: number; allTime: number };

/** Every banner and button that has been clicked, with its clicks in the period and ever, most first. */
export async function clickItems(days: number): Promise<ClickItem[]> {
  const { from, to } = await periodDays(days);
  const [inPeriod, ever] = await Promise.all([
    db.signatureClick.groupBy({ by: ["kind", "refId"], where: { day: { gte: from, lte: to } }, _sum: { clicks: true } }),
    db.signatureClick.groupBy({ by: ["kind", "refId"], _sum: { clicks: true } }),
  ]);
  const ids = (kind: string) => ever.filter((r) => r.kind === kind).map((r) => r.refId);
  const [banners, templates] = await Promise.all([
    db.signatureBanner.findMany({ where: { id: { in: ids("BANNER") } }, select: { id: true, name: true, removedAt: true } }),
    db.signatureTemplate.findMany({ where: { id: { in: ids("BUTTON") } }, select: { id: true, name: true, ctaLabel: true } }),
  ]);
  const period = new Map(inPeriod.map((r) => [`${r.kind}:${r.refId}`, r._sum.clicks ?? 0]));
  return ever
    .map((r): ClickItem => {
      const key = `${r.kind}:${r.refId}`;
      const banner = r.kind === "BANNER" ? banners.find((b) => b.id === r.refId) : undefined;
      const template = r.kind === "BUTTON" ? templates.find((t) => t.id === r.refId) : undefined;
      return {
        key,
        kind: r.kind as ClickKind,
        refId: r.refId,
        label: r.kind === "BANNER" ? (banner?.name ?? "A deleted banner") : `${template?.ctaLabel || "Button"} — ${template?.name ?? "a deleted template"}`,
        note: r.kind === "BANNER" ? (banner?.removedAt ? "Removed" : "Banner") : "Button",
        clicks: period.get(key) ?? 0,
        allTime: r._sum.clicks ?? 0,
      };
    })
    .sort((a, b) => b.clicks - a.clicks || b.allTime - a.allTime || a.label.localeCompare(b.label));
}

export type ClickDetail = {
  byDay: { day: string; clicks: number }[];
  byTeam: { team: string; clicks: number }[];
  byPerson: { userId: string; name: string; team: string; clicks: number }[];
  total: number;
};

/** One banner's or button's clicks in the period: by day, by department, and by whose signature carried it. */
export async function clickDetail(kind: ClickKind, refId: string, days: number): Promise<ClickDetail> {
  const { from, to, keys } = await periodDays(days);
  const where = { kind, refId, day: { gte: from, lte: to } };
  const [rowsByDay, rowsByUser] = await Promise.all([
    db.signatureClick.groupBy({ by: ["day"], where, _sum: { clicks: true } }),
    db.signatureClick.groupBy({ by: ["userId"], where, _sum: { clicks: true } }),
  ]);
  const people = await db.user.findMany({ where: { id: { in: rowsByUser.map((r) => r.userId) } }, select: { id: true, name: true, department: { select: { name: true } } } });
  const dayCounts = new Map(rowsByDay.map((r) => [r.day.toISOString().slice(0, 10), r._sum.clicks ?? 0]));
  const byPerson = rowsByUser
    .map((r) => {
      const p = people.find((x) => x.id === r.userId);
      return { userId: r.userId, name: p?.name ?? "A removed account", team: p?.department?.name ?? "No department", clicks: r._sum.clicks ?? 0 };
    })
    .sort((a, b) => b.clicks - a.clicks || a.name.localeCompare(b.name));
  const teams = new Map<string, number>();
  for (const p of byPerson) teams.set(p.team, (teams.get(p.team) ?? 0) + p.clicks);
  return {
    byDay: keys.map((day) => ({ day, clicks: dayCounts.get(day) ?? 0 })),
    byTeam: [...teams].map(([team, clicks]) => ({ team, clicks })).sort((a, b) => b.clicks - a.clicks || a.team.localeCompare(b.team)),
    byPerson,
    total: byPerson.reduce((n, p) => n + p.clicks, 0),
  };
}

/** Each banner's clicks in the last `days` days, for the Banners tab. */
export async function bannerClicks(days: number): Promise<Map<string, number>> {
  const { from, to } = await periodDays(days);
  const rows = await db.signatureClick.groupBy({ by: ["refId"], where: { kind: "BANNER", day: { gte: from, lte: to } }, _sum: { clicks: true } });
  return new Map(rows.map((r) => [r.refId, r._sum.clicks ?? 0]));
}
