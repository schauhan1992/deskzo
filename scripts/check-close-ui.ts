/**
 * check:close-ui — the month-end close's screens (Revenue & Close, spec §4.5) and the lock gap, against
 * a scratch workspace database, rendered the way a signed-in person would see them.
 *
 * Every page is an async server component: it is called with a stubbed session and rendered to HTML,
 * so nothing here signs in, and nothing touches the real books — a scratch database is built from the
 * migrations beside the real one and dropped at the end, and the real one is read before and after to
 * prove it.
 *
 *   · the close page for a manager (closes), an accounts executive (works, can't close) and a
 *     salesperson (refused); progress, the due date, overdue said in words, owners, "Checked
 *     automatically" against a person's tick, a task opened from a notification's link;
 *   · every automatic check's findings rendered for people — the figures, the records at fault and
 *     their links, the receivables tie-out's difference and its likely causes;
 *   · "Close <month>" disabled with its reason, the written-reason override (audited), the confirm
 *     step saying where the lock goes, reopening with its warning, and the month's history;
 *   · the Flux tab: the flag and its reason, the explanation field, an explanation with its author;
 *   · Prepaids & accruals: the list and its filters, a schedule's months with their entries, the form's
 *     preview of the months before saving (new and changed);
 *   · the settings pages, the Accounting overview card, and the add-on switched off;
 *   · the lock gap: Close the Books' lock moved back below a closed month's end — or removed, or a
 *     financial year reopened — reopens that month and every later one, audited, in one transaction,
 *     and Close the Books says so before it happens.
 *
 *   npm run check:close-ui
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
const json = (v: unknown) => JSON.stringify(v);

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const TAG = "ZZCLOSEUI";

// ── Who is signed in, as far as the pages and actions can tell ─────────────────────────────────

let actor: { id: string; name: string; email: string; role: string } | null = null;
let pathname = "/accounting/close";

const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
class UnauthorizedError extends Error {}
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check rendered a page without saying who was looking at it.");
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
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const email = { sendEmailNotification: async () => {} };
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

/** A server component tree with its nested async components awaited, so it can be rendered. */
async function resolveAsync(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: unknown }>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    return resolveAsync(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
  }
  if (el.props && "children" in el.props) {
    const kids = await resolveAsync(el.props.children);
    return Array.isArray(kids) ? cloneElement(el, undefined, ...(kids as ReactNode[])) : cloneElement(el, undefined, kids as ReactNode);
  }
  return el;
}
async function html(node: unknown): Promise<string> {
  // React marks the join between two text nodes with an empty comment; the page doesn't show it.
  return renderToStaticMarkup((await resolveAsync(await node)) as ReactElement).replace(/<!-- -->/g, "");
}
/** HTML entities back to text, so assertions read like the page does. */
const text = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
/** Whether an element with this id is rendered without the `hidden` attribute. */
const shown = (page: string, id: string) => {
  const tag = new RegExp(`<[a-z]+[^>]*\\sid="${id.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}"[^>]*>`).exec(page)?.[0];
  return tag ? !/\shidden=""/.test(tag) : null;
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
  const scratchName = `${realName}_close_ui_check`;
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
  ok("  its close months, templates, schedules and notes are as they were", realAfter.close === realBefore.close, realAfter.close);
  ok("  and nothing of this suite's is in it", realAfter.tagged === 0, realAfter.tagged);

  console.log(failures === 0 ? `\nAll ${passes} close screen checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** What the suite must never change in the real workspace. Read-only. */
async function snapshot(client: PrismaClient) {
  const [lock, months, closed, templates, tasks, schedules, notes, tagged] = await Promise.all([
    client.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true, note: true } }),
    client.closeMonth.count(),
    client.closeMonth.count({ where: { status: "CLOSED" } }),
    client.closeTaskTemplate.count(),
    client.closeTask.count(),
    client.accountingSchedule.count(),
    client.fluxNote.count(),
    client.journalEntry.count({ where: { narration: { contains: TAG } } }),
  ]);
  return {
    lock: lock ? `${lock.lockedUntil?.toISOString() ?? "null"} ${lock.note ?? ""}` : null,
    close: json({ months, closed, templates, tasks, schedules, notes }),
    tagged,
  };
}

// ── The suite ───────────────────────────────────────────────────────────────────────────────────

async function run(scratchUrl: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const journal = require("../src/lib/ledger/journal") as typeof import("../src/lib/ledger/journal");
  const booksLock = require("../src/lib/ledger/books-lock") as typeof import("../src/lib/ledger/books-lock");
  const months = require("../src/lib/close/months") as typeof import("../src/lib/close/months");
  const checks = require("../src/lib/close/checks") as typeof import("../src/lib/close/checks");
  const tieout = require("../src/lib/close/tieout") as typeof import("../src/lib/close/tieout");
  const { financialYearStartOf } = require("../src/lib/india-time") as typeof import("../src/lib/india-time");
  const closeActions = require("../src/actions/close") as typeof import("../src/actions/close");
  const scheduleActions = require("../src/actions/accounting-schedules") as typeof import("../src/actions/accounting-schedules");
  const booksActions = require("../src/actions/books") as typeof import("../src/actions/books");
  const ClosePage = (require("../src/app/(dashboard)/accounting/close/page") as typeof import("../src/app/(dashboard)/accounting/close/page")).default;
  const SchedulesPage = (require("../src/app/(dashboard)/accounting/schedules/page") as typeof import("../src/app/(dashboard)/accounting/schedules/page")).default;
  const OverviewPage = (require("../src/app/(dashboard)/accounting/page") as typeof import("../src/app/(dashboard)/accounting/page")).default;
  const SettingsRevenueClose = (require("../src/app/(dashboard)/settings/revenue-close/page") as typeof import("../src/app/(dashboard)/settings/revenue-close/page")).default;
  const SettingsChecklist = (require("../src/app/(dashboard)/settings/close-checklist/page") as typeof import("../src/app/(dashboard)/settings/close-checklist/page")).default;
  const { CheckDetailView } = require("../src/components/close/check-detail") as typeof import("../src/components/close/check-detail");
  const { ScheduleForm, BLANK_SCHEDULE } = require("../src/components/close/schedule-form") as typeof import("../src/components/close/schedule-form");
  const { TemplateForm } = require("../src/components/close/close-template-editor") as typeof import("../src/components/close/close-template-editor");
  const { BooksManager } = require("../src/components/accounting/books-manager") as typeof import("../src/components/accounting/books-manager");
  const { fluxReason, dayShort, dayLong } = require("../src/components/close/format") as typeof import("../src/components/close/format");
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
    entitlements: { v: 1 as const, ...entitlements, seats: null, copilotTokens: null, plans: [] },
    holdReason: null,
  });
  const ON = tenant("zzcloseui-on", { all: true, modules: [] });
  const OFF = tenant("zzcloseui-off", { all: false, modules: ["accounting"] });

  // The months the pages will offer by default are real ones: the last that has ended, and the one
  // before it. Everything below is dated relative to them.
  const now = new Date();
  const M2 = months.lastCompletedMonth(now);
  const M1 = months.addMonths(M2, -1);
  const k1 = months.monthKeyOf(M1);
  const k2 = months.monthKeyOf(M2);
  const L1 = months.monthLabel(M1);
  const L2 = months.monthLabel(M2);
  const N1 = months.monthName(M1);
  const N2 = months.monthName(M2);
  const midMonth = (m: Date) => new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), 15, 6, 30)); // 12:00 IST on the 15th
  const dayKey = months.dayKey;
  const end1 = dayKey(months.monthEnd(M1));
  const end2 = dayKey(months.monthEnd(M2));

  await runAsTenant(ON, async () => {
    // ── Fixture ──────────────────────────────────────────────────────────────────────────────
    section("Fixture");
    const user = (key: string, role: string, extra: { isSuperAdmin?: boolean } = {}) =>
      db.user.create({
        data: { name: `${TAG} ${key}`, email: `${TAG.toLowerCase()}-${key.toLowerCase()}@example.test`, passwordHash: "!", role, ...extra },
        select: { id: true, name: true, email: true, role: true },
      });
    const owner = await user("Owner", "ADMIN", { isSuperAdmin: true });
    const manager = await user("Manager", "ACCOUNTS");
    const exec = await user("Exec", "ACCOUNTS");
    const outsider = await user("Sales", "SALES");
    for (const permission of ["close.manage", "books.close"]) {
      await db.userPermission.create({ data: { userId: manager.id, permission, allowed: true, reason: `${TAG} fixture` } });
    }
    await journal.ensureChartOfAccounts(db);
    const acct = (code: string, name: string, type: "ASSET" | "LIABILITY" | "EXPENSE" | "INCOME") =>
      db.ledgerAccount.create({ data: { code: `ZZ-${code}`, name: `${TAG} ${name}`, type }, select: { id: true, code: true, name: true } });
    const rent = await acct("5801", "Rent", "EXPENSE");
    const clearing = await acct("2801", "Clearing", "LIABILITY");
    const insurance = await acct("5802", "Insurance", "EXPENSE");
    const customer = await db.company.create({
      data: { name: `${TAG} Customer`, normalizedName: `${TAG.toLowerCase()} customer`, createdById: owner.id },
      select: { id: true },
    });
    let seq = 0;
    const invoice = (status: "DRAFT" | "ISSUED", total: number) => {
      seq += 1;
      return db.tradeDocument.create({
        data: {
          docNumber: `${TAG}-INV-${seq}`,
          docType: "INVOICE",
          direction: "SALES",
          status,
          companyId: customer.id,
          createdById: owner.id,
          issueDate: midMonth(M2),
          currency: "INR",
          exchangeRate: 1,
          subtotal: total,
          taxableValue: total,
          cgstAmount: 0,
          sgstAmount: 0,
          total,
        },
        select: { id: true, docNumber: true },
      });
    };
    const draft = await invoice("DRAFT", 5000);
    const unposted = await invoice("ISSUED", 7000);
    const post = (date: Date, amount: number) =>
      db.$transaction((t) =>
        journal.writeEntry(t, {
          date,
          narration: `${TAG} rent`,
          source: "MANUAL",
          userId: owner.id,
          lines: [
            { accountId: rent.id, debit: amount, credit: 0 },
            { accountId: clearing.id, debit: 0, credit: amount },
          ],
        }),
      );
    await post(midMonth(M1), 30000);
    await post(midMonth(M2), 80000);
    ok(
      `people (a super admin, a manager with close.manage and books.close, an accounts executive, a salesperson), a draft and an unposted invoice in ${L2}, rent of ₹30,000 then ₹80,000`,
      !!owner && !!draft && !!unposted,
    );

    const closePage = (params: Record<string, string>) => html(ClosePage({ searchParams: Promise.resolve(params) }));

    // ── The close page ───────────────────────────────────────────────────────────────────────
    section(`The close page, ${L2}, as the manager`);
    actor = manager;
    pathname = "/accounting/close";
    const asManager = await closePage({ month: k2 });
    const managerText = text(asManager);
    const tasks2 = await db.closeTask.findMany({ where: { month: M2 }, select: { id: true, title: true, status: true, autoCheck: true, dueOn: true } });
    ok("opening it makes the month's checklist from the fourteen default templates", tasks2.length === 14, tasks2.length);
    ok("  the heading, the month and its status", managerText.includes("Month-end close") && managerText.includes(`${L2} Open`));
    const view2 = (await closeActions.getCloseMonth(k2, { refresh: false }))!;
    const finished2 = view2.progress.done + view2.progress.notApplicable;
    ok("  the progress in words: \"n of 14 done\"", managerText.includes(`${finished2} of 14 done`), `${finished2} of 14`);
    const due = view2.progress.nextDue ? dayShort(view2.progress.nextDue) : "";
    ok("  and when the next task falls due, as \"due 3 Oct\"", !!due && managerText.includes(`due ${due}`), due);
    const overdueNow = view2.tasks.filter((t) => t.overdue).length;
    ok(
      "  overdue is said in words, not only in amber",
      overdueNow === 0 || (managerText.includes(`${overdueNow} task${overdueNow === 1 ? " is" : "s are"} overdue`) && (asManager.match(/>Overdue</g) ?? []).length === overdueNow),
      `${overdueNow} overdue`,
    );
    ok("  every task is listed, with its owner (nobody yet) and its due day", tasks2.every((t) => managerText.includes(t.title)) && managerText.includes("No owner") && managerText.includes("Due "));
    const autoTicked = view2.tasks.filter((t) => t.status === "DONE" && t.doneBy?.automatic);
    ok("a task its check ticked says \"Checked automatically · <time>\"", autoTicked.length > 0 && managerText.includes("Checked automatically · "), autoTicked.map((t) => t.title).join(", "));
    ok(
      "  the draft invoice is named, linked to the document",
      managerText.includes(`1 draft invoice dated in ${L2}.`) && asManager.includes(`href="/documents/${draft.id}"`) && managerText.includes(draft.docNumber),
    );
    ok(
      "  the receivables tie-out shows both totals, the difference and its likely cause, linked",
      managerText.includes("Receivables ageing, in rupees at each document's rate") &&
        managerText.includes("Accounts Receivable in the ledger") &&
        managerText.includes("Difference") &&
        managerText.includes("Documents whose entry disagrees") &&
        asManager.includes(`href="/documents/${unposted.id}"`) &&
        managerText.includes("No entry in the ledger"),
    );
    ok("  the manager can work it: mark done, not applicable, owner, a note, attach a file", ["Mark done", "Not applicable…", "Owner", "Add a note", "Attach a file"].every((s) => managerText.includes(s)));
    ok(
      `"Close ${N2}" is there, disabled, with the reason`,
      new RegExp(`<button[^>]*disabled=""[^>]*aria-describedby="close-${k2}-why"[^>]*>.*?Close ${N2}</button>`).test(asManager) &&
        managerText.includes(`${view2.progress.open} task${view2.progress.open === 1 ? " is" : "s are"} still open.`),
    );
    ok("  with the override: a written reason, said to be audited", managerText.includes("Close with open tasks…") && managerText.includes(`Why close with ${view2.progress.open} task`) && managerText.includes("Audited: the reason is recorded in the audit log"));
    ok(`  and the confirm step says it locks the books to the month end`, managerText.includes(`Closing locks the books to ${dayLong(months.monthEnd(M2))} : nothing dated on or before it`));
    ok("  hidden until asked for", shown(asManager, `close-${k2}-confirm`) === false);
    ok("the month's history, empty and saying so", managerText.includes(`${L2} has never been closed.`));
    ok(
      "each task links the page it's done on — the flux task to this month's Flux tab",
      asManager.includes('href="/accounting/gst"') && asManager.includes(`href="/accounting/close?month=${k2}&amp;tab=flux"`) && !asManager.includes('href="/accounting/close?tab=flux"'),
    );
    ok("the month picker offers it, and the tabs",asManager.includes(`<option value="${k2}" selected="">`) && asManager.includes(">Checklist<") && asManager.includes(">Flux<"));

    const gst = view2.tasks.find((t) => t.title === "GST returns prepared")!;
    const focused = await closePage({ month: k2, task: gst.id });
    ok("a notification's link opens its task", shown(focused, `task-${gst.id}-panel`) === true && shown(asManager, `task-${gst.id}-panel`) === false);

    section(`The close page as the accounts executive (works, can't close)`);
    actor = exec;
    ok("  a person's tick: marked done by the executive", (await closeActions.setTaskStatus(gst.id, "DONE")).ok);
    const tds = view2.tasks.find((t) => t.title === "TDS reconciled")!;
    ok("  and not applicable, with the reason", (await closeActions.setTaskStatus(tds.id, "NOT_APPLICABLE", `${TAG}: no TDS deducted this month`)).ok);
    const pdf = `data:application/pdf;base64,${Buffer.from("%PDF-1.4 zz").toString("base64")}`;
    const attached = await closeActions.addTaskAttachment(gst.id, { name: `${TAG} GSTR-3B working.pdf`, fileDataUrl: pdf, mimeType: "application/pdf" });
    ok("  a file attached", attached.ok);
    const asExec = await closePage({ month: k2 });
    const execText = text(asExec);
    ok("the executive sees the checklist and can work it", execText.includes("Mark done") && execText.includes("Add a note"));
    ok(`  but no "Close ${N2}" — they're told who can`, !new RegExp(`>\\s*Close ${N2}\\s*<`).test(asExec) && execText.includes(`Closing ${N2} is for somebody who manages the close and may close the books.`));
    ok("  the person's tick names them", execText.includes(`Marked done by ${exec.name}`));
    ok("  not applicable shows who and why", execText.includes(`Marked not applicable by ${exec.name}`) && execText.includes("no TDS deducted this month"));
    ok("  the file is listed, with its size and who added it", execText.includes(`${TAG} GSTR-3B working.pdf`) && execText.includes(exec.name));
    if (attached.ok) {
      const file = await closeActions.getTaskAttachmentFile(attached.data.id);
      ok("  and it downloads as it was uploaded", file.ok && file.data.fileDataUrl === pdf);
      ok("  and can be removed", (await closeActions.deleteTaskAttachment(attached.data.id)).ok);
    }
    ok("  an owner can be given — a person, never the Automation account", (await closeActions.setTaskOwner(gst.id, manager.id)).ok && !(await closeActions.listCloseOwnerOptions()).some((p) => p.email?.endsWith("@system.invalid")));
    ok("  and is shown on the task", text(await closePage({ month: k2 })).includes(manager.name));

    section("Somebody outside the close");
    actor = outsider;
    const refused = text(await closePage({ month: k2 }));
    ok("a salesperson is refused, and told which permission would let them in", refused.includes("You don't have access to this") && !refused.includes("Checklist"));
    ok("  as on Prepaids & accruals", text(await html(SchedulesPage({ searchParams: Promise.resolve({}) }))).includes("You don't have access to this"));

    // ── Every automatic check, rendered ───────────────────────────────────────────────────────
    section("Every automatic check's findings, written for people");
    const render = (detail: unknown, okFlag: boolean | null) => html(createElement(CheckDetailView, { detail: detail as never, ok: okFlag }));
    const bank = checks.checkBankReconciled({
      month: M2,
      accounts: [
        { id: "b1", name: "HDFC current", reconciliations: [], latest: null },
        { id: "b2", name: "ICICI OD", reconciliations: [{ statementDate: months.monthEnd(M2), difference: 50 }], latest: null },
      ],
    });
    const bankHtml = await render(bank.detail, bank.ok);
    ok(
      "bank: the accounts not reconciled, why, and a link to reconcile each",
      text(bankHtml).includes("2 of 2 bank accounts not reconciled") && bankHtml.includes(`href="/accounting/banking?account=b1&amp;to=${end2}"`) && text(bankHtml).includes("Never reconciled") && text(bankHtml).includes("with a difference of ₹50.00") && text(bankHtml).includes("Not reconciled"),
    );
    const inv = checks.checkInvoicesIssued({ month: M2, drafts: [1, 2, 3].map((i) => ({ id: `d${i}`, docNumber: `INV-${i}`, companyName: "Acme", total: 1000 * i, currency: "INR" })) });
    const invHtml = await render(inv.detail, inv.ok);
    ok(`invoices: "3 draft invoices dated in ${L2}", each linked`, text(invHtml).includes(`3 draft invoices dated in ${L2}.`) && ["d1", "d2", "d3"].every((d) => invHtml.includes(`href="/documents/${d}"`)) && text(invHtml).includes("Draft invoices 3"));
    const rev = checks.checkRevenueRecognised({
      month: M2,
      unposted: [{ scheduleId: "r1", label: "INV-9 · Support", month: M2, amount: 1234.5 }],
      milestones: [],
      pending: [{ scheduleId: "r2", label: "INV-10 · Licence", amount: 900, startDate: M2 }],
    });
    const revHtml = await render(rev.detail, rev.ok);
    ok("revenue: the schedules behind and the ones waiting for approval, linked", revHtml.includes('href="/accounting/revenue?schedule=r1"') && text(revHtml).includes("Waiting for approval") && text(revHtml).includes("₹1,234.50"));
    const sch = checks.checkSchedulesPosted({ month: M2, unposted: [{ scheduleId: "s1", label: "Insurance", month: M2, amount: 1000 }], reversals: [], reclass: [] });
    const schHtml = await render(sch.detail, sch.ok);
    ok("prepaids and accruals: linked to this page's schedule", schHtml.includes('href="/accounting/schedules?schedule=s1"') && text(schHtml).includes("Months not posted 1"));
    const dep = checks.checkDepreciationRun({
      month: M2,
      assets: [{ id: "a1", tag: "AST-1", name: "Laptop", cost: 120000, salvageValue: 0, method: "STRAIGHT_LINE", usefulLifeYears: 3, ratePercent: null, purchasedOn: months.addMonths(M2, -3), disposedOn: null, charges: [] }],
    });
    const depHtml = await render(dep.detail, dep.ok);
    ok("depreciation: the asset not charged, with the charge due and a link to the run", text(depHtml).includes("AST-1 Laptop") && depHtml.includes('href="/accounting/assets?month=') && text(depHtml).includes("Charge missing"));
    const pay = checks.checkPayrollPosted({ month: M2, inUse: true, run: { id: "p1", status: "DRAFT", posted: false } });
    const payHtml = await render(pay.detail, pay.ok);
    ok("payroll: the run not locked, linked", payHtml.includes('href="/people/payroll/p1"') && text(payHtml).includes("isn't locked"));
    const exp = checks.checkExpensesPosted({ month: M2, claims: [{ id: "e1", label: "EXP-1 · Travel", amount: 2500 }] });
    const expHtml = await render(exp.detail, exp.ok);
    ok("expenses: the claim not posted, linked", expHtml.includes('href="/expenses/e1"') && text(expHtml).includes("Claims not posted 1") && text(expHtml).includes("₹2,500.00"));
    const del = checks.checkDeliveredNotInvoiced({ month: M2, stages: [{ id: "m1", label: "Go-live", projectId: "pr1", amount: 40000, deliveredAt: midMonth(M2), status: "DUE" }] });
    const delHtml = await render(del.detail, del.ok);
    ok("delivered, not invoiced: the milestone, linked to its project", delHtml.includes('href="/projects/pr1"') && text(delHtml).includes("Milestones waiting 1"));
    const flx = checks.checkFluxExplained({ month: M2, rows: [{ accountId: rent.id, code: rent.code, name: rent.name, changePrev: 50000, flagged: true, explained: false }] });
    const flxHtml = await render(flx.detail, flx.ok);
    ok("flux: the change not explained, linked to the Flux tab", flxHtml.includes(`href="/accounting/close?month=${k2}&amp;tab=flux"`) && text(flxHtml).includes("Not explained 1"));
    const tie = tieout.tieOut({
      side: "AR",
      month: M2,
      documents: [
        { id: "i1", docNumber: "INV-1", docType: "INVOICE", companyId: "c1", companyName: "Acme", currency: "INR", rate: 1, total: 10000, allocated: 0, credited: 0, applied: 0, posted: 0, hasEntry: false, entryNumbers: [] },
      ],
      payments: [],
      ledger: 1000,
      manualInMonth: [{ id: "j1", entryNumber: "JV-7", date: midMonth(M2), narration: "Write-off", amount: 1000 }],
      manualBefore: { count: 0, amount: 0 },
      partyless: { count: 0, amount: 0, items: [] },
      orphanPayments: { count: 0, amount: 0, items: [] },
    });
    const tieHtml = await render(tie.detail, tie.ok);
    const tieText = text(tieHtml);
    ok(
      "the AR tie-out: ageing, ledger, the difference in red, and the likely causes, each linked",
      !tie.ok && tieText.includes("₹10,000.00") && tieText.includes("₹1,000.00") && tieText.includes("₹9,000.00") && tieHtml.includes("text-danger") && tieText.includes("Likely causes") && tieHtml.includes('href="/documents/i1"') && tieHtml.includes('href="/accounting/journal?q=JV-7"') && tieText.includes("Manual journals on the account this month: 1"),
    );
    const errorHtml = await render({ key: "ar-ties", summary: "The check couldn't run: timeout.", error: true }, null);
    ok("a check that couldn't run says so, and that the task was left alone", text(errorHtml).includes("The check couldn't run: timeout.") && text(errorHtml).includes("not evidence either way"));

    // ── Flux ─────────────────────────────────────────────────────────────────────────────────
    section("The Flux tab");
    actor = exec;
    const fluxHtml = await closePage({ month: k2, tab: "flux" });
    const fluxText = text(fluxHtml);
    ok("the tab opens on the flagged rows, P&L and balance sheet", fluxText.includes("Profit & loss") && fluxText.includes("Balance sheet") && fluxText.includes(rent.name) && fluxText.includes(clearing.name));
    ok("  this month, last month, the change in amount and percent, and a year earlier", fluxText.includes("₹80,000.00") && fluxText.includes("₹30,000.00") && fluxText.includes("+₹50,000.00 (+167%)") && fluxText.includes("A year earlier"));
    ok("  the flag, with its reason in words", fluxText.includes("Flagged") && fluxText.includes("Up 167% and ₹50,000"), fluxReason({ changePrev: 50000, changePrevPct: 166.67 }));
    ok("  and an explanation field for somebody who works the close", fluxHtml.includes(`id="flux-${rent.id}"`) && fluxText.includes(`Why did ${rent.code} ${rent.name} move?`) && /maxlength="1000"/i.test(fluxHtml));
    ok("  the thresholds, stated", fluxText.includes("at least 20% and at least ₹25,000 — both"));
    ok("a 1,001-character explanation is refused", !(await closeActions.explainFlux(k2, rent.id, "x".repeat(1001))).ok);
    ok("  a short one is kept", (await closeActions.explainFlux(k2, rent.id, `${TAG}: the new office's first full month`)).ok);
    const explained = text(await closePage({ month: k2, tab: "flux" }));
    ok("the explained row shows the note and who wrote it", explained.includes("the new office's first full month") && explained.includes(`— ${exec.name}`) && explained.includes("Explained"));
    actor = outsider;
    ok("  and the salesperson can't read the flux either", !text(await closePage({ month: k2, tab: "flux" })).includes(rent.name));

    // ── Closing, the override, reopening, the history ─────────────────────────────────────────
    section(`Closing: ${L1} first, then ${L2} with a written reason`);
    actor = manager;
    const m1Page = await closePage({ month: k1 });
    ok(`opening ${L1} makes its checklist`, (await db.closeTask.count({ where: { month: M1 } })) === 14);
    const m2Blocked = text(await closePage({ month: k2 }));
    ok(`${L2} now waits for ${L1}: the reason is said, and no override is offered`, m2Blocked.includes(`Close ${L1} first.`) && !m2Blocked.includes("Close with open tasks…"));
    ok(`  ${L1}'s page offers the override while its tasks are open`, text(m1Page).includes("Close with open tasks…"));
    for (const t of await db.closeTask.findMany({ where: { month: M1, status: "TODO" }, select: { id: true } })) {
      await closeActions.setTaskStatus(t.id, "NOT_APPLICABLE", `${TAG}: before the add-on`);
    }
    const m1Ready = await closePage({ month: k1 });
    ok(
      `with every task done or not applicable, "Close ${N1}" is enabled and the confirm step says where the lock goes`,
      new RegExp(`<button(?![^>]*disabled="")[^>]*aria-controls="close-${k1}-confirm"[^>]*>.*?Close ${N1}</button>`).test(m1Ready) && text(m1Ready).includes(`Closing locks the books to `),
    );
    actor = exec;
    ok("  the executive can't close it through the action either", !(await closeActions.closeMonth(k1)).ok);
    actor = manager;
    const closed1 = await closeActions.closeMonth(k1);
    ok(`the manager closes ${L1}: the lock moves to its last day`, closed1.ok && closed1.data.lockedUntil === end1, closed1.ok ? closed1.data.lockedUntil : closed1.error);
    const closed2 = await closeActions.closeMonth(k2, { override: `${TAG}: payroll and GST filed offline` });
    ok(`  and ${L2} with a written reason`, closed2.ok && closed2.data.lockedUntil === end2, closed2.ok ? "" : closed2.error);
    const m2Closed = text(await closePage({ month: k2 }));
    ok(`${L2} shows as closed, by whom, with the reason`, m2Closed.includes(`${L2} Closed`) && m2Closed.includes(`Closed by ${manager.name}`) && m2Closed.includes("payroll and GST filed offline"));
    ok("  its history names the closing and the override's reason", m2Closed.includes(`Closed ${L2} with`) && m2Closed.includes("reason:") && m2Closed.includes(manager.name));
    ok(`  and it can be reopened`, m2Closed.includes(`Reopen ${N2}`) && m2Closed.includes("Why reopen it?"));
    const m1Closed = text(await closePage({ month: k1 }));
    ok(`reopening ${L1} warns that ${L2}, closed after it, reopens too`, m1Closed.includes(`${L2} is closed after it and reopens too`) && m1Closed.includes("Audited"));
    ok("  a closed month can't be worked: no ticking, no notes", !m2Closed.includes("Mark done") && !m2Closed.includes("Add a note"));

    // ── The Accounting overview card ────────────────────────────────────────────────────────
    section("The Accounting overview card");
    pathname = "/accounting";
    const overview = text(await html(OverviewPage()));
    ok(`the manager sees last month's close: "${N2} close: closed"`, overview.includes(`${N2} close:`) && overview.includes("closed ·") && overview.includes("View"), overview.match(new RegExp(`${N2} close:[^|]{0,60}`))?.[0]);
    actor = exec;
    ok("  so does the executive", text(await html(OverviewPage())).includes(`${N2} close:`));

    // ── Prepaids & accruals ──────────────────────────────────────────────────────────────────
    section("Prepaids & accruals");
    actor = manager;
    pathname = "/accounting/schedules";
    const schedulesPage = (params: Record<string, string>) => html(SchedulesPage({ searchParams: Promise.resolve(params) }));
    const empty = text(await schedulesPage({}));
    ok("with none yet, the page explains what a prepaid and an accrual are", empty.includes("No prepaids or accruals yet.") && empty.includes("New schedule"));
    const future = months.monthKeyOf(months.addMonths(M2, 1));
    const made = await scheduleActions.createSchedule({ kind: "PREPAID", name: `${TAG} Office insurance`, expenseAccountId: insurance.id, amount: 12000, startMonth: future, months: 12 });
    ok("the manager makes a prepaid (₹12,000 over 12 months from next month)", made.ok, made.ok ? made.data.reclassEntryNumber : made.error);
    const accrual = await scheduleActions.createSchedule({ kind: "ACCRUAL", name: `${TAG} Audit fee`, expenseAccountId: insurance.id, amount: 3000, startMonth: k2, months: 3 });
    ok("  and an accrual starting last month", accrual.ok, accrual.ok ? "" : accrual.error);
    // The books are locked to the end of last month, so its accrual catches up in the first open month.
    const list = text(await schedulesPage({}));
    ok("the list: name, kind, expense account, amounts, months and status", list.includes(`${TAG} Office insurance`) && list.includes("Prepaid") && list.includes("₹12,000.00") && list.includes("0 of 12") && list.includes("Running") && list.includes(`${TAG} Audit fee`));
    ok("  filtered to accruals, the prepaid goes", !text(await schedulesPage({ kind: "ACCRUAL" })).includes(`${TAG} Office insurance`) && text(await schedulesPage({ kind: "ACCRUAL" })).includes(`${TAG} Audit fee`));
    ok("  and a filter with nothing says so", text(await schedulesPage({ status: "CANCELLED" })).includes("Nothing matches these filters."));
    if (made.ok) {
      const detail = await schedulesPage({ schedule: made.data.id });
      const detailText = text(detail);
      ok(
        "a prepaid's detail: its opening reclass linked to the journal, Dr the prepaid / Cr the expense",
        !!made.data.reclassEntryNumber && detail.includes(`href="/accounting/journal?q=${encodeURIComponent(made.data.reclassEntryNumber)}"`) && detailText.includes("Opening reclass") && detailText.includes(`/ Cr ${insurance.name}`),
      );
      ok("  its twelve months, planned", (detailText.match(/Planned/g) ?? []).length === 12);
      ok("  and, for the manager, change and stop — stopping asks first", detailText.includes("Change") && detailText.includes("Stop…") && shown(detail, `schedule-${made.data.id}-stop`) === false && detailText.includes("still held in"));
      actor = exec;
      const execDetail = text(await schedulesPage({ schedule: made.data.id }));
      ok("  the executive reads it but can't change it, make one, or stop it", execDetail.includes(`${TAG} Office insurance`) && !execDetail.includes("Stop…") && !execDetail.includes("New schedule") && execDetail.includes("Post the months that have ended"));
      actor = manager;
    }
    if (accrual.ok) {
      const ran = await scheduleActions.runSchedules({ throughMonth: k2 });
      ok(`posting through ${L2} posts the accrual's month (caught up into the first open month, as ${L2} is locked)`, ran.ok && ran.data.months.length > 0, ran.ok ? json(ran.data.months.map((m) => [m.month, m.entryNumber, m.catchUp])) : ran.error);
      const accrualDetail = await schedulesPage({ schedule: accrual.data.id });
      const line = await db.accountingScheduleLine.findFirst({ where: { scheduleId: accrual.data.id, entryId: { not: null } }, select: { entry: { select: { entryNumber: true } }, reversalEntry: { select: { entryNumber: true } } } });
      ok(
        "  the accrual's detail links the month's entry and its reversal",
        !!line?.entry && !!line.reversalEntry && accrualDetail.includes(`q=${encodeURIComponent(line.entry.entryNumber)}"`) && accrualDetail.includes(`q=${encodeURIComponent(line.reversalEntry.entryNumber)}"`) && text(accrualDetail).includes("Reversal"),
      );
    }

    section("The schedule form's preview, before saving");
    const options = (await scheduleActions.scheduleFormOptions())!;
    const form = (initial: ReturnType<typeof BLANK_SCHEDULE>, extra: { posted?: { month: string; amount: number }[]; accountsFixed?: boolean } = {}) =>
      html(createElement(ScheduleForm, { initial, options, bills: [], vendors: [], onDone: () => {}, onCancel: () => {}, ...extra }));
    const blank = text(await form(BLANK_SCHEDULE(k2)));
    ok("blank, it asks for the figures before showing months", blank.includes("Enter an amount, a first month and 1 to 60 months to see them."));
    const preview = text(await form({ ...BLANK_SCHEDULE(k2), name: "Insurance", amount: "1000", months: "3", expenseAccountId: insurance.id }));
    ok(
      "₹1,000 over three months: ₹333.33, ₹333.33 and ₹333.34, totalling ₹1,000.00",
      preview.includes("3 months of about ₹333.33") && (preview.match(/₹333\.33/g) ?? []).length >= 3 && preview.includes("₹333.34") && preview.includes("Total ₹1,000.00"),
    );
    ok("  the balance account defaults to Prepaid Expenses, and the choice is the kind's", preview.includes("Prepaid Expenses (the default)"));
    const changed = text(
      await form(
        { ...BLANK_SCHEDULE(k1), id: "zz-edit", name: "Insurance", amount: "1200", months: "3", expenseAccountId: insurance.id },
        { posted: [{ month: k1, amount: 300 }], accountsFixed: true },
      ),
    );
    ok("changed: the posted month stays, the rest share what's left (₹450 each)", changed.includes("posted") && changed.includes("₹300.00") && (changed.match(/₹450\.00/g) ?? []).length >= 2 && changed.includes("Total ₹1,200.00"));
    ok("  a prepaid's accounts and a posted schedule's start are fixed, and it says why", changed.includes("Fixed once the opening reclass is posted") && changed.includes("the start can't move"));
    const tooLow = text(await form({ ...BLANK_SCHEDULE(k1), id: "zz-edit", name: "Insurance", amount: "100", months: "3", expenseAccountId: insurance.id }, { posted: [{ month: k1, amount: 300 }] }));
    ok("  and an amount below what is posted is refused in the preview", tooLow.includes("is already posted; the amount can't be less than that."));

    // ── Settings ─────────────────────────────────────────────────────────────────────────────
    section("Settings");
    pathname = "/settings/revenue-close";
    const settingsHtml = text(await html(SettingsRevenueClose()));
    ok(
      "Revenue & Close: automatic posting explained (the Automation account, \"Posted automatically\"), the spreading default, the flux thresholds",
      settingsHtml.includes("Post recognition and schedules automatically") && settingsHtml.includes("Automation") && settingsHtml.includes("Posted automatically") && settingsHtml.includes("By day (exact)") && settingsHtml.includes("Evenly by month") && settingsHtml.includes("Percentage change") && settingsHtml.includes("Amount (₹)"),
    );
    const saved = await closeActions.saveCloseSettings({ autoPost: false, spreadEvenly: true, fluxPercent: 15, fluxAmount: 10000 });
    ok("  saved, it reads back", saved.ok && saved.data.fluxPercent === 15 && !saved.data.autoPost);
    await closeActions.saveCloseSettings({ autoPost: true, spreadEvenly: false, fluxPercent: 20, fluxAmount: 25000 });
    pathname = "/settings/close-checklist";
    const checklistHtml = text(await html(SettingsChecklist()));
    ok(
      "the checklist editor lists the templates in order, with their checks, owners and due days",
      checklistHtml.includes("Bank accounts reconciled to month end") && checklistHtml.includes("Checked automatically: Bank reconciled") && checklistHtml.includes("due the 3rd working day") && checklistHtml.includes("Add a task") && checklistHtml.includes("Deactivate"),
    );
    const templateForm = await html(createElement(TemplateForm, {
      draft: { id: null, title: "", description: "", ownerId: "", dueDay: "3", autoCheck: "", active: true },
      people: [],
      pending: false,
      error: null,
      onSave: () => {},
      onCancel: () => {},
    }));
    ok("  its form: the checks in plain language, the owner, the due working day", text(templateForm).includes("Every active bank account reconciled to the month end") && text(templateForm).includes("None — ticked by hand") && text(templateForm).includes("The 3rd working day (Mon–Fri) of the following month"));
    actor = exec;
    pathname = "/settings/revenue-close";
    ok("the executive is refused both", text(await html(SettingsRevenueClose())).includes("You don’t have permission to change this") && text(await html(SettingsChecklist())).includes("You don’t have permission to change this"));
    actor = manager;

    // ── The lock gap ─────────────────────────────────────────────────────────────────────────
    section("The lock gap: moving Close the Books' lock below a closed month reopens it");
    const statusOf = async (m: Date) => (await db.closeMonth.findUniqueOrThrow({ where: { month: m }, select: { status: true, reopenedAt: true, note: true, id: true } }));
    ok(`${L1} and ${L2} are closed, the lock at ${end2}`, (await statusOf(M1)).status === "CLOSED" && (await statusOf(M2)).status === "CLOSED" && dayKey((await db.ledgerLock.findUniqueOrThrow({ where: { id: "global" } })).lockedUntil!) === end2);
    const status = await booksActions.getBooksStatus();
    ok("Close the Books is told which months are closed, with their last days", json(status.closedMonths.map((m) => [m.month, m.end])) === json([[k1, end1], [k2, end2]]));
    const warn = (lockedUntil: string) =>
      html(createElement(BooksManager, { status: { ...status, lockedUntil: new Date(`${lockedUntil}T00:00:00.000Z`) } as never, isAdmin: true }));
    const mid2 = `${k2}-15`;
    const warned = text(await warn(mid2));
    ok(`  and says, before it happens, that a lock on the 15th reopens ${L2} (not ${L1})`, warned.includes(`reopens ${L2} on the month-end close`) && !warned.includes(`reopens ${L1}`));
    const both = text(await warn(dayKey(months.monthEnd(months.addMonths(M1, -1)))));
    ok(`  and that one before ${L1} reopens both`, both.includes(`reopens ${L1} and ${L2}`));
    const none = text(await warn(end2));
    ok("  a lock covering them says nothing — beyond what removing it would do", !none.includes("Locking to") && none.includes(`Removing the lock reopens every month closed on the month-end close (${L1} and ${L2})`));

    const byHand = await booksActions.setBooksLock({ lockedUntil: mid2, note: `${TAG} late bill` });
    const after2 = await statusOf(M2);
    ok(`the lock moved to the 15th of ${L2}: ${L2} is reopened, in the same act`, byHand.ok && after2.status === "OPEN" && !!after2.reopenedAt && (after2.note ?? "").includes(`the period lock moved back to ${mid2}`), after2.note);
    ok(`  ${L1}, still under the lock, stays closed`, (await statusOf(M1)).status === "CLOSED");
    const lockAudit = await db.auditLog.findFirst({ where: { entityType: "LedgerLock" }, orderBy: { createdAt: "desc" }, select: { entityLabel: true } });
    ok("  Close the Books' own audit wording is unchanged", lockAudit?.entityLabel === `Reopened the books to ${mid2}`, lockAudit?.entityLabel);
    const history2 = await closeActions.closeMonthHistory(k2);
    ok(`  and the reopening is on ${L2}'s own history`, history2.some((h) => h.entityLabel.startsWith(`Reopened ${L2} — the period lock moved back to ${mid2}`) && h.user?.name === manager.name), history2.map((h) => h.entityLabel).join(" | "));
    const reopenedPage = text(await closePage({ month: k2 }));
    ok(`  the close page shows ${L2} open again, with the reopening in its history`, reopenedPage.includes(`${L2} Open`) && reopenedPage.includes(`Reopened ${L2} — the period lock moved back`));
    const tighten = await booksActions.setBooksLock({ lockedUntil: end2 });
    ok("tightening the lock again reopens nothing and closes nothing", tighten.ok && (await statusOf(M1)).status === "CLOSED" && (await statusOf(M2)).status === "OPEN");

    const reclose = await closeActions.closeMonth(k2, { override: `${TAG}: again` });
    ok(`${L2} closed again`, reclose.ok);
    ok(`the lock at exactly ${L1}'s last day reopens ${L2} only`, (await booksActions.setBooksLock({ lockedUntil: end1 })).ok && (await statusOf(M1)).status === "CLOSED" && (await statusOf(M2)).status === "OPEN");
    await booksActions.setBooksLock({ lockedUntil: end2 });
    await closeActions.closeMonth(k2, { override: `${TAG}: and again` });
    const rolledBack = await db
      .$transaction(async (tx) => {
        await booksLock.moveBooksLock(tx, { lockedUntil: null, userId: manager.id });
        throw new Error("ROLLBACK");
      })
      .catch((err: Error) => err.message);
    ok("a lock change that rolls back takes its reopening with it", rolledBack === "ROLLBACK" && (await statusOf(M1)).status === "CLOSED" && (await statusOf(M2)).status === "CLOSED");
    const removed = await booksActions.setBooksLock({ lockedUntil: null });
    ok("removing the lock reopens every closed month", removed.ok && (await statusOf(M1)).status === "OPEN" && (await statusOf(M2)).status === "OPEN");
    const removedAudits = await db.auditLog.count({ where: { entityType: "CloseMonth", entityLabel: { contains: "the period lock was removed" } } });
    ok("  each audited on its month", removedAudits === 2, removedAudits);

    ok("the arithmetic: a lock on a month's last day leaves the next month above it", dayKey(booksLock.firstMonthAboveLock(new Date("2026-07-31T00:00:00Z"))) === "2026-08-01");
    ok("  mid-month leaves that month above it", dayKey(booksLock.firstMonthAboveLock(new Date("2026-07-15T00:00:00Z"))) === "2026-07-01");
    ok("  29 February in a leap year is February's end", dayKey(booksLock.firstMonthAboveLock(new Date("2024-02-29T00:00:00Z"))) === "2024-03-01" && dayKey(booksLock.firstMonthAboveLock(new Date("2024-02-28T00:00:00Z"))) === "2024-02-01");
    ok("  and December rolls into January", dayKey(booksLock.firstMonthAboveLock(new Date("2025-12-31T00:00:00Z"))) === "2026-01-01");

    section("Reopening a financial year reopens its closed months too");
    for (const m of [M1, M2]) await db.closeMonth.update({ where: { month: m }, data: { status: "CLOSED", closedAt: new Date(), closedById: owner.id } });
    await booksActions.setBooksLock({ lockedUntil: end2 });
    const fyStart = financialYearStartOf(midMonth(M1));
    const fyLabel = `${fyStart}-${String((fyStart + 1) % 100).padStart(2, "0")}`;
    await db.fiscalYearClose.create({
      data: { label: fyLabel, fromDate: new Date(Date.UTC(fyStart, 3, 1)), toDate: new Date(Date.UTC(fyStart + 1, 2, 31)), netProfit: 0, closedById: owner.id },
    });
    actor = owner;
    const fyStatus = await booksActions.getBooksStatus();
    const yearDialog = fyStatus.closes.find((c) => c.label === fyLabel);
    ok(`the closed months are listed for the ${fyLabel} reopen warning`, !!yearDialog && fyStatus.closedMonths.every((m) => m.end >= new Date(yearDialog.fromDate).toISOString().slice(0, 10)));
    const reopenedYear = await booksActions.reopenFinancialYear(fyLabel);
    ok(`reopening ${fyLabel} reopens ${L1} and ${L2}`, reopenedYear.ok && (await statusOf(M1)).status === "OPEN" && (await statusOf(M2)).status === "OPEN", reopenedYear.ok ? "" : reopenedYear.error);
    const yearAudits = await db.auditLog.count({ where: { entityType: "CloseMonth", entityLabel: { contains: `${fyLabel} was reopened on Close the Books` } } });
    ok("  each audited on its month", yearAudits === 2, yearAudits);
    const yearWording = await db.auditLog.findFirst({ where: { entityType: "FiscalYearClose" }, orderBy: { createdAt: "desc" }, select: { entityLabel: true } });
    ok("  and the year's own audit wording is unchanged", yearWording?.entityLabel === `Reopened ${fyLabel} — closing entry reversed`, yearWording?.entityLabel);
  });

  // ── The add-on switched off ─────────────────────────────────────────────────────────────────
  await runAsTenant(OFF, async () => {
    section("A workspace whose plan leaves the add-on out");
    const someone = await db.user.findFirstOrThrow({ where: { name: `${TAG} Manager` }, select: { id: true, name: true, email: true, role: true } });
    actor = someone;
    pathname = "/accounting/close";
    const offClose = text(await html(ClosePage({ searchParams: Promise.resolve({}) })));
    ok("the close page says the add-on isn't in the plan", offClose.includes("Revenue & Close isn't part of this workspace's plan"));
    ok("  and Prepaids & accruals", text(await html(SchedulesPage({ searchParams: Promise.resolve({}) }))).includes("isn't part of this workspace's plan"));
    ok("  and both settings pages", text(await html(SettingsRevenueClose())).includes("isn't part of this workspace's plan") && text(await html(SettingsChecklist())).includes("isn't part of this workspace's plan"));
    pathname = "/accounting";
    const offOverview = text(await html(OverviewPage()));
    ok("  the Accounting overview renders, without the close card", offOverview.includes("Accounting") && !offOverview.includes(" close:"));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
