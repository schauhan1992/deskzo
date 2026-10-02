/**
 * fix:typed-times — times typed into forms before the India-time fix (owner, 2 Oct 2026), moved to the
 * moment the person meant. A dry run unless --apply.
 *
 * Before the fix a time typed into a form ("3:00 pm") was read in the server's own time zone. The live
 * servers run in UTC, so it was saved as 3:00 pm UTC — 8:30 pm in India, five and a half hours late:
 *   · a visit's planned time;
 *   · a call's callback, and the task raised for it;
 *   · an expected visitor's time;
 *   · and on every server, whatever its zone, an attendance correction's times, which were read as
 *     UTC outright — with the attendance day an approved one wrote.
 * A campaign's "Not before" was read the same way from the campaign editor but correctly from the
 * mass-mail wizard, and nothing tells the two apart afterwards: those are listed to check by hand.
 *
 * Only what was saved before the fix went live moves: by default the moment this release's first
 * migration started in that workspace (Coolify runs the migrations as the new code starts), or --before.
 * Left alone and listed: a visit changed since then, a visit with a date and no time (an import, most
 * likely), a callback's task or an attendance day edited since. It is done once: the audit log keeps
 * the record, and a second run says so.
 *
 *   npm run fix:typed-times                          every workspace, a dry run: what would move, and why
 *   npm run fix:typed-times -- --apply               the same, done
 *   npm run fix:typed-times -- --only acme,globex    just these workspaces
 *   npm run fix:typed-times -- --before 2026-10-02T21:40:00+05:30
 *                                                    a different moment the fix went live
 */
import "dotenv/config";
import type { Prisma, PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import { formatIstDate, formatIstDateTime } from "../src/lib/india-time";
import { formatVisitId } from "../src/lib/visits";

/** The first migration of the release that brought the fix: when it started is when the fix went live. */
export const RELEASE_MIGRATION = "20261018100000_workplace_sign_in_and_mail";
/** The audit log's record that this workspace's times were moved. */
export const FIX_ID = "typed-times-2026-10";
const IST_MINUTES = 330;

type Kind = "visit" | "callback" | "task" | "visitor" | "correction" | "attendance" | "campaign";
export type Move = { kind: Kind; id: string; what: string; field: string; from: Date; to: Date };
export type Held = { kind: Kind; id: string; what: string; at: Date | null; why: string };
export type Plan = { cutoff: Date; done: Date | null; moves: Move[]; held: Held[] };

/**
 * Minutes to add to a time typed on this server, to reach the moment meant: it was read in the server's
 * zone, not India's. −330 on a UTC server; 0 on one that runs on India time, where only the attendance
 * corrections went wrong.
 */
export type ServerShift = (at: Date) => number;
export const thisServer: ServerShift = (at) => -at.getTimezoneOffset() - IST_MINUTES;

const moved = (at: Date, minutes: number) => new Date(at.getTime() + minutes * 60_000);
const sameMoment = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);
/** A date with no time, as the visit importer saves one on a UTC server. */
const midnightUtc = (at: Date) => at.getTime() % 86_400_000 === 0;

