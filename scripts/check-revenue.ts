/**
 * check:revenue — revenue recognition against a real database that is not the owner's.
 *
 * Builds a scratch workspace database beside the real one (from the migrations, as check:ledger-close
 * does), points the app's own `db` at it, and drives the real actions — issuing and cancelling
 * documents (src/actions/trade-document.ts) and every revenue action (src/actions/revenue.ts) — with
 * `Module._load` stubs for the session and Next's cache, as check:branches does. It drops the
 * database at the end, pass or fail, and reads the real one before and after to show nothing moved.
 *
 * What it proves (ZZREV fixture; every figure is the fixture's own):
 *
 *   · the posting split — Sales and Deferred Revenue — for a rupee invoice and a dollar one at its rate;
 *   · schedules made once, by day across a year, and an invoice at 00:30 IST on 1 July read as July's;
 *   · the run: one entry per month, nothing the second time, two runs at once posting each month once,
 *     and a closed month's revenue caught up in the first open month;
 *   · credit notes taking their share off a schedule, and cancelling one giving it back; a schedule
 *     credited to nil, and brought back;
 *   · cancelling an invoice netting Sales and Deferred Revenue to nil, with a credit note standing and
 *     then cancelled too;
 *   · a milestone recognised in the month (IST) its delivery is completed;
 *   · approval by a second person, refused to the maker; editing re-planning unposted months only; a
 *     changed amount and a hand cancellation posting their moves;
 *   · the opening wizard; the roll-forward agreeing with the ledger, and a hand journal showing as the
 *     difference; the add-on off (no new deferrals, old schedules still recognised) and out of the plan;
 *   · permission refusals, and customer scope.
 *
 * After every step the schedules and the ledger's Deferred Revenue must agree to the paisa.
 *
 *   npm run check:revenue
 *   TZ=UTC npm run check:revenue
 *   $env:TZ = "America/New_York"; npm run check:revenue     (PowerShell — Git Bash drops a TZ with "/")
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
const ist = (s: string) => new Date(`${s}+05:30`);
const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const TAG = "ZZREV";

// ── Who the actions think is calling ─────────────────────────────────────────────────────────────

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
const as = (who: Actor) => {
  actor = who;
};

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
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const navigation = {
  notFound: () => {
    throw new Error("NOT_FOUND_CALLED");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/navigation", navigation],
  ["@/lib/session", session],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/navigation"), navigation],
  [load.resolve("../src/lib/session"), session],
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

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

async function main() {
  const realUrl = process.env.DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);

  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_revenue`;
  const scratchUrl = withDatabase(realUrl, scratchName);
  ok("  and it is not the real one", scratchName !== realName, scratchName);

  const real = directClient(realUrl, { max: 1 });
  const realBefore = await snapshot(real);

  const admin = directClient(withDatabase(realUrl, "postgres"), { max: 1 });
  let appDb: { $disconnect: () => Promise<void> } | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60 * 1000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);

    // From here on the app's own `db` is the scratch database: the environment's workspace is the
    // scratch one, and the control plane is switched off by value (a Prisma client reloads .env for a
    // variable that is missing, never for one that is set).
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = "";
    process.env.DESKZO_TENANCY_FALLBACK = "legacy";

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    appDb = db;
    await run(scratchName);
  } finally {
    await appDb?.$disconnect().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const gone = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratchName}'`);
    ok("the scratch database is dropped", Number(gone[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  section("The real workspace was not touched");
  const realAfter = await snapshot(real);
  await real.$disconnect();
  ok("its lock is as it was", realAfter.lock === realBefore.lock, realAfter.lock ?? "no lock");
  ok("  its journal has the same entries", realAfter.entries === realBefore.entries, realAfter.entries);
  ok("  it has the same revenue schedules", realAfter.schedules === realBefore.schedules, realAfter.schedules);
  ok("  and nothing of this suite's is in it", realAfter.tagged === 0, realAfter.tagged);

  console.log(failures === 0 ? `\nAll ${passes} revenue checks passed.\n` : `\n${failures} check(s) FAILED, ${passes} passed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** What the suite must never change in the real workspace. Read-only. */
async function snapshot(client: PrismaClient) {
  const [lock, entries, schedules, docs, companies] = await Promise.all([
    client.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true, note: true } }),
    client.journalEntry.count(),
    client.revenueSchedule.count(),
    client.tradeDocument.count({ where: { docNumber: { startsWith: TAG } } }),
    client.company.count({ where: { name: { startsWith: TAG } } }),
  ]);
  return {
    lock: lock ? `${lock.lockedUntil?.toISOString() ?? "null"} ${lock.note ?? ""}` : null,
    entries,
    schedules,
    tagged: docs + companies,
  };
}

