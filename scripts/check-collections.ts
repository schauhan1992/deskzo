/**
 * Collections: salespeople following up their clients' pending payments — through the real actions,
 * against the real dev database.
 *
 *   · The rules without a database: a promised date is today or later in India; how a promise reads
 *     ("Due in 3 days", "Broken 2 days ago"); whether the money that came in kept it — received by the
 *     end of the promised day in India, entered after the promise, late entries counted.
 *   · Scope (owner decision C-D1): a salesperson sees their accounts plus the orders they punched on
 *     somebody else's, and not a stranger's; their manager sees the team's; `companies.viewAll` sees all.
 *     Nothing wider — asserted over the whole database, with a stranger's invoice and order present, and
 *     with a search typed.
 *   · Permissions: without `collections.followUp` there's no list and no logging; with it, logging works;
 *     accounts log through `payments.record`.
 *   · Logging: validation, a new promise superseding the open one, a task for the next follow-up (tasks
 *     on) or none (tasks off).
 *   · Kept: money applied to an invoice, and allocated to an order in two parts; a foreign-currency
 *     invoice's promise in its own currency.
 *   · The daily job at 00:30 IST (still the day before in UTC): broken and kept promises, the salesperson,
 *     the manager and the accounts summary told — once, however many times it runs — and the morning
 *     reminder where there is no task. A receipt dated in time and entered late turns BROKEN into KEPT.
 *   · Receivables' Broken promises and Promised this week filters.
 *   · The screens: My collections for a salesperson, a manager and accounts (and refused without the
 *     permission); the history on the invoice, the order and the statement.
 *
 * Everything is named ZZPROBE_COLL and removed in a finally — by the probe users, the probe companies and
 * the fixture's ids, never by name alone. Dates are written with India's offset spelled out; run it under
 * a foreign clock too:
 *
 *   npm run check:collections
 *   TZ=UTC npm run check:collections
 *   $env:TZ = "America/New_York"; npm run check:collections      (PowerShell)
 */
import "dotenv/config";
import Module from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { directClient } from "../src/lib/tenancy/direct-client";
import { addDays, checkFutureDay, dayKey, istToday, promiseOutcome, promiseState } from "../src/lib/collections/rules";

// ── Who the actions think is calling ───────────────────────────────────────────────────────────

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
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
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/collections",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const viewMode = { getViewMode: async () => "list" as const, setViewMode: async () => {} };
const email = { sendEmailNotification: async () => {} };
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/navigation", navigation],
  ["@/lib/session", session],
  ["@/actions/view-mode", viewMode],
  ["@/lib/email", email],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/navigation"), navigation],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("../src/actions/view-mode"), viewMode],
  [load.resolve("../src/lib/email"), email],
]);
/** `@/lib/auth` with only `auth` swapped: a proxy over the real exports (the invoice page asks it who is looking). */
const swap = (real: Record<string, unknown>, name: string, value: unknown) =>
  new Proxy(real, { get: (target, prop, receiver) => (prop === name ? value : Reflect.get(target, prop, receiver)) });
const authFile = load.resolve("../src/lib/auth");
let authWrapped: unknown = null;
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
  if (resolved === authFile) {
    authWrapped ??= swap(realLoad.call(this, request, parent, isMain) as Record<string, unknown>, "auth", async () =>
      actor ? { user: { id: actor.id, name: actor.name, email: actor.email, role: actor.role, sid: null } } : null,
    );
    return authWrapped;
  }
  return realLoad.call(this, request, parent, isMain);
};

const db = directClient();
const TAG = "ZZPROBE_COLL";
const MAIL = "@zzprobe-coll.invalid";
/** The daily job is tested on days long past, so no real promise can fall due by them. */
const JOB_DAYS = ["2026-01-14", "2026-01-15"];
const RENDERS = path.join(
  process.env.COLL_RENDERS ??
    "C:/Users/Sachin/AppData/Local/Temp/claude/C--Users-Sachin-Documents-wroffy-crm/add8f996-e6c0-485a-aa61-d048675d5458/scratchpad/collections/renders",
);

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${String(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : r.error);
const ist = (s: string) => new Date(`${s}+05:30`);
/** A day `n` days from today in India, as the date inputs send it. */
const plusDays = (n: number) => dayKey(addDays(istToday(new Date()), n));

/** Awaits every async server component in a tree, so a static render can take it. */
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
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;|\u00a0/g, " ")
    .replace(/\s+/g, " ");