/** When the fix went live in this workspace: its release's first migration, as Prisma recorded it. Null before it. */
export async function fixWentLive(db: PrismaClient): Promise<Date | null> {
  const rows = await db.$queryRaw<{ started_at: Date }[]>`
    SELECT started_at FROM "_prisma_migrations"
    WHERE migration_name = ${RELEASE_MIGRATION} AND finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  return rows[0]?.started_at ?? null;
}

/** What would move, and what is left for a person to check. Reads only. */
export async function planTypedTimesFix(db: PrismaClient, cutoff: Date, shift: ServerShift = thisServer): Promise<Plan> {
  const done = await db.auditLog.findFirst({ where: { entityType: "DataFix", entityId: FIX_ID }, select: { createdAt: true } });
  const plan: Plan = { cutoff, done: done?.createdAt ?? null, moves: [], held: [] };
  if (done) return plan;
  const before = { lt: cutoff };

  // Visits: the planned time, from the visit form.
  const visits = await db.visit.findMany({
    where: { createdAt: before },
    orderBy: { scheduledFor: "asc" },
    select: { id: true, visitSeq: true, scheduledFor: true, updatedAt: true, company: { select: { name: true } }, user: { select: { name: true } } },
  });
  for (const v of visits) {
    const minutes = shift(v.scheduledFor);
    if (minutes === 0) continue;
    const what = `${formatVisitId(v.visitSeq)} — ${v.company.name}, ${v.user.name}`;
    if (v.updatedAt >= cutoff) plan.held.push({ kind: "visit", id: v.id, what, at: v.scheduledFor, why: "changed since the fix went live — check its time" });
    else if (midnightUtc(v.scheduledFor)) plan.held.push({ kind: "visit", id: v.id, what, at: v.scheduledFor, why: "a date with no time — an import, most likely; left as it is" });
    else plan.moves.push({ kind: "visit", id: v.id, what, field: "scheduledFor", from: v.scheduledFor, to: moved(v.scheduledFor, minutes) });
  }

  // Callbacks, and the task each raised — that one only while it still says the same time.
  const calls = await db.callLog.findMany({
    where: { createdAt: before, followUpAt: { not: null } },
    orderBy: { followUpAt: "asc" },
    select: {
      id: true,
      followUpAt: true,
      company: { select: { name: true } },
      user: { select: { name: true } },
      followUpTask: { select: { id: true, title: true, dueDate: true } },
    },
  });
  for (const c of calls) {
    const at = c.followUpAt!;
    const minutes = shift(at);
    if (minutes === 0) continue;
    plan.moves.push({ kind: "callback", id: c.id, what: `${c.company.name}, ${c.user.name}`, field: "followUpAt", from: at, to: moved(at, minutes) });
    const task = c.followUpTask;
    if (!task?.dueDate) continue;
    if (sameMoment(task.dueDate, at)) plan.moves.push({ kind: "task", id: task.id, what: task.title, field: "dueDate", from: task.dueDate, to: moved(task.dueDate, minutes) });
    else plan.held.push({ kind: "task", id: task.id, what: task.title, at: task.dueDate, why: "its due time was changed after the call — check it" });
  }

  // Expected visitors.
  const invites = await db.visitorInvite.findMany({
    where: { createdAt: before },
    orderBy: { expectedAt: "asc" },
    select: { id: true, name: true, expectedAt: true },
  });
  for (const i of invites) {
    const minutes = shift(i.expectedAt);
    if (minutes !== 0) plan.moves.push({ kind: "visitor", id: i.id, what: i.name, field: "expectedAt", from: i.expectedAt, to: moved(i.expectedAt, minutes) });
  }

  // Attendance corrections: read as UTC outright, on every server.
  const corrections = await db.attendanceRegularisation.findMany({
    where: { createdAt: before, OR: [{ requestedCheckIn: { not: null } }, { requestedCheckOut: { not: null } }] },
    orderBy: [{ decidedAt: "asc" }, { createdAt: "asc" }],
    select: { id: true, userId: true, date: true, status: true, requestedCheckIn: true, requestedCheckOut: true, user: { select: { name: true } } },
  });
  for (const r of corrections) {
    const what = `${r.user.name}, ${formatIstDate(r.date)}`;
    if (r.requestedCheckIn) plan.moves.push({ kind: "correction", id: r.id, what, field: "requestedCheckIn", from: r.requestedCheckIn, to: moved(r.requestedCheckIn, -IST_MINUTES) });
    if (r.requestedCheckOut) plan.moves.push({ kind: "correction", id: r.id, what, field: "requestedCheckOut", from: r.requestedCheckOut, to: moved(r.requestedCheckOut, -IST_MINUTES) });
  }
  // The day an approved one wrote, while it still holds those times. A day a later correction wrote —
  // made after the fix, so right — is that one's, not this one's.
  const dayKey = (r: { userId: string; date: Date }) => `${r.userId}|${r.date.toISOString()}`;
  const rewrittenSince = new Set(
    (await db.attendanceRegularisation.findMany({ where: { status: "APPROVED", createdAt: { gte: cutoff } }, select: { userId: true, date: true } })).map(dayKey),
  );
  const lastApproved = new Map<string, (typeof corrections)[number]>();
  for (const r of corrections) if (r.status === "APPROVED") lastApproved.set(dayKey(r), r);
  for (const [key, r] of lastApproved) {
    if (rewrittenSince.has(key)) continue;
    const day = await db.attendanceDay.findUnique({ where: { userId_date: { userId: r.userId, date: r.date } }, select: { id: true, checkInAt: true, checkOutAt: true } });
    if (!day) continue;
    const what = `${r.user.name}, ${formatIstDate(r.date)}`;
    if (!sameMoment(day.checkInAt, r.requestedCheckIn) || !sameMoment(day.checkOutAt, r.requestedCheckOut)) {
      plan.held.push({ kind: "attendance", id: day.id, what, at: day.checkInAt, why: "its times changed after the correction was approved — check them" });
      continue;
    }
    if (day.checkInAt) plan.moves.push({ kind: "attendance", id: day.id, what, field: "checkInAt", from: day.checkInAt, to: moved(day.checkInAt, -IST_MINUTES) });
    if (day.checkOutAt) plan.moves.push({ kind: "attendance", id: day.id, what, field: "checkOutAt", from: day.checkOutAt, to: moved(day.checkOutAt, -IST_MINUTES) });
  }

  // Campaigns still to run: the editor's "Not before" is late, the wizard's is right, and they look alike.
  const campaigns = await db.campaign.findMany({
    where: { createdAt: before, scheduledFor: { not: null }, status: { in: ["DRAFT", "PENDING_APPROVAL", "SCHEDULED", "PAUSED"] } },
    orderBy: { scheduledFor: "asc" },
    select: { id: true, reference: true, name: true, scheduledFor: true },
  });
  for (const c of campaigns) {
    if (shift(c.scheduledFor!) === 0) continue;
    plan.held.push({
      kind: "campaign",
      id: c.id,
      what: `${c.reference} — ${c.name}`,
      at: c.scheduledFor,
      why: "5½ hours late if its start time was set in the campaign editor, right if in the mass-mail wizard — check it",
    });
  }
  return plan;
}

/** Moves each one only while it still says what the plan read, and records the fix. One transaction. */
export async function applyTypedTimesFix(db: PrismaClient, plan: Plan): Promise<{ moved: number; changedMeanwhile: Move[] }> {
  if (plan.done) throw new Error(`These times were already moved, on ${formatIstDateTime(plan.done)}.`);
  const owner = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!owner) throw new Error("This workspace has no super admin to record the fix against.");
  return db.$transaction(
    async (tx) => {
      // Asked again inside, under a lock: a plan read before an earlier run, or two runs at once, must not
      // both go through.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${FIX_ID}))`;
      const already = await tx.auditLog.findFirst({ where: { entityType: "DataFix", entityId: FIX_ID }, select: { createdAt: true } });
      if (already) throw new Error(`These times were already moved, on ${formatIstDateTime(already.createdAt)}.`);
      const changedMeanwhile: Move[] = [];
      for (const m of plan.moves) if ((await moveOne(tx, m)) === 0) changedMeanwhile.push(m);
      const count = plan.moves.length - changedMeanwhile.length;
      await tx.auditLog.create({
        data: {
          userId: owner.id,
          action: "UPDATE",
          entityType: "DataFix",
          entityId: FIX_ID,
          entityLabel: `Times typed before the India-time fix moved to the moment meant — ${count} change(s) (scripts/fix-typed-times.ts)`,
        },
      });
      return { moved: count, changedMeanwhile };
    },
    { maxWait: 20_000, timeout: 300_000 },
  );
}

