/**
 * check:close — the month-end close engine (Revenue & Close, spec §4–§5), against a real database that
 * is not the owner's.
 *
 * Builds a scratch workspace database beside the real one (migrated from scratch, as check:ledger-close
 * does), runs everything as a workspace pointed at it (`runAsTenant`), and drops it at the end, pass or
 * fail. Nothing here moves the real lock or posts into the real books; the last section reads the real
 * database before and after to prove it.
 *
 *   · the default templates seeded once, and a deleted one never seeded back;
 *   · a month's checklist generated once, due on working days in India;
 *   · every automatic check failing on a fixture of its own and passing once it is put right —
 *     receivables tied to the ledger through a manual journal, a line with no party, an unapplied
 *     receipt, a USD invoice and a document whose entry disagrees; payables the same way;
 *   · prepaids (the reclass, the months, an edit, a stop) and accruals (the month and its reversal on
 *     the 1st), a closed month's share caught up into the first open one, and two runs at once
 *     posting once;
 *   · flux flagged at both thresholds, and the explanations passing the task;
 *   · the automation ticking and unticking only its own ticks, never a person's;
 *   · closing refused with an open task, then with a written reason; in order only; the lock at the
 *     month end through the shared lock path; reopening cascading;
 *   · the nightly job claimed once a day under two concurrent calls; owners told once; the job
 *     skipped with the add-on off, but running schedules still posted;
 *   · permissions, and the actions refusing a workspace whose plan leaves the add-on out.
 *
 * Dates are written with India's offset spelled out:
 *
 *   npm run check:close
 *   TZ=UTC npm run check:close
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const ist = (s: string) => new Date(`${s}+05:30`);
const utcDay = (y: number, m1: number, d: number) => new Date(Date.UTC(y, m1 - 1, d));
const round2 = (n: number) => Math.round(n * 100) / 100;
const json = (v: unknown) => JSON.stringify(v);

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const TAG = "ZZCLOSE";

// ── Who the actions think is calling, and what they would have mailed ──────────────────────────

let actor: { id: string; name: string; email: string; role: string } | null = null;
const mailed: { userId: string; subject: string }[] = [];

const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
class UnauthorizedError extends Error {}
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
  UnauthorizedError,
};
const navigation = {
  notFound: () => {
    throw new Error("NOT_FOUND_CALLED");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
  permanentRedirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
// No mail: notifyUser's email half is this recorder (the real one is a console stub today anyway).
const email = {
  sendEmailNotification: async (p: { userId: string; subject: string; body: string }) => {
    mailed.push({ userId: p.userId, subject: p.subject });
  },
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/navigation", navigation],
  ["@/lib/session", session],
  ["@/lib/email", email],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/navigation"), navigation],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("../src/lib/email"), email],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (byName.has(request)) return byName.get(request);
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
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
  const scratchName = `${realName}_close_check`;
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

    // From here on anything reaching for the environment's workspace lands in the scratch one too, and
    // the control plane is switched off by value (a Prisma client reloads .env for a missing variable).
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = "";

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    closeAll = () => db.$disconnect();
    /* eslint-enable @typescript-eslint/no-require-imports */
    await run(scratchUrl);
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
  ok("its lock is as it was", realAfter.lock === realBefore.lock, realAfter.lock ?? "no lock");
  ok("  its close months, templates, schedules and job runs are as they were", realAfter.close === realBefore.close, realAfter.close);
  ok("  and no entry of this suite's is in it", realAfter.tagged === 0 && realBefore.tagged === 0, realAfter.tagged);

  console.log(failures === 0 ? `\nAll ${passes} close checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** What the suite must never change in the real workspace. Read-only. */
async function snapshot(client: PrismaClient) {
  const [lock, months, templates, tasks, schedules, runs, tagged] = await Promise.all([
    client.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true, note: true } }),
    client.closeMonth.count(),
    client.closeTaskTemplate.count(),
    client.closeTask.count(),
    client.accountingSchedule.count(),
    client.dailyJobRun.count(),
    client.journalEntry.count({ where: { narration: { contains: TAG } } }),
  ]);
  return {
    lock: lock ? `${lock.lockedUntil?.toISOString() ?? "null"} ${lock.note ?? ""}` : null,
    close: json({ months, templates, tasks, schedules, runs }),
    tagged,
  };
}

// ── The suite ───────────────────────────────────────────────────────────────────────────────────

async function run(scratchUrl: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const journal = require("../src/lib/ledger/journal") as typeof import("../src/lib/ledger/journal");
  const { SYSTEM_ACCOUNTS } = require("../src/lib/ledger/chart") as typeof import("../src/lib/ledger/chart");
  const { endOfMonth, startOfMonth } = require("../src/lib/ledger/depreciation") as typeof import("../src/lib/ledger/depreciation");
  const { moveBooksLock } = require("../src/lib/ledger/books-lock") as typeof import("../src/lib/ledger/books-lock");
  const { automationUserId } = require("../src/lib/automation-user") as typeof import("../src/lib/automation-user");
  const months = require("../src/lib/close/months") as typeof import("../src/lib/close/months");
  const templates = require("../src/lib/close/templates") as typeof import("../src/lib/close/templates");
  const checklist = require("../src/lib/close/checklist") as typeof import("../src/lib/close/checklist");
  const closing = require("../src/lib/close/closing") as typeof import("../src/lib/close/closing");
  const schedules = require("../src/lib/close/schedules") as typeof import("../src/lib/close/schedules");
  const loaders = require("../src/lib/close/loaders") as typeof import("../src/lib/close/loaders");
  const flux = require("../src/lib/close/flux") as typeof import("../src/lib/close/flux");
  const settings = require("../src/lib/close/settings") as typeof import("../src/lib/close/settings");
  const nightly = require("../src/lib/close/nightly") as typeof import("../src/lib/close/nightly");
  const closeActions = require("../src/actions/close") as typeof import("../src/actions/close");
  const scheduleActions = require("../src/actions/accounting-schedules") as typeof import("../src/actions/accounting-schedules");
  const ledgerActions = require("../src/actions/ledger") as typeof import("../src/actions/ledger");
  const booksActions = require("../src/actions/books") as typeof import("../src/actions/books");
  const { ModuleNotInPlan } = require("../src/lib/modules-access") as typeof import("../src/lib/modules-access");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const tenant = (slug: string, entitlements: { all: boolean; modules: string[] }) => ({
    id: randomUUID(),
    slug,
    name: slug,
    status: "ACTIVE" as const,
    dbUrl: scratchUrl,
    primaryHost: `${slug}.localhost`,
    hosts: [`${slug}.localhost`],
    source: "env" as const,
    isDefault: false,
    keyBundleCipher: null,
    country: "IN",
    entitlements: { v: 1 as const, ...entitlements, seats: null, copilotTokens: null, customDomains: null, plans: [] },
    holdReason: null,
  });
  // The add-on in the plan, and a workspace whose plan has Accounting but not the add-on.
  const ON = tenant("zzclose-on", { all: true, modules: [] });
  const OFF = tenant("zzclose-off", { all: false, modules: ["accounting"] });

  await runAsTenant(ON, async () => {
    const tx = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => db.$transaction(fn, { timeout: 60_000 });
    const month = (key: string) => months.parseMonthKey(key)!;
    const JUN = month("2025-06");
    const SEP = month("2025-09");

    // ── Fixture ──────────────────────────────────────────────────────────────────────────────
    section("Fixture");
    const user = (key: string, role: string, extra: { isSuperAdmin?: boolean } = {}) =>
      db.user.create({
        data: { name: `${TAG} ${key}`, email: `${TAG.toLowerCase()}-${key.toLowerCase()}@example.test`, passwordHash: "!", role, ...extra },
        select: { id: true, name: true, email: true, role: true },
      });
    const owner = await user("Owner", "ADMIN", { isSuperAdmin: true });
    const clerk = await user("Clerk", "ACCOUNTS");
    const manager = await user("Manager", "ACCOUNTS");
    const sales = await user("Sales", "SALES");
    const person2 = await user("Preparer", "ACCOUNTS");
    await db.userPermission.create({ data: { userId: manager.id, permission: "close.manage", allowed: true, reason: `${TAG} fixture` } });
    await journal.ensureChartOfAccounts(db);
    const keyed = async (key: string) => (await db.ledgerAccount.findUniqueOrThrow({ where: { systemKey: key }, select: { id: true } })).id;
    const acct = (code: string, name: string, type: "ASSET" | "LIABILITY" | "EXPENSE" | "INCOME", extra: { isGroup?: boolean; active?: boolean } = {}) =>
      db.ledgerAccount.create({ data: { code: `ZZ-${code}`, name: `${TAG} ${name}`, type, ...extra }, select: { id: true, code: true } });
    const company = (name: string) => db.company.create({ data: { name: `${TAG} ${name}`, normalizedName: `${TAG.toLowerCase()} ${name.toLowerCase()}`, createdById: owner.id }, select: { id: true } });
    const customer = await company("Customer");
    const vendor = await company("Vendor");
    const AR = await keyed(SYSTEM_ACCOUNTS.AR);
    const AP = await keyed(SYSTEM_ACCOUNTS.AP);
    const ADJ = await keyed(SYSTEM_ACCOUNTS.ADJUSTMENTS);
    const PREPAID = await keyed(SYSTEM_ACCOUNTS.PREPAID_EXPENSES);
    const ACCRUED = await keyed(SYSTEM_ACCOUNTS.ACCRUED_EXPENSES);
    ok("people (a super admin, a clerk, a manager with close.manage, a salesperson), the chart, a customer and a vendor", !!owner && !!person2 && !!AR && !!PREPAID && !!ACCRUED);

    let seq = 0;
    const doc = (d: {
      docType: "INVOICE" | "CREDIT_NOTE" | "BILL";
      issueDate: Date;
      taxable: number;
      tax?: number;
      currency?: string;
      rate?: number;
      status?: "DRAFT" | "ISSUED" | "CANCELLED";
      againstDocumentId?: string;
    }) => {
      seq += 1;
      const half = round2((d.tax ?? 0) / 2);
      return db.tradeDocument.create({
        data: {
          docNumber: `${TAG}-${d.docType}-${seq}`,
          docType: d.docType,
          direction: d.docType === "BILL" ? "PURCHASE" : "SALES",
          status: d.status ?? "ISSUED",
          companyId: d.docType === "BILL" ? vendor.id : customer.id,
          createdById: owner.id,
          issueDate: d.issueDate,
          currency: d.currency ?? "INR",
          exchangeRate: d.rate ?? 1,
          subtotal: d.taxable,
          taxableValue: d.taxable,
          cgstAmount: half,
          sgstAmount: half,
          total: round2(d.taxable + half * 2),
          againstDocumentId: d.againstDocumentId ?? null,
        },
        select: { id: true, docNumber: true, total: true },
      });
    };
    const post = (id: string) => tx((t) => journal.postDocumentToLedger(t, id, owner.id));
    const entry = (date: Date, narration: string, lines: { accountId: string; debit: number; credit: number; companyId?: string | null }[], extra: { source?: "MANUAL" | "PAYROLL" | "REVENUE"; payrollRunId?: string; reversesId?: string } = {}) =>
      tx((t) => journal.writeEntry(t, { date, narration: `${TAG} ${narration}`, source: extra.source ?? "MANUAL", userId: owner.id, lines, payrollRunId: extra.payrollRunId, reversesId: extra.reversesId }));

    // ── Templates ─────────────────────────────────────────────────────────────────────────────
    section("The default templates, seeded once");
    const seeded = await Promise.all([templates.ensureDefaultTemplates(ist("2025-07-01T09:00:00")), templates.ensureDefaultTemplates(ist("2025-07-01T09:00:00"))]);
    ok("two first uses at once: exactly one seeds", seeded.filter(Boolean).length === 1, json(seeded));
    ok("  fourteen templates, due on the 3rd working day, nobody's", (await db.closeTaskTemplate.count()) === 14 && (await db.closeTaskTemplate.count({ where: { dueDay: 3, ownerId: null } })) === 14);
    ok("  eleven with an automatic check", (await db.closeTaskTemplate.count({ where: { autoCheck: { not: null } } })) === 11);
    ok("  and the seeding remembered as one close-seed row", (await db.dailyJobRun.count({ where: { job: "close-seed" } })) === 1);
    const tds = await db.closeTaskTemplate.findFirstOrThrow({ where: { title: "TDS reconciled" }, select: { id: true } });
    await templates.removeTemplate(tds.id);
    ok("a default deleted stays deleted: seeding again does nothing", !(await templates.ensureDefaultTemplates()) && (await db.closeTaskTemplate.count()) === 13);
    const bankTpl = await db.closeTaskTemplate.findFirstOrThrow({ where: { autoCheck: "bank-reconciled" }, select: { id: true } });
    const gstTpl = await db.closeTaskTemplate.findFirstOrThrow({ where: { title: "GST returns prepared" }, select: { id: true } });
    await templates.writeTemplate({ id: bankTpl.id, title: "Bank accounts reconciled to month end", ownerId: person2.id, dueDay: 1, autoCheck: "bank-reconciled" });
    await templates.writeTemplate({ id: gstTpl.id, title: "GST returns prepared", ownerId: person2.id, dueDay: 3 });
    ok("a template's owner must be a person here", !(await templates.writeTemplate({ title: "x", ownerId: "nobody" })).ok && !(await templates.writeTemplate({ title: "x", autoCheck: "made-up" })).ok);

    // ── Generation ────────────────────────────────────────────────────────────────────────────
    section("A month's checklist, generated once, due on working days");
    const genNow = ist("2025-07-02T09:00:00");
    const gen = await Promise.all([checklist.generateTasks(JUN, { now: genNow }), checklist.generateTasks(JUN, { now: genNow })]);
    const junTasks = await db.closeTask.findMany({ where: { month: JUN }, select: { id: true, title: true, dueOn: true, autoCheck: true, ownerId: true, templateId: true } });
    ok("two generations at once: June 2025 gets one task per active template", junTasks.length === 13, `${junTasks.length} (${json(gen)})`);
    ok("  a third generation adds nothing", (await checklist.generateTasks(JUN, { now: genNow })).created === 0 && (await db.closeTask.count({ where: { month: JUN } })) === 13);
    const dueDays = new Set(junTasks.filter((t) => t.templateId !== bankTpl.id).map((t) => months.dayKey(t.dueOn)));
    ok("  due on the 3rd working day of July 2025 — Thursday the 3rd", dueDays.size === 1 && dueDays.has("2025-07-03"), [...dueDays].join(","));
    const bankTask = junTasks.find((t) => t.templateId === bankTpl.id)!;
    ok("  the bank task (due day 1) on Tuesday 1 July, with its owner", months.dayKey(bankTask.dueOn) === "2025-07-01" && bankTask.ownerId === person2.id);
    ok("  the automatic check copied from its template", junTasks.filter((t) => t.autoCheck).length === 11);
    const assigned = await db.notification.findMany({ where: { userId: person2.id, type: "TASK_ASSIGNED" }, select: { link: true } });
    ok("the owner is told once per task, for both of theirs", assigned.length === 2 && assigned.every((n) => n.link?.includes("month=2025-06")), assigned.length);
    ok("a month still to come isn't generated", (await checklist.generateTasks(month("2025-08"), { now: genNow })).created === 0 && (await db.closeTask.count({ where: { month: month("2025-08") } })) === 0);

    // ── Prepaids and accruals ─────────────────────────────────────────────────────────────────
    section("Prepaids and accruals");
    const insurance = await acct("5901", "Insurance", "EXPENSE");
    const audit = await acct("5902", "Audit fee", "EXPENSE");
    const licence = await acct("5903", "Licences", "EXPENSE");
    const bill2 = await doc({ docType: "BILL", issueDate: ist("2025-04-15T11:00:00"), taxable: 12000 });
    await post(bill2.id);
    const aprNow = ist("2025-07-05T10:00:00");
    const p1 = await schedules.createAccountingSchedule(
      { kind: "PREPAID", name: `${TAG} Insurance`, expenseAccountId: insurance.id, amount: 12000, startMonth: "2025-04", months: 12, sourceDocumentId: bill2.id },
      owner.id,
      aprNow,
    );
    ok("a prepaid from an issued bill is made", p1.ok, p1.ok ? p1.reclassEntryNumber : p1.error);
    if (!p1.ok) throw new Error("prepaid");
    const p1Row = await db.accountingSchedule.findUniqueOrThrow({
      where: { id: p1.id },
      select: { balanceAccountId: true, vendorCompanyId: true, reclassEntry: { select: { date: true, lines: { select: { accountId: true, debit: true, credit: true } } } }, lines: { select: { amount: true } } },
    });
    const reclass = p1Row.reclassEntry!;
    ok("  its balance account defaults to Prepaid Expenses, its vendor to the bill's", p1Row.balanceAccountId === PREPAID && p1Row.vendorCompanyId === vendor.id);
    ok("  the reclass is dated the bill's date", reclass.date.getTime() === ist("2025-04-15T11:00:00").getTime(), reclass.date.toISOString());
    ok(
      "  Dr Prepaid Expenses 12,000 / Cr Insurance 12,000",
      reclass.lines.some((l) => l.accountId === PREPAID && Number(l.debit) === 12000) && reclass.lines.some((l) => l.accountId === insurance.id && Number(l.credit) === 12000),
    );
    ok("  twelve months of ₹1,000", p1Row.lines.length === 12 && p1Row.lines.every((l) => Number(l.amount) === 1000));
    const a1 = await schedules.createAccountingSchedule({ kind: "ACCRUAL", name: `${TAG} Audit fee`, expenseAccountId: audit.id, amount: 30000, startMonth: "2025-04", months: 3 }, owner.id, aprNow);
    ok("an accrual of ₹30,000 over three months from April is made, with no reclass", a1.ok && a1.reclassEntryNumber === null);
    if (!a1.ok) throw new Error("accrual");

    const actorId = owner.id;
    const run1 = await schedules.runAccountingSchedules({ throughMonth: JUN, actorId, now: aprNow });
    const kinds = (k: string) => run1.months.filter((m) => m.kind === k);
    ok("the run through June posts one prepaid entry and one accrual entry per month (April, May, June)", kinds("PREPAID").length === 3 && kinds("ACCRUAL").length === 3, json(run1.months.map((m) => `${m.kind} ${m.month}`)));
    const junePrepaid = kinds("PREPAID").find((m) => m.month === "2025-06")!;
    ok("  each dated its month's last day, 12:00 UTC", junePrepaid.date.toISOString() === "2025-06-30T12:00:00.000Z");
    const junePrepaidLines = await db.journalLine.findMany({ where: { entryId: junePrepaid.entryId }, select: { accountId: true, debit: true, credit: true } });
    ok(
      "  a prepaid month: Dr Insurance 1,000 / Cr Prepaid Expenses 1,000, source SCHEDULE",
      junePrepaidLines.some((l) => l.accountId === insurance.id && Number(l.debit) === 1000) &&
        junePrepaidLines.some((l) => l.accountId === PREPAID && Number(l.credit) === 1000) &&
        (await db.journalEntry.findUniqueOrThrow({ where: { id: junePrepaid.entryId }, select: { source: true } })).source === "SCHEDULE",
    );
    const aprilAccrual = kinds("ACCRUAL").find((m) => m.month === "2025-04")!;
    ok("an accrual month: dated 30 April, with its reversal on 1 May", aprilAccrual.date.toISOString() === "2025-04-30T12:00:00.000Z" && aprilAccrual.reversals[0]?.date.toISOString() === "2025-05-01T12:00:00.000Z");
    const aprReversal = await db.journalEntry.findUniqueOrThrow({
      where: { id: aprilAccrual.reversals[0]!.entryId },
      select: { reversesId: true, lines: { select: { accountId: true, debit: true, credit: true } } },
    });
    ok(
      "  the reversal is Dr Accrued Expenses / Cr Audit fee, recorded as the accrual's reversal",
      aprReversal.reversesId === aprilAccrual.entryId && aprReversal.lines.some((l) => l.accountId === ACCRUED && Number(l.debit) === 10000) && aprReversal.lines.some((l) => l.accountId === audit.id && Number(l.credit) === 10000),
    );
    const a1Lines = await db.accountingScheduleLine.findMany({ where: { scheduleId: a1.id }, select: { entryId: true, reversalEntryId: true, catchUp: true } });
    ok("  every accrual month has its entry and its reversal, none caught up", a1Lines.every((l) => l.entryId && l.reversalEntryId && !l.catchUp));
    ok("a second run posts nothing", (await schedules.runAccountingSchedules({ throughMonth: JUN, actorId, now: aprNow })).months.length === 0);
    const julNow = ist("2025-08-05T10:00:00");
    const both = await Promise.all([
      schedules.runAccountingSchedules({ throughMonth: month("2025-07"), actorId, now: julNow }),
      schedules.runAccountingSchedules({ throughMonth: month("2025-07"), actorId, now: julNow }),
    ]);
    const julyEntries = await db.journalEntry.count({ where: { source: "SCHEDULE", date: { gte: ist("2025-07-01T00:00:00"), lt: ist("2025-08-01T00:00:00") }, narration: { contains: "July 2025" } } });
    ok("two runs through July at once: July posted once — one prepaid entry, no accrual (it ended in June)", julyEntries === 1 && both.flatMap((b) => b.months).length === 1, json(both.map((b) => b.months.length)));
    ok("  and the accrual, every month posted, is complete", (await db.accountingSchedule.findUniqueOrThrow({ where: { id: a1.id }, select: { status: true } })).status === "COMPLETED");
    ok("a run can't post a month that hasn't ended: through September on 5 August posts through July", (await schedules.runAccountingSchedules({ throughMonth: month("2025-09"), actorId, now: julNow })).months.length === 0);

    const edited = await schedules.editAccountingSchedule(p1.id, { amount: 13200 }, owner.id, julNow);
    const p1After = await db.accountingSchedule.findUniqueOrThrow({ where: { id: p1.id }, select: { lines: { where: { entryId: null }, orderBy: { month: "asc" }, select: { amount: true } } } });
    ok(
      "raised to ₹13,200 with four months posted: the other eight share ₹9,200 (₹1,150 each)",
      edited.ok && p1After.lines.length === 8 && p1After.lines.every((l) => Number(l.amount) === 1150),
      edited.ok ? edited.adjustmentEntryNumber : edited.error,
    );
    ok("  and the ₹1,200 more goes into Prepaid Expenses by a further reclass", edited.ok && !!edited.adjustmentEntryNumber);
    ok("  a prepaid's accounts can't change once its reclass is posted", !(await schedules.editAccountingSchedule(p1.id, { expenseAccountId: audit.id }, owner.id, julNow)).ok);
    ok("  nor its start once months are posted", !(await schedules.editAccountingSchedule(p1.id, { startMonth: "2025-05" }, owner.id, julNow)).ok);

    section("A closed month's share caught up into the first open month");
    const lockMay = await moveBooksLock(db, { lockedUntil: "2025-05-31", note: `${TAG} catch-up`, userId: owner.id, now: ist("2025-07-10T10:00:00") });
    ok("the books are locked to 31 May", lockMay.ok);
    const catchNow = ist("2025-07-10T10:00:00");
    const p2 = await schedules.createAccountingSchedule({ kind: "PREPAID", name: `${TAG} Licence`, expenseAccountId: licence.id, amount: 6000, startMonth: "2025-04", months: 6 }, owner.id, catchNow);
    if (!p2.ok) throw new Error(`catch-up prepaid: ${p2.error}`);
    const p2Reclass = await db.accountingSchedule.findUniqueOrThrow({ where: { id: p2.id }, select: { reclassEntry: { select: { date: true } } } });
    ok("a prepaid with no bill, starting in April under that lock: its reclass moves to the first open day, 1 June", p2Reclass.reclassEntry?.date.toISOString() === "2025-06-01T12:00:00.000Z", p2Reclass.reclassEntry?.date.toISOString());
    const catchRun = await schedules.runAccountingSchedules({ throughMonth: JUN, actorId, now: catchNow });
    const catchJune = catchRun.months.find((m) => m.kind === "PREPAID");
    ok("April and May (closed) and June post together, in June — one entry", catchRun.months.length === 1 && catchJune?.month === "2025-06" && catchJune.amount === 3000, json(catchRun.months.map((m) => [m.month, m.amount, m.catchUp])));
    ok("  dated 30 June", catchJune?.date.toISOString() === "2025-06-30T12:00:00.000Z");
    const p2Lines = await db.accountingScheduleLine.findMany({ where: { scheduleId: p2.id, entryId: { not: null } }, orderBy: { month: "asc" }, select: { month: true, catchUp: true } });
    ok("  April and May flagged as caught up, June not", json(p2Lines.map((l) => [months.monthKeyOf(l.month), l.catchUp])) === json([["2025-04", true], ["2025-05", true], ["2025-06", false]]));
    const stopped = await schedules.stopAccountingSchedule(p2.id, owner.id, catchNow);
    ok("stopping it expenses the ₹3,000 not yet expensed, today", stopped.ok && stopped.expensedNow === 3000 && !!stopped.entryNumber, stopped.ok ? stopped.entryNumber : stopped.error);
    const p2Stopped = await db.accountingSchedule.findUniqueOrThrow({ where: { id: p2.id }, select: { status: true, note: true, _count: { select: { lines: true } } } });
    ok("  it is CANCELLED, its unposted months gone", p2Stopped.status === "CANCELLED" && p2Stopped._count.lines === 3, p2Stopped.note);
    ok("  and stopping twice is refused", !(await schedules.stopAccountingSchedule(p2.id, owner.id, catchNow)).ok);
    ok("the lock is removed again (the same path)", (await moveBooksLock(db, { lockedUntil: null, userId: owner.id })).ok);

    section("A schedule refused");
    const bad = (input: Partial<import("../src/lib/close/schedules").ScheduleInput>) =>
      schedules.createAccountingSchedule({ kind: "ACCRUAL", name: `${TAG} bad`, expenseAccountId: audit.id, amount: 100, startMonth: "2025-06", months: 1, ...input }, owner.id, catchNow);
    const group = await acct("5990", "Group", "EXPENSE", { isGroup: true });
    const archived = await acct("5991", "Archived", "EXPENSE", { active: false });
    const asset = await acct("1901", "Some asset", "ASSET");
    const refusals = await Promise.all([
      bad({ months: 61 }),
      bad({ months: 0 }),
      bad({ amount: 0 }),
      bad({ expenseAccountId: asset.id }),
      bad({ expenseAccountId: group.id }),
      bad({ expenseAccountId: archived.id }),
      bad({ sourceDocumentId: bill2.id }),
      bad({ balanceAccountId: asset.id }),
      bad({ startMonth: "2025-13" }),
    ]);
    ok(
      "61 months, 0 months, ₹0, an asset, a group, an archived account, an accrual from a bill, an asset to accrue into, a month that isn't one",
      refusals.every((r) => !r.ok),
      refusals.map((r) => (r.ok ? "ACCEPTED" : r.error.slice(0, 32))).join(" | "),
    );

    // ── The automatic checks, one by one ──────────────────────────────────────────────────────
    section("Every automatic check, failing and passing (June 2025)");
    const check = (key: Parameters<typeof loaders.runCheck>[0]) => loaders.runCheck(key, JUN);

    // Bank.
    const bankLedger = await acct("1191", "HDFC", "ASSET");
    const bankLedger2 = await acct("1192", "Old bank", "ASSET");
    const ba1 = await db.bankAccount.create({ data: { name: `${TAG} HDFC`, ledgerAccountId: bankLedger.id, active: true }, select: { id: true } });
    await db.bankAccount.create({ data: { name: `${TAG} Old bank`, ledgerAccountId: bankLedger2.id, active: false } });
    let r = await check("bank-reconciled");
    ok("bank: never reconciled fails; the inactive account isn't asked", !r.ok && r.detail.items.length === 1 && r.detail.items[0]!.id === ba1.id && r.detail.items[0]!.note === "Never reconciled", r.detail.summary);
    const recon = (date: Date, difference: number) =>
      db.bankReconciliation.create({ data: { bankAccountId: ba1.id, statementDate: date, statementBalance: 0, bookBalance: -difference, difference, completedById: owner.id } });
    await recon(utcDay(2025, 6, 30), 50);
    r = await check("bank-reconciled");
    ok("  reconciled to 30 June with a ₹50 difference fails", !r.ok && (r.detail.items[0]!.note ?? "").includes("difference"), r.detail.items[0]?.note);
    await recon(utcDay(2025, 7, 2), 0);
    r = await check("bank-reconciled");
    ok("  reconciled to 2 July with none passes", r.ok, r.detail.summary);

    // Invoices.
    const d0 = await doc({ docType: "INVOICE", status: "DRAFT", issueDate: ist("2025-05-31T23:59:00"), taxable: 100 });
    const d1 = await doc({ docType: "INVOICE", status: "DRAFT", issueDate: ist("2025-06-30T23:30:00"), taxable: 100 });
    const d2 = await doc({ docType: "INVOICE", status: "DRAFT", issueDate: ist("2025-07-01T00:10:00"), taxable: 100 });
    const d3 = await doc({ docType: "INVOICE", status: "DRAFT", issueDate: ist("2025-06-01T00:00:00"), taxable: 100 });
    r = await check("invoices-issued");
    ok("invoices: drafts dated 00:00 IST on 1 June and 23:30 IST on 30 June fail; 31 May and 1 July don't count", !r.ok && json(r.detail.items.map((i) => i.id).sort()) === json([d1.id, d3.id].sort()), r.detail.summary);
    await db.tradeDocument.deleteMany({ where: { id: { in: [d0.id, d1.id, d2.id, d3.id] } } });
    ok("  none left passes", (await check("invoices-issued")).ok);

    // Revenue.
    ok("revenue: no schedules at all passes", (await check("revenue-recognised")).ok);
    const project = await db.project.create({ data: { code: `${TAG}-PJ1`, name: `${TAG} Implementation`, companyId: customer.id, createdById: owner.id }, select: { id: true } });
    const milestone = (name: string, completedAt: Date | null) => db.projectMilestone.create({ data: { projectId: project.id, name, completedAt }, select: { id: true } });
    const rs1 = await db.revenueSchedule.create({
      data: { companyId: customer.id, kind: "RATABLE", status: "ACTIVE", amount: 12000, startDate: utcDay(2025, 6, 1), endDate: utcDay(2026, 5, 31), opening: true, createdById: owner.id, lines: { create: [{ month: JUN, amount: 1000 }] } },
      select: { id: true, lines: { select: { id: true } } },
    });
    const rs2 = await db.revenueSchedule.create({
      data: { companyId: customer.id, kind: "RATABLE", status: "PENDING_APPROVAL", amount: 5000, startDate: utcDay(2025, 6, 15), endDate: utcDay(2025, 12, 14), opening: true, createdById: owner.id },
      select: { id: true },
    });
    const m3 = await milestone("Go-live", ist("2025-06-25T16:00:00"));
    const bm3 = await db.projectBillingMilestone.create({ data: { projectId: project.id, label: "On go-live", amount: 40000, status: "INVOICED", deliveryMilestoneId: m3.id }, select: { id: true } });
    const rs3 = await db.revenueSchedule.create({
      data: { companyId: customer.id, kind: "MILESTONE", status: "ACTIVE", amount: 40000, billingMilestoneId: bm3.id, opening: true, createdById: owner.id },
      select: { id: true },
    });
    r = await check("revenue-recognised");
    ok("  an unposted June month, a schedule waiting for approval, and a delivered milestone fail", !r.ok && json(r.detail.items.map((i) => i.id).sort()) === json([rs1.id, rs2.id, rs3.id].sort()), r.detail.summary);
    const recognised = await entry(ist("2025-06-30T17:30:00"), "June revenue", [
      { accountId: await keyed(SYSTEM_ACCOUNTS.DEFERRED_REVENUE), debit: 1000, credit: 0 },
      { accountId: await keyed(SYSTEM_ACCOUNTS.SALES), debit: 0, credit: 1000 },
    ], { source: "REVENUE" });
    await db.revenueScheduleLine.update({ where: { id: rs1.lines[0]!.id }, data: { entryId: recognised.id, postedAt: new Date() } });
    await db.revenueSchedule.update({ where: { id: rs2.id }, data: { status: "CANCELLED" } });
    await db.revenueSchedule.update({ where: { id: rs3.id }, data: { status: "COMPLETED" } });
    ok("  posted, cancelled and recognised, it passes", (await check("revenue-recognised")).ok);

    // Schedules.
    ok("schedules: everything through June posted passes", (await check("schedules-posted")).ok);
    const a2 = await schedules.createAccountingSchedule({ kind: "ACCRUAL", name: `${TAG} Retainer`, expenseAccountId: audit.id, amount: 5000, startMonth: "2025-06", months: 1 }, owner.id, catchNow);
    r = await check("schedules-posted");
    ok("  a new accrual for June, unposted, fails", a2.ok && !r.ok && r.detail.items[0]?.id === a2.id, r.detail.summary);
    await schedules.runAccountingSchedules({ throughMonth: JUN, actorId, now: catchNow });
    ok("  posted, it passes", (await check("schedules-posted")).ok);

    // Depreciation.
    const computers = await acct("1501", "Computers", "ASSET");
    const fa = await db.fixedAsset.create({
      data: { tag: `${TAG}-FA1`, name: "Laptop", purchasedOn: utcDay(2025, 4, 10), cost: 36000, usefulLifeYears: 3, assetAccountId: computers.id, createdById: owner.id },
      select: { id: true },
    });
    await db.fixedAsset.create({ data: { tag: `${TAG}-FA2`, name: "Printer", purchasedOn: utcDay(2025, 7, 2), cost: 12000, usefulLifeYears: 1, assetAccountId: computers.id, createdById: owner.id } });
    r = await check("depreciation-run");
    ok("depreciation: an asset due June's ₹1,000 fails; one bought in July isn't due", !r.ok && r.detail.items.length === 1 && r.detail.items[0]!.id === fa.id && r.detail.items[0]!.amount === 1000, r.detail.summary);
    await tx((t) => journal.postDepreciationToLedger(t, { assetId: fa.id, amount: 1000, fromDate: startOfMonth(2025, 6), toDate: endOfMonth(2025, 6), periodLabel: `${TAG} June 2025`, userId: owner.id }));
    ok("  charged, it passes", (await check("depreciation-run")).ok);

    // Payroll.
    r = await check("payroll-posted");
    ok("payroll: no run for June fails", !r.ok, r.detail.summary);
    const payrollRun = await db.payrollRun.create({ data: { month: 6, year: 2025, status: "DRAFT" }, select: { id: true } });
    ok("  a draft run fails", !(await check("payroll-posted")).ok);
    await db.payrollRun.update({ where: { id: payrollRun.id }, data: { status: "LOCKED" } });
    r = await check("payroll-posted");
    ok("  locked but not posted fails", !r.ok && r.detail.summary.includes("not posted"), r.detail.summary);
    await entry(ist("2025-06-30T17:30:00"), "June payroll", [
      { accountId: await keyed(SYSTEM_ACCOUNTS.SALARIES), debit: 50000, credit: 0 },
      { accountId: await keyed(SYSTEM_ACCOUNTS.SALARY_PAYABLE), debit: 0, credit: 50000 },
    ], { source: "PAYROLL", payrollRunId: payrollRun.id });
    ok("  locked and posted passes", (await check("payroll-posted")).ok);
    await db.systemModule.upsert({ where: { key: "payroll" }, create: { key: "payroll", enabled: false }, update: { enabled: false } });
    r = await check("payroll-posted");
    ok("  with payroll switched off it passes as not in use", r.ok && r.detail.summary === "Payroll isn't in use.", r.detail.summary);
    await db.systemModule.delete({ where: { key: "payroll" } });

    // Expenses.
    const expense = (spentOn: Date, status: "APPROVED" | "REJECTED") =>
      db.expense.create({ data: { amount: 1200, spentOn, description: `${TAG} cab`, status, userId: person2.id }, select: { id: true } });
    const e1 = await expense(ist("2025-06-15T10:00:00"), "APPROVED");
    await expense(ist("2025-07-01T00:10:00"), "APPROVED");
    await expense(ist("2025-06-16T10:00:00"), "REJECTED");
    r = await check("expenses-posted");
    ok("expenses: an approved June claim without its entry fails; July's and a rejected one don't count", !r.ok && r.detail.items.length === 1 && r.detail.items[0]!.id === e1.id, r.detail.summary);
    await tx((t) => journal.postExpenseToLedger(t, e1.id, owner.id));
    ok("  posted, it passes", (await check("expenses-posted")).ok);

    // Delivered, not invoiced.
    const m1 = await milestone("Design signed off", ist("2025-06-20T15:00:00"));
    const m2 = await milestone("Build", ist("2025-07-01T00:10:00"));
    const bm1 = await db.projectBillingMilestone.create({ data: { projectId: project.id, label: "On design", amount: 50000, status: "PENDING", deliveryMilestoneId: m1.id }, select: { id: true } });
    await db.projectBillingMilestone.create({ data: { projectId: project.id, label: "On build", amount: 50000, status: "DUE", deliveryMilestoneId: m2.id } });
    r = await check("delivered-not-invoiced");
    ok("delivered, not invoiced: June's delivery with its stage pending fails; July's doesn't count", !r.ok && r.detail.items.length === 1 && r.detail.items[0]!.id === bm1.id, r.detail.summary);
    await db.projectBillingMilestone.update({ where: { id: bm1.id }, data: { status: "INVOICED" } });
    ok("  invoiced, it passes", (await check("delivered-not-invoiced")).ok);

    // Receivables tie-out.
    section("Receivables tied to the ledger (June 2025)");
    const i1 = await doc({ docType: "INVOICE", issueDate: ist("2025-06-10T11:00:00"), taxable: 10000, tax: 1800 });
    const i2 = await doc({ docType: "INVOICE", issueDate: ist("2025-06-12T11:00:00"), taxable: 100.38, tax: 18.06, currency: "USD", rate: 83.47 });
    const i3 = await doc({ docType: "INVOICE", issueDate: ist("2025-06-29T11:00:00"), taxable: 5000, tax: 900 });
    const i3b = await doc({ docType: "INVOICE", issueDate: ist("2025-06-15T11:00:00"), taxable: 2000, tax: 360 });
    const i4 = await doc({ docType: "INVOICE", issueDate: ist("2025-07-02T11:00:00"), taxable: 3000, tax: 540 });
    const cn1 = await doc({ docType: "CREDIT_NOTE", issueDate: ist("2025-06-28T11:00:00"), taxable: 1000, tax: 180, againstDocumentId: i1.id });
    for (const d of [i1, i2, i3, i3b, i4, cn1]) await post(d.id);
    const payment = async (p: { amount: number; paidOn: Date; direction?: "RECEIVED" | "PAID"; currency?: string; rate?: number; companyId?: string; allocateTo?: string }) => {
      const row = await db.payment.create({
        data: {
          companyId: p.companyId ?? customer.id, direction: p.direction ?? "RECEIVED", amount: p.amount, paidOn: p.paidOn, method: "BANK_TRANSFER",
          currency: p.currency ?? "INR", exchangeRate: p.rate ?? 1, recordedByUserId: owner.id,
          ...(p.allocateTo ? { allocations: { create: [{ documentId: p.allocateTo, amount: p.amount, allocatedByUserId: owner.id }] } } : {}),
        },
        select: { id: true },
      });
      await tx((t) => journal.postPaymentToLedger(t, row.id, owner.id));
      if (p.allocateTo) await tx((t) => journal.postExchangeDifferenceToLedger(t, { paymentId: row.id, documentId: p.allocateTo!, allocatedAmount: p.amount, userId: owner.id }));
      return row;
    };
    await payment({ amount: 5000, paidOn: ist("2025-06-20T10:00:00"), allocateTo: i1.id });
    const p2Receipt = await payment({ amount: 2000, paidOn: ist("2025-06-25T10:00:00") });
    await payment({ amount: 50, paidOn: ist("2025-06-26T10:00:00"), currency: "USD", rate: 85, allocateTo: i2.id });
    await db.creditNoteApplication.create({ data: { creditNoteId: cn1.id, invoiceId: i1.id, amount: 1180, appliedByUserId: owner.id, createdAt: ist("2025-06-28T12:00:00") } });
    // I3 cancelled after the month end (its reversal is dated today), I3b inside June.
    await db.tradeDocument.update({ where: { id: i3.id }, data: { status: "CANCELLED" } });
    await tx((t) => journal.reverseDocumentPosting(t, i3.id, owner.id));
    const i3bEntry = await db.journalEntry.findFirstOrThrow({ where: { documentId: i3b.id, source: "INVOICE" }, select: { id: true, lines: { select: journal.reversibleLineSelect } } });
    await db.tradeDocument.update({ where: { id: i3b.id }, data: { status: "CANCELLED" } });
    await tx((t) => journal.writeEntry(t, { date: ist("2025-06-18T12:00:00"), narration: `${TAG} reversal — cancelled`, source: "MANUAL", userId: owner.id, lines: journal.reversedLines(i3bEntry.lines), reversesId: i3bEntry.id }));

    const arBalance = async () => {
      const s = await db.journalLine.aggregate({ where: { accountId: AR, entry: { date: { lt: ist("2025-07-01T00:00:00") } } }, _sum: { debit: true, credit: true } });
      return round2(Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0));
    };
    // Ageing at 30 June: I1 11,800 − 5,000 − 1,180 = 5,620; I2 $118.44 − $50 at 83.47 = 9,886.19 − 4,173.50 = 5,712.69;
    // I3 5,900 (cancelled in July, owed in June); the credit note fully applied 0; ₹2,000 on account −2,000. Total 15,232.69.
    r = await check("ar-ties");
    const ar = r.detail as import("../src/lib/close/tieout").TieOutDetail;
    ok("the ageing at 30 June is ₹15,232.69, in rupees at each document's rate", ar.ageing === 15232.69, ar.ageing);
    ok("  and the ledger agrees — it ties", r.ok && ar.ledger === 15232.69 && ar.ledger === (await arBalance()), ar.summary);
    ok("  the invoice cancelled inside June is out; the one cancelled in July and July's own invoice are as they stood", !ar.causes.mismatchedDocuments.count, ar.causes.mismatchedDocuments.items.map((i) => i.label).join(", "));
    ok("  the receipt on account is listed, at −₹2,000", ar.causes.unappliedPayments.count === 1 && ar.causes.unappliedPayments.items[0]!.id === p2Receipt.id && ar.breakdown.unappliedPayments === -2000);
    ok("  the cancellation's reversal is not counted as a manual journal", ar.causes.manualJournals.count === 0);
    const mj1 = await entry(ist("2025-06-30T17:30:00"), "write-back", [{ accountId: AR, debit: 1000, credit: 0, companyId: customer.id }, { accountId: ADJ, debit: 0, credit: 1000 }]);
    r = await check("ar-ties");
    let tie = r.detail as import("../src/lib/close/tieout").TieOutDetail;
    ok("a manual journal of ₹1,000 on AR in June: ₹1,000 apart, and it fails", !r.ok && tie.difference === -1000, tie.summary);
    ok("  the journal is named among the causes, with its number", tie.causes.manualJournals.items.some((i) => i.id === mj1.id && i.label.startsWith(mj1.entryNumber)) && r.detail.items.some((i) => i.id === mj1.id));
    const mj2 = await entry(ist("2025-06-30T17:30:00"), "no party", [{ accountId: AR, debit: 500, credit: 0 }, { accountId: ADJ, debit: 0, credit: 500 }]);
    r = await check("ar-ties");
    tie = r.detail as import("../src/lib/close/tieout").TieOutDetail;
    ok("an AR line with no party is listed as one", tie.difference === -1500 && tie.causes.partylessLines.items.some((i) => i.id === mj2.id), tie.causes.partylessLines.count);
    const i5 = await doc({ docType: "INVOICE", issueDate: ist("2025-06-05T11:00:00"), taxable: 1000 });
    await post(i5.id);
    await db.tradeDocument.update({ where: { id: i5.id }, data: { total: 1100 } });
    r = await check("ar-ties");
    tie = r.detail as import("../src/lib/close/tieout").TieOutDetail;
    ok("a document whose entry disagrees with its total is named, with the gap", tie.causes.mismatchedDocuments.items.some((i) => i.id === i5.id && i.amount === -100), tie.causes.mismatchedDocuments.items.map((i) => `${i.label} ${i.amount}`).join(", "));
    await db.tradeDocument.update({ where: { id: i5.id }, data: { total: 1000 } });
    for (const e of [mj1, mj2]) {
      const original = await db.journalEntry.findUniqueOrThrow({ where: { id: e.id }, select: { lines: { select: journal.reversibleLineSelect } } });
      await tx((t) => journal.writeEntry(t, { date: ist("2025-06-30T18:00:00"), narration: `${TAG} reversal`, source: "MANUAL", userId: owner.id, lines: journal.reversedLines(original.lines), reversesId: e.id }));
    }
    r = await check("ar-ties");
    ok("  reversed, and the total put right: it ties again", r.ok, r.detail.summary);

    section("Payables tied to the ledger (June 2025)");
    const b1 = await doc({ docType: "BILL", issueDate: ist("2025-06-08T11:00:00"), taxable: 20000, tax: 3600 });
    await post(b1.id);
    await payment({ amount: 10000, paidOn: ist("2025-06-18T10:00:00"), direction: "PAID", companyId: vendor.id, allocateTo: b1.id });
    r = await check("ap-ties");
    const apDetail = r.detail as import("../src/lib/close/tieout").TieOutDetail;
    const apLedger = await db.journalLine.aggregate({ where: { accountId: AP, entry: { date: { lt: ist("2025-07-01T00:00:00") } } }, _sum: { debit: true, credit: true } });
    ok("the June bill less its payment, and April's prepaid bill: ₹25,600, tied", r.ok && apDetail.ageing === 25600, apDetail.summary);
    ok("  the ledger side is the Accounts Payable balance, credit − debit", apDetail.ledger === round2(Number(apLedger._sum.credit ?? 0) - Number(apLedger._sum.debit ?? 0)), apDetail.ledger);
    const b3 = await doc({ docType: "BILL", issueDate: ist("2025-06-20T11:00:00"), taxable: 5000 });
    r = await check("ap-ties");
    tie = r.detail as import("../src/lib/close/tieout").TieOutDetail;
    ok("an issued bill never posted: ₹5,000 apart, named as having no entry", !r.ok && tie.difference === 5000 && tie.causes.mismatchedDocuments.items[0]?.id === b3.id, tie.causes.mismatchedDocuments.items[0]?.note);
    await post(b3.id);
    ok("  posted, it ties", (await check("ap-ties")).ok);

    // ── Flux ──────────────────────────────────────────────────────────────────────────────────
    section("Flux: flagged at both thresholds, and explained (September 2025)");
    const rent = await acct("5801", "Rent", "EXPENSE");
    const power = await acct("5802", "Power", "EXPENSE");
    const edge = await acct("5803", "Edge", "EXPENSE");
    const under = await acct("5804", "Under", "EXPENSE");
    const clearing = await acct("2801", "Flux clearing", "LIABILITY");
    const spend = (accountId: string, date: Date, amount: number) =>
      entry(date, "flux", [{ accountId, debit: amount, credit: 0 }, { accountId: clearing.id, debit: 0, credit: amount }]);
    await spend(rent.id, ist("2024-09-15T12:00:00"), 90000);
    await spend(rent.id, ist("2025-08-15T12:00:00"), 100000);
    await spend(rent.id, ist("2025-09-01T00:00:00"), 30000);
    await spend(rent.id, ist("2025-09-30T23:30:00"), 100000);
    await spend(rent.id, ist("2025-10-01T00:10:00"), 99999);
    await spend(power.id, ist("2025-08-15T12:00:00"), 200000);
    await spend(power.id, ist("2025-09-15T12:00:00"), 224000);
    await spend(edge.id, ist("2025-08-15T12:00:00"), 125000);
    await spend(edge.id, ist("2025-09-15T12:00:00"), 150000);
    await spend(under.id, ist("2025-08-15T12:00:00"), 125100);
    await spend(under.id, ist("2025-09-15T12:00:00"), 150100);
    const report = await flux.fluxFor(SEP);
    const row = (id: string) => report.rows.find((x) => x.accountId === id)!;
    ok("Rent: ₹1,30,000 in September (00:00 IST on the 1st and 23:30 IST on the 30th; 00:10 IST on 1 October is October's)", row(rent.id).current === 130000 && row(rent.id).previous === 100000 && row(rent.id).lastYear === 90000, json([row(rent.id).current, row(rent.id).previous, row(rent.id).lastYear]));
    ok("  +₹30,000 and +30% on August: flagged", row(rent.id).changePrev === 30000 && row(rent.id).changePrevPct === 30 && row(rent.id).flagged);
    ok("  and +₹40,000, +44.44% on last September", row(rent.id).changeYear === 40000 && row(rent.id).changeYearPct === 44.44);
    ok("Power: +₹24,000 (12%) — under the amount, not flagged", !row(power.id).flagged);
    ok("Edge: +₹25,000 at exactly 20% — both met, flagged", row(edge.id).flagged);
    ok("Under: +₹25,000 at 19.98% — under the percentage, not flagged", !row(under.id).flagged);
    ok("the clearing liability compares closing balances: ₹6,40,100 at August's end, ₹12,94,200 at September's", row(clearing.id).statement === "BS" && row(clearing.id).previous === 640100 && row(clearing.id).current === 1294200 && row(clearing.id).flagged, json([row(clearing.id).previous, row(clearing.id).current]));
    r = await loaders.runCheck("flux-explained", SEP);
    const unexplained = new Set(r.detail.items.map((i) => i.id));
    ok("the flux check fails, naming Rent, Edge and the clearing account — not Power or Under", !r.ok && [rent.id, edge.id, clearing.id].every((id) => unexplained.has(id)) && !unexplained.has(power.id) && !unexplained.has(under.id), r.detail.summary);
    for (const flagged of report.rows.filter((x) => x.flagged)) {
      await flux.writeFluxNote({ month: SEP, accountId: flagged.accountId, explanation: `${TAG} explained`, userId: clerk.id });
    }
    await checklist.generateTasks(SEP, { now: ist("2025-10-01T09:00:00") });
    const sepEval = await checklist.evaluateAutoChecks(SEP, { now: ist("2025-10-01T09:00:00"), keys: ["flux-explained"] });
    const fluxTask = await db.closeTask.findFirstOrThrow({ where: { month: SEP, autoCheck: "flux-explained" }, select: { status: true, doneById: true, autoOk: true } });
    const automation = await automationUserId();
    ok("every flagged row explained: the flux task passes and is ticked by the Automation account", sepEval.passed === 1 && fluxTask.status === "DONE" && fluxTask.doneById === automation && fluxTask.autoOk === true);
    await db.fluxNote.delete({ where: { month_accountId: { month: SEP, accountId: edge.id } } });
    r = await loaders.runCheck("flux-explained", SEP);
    ok("  one explanation removed: it fails again, naming only that account", !r.ok && r.detail.items.length === 1 && r.detail.items[0]!.id === edge.id);
    await flux.writeFluxNote({ month: SEP, accountId: edge.id, explanation: `${TAG} explained again`, userId: clerk.id });

    // ── Automation vs people ──────────────────────────────────────────────────────────────────
    section("The automation ticks only its own ticks");
    const evalNow = ist("2025-07-10T10:00:00");
    const evalJun = await checklist.evaluateAutoChecks(JUN, { now: evalNow });
    const task = async (key: string) =>
      db.closeTask.findFirstOrThrow({ where: { month: JUN, autoCheck: key }, select: { id: true, status: true, doneById: true, note: true, autoOk: true, autoCheckedAt: true, autoDetail: true } });
    let bankT = await task("bank-reconciled");
    ok("a passing check ticks its task, as the Automation account, 'Checked automatically'", bankT.status === "DONE" && bankT.doneById === automation && bankT.note === "Checked automatically" && bankT.autoOk === true, json(evalJun));
    ok("  the detail is stored with its summary and figures", typeof (bankT.autoDetail as { summary?: string }).summary === "string" && (bankT.autoDetail as { numbers?: { accounts?: number } }).numbers?.accounts === 1);
    const passedKeys = ["bank-reconciled", "invoices-issued", "revenue-recognised", "schedules-posted", "depreciation-run", "payroll-posted", "expenses-posted", "ar-ties", "ap-ties", "delivered-not-invoiced"];
    const juneAuto = await db.closeTask.findMany({ where: { month: JUN, autoCheck: { in: passedKeys } }, select: { autoCheck: true, status: true, autoOk: true } });
    ok("  every June check the fixture put right has passed and ticked", juneAuto.length === 10 && juneAuto.every((t) => t.status === "DONE" && t.autoOk === true), juneAuto.filter((t) => t.status !== "DONE").map((t) => t.autoCheck).join(", "));
    const late = await doc({ docType: "INVOICE", status: "DRAFT", issueDate: ist("2025-06-30T20:00:00"), taxable: 10 });
    await checklist.evaluateAutoChecks(JUN, { now: ist("2025-07-11T10:00:00"), keys: ["invoices-issued"] });
    let inv = await task("invoices-issued");
    ok("a check that fails later unticks a task the Automation account ticked", inv.status === "TODO" && inv.doneById === null && inv.autoOk === false);
    const byPerson = await checklist.writeTaskStatus({ taskId: inv.id, status: "DONE", note: "Draft is a duplicate; deleting after close", userId: clerk.id, userName: clerk.name });
    const before = inv.autoCheckedAt!;
    await checklist.evaluateAutoChecks(JUN, { now: ist("2025-07-12T10:00:00"), keys: ["invoices-issued"] });
    inv = await task("invoices-issued");
    ok("  but never one a person marked done: it stays theirs, and only the detail is refreshed", byPerson.ok && inv.status === "DONE" && inv.doneById === clerk.id && inv.autoOk === false && inv.autoCheckedAt!.getTime() > before.getTime());
    ok("  the person's note is kept, under their name", (inv.note ?? "").includes(`${clerk.name}, `) && (inv.note ?? "").includes("duplicate"));
    const naRefused = await checklist.writeTaskStatus({ taskId: bankT.id, status: "NOT_APPLICABLE", userId: clerk.id, userName: clerk.name });
    ok("not applicable needs a reason", !naRefused.ok);
    await checklist.writeTaskStatus({ taskId: bankT.id, status: "NOT_APPLICABLE", note: "Account closed in June", userId: clerk.id, userName: clerk.name });
    await checklist.evaluateAutoChecks(JUN, { now: ist("2025-07-12T11:00:00"), keys: ["bank-reconciled"] });
    bankT = await task("bank-reconciled");
    ok("  and a task marked not applicable stays so when its check passes", bankT.status === "NOT_APPLICABLE" && bankT.doneById === clerk.id);
    await db.tradeDocument.delete({ where: { id: late.id } });

    // ── Closing and reopening ─────────────────────────────────────────────────────────────────
    section("Closing a month, in order, through the shared lock path");
    const MAY = month("2025-05");
    const JUL = month("2025-07");
    const closeNow = ist("2025-07-15T10:00:00");
    await checklist.generateTasks(MAY, { now: closeNow });
    let closed = await closing.closeMonthInBooks({ month: JUN, userId: owner.id, now: closeNow });
    ok("June can't close before May", !closed.ok && closed.error.includes("May 2025"), closed.ok ? "" : closed.error);
    closed = await closing.closeMonthInBooks({ month: MAY, userId: owner.id, now: closeNow });
    ok("May can't close with open tasks and no reason", !closed.ok && closed.error.includes("still open"), closed.ok ? "" : closed.error);
    ok("  and the lock hasn't moved", (await db.ledgerLock.findUnique({ where: { id: "global" } }))?.lockedUntil == null);
    closed = await closing.closeMonthInBooks({ month: MAY, userId: owner.id, override: `${TAG}: nothing happened in May`, now: closeNow });
    ok("with a written reason it closes", closed.ok && closed.openTasks > 0, closed.ok ? closed.openTasks : closed.error);
    const mayRow = await db.closeMonth.findUniqueOrThrow({ where: { month: MAY }, select: { id: true, status: true, closedById: true, note: true } });
    ok("  May is CLOSED, by whom, with the reason noted", mayRow.status === "CLOSED" && mayRow.closedById === owner.id && (mayRow.note ?? "").includes("nothing happened"));
    let lock = await db.ledgerLock.findUniqueOrThrow({ where: { id: "global" }, select: { lockedUntil: true, updatedById: true } });
    ok("  the books are locked to 31 May", months.dayKey(lock.lockedUntil!) === "2025-05-31");
    const audits = await db.auditLog.findMany({ where: { OR: [{ entityType: "LedgerLock" }, { entityType: "CloseMonth", entityId: mayRow.id }] }, orderBy: { createdAt: "asc" }, select: { entityType: true, entityLabel: true } });
    ok("  audited through the lock path, and the override with its reason", audits.some((a) => a.entityType === "LedgerLock" && a.entityLabel === "Locked the books to 2025-05-31 — closing May 2025") && audits.some((a) => a.entityType === "CloseMonth" && a.entityLabel.includes("reason:") && a.entityLabel.includes("nothing happened")), audits.map((a) => a.entityLabel).join(" | "));
    closed = await closing.closeMonthInBooks({ month: JUN, userId: owner.id, now: closeNow });
    ok("June with open tasks (flux, the tasks done by hand) and no reason: refused", !closed.ok && closed.error.includes("still open"));
    closed = await closing.closeMonthInBooks({ month: JUN, userId: owner.id, override: `${TAG}: GST and flux done offline`, now: closeNow });
    lock = await db.ledgerLock.findUniqueOrThrow({ where: { id: "global" }, select: { lockedUntil: true, updatedById: true } });
    ok("  with a reason June closes and the lock moves to 30 June", closed.ok && months.dayKey(lock.lockedUntil!) === "2025-06-30");
    ok("closing it again is refused", !(await closing.closeMonthInBooks({ month: JUN, userId: owner.id, override: "again", now: closeNow })).ok);
    const tryPost = async (date: Date) => {
      try {
        await db.$transaction(async (t) => {
          await journal.writeEntry(t, { date, narration: `${TAG} probe`, source: "MANUAL", userId: owner.id, lines: [{ accountId: rent.id, debit: 1, credit: 0 }, { accountId: clearing.id, debit: 0, credit: 1 }] });
          throw new Error("ROLLBACK");
        });
        return "posted";
      } catch (err) {
        return err instanceof Error && err.message === "ROLLBACK" ? "accepted" : "refused";
      }
    };
    ok("the lock at the month end: 12:00 UTC on 30 June is refused", (await tryPost(ist("2025-06-30T17:30:00"))) === "refused");
    ok("  23:59 IST on 30 June is refused", (await tryPost(ist("2025-06-30T23:59:00"))) === "refused");
    ok("  00:00 IST on 1 July is accepted (and rolled back)", (await tryPost(ist("2025-07-01T00:00:00"))) === "accepted");
    const lockAug = await moveBooksLock(db, { lockedUntil: "2025-08-31", note: `${TAG} by hand`, userId: owner.id, now: ist("2025-09-10T10:00:00") });
    await checklist.generateTasks(JUL, { now: ist("2025-09-10T10:00:00") });
    closed = await closing.closeMonthInBooks({ month: JUL, userId: owner.id, override: `${TAG}: July`, now: ist("2025-09-10T10:00:00") });
    lock = await db.ledgerLock.findUniqueOrThrow({ where: { id: "global" }, select: { lockedUntil: true, updatedById: true } });
    ok("closing July under a lock already at 31 August never loosens it", lockAug.ok && closed.ok && closed.lock === null && months.dayKey(lock.lockedUntil!) === "2025-08-31");
    closed = await closing.closeMonthInBooks({ month: month("2025-09"), userId: owner.id, override: "x", now: ist("2025-09-20T10:00:00") });
    ok("a month that hasn't finished can't close", !closed.ok && closed.error.includes("hasn't finished"), closed.ok ? "" : closed.error);
    // The books are locked to 31 August here. A month inside the lock was closed before the checklist:
    // opening it (a typed address) must give it no checklist, and none it has may block a later close.
    const JAN = month("2025-01");
    const janGen = await checklist.generateTasks(JAN, { now: ist("2025-09-10T10:00:00") });
    ok(
      "opening a month the books are locked through creates no checklist",
      janGen.created === 0 && (await db.closeTask.count({ where: { month: JAN } })) === 0 && !(await db.closeMonth.findUnique({ where: { month: JAN } })),
    );
    await db.closeTask.create({ data: { month: month("2025-02"), title: `${TAG} a stray task`, dueOn: utcDay(2025, 3, 5) } });
    const blocker = await checklist.earlierOpenMonth(month("2025-09"));
    ok("  and an open task in a locked month doesn't stand in front of a later close", blocker === null, blocker ? months.dayKey(blocker) : "none");

    section("Reopening cascades");
    ok("a reason is required", !(await closing.reopenMonthInBooks({ month: JUN, userId: owner.id, reason: " " })).ok);
    const reopened = await closing.reopenMonthInBooks({ month: JUN, userId: owner.id, reason: `${TAG}: a late bill` });
    ok("reopening June reopens June and July", reopened.ok && json(reopened.reopened) === json(["June 2025", "July 2025"]), reopened.ok ? reopened.reopened.join(", ") : reopened.error);
    const statuses = await db.closeMonth.findMany({ where: { month: { in: [MAY, JUN, JUL] } }, orderBy: { month: "asc" }, select: { status: true, reopenedAt: true } });
    ok("  May stays closed", json(statuses.map((s) => s.status)) === json(["CLOSED", "OPEN", "OPEN"]) && !!statuses[1]!.reopenedAt);
    lock = await db.ledgerLock.findUniqueOrThrow({ where: { id: "global" }, select: { lockedUntil: true, updatedById: true } });
    ok("  the lock loosens to 31 May, through the same path", months.dayKey(lock.lockedUntil!) === "2025-05-31");
    ok("  audited as a reopening", !!(await db.auditLog.findFirst({ where: { entityType: "LedgerLock", entityLabel: { startsWith: "Reopened the books to 2025-05-31 — reopening June 2025" } } })));
    ok("reopening a month that isn't closed is refused", !(await closing.reopenMonthInBooks({ month: JUN, userId: owner.id, reason: "x" })).ok);
    await db.fiscalYearClose.create({ data: { label: "2024-25", fromDate: utcDay(2024, 4, 1), toDate: utcDay(2025, 3, 31), netProfit: 0, closedById: owner.id } });
    await db.closeMonth.create({ data: { month: month("2025-03"), status: "CLOSED", closedAt: new Date(), closedById: owner.id } });
    const inYear = await closing.reopenMonthInBooks({ month: month("2025-03"), userId: owner.id, reason: "x" });
    ok("a month inside a closed financial year stays shut", !inYear.ok && inYear.error.includes("2024-25"), inYear.ok ? "" : inYear.error);

    // ── The nightly job ───────────────────────────────────────────────────────────────────────
    section("The nightly job");
    const rs4 = await db.revenueSchedule.create({
      data: {
        companyId: customer.id, kind: "RATABLE", status: "ACTIVE", amount: 1000, startDate: utcDay(2025, 8, 1), endDate: utcDay(2025, 9, 30), opening: true, createdById: owner.id,
        lines: { create: [{ month: month("2025-08"), amount: 500 }, { month: SEP, amount: 500 }] },
      },
      select: { id: true },
    });
    const oct2 = ist("2025-10-02T09:00:00");
    const nights = await Promise.all([nightly.runRevenueAndClose(oct2), nightly.runRevenueAndClose(oct2)]);
    ok("two heartbeats at once on 2 October: exactly one runs", nights.filter((n) => n.ran).length === 1, json(nights.map((n) => n.reason ?? "ran")));
    const night = nights.find((n) => n.ran)!;
    const jobRow = await db.dailyJobRun.findUnique({ where: { job_day: { job: "revenue-close", day: utcDay(2025, 10, 2) } } });
    ok("  its claim is the day's row, with how it went", !!jobRow && jobRow.ok === night.steps.every((s) => s.ok), jobRow?.error ?? "ok");
    ok("  every step timed and none failed", night.steps.every((s) => s.ok && typeof s.ms === "number"), night.steps.map((s) => `${s.step}${s.ok ? "" : ` FAILED ${s.error}`}`).join(", "));
    ok("  a third call the same day does nothing", !(await nightly.runRevenueAndClose(ist("2025-10-02T21:00:00"))).ran);
    ok("September's checklist is generated", (await db.closeTask.count({ where: { month: SEP } })) === (await db.closeTaskTemplate.count({ where: { active: true } })));
    const p1Posted = await db.accountingScheduleLine.findMany({ where: { scheduleId: p1.id, month: { in: [month("2025-08"), SEP] } }, select: { entry: { select: { createdById: true } } } });
    ok("prepaids posted through September, by the Automation account", p1Posted.length === 2 && p1Posted.every((l) => l.entry?.createdById === automation));
    const rs4Lines = await db.revenueScheduleLine.findMany({ where: { scheduleId: rs4.id }, select: { entry: { select: { createdById: true, source: true } } } });
    ok("revenue recognised through September, by the Automation account", rs4Lines.length === 2 && rs4Lines.every((l) => l.entry?.source === "REVENUE" && l.entry.createdById === automation), json(rs4Lines.map((l) => l.entry?.source ?? null)));
    ok("  and the checks the postings move are run again afterwards", night.steps.some((s) => s.step === "re-check after posting"));
    const told = async (type: "TASK_DUE" | "TASK_OVERDUE") => db.notification.findMany({ where: { userId: person2.id, type, link: { contains: "month=2025-09" } }, select: { title: true } });
    ok("the owner is told their bank task (due 1 October) is overdue", (await told("TASK_OVERDUE")).length === 1, (await told("TASK_OVERDUE")).map((n) => n.title).join(", "));
    ok("  and their GST task is due on 3 October", (await told("TASK_DUE")).length === 1, (await told("TASK_DUE")).map((n) => n.title).join(", "));
    const oct3 = await nightly.runRevenueAndClose(ist("2025-10-03T09:00:00"));
    ok("the next day's run tells them nothing twice", oct3.ran && (await told("TASK_OVERDUE")).length === 1 && (await told("TASK_DUE")).length === 1);
    ok("no mail leaves: notifyUser's email half went to the suite's stub", mailed.every((m) => typeof m.userId === "string"), `${mailed.length} recorded`);

    section("The add-on switched off");
    await runAsTenant(OFF, async () => {
      const rs5 = await db.revenueSchedule.create({
        data: { companyId: customer.id, kind: "RATABLE", status: "ACTIVE", amount: 700, startDate: utcDay(2025, 10, 1), endDate: utcDay(2025, 10, 31), opening: true, createdById: owner.id, lines: { create: [{ month: month("2025-10"), amount: 700 }] } },
        select: { id: true },
      });
      const nov = await nightly.runRevenueAndClose(ist("2025-11-03T09:00:00"));
      ok("with schedules still running, the job runs — but only the postings", nov.ran && !nov.steps.some((s) => ["seed templates", "evaluate checks", "notify owners"].includes(s.step) || s.step.startsWith("generate")), nov.steps.map((s) => s.step).join(", "));
      const octLine = await db.revenueScheduleLine.findFirstOrThrow({ where: { scheduleId: rs5.id }, select: { entryId: true } });
      const p1Oct = await db.accountingScheduleLine.findFirstOrThrow({ where: { scheduleId: p1.id, month: month("2025-10") }, select: { entryId: true } });
      ok("  October's revenue and prepaid are posted", !!octLine.entryId && !!p1Oct.entryId);
      ok("  and no October checklist is made", (await db.closeTask.count({ where: { month: month("2025-10") } })) === 0);
      await db.accountingSchedule.updateMany({ where: { status: "ACTIVE" }, data: { status: "CANCELLED" } });
      await db.revenueSchedule.updateMany({ where: { status: "ACTIVE" }, data: { status: "CANCELLED" } });
      const dec = await nightly.runRevenueAndClose(ist("2025-12-02T09:00:00"));
      ok("with nothing running, it does nothing and claims nothing", !dec.ran && !(await db.dailyJobRun.findUnique({ where: { job_day: { job: "revenue-close", day: utcDay(2025, 12, 2) } } })), dec.reason);

      section("A workspace whose plan leaves the add-on out");
      actor = owner;
      const refused = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
          return false;
        } catch (err) {
          return err instanceof ModuleNotInPlan;
        }
      };
      ok("the close's actions refuse", await refused(() => closeActions.getCloseMonth("2025-06")) && await refused(() => closeActions.closeMonth("2025-06", { override: "x" })));
      ok("  and so do the schedules'", await refused(() => scheduleActions.createSchedule({ kind: "ACCRUAL", name: "x", expenseAccountId: audit.id, amount: 1, startMonth: "2025-06", months: 1 })));
    });

    await settings.writeCloseSettings({ ...settings.CLOSE_SETTINGS_DEFAULTS, autoPost: false }, owner.id);
    const a3 = await schedules.createAccountingSchedule({ kind: "ACCRUAL", name: `${TAG} Cleaning`, expenseAccountId: audit.id, amount: 900, startMonth: "2025-11", months: 1 }, owner.id, ist("2025-11-20T10:00:00"));
    const noPost = await nightly.runRevenueAndClose(ist("2025-12-03T09:00:00"));
    const a3Line = a3.ok ? await db.accountingScheduleLine.findFirstOrThrow({ where: { scheduleId: a3.id }, select: { entryId: true } }) : null;
    ok("with automatic posting off, the checklist runs but nothing is posted", noPost.ran && !noPost.steps.some((s) => s.step === "recognise revenue") && a3Line?.entryId === null, noPost.steps.map((s) => s.step).join(", "));
    await settings.writeCloseSettings({ ...settings.CLOSE_SETTINGS_DEFAULTS }, owner.id);

    // ── Permissions ───────────────────────────────────────────────────────────────────────────
    section("Permissions");
    const junTask = await db.closeTask.findFirstOrThrow({ where: { month: JUN, autoCheck: null, status: "TODO" }, select: { id: true } });
    actor = sales;
    ok("a salesperson sees no close", (await closeActions.getCloseMonth("2025-06", { refresh: false })) === null && (await closeActions.listCloseTemplates()).length === 0);
    ok("  can't tick a task, explain a flux or post schedules", !(await closeActions.setTaskStatus(junTask.id, "DONE")).ok && !(await closeActions.explainFlux("2025-09", rent.id, "x")).ok && !(await scheduleActions.runSchedules({ throughMonth: "2025-06" })).ok);
    actor = clerk;
    const view = await closeActions.getCloseMonth("2025-06", { refresh: false });
    ok("the clerk (close.work) reads the month, and may work but not manage or close it", !!view && view.permissions.work && !view.permissions.manage && !view.permissions.close && view.tasks.length === 13, view ? json(view.progress) : "null");
    ok("  ticks a task", (await closeActions.setTaskStatus(junTask.id, "DONE", "Done offline")).ok);
    ok("  but can't change a template, the settings, or make a schedule", !(await closeActions.saveCloseTemplate({ title: "x" })).ok && !(await closeActions.saveCloseSettings({ ...settings.CLOSE_SETTINGS_DEFAULTS })).ok && !(await scheduleActions.createSchedule({ kind: "ACCRUAL", name: "x", expenseAccountId: audit.id, amount: 1, startMonth: "2025-06", months: 1 })).ok);
    ok("  nor close a month", !(await closeActions.closeMonth("2025-06", { override: "x" })).ok);
    ok("  an explanation over 1,000 characters is refused; one within is kept", !(await closeActions.explainFlux("2025-09", rent.id, "x".repeat(1001))).ok && (await closeActions.explainFlux("2025-09", rent.id, "Rent revised from September")).ok);
    ok("  runs a month's schedules, but not one that hasn't ended", (await scheduleActions.runSchedules({ throughMonth: "2025-06" })).ok && !(await scheduleActions.runSchedules({ throughMonth: "2099-01" })).ok);
    actor = manager;
    const made = await closeActions.saveCloseTemplate({ title: `${TAG} Review payroll variance`, dueDay: 5 });
    ok("the manager (close.manage) edits templates", made.ok);
    ok("  but closing a month also needs books.close", !(await closeActions.closeMonth("2025-06", { override: "x" })).ok);
    actor = owner;
    const byAction = await closeActions.closeMonth("2025-06", { override: `${TAG}: closed from the page` });
    ok("the super admin closes June from the page", byAction.ok && byAction.data.lockedUntil === "2025-06-30", byAction.ok ? byAction.data.lockedUntil : byAction.error);
    ok("  a month still to come is not shown", (await closeActions.getCloseMonth("2099-01")) === null);

    section("Close the Books' own lock form, now through the shared path");
    const tighten = await booksActions.setBooksLock({ lockedUntil: "2025-07-31", note: `${TAG} by hand` });
    const loosen = await booksActions.setBooksLock({ lockedUntil: "2025-06-30" });
    const lockAudits = await db.auditLog.findMany({ where: { entityType: "LedgerLock", userId: owner.id }, orderBy: { createdAt: "desc" }, take: 2, select: { entityLabel: true } });
    ok("it locks and loosens with the same wording", tighten.ok && loosen.ok && json(lockAudits.map((a) => a.entityLabel)) === json(["Reopened the books to 2025-06-30", "Locked the books to 2025-07-31"]), lockAudits.map((a) => a.entityLabel).join(" | "));
    const future = await booksActions.setBooksLock({ lockedUntil: "2099-01-31" });
    ok("  and still refuses a period that hasn't finished", !future.ok && future.error === "You can't lock a period that hasn't finished.");
    ok("  or anything that isn't a date", !(await booksActions.setBooksLock({ lockedUntil: "31/01/2025" })).ok);
    actor = clerk;
    ok("  or anybody without books.close", !(await booksActions.setBooksLock({ lockedUntil: "2025-05-31" })).ok);
    actor = owner;
    ok("  the lock is where the owner left it", months.dayKey((await db.ledgerLock.findUniqueOrThrow({ where: { id: "global" } })).lockedUntil!) === "2025-06-30");

    // ── An account a schedule uses ────────────────────────────────────────────────────────────
    section("An account a schedule uses can't be deleted");
    const spare = await acct("5950", "Spare", "EXPENSE");
    await schedules.createAccountingSchedule({ kind: "ACCRUAL", name: `${TAG} Future`, expenseAccountId: spare.id, amount: 100, startMonth: "2099-01", months: 1 }, owner.id);
    const deleted = await ledgerActions.deleteAccount(spare.id);
    ok("deleting it is refused with a message, not a foreign-key error", !deleted.ok && deleted.error.includes("schedule"), deleted.ok ? "" : deleted.error);
    ok("  and the account is still there", !!(await db.ledgerAccount.findUnique({ where: { id: spare.id } })));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
