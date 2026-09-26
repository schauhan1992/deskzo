/**
 * Administrator locks — src/lib/access/lock.ts.
 *
 *   · Without a database: a lock holds before anything else the gate checks, the super admin is never
 *     held, an ended session still ends, and a lock with an end date lifts itself.
 *   · Through the real gate and the real `requireUser`: a locked person is held on every page and
 *     refused every server action; unlocked, they aren't.
 *   · The whole company: everybody held except the super admin — checked through a stand-in lock,
 *     because a real one would hold everybody using this server while the check ran.
 *   · Who may lock whom: `users.lock` for one person, never yourself or the super admin, the super
 *     admin alone for the company, and nothing while viewing as somebody.
 *   · The notice they see, and the page that manages it.
 *
 * Fixtures are named ZZLOCK and removed in a finally.
 *
 *   npm run check:access-lock
 */
import "dotenv/config";
import Module from "node:module";
import type { ReactElement } from "react";
import { directClient } from "../src/lib/tenancy/direct-client";

let actorId = "";
let viewingAs = false;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  // The session the real `requireUser` reads, and the one the stand-in hands the actions.
  if (request === "@/lib/auth") {
    return { auth: async () => (actorId ? { user: { id: actorId, name: NAMES[actorId] ?? "Zzlock", email: `x${MAIL}`, sid: null } } : null), signIn: async () => {}, signOut: async () => {} };
  }
  if (request === "@/lib/session" || request === "../src/lib/session") {
    const user = () => ({ id: actorId, role: "SALES", name: NAMES[actorId] ?? "Zzlock", email: `x${MAIL}` });
    return {
      requireUser: async () => user(),
      currentUser: async () => user(),
      viewAsContext: async () => (viewingAs ? { user: { id: "someone" }, actor: { id: actorId } } : null),
    };
  }
  // A request from a browser, as the gate sees one. Outside a request `requireUser` asks nobody —
  // scripts and background jobs have nobody at a door — so without this the real refusal can't show.
  if (request === "@/lib/access/request") {
    return { requestFacts: async () => ({ inRequest: true, ip: null, userAgent: "Mozilla/5.0 (Windows NT 10.0)", mobileHint: null, deviceToken: null }) };
  }
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => "/",
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZLOCK";
const MAIL = "@zzprobe-lock.invalid";
const NAMES: Record<string, string> = {};
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await db.activityLog.deleteMany({ where: { userId: { in: ids } } });
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: ids } }] } });
  await db.userDevice.deleteMany({ where: { userId: { in: ids } } });
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.user.updateMany({ where: { lockedById: { in: ids } }, data: { lockedById: null } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const decide = require("../src/lib/access/decide") as typeof import("../src/lib/access/decide");
  const lock = require("../src/lib/access/lock") as typeof import("../src/lib/access/lock");

  // ─────────────────────────────────────────────────────────────────────────────
  section("The decision");

  const base = {
    sessionEnded: false,
    exempt: false,
    policy: decide.OPEN_POLICY,
    network: { standing: "ALLOWED" as const, rule: null },
    device: { kind: "COMPUTER" as const, status: "APPROVED" as const },
    locationShared: true,
  };
  const reason = (f: Partial<typeof base> & { locked?: boolean }) => {
    const v = decide.decideAccess({ ...base, ...f } as unknown as Parameters<typeof decide.decideAccess>[0]);
    return v.ok ? "OK" : v.reason;
  };
  ok("a locked person is held", reason({ locked: true }) === "LOCKED");
  ok("  before the network and device are even looked at", reason({ locked: true, network: { standing: "BLOCKED", rule: null } as never }) === "LOCKED");
  ok("the super admin is never held by a lock", reason({ locked: true, exempt: true }) === "OK");
  ok("an ended session still reads as ended — signing in again is the way out of that one", reason({ locked: true, sessionEnded: true }) === "SESSION_ENDED");
  ok("unlocked, nothing changes", reason({}) === "OK" && reason({ locked: false }) === "OK");
  const soon = new Date(Date.now() + 3_600_000);
  const past = new Date(Date.now() - 60_000);
  ok("a lock with no end holds", lock.personalLockActive({ lockedAt: new Date(), lockedUntil: null }));
  ok("  one with an end holds until then, and lifts itself after", lock.personalLockActive({ lockedAt: new Date(), lockedUntil: soon }) && !lock.personalLockActive({ lockedAt: new Date(), lockedUntil: past }));
  ok("the company lock the same way", lock.companyLockActive({ enabled: true, until: null }) && !lock.companyLockActive({ enabled: true, until: past }) && !lock.companyLockActive({ enabled: false, until: null }));
  ok("the notice has words when the admin wrote none", decide.HOLD_MESSAGE.LOCKED.title.length > 0 && lock.DEFAULT_LOCK_MESSAGE.length > 20);

  const gate = require("../src/lib/access/gate") as typeof import("../src/lib/access/gate");
  const session = require("../src/lib/session.ts") as typeof import("../src/lib/session");
  const actions = require("../src/actions/access-lock") as typeof import("../src/actions/access-lock");
  const held = async (userId: string) => {
    gate.clearAccessCache();
    const v = await gate.evaluateAccess({ userId, sid: null, deviceToken: null, ip: null, userAgent: "Mozilla/5.0 (Windows NT 10.0)", mobileHint: null });
    return v.ok ? "OK" : v.reason;
  };
  const refusedAction = async (userId: string) => {
    const was = actorId;
    actorId = userId;
    gate.clearAccessCache();
    try {
      await session.requireUser();
      return false;
    } catch (err) {
      return err instanceof session.UnauthorizedError;
    } finally {
      actorId = was;
    }
  };

  await cleanup();
  const superAdmin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true, name: true } });
  try {
    const make = async (name: string, grants: Record<string, boolean>, active = true) => {
      const u = await db.user.create({
        data: {
          name: `Zzlock ${name}`,
          email: `${name.toLowerCase()}${MAIL}`,
          role: "SALES",
          active,
          passwordHash: "x".repeat(60),
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
      });
      NAMES[u.id] = u.name;
      return u;
    };
    const admin = await make("Admin", { "users.lock": true });
    const rep = await make("Rep", { "users.lock": false });
    const target = await make("Target", {});
    const leaver = await make("Leaver", {}, false);

    // ───────────────────────────────────────────────────────────────────────────
    section("Who may lock whom");

    actorId = rep.id;
    ok("somebody without the permission can't see the locks", (await actions.getAccessLocks()) === null);
    ok("  nor lock anybody", !(await actions.lockUser({ userId: target.id })).ok);
    actorId = admin.id;
    const why = async (input: Parameters<typeof actions.lockUser>[0]) => {
      const r = await actions.lockUser(input);
      return r.ok ? "LOCKED" : r.error;
    };
    ok("nobody can lock themselves out", (await why({ userId: admin.id })).includes("yourself"));
    ok("nobody can lock the super admin", !superAdmin || (await why({ userId: superAdmin.id })).includes("super admin"));
    ok("somebody who has left isn't locked — they're already out", (await why({ userId: leaver.id })).includes("active"));
    ok("an end time that has passed is refused", (await why({ userId: target.id, until: "2020-01-01T10:00" })).includes("future"));
    ok("so is a notice too long to read", (await why({ userId: target.id, message: "x".repeat(1001) })).includes("under"));
    viewingAs = true;
    ok("nothing while viewing as somebody", (await why({ userId: target.id })).includes("own account"));
    viewingAs = false;
    ok("the whole company is the super admin's alone", !(await actions.lockCompany({ confirm: "LOCK" })).ok);

    // ───────────────────────────────────────────────────────────────────────────
    section("One person, locked");

    ok("before: not held", (await held(target.id)) !== "LOCKED" && !(await refusedAction(target.id)));
    actorId = admin.id;
    const locked = await actions.lockUser({ userId: target.id, message: `${TAG} Your dues are pending.\nCall accounts.`, until: "2099-01-01T10:00" });
    ok("it locks", locked.ok, !locked.ok ? locked.error : "");
    const row = await db.user.findUnique({ where: { id: target.id }, select: { lockedAt: true, lockedUntil: true, lockMessage: true, lockedById: true } });
    ok("  recording who, when, until when and the notice", !!row?.lockedAt && row.lockedById === admin.id && row.lockMessage?.startsWith(TAG) === true && row.lockedUntil?.toISOString() === "2099-01-01T04:30:00.000Z");
    ok("every page holds them — straight away, not after a cache runs out", (await held(target.id)) === "LOCKED");
    ok("every server action refuses them", await refusedAction(target.id));
    ok("it is audited", (await db.auditLog.count({ where: { userId: admin.id, entityId: target.id, entityLabel: { contains: "locked out" } } })) === 1);
    const notice = await lock.lockNoticeFor(target.id);
    ok("their notice is the admin's words, with the end and who locked them", notice?.scope === "user" && notice.message.includes("dues are pending") && notice.lockedBy === "Zzlock Admin" && !!notice.until);
    actorId = admin.id;
    const view = await actions.getAccessLocks();
    ok("the locks page lists them as locked", !!view?.people.find((p) => p.id === target.id && p.active));
    ok("  and doesn't offer to lock them again, nor yourself, nor the super admin", !!view && !view.candidates.some((c) => c.id === target.id || c.id === admin.id || c.id === superAdmin?.id));

    // The page they see.
    const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
    const AccessPage = (require("../src/app/(auth)/access/page") as { default: (p: { searchParams: Promise<{ next?: string }> }) => Promise<ReactElement> }).default;
    actorId = target.id;
    gate.clearAccessCache();
    const splash = renderToStaticMarkup(await AccessPage({ searchParams: Promise.resolve({ next: "/dashboard" }) }));
    ok("what they see: the lock, the notice, when it lifts, and only Check again and Sign out", splash.includes("Your access is locked") && splash.includes("dues are pending") && splash.includes("Access returns on") && splash.includes("Sign out") && splash.includes("Check again"));
    ok("  nothing of the app — not even the device and network panel other holds show", !splash.includes("Address unknown") && !splash.includes("dashboard</a>"));

    // Lifting.
    actorId = admin.id;
    ok("unlocking lets them back at once", (await actions.unlockUser(target.id)).ok && (await held(target.id)) !== "LOCKED" && !(await refusedAction(target.id)));
    ok("  and is audited", (await db.auditLog.count({ where: { userId: admin.id, entityId: target.id, entityLabel: { contains: "unlocked" } } })) === 1);
    actorId = admin.id;
    const notLocked = await actions.unlockUser(target.id);
    ok("unlocking somebody who isn't locked says so", !notLocked.ok && notLocked.error.includes("isn't locked"), !notLocked.ok ? notLocked.error : "");
    actorId = admin.id;
    ok("locked again", (await actions.lockUser({ userId: target.id })).ok);
    actorId = rep.id;
    const repUnlock = await actions.unlockUser(target.id);
    ok("  and anyone without the permission can't unlock", !repUnlock.ok && repUnlock.error.includes("can't"), !repUnlock.ok ? repUnlock.error : "");
    await db.user.update({ where: { id: target.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    ok("a lock whose time has passed has lifted itself", (await held(target.id)) !== "LOCKED" && !(await refusedAction(target.id)));
    actorId = admin.id;
    ok("  and the page shows it as lifted", (await actions.getAccessLocks())?.people.find((p) => p.id === target.id)?.active === false);

    // ───────────────────────────────────────────────────────────────────────────
    section("The whole company — through a stand-in, so nobody here is held");

    lock.setTestCompanyLock({ enabled: true, until: null, message: `${TAG} Annual audit in progress.`, lockedAt: new Date(), lockedById: superAdmin?.id ?? null });
    ok("everybody is held — a rep", (await held(rep.id)) === "LOCKED" && (await refusedAction(rep.id)));
    ok("  an admin who can lock people", (await held(admin.id)) === "LOCKED");
    ok("  but never the super admin, who is the one who can lift it", !superAdmin || (await held(superAdmin.id)) !== "LOCKED");
    const companyNotice = await lock.lockNoticeFor(rep.id);
    ok("they see the company's notice", companyNotice?.scope === "company" && companyNotice.message.includes("Annual audit"));
    actorId = rep.id;
    gate.clearAccessCache();
    lock.setTestCompanyLock({ enabled: true, until: null, message: `${TAG} Annual audit in progress.`, lockedAt: new Date(), lockedById: superAdmin?.id ?? null });
    const companySplash = renderToStaticMarkup(await AccessPage({ searchParams: Promise.resolve({}) }));
    ok("  under the heading for the whole CRM", companySplash.includes("The CRM is locked") && companySplash.includes("Annual audit"));
    lock.setTestCompanyLock({ enabled: true, until: new Date(Date.now() - 1000), message: null, lockedAt: new Date(), lockedById: null });
    ok("a company lock whose time has passed has lifted itself", (await held(rep.id)) !== "LOCKED");
    lock.setTestCompanyLock(undefined);
    if (superAdmin) {
      actorId = superAdmin.id;
      const wrong = await actions.lockCompany({ confirm: "lock it" });
      ok("the super admin has to type the phrase", !wrong.ok && wrong.error.includes("LOCK"));
    }

    // ───────────────────────────────────────────────────────────────────────────
    section("The page that manages it");

    const Page = (require("../src/app/(dashboard)/settings/locks/page") as { default: () => Promise<ReactElement> }).default;
    actorId = admin.id;
    const html = renderToStaticMarkup(await Page());
    ok("an admin sees the person lock, and that the company lock isn't theirs", html.includes("Lock one person") && html.includes("Only the super admin can lock the whole company"));
    actorId = rep.id;
    ok("somebody without the permission is told so", renderToStaticMarkup(await Page()).includes("Only somebody who can lock people out"));
    if (superAdmin) {
      actorId = superAdmin.id;
      const superHtml = renderToStaticMarkup(await Page());
      ok("the super admin is offered the company lock, behind a typed confirmation", superHtml.includes("Lock the whole company") && superHtml.includes("Type LOCK to confirm"));
    }
  } finally {
    lock.setTestCompanyLock(undefined);
    await cleanup();
    gate.clearAccessCache();
  }

  console.log(failures === 0 ? "\nAll access-lock checks passed." : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