async function moveOne(tx: Prisma.TransactionClient, m: Move): Promise<number> {
  const { id, from, to } = m;
  switch (`${m.kind}.${m.field}`) {
    case "visit.scheduledFor":
      return (await tx.visit.updateMany({ where: { id, scheduledFor: from }, data: { scheduledFor: to } })).count;
    case "callback.followUpAt":
      return (await tx.callLog.updateMany({ where: { id, followUpAt: from }, data: { followUpAt: to } })).count;
    case "task.dueDate":
      return (await tx.task.updateMany({ where: { id, dueDate: from }, data: { dueDate: to } })).count;
    case "visitor.expectedAt":
      return (await tx.visitorInvite.updateMany({ where: { id, expectedAt: from }, data: { expectedAt: to } })).count;
    case "correction.requestedCheckIn":
      return (await tx.attendanceRegularisation.updateMany({ where: { id, requestedCheckIn: from }, data: { requestedCheckIn: to } })).count;
    case "correction.requestedCheckOut":
      return (await tx.attendanceRegularisation.updateMany({ where: { id, requestedCheckOut: from }, data: { requestedCheckOut: to } })).count;
    case "attendance.checkInAt":
      return (await tx.attendanceDay.updateMany({ where: { id, checkInAt: from }, data: { checkInAt: to } })).count;
    case "attendance.checkOutAt":
      return (await tx.attendanceDay.updateMany({ where: { id, checkOutAt: from }, data: { checkOutAt: to } })).count;
    default:
      throw new Error(`Nothing moves ${m.kind}.${m.field}.`);
  }
}

