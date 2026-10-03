/**
 * Running journeys (src/lib/marketing/enrol.ts `advanceEnrolments`), against a database: what the
 * pure rules in check:marketing can't show is which enrolments the run picks up at all.
 *
 *   · A paused journey holds everybody where they are — no step, no task, no message — while a
 *     running one beside it carries on. Pausing exits nobody.
 *   · On Start they carry on from their step, and the wait after it counts from then.
 *   · A draft journey holds the same way.
 *   · Archiving exits whoever is still in it, saying why, so starting it again wakes nobody.
 *
 * On a scratch database built from the migrations and dropped at the end: a run advances every due
 * enrolment it can see, and the real workspace's journeys are not this suite's to advance.
 *
 *   npm run check:journey-runs
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const TAG = "ZZJOURNEY";
const DAY = 86_400_000;

// ── Who is calling ──────────────────────────────────────────────────────────────────────────────

let actor: { id: string; name: string; email: string; role: string } | null = null;
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const moduleOverrides = {
  requireModuleUser: async () => session.requireUser(),
  moduleAvailableForTenant: async () => true,
};
let modulesAccess: unknown = null;
const files = new Map<string, () => unknown>([
  [load.resolve("next/cache"), () => nextCache],
  [load.resolve("../src/lib/session"), () => session],
]);
const modulesFile = load.resolve("../src/lib/modules-access");
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return nextCache;
  if (request === "@/lib/session") return session;
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved && files.has(resolved)) return files.get(resolved)!();
  if (request === "@/lib/modules-access" || resolved === modulesFile) {
    modulesAccess ??= { ...(realLoad.call(this, request, parent, isMain) as object), ...moduleOverrides };
    return modulesAccess;
  }
  return realLoad.call(this, request, parent, isMain);
};

// ── The scratch database ────────────────────────────────────────────────────────────────────────

async function main() {
  const realUrl = process.env.DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);

  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_journeys`;
  const scratchUrl = withDatabase(realUrl, scratchName);
  ok("  and it is not the real one", scratchName !== realName, scratchName);

  const real = directClient(realUrl, { max: 1 });
  const realBefore = await snapshot(real);
  const admin = directClient(withDatabase(realUrl, "postgres"), { max: 1 });
  let closeAll: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60 * 1000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);

    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = "";
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    closeAll = () => db.$disconnect();
    await run(db as unknown as PrismaClient);
  } finally {
    await closeAll?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const gone = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratchName}'`);
    ok("the scratch database is dropped", Number(gone[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  section("The real workspace was not touched");
  const realAfter = await snapshot(real);
  await real.$disconnect();
  ok("its journeys and enrolments are as they were", realAfter === realBefore, realAfter);

  console.log(failures === 0 ? `\nAll ${passes} journey run checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** What the suite must never change in the real workspace. Read-only. */
async function snapshot(client: PrismaClient) {
  const [journeys, enrolments, steps] = await Promise.all([
    client.journey.count(),
    client.journeyEnrolment.groupBy({ by: ["status", "currentStep"], _count: true, orderBy: [{ status: "asc" }, { currentStep: "asc" }] }),
    client.journeyStep.count(),
  ]);
  return JSON.stringify({ journeys, steps, enrolments: enrolments.map((e) => `${e.status}@${e.currentStep}:${e._count}`) });
}

// ── The suite ───────────────────────────────────────────────────────────────────────────────────