/** Every follow-up and notification key the fixture made, gathered as it goes, for the cleanup. */
const fixtureFollowUps = new Set<string>();

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const companies = await db.company.findMany({
    where: { OR: [{ name: { startsWith: TAG } }, { createdById: { in: userIds } }, { ownerUserId: { in: userIds } }] },
    select: { id: true },
  });
  const companyIds = companies.map((c) => c.id);
  const followUps = await db.paymentFollowUp.findMany({
    where: { OR: [{ companyId: { in: companyIds } }, { byUserId: { in: userIds } }, { id: { in: [...fixtureFollowUps] } }] },
    select: { id: true },
  });
  const followUpIds = [...new Set([...followUps.map((f) => f.id), ...fixtureFollowUps])];
  const payments = await db.payment.findMany({ where: { OR: [{ companyId: { in: companyIds } }, { recordedByUserId: { in: userIds } }] }, select: { id: true } });
  const paymentIds = payments.map((p) => p.id);
  const documents = await db.tradeDocument.findMany({ where: { OR: [{ companyId: { in: companyIds } }, { docNumber: { startsWith: TAG } }] }, select: { id: true } });
  const documentIds = documents.map((d) => d.id);
  // Everybody the fixture told something — the probe users, and the real accounts people the summary reached.
  await db.notification.deleteMany({
    where: {
      OR: [
        { userId: { in: userIds } },
        { dedupeKey: { in: followUpIds.flatMap((id) => [`promise-broken:${id}`, `collections-next:${id}`]) } },
        { dedupeKey: { in: JOB_DAYS.map((d) => `promise-broken-summary:${d}`) } },
      ],
    },
  });
  await db.task.deleteMany({ where: { OR: [{ createdByUserId: { in: userIds } }, { assignedToUserId: { in: userIds } }, { companyId: { in: companyIds } }] } });
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { entityId: { in: [...followUpIds, ...companyIds, ...paymentIds, ...documentIds] } }] } });
  await db.paymentFollowUp.deleteMany({ where: { id: { in: followUpIds } } });
  // Nothing here posts to the ledger (the payments are made on account, applied at their own rate), but if
  // anything ever did, its entries go with the fixture rather than staying in the dev books.
  await db.journalEntry.deleteMany({ where: { OR: [{ paymentId: { in: paymentIds } }, { documentId: { in: documentIds } }, { companyId: { in: companyIds } }] } });
  await db.payment.deleteMany({ where: { id: { in: paymentIds } } });
  await db.tradeDocument.deleteMany({ where: { id: { in: documentIds } } });
  await db.companyProduct.deleteMany({ where: { OR: [{ companyId: { in: companyIds } }, { addedByUserId: { in: userIds } }, { item: { sku: { startsWith: TAG } } }] } });
  await db.companyLocation.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.item.deleteMany({ where: { sku: { startsWith: TAG } } });
  await db.dailyJobRun.deleteMany({ where: { job: "collections", day: { in: JOB_DAYS.map((d) => new Date(`${d}T00:00:00Z`)) } } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.updateMany({ where: { id: { in: userIds } }, data: { managerId: null } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  // ── The rules ────────────────────────────────────────────────────────────────────────────────
  section("The rules, without a database");

  const c1 = checkFutureDay("2026-09-30", ist("2026-09-30T23:59:00"), "promised date");
  const c2 = checkFutureDay("2026-09-30", ist("2026-10-01T00:01:00"), "promised date");
  ok("a promised date may be today in India: 30 Sep is fine at 23:59 IST on 30 Sep", c1.ok);
  ok("  and refused two minutes later, at 00:01 IST on 1 Oct (18:31 UTC on 30 Sep)", !c2.ok, c2.ok ? "accepted" : c2.error);
  ok("  a date that isn't one is refused, and so is one more than a year out", !checkFutureDay("2026-02-30", ist("2026-01-01T10:00:00"), "d").ok && !checkFutureDay("2027-12-01", ist("2026-09-30T10:00:00"), "d").ok);

  const due = (promisedOn: string, at: string, status: "OPEN" | "BROKEN" | "KEPT" | "SUPERSEDED" = "OPEN") =>
    promiseState({ promiseStatus: status, promisedOn: new Date(`${promisedOn}T00:00:00Z`) }, ist(at));
  ok("a promise three days out reads 'Due in 3 days', in amber", due("2026-10-03", "2026-09-30T10:00:00").text === "Due in 3 days" && due("2026-10-03", "2026-09-30T10:00:00").tone === "amber");
  ok("  on its day, 'Due today' — until midnight IST", due("2026-09-30", "2026-09-30T23:30:00").text === "Due today");
  ok(
    "  at 00:30 IST the next day (still the 30th in UTC) it reads 'Broken 1 day ago', in red",
    due("2026-09-30", "2026-10-01T00:30:00").text === "Broken 1 day ago" && due("2026-09-30", "2026-10-01T00:30:00").tone === "red",
    due("2026-09-30", "2026-10-01T00:30:00").text,
  );
  ok("  two days after, 'Broken 2 days ago'; kept is green and says so", due("2026-09-28", "2026-09-30T10:00:00", "BROKEN").text === "Broken 2 days ago" && due("2026-09-28", "2026-09-30T10:00:00", "KEPT").text === "Kept");

  const ev = (amount: number, recorded: string, effective = recorded) => ({ amount, recordedAt: ist(recorded), effectiveAt: ist(effective) });
  const base = { loggedAt: ist("2026-10-01T10:00:00"), promisedOn: new Date("2026-10-15T00:00:00Z"), promisedAmount: 5000, total: 10000 };
  const before = ev(2000, "2026-09-20T10:00:00");
  ok("money entered before the promise doesn't count toward it", !promiseOutcome({ ...base, events: [before, ev(3000, "2026-10-05T10:00:00")] }).kept);
  const lastMinute = promiseOutcome({ ...base, events: [before, ev(3000, "2026-10-05T10:00:00"), ev(2000, "2026-10-15T23:00:00")] });
  ok("  ₹3,000 then ₹2,000 at 23:00 IST on the promised day keeps a ₹5,000 promise", lastMinute.kept, JSON.stringify(lastMinute));
  const late = promiseOutcome({ ...base, events: [before, ev(3000, "2026-10-05T10:00:00"), ev(2000, "2026-10-16T00:10:00")] });
  ok("  the same ₹2,000 at 00:10 IST the next day (still the 15th in UTC) does not", !late.kept, JSON.stringify(late));
  ok(
    "  a receipt entered on the 20th but received on the 14th counts: the client kept their word",
    promiseOutcome({ ...base, events: [before, ev(5000, "2026-10-20T10:00:00", "2026-10-14T00:00:00")] }).kept,
  );
  const whole = promiseOutcome({ ...base, promisedAmount: null, events: [before, ev(7000, "2026-10-10T10:00:00")] });
  ok("with no amount, the promise is to clear what was owed when it was made (₹8,000)", !whole.kept && whole.needed === 8000, JSON.stringify(whole));
  ok("  a promise of more than was owed is kept by settling it in full", promiseOutcome({ ...base, promisedAmount: 9000, events: [before, ev(8000, "2026-10-10T10:00:00")] }).kept);

  /* eslint-disable @typescript-eslint/no-require-imports */
  const collections = require("../src/actions/collections") as typeof import("../src/actions/collections");
  const receivable = require("../src/actions/receivable") as typeof import("../src/actions/receivable");
  const payment = require("../src/actions/payment") as typeof import("../src/actions/payment");
  const { runCollectionsDaily } = require("../src/lib/collections/daily") as typeof import("../src/lib/collections/daily");
  const { resolvePromises } = require("../src/lib/collections/promises") as typeof import("../src/lib/collections/promises");
  const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
  const { formatMoney } = require("../src/lib/currency") as typeof import("../src/lib/currency");
  const { MODULE_REGISTRY, navPermissionKeys } = require("../src/lib/modules") as typeof import("../src/lib/modules");
  const { getPermissionDefinition } = require("../src/lib/permissions") as typeof import("../src/lib/permissions");
  const { ROLE_PRESETS } = require("../src/lib/authz/presets") as typeof import("../src/lib/authz/presets");
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const { LogFollowUpForm } = require("../src/components/collections/log-follow-up-button") as typeof import("../src/components/collections/log-follow-up-button");
  const { CompanyStatement } = require("../src/components/companies/company-statement") as typeof import("../src/components/companies/company-statement");
  const { DocumentDetail } = require("../src/components/documents/document-detail") as typeof import("../src/components/documents/document-detail");
  const { OrderDetail } = require("../src/components/orders/order-detail") as typeof import("../src/components/orders/order-detail");
  type PageFn = (p: unknown) => Promise<ReactElement>;
  const CollectionsPage = (require("../src/app/(dashboard)/collections/page") as { default: PageFn }).default;
  const ReceivablesPage = (require("../src/app/(dashboard)/receivables/page") as { default: PageFn }).default;
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("The permission");
  const def = getPermissionDefinition("collections.followUp");
  ok("collections.followUp is declared, off for every role by default", !!def && def.defaultRoles.length === 0, def?.label);
  ok(
    "  and switched on by the sales-executive and sales-manager presets",
    ["sales-executive", "sales-manager"].every((k) => ROLE_PRESETS.find((p) => p.key === k)?.permissions.includes("collections.followUp")),
  );
  const nav = MODULE_REGISTRY.find((m) => m.key === "receivables")?.navItems.find((i) => i.href === "/collections");
  ok("My collections is in Receivables' links, for collections.followUp", !!nav && navPermissionKeys(nav).join() === "collections.followUp", nav?.label);

  await cleanup();
  // Real promises in the dev database, as they were: the daily job below must leave every one of them alone.
  const othersBefore = JSON.stringify(
    await db.paymentFollowUp.findMany({ orderBy: { id: "asc" }, select: { id: true, promiseStatus: true, brokenNotifiedAt: true } }),
  );
  const tasksSwitch = await db.systemModule.findUnique({ where: { key: "tasks" } });
  try {
    // ── Fixture ────────────────────────────────────────────────────────────────────────────────
    section("Fixture");
    const make = (name: string, grants: Record<string, boolean>, extra: { managerId?: string } = {}) =>
      db.user.create({
        data: {
          name: `Zzprobe ${name}`,
          email: `${name}${MAIL}`,
          role: "PROFILE",
          passwordHash: "x".repeat(60),
          ...extra,
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
        select: { id: true, name: true, email: true, role: true },
      });
    const seen = { "payments.view": true, "documents.view": true, "orders.view": true, "permissions.view": false, "payments.delete": false };
    const collector = { ...seen, "collections.followUp": true, "payments.record": false, "companies.viewAll": false };
    const manager = await make("manager", collector);
    const sales = await make("sales", collector, { managerId: manager.id });
    const stranger = await make("stranger", collector);
    const plain = await make("plain", { ...seen, "collections.followUp": false, "payments.record": false, "companies.viewAll": false });
    const accounts = await make("accounts", { ...seen, "collections.followUp": false, "payments.record": true, "companies.viewAll": true });
    const auditor = await make("auditor", { ...seen, "collections.followUp": false, "payments.record": false, "companies.viewAll": true });
    const as = (u: Actor) => {
      actor = u;
    };
    ok(
      "a salesperson and their manager with the permission, a stranger with it, somebody without it, accounts and a read-only viewer",
      (await can(sales.id, "collections.followUp")) && !(await can(plain.id, "collections.followUp")) && (await can(accounts.id, "payments.record")) && !(await can(sales.id, "companies.viewAll")),
    );

    const company = async (name: string, ownerUserId: string) => {
      const c = await db.company.create({
        data: { name: `${TAG} ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), createdById: ownerUserId, ownerUserId, relationshipType: "CLIENT", stage: "CUSTOMER" },
        select: { id: true, name: true },
      });
      const location = await db.companyLocation.create({ data: { companyId: c.id, label: "Head Office", isPrimary: true }, select: { id: true } });
      return { ...c, locationId: location.id };
    };
    const alpha = await company("Alpha", sales.id);
    const strangerCo = await company("Stranger", stranger.id);
    const shared = await company("Shared", stranger.id);
    const plainCo = await company("Plain", plain.id);
    const item = await db.item.create({ data: { name: `${TAG} Licence`, sku: `${TAG}-1`, type: "SERVICE", sellingPrice: 1000, taxRatePercent: 18, createdById: sales.id } });

    const now = new Date();
    const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
    const order = (c: { id: string; locationId: string }, by: string, extra: Record<string, unknown> = {}) =>
      db.companyProduct.create({
        data: { companyId: c.id, locationId: c.locationId, itemId: item.id, quantity: 1, unitPrice: 1000, addedByUserId: by, orderStatus: "APPROVED", accountsApprovedAt: daysAgo(20), ...extra },
        select: { id: true, orderSeq: true },
      });
    const o1 = await order(alpha, sales.id); // ₹1,180 on the salesperson's own account
    const o2 = await order(shared, sales.id); // punched by the salesperson on the stranger's account, then invoiced
    const o3 = await order(strangerCo, stranger.id); // the stranger's own
    const o4 = await order(alpha, sales.id, { orderStatus: "CANCELLED" }); // nothing to chase
    const o5 = await order(alpha, sales.id, { purchaseRelease: "HELD", bookedAt: null }); // held: still owes what it owes

    let seq = 0;
    const invoice = async (c: { id: string }, total: number, opts: { due?: Date; currency?: string; rate?: number; status?: "ISSUED" | "DRAFT"; orderId?: string } = {}) => {
      seq += 1;
      const doc = await db.tradeDocument.create({
        data: {
          docNumber: `${TAG}-INV-${seq}`,
          docType: "INVOICE",
          direction: "SALES",
          status: opts.status ?? "ISSUED",
          companyId: c.id,
          createdById: sales.id,
          issueDate: daysAgo(60),
          dueDate: opts.due ?? null,
          currency: opts.currency ?? "INR",
          exchangeRate: opts.rate ?? 1,
          subtotal: total,
          taxableValue: total,
          total,
          ...(opts.orderId
            ? { lines: { create: [{ companyProductId: opts.orderId, itemId: item.id, name: `${TAG} Licence`, quantity: 1, unitPrice: total, taxableValue: total, lineTotal: total }] } }
            : {}),
        },
        select: { id: true, docNumber: true },
      });
      return doc;
    };
    const inv1 = await invoice(alpha, 10000, { due: daysAgo(45) });
    const invFx = await invoice(alpha, 1000, { due: new Date(now.getTime() + 10 * 86_400_000), currency: "USD", rate: 83 });
    const inv2 = await invoice(shared, 1180, { due: daysAgo(5), orderId: o2.id });
    const inv3 = await invoice(strangerCo, 5000, { due: daysAgo(10) });
    const invP = await invoice(plainCo, 2000, { due: daysAgo(3) });
    const draft = await invoice(alpha, 999, { status: "DRAFT" });
    ok("four client companies, five orders and six invoices (one a draft, one in USD, one billing the punched order)", true);

    // ── Scope ──────────────────────────────────────────────────────────────────────────────────
    section("Scope (C-D1) — nothing wider");

    const keys = (list: Awaited<ReturnType<typeof collections.listCollections>>) =>
      (list?.groups ?? []).flatMap((g) => g.rows.map((r) => r.key)).sort();
    const want = (...k: string[]) => k.sort();
    const salesSet = want(`invoice:${inv1.id}`, `invoice:${invFx.id}`, `invoice:${inv2.id}`, `order:${o1.id}`, `order:${o5.id}`);

    as(sales);
    const mine = await collections.listCollections();
    ok(
      "the salesperson sees their account's invoices and orders, and the invoice billing the order they punched on the stranger's account — and not one row more, over the whole database",
      JSON.stringify(keys(mine)) === JSON.stringify(salesSet),
      keys(mine).join(", "),
    );
    const punched = mine?.groups.flatMap((g) => g.rows).find((r) => r.id === inv2.id);
    ok("  that invoice is marked as theirs through the order, not their account (no link to a page that would refuse them)", punched?.onTheirAccount === false && punched.punchedBy === "Zzprobe sales");
    ok(
      "  not the stranger's invoice or order, the cancelled order, the draft, or the other salesperson's client",
      !keys(mine).some((k) => [inv3.id, o3.id, o4.id, draft.id, invP.id].some((id) => k.endsWith(id))),
    );
    const searched = await collections.listCollections({ q: "Stranger" });
    ok("  searching for the stranger's client finds nothing — the search narrows the scope, never replaces it", keys(searched).length === 0, keys(searched).join(", "));
    const searchedShared = await collections.listCollections({ q: "Shared" });
    ok("  and searching for the shared client finds only the invoice for their order", JSON.stringify(keys(searchedShared)) === JSON.stringify([`invoice:${inv2.id}`]), keys(searchedShared).join(", "));

    as(manager);
    const team = await collections.listCollections();
    ok("the manager sees their team's — exactly the salesperson's rows, nothing else in the database", JSON.stringify(keys(team)) === JSON.stringify(salesSet), keys(team).join(", "));

    as(stranger);
    const theirs = await collections.listCollections();
    ok(
      "the stranger sees their own accounts — the shared client's invoice included — and none of the salesperson's",
      JSON.stringify(keys(theirs)) === JSON.stringify(want(`invoice:${inv3.id}`, `invoice:${inv2.id}`, `order:${o3.id}`)),
      keys(theirs).join(", "),
    );

    as(accounts);
    const everything = await collections.listCollections({ q: TAG });
    ok(
      "companies.viewAll (accounts) sees every account's",
      JSON.stringify(keys(everything)) ===
        JSON.stringify(want(`invoice:${inv1.id}`, `invoice:${invFx.id}`, `invoice:${inv2.id}`, `invoice:${inv3.id}`, `invoice:${invP.id}`, `order:${o1.id}`, `order:${o3.id}`, `order:${o5.id}`)),
      keys(everything).join(", "),
    );
    const fxRow = everything?.groups.flatMap((g) => g.rows).find((r) => r.id === invFx.id);
    ok("  a USD invoice is outstanding in dollars, and ₹ at its own rate for the totals", fxRow?.currency === "USD" && fxRow.balance === 1000 && fxRow.balanceInr === 83000, JSON.stringify({ c: fxRow?.currency, b: fxRow?.balance, inr: fxRow?.balanceInr }));
    const inv1Row = everything?.groups.flatMap((g) => g.rows).find((r) => r.id === inv1.id);
    ok("  a 45-days-overdue invoice sits in the 31–60 bucket", inv1Row?.daysOverdue === 45 && inv1Row.bucket === "d31_60", `${inv1Row?.daysOverdue} ${inv1Row?.bucket}`);

    // ── Permissions ────────────────────────────────────────────────────────────────────────────
    section("Permissions");
    as(plain);
    ok("without collections.followUp there's no list", (await collections.listCollections()) === null);
    const refused = await collections.logFollowUp({ documentId: invP.id, channel: "CALL", remarks: "Tried" });
    ok("  and no logging, even on their own account's invoice", !refused.ok && /permission/.test(refused.error), errorOf(refused));
    as(sales);
    const outOfScope = await collections.logFollowUp({ documentId: inv3.id, channel: "CALL", remarks: "Nosy" });
    ok("with it, a stranger's invoice is refused as not theirs", !outOfScope.ok && /isn't in your collections/.test(outOfScope.error), errorOf(outOfScope));
    const onPunched = await collections.logFollowUp({ documentId: inv2.id, channel: "WHATSAPP", remarks: "Shared the invoice again" });
    ok("  and the invoice for the order they punched on it is theirs to chase", onPunched.ok, errorOf(onPunched));
    if (onPunched.ok) fixtureFollowUps.add(onPunched.data.id);
    as(accounts);
    const byAccounts = await collections.logFollowUp({ documentId: inv3.id, channel: "EMAIL", remarks: "Statement sent to their AP team" });
    ok("accounts log follow-ups through payments.record, on any account", byAccounts.ok, errorOf(byAccounts));
    if (byAccounts.ok) fixtureFollowUps.add(byAccounts.data.id);

    // ── Logging ────────────────────────────────────────────────────────────────────────────────
    section("Logging a follow-up");
    as(sales);
    const log = async (input: Record<string, unknown>) => {
      const r = await collections.logFollowUp(input);
      if (r.ok) fixtureFollowUps.add(r.data.id);
      return r;
    };
    const blank = await log({ documentId: inv1.id, channel: "CALL", remarks: "   " });
    ok("remarks are required", !blank.ok, errorOf(blank));
    const long = await log({ documentId: inv1.id, channel: "CALL", remarks: "x".repeat(1001) });
    ok("  and at most 1,000 characters", !long.ok, errorOf(long));
    const yesterday = await log({ documentId: inv1.id, channel: "CALL", remarks: "Will pay", promisedOn: plusDays(-1) });
    ok("a promised date before today in India is refused", !yesterday.ok && /past/.test(yesterday.error), errorOf(yesterday));
    const noDate = await log({ documentId: inv1.id, channel: "CALL", remarks: "Will pay", promisedAmount: 100 });
    ok("  an amount without a date is refused", !noDate.ok, errorOf(noDate));
    const tooMuch = await log({ documentId: inv1.id, channel: "CALL", remarks: "Will pay", promisedOn: plusDays(3), promisedAmount: 10000.5 });
    ok("  and more than is outstanding (₹10,000)", !tooMuch.ok && tooMuch.error.includes(formatMoney(10000, "INR")), errorOf(tooMuch));
    const onDraft = await log({ documentId: draft.id, channel: "CALL", remarks: "Hm" });
    ok("  a draft invoice isn't in the list, so it can't be followed up", !onDraft.ok, errorOf(onDraft));
    const onCancelled = await log({ companyProductId: o4.id, channel: "CALL", remarks: "Hm" });
    ok("  nor a cancelled order", !onCancelled.ok, errorOf(onCancelled));

    const f1 = await log({ documentId: inv1.id, channel: "CALL", remarks: "Accounts will release ₹4,000 this week", promisedOn: plusDays(3), promisedAmount: 4000 });
    ok("a promise is logged, OPEN", f1.ok && (await db.paymentFollowUp.findUnique({ where: { id: f1.data.id } }))?.promiseStatus === "OPEN", errorOf(f1));
    const f2 = await log({ documentId: inv1.id, channel: "MEETING", remarks: "Met the CFO: ₹3,000 by Friday, the rest next month", promisedOn: plusDays(5), promisedAmount: 3000 });
    const f1After = f1.ok ? await db.paymentFollowUp.findUnique({ where: { id: f1.data.id } }) : null;
    ok("a new promise on the same invoice marks the open one SUPERSEDED", f2.ok && f1After?.promiseStatus === "SUPERSEDED" && !!f1After.promiseResolvedAt, f1After?.promiseStatus);
    const forToday = await log({ documentId: inv1.id, channel: "CALL", remarks: "Reminded them; no change", promisedOn: plusDays(0) });
    ok("  a promise for today in India is accepted", forToday.ok, errorOf(forToday));
    const f2After = f2.ok ? await db.paymentFollowUp.findUnique({ where: { id: f2.data.id } }) : null;
    ok("  (and superseded the ₹3,000 one in turn)", f2After?.promiseStatus === "SUPERSEDED", f2After?.promiseStatus);
    const f3 = await log({ documentId: inv1.id, channel: "MEETING", remarks: "Confirmed: ₹3,000 by Friday", promisedOn: plusDays(5), promisedAmount: 3000 });
    const remarksOnly = await log({ documentId: inv1.id, channel: "CALL", remarks: "Chased the cheque" });
    const f3After = f3.ok ? await db.paymentFollowUp.findUnique({ where: { id: f3.data.id } }) : null;
    ok("a follow-up with no promise leaves the open promise alone", remarksOnly.ok && f3After?.promiseStatus === "OPEN", f3After?.promiseStatus);
    const audit = f3.ok ? await db.auditLog.findFirst({ where: { entityType: "PaymentFollowUp", entityId: f3.data.id } }) : null;
    ok("each follow-up is audited", !!audit && audit.action === "CREATE" && audit.userId === sales.id, audit?.entityLabel);

    const withTask = await log({ companyProductId: o1.id, channel: "CALL", remarks: "Payment in process", nextFollowUpOn: plusDays(1) });
    const withTaskRow = withTask.ok ? await db.paymentFollowUp.findUnique({ where: { id: withTask.data.id } }) : null;
    const task = withTaskRow?.taskId ? await db.task.findUnique({ where: { id: withTaskRow.taskId } }) : null;
    ok(
      "with the tasks module on, a next follow-up date is a task for the salesperson, due that day",
      !!task && task.assignedToUserId === sales.id && task.dueDate?.toISOString().slice(0, 10) === plusDays(1) && task.title.includes(`${TAG} Alpha`),
      task ? `${task.title} · ${task.dueDate?.toISOString()}` : errorOf(withTask),
    );
    await db.systemModule.upsert({ where: { key: "tasks" }, create: { key: "tasks", enabled: false }, update: { enabled: false } });
    const noTask = await log({ documentId: inv1.id, channel: "VISIT", remarks: "Left the statement at reception", nextFollowUpOn: plusDays(0) });
    // Back as it was straight away — the dev server shares this switch.
    if (tasksSwitch) await db.systemModule.update({ where: { key: "tasks" }, data: { enabled: tasksSwitch.enabled } });
    else await db.systemModule.delete({ where: { key: "tasks" } });
    const noTaskRow = noTask.ok ? await db.paymentFollowUp.findUnique({ where: { id: noTask.data.id } }) : null;
    ok("  with it off, no task — the daily job reminds them that morning instead (below)", noTask.ok && noTaskRow?.taskId === null, errorOf(noTask));

    // ── Kept ───────────────────────────────────────────────────────────────────────────────────
    section("A payment before the date keeps the promise");
    const onAccount = (companyId: string, amount: number, paidOn: Date, currency = "INR", exchangeRate = 1) =>
      db.payment.create({
        data: { companyId, amount, paidOn, method: "BANK_TRANSFER", currency, exchangeRate, recordedByUserId: accounts.id, reference: TAG },
        select: { id: true },
      });
    as(accounts);
    const pay1 = await onAccount(alpha.id, 3000, new Date(`${plusDays(0)}T00:00:00Z`));
    const applied = await receivable.applyPaymentToInvoice(pay1.id, inv1.id, 3000);
    const f3Kept = f3.ok ? await db.paymentFollowUp.findUnique({ where: { id: f3.data.id } }) : null;
    ok("₹3,000 applied to the invoice keeps the ₹3,000 promise — at once, from the payment action", applied.ok && f3Kept?.promiseStatus === "KEPT" && !!f3Kept.promiseResolvedAt, `${errorOf(applied)} ${f3Kept?.promiseStatus}`);

    as(sales);
    const orderPromise = await log({ companyProductId: o1.id, channel: "CALL", remarks: "Full amount by Thursday", promisedOn: plusDays(2) });
    as(accounts);
    const pay2 = await onAccount(alpha.id, 1180, new Date(`${plusDays(0)}T00:00:00Z`));
    const part1 = await payment.allocatePayment({ paymentId: pay2.id, companyProductId: o1.id, amount: 500 });
    const orderAfterPart = orderPromise.ok ? await db.paymentFollowUp.findUnique({ where: { id: orderPromise.data.id } }) : null;
    ok("half of an order's promised clearance leaves the promise open", part1.ok && orderAfterPart?.promiseStatus === "OPEN", `${errorOf(part1)} ${orderAfterPart?.promiseStatus}`);
    const part2 = await payment.allocatePayment({ paymentId: pay2.id, companyProductId: o1.id, amount: 680 });
    const orderAfterAll = orderPromise.ok ? await db.paymentFollowUp.findUnique({ where: { id: orderPromise.data.id } }) : null;
    ok("  the rest keeps it (no amount promised: the whole ₹1,180)", part2.ok && orderAfterAll?.promiseStatus === "KEPT", `${errorOf(part2)} ${orderAfterAll?.promiseStatus}`);

    // ── Foreign currency ───────────────────────────────────────────────────────────────────────
    section("A foreign-currency invoice's promise, in its own currency");
    as(sales);
    const fxTooMuch = await log({ documentId: invFx.id, channel: "EMAIL", remarks: "Will wire it", promisedOn: plusDays(6), promisedAmount: 1200 });
    ok("$1,200 against a $1,000 invoice is refused in dollars, not measured against ₹83,000", !fxTooMuch.ok && fxTooMuch.error.includes(formatMoney(1000, "USD")), errorOf(fxTooMuch));
    const fx = await log({ documentId: invFx.id, channel: "EMAIL", remarks: "Wire of $400 on its way", promisedOn: plusDays(6), promisedAmount: 400 });
    const fxView = (await collections.listCollections())?.groups.flatMap((g) => g.rows).find((r) => r.id === invFx.id)?.promise;
    ok("$400 promised is held and shown as dollars", fx.ok && fxView?.currency === "USD" && fxView.promisedAmount === 400, JSON.stringify({ c: fxView?.currency, a: fxView?.promisedAmount }));
    const formHtml = renderToStaticMarkup(
      createElement(LogFollowUpForm, { target: { documentId: invFx.id, label: invFx.docNumber, companyName: alpha.name, balance: 1000, currency: "USD" }, onDone: () => {}, onCancel: () => {} }),
    );
    const formText = text(formHtml);
    ok(
      "  the dialog asks for the amount in USD, and shows what's outstanding in dollars",
      formText.includes("Amount (USD)") && formText.includes(`${formatMoney(1000, "USD")} outstanding on ${invFx.docNumber}`) && formText.includes("In USD, the invoice's currency"),
    );
    ok("  every field in it is labelled", ["How you reached them", "What the client said", "Will pay by", "Next follow-up (optional)"].every((l) => formText.includes(l)) && (formHtml.match(/<label[^>]*for="/g) ?? []).length === 5);

    // Receivables' "Promised this week", before the dollars arrive.
    as(accounts);
    const week = await receivable.agingReport({ search: TAG, promise: "week" });
    ok("Receivables' Promised this week has the client with $400 due in six days", week.rows.some((r) => r.id === alpha.id), week.rows.map((r) => r.name).join(", "));
    const usd = await onAccount(alpha.id, 400, new Date(`${plusDays(0)}T00:00:00Z`), "USD", 83);
    const fxApplied = await receivable.applyPaymentToInvoice(usd.id, invFx.id, 400);
    const fxAfter = fx.ok ? await db.paymentFollowUp.findUnique({ where: { id: fx.data.id } }) : null;
    ok("$400 received keeps it", fxApplied.ok && fxAfter?.promiseStatus === "KEPT", `${errorOf(fxApplied)} ${fxAfter?.promiseStatus}`);

    // ── The daily job ──────────────────────────────────────────────────────────────────────────
    section("The daily job, at 00:30 IST (still yesterday in UTC)");
    as(sales);
    const fb = await log({ companyProductId: o5.id, channel: "CALL", remarks: "Held order — will pay before we release it", promisedOn: plusDays(0), promisedAmount: 1180 });
    const fk = await log({ documentId: inv2.id, channel: "CALL", remarks: "Paying ₹500 of the shared invoice", promisedOn: plusDays(0), promisedAmount: 500 });
    as(accounts);
    const fl = await log({ documentId: inv3.id, channel: "CALL", remarks: "Their AP says the 13th", promisedOn: plusDays(0), promisedAmount: 5000 });
    const ids = [fb, fk, fl].map((r) => (r.ok ? r.data.id : ""));
    ok("three promises for the job: a held order's, the shared invoice's, and one accounts logged", ids.every(Boolean), [fb, fk, fl].map(errorOf).join(" / "));
    // Moved onto a day long past, so the job's clock can be set there without touching real promises.
    await db.paymentFollowUp.updateMany({ where: { id: { in: ids } }, data: { createdAt: ist("2026-01-10T10:00:00"), promisedOn: new Date("2026-01-13T00:00:00Z") } });
    const reminded = [noTask, withTask].map((r) => (r.ok ? r.data.id : ""));
    await db.paymentFollowUp.updateMany({ where: { id: { in: reminded } }, data: { nextFollowUpOn: new Date("2026-01-14T00:00:00Z") } });

    const early = await resolvePromises(ist("2026-01-13T23:59:00"));
    const status = async (id: string) => (await db.paymentFollowUp.findUnique({ where: { id }, select: { promiseStatus: true } }))?.promiseStatus;
    ok("at 23:59 IST on the promised day, nothing is broken yet", !early.broken.some((id) => ids.includes(id)) && (await status(ids[0]!)) === "OPEN", JSON.stringify(early));
    // ₹500 of the shared invoice paid on the 12th — entered now, and not through an action, so only the job sees it.
    const lateEntry = await onAccount(shared.id, 500, new Date("2026-01-12T00:00:00Z"));
    await db.paymentAllocation.create({ data: { paymentId: lateEntry.id, documentId: inv2.id, amount: 500, allocatedByUserId: accounts.id } });

    const notices = (where: Record<string, unknown>) => db.notification.findMany({ where, select: { userId: true, type: true, title: true, message: true, link: true } });
    const run1 = await runCollectionsDaily(ist("2026-01-14T00:30:00"));
    ok("the job runs once for the day", run1.ran && run1.day === "2026-01-14", JSON.stringify(run1));
    ok("  the held order's promise is BROKEN — the day is India's, not UTC's", (await status(ids[0]!)) === "BROKEN");
    ok("  the shared invoice's ₹500 is KEPT: paid on the 12th", (await status(ids[1]!)) === "KEPT");
    ok("  and the one accounts logged is BROKEN", (await status(ids[2]!)) === "BROKEN");
    const title = `${TAG} Alpha promised ${formatMoney(1180, "INR")} by 13 Jan — not received`;
    const toSales = await notices({ userId: sales.id, dedupeKey: `promise-broken:${ids[0]}` });
    ok("the salesperson is told: '<Client> promised ₹X by 13 Jan — not received'", toSales.length === 1 && toSales[0]!.title === title && toSales[0]!.link === "/collections?filter=broken", toSales[0]?.title);
    ok("  as Collections' own type, not a task's", toSales[0]?.type === "PAYMENT_PROMISE_BROKEN", toSales[0]?.type);
    const toManager = await notices({ userId: manager.id, dedupeKey: `promise-broken:${ids[0]}` });
    ok("  and their reporting manager, saying who logged it", toManager.length === 1 && toManager[0]!.title === title && toManager[0]!.type === "PAYMENT_PROMISE_BROKEN" && (toManager[0]!.message ?? "").includes("Logged by Zzprobe sales"), toManager[0]?.message);
    const toAccountsOwn = await notices({ userId: accounts.id, dedupeKey: `promise-broken:${ids[2]}` });
    ok("  accounts, who logged the other, are told of theirs", toAccountsOwn.length === 1);
    const summary = await notices({ dedupeKey: "promise-broken-summary:2026-01-14" });
    const holders = await (async () => {
      // Every active person holding payments.record, less anybody who has switched this type off.
      const muted = new Set((await db.notificationPreference.findMany({ where: { type: "PAYMENT_PROMISES_SUMMARY", inApp: false }, select: { userId: true } })).map((m) => m.userId));
      const people = await db.user.findMany({ where: { active: true, kind: "MEMBER" }, select: { id: true } });
      const out: string[] = [];
      for (const p of people) if (!muted.has(p.id) && (await can(p.id, "payments.record"))) out.push(p.id);
      return out;
    })();
    ok(
      "one daily summary to every payments.record holder (people only), linking to Broken promises on Receivables",
      summary.length === holders.length && summary.some((s) => s.userId === accounts.id) && summary.every((s) => s.type === "PAYMENT_PROMISES_SUMMARY" && s.link === "/receivables?promise=broken" && s.title === "2 promises to pay broken"),
      `${summary.length} sent, ${holders.length} holders; ${summary[0]?.title}`,
    );
    ok("  naming the clients", (summary.find((s) => s.userId === accounts.id)?.message ?? "").includes(`${TAG} Alpha`) && (summary.find((s) => s.userId === accounts.id)?.message ?? "").includes(`${TAG} Stranger`));
    ok("  not the salesperson or the manager, who hold no payments.record", !summary.some((s) => s.userId === sales.id || s.userId === manager.id));
    const reminder = await notices({ userId: sales.id, dedupeKey: `collections-next:${reminded[0]}` });
    ok("the morning reminder for the follow-up with no task (tasks were off)", reminder.length === 1 && reminder[0]!.type === "PAYMENT_FOLLOW_UP_DUE" && reminder[0]!.title.includes("today"), reminder[0]?.title);
    ok("  and none for the one with a task — the task is the reminder", (await notices({ dedupeKey: `collections-next:${reminded[1]}` })).length === 0);

    const counts = async () =>
      (await notices({ OR: [{ dedupeKey: { in: ids.map((id) => `promise-broken:${id}`) } }, { dedupeKey: { startsWith: "promise-broken-summary:2026-01-1" } }, { dedupeKey: `collections-next:${reminded[0]}` }] })).length;
    const before2 = await counts();
    const run2 = await runCollectionsDaily(ist("2026-01-14T09:00:00"));
    ok("run again the same day, it doesn't run", !run2.ran && run2.reason === "already ran today", run2.reason);
    const run3 = await runCollectionsDaily(ist("2026-01-15T00:30:00"));
    ok("  the next day it runs, and tells nobody again", run3.ran && run3.notified === 0 && run3.summaryTo === 0 && run3.reminders === 0 && (await counts()) === before2, JSON.stringify(run3));
    const claims = await db.dailyJobRun.count({ where: { job: "collections", day: { in: JOB_DAYS.map((d) => new Date(`${d}T00:00:00Z`)) } } });
    ok("  one claim row per day", claims === 2, claims);

    // Receivables' Broken promises, while one is broken on an invoice.
    const broken = await receivable.agingReport({ search: TAG, promise: "broken" });
    ok("Receivables' Broken promises has the stranger's client (its invoice's promise broke) and not Alpha", broken.rows.some((r) => r.id === strangerCo.id) && !broken.rows.some((r) => r.id === alpha.id), broken.rows.map((r) => r.name).join(", "));
    const aging = await receivable.agingReport({ search: TAG });
    const alphaAging = aging.rows.find((r) => r.id === alpha.id);
    ok("  and the ageing list carries each client's last follow-up", alphaAging?.lastFollowUp?.byName === "Zzprobe sales", alphaAging?.lastFollowUp?.remarks);

    section("Money received in time but entered late");
    const inTime = await onAccount(strangerCo.id, 5000, new Date("2026-01-12T00:00:00Z"));
    const lateApplied = await receivable.applyPaymentToInvoice(inTime.id, inv3.id, 5000);
    ok("a receipt dated the 12th, entered now, turns the broken promise KEPT", lateApplied.ok && (await status(ids[2]!)) === "KEPT", `${errorOf(lateApplied)} ${await status(ids[2]!)}`);
    const brokenAfter = await receivable.agingReport({ search: TAG, promise: "broken" });
    ok("  and the client leaves Broken promises", !brokenAfter.rows.some((r) => r.id === strangerCo.id));

    const othersAfter = JSON.stringify(
      await db.paymentFollowUp.findMany({ where: { id: { notIn: [...fixtureFollowUps] } }, orderBy: { id: "asc" }, select: { id: true, promiseStatus: true, brokenNotifiedAt: true } }),
    );
    ok("every real promise in the database is as it was", othersAfter === othersBefore, `${JSON.parse(othersBefore).length} real follow-ups`);

    // ── The screens ────────────────────────────────────────────────────────────────────────────
    section("The screens");
    mkdirSync(RENDERS, { recursive: true });
    const save = (name: string, html: string) => writeFileSync(path.join(RENDERS, `${name}.html`), html);
    const page = async (who: Actor, name: string, fn: PageFn, searchParams: Record<string, string> = {}) => {
      as(who);
      const html = renderToStaticMarkup((await resolveAsync(await fn({ searchParams: Promise.resolve(searchParams), params: Promise.resolve({}) }))) as ReactElement);
      save(name, html);
      return { html, text: text(html) };
    };

    const salesPage = await page(sales, "collections-salesperson", CollectionsPage);
    ok(
      "My collections for the salesperson: their clients, the tiles, the filters",
      ["My collections", `${TAG} Alpha`, `${TAG} Shared`, "Total pending", "Promised this week", "Broken promises", "Promise broken", "No follow-up in 14 days", "Most overdue", "Largest amount"].every((s) => salesPage.text.includes(s)) &&
        !salesPage.text.includes(`${TAG} Stranger`) &&
        !salesPage.text.includes(`${TAG} Plain`),
    );
    ok(
      "  each due with its last follow-up, its promise in words, and Log follow-up",
      salesPage.text.includes("Left the statement at reception") &&
        /Broken \d+ days ago/.test(salesPage.text) &&
        salesPage.text.includes("Log follow-up") &&
        salesPage.text.includes("punched by Zzprobe sales"),
    );
    ok("  the shared client's invoice has no link — its page would refuse them", !salesPage.html.includes(`href="/documents/${inv2.id}"`) && salesPage.html.includes(`href="/documents/${inv1.id}"`));
    const brokenPage = await page(sales, "collections-salesperson-broken", CollectionsPage, { filter: "broken" });
    ok("  the Promise broken filter shows the held order, and not the others", brokenPage.text.includes(`ORD-${String(o5.orderSeq).padStart(6, "0")}`) && !brokenPage.text.includes(inv1.docNumber));
    const managerPage = await page(manager, "collections-manager", CollectionsPage);
    ok("My collections for the manager: the team's", managerPage.text.includes(`${TAG} Alpha`) && managerPage.text.includes(`${TAG} Shared`) && !managerPage.text.includes(`${TAG} Plain`));
    const accountsPage = await page(accounts, "collections-accounts", CollectionsPage, { q: TAG });
    ok("  for accounts: every account's", [`${TAG} Alpha`, `${TAG} Shared`, `${TAG} Stranger`, `${TAG} Plain`].every((s) => accountsPage.text.includes(s)) && accountsPage.text.includes("What every client owes"));
    const plainPage = await page(plain, "collections-refused", CollectionsPage);
    ok("  and refused without the permission, naming it", plainPage.text.includes("Follow up payments on their accounts") && !plainPage.text.includes(`${TAG} Plain`));

    const receivablesPage = await page(accounts, "receivables-accounts", ReceivablesPage, { q: TAG });
    ok("Receivables for accounts: the Broken promises and Promised this week filters, and the last follow-up", ["Broken promises", "Promised this week", "Last follow-up", "Zzprobe sales"].every((s) => receivablesPage.text.includes(s)));

    /** The words, plus the markup (as `.html`) for asserting on a button that is or isn't there. */
    const render = async (who: Actor, name: string, el: ReactElement) => {
      as(who);
      const html = renderToStaticMarkup((await resolveAsync(el)) as ReactElement);
      save(name, html);
      return Object.assign(text(html), { html });
    };
    const invoicePage = await render(accounts, "invoice-accounts", createElement(DocumentDetail, { id: inv1.id }));
    ok(
      "the invoice shows its follow-up history to accounts — who, how, what was said, the promise and how it ended",
      ["Payment follow-ups", "Met the CFO", "Replaced by a later promise", "Kept", "Zzprobe sales", "Meeting", "Log follow-up"].every((s) => invoicePage.includes(s)),
    );
    const invoiceAuditor = await render(auditor, "invoice-read-only", createElement(DocumentDetail, { id: inv1.id }));
    ok("  a read-only viewer of the account sees the history, without Log follow-up", invoiceAuditor.includes("Met the CFO") && !invoiceAuditor.html.includes(">Log follow-up</button>"));
    const orderPage = await render(sales, "order-salesperson", createElement(OrderDetail, { id: o1.id }));
    ok("the order page shows its follow-ups", orderPage.includes("Payment follow-ups") && orderPage.includes("Full amount by Thursday") && orderPage.includes("Kept"));
    as(accounts);
    const statement = await receivable.customerStatement(alpha.id);
    const statementText = await render(accounts, "statement-accounts", createElement(CompanyStatement, { statement: statement! }));
    ok(
      "the customer statement shows every follow-up on the account, naming the invoice or order, with Follow up beside open invoices",
      statementText.includes("Payment follow-ups") && statementText.includes(inv1.docNumber) && statementText.includes("Full amount by Thursday") && statementText.html.includes(">Follow up</button>"),
    );
    as(auditor);
    const auditorStatement = await receivable.customerStatement(alpha.id);
    const auditorText = await render(auditor, "statement-read-only", createElement(CompanyStatement, { statement: auditorStatement! }));
    ok("  a read-only viewer sees the same history, and no Follow up", auditorText.includes("Met the CFO") && !auditorText.html.includes(">Follow up</button>"));
    as(sales);
    const strangerStatement = await receivable.customerStatement(strangerCo.id);
    ok("  and a customer outside the viewer's accounts shows no follow-ups at all", strangerStatement?.followUps.length === 0);
  } finally {
    // The tasks switch first: whatever else failed, it goes back as it was.
    await (async () => {
      const current = await db.systemModule.findUnique({ where: { key: "tasks" } });
      if (tasksSwitch && current?.enabled !== tasksSwitch.enabled) await db.systemModule.update({ where: { key: "tasks" }, data: { enabled: tasksSwitch.enabled } });
      if (!tasksSwitch && current) await db.systemModule.delete({ where: { key: "tasks" } });
    })().catch((err) => {
      failures += 1;
      console.error("could not restore the tasks switch", err);
    });
    await cleanup().catch((err) => {
      failures += 1;
      console.error("cleanup failed", err);
    });
    const left = await Promise.all([
      db.user.count({ where: { email: { endsWith: MAIL } } }),
      db.company.count({ where: { name: { startsWith: TAG } } }),
      db.paymentFollowUp.count({ where: { id: { in: [...fixtureFollowUps] } } }),
      db.notification.count({ where: { dedupeKey: { in: JOB_DAYS.map((d) => `promise-broken-summary:${d}`) } } }),
      db.dailyJobRun.count({ where: { job: "collections", day: { in: JOB_DAYS.map((d) => new Date(`${d}T00:00:00Z`)) } } }),
    ]);
    ok("nothing of the fixture is left behind", left.every((n) => n === 0), left.join(","));
    await db.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} collections checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