async function run(scratchName: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const journal = require("../src/lib/ledger/journal") as typeof import("../src/lib/ledger/journal");
  const docs = require("../src/actions/trade-document") as typeof import("../src/actions/trade-document");
  const revenue = require("../src/actions/revenue") as typeof import("../src/actions/revenue");
  const runLib = require("../src/lib/revenue/run") as typeof import("../src/lib/revenue/run");
  const reports = require("../src/lib/revenue/reports") as typeof import("../src/lib/revenue/reports");
  const deferral = require("../src/lib/revenue/deferral") as typeof import("../src/lib/revenue/deferral");
  const access = require("../src/lib/modules-access") as typeof import("../src/lib/modules-access");
  const tenancy = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const periods = require("../src/lib/revenue/periods") as typeof import("../src/lib/revenue/periods");
  const { SYSTEM_ACCOUNTS } = require("../src/lib/ledger/chart") as typeof import("../src/lib/ledger/chart");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const where = await db.$queryRaw<{ name: string }[]>`SELECT current_database()::text AS name`;
  ok("the app's db is the scratch database", where[0]?.name === scratchName, where[0]?.name);
  if (where[0]?.name !== scratchName) throw new Error("Refusing to go on: db is not the scratch database.");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sessionModule = require("../src/lib/session") as { requireUser: () => Promise<unknown> };
  ok("  the session stub is live", (await sessionModule.requireUser().catch((e: Error) => e.message)) === "The check called an action without saying who was calling it.");

  // ── Fixture ──────────────────────────────────────────────────────────────────────────────────
  section("Fixture");
  const user = async (key: string, role: string, extra: { isSuperAdmin?: boolean } = {}): Promise<Actor> => {
    const u = await db.user.create({
      data: { name: `${TAG} ${key}`, email: `${TAG.toLowerCase()}-${key.toLowerCase()}@example.test`, passwordHash: "!", role, ...extra },
      select: { id: true, name: true, email: true, role: true },
    });
    return u;
  };
  const sa = await user("Owner", "ADMIN", { isSuperAdmin: true });
  const maker = await user("Maker", "ACCOUNTS");
  const checker = await user("Checker", "ACCOUNTS");
  const clerk = await user("Clerk", "ACCOUNTS");
  const salesRep = await user("Sales", "SALES");
  const scoped = await user("Scoped", "ACCOUNTS");
  const grant = (u: Actor, permission: string, allowed = true) =>
    db.userPermission.create({ data: { userId: u.id, permission, allowed, reason: `${TAG} fixture`, grantedById: sa.id } });
  await grant(maker, "revenue.manage");
  await grant(checker, "revenue.manage");
  await grant(scoped, "companies.viewAll", false);

  const kaGst = await db.gstRegistration.create({ data: { gstin: "29AAACZ9999Z1Z1", stateCode: "29", code: "KA" } });
  const mhGst = await db.gstRegistration.create({ data: { gstin: "27AAACZ9999Z1Z5", stateCode: "27", code: "MH" } });
  const head = await db.branch.create({ data: { name: `${TAG} Head office`, code: "HO", isHeadOffice: true, gstRegistrationId: mhGst.id }, select: { id: true, gstRegistrationId: true } });
  const blr = await db.branch.create({ data: { name: `${TAG} Bengaluru`, code: "BLR", gstRegistrationId: kaGst.id }, select: { id: true, gstRegistrationId: true } });
  const company = (name: string, ownerUserId: string) =>
    db.company.create({ data: { name: `${TAG} ${name}`, normalizedName: `${TAG.toLowerCase()} ${name.toLowerCase()}`, createdById: sa.id, ownerUserId }, select: { id: true, name: true } });
  const c1 = await company("Acme Cloud", sa.id);
  const c2 = await company("Beta Services", scoped.id);
  const item = (name: string, type: "GOOD" | "SERVICE" | "SUBSCRIPTION", sku: string) =>
    db.item.create({ data: { name: `${TAG} ${name}`, sku: `${TAG}-${sku}`, type, sellingPrice: 1, createdById: sa.id, billingCycle: type === "SUBSCRIPTION" ? "ANNUAL" : null }, select: { id: true } });
  const cloud = await item("Cloud suite", "SUBSCRIPTION", "CLOUD");
  const support = await item("Support", "SERVICE", "SUPPORT");
  const laptop = await item("Laptop", "GOOD", "LAPTOP");
  ok("people, two branches under two GSTINs, two customers, three items", true);

  let seq = 0;
  type LineSpec = { name: string; itemId?: string | null; taxable: number; from?: string; to?: string; billingMilestoneId?: string };
  const draft = async (spec: {
    docType: "INVOICE" | "CREDIT_NOTE";
    issueDate: Date;
    companyId: string;
    branch: { id: string; gstRegistrationId: string | null };
    lines: LineSpec[];
    currency?: string;
    rate?: number;
    againstDocumentId?: string;
  }) => {
    seq += 1;
    const taxable = round2(spec.lines.reduce((t, l) => t + l.taxable, 0));
    const igst = round2(taxable * 0.18);
    return db.tradeDocument.create({
      data: {
        docNumber: `${TAG}-${spec.docType === "INVOICE" ? "INV" : "CN"}-${String(seq).padStart(3, "0")}`,
        docType: spec.docType,
        direction: "SALES",
        status: "DRAFT",
        companyId: spec.companyId,
        createdById: sa.id,
        issueDate: spec.issueDate,
        currency: spec.currency ?? "INR",
        exchangeRate: spec.rate ?? 1,
        subtotal: taxable,
        taxableValue: taxable,
        igstAmount: igst,
        total: round2(taxable + igst),
        branchId: spec.branch.id,
        gstRegistrationId: spec.branch.gstRegistrationId,
        againstDocumentId: spec.againstDocumentId ?? null,
        lines: {
          create: spec.lines.map((l, i) => ({
            name: l.name,
            itemId: l.itemId ?? null,
            quantity: 1,
            unitPrice: l.taxable,
            taxRatePercent: 18,
            taxableValue: l.taxable,
            igstAmount: round2(l.taxable * 0.18),
            lineTotal: round2(l.taxable * 1.18),
            sortOrder: i,
            servicePeriodFrom: l.from ? new Date(`${l.from}T00:00:00.000Z`) : null,
            servicePeriodTo: l.to ? new Date(`${l.to}T00:00:00.000Z`) : null,
            billingMilestoneId: l.billingMilestoneId ?? null,
          })),
        },
      },
      select: { id: true, docNumber: true, total: true },
    });
  };
  const issue = async (doc: { id: string; docNumber: string }) => {
    as(sa);
    const result = await docs.issueTradeDocument({ id: doc.id });
    if (!result.ok) throw new Error(`Issuing ${doc.docNumber} failed: ${result.error}`);
    return doc;
  };
  const cancelDoc = async (doc: { id: string; docNumber: string }) => {
    as(sa);
    const result = await docs.setTradeDocumentStatus(doc.id, "CANCELLED", "Raised in error");
    if (!result.ok) throw new Error(`Cancelling ${doc.docNumber} failed: ${result.error}`);
  };
  const liveEntry = (documentId: string) =>
    db.journalEntry.findFirst({ where: { documentId, source: { in: ["INVOICE", "CREDIT_NOTE"] }, reversesId: null }, select: { id: true, entryNumber: true } });
  const entryLines = (entryId: string) =>
    db.journalLine.findMany({ where: { entryId }, orderBy: { sortOrder: "asc" }, select: { debit: true, credit: true, companyId: true, branchId: true, gstRegistrationId: true, account: { select: { systemKey: true } } } });
  const onAccount = (lines: Awaited<ReturnType<typeof entryLines>>, key: string) =>
    round2(lines.filter((l) => l.account.systemKey === key).reduce((t, l) => t + Number(l.credit) - Number(l.debit), 0));
  const schedulesOf = (documentId: string) =>
    db.revenueSchedule.findMany({
      where: { documentId },
      select: { id: true, kind: true, status: true, amount: true, startDate: true, endDate: true, createdById: true, branchId: true, gstRegistrationId: true, companyId: true, lines: { orderBy: { month: "asc" }, select: { id: true, month: true, amount: true, entryId: true, catchUp: true } } },
    });
  const monthOf = (d: Date) => d.toISOString().slice(0, 7);
  const tie = async (label: string) => {
    const t = await reports.deferredTieOut(db);
    ok(`${label}: the schedules and Deferred Revenue agree`, t.difference === 0, `schedules ${money(t.schedules)} · ledger ${money(t.ledger)}`);
    return t;
  };
  const libRun = (throughMonth: string, by: Actor = checker) => runLib.runRevenueRecognition({ throughMonth, actorId: by.id });

  // ── The add-on's switch, and a legacy invoice ─────────────────────────────────────────────────
  section("1. The add-on's switch, as the ledger asks it");
  const agree = async (label: string, expected: boolean) => {
    const [mine, theirs] = await Promise.all([db.$transaction((tx) => deferral.revenueAddonOn(tx)), access.moduleAvailableForTenant("revenue_close")]);
    ok(`${label}: revenueAddonOn = moduleAvailableForTenant = ${expected}`, mine === expected && theirs === expected, `${mine}/${theirs}`);
  };
  await agree("in the plan and switched on", true);
  await db.systemModule.upsert({ where: { key: "revenue_close" }, create: { key: "revenue_close", enabled: false }, update: { enabled: false } });
  await agree("switched off in Settings", false);

  const legacy = await issue(await draft({
    docType: "INVOICE", issueDate: ist("2025-03-10T11:00:00"), companyId: c1.id, branch: blr,
    lines: [{ name: "Cloud suite 2025", itemId: cloud.id, taxable: 36500, from: "2025-01-01", to: "2025-12-31" }],
  }));
  const legacyLines = await entryLines((await liveEntry(legacy.id))!.id);
  ok("with the add-on off, a subscription invoice posts as it always has: all to Sales", onAccount(legacyLines, SYSTEM_ACCOUNTS.SALES) === 36500 && onAccount(legacyLines, SYSTEM_ACCOUNTS.DEFERRED_REVENUE) === 0);
  ok("  and makes no schedule", (await schedulesOf(legacy.id)).length === 0);
  await db.systemModule.update({ where: { key: "revenue_close" }, data: { enabled: true } });
  await agree("switched back on", true);

  // ── The opening wizard ────────────────────────────────────────────────────────────────────────
  section("2. Opening deferred revenue as at 31 May 2025 (D4)");
  as(clerk);
  const clerkOpening = await revenue.postOpening({ asAt: "2025-05", lines: [] });
  ok("somebody without revenue.manage can't open it", !clerkOpening.ok && /management/.test(clerkOpening.error), !clerkOpening.ok ? clerkOpening.error : "");
  as(maker);
  const candidates = await revenue.openingCandidates({ asAt: "2025-05" });
  const legacyCandidate = candidates.ok ? candidates.data.find((c) => c.documentId === legacy.id) : undefined;
  ok("the legacy invoice is a candidate, its subscription line at ₹36,500", legacyCandidate?.lines.length === 1 && legacyCandidate.lines[0].amount === 36500, JSON.stringify(legacyCandidate?.lines));
  const lineId = legacyCandidate!.lines[0].lineId;
  const preview = await revenue.previewOpening({ asAt: "2025-05", lines: [{ lineId, from: "2025-01-01", to: "2025-12-31" }] });
  const previewLine = preview.ok ? preview.data.lines[0] : null;
  ok("the preview: ₹36,500 over 2025 is ₹100 a day, so ₹21,400 (Jun–Dec, 214 days) is unearned at 31 May", previewLine?.unearned === 21400 && previewLine.problem === null, JSON.stringify({ unearned: previewLine?.unearned, problem: previewLine?.problem }));
  ok("  in seven months from June, ₹3,000 and ₹3,100 a month", previewLine?.months.length === 7 && previewLine.months[0].month === "2025-06" && previewLine.months[0].amount === 3000 && previewLine.months[1].amount === 3100);
  const badPreview = await revenue.previewOpening({ asAt: "2025-05", lines: [{ lineId, from: "2025-01-01", to: "2025-04-30" }] });
  ok("  a period over by the month end has nothing to open", badPreview.ok && /nothing to defer/.test(badPreview.data.lines[0].problem ?? ""), badPreview.ok ? badPreview.data.lines[0].problem : "");
  const opened = await revenue.postOpening({ asAt: "2025-05", lines: [{ lineId, from: "2025-01-01", to: "2025-12-31" }] });
  ok("the maker opens it", opened.ok && opened.data.total === 21400 && opened.data.schedules === 1, opened.ok ? opened.data.entryNumber : opened.error);
  const openingEntry = await db.journalEntry.findFirstOrThrow({ where: { narration: { startsWith: "Opening deferred revenue" } }, select: { id: true, date: true, source: true } });
  const openingLines = await entryLines(openingEntry.id);
  ok("  one entry, dated 31 May 2025 12:00 UTC (17:30 IST), source REVENUE", openingEntry.date.toISOString() === "2025-05-31T12:00:00.000Z" && openingEntry.source === "REVENUE");
  ok("  Dr Sales ₹21,400, Cr Deferred Revenue ₹21,400, under the invoice's branch and GSTIN",
    onAccount(openingLines, SYSTEM_ACCOUNTS.SALES) === -21400 && onAccount(openingLines, SYSTEM_ACCOUNTS.DEFERRED_REVENUE) === 21400 && openingLines.every((l) => l.branchId === blr.id && l.gstRegistrationId === kaGst.id && l.companyId === c1.id));
  const [openingSchedule] = await schedulesOf(legacy.id);
  ok("  a schedule, PENDING_APPROVAL, opening, starting 1 June 2025", openingSchedule?.status === "PENDING_APPROVAL" && openingSchedule.startDate?.toISOString() === "2025-06-01T00:00:00.000Z" && openingSchedule.lines.length === 7);
  const again = await revenue.postOpening({ asAt: "2025-05", lines: [{ lineId, from: "2025-01-01", to: "2025-12-31" }] });
  ok("  opening the same line again is refused", !again.ok && /already has a revenue schedule/.test(again.error), !again.ok ? again.error : "");
  const afterCandidates = await revenue.openingCandidates({ asAt: "2025-05" });
  ok("  and it is no longer a candidate", afterCandidates.ok && !afterCandidates.data.some((c) => c.documentId === legacy.id));
  await tie("After the opening");

  section("3. Approval by a second person");
  as(maker);
  const own = await revenue.approveSchedule(openingSchedule.id);
  ok("the maker can't approve their own", !own.ok && /somebody else/.test(own.error), !own.ok ? own.error : "");
  as(clerk);
  const noRight = await revenue.approveSchedule(openingSchedule.id);
  ok("  nor can somebody without revenue.manage", !noRight.ok, !noRight.ok ? noRight.error : "");
  const pendingRun = await libRun("2025-06");
  ok("a pending schedule recognises nothing, and the run says why", pendingRun.months.length === 0 && pendingRun.skipped.some((s) => /wait/.test(s.reason)), JSON.stringify(pendingRun.skipped));
  as(checker);
  const approved = await revenue.approveSchedule(openingSchedule.id);
  const afterApproval = await db.revenueSchedule.findUniqueOrThrow({ where: { id: openingSchedule.id }, select: { status: true, approvedById: true } });
  ok("  a second person with revenue.manage approves it", approved.ok && approved.data.reason === "manager" && afterApproval.status === "ACTIVE" && afterApproval.approvedById === checker.id);

  // ── The posting split ─────────────────────────────────────────────────────────────────────────
  section("4. Issuing an invoice: Sales and Deferred Revenue");
  const a1 = await issue(await draft({
    docType: "INVOICE", issueDate: ist("2025-06-10T10:00:00"), companyId: c1.id, branch: blr,
    lines: [
      { name: "Cloud suite, a year", itemId: cloud.id, taxable: 120000, from: "2025-07-01", to: "2026-06-30" },
      { name: "Laptop", itemId: laptop.id, taxable: 50000 },
      { name: "Setup in June", itemId: support.id, taxable: 10000, from: "2025-06-01", to: "2025-06-30" },
    ],
  }));
  const a1Entry = (await liveEntry(a1.id))!;
  const a1Lines = await entryLines(a1Entry.id);
  ok("₹1,80,000 invoiced: Cr Sales ₹60,000 (the laptop and June's setup), Cr Deferred Revenue ₹1,20,000",
    onAccount(a1Lines, SYSTEM_ACCOUNTS.SALES) === 60000 && onAccount(a1Lines, SYSTEM_ACCOUNTS.DEFERRED_REVENUE) === 120000, `${onAccount(a1Lines, SYSTEM_ACCOUNTS.SALES)} / ${onAccount(a1Lines, SYSTEM_ACCOUNTS.DEFERRED_REVENUE)}`);
  ok("  AR and the tax as they always were", onAccount(a1Lines, SYSTEM_ACCOUNTS.AR) === -212400 && onAccount(a1Lines, SYSTEM_ACCOUNTS.OUTPUT_IGST) === 32400);
  ok("  every line under the invoice's branch and GSTIN; Deferred Revenue names the customer",
    a1Lines.every((l) => l.branchId === blr.id && l.gstRegistrationId === kaGst.id) && a1Lines.find((l) => l.account.systemKey === SYSTEM_ACCOUNTS.DEFERRED_REVENUE)?.companyId === c1.id);
  const [a1Schedule, ...a1Extra] = await schedulesOf(a1.id);
  ok("one schedule — the subscription; the laptop and the June setup are recognised at once", !!a1Schedule && a1Extra.length === 0 && a1Schedule.kind === "RATABLE" && a1Schedule.status === "ACTIVE" && Number(a1Schedule.amount) === 120000);
  ok("  made by the issuer, under the invoice's branch and GSTIN", a1Schedule.createdById === sa.id && a1Schedule.branchId === blr.id && a1Schedule.gstRegistrationId === kaGst.id && a1Schedule.companyId === c1.id);
  const a1Months = a1Schedule.lines.map((l) => [monthOf(l.month), Number(l.amount)] as const);
  const expectedYear: [string, number][] = [
    ["2025-07", 10191.78], ["2025-08", 10191.78], ["2025-09", 9863.01], ["2025-10", 10191.78], ["2025-11", 9863.01], ["2025-12", 10191.78],
    ["2026-01", 10191.78], ["2026-02", 9205.48], ["2026-03", 10191.78], ["2026-04", 9863.01], ["2026-05", 10191.78], ["2026-06", 9863.03],
  ];
  ok("  by day across the year: 31/365 is ₹10,191.78, 28/365 ₹9,205.48, June takes the rounding (₹9,863.03)", JSON.stringify(a1Months) === JSON.stringify(expectedYear), a1Months.map(([m, a]) => `${m.slice(2)}:${a}`).join(" "));
  ok("  and the months add up to ₹1,20,000.00", Math.round(a1Months.reduce((t, [, a]) => t + a * 100, 0)) === 12000000);
  const reposted = await db.$transaction((tx) => journal.postDocumentToLedger(tx, a1.id, sa.id));
  ok("posting it again returns the same entry and makes no second schedule", reposted?.id === a1Entry.id && (await schedulesOf(a1.id)).length === 1 && (await db.journalEntry.count({ where: { documentId: a1.id } })) === 1);
  as(sa);
  const reissue = await docs.issueTradeDocument({ id: a1.id });
  ok("  and issuing it again is refused before it gets that far", !reissue.ok);

  const a2 = await issue(await draft({
    docType: "INVOICE", issueDate: ist("2025-06-12T15:00:00"), companyId: c1.id, branch: head, currency: "USD", rate: 83.47,
    lines: [
      { name: "Support, six months", itemId: support.id, taxable: 1000, from: "2025-06-15", to: "2025-12-14" },
      { name: "Adapter", itemId: laptop.id, taxable: 200 },
    ],
  }));
  const a2Lines = await entryLines((await liveEntry(a2.id))!.id);
  ok("a $1,200 invoice at ₹83.47 defers its $1,000 service line at the invoice's rate: ₹83,470, and ₹16,694 to Sales",
    onAccount(a2Lines, SYSTEM_ACCOUNTS.DEFERRED_REVENUE) === 83470 && onAccount(a2Lines, SYSTEM_ACCOUNTS.SALES) === 16694, `${onAccount(a2Lines, SYSTEM_ACCOUNTS.DEFERRED_REVENUE)} / ${onAccount(a2Lines, SYSTEM_ACCOUNTS.SALES)}`);
  ok("  AR is $1,416 × 83.47 = ₹1,18,193.52, as before", onAccount(a2Lines, SYSTEM_ACCOUNTS.AR) === -118193.52);
  const [a2Schedule] = await schedulesOf(a2.id);
  ok("  its schedule is ₹83,470 over 15 Jun–14 Dec, June 16/183 of it (₹7,297.92)", Number(a2Schedule.amount) === 83470 && Number(a2Schedule.lines[0].amount) === 7297.92 && a2Schedule.lines.length === 7, a2Schedule.lines.map((l) => Number(l.amount)).join(" "));

  const lateJune = await issue(await draft({
    docType: "INVOICE", issueDate: ist("2025-06-30T23:30:00"), companyId: c1.id, branch: blr,
    lines: [{ name: "July support", itemId: support.id, taxable: 3100, from: "2025-07-01", to: "2025-07-31" }],
  }));
  const firstJuly = await issue(await draft({
    docType: "INVOICE", issueDate: ist("2025-07-01T00:30:00"), companyId: c1.id, branch: blr,
    lines: [{ name: "July support", itemId: support.id, taxable: 3100, from: "2025-07-01", to: "2025-07-31" }],
  }));
  ok("an invoice at 23:30 IST on 30 June for July's support defers it to July", (await schedulesOf(lateJune.id)).length === 1);
  ok("  one at 00:30 IST on 1 July — still 30 June in UTC — is July's own, and recognised at once", (await schedulesOf(firstJuly.id)).length === 0 && ist("2025-07-01T00:30:00").toISOString().startsWith("2025-06-30"));

  // A project stage billed before its delivery.
  const project = await db.project.create({ data: { code: `${TAG}-P1`, companyId: c1.id, name: `${TAG} Rollout`, createdById: sa.id }, select: { id: true } });
  const uat = await db.projectMilestone.create({ data: { projectId: project.id, name: "UAT sign-off" }, select: { id: true } });
  const stage = await db.projectBillingMilestone.create({ data: { projectId: project.id, label: "40% on UAT", amount: 50000, deliveryMilestoneId: uat.id }, select: { id: true } });
  const a4 = await issue(await draft({
    docType: "INVOICE", issueDate: ist("2025-08-20T12:00:00"), companyId: c1.id, branch: blr,
    lines: [{ name: "40% on UAT", itemId: support.id, taxable: 50000, billingMilestoneId: stage.id }],
  }));
  const [a4Schedule] = await schedulesOf(a4.id);
  const a4Lines = await entryLines((await liveEntry(a4.id))!.id);
  ok("a stage invoiced before its delivery milestone is done defers as MILESTONE, with no months yet",
    a4Schedule?.kind === "MILESTONE" && a4Schedule.lines.length === 0 && onAccount(a4Lines, SYSTEM_ACCOUNTS.DEFERRED_REVENUE) === 50000 && onAccount(a4Lines, SYSTEM_ACCOUNTS.SALES) === 0);
  await tie("After issuing");

  // ── The run ───────────────────────────────────────────────────────────────────────────────────
  section("5. The run: one entry a month, and never twice");
  const first = await libRun("2025-09");
  ok("recognising through Sep 2025 posts June, July, August and September — one entry each", first.months.map((m) => m.month).join() === "2025-06,2025-07,2025-08,2025-09", first.months.map((m) => `${m.month} ${m.entryNumber} ₹${m.amount}`).join("; "));
  const julyEntry = await db.journalEntry.findUniqueOrThrow({ where: { id: first.months[1].entryId }, select: { date: true, narration: true, source: true, createdById: true } });
  ok("  July's is dated 31 Jul 2025 12:00 UTC (17:30 IST), source REVENUE, by whoever ran it", julyEntry.date.toISOString() === "2025-07-31T12:00:00.000Z" && julyEntry.source === "REVENUE" && julyEntry.createdById === checker.id);
  ok("  narrated 'Revenue recognised — Jul 2025 (4 schedules)'", julyEntry.narration === "Revenue recognised — Jul 2025 (4 schedules)", julyEntry.narration);
  const julyLines = await entryLines(first.months[1].entryId);
  ok("  Dr Deferred Revenue / Cr Sales, one pair per branch, GSTIN and customer (Bengaluru and head office)",
    julyLines.length === 4 && onAccount(julyLines, SYSTEM_ACCOUNTS.SALES) === first.months[1].amount && onAccount(julyLines, SYSTEM_ACCOUNTS.DEFERRED_REVENUE) === -first.months[1].amount && julyLines.every((l) => l.companyId === c1.id),
    julyLines.map((l) => `${l.account.systemKey}:${Number(l.debit) || -Number(l.credit)}@${l.branchId === blr.id ? "BLR" : "HO"}`).join(" "));
  const a1AfterRun = await schedulesOf(a1.id);
  ok("  each month posted is marked with its entry", a1AfterRun[0].lines.slice(0, 3).every((l) => l.entryId && !l.catchUp) && a1AfterRun[0].lines.slice(3).every((l) => !l.entryId));
  const second = await libRun("2025-09");
  ok("a second run finds nothing to do", second.months.length === 0, JSON.stringify(second.months));
  ok("  the July-only schedule is COMPLETED", (await schedulesOf(lateJune.id))[0].status === "COMPLETED");
  await tie("After the run");
  const roll = await reports.rollForward(db, "2025-09");
  ok("the roll-forward for Sep 2025 closes at the ledger's balance", roll.difference === 0 && roll.closing === roll.ledger, JSON.stringify(roll));

  section("6. A closed month catches up in the first open one");
  await db.ledgerLock.upsert({ where: { id: "global" }, create: { id: "global", lockedUntil: new Date("2025-10-31T00:00:00.000Z"), updatedById: sa.id }, update: { lockedUntil: new Date("2025-10-31T00:00:00.000Z") } });
  const catchUp = await libRun("2025-11");
  ok("with the books closed to 31 October, recognising through November writes one entry, in November", catchUp.months.length === 1 && catchUp.months[0].month === "2025-11" && catchUp.months[0].catchUpFrom.join() === "2025-10", JSON.stringify(catchUp.months));
  const novEntry = await db.journalEntry.findUniqueOrThrow({ where: { id: catchUp.months[0].entryId }, select: { date: true, narration: true } });
  ok("  dated 30 Nov 2025, saying what it caught up", novEntry.date.toISOString() === "2025-11-30T12:00:00.000Z" && /catch-up for Oct 2025/.test(novEntry.narration), novEntry.narration);
  const a1Catch = (await schedulesOf(a1.id))[0].lines;
  const oct = a1Catch.find((l) => monthOf(l.month) === "2025-10")!;
  const nov = a1Catch.find((l) => monthOf(l.month) === "2025-11")!;
  ok("  October's month is marked catchUp, November's is not, both in that entry", oct.catchUp && !nov.catchUp && oct.entryId === nov.entryId && oct.entryId === catchUp.months[0].entryId);
  await db.ledgerLock.update({ where: { id: "global" }, data: { lockedUntil: null } });

  section("7. Two runs at once post each month once");
  const dueBefore = await db.revenueScheduleLine.findMany({
    where: { entryId: null, month: { lte: periods.monthDate("2026-01") }, schedule: { status: "ACTIVE" } },
    select: { id: true, amount: true },
  });
  const dueTotal = round2(dueBefore.reduce((t, l) => t + Number(l.amount), 0));
  const [runA, runB] = await Promise.all([libRun("2026-01", checker), libRun("2026-01", maker)]);
  const postedTotal = round2([...runA.months, ...runB.months].reduce((t, m) => t + m.amount, 0));
  ok(`two runs through Jan 2026 at once post ₹${money(dueTotal)} between them, not twice`, postedTotal === dueTotal && dueTotal > 0, `A ${runA.months.map((m) => m.month).join(",")} · B ${runB.months.map((m) => m.month).join(",")}`);
  const stillDue = await db.revenueScheduleLine.count({ where: { entryId: null, month: { lte: periods.monthDate("2026-01") }, schedule: { status: "ACTIVE" } } });
  ok("  and nothing due is left behind", stillDue === 0);
  const revenueDebits = await db.journalLine.aggregate({
    where: { entry: { source: "REVENUE", narration: { startsWith: "Revenue recognised" }, date: { gte: ist("2025-12-01T00:00:00"), lt: ist("2026-02-01T00:00:00") } }, account: { systemKey: SYSTEM_ACCOUNTS.DEFERRED_REVENUE } },
    _sum: { debit: true },
  });
  ok("  the ledger agrees: December and January's recognition debits add up to the same", round2(Number(revenueDebits._sum.debit ?? 0)) === dueTotal, money(Number(revenueDebits._sum.debit ?? 0)));
  ok("  the dollar schedule, over by 14 December, is COMPLETED", (await schedulesOf(a2.id))[0].status === "COMPLETED");
  await tie("After the concurrent runs");

  // ── Credit notes ──────────────────────────────────────────────────────────────────────────────
  section("8. A credit note takes its share off the schedule");
  const beforeCredit = (await schedulesOf(a1.id))[0];
  const postedBefore = beforeCredit.lines.filter((l) => l.entryId).map((l) => `${monthOf(l.month)}:${Number(l.amount)}:${l.entryId}`);
  const unrecBefore = round2(beforeCredit.lines.filter((l) => !l.entryId).reduce((t, l) => t + Number(l.amount), 0));
  ok("A1's subscription has ₹49,315.08 left (Feb–Jun 2026)", unrecBefore === 49315.08, unrecBefore);
  const cn1 = await issue(await draft({ docType: "CREDIT_NOTE", issueDate: ist("2026-02-10T11:00:00"), companyId: c1.id, branch: blr, againstDocumentId: a1.id, lines: [{ name: "Goodwill credit", taxable: 18000 }] }));
  const cn1Lines = await entryLines((await liveEntry(cn1.id))!.id);
  ok("₹18,000 credited, shared 120:50:10 — ₹12,000 of it off the subscription's deferred revenue, ₹6,000 a sales return",
    onAccount(cn1Lines, SYSTEM_ACCOUNTS.DEFERRED_REVENUE) === -12000 && onAccount(cn1Lines, SYSTEM_ACCOUNTS.SALES_RETURNS) === -6000, `${onAccount(cn1Lines, SYSTEM_ACCOUNTS.DEFERRED_REVENUE)} / ${onAccount(cn1Lines, SYSTEM_ACCOUNTS.SALES_RETURNS)}`);
  const adjustment = await db.revenueScheduleAdjustment.findFirst({ where: { documentId: cn1.id }, select: { amount: true, scheduleId: true, reversedAt: true } });
  ok("  recorded against the schedule", Number(adjustment?.amount) === 12000 && adjustment?.scheduleId === a1Schedule.id);
  const afterCredit = (await schedulesOf(a1.id))[0];
  const unrecAfter = round2(afterCredit.lines.filter((l) => !l.entryId).reduce((t, l) => t + Number(l.amount), 0));
  ok("  its unposted months shrink to ₹37,315.08, in proportion", unrecAfter === 37315.08 && afterCredit.lines.filter((l) => !l.entryId).length === 5, afterCredit.lines.filter((l) => !l.entryId).map((l) => Number(l.amount)).join(" "));
  ok("  posted months untouched", JSON.stringify(afterCredit.lines.filter((l) => l.entryId).map((l) => `${monthOf(l.month)}:${Number(l.amount)}:${l.entryId}`)) === JSON.stringify(postedBefore));
  await tie("After the credit note");
  await cancelDoc(cn1);
  const restoredAdj = await db.revenueScheduleAdjustment.findFirst({ where: { documentId: cn1.id }, select: { reversedAt: true } });
  const afterRestore = (await schedulesOf(a1.id))[0];
  ok("cancelling the credit note gives the ₹12,000 back to the unposted months", !!restoredAdj?.reversedAt && round2(afterRestore.lines.filter((l) => !l.entryId).reduce((t, l) => t + Number(l.amount), 0)) === 49315.08 && afterRestore.status === "ACTIVE");
  await tie("After cancelling the credit note");

  section("9. Credited to nil, and brought back");
  const a10 = await issue(await draft({ docType: "INVOICE", issueDate: ist("2026-02-05T11:00:00"), companyId: c1.id, branch: blr, lines: [{ name: "Quarterly support", itemId: support.id, taxable: 30000, from: "2026-02-01", to: "2026-04-30" }] }));
  const cn10 = await issue(await draft({ docType: "CREDIT_NOTE", issueDate: ist("2026-02-06T11:00:00"), companyId: c1.id, branch: blr, againstDocumentId: a10.id, lines: [{ name: "Cancelled order", taxable: 30000 }] }));
  const cn10Lines = await entryLines((await liveEntry(cn10.id))!.id);
  const [a10Credited] = await schedulesOf(a10.id);
  ok("credited in full: all of it off Deferred Revenue, no sales return, the schedule CANCELLED with no months",
    onAccount(cn10Lines, SYSTEM_ACCOUNTS.DEFERRED_REVENUE) === -30000 && onAccount(cn10Lines, SYSTEM_ACCOUNTS.SALES_RETURNS) === 0 && a10Credited.status === "CANCELLED" && a10Credited.lines.length === 0);
  await cancelDoc(cn10);
  const [a10Back] = await schedulesOf(a10.id);
  ok("  cancelling that credit note brings it back ACTIVE, spread by day over Feb–Apr again",
    a10Back.status === "ACTIVE" && a10Back.lines.map((l) => `${monthOf(l.month)}:${Number(l.amount)}`).join(" ") === "2026-02:9438.2 2026-03:10449.44 2026-04:10112.36",
    a10Back.lines.map((l) => `${monthOf(l.month)}:${Number(l.amount)}`).join(" "));
  await tie("After bringing it back");

  // ── Cancelling an invoice ─────────────────────────────────────────────────────────────────────
  section("10. Cancelling an invoice nets Sales and Deferred Revenue to nil");
  const a3 = await issue(await draft({ docType: "INVOICE", issueDate: ist("2025-07-05T11:00:00"), companyId: c2.id, branch: blr, lines: [{ name: "Managed service H2", itemId: support.id, taxable: 60000, from: "2025-07-01", to: "2025-12-31" }] }));
  const cn3 = await issue(await draft({ docType: "CREDIT_NOTE", issueDate: ist("2025-08-10T11:00:00"), companyId: c2.id, branch: blr, againstDocumentId: a3.id, lines: [{ name: "Service credit", taxable: 6000 }] }));
  const midRun = await libRun("2025-09");
  const [a3Mid] = await schedulesOf(a3.id);
  const a3Posted = round2(a3Mid.lines.filter((l) => l.entryId).reduce((t, l) => t + Number(l.amount), 0));
  const a3Held = round2(a3Mid.lines.filter((l) => !l.entryId).reduce((t, l) => t + Number(l.amount), 0));
  ok("₹60,000 over Jul–Dec 2025, ₹6,000 credited, Jul–Sep recognised by the run", midRun.months.length === 3 && a3Posted > 0 && round2(a3Posted + a3Held) === 54000, `recognised ₹${money(a3Posted)}, left ₹${money(a3Held)}`);
  await cancelDoc(a3);
  const [a3After] = await schedulesOf(a3.id);
  ok("  the invoice cancelled: its schedule CANCELLED, unposted months gone", a3After.status === "CANCELLED" && a3After.lines.every((l) => l.entryId));
  const a3Entry = await db.journalEntry.findFirstOrThrow({ where: { documentId: a3.id, source: "INVOICE" }, select: { id: true } });
  const cn3Entry = await db.journalEntry.findFirstOrThrow({ where: { documentId: cn3.id, source: "CREDIT_NOTE" }, select: { id: true } });
  const cancellation = await db.journalEntry.findFirstOrThrow({ where: { narration: { startsWith: `Revenue reversed — invoice ${a3.docNumber}` } }, select: { id: true, date: true } });
  const cancellationLines = await entryLines(cancellation.id);
  ok("  one more entry takes back what the schedule recognised, and makes the credit a return",
    onAccount(cancellationLines, SYSTEM_ACCOUNTS.SALES) === -a3Posted && onAccount(cancellationLines, SYSTEM_ACCOUNTS.SALES_RETURNS) === -6000 && onAccount(cancellationLines, SYSTEM_ACCOUNTS.DEFERRED_REVENUE) === round2(a3Posted + 6000),
    cancellationLines.map((l) => `${l.account.systemKey}:${Number(l.debit) || -Number(l.credit)}`).join(" "));
  const a3Sum = async () => {
    const rows = await db.journalLine.findMany({
      where: {
        OR: [
          { entryId: { in: [a3Entry.id, cn3Entry.id] } },
          { entry: { reversesId: { in: [a3Entry.id, cn3Entry.id] } } },
          { entry: { source: "REVENUE" }, companyId: c2.id },
        ],
      },
      select: { debit: true, credit: true, account: { select: { systemKey: true } } },
    });
    const net = (key: string) => round2(rows.filter((r) => r.account.systemKey === key).reduce((t, r) => t + Number(r.debit) - Number(r.credit), 0));
    return { sales: net(SYSTEM_ACCOUNTS.SALES), deferred: net(SYSTEM_ACCOUNTS.DEFERRED_REVENUE), returns: net(SYSTEM_ACCOUNTS.SALES_RETURNS), ar: net(SYSTEM_ACCOUNTS.AR) };
  };
  const net1 = await a3Sum();
  ok("  over the invoice's life Sales and Deferred Revenue net to nil; the credit note stands as a ₹6,000 return",
    net1.sales === 0 && net1.deferred === 0 && net1.returns === 6000, JSON.stringify(net1));
  await cancelDoc(cn3);
  const net2 = await a3Sum();
  ok("  and once the credit note is cancelled too, everything nets to nil — returns and the receivable included",
    net2.sales === 0 && net2.deferred === 0 && net2.returns === 0 && net2.ar === 0, JSON.stringify(net2));
  await tie("After cancelling the invoice and its credit note");

  // ── Milestones ────────────────────────────────────────────────────────────────────────────────
  section("11. A milestone is recognised the month (IST) it is delivered");
  await db.projectMilestone.update({ where: { id: uat.id }, data: { completedAt: ist("2026-02-01T00:15:00") } });
  await libRun("2026-01");
  ok("UAT done at 00:15 IST on 1 February (31 January in UTC): recognising through January leaves it alone", (await schedulesOf(a4.id))[0].lines.length === 0);
  const febRun = await libRun("2026-02");
  const [a4Done] = await schedulesOf(a4.id);
  ok("  through February: one month, February, ₹50,000, posted — and the schedule COMPLETED",
    a4Done.lines.length === 1 && monthOf(a4Done.lines[0].month) === "2026-02" && Number(a4Done.lines[0].amount) === 50000 && !!a4Done.lines[0].entryId && a4Done.status === "COMPLETED",
    febRun.months.map((m) => `${m.month} ₹${m.amount}`).join("; "));
  await tie("After the milestone");

  // ── Editing ───────────────────────────────────────────────────────────────────────────────────
  section("12. Editing re-plans unposted months only, and needs approving again");
  const beforeEdit = (await schedulesOf(a1.id))[0];
  const postedSnapshot = JSON.stringify(beforeEdit.lines.filter((l) => l.entryId).map((l) => [monthOf(l.month), Number(l.amount), l.entryId]));
  const leftBeforeEdit = round2(beforeEdit.lines.filter((l) => !l.entryId).reduce((t, l) => t + Number(l.amount), 0));
  as(maker);
  const extended = await revenue.editSchedule(a1Schedule.id, { endDate: "2026-12-31" });
  const afterEdit = (await schedulesOf(a1.id))[0];
  ok("the maker extends the period to Dec 2026: saved, no entry", extended.ok && extended.data.status === "saved" && extended.data.entryNumber === null, extended.ok ? extended.data.status : extended.error);
  ok("  posted months exactly as they were", JSON.stringify(afterEdit.lines.filter((l) => l.entryId).map((l) => [monthOf(l.month), Number(l.amount), l.entryId])) === postedSnapshot);
  const unposted = afterEdit.lines.filter((l) => !l.entryId);
  ok(`  what was left (₹${money(leftBeforeEdit)}) spread over Mar–Dec 2026 by day`,
    round2(unposted.reduce((t, l) => t + Number(l.amount), 0)) === leftBeforeEdit && Math.abs(leftBeforeEdit - 40109.6) <= 0.02 && unposted.length === 10 && monthOf(unposted[0].month) === "2026-03" && monthOf(unposted[9].month) === "2026-12",
    unposted.map((l) => Number(l.amount)).join(" "));
  ok("  and it is PENDING_APPROVAL, with the maker as its maker", afterEdit.status === "PENDING_APPROVAL" && afterEdit.createdById === maker.id);
  const skippedRun = await libRun("2026-03");
  ok("  a run skips it while it waits", (await schedulesOf(a1.id))[0].lines.filter((l) => monthOf(l.month) === "2026-03")[0].entryId === null && skippedRun.skipped.some((s) => /approval/.test(s.reason)));
  const mine = await revenue.approveSchedule(a1Schedule.id);
  ok("  the maker can't approve their own edit", !mine.ok);
  as(checker);
  const theirs = await revenue.approveSchedule(a1Schedule.id);
  ok("  the checker can", theirs.ok && (await schedulesOf(a1.id))[0].status === "ACTIVE");

  as(maker);
  const ask = await revenue.editSchedule(a1Schedule.id, { amount: 130000 });
  ok("raising the amount by ₹10,000 asks first: ₹10,000 moves from Sales into Deferred Revenue", ask.ok && ask.data.status === "confirm" && ask.data.reclass === -10000, JSON.stringify(ask.ok ? ask.data : ask.error));
  ok("  and asking wrote nothing", (await schedulesOf(a1.id))[0].status === "ACTIVE" && Number((await schedulesOf(a1.id))[0].amount) === 120000);
  const wrongConfirm = await revenue.editSchedule(a1Schedule.id, { amount: 130000, confirmReclass: -9000 });
  ok("  a confirmation of another figure asks again", wrongConfirm.ok && wrongConfirm.data.status === "confirm");
  const remeasured = await revenue.editSchedule(a1Schedule.id, { amount: 130000, confirmReclass: -10000 });
  const remeasureEntry = remeasured.ok && remeasured.data.status === "saved" ? await db.journalEntry.findUnique({ where: { entryNumber: remeasured.data.entryNumber! }, select: { id: true, narration: true, date: true } }) : null;
  const remeasureLines = remeasureEntry ? await entryLines(remeasureEntry.id) : [];
  ok("  confirmed: Dr Sales ₹10,000 / Cr Deferred Revenue ₹10,000, and the months hold ₹10,000 more",
    onAccount(remeasureLines, SYSTEM_ACCOUNTS.DEFERRED_REVENUE) === 10000 && onAccount(remeasureLines, SYSTEM_ACCOUNTS.SALES) === -10000 &&
      round2((await schedulesOf(a1.id))[0].lines.filter((l) => !l.entryId).reduce((t, l) => t + Number(l.amount), 0)) === round2(leftBeforeEdit + 10000),
    remeasureEntry?.narration);
  await tie("After re-measuring");
  as(sa);
  const bySuper = await revenue.approveSchedule(a1Schedule.id);
  ok("the super admin approves somebody else's", bySuper.ok && bySuper.data.reason === "super-admin");
  const noteOnly = await revenue.editSchedule(a1Schedule.id, { note: "Reviewed by the owner" });
  ok("  a note alone changes nothing recognised, so needs no approval", noteOnly.ok && (await schedulesOf(a1.id))[0].status === "ACTIVE");
  await revenue.editSchedule(a1Schedule.id, { spreadEvenly: true });
  const ownSuper = await revenue.approveSchedule(a1Schedule.id);
  const selfAudit = await db.auditLog.findFirst({ where: { entityId: a1Schedule.id, entityLabel: { contains: "their own, as super admin" } }, select: { id: true } });
  ok("  and may approve their own, which the audit log says in as many words", ownSuper.ok && ownSuper.data.reason === "super-admin-own" && !!selfAudit);

  // ── Cancelling a schedule by hand ─────────────────────────────────────────────────────────────
  section("13. Cancelling a schedule by hand");
  const a11 = await issue(await draft({ docType: "INVOICE", issueDate: ist("2026-03-05T11:00:00"), companyId: c1.id, branch: blr, lines: [{ name: "Cloud suite, next year", itemId: cloud.id, taxable: 12000, from: "2026-03-01", to: "2027-02-28" }] }));
  const cn11 = await issue(await draft({ docType: "CREDIT_NOTE", issueDate: ist("2026-03-06T11:00:00"), companyId: c1.id, branch: blr, againstDocumentId: a11.id, lines: [{ name: "Discount", taxable: 1200 }] }));
  const [a11Schedule] = await schedulesOf(a11.id);
  as(clerk);
  const clerkCancel = await revenue.cancelSchedule(a11Schedule.id, "Customer left");
  ok("somebody without revenue.manage can't cancel one", !clerkCancel.ok);
  as(maker);
  const askCancel = await revenue.cancelSchedule(a11Schedule.id, "Customer left");
  ok("the first call asks: ₹10,800 would be recognised now", askCancel.ok && askCancel.data.status === "confirm" && askCancel.data.amount === 10800, JSON.stringify(askCancel.ok ? askCancel.data : askCancel.error));
  const staleCancel = await revenue.cancelSchedule(a11Schedule.id, "Customer left", 10000);
  ok("  a confirmation of another figure asks again", staleCancel.ok && staleCancel.data.status === "confirm");
  const cancelled = await revenue.cancelSchedule(a11Schedule.id, "Customer left", 10800);
  const cancelEntry = cancelled.ok && cancelled.data.status === "cancelled" ? await db.journalEntry.findUnique({ where: { entryNumber: cancelled.data.entryNumber! }, select: { id: true } }) : null;
  const cancelLines = cancelEntry ? await entryLines(cancelEntry.id) : [];
  ok("  confirmed: Dr Deferred Revenue ₹10,800 / Cr Sales ₹10,800, the schedule CANCELLED with no months left",
    onAccount(cancelLines, SYSTEM_ACCOUNTS.SALES) === 10800 && onAccount(cancelLines, SYSTEM_ACCOUNTS.DEFERRED_REVENUE) === -10800 && (await schedulesOf(a11.id))[0].status === "CANCELLED" && (await schedulesOf(a11.id))[0].lines.length === 0);
  await cancelDoc(cn11);
  const restoredNow = await db.journalEntry.findFirst({ where: { narration: { startsWith: `Restored revenue recognised — credit note ${cn11.docNumber}` } }, select: { id: true } });
  const restoredLines = restoredNow ? await entryLines(restoredNow.id) : [];
  ok("  its credit note cancelled afterwards: that ₹1,200 is recognised now too, the schedule stays CANCELLED",
    onAccount(restoredLines, SYSTEM_ACCOUNTS.SALES) === 1200 && (await schedulesOf(a11.id))[0].status === "CANCELLED");
  await tie("After the hand cancellation");

  // ── The roll-forward ──────────────────────────────────────────────────────────────────────────
  section("14. The roll-forward agrees with the ledger");
  const feb = await reports.rollForward(db, "2026-02");
  ok("Feb 2026: opening + deferred − recognised − credited ± opening = closing = the ledger",
    feb.difference === 0 && round2(feb.opening + feb.deferredFromInvoices - feb.recognised - feb.credited + feb.openingAdjustments - feb.cancelled) === feb.closing && feb.deferredFromInvoices === 30000 && feb.recognised > 0,
    JSON.stringify({ opening: feb.opening, deferred: feb.deferredFromInvoices, recognised: feb.recognised, credited: feb.credited, closing: feb.closing, ledger: feb.ledger }));
  const may25 = await reports.rollForward(db, "2025-05");
  ok("May 2025 shows the wizard's ₹21,400 as opening adjustments", may25.openingAdjustments === 21400 && may25.difference === 0);
  const accounts = await db.$transaction((tx) => journal.resolveAccounts(tx, [SYSTEM_ACCOUNTS.SALES, SYSTEM_ACCOUNTS.DEFERRED_REVENUE]));
  const handJournal = (debit: string, credit: string) =>
    db.$transaction((tx) => journal.writeEntry(tx, {
      date: ist("2026-02-15T12:00:00"), narration: `${TAG} hand journal`, source: "MANUAL", userId: sa.id,
      lines: [{ accountId: accounts.get(debit as never)!, debit: 1, credit: 0 }, { accountId: accounts.get(credit as never)!, debit: 0, credit: 1 }],
    }));
  await handJournal(SYSTEM_ACCOUNTS.SALES, SYSTEM_ACCOUNTS.DEFERRED_REVENUE);
  const withHand = await reports.rollForward(db, "2026-02");
  ok("a ₹1 hand journal to Deferred Revenue shows as the difference, in the month", withHand.difference === 1 && withHand.unexplained.inMonth === 1, JSON.stringify(withHand.unexplained));
  ok("  and the schedules no longer tie to the ledger", (await reports.deferredTieOut(db)).difference === 1);
  await handJournal(SYSTEM_ACCOUNTS.DEFERRED_REVENUE, SYSTEM_ACCOUNTS.SALES);
  ok("  taken back out, both agree again", (await reports.rollForward(db, "2026-02")).difference === 0 && (await reports.deferredTieOut(db)).difference === 0);

  // ── The add-on off, and out of the plan ───────────────────────────────────────────────────────
  section("15. The add-on off: nothing new deferred, old schedules still recognised");
  await db.systemModule.update({ where: { key: "revenue_close" }, data: { enabled: false } });
  const offInvoice = await issue(await draft({ docType: "INVOICE", issueDate: ist("2026-04-02T11:00:00"), companyId: c1.id, branch: blr, lines: [{ name: "Cloud suite, switched off", itemId: cloud.id, taxable: 24000, from: "2026-04-01", to: "2027-03-31" }] }));
  const offLines = await entryLines((await liveEntry(offInvoice.id))!.id);
  ok("switched off: a new subscription invoice goes to Sales, with no schedule", onAccount(offLines, SYSTEM_ACCOUNTS.SALES) === 24000 && (await schedulesOf(offInvoice.id)).length === 0);
  const offRun = await libRun("2026-04");
  ok("  while the run still recognises the schedules there are", offRun.months.length > 0 && offRun.months.every((m) => m.amount > 0), offRun.months.map((m) => `${m.month} ₹${m.amount}`).join("; "));
  await db.systemModule.update({ where: { key: "revenue_close" }, data: { enabled: true } });
  const envTenant = await tenancy.currentTenant();
  const narrow = { ...envTenant, entitlements: { v: 1 as const, all: false, modules: ["accounting", "sales_documents", "purchase_documents", "receivables", "payments", "items"], seats: null, copilotTokens: null, customDomains: null, plans: [] } };
  await tenancy.runAsTenant(narrow, async () => {
    const [mineOff, theirsOff] = await Promise.all([db.$transaction((tx) => deferral.revenueAddonOn(tx)), access.moduleAvailableForTenant("revenue_close")]);
    ok("out of the plan: revenueAddonOn = moduleAvailableForTenant = false", !mineOff && !theirsOff);
    as(maker);
    let refused = "";
    try {
      await revenue.revenueRun({ throughMonth: "2026-05" });
    } catch (e) {
      refused = e instanceof Error ? e.message : String(e);
    }
    ok("  the revenue actions refuse", /not part of this workspace's plan/.test(refused), refused);
    let listRefused = "";
    try {
      await revenue.listSchedules();
    } catch (e) {
      listRefused = e instanceof Error ? e.message : String(e);
    }
    ok("  reads included", /not part of this workspace's plan/.test(listRefused));
    const planless = await libRun("2026-05", sa);
    ok("  but the run itself still finishes existing schedules", planless.months.length === 1 && planless.months[0].month === "2026-05", planless.months.map((m) => `${m.month} ₹${m.amount}`).join("; "));
  });
  await tie("After the add-on off and out of the plan");

  // ── Permissions and scope ─────────────────────────────────────────────────────────────────────
  section("16. Who may do what");
  as(clerk);
  const clerkRun = await revenue.revenueRun({ throughMonth: "2026-05" });
  ok("revenue.viewReports alone can't run recognition", !clerkRun.ok && /management/.test(clerkRun.error));
  const clerkEdit = await revenue.editSchedule(a10Back.id, { note: "x" });
  ok("  nor edit a schedule", !clerkEdit.ok);
  const clerkList = await revenue.listSchedules();
  ok("  but can read the list", clerkList.total >= 8, clerkList.total);
  as(salesRep);
  let salesRefused = "";
  try {
    await revenue.listSchedules();
  } catch (e) {
    salesRefused = e instanceof Error ? e.message : String(e);
  }
  ok("a salesperson can't read revenue at all", /permission/.test(salesRefused), salesRefused);
  as(scoped);
  const scopedList = await revenue.listSchedules();
  ok("somebody limited to their own accounts sees only those customers' schedules", scopedList.rows.length > 0 && scopedList.rows.every((r) => r.companyId === c2.id), scopedList.rows.map((r) => r.companyName).join(", "));
  ok("  not another customer's schedule", (await revenue.getSchedule(a1Schedule.id)) === null);
  ok("  nor another customer's revenue", (await revenue.customerRevenue(c1.id)) === null);
  as(maker);
  const now = new Date();
  const thisMonth = periods.monthKeyAt(now);
  const notOver = await revenue.revenueRun({ throughMonth: thisMonth });
  ok(`recognising through the current month (${thisMonth}) is refused`, !notOver.ok && /isn't over/.test(notOver.error));
  const crafted = await revenue.revenueRun({ throughMonth: "2026-13" });
  ok("  and a month that isn't one", !crafted.ok);
  const upToDate = await revenue.revenueRun({ throughMonth: periods.lastCompletedMonth(now) });
  ok(`through ${periods.lastCompletedMonth(now)} it runs`, upToDate.ok, upToDate.ok ? upToDate.data.months.map((m) => m.month).join(",") : upToDate.error);

  section("17. The screens' reads");
  as(checker);
  const detail = await revenue.getSchedule(a1Schedule.id);
  ok("a schedule's detail lists its months with their entries, and what the viewer may do",
    !!detail && detail.months.length === 18 && detail.months.filter((m) => m.posted).every((m) => !!m.entry?.entryNumber) && detail.viewer.mayManage && detail.adjustments.length === 1,
    `${detail?.months.length} months, ${detail?.adjustments.length} credit note`);
  const tieNow = await reports.deferredTieOut(db);
  const wf = await revenue.waterfall({ by: "customer", months: 12 });
  ok("the waterfall's total is everything still deferred — the remaining performance obligation", wf.totals.total === tieNow.schedules && wf.months.length === 12, `₹${money(wf.totals.total)}`);
  const byItem = await revenue.waterfall({ by: "item", months: 24 });
  ok("  by item, over 24 months, the same total", byItem.totals.total === tieNow.schedules && byItem.months.length === 24);
  const card = await revenue.customerRevenue(c1.id);
  const c1Deferred = round2((await db.revenueSchedule.findMany({ where: { companyId: c1.id, status: { in: ["ACTIVE", "PENDING_APPROVAL"] } }, select: { lines: { where: { entryId: null }, select: { amount: true } } } })).flatMap((s) => s.lines).reduce((t, l) => t + Number(l.amount), 0));
  ok("a customer's card: recognised = invoiced − credited − deferred, deferred = its schedules' balance",
    !!card && card.deferred === c1Deferred && card.recognised === round2(card.invoiced - card.credited - card.deferred) && card.invoiced > 0,
    card ? JSON.stringify({ invoiced: card.invoiced, credited: card.credited, deferred: card.deferred, recognised: card.recognised, mrr: card.mrr }) : "");
  const rf = await revenue.rollForward("2026-03");
  ok("the roll-forward action carries the tie-out", rf.difference === 0 && rf.tieOut.difference === 0);

  section("Every entry balances");
  const unbalanced = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM (SELECT l."entryId" FROM journal_lines l GROUP BY l."entryId" HAVING SUM(l.debit) <> SUM(l.credit)) x`;
  ok("every entry in the scratch books balances", Number(unbalanced[0]?.n ?? 1) === 0);
  const twice = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM revenue_schedule_lines WHERE "entryId" IS NOT NULL AND "postedAt" IS NULL`;
  ok("every posted month says when", Number(twice[0]?.n ?? 1) === 0);
  await tie("At the end");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