async function run(db: PrismaClient) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { advanceEnrolments } = require("../src/lib/marketing/enrol") as typeof import("../src/lib/marketing/enrol");
  const { setJourneyStatus } = require("../src/actions/marketing") as typeof import("../src/actions/marketing");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("Two journeys, one person in each");
  const owner = await db.user.create({
    data: { name: `${TAG} Owner`, email: "owner@zzjourney.example.test", passwordHash: "!", role: "ADMIN", isSuperAdmin: true },
    select: { id: true, name: true, email: true, role: true },
  });
  actor = owner;
  const company = await db.company.create({
    data: { name: `${TAG} Traders`, normalizedName: `${TAG} traders`.toLowerCase(), createdById: owner.id, ownerUserId: owner.id },
    select: { id: true },
  });
  const journey = async (name: string) =>
    db.journey.create({
      data: {
        name: `${TAG} ${name}`,
        trigger: "MANUAL",
        status: "ACTIVE",
        createdById: owner.id,
        steps: {
          create: [
            { order: 1, delayDays: 0, channel: "TASK", taskTitle: `${name} — call {{companyName}}`, taskAssignee: "OWNER" },
            { order: 2, delayDays: 3, channel: "TASK", taskTitle: `${name} — follow up`, taskAssignee: "OWNER" },
          ],
        },
      },
      select: { id: true },
    });
  const paused = await journey("Paused");
  const running = await journey("Running");
  const enrol = (journeyId: string) =>
    db.journeyEnrolment.create({
      data: { journeyId, companyId: company.id, triggerKey: `${TAG}:${journeyId}`, currentStep: 0, nextRunAt: new Date(Date.now() - 60_000) },
      select: { id: true },
    });
  const held = await enrol(paused.id);
  const moving = await enrol(running.id);
  const enrolment = (id: string) => db.journeyEnrolment.findUniqueOrThrow({ where: { id } });
  const tasks = (title: string) => db.task.count({ where: { title: { startsWith: title } } });
  ok("both due now", (await db.journeyEnrolment.count({ where: { nextRunAt: { lte: new Date() } } })) === 2);

  section("Paused");
  const pause = await setJourneyStatus(paused.id, "PAUSED");
  ok("the journey pauses", pause.ok, pause.ok ? "" : pause.error);
  const heldBefore = await enrolment(held.id);
  const first = await advanceEnrolments("http://localhost:3000");
  ok("a run steps only the running journey", first.stepped === 1 && first.tasks === 1, JSON.stringify(first));
  ok("  which made its first task", (await tasks("Running — call")) === 1);
  ok("  and the paused one made nothing", (await tasks("Paused")) === 0);
  const heldAfter = await enrolment(held.id);
  ok(
    "  its person is where they were, still in it",
    heldAfter.status === "ACTIVE" && heldAfter.currentStep === 0 && heldAfter.nextRunAt?.getTime() === heldBefore.nextRunAt?.getTime(),
    `${heldAfter.status} at step ${heldAfter.currentStep}`,
  );
  const movingAfter = await enrolment(moving.id);
  ok(
    "the running one is at step 1, the next three days off",
    movingAfter.currentStep === 1 && Math.abs((movingAfter.nextRunAt?.getTime() ?? 0) - (Date.now() + 3 * DAY)) < 5 * 60_000,
    `${movingAfter.currentStep}, ${movingAfter.nextRunAt?.toISOString()}`,
  );
  const again = await advanceEnrolments("http://localhost:3000");
  ok("  and a second run has nothing to do", again.stepped === 0 && again.tasks === 0, JSON.stringify(again));

  section("Started again");
  const start = await setJourneyStatus(paused.id, "ACTIVE");
  ok("the journey starts", start.ok, start.ok ? "" : start.error);
  const resumed = await advanceEnrolments("http://localhost:3000");
  ok("its person carries on from their step", resumed.stepped === 1 && (await tasks("Paused — call")) === 1, JSON.stringify(resumed));
  const after = await enrolment(held.id);
  ok(
    "  and the wait after it counts from now",
    after.currentStep === 1 && Math.abs((after.nextRunAt?.getTime() ?? 0) - (Date.now() + 3 * DAY)) < 5 * 60_000,
    after.nextRunAt?.toISOString(),
  );

  section("Draft");
  await db.journeyEnrolment.update({ where: { id: moving.id }, data: { nextRunAt: new Date(Date.now() - 60_000) } });
  await db.journey.update({ where: { id: running.id }, data: { status: "DRAFT" } });
  const drafted = await advanceEnrolments("http://localhost:3000");
  ok("a journey back in draft holds its people too", drafted.stepped === 0 && (await tasks("Running — follow up")) === 0, JSON.stringify(drafted));
  ok("  without exiting them", (await enrolment(moving.id)).status === "ACTIVE");

  section("Archived");
  const archive = await setJourneyStatus(running.id, "ARCHIVED");
  ok("the journey archives", archive.ok, archive.ok ? "" : archive.error);
  const archived = await enrolment(moving.id);
  ok(
    "whoever was in it has left, saying why",
    archived.status === "EXITED" && archived.exitReason === "The journey was archived" && archived.nextRunAt === null && archived.exitedAt !== null,
    `${archived.status}: ${archived.exitReason}`,
  );
  ok("  the paused-then-started journey's person is untouched", (await enrolment(held.id)).status === "ACTIVE");
  const audit = await db.auditLog.findFirst({ where: { entityId: running.id }, orderBy: { createdAt: "desc" }, select: { entityLabel: true } });
  ok("  and the audit says how many it stopped", /archived, 1 still in it stopped$/.test(audit?.entityLabel ?? ""), audit?.entityLabel);
  await setJourneyStatus(running.id, "ACTIVE");
  const woken = await advanceEnrolments("http://localhost:3000");
  ok("starting it again wakes nobody", woken.stepped === 0 && (await tasks("Running — follow up")) === 0, JSON.stringify(woken));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
