/**
 * check:typed-times-fix — scripts/fix-typed-times.ts, which moves the times typed into forms before the
 * India-time fix to the moment the person meant (owner, 2 Oct 2026).
 *
 * It builds a scratch workspace database beside the real one, fills it the way the old code did on a
 * server running in UTC, as production does — a form's "3:00 pm" saved as 3:00 pm UTC — and proves:
 *
 *   · what moves: a visit's planned time, a callback and its task, an expected visitor, an attendance
 *     correction's times and the day an approved one wrote — each five and a half hours earlier;
 *   · what is left and listed: a visit changed since the fix went live, a visit with a date and no time
 *     (an import), a callback task edited since, an attendance day changed since, a campaign still to
 *     run (its editor and the mass-mail wizard can't be told apart);
 *   · what is never touched: anything saved after the fix went live; a day a later correction wrote;
 *   · on a server that runs on India time, only the attendance corrections move;
 *   · the dry run changes nothing; applying moves each row only while it still says what was read,
 *     records the fix in the audit log, and a second run says it is done and refuses;
 *   · when the fix went live is read from the migrations, and --before must say its zone;
 *   · and the real workspace untouched.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import { FIX_ID, applyTypedTimesFix, describe, fixWentLive, planTypedTimesFix, readOptions, thisServer, type Plan } from "./fix-typed-times";

// As production runs. Node re-reads the zone when TZ is assigned; the first check confirms it took.
process.env.TZ = "UTC";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const iso = (at: Date | null | undefined) => at?.toISOString() ?? null;

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const TAG = "ZZTYPEDFIX";
/** When the fix went live, for the fixture. */
const CUTOFF = new Date("2026-10-02T16:00:00.000Z");
const beforeIt = (days: number) => new Date(CUTOFF.getTime() - days * 86_400_000);
const afterIt = (minutes: number) => new Date(CUTOFF.getTime() + minutes * 60_000);
const day = (date: string) => new Date(`${date}T00:00:00.000Z`);

