/**
 * TV screens (owner, 17 Oct 2026 — src/lib/tv/screens.ts, src/actions/tv.ts, src/actions/tv-public.ts,
 * src/app/(tv)): a TV paired by a code, showing one branch's wins (or everybody's), with no user and no seat.
 *
 *   · Pairing: a TV gets a code and keeps it; somebody with "Put Deskzo on a TV" types it in; the TV
 *     collects its secret once and is that screen from then on. A typo, a stale code and a code paired
 *     already are refused alike; nobody without the permission pairs or lists. Only so many TVs wait
 *     with a code at once, since /tv is open to anybody.
 *   · The screen: found from the TV's cookie; renamed and moved to another branch; taken off, its secret
 *     stops working. A TV on an address a rule blocks for everybody shows nothing.
 *   · Its board: a branch's screen shows that branch's people — their targets and wins — and nobody else's.
 *
 * Everything is named ZZPROBE_TV and removed in a finally.
 *
 *   npm run check:tv-screens
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

// The TV's cookies and request headers, as Next would hand them to the code.
const jar = new Map<string, string>();
let requestHeaders = new Headers();
let actorId = "";
const roles = new Map<string, string>();
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/headers") {
    return {
      cookies: async () => ({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
        set: (name: string, value: string, opts?: { maxAge?: number }) => {
          if (!value || opts?.maxAge === 0) jar.delete(name);
          else jar.set(name, value);
        },
      }),
      headers: async () => requestHeaders,
    };
  }
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => (actorId ? { id: actorId, role: roles.get(actorId) ?? "SALES", name: "Zzprobe Tv", email: `${actorId}${MAIL}` } : null);
    return {
      requireUser: async () => {
        const u = user();
        if (!u) throw new Error("Unauthorized");
        return u;
      },
      currentUser: async () => user(),
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_TV";
const MAIL = "@zzprobe-tv.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const said = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : r.error);
/** The codes this run's TVs were given, so their pairings go with the rest. */
const codes: string[] = [];

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await db.tvScreen.deleteMany({ where: { name: { startsWith: TAG } } });
  if (ids.length) {
    await db.celebration.deleteMany({ where: { subjectUserId: { in: ids } } });
    await db.target.deleteMany({ where: { userId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
  await db.branch.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.ipRule.deleteMany({ where: { label: { startsWith: TAG } } });
  if (codes.length) await db.tvPairing.deleteMany({ where: { code: { in: codes } } });
}

/** A fresh TV: no cookies yet. */
const newTv = () => jar.clear();
/** A TV asking for its code, the code noted for the clean-up. Null when it gets none. */
async function codeFor(tvPublic: typeof import("../src/actions/tv-public")) {
  const got = await tvPublic.tvPairingCode();
  if (!got || got === "BUSY") return null;
  codes.push(got.code);
  return got;
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const tvPublic = require("../src/actions/tv-public") as typeof import("../src/actions/tv-public");
  const tv = require("../src/actions/tv") as typeof import("../src/actions/tv");
  const screens = require("../src/lib/tv/screens") as typeof import("../src/lib/tv/screens");
  const { buildWinsWall } = require("../src/lib/wins/wall") as typeof import("../src/lib/wins/wall");
  const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
  const { clearAccessCache } = require("../src/lib/access/gate") as typeof import("../src/lib/access/gate");
  const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
  const { periodContaining } = require("../src/lib/forecast/periods") as typeof import("../src/lib/forecast/periods");

  await cleanup();
  try {
    const make = async (key: string, role: string, branchId: string | null = null) => {
      const u = await db.user.create({ data: { name: `${TAG} ${key}`, email: `${key}${MAIL}`, role, passwordHash: "x".repeat(60), branchId } });
      roles.set(u.id, role);
      return u;
    };
    const mumbai = await db.branch.create({ data: { name: `${TAG} Mumbai`, code: "ZZTVM" } });
    const pune = await db.branch.create({ data: { name: `${TAG} Pune`, code: "ZZTVP" } });
    const manager = await make("manager", "MANAGEMENT");
    const rep = await make("rep", "SALES", mumbai.id);
    const other = await make("other", "SALES", pune.id);

    section("Who may put Deskzo on a TV");
    ok("Management may, by default", await can(manager.id, "wins.tv"));
    ok("  a sales rep may not", !(await can(rep.id, "wins.tv")));

    section("Pairing");
    newTv();
    const first = await codeFor(tvPublic);
    ok("a TV gets a six-digit code", !!first && /^\d{6}$/.test(first.code), first?.code);
    const again = await codeFor(tvPublic);
    ok("  and keeps it while it's good", again?.code === first?.code);
    ok("  waiting till somebody pairs it", (await tvPublic.tvPairingStatus()) === "WAITING");
    const code = first?.code ?? "";

    actorId = rep.id;
    ok("a sales rep can't pair it", !(await tv.pairTvScreen({ code, name: `${TAG} Floor`, branchId: mumbai.id })).ok);
    ok("  nor list the screens", (await tv.listTvScreens()) === null);
    actorId = manager.id;
    const wrong = code === "000000" ? "000001" : "000000";
    const typo = await tv.pairTvScreen({ code: wrong, name: `${TAG} Floor`, branchId: mumbai.id });
    ok("a code no TV is showing is refused", !typo.ok && /No TV is showing/.test(typo.error), said(typo));
    ok("  as is a screen with no name", !(await tv.pairTvScreen({ code, name: " ", branchId: mumbai.id })).ok);
    const paired = await tv.pairTvScreen({ code, name: `${TAG} Mumbai floor`, branchId: mumbai.id });
    ok("the manager pairs it for Mumbai", paired.ok, said(paired));
    const twice = await tv.pairTvScreen({ code, name: `${TAG} Again`, branchId: null });
    ok("  the same code can't pair a second screen", !twice.ok, said(twice));
    ok("the TV collects its screen", (await tvPublic.tvPairingStatus()) === "PAIRED");
    ok("  keeping a secret of its own, and dropping its code", jar.has(screens.TV_COOKIE) && !jar.has(screens.TV_PAIR_COOKIE));
    const stored = paired.ok ? await db.tvScreen.findUniqueOrThrow({ where: { id: paired.data.id } }) : null;
    ok("  the secret itself is never stored, only its hash", !!stored && stored.tokenHash === screens.hashSecret(jar.get(screens.TV_COOKIE)!) && stored.tokenHash !== jar.get(screens.TV_COOKIE));
    ok("  and the pairing is gone", (await db.tvPairing.count({ where: { code } })) === 0);
    const seen = await screens.screenForThisTv();
    ok("the TV is that screen from now on", seen?.id === stored?.id && seen?.branchId === mumbai.id && seen?.branchName === `${TAG} Mumbai` && seen?.pairedById === manager.id);
    ok("  and was seen", !!(await db.tvScreen.findUniqueOrThrow({ where: { id: stored!.id } })).lastSeenAt);

    newTv();
    const stale = await codeFor(tvPublic);
    await db.tvPairing.update({ where: { code: stale!.code }, data: { expiresAt: new Date(Date.now() - 1000) } });
    ok("a code that has run out can't be paired", !(await tv.pairTvScreen({ code: stale!.code, name: `${TAG} Late`, branchId: null })).ok);
    ok("  and the TV is told to get a new one", (await tvPublic.tvPairingStatus()) === "EXPIRED");
    ok("  which it does", (await codeFor(tvPublic))?.code !== stale!.code);

    // Fill the waiting room up to the cap, counting whatever is waiting already on this database.
    const waiting = await db.tvPairing.count({ where: { screenId: null, expiresAt: { gt: new Date() } } });
    for (let i = 0; i < screens.MAX_WAITING - waiting; i++) {
      let filler = "";
      do filler = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
      while (await db.tvPairing.findUnique({ where: { code: filler }, select: { id: true } }));
      codes.push(filler);
      await db.tvPairing.create({ data: { code: filler, deviceKeyHash: screens.hashSecret(`${TAG}-${filler}`), expiresAt: new Date(Date.now() + 60_000) } });
    }
    newTv();
    ok(`with ${screens.MAX_WAITING} TVs waiting, another is told to try later`, (await tvPublic.tvPairingCode()) === "BUSY");
    await db.tvPairing.deleteMany({ where: { code: { in: codes } } });

    section("Its board");
    const clock = await workspaceClock();
    const month = periodContaining(new Date(), "month", clock);
    const lastDay = new Date(clock.calendarDate(month.to).getTime() - 86_400_000);
    for (const [who, value] of [[rep, 500000], [other, 700000]] as const) {
      await db.target.create({ data: { metric: "ORDER_VALUE", period: "MONTH", scope: "USER", userId: who.id, fromDate: clock.calendarDate(month.from), toDate: lastDay, label: month.label, value, createdById: manager.id } });
      await db.celebration.create({ data: { kind: "ACHIEVEMENT", source: "TARGET_HIT", title: `${TAG} ${who.name} hit target`, startsOn: new Date(), endsOn: new Date(Date.now() + 86_400_000), subjectUserId: who.id } });
    }
    const mumbaiWall = await buildWinsWall({ viewerId: null, maskAs: manager.id, branchId: mumbai.id });
    const names = mumbaiWall.leaderboard.map((r) => r.name);
    ok("a branch's board has its people on the leaderboard", names.includes(rep.name) && !names.includes(other.name), names.join(", "));
    const wins = mumbaiWall.wins.map((w) => w.title).filter((t) => t.startsWith(TAG));
    ok("  and its people's wins, nobody else's", wins.length === 1 && wins[0]!.includes(rep.name), wins.join(" | "));
    const everybody = await buildWinsWall({ viewerId: null, maskAs: manager.id, branchId: null });
    ok("the whole company's has both", [rep.name, other.name].every((n) => everybody.leaderboard.some((r) => r.name === n)));
    ok("  and marks nobody as 'you' on a TV", everybody.leaderboard.every((r) => !r.isYou));

    section("Changing and taking off a screen");
    newTv();
    const p2 = await codeFor(tvPublic);
    const second = await tv.pairTvScreen({ code: p2!.code, name: `${TAG} Pune floor`, branchId: pune.id });
    await tvPublic.tvPairingStatus();
    const list = await tv.listTvScreens();
    ok("the manager sees the screens, with their branches", !!list && list.screens.filter((s) => s.name.startsWith(TAG)).map((s) => `${s.name}:${s.branch?.name ?? "all"}`).sort().join() === `${TAG} Mumbai floor:${TAG} Mumbai,${TAG} Pune floor:${TAG} Pune`);
    if (second.ok) {
      ok("renamed and moved to the whole company", (await tv.updateTvScreen({ id: second.data.id, name: `${TAG} Pune lobby`, branchId: null })).ok && (await screens.screenForThisTv())?.branchId === null);
      ok("taken off, its secret stops working", (await tv.removeTvScreen(second.data.id)).ok && (await screens.screenForThisTv()) === null);
    }

    section("Where a TV may show");
    newTv();
    const p3 = await codeFor(tvPublic);
    await tv.pairTvScreen({ code: p3!.code, name: `${TAG} Blocked`, branchId: null });
    await tvPublic.tvPairingStatus();
    process.env.TRUST_PROXY = "1";
    requestHeaders = new Headers({ "x-forwarded-for": "203.0.113.9" });
    ok("from an ordinary address, it shows", !!(await screens.screenForThisTv()));
    await db.ipRule.create({ data: { cidr: "203.0.113.0/24", action: "BLOCK", label: `${TAG} blocked range`, roleKeys: [] } });
    clearAccessCache();
    ok("  from an address blocked for everybody, nothing", (await screens.screenForThisTv()) === null);
  } finally {
    await cleanup();
    clearAccessCache();
  }

  console.log(failures === 0 ? "\nAll TV screen checks passed." : `\n${failures} TV screen check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
