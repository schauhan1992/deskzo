/**
 * check:expense-approvals — expense claims in HR, approved by HR, then in Accounts (owner, 19 Oct 2026).
 *
 *   · Everybody claims their official expenses under People › Expenses; the menu has it there, and
 *     Accounting has Expense claims while Expenses is on.
 *   · Who approves is the company's choice — HR (the default), the reporting manager, or the manager
 *     and then HR — snapshotted onto each claim when it is submitted. At HR's step HR alone decides;
 *     nobody decides their own; the manager's yes on a manager-then-HR claim hands it to HR and books
 *     nothing.
 *   · An approved claim is booked to the ledger and shows in Accounting › Expense claims, To pay; paying
 *     it books the payment and moves it to Paid. Nothing unapproved shows there, and nobody but Accounts
 *     (and whoever reads every claim) sees that list.
 *
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:expense-approvals
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

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
  section("The rules");
  const rules = load("../src/lib/expense-approval") as typeof import("../src/lib/expense-approval");
  ok("no setting is HR", rules.DEFAULT_EXPENSE_APPROVAL_FLOW === "HR");
  ok("HR: every claim goes to HR, manager or not", rules.firstApprovalStep("HR", true) === "HR" && rules.firstApprovalStep("HR", false) === "HR");
  ok("the manager: to the manager", rules.firstApprovalStep("MANAGER", true) === "MANAGER" && rules.firstApprovalStep("MANAGER", false) === "MANAGER");
  ok("the manager then HR: the manager first — or HR, for somebody with no manager", rules.firstApprovalStep("MANAGER_THEN_HR", true) === "MANAGER" && rules.firstApprovalStep("MANAGER_THEN_HR", false) === "HR");
  ok("a yes at the manager's step of manager-then-HR hands it to HR", rules.afterApproval("MANAGER_THEN_HR", "MANAGER") === "to-hr");
  ok("  every other yes approves it — HR's, a manager-only claim's, a claim from before the rule", rules.afterApproval("MANAGER_THEN_HR", "HR") === "approved" && rules.afterApproval("HR", "HR") === "approved" && rules.afterApproval("MANAGER", "MANAGER") === "approved" && rules.afterApproval(null, null) === "approved");
  const decide = (o: Partial<Parameters<typeof rules.mayDecideExpense>[0]>) =>
    rules.mayDecideExpense({ viewerId: "v", claimantId: "c", step: "HR", approverUserId: null, holdsHrApproval: false, holdsAnyClaimApproval: false, ...o });
  ok("at HR's step: HR decides", decide({ holdsHrApproval: true }));
  ok("  and nobody else — not whoever may approve any claim, not a manager", !decide({ holdsAnyClaimApproval: true }) && !decide({ approverUserId: "v" }));
  ok("at the manager's step: the manager it went to, or whoever may approve any claim", decide({ step: "MANAGER", approverUserId: "v" }) && decide({ step: "MANAGER", holdsAnyClaimApproval: true }));
  ok("  not HR as such", !decide({ step: "MANAGER", approverUserId: "m", holdsHrApproval: true }));
  ok("never one's own claim", !decide({ viewerId: "c", holdsHrApproval: true, holdsAnyClaimApproval: true }) && !decide({ viewerId: "c", step: "MANAGER", approverUserId: "c" }));

  section("Where it is");
  const { getModuleDefinition } = load("../src/lib/modules") as typeof import("../src/lib/modules");
  ok("Expenses is in HR's part of the menu", getModuleDefinition("expenses")?.navGroup === "People");
  const accountsLink = getModuleDefinition("accounting")?.navItems.find((i) => i.href === "/accounting/expense-claims");
  ok("Accounting has Expense claims, for whoever pays claims or reads them all, while Expenses is on", !!accountsLink && accountsLink.alsoNeeds === "expenses" && JSON.stringify(accountsLink.permission) === JSON.stringify(["expenses.reimburse", "expenses.viewAll"]));
  const { buildNavigation } = load("../src/lib/navigation") as typeof import("../src/lib/navigation");
  const hrefs = (open: string[]) => buildNavigation({ openModules: open, permissions: ["expenses.reimburse", "ledger.viewReports", "section.accounting", "section.expenses", "section.hr"], country: "IN" }).flatMap((s) => s.items.map((i) => i.href));
  ok("  shown with both open", hrefs(["accounting", "expenses"]).includes("/accounting/expense-claims"));
  ok("  not with Expenses off", !hrefs(["accounting"]).includes("/accounting/expense-claims"));
  const people = buildNavigation({ openModules: ["hr", "expenses"], permissions: ["section.hr", "section.expenses"], country: "IN" }).find((s) => s.group === "People");
  ok("  and People lists Expenses", !!people?.items.some((i) => i.href === "/expenses"));
  const { getPermissionDefinition } = load("../src/lib/permissions") as typeof import("../src/lib/permissions");
  const hrPermission = getPermissionDefinition("hr.approveExpenses");
  ok("“Approve expense claims (HR)” is a permission the HR roles and Management hold to begin with", !!hrPermission && ["HR", "HR_HEAD", "MANAGEMENT"].every((r) => (hrPermission.defaultRoles as readonly string[]).includes(r)));
  ok("  in the HR presets", (read("src/lib/authz/presets.ts").match(/"hr\.approveExpenses"/g) ?? []).length === 3);
  ok("Settings › People › Expense approvals, HR's to set", read("src/lib/settings/catalogue.ts").includes('href: "/settings/expense-approvals"') && read("src/app/(dashboard)/settings/expense-approvals/page.tsx").includes('settingsKey="expense-approvals"'));
  ok("the Expenses page opens on your own claims, with To approve and All", read("src/app/(dashboard)/expenses/page.tsx").includes('{ key: "mine", label: "My expenses" }'));

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${realName}_expappr`;
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  let close: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, scratch) }, timeout: 10 * 60_000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);
    process.env.DATABASE_URL = withDatabase(url, scratch);
    process.env.CONTROL_DATABASE_URL = "";

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    close = () => db.$disconnect();
    const expenses = require("../src/actions/expense") as typeof import("../src/actions/expense");
    /* eslint-enable @typescript-eslint/no-require-imports */

    const person = (name: string, role: string, extra: Record<string, unknown> = {}) =>
      db.user.create({
        data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zz-expenses.in`, passwordHash: "!", role, ...extra },
        select: { id: true, name: true, email: true, role: true },
      });
    const boss = await person("Zz Boss", "ADMIN", { isSuperAdmin: true });
    const manager = await person("Zz Manager", "SALES_MANAGER");
    const employee = await person("Zz Employee", "SALES", { managerId: manager.id });
    const loner = await person("Zz Loner", "SALES");
    const hr = await person("Zz Hr", "HR");
    const accounts = await person("Zz Accounts", "ACCOUNTS");
    const as = async <T,>(who: { id: string; name: string; email: string | null; role: string }, work: () => Promise<T>) => {
      const before = actor;
      actor = { id: who.id, name: who.name, email: who.email!, role: who.role };
      try {
        return await work();
      } finally {
        actor = before;
      }
    };
    let day = 1;
    const claim = (who: typeof employee, amount: number) =>
      as(who, () =>
        expenses.createExpense({
          category: "TRAVEL",
          amount,
          spentOn: `2026-10-${String(day++).padStart(2, "0")}`,
          description: `Zz cab to the client, ${amount}`,
          paymentMode: "UPI",
          reimbursable: true,
          submit: true,
        }),
      );
    const row = (id: string) =>
      db.expense.findUnique({
        where: { id },
        select: { status: true, approvalFlow: true, approvalStep: true, approverUserId: true, managerApproverId: true, journalEntries: { select: { source: true } } },
      });
    const booked = async (id: string, source: string) => ((await row(id))?.journalEntries ?? []).filter((j) => j.source === source).length;

    section("HR approves (the default)");
    ok("no setting yet: HR", (await as(boss, () => expenses.getExpenseApprovalFlow())) === "HR");
    const first = await claim(employee, 450);
    ok("an employee claims an official expense and submits it", first.ok, first.ok ? "" : first.error);
    if (!first.ok) throw new Error("could not claim");
    const firstRow = await row(first.data.id);
    ok("  it goes to HR — the rule and the step on the claim, nobody named", firstRow?.status === "SUBMITTED" && firstRow.approvalFlow === "HR" && firstRow.approvalStep === "HR" && firstRow.approverUserId === null, firstRow);
    const told = async (userId: string) => db.notification.count({ where: { userId, type: "EXPENSE_SUBMITTED" } });
    ok("  HR is told; the manager isn't", (await told(hr.id)) === 1 && (await told(manager.id)) === 0);
    ok("  in HR's To approve", (await as(hr, () => expenses.listExpensesPaged({ awaitingMyDecision: true, page: 1, pageSize: 25 }))).rows.some((r) => r.id === first.data.id));
    ok("  counted on HR's tab", (await as(hr, () => expenses.expenseSummary({ awaitingMyDecision: true }))).awaitingMyDecision === 1);
    ok("  HR can open it, though the employee isn't otherwise theirs to see", !!(await as(hr, () => expenses.getExpense(first.data.id))));
    ok("  not in the manager's queue", !(await as(manager, () => expenses.listExpensesPaged({ awaitingMyDecision: true, page: 1, pageSize: 25 }))).rows.some((r) => r.id === first.data.id));
    ok("  nor in Accounts' list yet — it isn't approved", !(await as(accounts, () => expenses.listExpenseClaimsForAccounts({ view: "to-pay", page: 1, pageSize: 25 })))!.rows.some((r) => r.id === first.data.id));
    const byManager = await as(manager, () => expenses.decideExpense({ id: first.data.id, approved: true }));
    ok("the manager can't decide it", !byManager.ok, byManager.ok ? "DECIDED" : byManager.error);
    const byAccounts = await as(accounts, () => expenses.decideExpense({ id: first.data.id, approved: true }));
    ok("  nor Accounts, who may approve any claim at a manager's step", !byAccounts.ok);
    const byMe = await as(employee, () => expenses.decideExpense({ id: first.data.id, approved: true }));
    ok("  nor the employee", !byMe.ok && byMe.error.includes("your own"), byMe.ok ? "" : byMe.error);
    const byHr = await as(hr, () => expenses.decideExpense({ id: first.data.id, approved: true }));
    ok("HR approves it", byHr.ok, byHr.ok ? "" : byHr.error);
    const approvedRow = await row(first.data.id);
    ok("  approved, by HR", approvedRow?.status === "APPROVED" && approvedRow.approverUserId === hr.id, approvedRow);
    ok("  and booked to the ledger", (await booked(first.data.id, "EXPENSE")) === 1);
    ok("  deciding it again is refused", !(await as(hr, () => expenses.decideExpense({ id: first.data.id, approved: true }))).ok);
    ok("  the employee is told", (await db.notification.count({ where: { userId: employee.id, type: "EXPENSE_DECIDED" } })) === 1);

    section("Accounts");
    const toPay = await as(accounts, () => expenses.listExpenseClaimsForAccounts({ view: "to-pay", page: 1, pageSize: 25 }));
    const listed = toPay?.rows.find((r) => r.id === first.data.id);
    ok("the approved claim is in Accounting › Expense claims, To pay", !!listed, toPay?.rows.length);
    ok("  with its amount, who approved it and its ledger entry", !!listed && Number(listed.amount) === 450 && listed.approver?.id === hr.id && listed.journalEntries.some((j) => j.source === "EXPENSE"));
    ok("  the total to pay", toPay?.toPay.amount === 450 && toPay.toPay.count === 1 && toPay.mayPay === true, toPay?.toPay);
    ok("the employee doesn't get that list", (await as(employee, () => expenses.listExpenseClaimsForAccounts({ view: "to-pay", page: 1, pageSize: 25 }))) === null);
    ok("  nor HR", (await as(hr, () => expenses.listExpenseClaimsForAccounts({ view: "to-pay", page: 1, pageSize: 25 }))) === null);
    const paid = await as(accounts, () => expenses.reimburseExpenses({ expenseIds: [first.data.id], reimbursementRef: "UTR123", reimbursedOn: "2026-10-19" }));
    ok("Accounts marks it paid", paid.ok && paid.data.count === 1, paid.ok ? paid.data : paid.error);
    ok("  the payment is booked", (await booked(first.data.id, "PAYMENT")) === 1);
    const paidList = await as(accounts, () => expenses.listExpenseClaimsForAccounts({ view: "paid", page: 1, pageSize: 25 }));
    ok("  it moves to Paid, with the reference", paidList?.rows.some((r) => r.id === first.data.id && r.reimbursementRef === "UTR123") === true);
    ok("  and off To pay", (await as(accounts, () => expenses.listExpenseClaimsForAccounts({ view: "to-pay", page: 1, pageSize: 25 })))?.toPay.count === 0);

    section("Who sets the rule");
    ok("not the employee", !(await as(employee, () => expenses.setExpenseApprovalFlow("MANAGER"))).ok);
    ok("  nor a bad answer", !(await as(boss, () => expenses.setExpenseApprovalFlow("NOBODY"))).ok);
    const set = await as(boss, () => expenses.setExpenseApprovalFlow("MANAGER_THEN_HR"));
    ok("an HR administrator sets the manager, then HR", set.ok && (await as(boss, () => expenses.getExpenseApprovalFlow())) === "MANAGER_THEN_HR", set.ok ? "" : set.error);
    ok("  audited", (await db.auditLog.count({ where: { entityType: "ExpenseSettings" } })) === 1);

    section("The manager, then HR");
    const second = await claim(employee, 1200);
    if (!second.ok) throw new Error(second.error);
    const secondRow = await row(second.data.id);
    ok("a claim goes to the employee's manager first", secondRow?.approvalFlow === "MANAGER_THEN_HR" && secondRow.approvalStep === "MANAGER" && secondRow.approverUserId === manager.id, secondRow);
    ok("  HR can't decide it yet", !(await as(hr, () => expenses.decideExpense({ id: second.data.id, approved: true }))).ok);
    const managerYes = await as(manager, () => expenses.decideExpense({ id: second.data.id, approved: true, note: "Fine by me" }));
    ok("the manager approves it", managerYes.ok, managerYes.ok ? "" : managerYes.error);
    const withHr = await row(second.data.id);
    ok("  still waiting — now with HR, the manager's yes recorded", withHr?.status === "SUBMITTED" && withHr.approvalStep === "HR" && withHr.approverUserId === null && withHr.managerApproverId === manager.id, withHr);
    ok("  nothing booked yet", (await booked(second.data.id, "EXPENSE")) === 0);
    ok("  the manager can't approve it a second time", !(await as(manager, () => expenses.decideExpense({ id: second.data.id, approved: true }))).ok);
    ok("  the manager can still open it", !!(await as(manager, () => expenses.getExpense(second.data.id))));
    const hrYes = await as(hr, () => expenses.decideExpense({ id: second.data.id, approved: true }));
    ok("HR approves it", hrYes.ok && (await row(second.data.id))?.status === "APPROVED", hrYes.ok ? "" : hrYes.error);
    ok("  booked, and in Accounts' To pay", (await booked(second.data.id, "EXPENSE")) === 1 && (await as(accounts, () => expenses.listExpenseClaimsForAccounts({ view: "to-pay", page: 1, pageSize: 25 })))!.rows.some((r) => r.id === second.data.id && r.managerApprover?.id === manager.id));

    const third = await claim(employee, 300);
    if (!third.ok) throw new Error(third.error);
    await as(manager, () => expenses.decideExpense({ id: third.data.id, approved: true }));
    ok("HR rejecting needs a reason", !(await as(hr, () => expenses.decideExpense({ id: third.data.id, approved: false }))).ok);
    const no = await as(hr, () => expenses.decideExpense({ id: third.data.id, approved: false, note: "No receipt" }));
    ok("HR rejects one, with the reason", no.ok && (await row(third.data.id))?.status === "REJECTED");
    const again = await as(employee, () => expenses.submitExpense(third.data.id));
    const againRow = await row(third.data.id);
    ok("resubmitted, it starts again with the manager", again.ok && againRow?.approvalStep === "MANAGER" && againRow.approverUserId === manager.id && againRow.managerApproverId === null, againRow);

    const lonely = await claim(loner, 200);
    if (!lonely.ok) throw new Error(lonely.error);
    ok("somebody with no manager goes straight to HR", (await row(lonely.data.id))?.approvalStep === "HR");

    section("The manager alone");
    const fourthBefore = await claim(employee, 99);
    if (!fourthBefore.ok) throw new Error(fourthBefore.error);
    await as(boss, () => expenses.setExpenseApprovalFlow("MANAGER"));
    ok("a claim submitted before the rule changed keeps its rule", (await row(fourthBefore.data.id))?.approvalFlow === "MANAGER_THEN_HR");
    const fifth = await claim(employee, 75);
    if (!fifth.ok) throw new Error(fifth.error);
    const managerOnly = await as(manager, () => expenses.decideExpense({ id: fifth.data.id, approved: true }));
    ok("under the manager alone, the manager's yes approves it and books it", managerOnly.ok && (await row(fifth.data.id))?.status === "APPROVED" && (await booked(fifth.data.id, "EXPENSE")) === 1, managerOnly.ok ? "" : managerOnly.error);
    const lonelyManagerOnly = await claim(loner, 60);
    if (!lonelyManagerOnly.ok) throw new Error(lonelyManagerOnly.error);
    const lonelyRow = await row(lonelyManagerOnly.data.id);
    ok("  somebody with no manager: to whoever may approve any claim, as before", lonelyRow?.approvalStep === "MANAGER" && lonelyRow.approverUserId !== null && lonelyRow.approverUserId !== loner.id, lonelyRow);
  } finally {
    actor = null;
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} expense approval checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