async function main() {
  section("The process is in UTC, as production is");
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  ok("no offset, and Intl agrees", new Date(2026, 9, 5, 10, 0).getTimezoneOffset() === 0 && (zone === "UTC" || zone === "Etc/UTC"), zone);
  ok("  so a time typed here was saved five and a half hours late: it moves 330 minutes back", thisServer(new Date()) === -330);

  section("The command line");
  ok("a dry run unless --apply", !readOptions([]).apply && readOptions(["--apply"]).apply);
  ok("  --only names workspaces, and naming none is refused", readOptions(["--only", "acme, globex"]).only?.join() === "acme,globex" && throws(() => readOptions(["--only", ""])));
  ok("  --before must say its zone — a bare one would be read in this server's zone, the very mistake", throws(() => readOptions(["--before", "2026-10-02T21:40"])));
  ok("  and with it, it is that moment", readOptions(["--before=2026-10-02T21:40:00+05:30"]).before?.toISOString() === "2026-10-02T16:10:00.000Z");

  const realUrl = process.env.DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);

  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_typedfix`;
  const scratchUrl = withDatabase(realUrl, scratchName);
  ok("  and it is not the real one", scratchName !== realName, scratchName);

  const real = directClient(realUrl, { max: 1 });
  const realBefore = await snapshotReal(real);
  const admin = directClient(withDatabase(realUrl, "postgres"), { max: 1 });
  let scratch: PrismaClient | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    const started = new Date();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60 * 1000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started.getTime()) / 1000)} s`);
    scratch = directClient(scratchUrl, { max: 2 });
    const live = await fixWentLive(scratch);
    ok("when the fix went live is when its release's first migration started", !!live && live >= new Date(started.getTime() - 1000) && live <= new Date(), iso(live));
    await run(scratch);
  } finally {
    await scratch?.$disconnect().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const gone = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratchName}'`);
    ok("the scratch database is dropped", Number(gone[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  section("The real workspace was not touched");
  const realAfter = await snapshotReal(real);
  await real.$disconnect();
  ok("its visits, callbacks, corrections and audit log are as they were", realAfter === realBefore, realAfter);

  console.log(failures === 0 ? `\nAll ${passes} typed-times fix checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

/** What the suite must never change in the real workspace. Read-only. */
async function snapshotReal(client: PrismaClient): Promise<string> {
  const [visits, calls, corrections, fixes, latestVisit] = await Promise.all([
    client.visit.count(),
    client.callLog.count(),
    client.attendanceRegularisation.count(),
    client.auditLog.count({ where: { entityType: "DataFix" } }),
    client.visit.findFirst({ orderBy: { updatedAt: "desc" }, select: { id: true, scheduledFor: true } }),
  ]);
  return JSON.stringify({ visits, calls, corrections, fixes, latestVisit });
}

async function run(db: PrismaClient) {
  // ── Fixture: saved as the old code saved it on a UTC server ────────────────────────────────────
  section("Fixture");
  const boss = await db.user.create({ data: { name: `${TAG} Boss`, email: `${TAG.toLowerCase()}-boss@example.test`, passwordHash: "!", role: "ADMIN", isSuperAdmin: true } });
  const rep = await db.user.create({ data: { name: `${TAG} Rep`, email: `${TAG.toLowerCase()}-rep@example.test`, passwordHash: "!", role: "SALES" } });
  const company = await db.company.create({ data: { name: `${TAG} Sunrise Towers`, normalizedName: `${TAG} sunrise towers`.toLowerCase(), createdById: rep.id, ownerUserId: rep.id } });

  const visit = async (scheduledFor: string, createdAt: Date, updatedAt: Date) => {
    const v = await db.visit.create({ data: { companyId: company.id, userId: rep.id, scheduledFor: new Date(scheduledFor) }, select: { id: true } });
    await db.$executeRawUnsafe(`UPDATE "visits" SET "createdAt" = $1, "updatedAt" = $2 WHERE id = $3`, createdAt, updatedAt, v.id);
    return v.id;
  };
  // "3:00 pm" typed, saved as 3:00 pm UTC.
  const vPlanned = await visit("2026-10-06T15:00:00.000Z", beforeIt(1), beforeIt(1));
  const vTouched = await visit("2026-10-01T11:00:00.000Z", beforeIt(2), afterIt(60));
  const vImported = await visit("2026-10-07T00:00:00.000Z", beforeIt(3), beforeIt(3));
  const vNew = await visit("2026-10-08T09:30:00.000Z", afterIt(5), afterIt(5));

  const callback = async (followUpAt: string, taskDue: string, createdAt: Date) => {
    const task = await db.task.create({
      data: { title: `${TAG} Call back`, dueDate: new Date(taskDue), assignedToUserId: rep.id, createdByUserId: rep.id, companyId: company.id },
      select: { id: true },
    });
    const call = await db.callLog.create({
      data: { companyId: company.id, userId: rep.id, phoneNumber: "+919800000001", outcome: "NO_ANSWER", startedAt: createdAt, followUpAt: new Date(followUpAt), followUpTaskId: task.id, createdAt },
      select: { id: true },
    });
    return { call: call.id, task: task.id };
  };
  const cOld = await callback("2026-10-06T16:00:00.000Z", "2026-10-06T16:00:00.000Z", beforeIt(1));
  const cTaskEdited = await callback("2026-10-06T17:00:00.000Z", "2026-10-09T05:00:00.000Z", beforeIt(1));
  const cNew = await callback("2026-10-07T04:30:00.000Z", "2026-10-07T04:30:00.000Z", afterIt(10));

  const invite = async (code: string, expectedAt: string, createdAt: Date) =>
    (await db.visitorInvite.create({ data: { code, hostUserId: rep.id, name: `${TAG} Ravi ${code}`, expectedAt: new Date(expectedAt), createdAt }, select: { id: true } })).id;
  const iOld = await invite("ZZTF01", "2026-10-06T10:00:00.000Z", beforeIt(1));
  const iEditedMeanwhile = await invite("ZZTF02", "2026-10-06T12:00:00.000Z", beforeIt(1));
  const iNew = await invite("ZZTF03", "2026-10-06T04:30:00.000Z", afterIt(15));

  const template = await db.marketingTemplate.create({ data: { name: `${TAG} offer`, body: "Hello", createdById: boss.id }, select: { id: true } });
  const campaign = async (reference: string, status: "SCHEDULED" | "SENT", createdAt: Date) =>
    (
      await db.campaign.create({
        data: { reference, name: `${TAG} ${status}`, templateId: template.id, createdById: boss.id, status, scheduledFor: new Date("2026-10-10T09:00:00.000Z"), createdAt },
        select: { id: true },
      })
    ).id;
  const campScheduled = await campaign(`${TAG}-1`, "SCHEDULED", beforeIt(1));
  const campSent = await campaign(`${TAG}-2`, "SENT", beforeIt(1));

  // "09:30" and "18:00" typed for a day, saved as UTC outright — on any server.
  const correction = async (date: string, checkIn: string, checkOut: string, status: "PENDING" | "APPROVED", createdAt: Date) =>
    (
      await db.attendanceRegularisation.create({
        data: {
          userId: rep.id,
          date: day(date),
          requestedStatus: "PRESENT",
          reason: `${TAG} forgot to clock in`,
          requestedCheckIn: new Date(`${date}T${checkIn}:00.000Z`),
          requestedCheckOut: new Date(`${date}T${checkOut}:00.000Z`),
          status,
          ...(status === "APPROVED" ? { approverId: boss.id, decidedAt: new Date(createdAt.getTime() + 3_600_000) } : {}),
          createdAt,
        },
        select: { id: true },
      })
    ).id;
  const attendance = async (date: string, checkInAt: string, checkOutAt: string) =>
    (await db.attendanceDay.create({ data: { userId: rep.id, date: day(date), status: "PRESENT", checkInAt: new Date(checkInAt), checkOutAt: new Date(checkOutAt) }, select: { id: true } })).id;
  const rPending = await correction("2026-10-01", "09:30", "18:00", "PENDING", beforeIt(1));
  const rApproved = await correction("2026-09-30", "10:00", "19:00", "APPROVED", beforeIt(2));
  const dApproved = await attendance("2026-09-30", "2026-09-30T10:00:00.000Z", "2026-09-30T19:00:00.000Z");
  const rDayChanged = await correction("2026-09-29", "10:00", "19:00", "APPROVED", beforeIt(3));
  const dChanged = await attendance("2026-09-29", "2026-09-29T03:45:00.000Z", "2026-09-29T19:00:00.000Z");
  // Approved before the fix, then corrected again after it — by the fixed code, so the day is right.
  const rRewritten = await correction("2026-09-28", "10:00", "19:00", "APPROVED", beforeIt(4));
  await db.attendanceRegularisation.create({
    data: {
      userId: rep.id,
      date: day("2026-09-28"),
      requestedStatus: "PRESENT",
      reason: `${TAG} again`,
      requestedCheckIn: new Date("2026-09-28T04:30:00.000Z"),
      requestedCheckOut: new Date("2026-09-28T13:30:00.000Z"),
      status: "APPROVED",
      approverId: boss.id,
      decidedAt: afterIt(30),
      createdAt: afterIt(20),
    },
  });
  const dRewritten = await attendance("2026-09-28", "2026-09-28T04:30:00.000Z", "2026-09-28T13:30:00.000Z");
  const rNew = await correction("2026-10-02", "09:00", "17:00", "PENDING", afterIt(25));
  ok("a boss, a rep, visits, callbacks, visitors, campaigns and attendance corrections, either side of the fix", true);

  /** Every time the fixture holds, read fresh. */
  const times = async () => {
    const [visits, calls, tasks, invites, camps, corrections, days] = await Promise.all([
      db.visit.findMany({ select: { id: true, scheduledFor: true } }),
      db.callLog.findMany({ select: { id: true, followUpAt: true } }),
      db.task.findMany({ select: { id: true, dueDate: true } }),
      db.visitorInvite.findMany({ select: { id: true, expectedAt: true } }),
      db.campaign.findMany({ select: { id: true, scheduledFor: true } }),
      db.attendanceRegularisation.findMany({ select: { id: true, requestedCheckIn: true, requestedCheckOut: true } }),
      db.attendanceDay.findMany({ select: { id: true, checkInAt: true, checkOutAt: true } }),
    ]);
    const all = new Map<string, string | null>();
    for (const v of visits) all.set(`visit ${v.id}`, iso(v.scheduledFor));
    for (const c of calls) all.set(`call ${c.id}`, iso(c.followUpAt));
    for (const t of tasks) all.set(`task ${t.id}`, iso(t.dueDate));
    for (const i of invites) all.set(`invite ${i.id}`, iso(i.expectedAt));
    for (const c of camps) all.set(`campaign ${c.id}`, iso(c.scheduledFor));
    for (const r of corrections) all.set(`correction ${r.id}`, `${iso(r.requestedCheckIn)} ${iso(r.requestedCheckOut)}`);
    for (const d of days) all.set(`day ${d.id}`, `${iso(d.checkInAt)} ${iso(d.checkOutAt)}`);
    return all;
  };
  const moveOf = (plan: Plan, id: string, field: string) => plan.moves.find((m) => m.id === id && m.field === field);
  const heldOf = (plan: Plan, id: string) => plan.held.find((h) => h.id === id);
  const named = (plan: Plan, id: string) => plan.moves.some((m) => m.id === id) || !!heldOf(plan, id);

  // ── The dry run ────────────────────────────────────────────────────────────────────────────────
  section("The dry run");
  const original = await times();
  const plan = await planTypedTimesFix(db, CUTOFF);
  ok(
    "a visit planned for 3:00 pm, saved as 3:00 pm UTC, moves to 3:00 pm India time",
    iso(moveOf(plan, vPlanned, "scheduledFor")?.to) === "2026-10-06T09:30:00.000Z",
    moveOf(plan, vPlanned, "scheduledFor"),
  );
  ok("  one changed since the fix went live is left, and listed to check", !plan.moves.some((m) => m.id === vTouched) && /changed since the fix went live/.test(heldOf(plan, vTouched)?.why ?? ""));
  ok("  one with a date and no time — an import — is left, and listed", !plan.moves.some((m) => m.id === vImported) && /date with no time/.test(heldOf(plan, vImported)?.why ?? ""));
  ok(
    "a callback moves, and the task it raised with it",
    iso(moveOf(plan, cOld.call, "followUpAt")?.to) === "2026-10-06T10:30:00.000Z" && iso(moveOf(plan, cOld.task, "dueDate")?.to) === "2026-10-06T10:30:00.000Z",
  );
  ok(
    "  a task whose due time was edited since stays, and is listed — its callback still moves",
    !!moveOf(plan, cTaskEdited.call, "followUpAt") && !moveOf(plan, cTaskEdited.task, "dueDate") && /changed after the call/.test(heldOf(plan, cTaskEdited.task)?.why ?? ""),
  );
  ok("an expected visitor at 10:00 moves to 10:00 India time", iso(moveOf(plan, iOld, "expectedAt")?.to) === "2026-10-06T04:30:00.000Z");
  ok(
    "an attendance correction's 9:30 to 6:00 pm move to India time",
    iso(moveOf(plan, rPending, "requestedCheckIn")?.to) === "2026-10-01T04:00:00.000Z" && iso(moveOf(plan, rPending, "requestedCheckOut")?.to) === "2026-10-01T12:30:00.000Z",
  );
  ok(
    "  and the day an approved one wrote moves with it",
    iso(moveOf(plan, dApproved, "checkInAt")?.to) === "2026-09-30T04:30:00.000Z" && iso(moveOf(plan, dApproved, "checkOutAt")?.to) === "2026-09-30T13:30:00.000Z" && !!moveOf(plan, rApproved, "requestedCheckIn"),
  );
  ok(
    "  a day whose times changed since stays, and is listed — the correction itself still moves",
    !plan.moves.some((m) => m.id === dChanged) && /changed after the correction/.test(heldOf(plan, dChanged)?.why ?? "") && !!moveOf(plan, rDayChanged, "requestedCheckIn"),
  );
  ok("  a day a later correction wrote — after the fix, so right — is that one's: neither moved nor listed", !named(plan, dRewritten) && !!moveOf(plan, rRewritten, "requestedCheckOut"));
  ok("a campaign still to run is listed to check, not moved — the editor and the wizard look alike", !plan.moves.some((m) => m.id === campScheduled) && /campaign editor/.test(heldOf(plan, campScheduled)?.why ?? ""));
  ok("  one already sent is history, and left out", !named(plan, campSent));
  ok(
    "nothing saved after the fix went live is named",
    [vNew, cNew.call, cNew.task, iNew, rNew].every((id) => !named(plan, id)),
  );
  ok("sixteen moves and five to check, all told", plan.moves.length === 16 && plan.held.length === 5, { moves: plan.moves.length, held: plan.held.length });
  const said = describe(plan).join("\n");
  ok(
    "the report says each in India time, before and after",
    said.includes("8:30 pm → ") && said.includes("3:00 pm") && said.includes("VIS-") && said.includes("Left as they are — check by hand: 5"),
    said.split("\n").slice(0, 3),
  );
  const unchanged = await times();
  ok("the dry run changed nothing", [...original].every(([k, v]) => unchanged.get(k) === v));

  section("On a server that runs on India time");
  const indiaPlan = await planTypedTimesFix(db, CUTOFF, () => 0);
  ok(
    "only the attendance corrections move — the forms were read right there",
    indiaPlan.moves.every((m) => m.kind === "correction" || m.kind === "attendance") && indiaPlan.moves.length === 10 && indiaPlan.held.length === 1,
    { moves: indiaPlan.moves.length, held: indiaPlan.held.map((h) => h.kind) },
  );
  ok(
    "  and they move five and a half hours there too — they were read as UTC outright, on any server",
    iso(moveOf(indiaPlan, rPending, "requestedCheckIn")?.to) === "2026-10-01T04:00:00.000Z" && iso(moveOf(indiaPlan, dApproved, "checkInAt")?.to) === "2026-09-30T04:30:00.000Z",
  );

  // ── Applying ───────────────────────────────────────────────────────────────────────────────────
  section("Applying");
  // Somebody fixes one by hand between the dry run's read and the move.
  await db.visitorInvite.update({ where: { id: iEditedMeanwhile }, data: { expectedAt: new Date("2026-10-06T06:30:00.000Z") } });
  const meanwhile = plan.moves.find((m) => m.id === iEditedMeanwhile);
  const result = await applyTypedTimesFix(db, plan);
  const after = await times();
  ok(
    "each moves only while it still says what was read: one changed meanwhile is left as its person set it",
    !!meanwhile && result.changedMeanwhile.length === 1 && result.changedMeanwhile[0]?.id === iEditedMeanwhile && after.get(`invite ${iEditedMeanwhile}`) === "2026-10-06T06:30:00.000Z",
    result.changedMeanwhile.map((m) => m.what),
  );
  ok("the other fifteen moved", result.moved === 15, result.moved);
  ok(
    "  the visit, the callback and its task, the visitor, the correction and its day — at the moments meant",
    after.get(`visit ${vPlanned}`) === "2026-10-06T09:30:00.000Z" &&
      after.get(`call ${cOld.call}`) === "2026-10-06T10:30:00.000Z" &&
      after.get(`task ${cOld.task}`) === "2026-10-06T10:30:00.000Z" &&
      after.get(`invite ${iOld}`) === "2026-10-06T04:30:00.000Z" &&
      after.get(`correction ${rPending}`) === "2026-10-01T04:00:00.000Z 2026-10-01T12:30:00.000Z" &&
      after.get(`day ${dApproved}`) === "2026-09-30T04:30:00.000Z 2026-09-30T13:30:00.000Z",
  );
  ok(
    "  what was listed to check, and everything after the fix, as it was",
    [`visit ${vTouched}`, `visit ${vImported}`, `task ${cTaskEdited.task}`, `day ${dChanged}`, `day ${dRewritten}`, `campaign ${campScheduled}`, `visit ${vNew}`, `call ${cNew.call}`, `invite ${iNew}`, `correction ${rNew}`].every(
      (k) => after.get(k) === original.get(k),
    ),
  );
  const record = await db.auditLog.findFirst({ where: { entityType: "DataFix", entityId: FIX_ID }, select: { userId: true, entityLabel: true } });
  ok("the audit log records it, against the super admin", record?.userId === boss.id && /15 change/.test(record.entityLabel), record?.entityLabel);

  section("A second run");
  const again = await planTypedTimesFix(db, CUTOFF);
  ok("says it is done, and moves nothing", !!again.done && again.moves.length === 0 && describe(again)[0]?.includes("Already moved") === true, describe(again));
  let refused = "";
  try {
    await applyTypedTimesFix(db, plan);
  } catch (err) {
    refused = (err as Error).message;
  }
  ok("  and applying the old plan again is refused", /already moved/.test(refused), refused);
  ok("  so nothing moved twice", (await db.visit.findUniqueOrThrow({ where: { id: vPlanned }, select: { scheduledFor: true } })).scheduledFor.toISOString() === "2026-10-06T09:30:00.000Z");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