const HEADINGS: Record<Kind, string> = {
  visit: "Visits — the planned time",
  callback: "Callbacks",
  task: "Callback tasks — the due time",
  visitor: "Expected visitors",
  correction: "Attendance corrections — the times asked for",
  attendance: "Attendance days an approved correction wrote",
  campaign: "Campaigns",
};

/** The plan, as a person reads it: every change in India time, then what is left to check. */
export function describe(plan: Plan): string[] {
  if (plan.done) return [`  Already moved on ${formatIstDateTime(plan.done)} — nothing to do.`];
  const lines: string[] = [];
  for (const kind of Object.keys(HEADINGS) as Kind[]) {
    const moves = plan.moves.filter((m) => m.kind === kind);
    if (moves.length === 0) continue;
    lines.push(`  ${HEADINGS[kind]}: ${moves.length}`);
    for (const m of moves) lines.push(`    ${m.what} — ${formatIstDateTime(m.from)} → ${formatIstDateTime(m.to)}`);
  }
  if (plan.moves.length === 0) lines.push("  Nothing to move.");
  if (plan.held.length > 0) {
    lines.push(`  Left as they are — check by hand: ${plan.held.length}`);
    for (const h of plan.held) lines.push(`    ${HEADINGS[h.kind]}: ${h.what}${h.at ? ` (${formatIstDateTime(h.at)})` : ""} — ${h.why}`);
  }
  return lines;
}

function valueOf(args: string[], name: string): string | null {
  const inline = args.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const at = args.indexOf(name);
  return at >= 0 ? (args[at + 1] ?? "") : null;
}

/** The command line: --apply, --only a,b, --before <a moment with its zone>. Throws on anything unclear. */
export function readOptions(args: string[]): { apply: boolean; only: string[] | null; before: Date | null } {
  const onlyArg = valueOf(args, "--only");
  const only = onlyArg === null ? null : onlyArg.split(",").map((s) => s.trim()).filter(Boolean);
  if (only && only.length === 0) throw new Error("Name the workspaces after --only: --only acme,globex");
  const beforeArg = valueOf(args, "--before");
  // With its zone, always: a bare time here would be read in this server's zone — the very mistake being mended.
  if (beforeArg !== null && !/(Z|[+-]\d\d:?\d\d)$/i.test(beforeArg.trim())) throw new Error("Give --before with its zone: --before 2026-10-02T21:40:00+05:30");
  const before = beforeArg === null ? null : new Date(beforeArg);
  if (before && Number.isNaN(before.getTime())) throw new Error(`--before ${beforeArg} isn't a date.`);
  return { apply: args.includes("--apply"), only, before };
}

async function main() {
  const { apply, only, before } = readOptions(process.argv.slice(2));
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const shift = thisServer(new Date());
  console.log(apply ? "Moving the times typed before the India-time fix." : "A dry run — nothing is changed.");
  console.log(
    shift === 0
      ? `This server runs on ${zone}, so only attendance corrections were read wrongly here.`
      : `This server runs on ${zone}: a time typed here was saved ${Math.abs(shift) / 60} hours ${shift < 0 ? "late" : "early"}.`,
  );

  const { activeTenants } = await import("../src/lib/tenancy/registry");
  const all = await activeTenants();
  const tenants = only ? all.filter((t) => only.includes(t.slug)) : all;
  for (const slug of only ?? []) if (!all.some((t) => t.slug === slug)) console.log(`\nNo active workspace is called "${slug}".`);

  let total = 0;
  for (const tenant of tenants) {
    if (!tenant.dbUrl) {
      console.log(`\n${tenant.slug}: no database yet.`);
      continue;
    }
    const db = directClient(tenant.dbUrl, { max: 2 });
    try {
      const cutoff = before ?? (await fixWentLive(db));
      if (!cutoff) {
        console.log(`\n${tenant.slug}: the fix isn't on this workspace yet — run its migrations first.`);
        continue;
      }
      const plan = await planTypedTimesFix(db, cutoff);
      console.log(`\n${tenant.slug} — the fix went live ${formatIstDateTime(cutoff)}`);
      for (const line of describe(plan)) console.log(line);
      total += plan.moves.length;
      if (apply && !plan.done && plan.moves.length > 0) {
        const result = await applyTypedTimesFix(db, plan);
        console.log(`  Moved: ${result.moved}.`);
        for (const m of result.changedMeanwhile) console.log(`  Not moved — it changed while this ran: ${HEADINGS[m.kind]}: ${m.what}`);
      }
    } finally {
      await db.$disconnect();
    }
  }
  if (!apply) console.log(total > 0 ? "\nNothing was changed. To make these changes, run it again with --apply." : "\nNothing to change.");
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
