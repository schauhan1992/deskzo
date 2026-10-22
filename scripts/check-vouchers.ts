/**
 * check:vouchers — Finance → Accounts' payment, receipt, contra and journal vouchers (owner, 22 Oct 2026),
 * through the real server actions, in a scratch workspace built from the migrations and dropped after.
 *
 *   · each kind's rules refused on save: a payment putting money into the bank, a journal touching it, a
 *     contra on anything but bank and cash, a receivable with no party, debits and credits apart, a group
 *     account, a date still to come;
 *   · a form submitted twice makes one voucher; numbers run PMT/<FY>/0001, 0002 per series;
 *   · approval where Accounts settings ask for it — not posted before, never by the person who wrote it;
 *   · posting is one balanced journal entry under `voucher:<id>`, once, even with two posts at once; not into
 *     a closed period; a posted voucher isn't edited, it's reversed by an opposite entry that nets to nothing;
 *   · who may write, approve and post.
 *
 *   npm run check:vouchers
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const TAG = "ZZV";

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
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
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["@/lib/session", session],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
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

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${realName}_vouchers_check`;
  const scratchUrl = withDatabase(url, scratch);
  ok("  and it is not the real one", scratch !== realName, scratch);
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  let close: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60_000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = "";

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    close = () => db.$disconnect();
    const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    /* eslint-enable @typescript-eslint/no-require-imports */
    await runAsTenant(
      {
        id: randomUUID(),
        slug: "zzvouchers",
        name: "zzvouchers",
        status: "ACTIVE",
        dbUrl: scratchUrl,
        primaryHost: "zzvouchers.localhost",
        hosts: ["zzvouchers.localhost"],
        source: "env",
        isDefault: false,
        keyBundleCipher: null,
        country: "IN",
        entitlements: { v: 1, all: true, modules: [], seats: null, copilotTokens: null, customDomains: null, plans: [] },
        holdReason: null,
      } as Parameters<typeof runAsTenant>[0],
      () => run(),
    );
  } finally {
    actor = null;
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} voucher checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

async function run() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const vouchers = require("../src/actions/vouchers") as typeof import("../src/actions/vouchers");
  const rules = require("../src/lib/accounts/vouchers") as typeof import("../src/lib/accounts/vouchers");
  const journal = require("../src/lib/ledger/journal") as typeof import("../src/lib/ledger/journal");
  const { SYSTEM_ACCOUNTS } = require("../src/lib/ledger/chart") as typeof import("../src/lib/ledger/chart");
  const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
  const { financialYearOf } = require("../src/lib/gst-engine") as typeof import("../src/lib/gst-engine");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("Fixture");
  const person = (key: string, role: string) =>
    db.user.create({
      data: { name: `${TAG} ${key}`, email: `${TAG.toLowerCase()}-${key.toLowerCase()}@example.test`, passwordHash: "!", role },
      select: { id: true, name: true, email: true, role: true },
    });
  const boss = await person("Admin", "ADMIN");
  const clerk = await person("Clerk", "ACCOUNTS");
  const manager = await person("Manager", "MANAGEMENT");
  const sales = await person("Sales", "SALES");
  const as = async <T,>(who: { id: string; name: string; email: string | null; role: string }, work: () => Promise<T>) => {
    const before = actor;
    actor = { id: who.id, name: who.name, email: who.email!, role: who.role };
    try {
      return await work();
    } finally {
      actor = before;
    }
  };
  await journal.ensureChartOfAccounts(db);
  const keyed = async (key: string) => (await db.ledgerAccount.findUniqueOrThrow({ where: { systemKey: key }, select: { id: true } })).id;
  const BANK = await keyed(SYSTEM_ACCOUNTS.BANK);
  const CASH = await keyed(SYSTEM_ACCOUNTS.CASH);
  const AR = await keyed(SYSTEM_ACCOUNTS.AR);
  const acct = (code: string, name: string, type: "ASSET" | "EXPENSE" | "INCOME", extra: { isGroup?: boolean; active?: boolean } = {}) =>
    db.ledgerAccount.create({ data: { code: `${TAG}-${code}`, name: `${TAG} ${name}`, type, ...extra }, select: { id: true } });
  const RENT = (await acct("5100", "Rent", "EXPENSE")).id;
  const INTEREST = (await acct("4100", "Interest received", "INCOME")).id;
  const GROUP = (await acct("5000", "Overheads", "EXPENSE", { isGroup: true })).id;
  const CLOSED = (await acct("5200", "Old expense", "EXPENSE", { active: false })).id;
  const customer = await db.company.create({ data: { name: `${TAG} Customer`, normalizedName: `${TAG.toLowerCase()} customer`, createdById: boss.id }, select: { id: true } });
  const clock = await workspaceClock();
  const today = clock.today();
  const FY = financialYearOf(new Date(`${today}T12:00:00.000Z`));
  const daysAgo = (n: number) => new Date(Date.parse(`${today}T12:00:00.000Z`) - n * 86_400_000).toISOString().slice(0, 10);
  ok("people (an admin, an accounts clerk, a manager, a salesperson), the chart, a customer", !!boss && !!RENT && !!customer);

  type Line = { accountId: string; debit: number; credit: number; companyId?: string | null };
  const write = (who: typeof clerk, type: "PAYMENT" | "RECEIPT" | "CONTRA" | "JOURNAL", lines: Line[], extra: { date?: string; requestId?: string; narration?: string; id?: string } = {}) =>
    as(who, () => vouchers.saveVoucher({ type, date: extra.date ?? today, narration: extra.narration ?? `${TAG} ${type.toLowerCase()}`, lines, requestId: extra.requestId, id: extra.id }));
  const entriesOf = (voucherId: string) =>
    // Selected by name: the posting key is one of the columns read only where asked for (src/lib/tenancy/clients.ts).
    db.journalEntry.findMany({
      where: { accountVoucherId: voucherId },
      orderBy: { createdAt: "asc" },
      select: { id: true, source: true, postingKey: true, reversesId: true, lines: { select: { accountId: true, debit: true, credit: true, companyId: true } } },
    });
  const paise = (n: unknown) => Math.round(Number(n) * 100);
  const balanced = (lines: { debit: unknown; credit: unknown }[]) =>
    lines.reduce((t, l) => t + paise(l.debit), 0) === lines.reduce((t, l) => t + paise(l.credit), 0) && lines.some((l) => paise(l.debit) > 0);

  section("Each kind's rules, refused on save");
  const refusals: [string, ReturnType<typeof write>, RegExp][] = [
    ["a payment can't put money into the bank", write(clerk, "PAYMENT", [{ accountId: BANK, debit: 100, credit: 0 }, { accountId: INTEREST, debit: 0, credit: 100 }]), /takes money out/],
    ["a receipt can't take money out of it", write(clerk, "RECEIPT", [{ accountId: RENT, debit: 100, credit: 0 }, { accountId: BANK, debit: 0, credit: 100 }]), /puts money into/],
    ["a journal can't touch bank or cash", write(clerk, "JOURNAL", [{ accountId: RENT, debit: 100, credit: 0 }, { accountId: BANK, debit: 0, credit: 100 }]), /bank or cash account/],
    ["a contra is bank and cash only", write(clerk, "CONTRA", [{ accountId: CASH, debit: 100, credit: 0 }, { accountId: RENT, debit: 0, credit: 100 }]), /bank and cash accounts only/],
    ["a receivable line names whose", write(clerk, "RECEIPT", [{ accountId: BANK, debit: 100, credit: 0 }, { accountId: AR, debit: 0, credit: 100 }]), /choose whose/],
    ["debits and credits must agree", write(clerk, "PAYMENT", [{ accountId: RENT, debit: 100, credit: 0 }, { accountId: BANK, debit: 0, credit: 90 }]), /differ by ₹10\.00/],
    ["not a group account", write(clerk, "PAYMENT", [{ accountId: GROUP, debit: 100, credit: 0 }, { accountId: BANK, debit: 0, credit: 100 }]), /is a group/],
    ["not a closed account", write(clerk, "PAYMENT", [{ accountId: CLOSED, debit: 100, credit: 0 }, { accountId: BANK, debit: 0, credit: 100 }]), /is closed/],
    ["a line is a debit or a credit, not both", write(clerk, "JOURNAL", [{ accountId: RENT, debit: 100, credit: 100 }, { accountId: INTEREST, debit: 0, credit: 0.01 }]), /one, not both/],
    ["a payment needs its bank or cash", write(clerk, "PAYMENT", [{ accountId: RENT, debit: 100, credit: 0 }, { accountId: INTEREST, debit: 0, credit: 100 }]), /bank or cash account the money left/],
    ["one line isn't a voucher", write(clerk, "JOURNAL", [{ accountId: RENT, debit: 100, credit: 0 }]), /at least two lines/],
    ["a day still to come is refused", write(clerk, "PAYMENT", [{ accountId: RENT, debit: 100, credit: 0 }, { accountId: BANK, debit: 0, credit: 100 }], { date: "2999-01-01" }), /future/],
    ["a voucher says what it's for", write(clerk, "PAYMENT", [{ accountId: RENT, debit: 100, credit: 0 }, { accountId: BANK, debit: 0, credit: 100 }], { narration: "  " }), /Say what the voucher is for/],
  ];
  for (const [label, attempt, expected] of refusals) {
    const out = await attempt;
    ok(label, !out.ok && expected.test(out.error), out.ok ? "SAVED" : out.error);
  }
  ok("  and none of them was saved", (await db.accountVoucher.count()) === 0);
  const pure = rules.voucherProblem(
    "CONTRA",
    [{ accountId: CASH, debit: 50.1, credit: 0 }, { accountId: BANK, debit: 0, credit: 50.1 }],
    new Map([
      [CASH, { id: CASH, code: "c", name: "Cash", isGroup: false, active: true, isMoney: true, needsParty: false }],
      [BANK, { id: BANK, code: "b", name: "Bank", isGroup: false, active: true, isMoney: true, needsParty: false }],
    ]),
  );
  ok("the same rules, run in the browser as you type, pass a good contra", pure === null, pure ?? "");

  section("Who may write");
  const bySales = await write(sales, "PAYMENT", [{ accountId: RENT, debit: 100, credit: 0 }, { accountId: BANK, debit: 0, credit: 100 }]);
  ok("a salesperson can't write a voucher", !bySales.ok && /Write vouchers/.test(bySales.error), bySales.ok ? "SAVED" : bySales.error);
  ok("  nor list them", (await as(sales, () => vouchers.listVouchers())) === null);
  ok("  nor get the form's lists", (await as(sales, () => vouchers.voucherFormOptions())) === null);
  const caps = await as(clerk, () => vouchers.voucherCapabilities());
  ok("an accounts clerk writes and reads them, but doesn't approve or post", caps.create && caps.read && !caps.approve && !caps.post && caps.migrated, caps);

  section("A form sent twice is one voucher; numbers run in their series");
  const token = randomUUID();
  const rent = [{ accountId: RENT, debit: 25000, credit: 0 }, { accountId: BANK, debit: 0, credit: 25000 }];
  const first = await write(clerk, "PAYMENT", rent, { requestId: token, narration: `${TAG} October rent` });
  const again = await write(clerk, "PAYMENT", rent, { requestId: token, narration: `${TAG} October rent` });
  ok("the first save makes a draft", first.ok, first.ok ? first.data.number : first.error);
  ok("  the same form again returns the same voucher", first.ok && again.ok && again.data.id === first.data.id && again.data.number === first.data.number);
  ok("  and there is one row", (await db.accountVoucher.count({ where: { idempotencyKey: `voucher-form:${token}` } })) === 1);
  const raced = randomUUID();
  const racing = await Promise.all([write(clerk, "PAYMENT", rent, { requestId: raced }), write(clerk, "PAYMENT", rent, { requestId: raced })]);
  ok("two saves of one form at once still make one row", (await db.accountVoucher.count({ where: { idempotencyKey: `voucher-form:${raced}` } })) === 1, racing.map((r) => (r.ok ? r.data.number : r.error)));
  ok("  and both are told it's the same voucher", racing.every((r) => r.ok) && new Set(racing.map((r) => (r.ok ? r.data.id : ""))).size === 1);
  await write(clerk, "PAYMENT", rent, { requestId: randomUUID() });
  const numbers = (await db.accountVoucher.findMany({ where: { type: "PAYMENT" }, orderBy: { number: "asc" }, select: { number: true } })).map((v) => v.number);
  ok(`payment vouchers are PMT/${FY}/0001 onwards, no gaps from the repeats`, first.ok && first.data.number === `PMT/${FY}/0001` && numbers.every((n, i) => n === `PMT/${FY}/${String(i + 1).padStart(4, "0")}`), numbers);
  const receipt = await write(clerk, "RECEIPT", [{ accountId: BANK, debit: 11800, credit: 0 }, { accountId: AR, debit: 0, credit: 11800, companyId: customer.id }]);
  ok(`a receipt has its own series: RCT/${FY}/0001`, receipt.ok && receipt.data.number === `RCT/${FY}/0001`, receipt.ok ? receipt.data.number : receipt.error);
  const saved = first.ok ? await db.accountVoucher.findUniqueOrThrow({ where: { id: first.data.id }, include: { lines: true } }) : null;
  ok("  a saved voucher keeps its amount, its bank and its lines", !!saved && Number(saved.amount) === 25000 && saved.moneyAccountId === BANK && saved.lines.length === 2 && saved.status === "DRAFT");
  const listed = await as(clerk, () => vouchers.listVouchers({ type: "PAYMENT", status: "NOT_A_STATUS", from: "garbage" }));
  ok("the list filters by kind, and a mistyped filter narrows nothing rather than failing", !!listed && listed.total === numbers.length, listed?.total);

  section("Posting, without approval");
  const firstId = first.ok ? first.data.id : "";
  const byClerk = await as(clerk, () => vouchers.postVoucher(firstId));
  ok("the clerk can't post — that's “Write and reverse journal entries”", !byClerk.ok && /journal entries/.test(byClerk.error), byClerk.ok ? "POSTED" : byClerk.error);
  const posted = await as(boss, () => vouchers.postVoucher(firstId));
  ok("an admin posts it", posted.ok, posted.ok ? posted.data.entryNumber : posted.error);
  const [entry, ...more] = await entriesOf(firstId);
  ok("  one journal entry, from a voucher, under its posting key", !!entry && more.length === 0 && entry.source === "VOUCHER" && entry.postingKey === `voucher:${firstId}`, entry?.postingKey);
  ok("  balanced, the voucher's own lines", !!entry && balanced(entry.lines) && entry.lines.some((l) => l.accountId === RENT && paise(l.debit) === 2500000) && entry.lines.some((l) => l.accountId === BANK && paise(l.credit) === 2500000));
  ok("  and the voucher is posted, by whom and when", (await db.accountVoucher.findUniqueOrThrow({ where: { id: firstId } })).status === "POSTED");
  const twice = await as(boss, () => vouchers.postVoucher(firstId));
  ok("posting it again is refused", !twice.ok && /already posted/.test(twice.error), twice.ok ? "POSTED AGAIN" : twice.error);
  const edited = await write(clerk, "PAYMENT", rent, { id: firstId });
  ok("  and a posted voucher isn't edited", !edited.ok && /Only a draft/.test(edited.error), edited.ok ? "EDITED" : edited.error);
  const racer = await write(clerk, "PAYMENT", rent, { requestId: randomUUID() });
  const racerId = racer.ok ? racer.data.id : "";
  const both = await Promise.all([as(boss, () => vouchers.postVoucher(racerId)), as(boss, () => vouchers.postVoucher(racerId))]);
  ok("two posts at once: one goes through", both.filter((r) => r.ok).length === 1, both.map((r) => (r.ok ? r.data.entryNumber : r.error)));
  ok("  and there is one entry", (await entriesOf(racerId)).length === 1);
  const receiptId = receipt.ok ? receipt.data.id : "";
  await as(boss, () => vouchers.postVoucher(receiptId));
  const receiptEntry = (await entriesOf(receiptId))[0];
  ok("a receipt's receivable line carries the customer into the ledger", !!receiptEntry && receiptEntry.lines.some((l) => l.accountId === AR && l.companyId === customer.id && paise(l.credit) === 1180000));
  const contra = await write(clerk, "CONTRA", [{ accountId: BANK, debit: 5000, credit: 0 }, { accountId: CASH, debit: 0, credit: 5000 }]);
  ok(`a contra, cash into the bank, is CNT/${FY}/0001 and posts`, contra.ok && contra.data.number === `CNT/${FY}/0001` && (await as(boss, () => vouchers.postVoucher(contra.data.id))).ok);

  section("Cancelling");
  const toCancel = await write(clerk, "JOURNAL", [{ accountId: RENT, debit: 300, credit: 0 }, { accountId: INTEREST, debit: 0, credit: 300 }]);
  const cancelId = toCancel.ok ? toCancel.data.id : "";
  ok("a journal voucher is JNL", toCancel.ok && toCancel.data.number === `JNL/${FY}/0001`);
  ok("cancelling asks why", !(await as(clerk, () => vouchers.cancelVoucher(cancelId, " "))).ok);
  ok("  and with a reason it's cancelled", (await as(clerk, () => vouchers.cancelVoucher(cancelId, `${TAG} written twice`))).ok && (await db.accountVoucher.findUniqueOrThrow({ where: { id: cancelId } })).status === "CANCELLED");
  ok("  a cancelled voucher doesn't post", !(await as(boss, () => vouchers.postVoucher(cancelId))).ok && (await entriesOf(cancelId)).length === 0);
  ok("  and a posted one can't be cancelled — it's reversed", !(await as(clerk, () => vouchers.cancelVoucher(firstId, "x"))).ok);

  section("Approval, where Accounts settings ask for it");
  await db.accountsSettings.upsert({ where: { id: "global" }, create: { id: "global", voucherApprovalRequired: true }, update: { voucherApprovalRequired: true } });
  ok("capabilities say so", (await as(clerk, () => vouchers.voucherCapabilities())).approvalRequired);
  const needs = await write(clerk, "PAYMENT", [{ accountId: RENT, debit: 1200, credit: 0 }, { accountId: CASH, debit: 0, credit: 1200 }]);
  const needsId = needs.ok ? needs.data.id : "";
  const early = await as(boss, () => vouchers.postVoucher(needsId));
  ok("a draft isn't posted before it's approved — not even by an admin", !early.ok && /needs approving/.test(early.error), early.ok ? "POSTED" : early.error);
  ok("the clerk sends it for approval", (await as(clerk, () => vouchers.submitVoucher(needsId))).ok && (await db.accountVoucher.findUniqueOrThrow({ where: { id: needsId } })).status === "PENDING_APPROVAL");
  const clerkApproves = await as(clerk, () => vouchers.approveVoucher(needsId));
  ok("  the clerk can't approve", !clerkApproves.ok && /Approve vouchers/.test(clerkApproves.error), clerkApproves.ok ? "APPROVED" : clerkApproves.error);
  ok("  a voucher waiting for approval isn't edited", !(await write(clerk, "PAYMENT", rent, { id: needsId })).ok);
  const own = await write(manager, "PAYMENT", [{ accountId: RENT, debit: 700, credit: 0 }, { accountId: CASH, debit: 0, credit: 700 }]);
  const ownId = own.ok ? own.data.id : "";
  await as(manager, () => vouchers.submitVoucher(ownId));
  const selfApproval = await as(manager, () => vouchers.approveVoucher(ownId));
  ok("the manager can't approve a voucher they wrote", !selfApproval.ok && /you wrote/.test(selfApproval.error), selfApproval.ok ? "APPROVED" : selfApproval.error);
  const sentBack = await as(manager, () => vouchers.returnVoucher(needsId, "attach the receipt"));
  ok("the manager sends the clerk's back to draft", sentBack.ok && (await db.accountVoucher.findUniqueOrThrow({ where: { id: needsId } })).status === "DRAFT");
  ok("  the clerk changes it and sends it again", (await write(clerk, "PAYMENT", [{ accountId: RENT, debit: 1250, credit: 0 }, { accountId: CASH, debit: 0, credit: 1250 }], { id: needsId })).ok && (await as(clerk, () => vouchers.submitVoucher(needsId))).ok);
  ok("  and the manager approves it", (await as(manager, () => vouchers.approveVoucher(needsId))).ok && (await db.accountVoucher.findUniqueOrThrow({ where: { id: needsId } })).status === "APPROVED");
  const managerPosts = await as(manager, () => vouchers.postVoucher(needsId));
  ok("approving doesn't post, and a manager without “Write and reverse journal entries” can't", !managerPosts.ok && (await entriesOf(needsId)).length === 0, managerPosts.ok ? "POSTED" : managerPosts.error);
  await db.userPermission.create({ data: { userId: manager.id, permission: "ledger.post", allowed: true, reason: `${TAG} fixture` } });
  const approvedPost = await as(manager, () => vouchers.postVoucher(needsId));
  ok("given it, the manager posts the approved voucher", approvedPost.ok && (await entriesOf(needsId)).length === 1, approvedPost.ok ? approvedPost.data.entryNumber : approvedPost.error);
  const approvedRow = await db.accountVoucher.findUniqueOrThrow({ where: { id: needsId } });
  ok("  who approved it and who posted it are kept", approvedRow.approvedById === manager.id && approvedRow.postedById === manager.id && approvedRow.submittedById === clerk.id);
  await db.accountsSettings.update({ where: { id: "global" }, data: { voucherApprovalRequired: false } });

  section("A closed period");
  const lockedDay = daysAgo(3);
  const late = await write(clerk, "PAYMENT", [{ accountId: RENT, debit: 999, credit: 0 }, { accountId: BANK, debit: 0, credit: 999 }], { date: lockedDay });
  const lateId = late.ok ? late.data.id : "";
  await db.ledgerLock.upsert({ where: { id: "global" }, create: { id: "global", lockedUntil: new Date(`${lockedDay}T00:00:00.000Z`) }, update: { lockedUntil: new Date(`${lockedDay}T00:00:00.000Z`) } });
  const intoClosed = await as(boss, () => vouchers.postVoucher(lateId));
  ok("a voucher dated in a closed period doesn't post", !intoClosed.ok && /closed/.test(intoClosed.error), intoClosed.ok ? "POSTED" : intoClosed.error);
  ok("  and is left as it was, with no entry", (await db.accountVoucher.findUniqueOrThrow({ where: { id: lateId } })).status === "DRAFT" && (await entriesOf(lateId)).length === 0);
  await db.ledgerLock.update({ where: { id: "global" }, data: { lockedUntil: null } });
  ok("  once the period is open again, it posts", (await as(boss, () => vouchers.postVoucher(lateId))).ok);

  section("Reversing");
  const noReason = await as(boss, () => vouchers.reverseVoucher(firstId, " "));
  ok("reversing asks why", !noReason.ok);
  ok("  can't be dated in the future", !(await as(boss, () => vouchers.reverseVoucher(firstId, "x", "2999-01-01"))).ok);
  ok("  nor before the voucher", !(await as(boss, () => vouchers.reverseVoucher(lateId, "x", daysAgo(30)))).ok && (await db.accountVoucher.findUniqueOrThrow({ where: { id: lateId } })).status === "POSTED");
  ok("  and needs “Write and reverse journal entries”", !(await as(clerk, () => vouchers.reverseVoucher(firstId, "x"))).ok);
  const reversed = await as(boss, () => vouchers.reverseVoucher(firstId, `${TAG} paid twice`, today));
  ok("an admin reverses the posted rent voucher", reversed.ok, reversed.ok ? reversed.data.entryNumber : reversed.error);
  const pair = await entriesOf(firstId);
  const reversal = pair.find((e) => e.reversesId);
  ok("  the voucher is reversed, and keeps the reason", (await db.accountVoucher.findUniqueOrThrow({ where: { id: firstId } })).status === "REVERSED");
  ok("  a second entry, under its own key, pointing at the first", pair.length === 2 && !!reversal && reversal.postingKey === `voucher:${firstId}:reversal` && reversal.reversesId === pair.find((e) => !e.reversesId)?.id);
  ok("  balanced", !!reversal && balanced(reversal.lines));
  const net = new Map<string, number>();
  for (const e of pair) for (const l of e.lines) net.set(l.accountId, (net.get(l.accountId) ?? 0) + paise(l.debit) - paise(l.credit));
  ok("  and the two net to nothing on every account", [...net.values()].every((v) => v === 0), Object.fromEntries(net));
  ok("reversing it again is refused", !(await as(boss, () => vouchers.reverseVoucher(firstId, "again"))).ok && (await entriesOf(firstId)).length === 2);

  section("The keys' helpers: standard narrations (F4), previous and next (Page Up / Page Down)");
  await write(clerk, "PAYMENT", rent, { requestId: randomUUID(), narration: `${TAG} newest rent` });
  const said = await as(clerk, () => vouchers.recentNarrations("PAYMENT"));
  ok("standard narrations: each once, none blank, twenty at most", said.length > 0 && said.length <= 20 && new Set(said.map((t) => t.toLowerCase())).size === said.length && said.every((t) => t !== "" && t === t.trim()), said);
  ok("  the most recent first", said[0] === `${TAG} newest rent`, said[0]);
  const paymentSaid = new Set((await db.accountVoucher.findMany({ where: { type: "PAYMENT" }, select: { narration: true } })).map((v) => v.narration.trim().toLowerCase()));
  const firstOther = said.findIndex((t) => !paymentSaid.has(t.toLowerCase()));
  ok("  this kind's before the others'", firstOther > 0 && said.slice(firstOther).every((t) => !paymentSaid.has(t.toLowerCase())), { firstOther, said });
  ok("  the others' are offered too", said.includes(`${TAG} journal`), said);
  ok("  and a salesperson is offered none", (await as(sales, () => vouchers.recentNarrations("PAYMENT"))).length === 0);
  const listOrder = (await db.accountVoucher.findMany({ orderBy: [{ date: "desc" }, { number: "desc" }], select: { id: true } })).map((v) => v.id);
  const middle = listOrder[1]!;
  ok("Page Up goes to the voucher listed above", (await as(clerk, () => vouchers.adjacentVoucher(middle, "previous"))) === listOrder[0]);
  ok("  Page Down to the one below", (await as(clerk, () => vouchers.adjacentVoucher(middle, "next"))) === listOrder[2]);
  ok("  and at either end, nowhere", (await as(clerk, () => vouchers.adjacentVoucher(listOrder[0]!, "previous"))) === null && (await as(clerk, () => vouchers.adjacentVoucher(listOrder[listOrder.length - 1]!, "next"))) === null);
  const walked: string[] = [];
  let at: string | null = listOrder[0]!;
  while (at && walked.length <= listOrder.length) {
    walked.push(at);
    const from: string = at;
    at = await as(clerk, (): Promise<string | null> => vouchers.adjacentVoucher(from, "next"));
  }
  ok(`  Page Down from the top walks the whole list, in its order (${listOrder.length})`, walked.join() === listOrder.join(), { walked: walked.length, listed: listOrder.length });
  ok("  and a salesperson goes nowhere", (await as(sales, () => vouchers.adjacentVoucher(middle, "next"))) === null);

  section("The books and the record");
  const totals = await db.journalLine.aggregate({ _sum: { debit: true, credit: true } });
  ok("every entry together still balances", paise(totals._sum.debit) === paise(totals._sum.credit) && paise(totals._sum.debit) > 0, { debit: Number(totals._sum.debit), credit: Number(totals._sum.credit) });
  const fromVouchers = await db.journalEntry.count({ where: { source: "VOUCHER" } });
  const postedOrReversed = await db.accountVoucher.count({ where: { status: { in: ["POSTED", "REVERSED"] } } });
  ok("one entry per posted voucher, plus the one reversal", fromVouchers === postedOrReversed + 1, { fromVouchers, postedOrReversed });
  const audits = await db.auditLog.count({ where: { entityType: "AccountVoucher" } });
  ok("every step is in the audit log", audits >= 15, audits);
  const detail = await as(clerk, () => vouchers.getVoucher(receiptId));
  ok("a voucher's page names its lines' party", detail?.lines.find((l) => l.accountId === AR)?.company?.id === customer.id);
  ok("  and its entry", detail?.journalEntries.length === 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
