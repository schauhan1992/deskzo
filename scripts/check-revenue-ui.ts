/**
 * check:revenue-ui — the revenue screens of Revenue & Close, rendered.
 *
 * Builds a scratch workspace database beside the real one (from the migrations, as check:revenue
 * does), points the app's own `db` at it, makes a fixture through the real actions — invoices issued,
 * a recognition run, an opening, an edit — and then renders the pages and components the way Next
 * would, as different people, asserting on the HTML (the server-render pattern of check-cms and
 * check-revenue-capture). No browser and no sign-in: the session is a stub that says who is asking.
 *
 * What it proves:
 *
 *   · the Revenue page — the schedule list and its filters, the Review tab, the roll-forward (the red
 *     difference and its ledger link when a hand journal disagrees), the opening wizard's steps and
 *     "Recognise through" — for a manager, for an accounts executive (read-only: no buttons that move
 *     money) and for somebody without the permission (refused);
 *   · a schedule's own page, and the confirm steps of an edit and a cancellation, driven through the
 *     real actions and then re-sent with the figure;
 *   · the waterfall by customer and by item, over 12 and 24 months, and its CSV — formula-guarded and
 *     needing the export permission;
 *   · the customer revenue card on the company page, and "Recognised over … — schedule →" on the invoice;
 *   · the add-on switched off, and out of the plan: the notice in place of the screens, and the card
 *     and the invoice link gone;
 *   · on every page rendered: no duplicate ids, every form control named, every table in a scroller.
 *
 * It drops the scratch database at the end, pass or fail, and reads the real one before and after.
 *
 *   npm run check:revenue-ui
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { createElement, type ReactNode } from "react";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import { renderHtml } from "./lib/render-html";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${String(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const ist = (s: string) => new Date(`${s}+05:30`);
const round2 = (n: number) => Math.round(n * 100) / 100;
const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── Who the pages think is looking ───────────────────────────────────────────────────────────────

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
const sessionStub = {
  requireUser: async () => {
    if (!actor) throw new Error("The check rendered a page without saying who was looking.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
  UnauthorizedError,
};
const cacheStub = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const navigationStub = {
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/accounting/revenue",
  useParams: () => ({}),
  // Named, so "the record was not found" can't be mistaken for "the page crashed".
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
const byName = new Map<string, unknown>([
  ["next/cache", cacheStub],
  ["next/navigation", navigationStub],
  ["@/lib/session", sessionStub],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), cacheStub],
  [load.resolve("next/navigation"), navigationStub],
  [load.resolve("../src/lib/session"), sessionStub],
]);
/** `@/lib/auth` with only `auth` swapped: a proxy over the real exports, which sit in an import cycle. */
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

// ── Rendering ────────────────────────────────────────────────────────────────────────────────────

const html = async (el: unknown) => renderHtml(el as ReactNode);
type Page = (props: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<unknown>;
const renderPage = async (page: Page, searchParams: Record<string, string> = {}, params: Record<string, string> = {}) =>
  html(await page({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams) }));
/** The words on the page, entities decoded. */
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/** Structural rules every rendered screen must keep: unique ids, named controls, tables that scroll inside their panel. */
function structure(label: string, markup: string) {
  const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  ok(`${label}: no id is used twice`, dupes.length === 0, dupes.join(", "));
  const unnamed: string[] = [];
  for (const m of markup.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = m[2]!;
    if (/type="hidden"/.test(attrs)) continue;
    if (/aria-label(ledby)?="[^"]+"/.test(attrs)) continue;
    const id = /\sid="([^"]+)"/.exec(attrs)?.[1];
    if (id && markup.includes(`for="${id}"`)) continue;
    const before = markup.slice(0, m.index);
    if (before.lastIndexOf("<label") > before.lastIndexOf("</label>")) continue;
    unnamed.push(`<${m[1]} ${attrs.slice(0, 60)}>`);
  }
  ok(`${label}: every form control has a name`, unnamed.length === 0, unnamed.slice(0, 3).join(" | "));
  const loose: number[] = [];
  let at = markup.indexOf("<table");
  while (at !== -1) {
    const before = markup.slice(0, at);
    if (before.lastIndexOf("overflow-x-auto") <= before.lastIndexOf("</table>")) loose.push(at);
    at = markup.indexOf("<table", at + 1);
  }
  ok(`${label}: every table scrolls inside its own panel (no page-level overflow at 375 px)`, loose.length === 0, `${loose.length} table(s) outside a scroller`);
  // Intl's en-IN writes "Sept" on some runtimes; the screens spell their months out so they read "Sep 2026".
  ok(`${label}: months read "Sep 2026", never "Sept"`, !/\bSept\b/.test(text(markup)));
}

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
  const scratchName = `${realName}_revenue_ui`;
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

    // From here on the app's own `db` is the scratch database, and the control plane is off by value.
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
  ok("its journal has the same entries", realAfter.entries === realBefore.entries, realAfter.entries);
  ok("  and the same revenue schedules", realAfter.schedules === realBefore.schedules, realAfter.schedules);

  console.log(failures === 0 ? `\nAll ${passes} revenue screen checks passed.\n` : `\n${failures} check(s) FAILED, ${passes} passed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

async function snapshot(client: PrismaClient) {
  const [entries, schedules] = await Promise.all([client.journalEntry.count(), client.revenueSchedule.count()]);
  return { entries, schedules };
}

async function run(scratchName: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const journal = require("../src/lib/ledger/journal") as typeof import("../src/lib/ledger/journal");
  const docs = require("../src/actions/trade-document") as typeof import("../src/actions/trade-document");
  const revenue = require("../src/actions/revenue") as typeof import("../src/actions/revenue");
  const screens = require("../src/actions/revenue-screens") as typeof import("../src/actions/revenue-screens");
  const reports = require("../src/lib/revenue/reports") as typeof import("../src/lib/revenue/reports");
  const periods = require("../src/lib/revenue/periods") as typeof import("../src/lib/revenue/periods");
  const tenancy = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const { SYSTEM_ACCOUNTS } = require("../src/lib/ledger/chart") as typeof import("../src/lib/ledger/chart");
  const { formatCompanyId } = require("../src/lib/order-id") as typeof import("../src/lib/order-id");
  const { istDay } = require("../src/components/revenue/labels") as typeof import("../src/components/revenue/labels");
  const D = "../src/app/(dashboard)";
  const RevenuePage = (load(`${D}/accounting/revenue/page`) as { default: Page }).default;
  const SchedulePage = (load(`${D}/accounting/revenue/[id]/page`) as { default: Page }).default;
  const WaterfallPage = (load(`${D}/accounting/revenue/waterfall/page`) as { default: Page }).default;
  const CompanyPage = (load(`${D}/companies/[id]/page`) as { default: Page }).default;
  const { DocumentDetail } = load("../src/components/documents/document-detail") as typeof import("../src/components/documents/document-detail");
  const wizard = load("../src/components/revenue/opening-wizard") as typeof import("../src/components/revenue/opening-wizard");
  const actionsUi = load("../src/components/revenue/schedule-actions") as typeof import("../src/components/revenue/schedule-actions");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const { addMonths, firstDay, lastDay, monthKeyAt, monthLabel, dayLabel } = periods;

  const where = await db.$queryRaw<{ name: string }[]>`SELECT current_database()::text AS name`;
  ok("the app's db is the scratch database", where[0]?.name === scratchName, where[0]?.name);
  if (where[0]?.name !== scratchName) throw new Error("Refusing to go on: db is not the scratch database.");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sessionModule = require("../src/lib/session") as { requireUser: () => Promise<unknown> };
  ok("  the session stub is live", (await sessionModule.requireUser().catch((e: Error) => e.message)) === "The check rendered a page without saying who was looking.");

  // ── Fixture ────────────────────────────────────────────────────────────────────────────────────
  section("Fixture");
  const user = (key: string, role: string, extra: { isSuperAdmin?: boolean } = {}): Promise<Actor> =>
    db.user.create({
      data: { name: `Zz ${key}`, email: `zzrevui-${key.toLowerCase()}@example.test`, passwordHash: "!", role, ...extra },
      select: { id: true, name: true, email: true, role: true },
    });
  const owner = await user("Owner", "ADMIN", { isSuperAdmin: true });
  const manager = await user("Manager", "ACCOUNTS");
  const checker = await user("Checker", "ACCOUNTS");
  const exec = await user("Executive", "ACCOUNTS");
  const rep = await user("Rep", "SALES");
  const grant = (u: Actor, permission: string) =>
    db.userPermission.create({ data: { userId: u.id, permission, allowed: true, reason: "check:revenue-ui", grantedById: owner.id } });
  await grant(manager, "revenue.manage");
  await grant(manager, "data.exportFinance");
  await grant(checker, "revenue.manage");

  const kaGst = await db.gstRegistration.create({ data: { gstin: "29AAACZ9999Z1Z1", stateCode: "29", code: "KA" } });
  const mhGst = await db.gstRegistration.create({ data: { gstin: "27AAACZ9999Z1Z5", stateCode: "27", code: "MH" } });
  await db.branch.create({ data: { name: "Zz Head office", code: "HO", isHeadOffice: true, gstRegistrationId: mhGst.id } });
  const blr = await db.branch.create({ data: { name: "Zz Bengaluru", code: "BLR", gstRegistrationId: kaGst.id }, select: { id: true, gstRegistrationId: true } });
  const company = (name: string, ownerUserId: string) =>
    db.company.create({
      data: { name, normalizedName: name.toLowerCase(), createdById: owner.id, ownerUserId, relationshipType: "CLIENT", stage: "CUSTOMER" },
      select: { id: true, name: true, companySeq: true },
    });
  // The rep owns Acme, so the rep can open its page and its invoice — and still sees no revenue.
  const acme = await company("Zz Acme Cloud", rep.id);
  // A name a spreadsheet would run as a formula: the CSV must neutralise it.
  const formula = await company("=SUM(1+1) Zz Formula Ltd", owner.id);
  const item = (name: string, type: "SERVICE" | "SUBSCRIPTION", sku: string) =>
    db.item.create({ data: { name, sku, type, sellingPrice: 1, createdById: owner.id, billingCycle: type === "SUBSCRIPTION" ? "ANNUAL" : null }, select: { id: true, name: true } });
  const cloud = await item("Zz Cloud suite", "SUBSCRIPTION", "ZZUI-CLOUD");
  const support = await item("Zz Support plan", "SERVICE", "ZZUI-SUPPORT");

  let seq = 0;
  const invoice = async (spec: { issueDate: Date; companyId: string; name: string; itemId: string; taxable: number; from: string; to: string }) => {
    seq += 1;
    const igst = round2(spec.taxable * 0.18);
    const doc = await db.tradeDocument.create({
      data: {
        docNumber: `ZZUI-INV-${String(seq).padStart(3, "0")}`,
        docType: "INVOICE",
        direction: "SALES",
        status: "DRAFT",
        companyId: spec.companyId,
        createdById: owner.id,
        issueDate: spec.issueDate,
        currency: "INR",
        exchangeRate: 1,
        subtotal: spec.taxable,
        taxableValue: spec.taxable,
        igstAmount: igst,
        total: round2(spec.taxable + igst),
        branchId: blr.id,
        gstRegistrationId: blr.gstRegistrationId,
        lines: {
          create: [{
            name: spec.name,
            itemId: spec.itemId,
            quantity: 1,
            unitPrice: spec.taxable,
            taxRatePercent: 18,
            taxableValue: spec.taxable,
            igstAmount: igst,
            lineTotal: round2(spec.taxable + igst),
            sortOrder: 0,
            servicePeriodFrom: new Date(`${spec.from}T00:00:00.000Z`),
            servicePeriodTo: new Date(`${spec.to}T00:00:00.000Z`),
          }],
        },
      },
      select: { id: true, docNumber: true, lines: { select: { id: true } } },
    });
    as(owner);
    const issued = await docs.issueTradeDocument({ id: doc.id });
    if (!issued.ok) throw new Error(`Issuing ${doc.docNumber} failed: ${issued.error}`);
    const issuedDoc = await db.tradeDocument.findUniqueOrThrow({ where: { id: doc.id }, select: { docNumber: true } });
    return { id: doc.id, docNumber: issuedDoc.docNumber, lineId: doc.lines[0]!.id };
  };
  const scheduleOf = (documentId: string) => db.revenueSchedule.findFirstOrThrow({ where: { documentId }, select: { id: true, status: true, amount: true } });

  // Every date is relative to today, so the suite means the same thing whenever it runs.
  const now = new Date();
  const M0 = monthKeyAt(now);
  const L = periods.lastCompletedMonth(now);

  await db.systemModule.upsert({ where: { key: "revenue_close" }, create: { key: "revenue_close", enabled: false }, update: { enabled: false } });
  const legacy = await invoice({
    issueDate: ist(`${addMonths(L, -2)}-05T10:00:00`), companyId: acme.id, name: "Zz Cloud suite, legacy year", itemId: cloud.id, taxable: 36500,
    from: firstDay(addMonths(L, -2)), to: lastDay(addMonths(L, 9)),
  });
  await db.systemModule.update({ where: { key: "revenue_close" }, data: { enabled: true } });

  const a = await invoice({
    issueDate: ist(`${addMonths(M0, -15)}-10T10:00:00`), companyId: acme.id, name: "Zz Cloud suite, a year", itemId: cloud.id, taxable: 120000,
    from: firstDay(addMonths(M0, -14)), to: lastDay(addMonths(M0, -3)),
  });
  const b = await invoice({
    issueDate: ist(`${addMonths(M0, -2)}-03T10:00:00`), companyId: acme.id, name: "Zz Support, six months", itemId: support.id, taxable: 30000,
    from: firstDay(addMonths(M0, -1)), to: lastDay(addMonths(M0, 4)),
  });
  const c = await invoice({
    issueDate: new Date(now.getTime() - 60_000), companyId: formula.id, name: "Zz Support, a year ahead", itemId: support.id, taxable: 60000,
    from: firstDay(M0), to: lastDay(addMonths(M0, 11)),
  });
  const sa = await scheduleOf(a.id);
  const sb = await scheduleOf(b.id);
  const sc = await scheduleOf(c.id);
  ok("three invoices issued with the add-on on, each with an active schedule", [sa, sb, sc].every((s) => s.status === "ACTIVE"));
  ok("  and one issued with it off, with none", (await db.revenueSchedule.count({ where: { documentId: legacy.id } })) === 0);

  as(manager);
  const through = addMonths(M0, -12);
  const ran = await revenue.revenueRun({ throughMonth: through });
  ok(`the manager recognises through ${monthLabel(through)}: three months of the year's invoice`, ran.ok && ran.data.months.length === 3, ran.ok ? ran.data.months.map((m) => m.entryNumber).join(", ") : ran.error);

  as(owner);
  const ownEdit = await revenue.editSchedule(sb.id, { spreadEvenly: true });
  ok("the super admin re-plans the support schedule evenly: it waits for approval, theirs", ownEdit.ok && ownEdit.data.status === "saved" && (await scheduleOf(b.id)).status === "PENDING_APPROVAL");

  as(manager);
  const candidates = await revenue.openingCandidates({ asAt: L });
  const legacyCandidate = candidates.ok ? candidates.data.filter((d) => d.documentId === legacy.id) : [];
  ok(`the legacy invoice is an opening candidate as at ${monthLabel(L)}`, legacyCandidate.length === 1, candidates.ok ? "" : candidates.error);
  const openingInput = { asAt: L, lines: [{ lineId: legacy.lineId, from: firstDay(addMonths(L, -2)), to: lastDay(addMonths(L, 9)) }] };
  const preview = await revenue.previewOpening(openingInput);
  ok("  its preview has an unearned part and no problem", preview.ok && preview.data.total > 0 && preview.data.lines[0]!.problem === null, preview.ok ? rupees(preview.data.total) : preview.error);
  const badPreview = await revenue.previewOpening({ asAt: L, lines: [{ lineId: legacy.lineId, from: firstDay(addMonths(L, -2)), to: lastDay(addMonths(L, -1)) }] });
  const opened = await revenue.postOpening(openingInput);
  ok("  the manager posts it", opened.ok && opened.data.schedules === 1, opened.ok ? opened.data.entryNumber : opened.error);
  const so = await scheduleOf(legacy.id);
  ok("  and its schedule waits for approval", so.status === "PENDING_APPROVAL");

  // ── The list ───────────────────────────────────────────────────────────────────────────────────
  section("1. The schedule list");
  as(manager);
  const listManager = await renderPage(RevenuePage);
  const tm = text(listManager);
  const aLine = await db.revenueScheduleLine.findFirstOrThrow({ where: { scheduleId: sa.id, entryId: null }, orderBy: { month: "asc" }, select: { month: true, amount: true } });
  const aRow = (await revenue.listSchedules({ documentId: a.id })).rows[0]!;
  ok("the manager sees every schedule, each linked to its invoice and to itself",
    [a, b, c, legacy].every((d) => listManager.includes(`href="/documents/${d.id}"`)) && [sa, sb, sc, so].every((s) => listManager.includes(`href="/accounting/revenue/${s.id}"`)));
  ok("  customer, line, kind, period, amount, recognised, remaining",
    tm.includes("Zz Acme Cloud") && tm.includes("Zz Cloud suite, a year") && tm.includes("Over the period") &&
      tm.includes(`${dayLabel(firstDay(addMonths(M0, -14)))} – ${dayLabel(lastDay(addMonths(M0, -3)))}`) &&
      tm.includes(rupees(120000)) && tm.includes(rupees(aRow.recognised)) && tm.includes(rupees(aRow.remaining)),
    `recognised ${rupees(aRow.recognised)}, remaining ${rupees(aRow.remaining)}`);
  ok("  the next month and its amount", tm.includes(monthLabel(periods.monthKeyOfDate(aLine.month))) && tm.includes(rupees(Number(aLine.amount))), `${monthLabel(periods.monthKeyOfDate(aLine.month))} ${rupees(Number(aLine.amount))}`);
  ok("  status and the opening badge", tm.includes("Active") && tm.includes("Pending approval") && tm.includes("Opening"));
  ok("  the manager has Recognise through, and the opening tab", tm.includes("Recognise through") && tm.includes("Open deferred revenue"));
  ok("  the Review tab counts what waits", tm.includes("Review (2)"));
  structure("the list, as the manager", listManager);

  as(exec);
  const listExec = await renderPage(RevenuePage);
  const te = text(listExec);
  ok("an accounts executive reads the list", [sa, sb, sc].every((s) => listExec.includes(`/accounting/revenue/${s.id}`)));
  ok("  with nothing that moves money: no Recognise through, no opening tab", !te.includes("Recognise through") && !te.includes("Open deferred revenue") && !te.includes("Recognise revenue"));
  as(rep);
  const listRep = text(await renderPage(RevenuePage));
  ok("a salesperson is refused, and told why", listRep.includes("permission to see revenue recognition") && !listRep.includes("Zz Acme Cloud"), listRep.slice(0, 120));

  as(manager);
  const byCustomer = await renderPage(RevenuePage, { customer: formula.id });
  ok("filtered by customer (in the URL): only that customer's schedules", byCustomer.includes(`/accounting/revenue/${sc.id}`) && !byCustomer.includes(`/accounting/revenue/${sa.id}`));
  const byStatus = await renderPage(RevenuePage, { status: "PENDING_APPROVAL" });
  ok("  by status: only the pending ones", byStatus.includes(`/accounting/revenue/${sb.id}`) && byStatus.includes(`/accounting/revenue/${so.id}`) && !byStatus.includes(`/accounting/revenue/${sa.id}`) && !byStatus.includes(`/accounting/revenue/${sc.id}`));
  const pendingOnly = await renderPage(RevenuePage, { pending: "1" });
  ok("  \"Pending approval\" alone does the same, and shows as pressed", pendingOnly.includes(`/accounting/revenue/${sb.id}`) && !pendingOnly.includes(`/accounting/revenue/${sa.id}`) && pendingOnly.includes('aria-pressed="true"'));
  const byItem = await renderPage(RevenuePage, { item: cloud.id });
  ok("  by item", byItem.includes(`/accounting/revenue/${sa.id}`) && !byItem.includes(`/accounting/revenue/${sc.id}`));
  const byMonths = await renderPage(RevenuePage, { from: M0, to: M0 });
  ok(`  by month range (${monthLabel(M0)}): the year ahead and the support schedule, not last year's`, byMonths.includes(`/accounting/revenue/${sc.id}`) && byMonths.includes(`/accounting/revenue/${sb.id}`) && !byMonths.includes(`/accounting/revenue/${sa.id}`));
  const paged = await renderPage(RevenuePage, { pageSize: "25", page: "2" });
  ok("  paged (in the URL): page 2 of four schedules says it is past the end", text(paged).includes("past the end of the list") && !paged.includes(`/accounting/revenue/${sa.id}`));
  const nothing = text(await renderPage(RevenuePage, { q: "no-such-thing-zz" }));
  ok("  no match explains itself, with a way back", nothing.includes("No schedule matches these filters") && nothing.includes("Clear them"));

  // ── Review ─────────────────────────────────────────────────────────────────────────────────────
  section("2. The Review tab");
  const approveButtons = (markup: string) => count(markup, ">Approve</button>");
  as(manager);
  const reviewManager = await renderPage(RevenuePage, { tab: "review" });
  ok("the manager may approve the super admin's schedule, not their own opening", approveButtons(reviewManager) === 1 && text(reviewManager).includes("Yours — somebody else approves it"), approveButtons(reviewManager));
  as(owner);
  const reviewOwner = text(await renderPage(RevenuePage, { tab: "review" }));
  ok("the super admin may approve the opening, and their own — shown as such", reviewOwner.includes("Approve your own") && reviewOwner.includes("As super admin you may approve it") && count(reviewOwner, " Approve ") >= 1);
  as(exec);
  const reviewExec = await renderPage(RevenuePage, { tab: "review" });
  ok("the executive sees the queue with no buttons", approveButtons(reviewExec) === 0 && !reviewExec.includes("Approve your own") && count(text(reviewExec), "Waiting for a manager") === 2);
  structure("the Review tab", reviewExec);
  as(checker);
  const reviewChecker = await renderPage(RevenuePage, { tab: "review" });
  ok("a second manager may approve both", approveButtons(reviewChecker) === 2);

  // ── One schedule ───────────────────────────────────────────────────────────────────────────────
  section("3. A schedule's own page");
  const posted = await db.revenueScheduleLine.findMany({ where: { scheduleId: sa.id, entryId: { not: null } }, select: { entry: { select: { entryNumber: true } } } });
  as(manager);
  const detailManager = await renderPage(SchedulePage, {}, { id: sa.id });
  const tdm = text(detailManager);
  ok("its customer, invoice, line, period and amount", detailManager.includes(`href="/companies/${formatCompanyId(acme.companySeq)}"`) && detailManager.includes(`href="/documents/${a.id}"`) && tdm.includes("Zz Cloud suite, a year") && tdm.includes(rupees(120000)));
  ok("  its months: three posted with their entries, the rest planned", count(tdm, " Posted ") === 3 && posted.every((p) => tdm.includes(p.entry!.entryNumber)) && tdm.includes("Planned"), posted.map((p) => p.entry!.entryNumber).join(", "));
  ok("  who made it (authorLabel), and that it needed no approval", tdm.includes(`Made by ${owner.name}`) && tdm.includes("started active without approval"));
  ok("  who posted each month", tdm.includes(`by ${manager.name}`));
  ok("  the manager has Edit and Cancel", tdm.includes("Edit") && tdm.includes("Cancel schedule"));
  ok("  and the credit notes section says there are none", tdm.includes("No credit note has taken anything off this schedule"));
  structure("a schedule, as the manager", detailManager);
  as(exec);
  const detailExec = text(await renderPage(SchedulePage, {}, { id: sa.id }));
  ok("the executive reads it with no buttons", detailExec.includes("Zz Cloud suite, a year") && !detailExec.includes("Cancel schedule") && !detailExec.includes(" Edit "));
  as(rep);
  ok("a salesperson is refused", text(await renderPage(SchedulePage, {}, { id: sa.id })).includes("permission to see revenue recognition"));
  as(manager);
  const missing = await renderPage(SchedulePage, {}, { id: "no-such-schedule" }).catch((e: Error) => e.message);
  ok("an id that isn't one is not found", missing === "NOT_FOUND_CALLED", missing.slice(0, 80));
  as(checker);
  const openingDetail = text(await renderPage(SchedulePage, {}, { id: so.id }));
  ok("the opening's page: waiting, made by the manager, and the checker may approve it",
    openingDetail.includes("Waiting for approval by somebody other than its maker") && openingDetail.includes(`Made by ${manager.name}`) && openingDetail.includes("Approve") && openingDetail.includes("Opening"));
  as(owner);
  ok("the super admin's own pending schedule offers \"Approve your own\"", text(await renderPage(SchedulePage, {}, { id: sb.id })).includes("Approve your own"));

  // ── Edit and cancel: the confirm flow ──────────────────────────────────────────────────────────
  section("4. Edit and cancel ask first, with the figure");
  as(manager);
  const firstAsk = await revenue.editSchedule(sc.id, { amount: 54000 });
  const ask = firstAsk.ok && firstAsk.data.status === "confirm" ? firstAsk.data : null;
  ok("a new amount comes back as a question: ₹6,000 to move", ask?.reclass === 6000, firstAsk.ok ? JSON.stringify({ status: firstAsk.data.status, reclass: firstAsk.data.reclass }) : firstAsk.error);
  const confirmHtml = text(await html(createElement(actionsUi.ReclassConfirm, ask!)));
  ok("  the confirm step says how much, which way and on what date", confirmHtml.includes(rupees(6000)) && confirmHtml.includes("from Deferred Revenue to Sales") && confirmHtml.includes(istDay(ask!.date)));
  ok("  and lists the months it leaves", confirmHtml.includes(monthLabel(M0)) && confirmHtml.includes(monthLabel(addMonths(M0, 11))));
  const resent = await revenue.editSchedule(sc.id, { amount: 54000, confirmReclass: ask!.reclass });
  ok("  re-sent with the figure, it posts and waits for approval", resent.ok && resent.data.status === "saved" && !!resent.data.entryNumber && (await scheduleOf(c.id)).status === "PENDING_APPROVAL", resent.ok && resent.data.status === "saved" ? resent.data.entryNumber : "");
  const cancelAsk = await revenue.cancelSchedule(sb.id, "Zz contract ended early");
  const cask = cancelAsk.ok && cancelAsk.data.status === "confirm" ? cancelAsk.data : null;
  ok("cancelling asks first, with what it would recognise now", cask !== null && cask.amount > 0, cask ? rupees(cask.amount) : "");
  const cancelHtml = text(await html(createElement(actionsUi.CancelConfirmStep, cask!)));
  ok("  the confirm step says the figure and the date", cancelHtml.includes(rupees(cask!.amount)) && cancelHtml.includes(istDay(cask!.date)) && cancelHtml.includes("recognised into Sales"));
  const actionsHtml = await html(createElement(actionsUi.ScheduleActions, {
    schedule: { id: sa.id, kind: "RATABLE", status: "ACTIVE", startDate: aRow.startDate, endDate: aRow.endDate, amount: aRow.amount, spreadEvenly: false, note: null, remaining: aRow.remaining },
    mayApprove: false,
    approveOwn: false,
  }));
  ok("  the actions render closed: buttons, no dialog yet", text(actionsHtml).includes("Edit") && !actionsHtml.includes('role="dialog"'));

  // ── Recognise through ─────────────────────────────────────────────────────────────────────────
  section("5. Recognise through a month");
  ok("the picker offers completed months only, newest first", listManager.includes(`<option value="${L}" selected="">${monthLabel(L)}</option>`) && !listManager.includes(`value="${M0}" selected=""`));
  const notOver = await revenue.revenueRun({ throughMonth: M0 });
  ok("  and the action refuses the month under way, in words", !notOver.ok && /isn't over yet/.test(notOver.error));
  const nothingDue = await revenue.revenueRun({ throughMonth: through });
  ok("  running the same month again posts nothing", nothingDue.ok && nothingDue.data.months.length === 0);

  // ── Roll-forward ───────────────────────────────────────────────────────────────────────────────
  section("6. The roll-forward");
  as(exec);
  const rollClean = await renderPage(RevenuePage, { tab: "roll-forward", month: L });
  const trc = text(rollClean);
  const roll = await revenue.rollForward(L);
  ok(`${monthLabel(L)}: opening, the movements and closing, and the ledger beside it`,
    trc.includes("Opening balance") && trc.includes("+ Deferred from invoices") && trc.includes("− Recognised") && trc.includes("− Credited") && trc.includes("± Opening adjustments") && trc.includes("= Closing balance") && trc.includes(rupees(roll.closing)) && trc.includes(rupees(roll.openingAdjustments)),
    `closing ${rupees(roll.closing)}, opening adjustments ${rupees(roll.openingAdjustments)}`);
  ok("  and they agree", trc.includes("agrees with the ledger") && !rollClean.includes('role="alert"'));
  structure("the roll-forward", rollClean);
  const accounts = await db.$transaction((tx) => journal.resolveAccounts(tx, [SYSTEM_ACCOUNTS.SALES, SYSTEM_ACCOUNTS.DEFERRED_REVENUE]));
  const deferredId = accounts.get(SYSTEM_ACCOUNTS.DEFERRED_REVENUE)!;
  const handJournal = (debit: string, credit: string) =>
    db.$transaction((tx) => journal.writeEntry(tx, {
      date: ist(`${L}-15T12:00:00`), narration: "Zz hand journal", source: "MANUAL", userId: owner.id,
      lines: [{ accountId: accounts.get(debit as never)!, debit: 1, credit: 0 }, { accountId: accounts.get(credit as never)!, debit: 0, credit: 1 }],
    }));
  await handJournal(SYSTEM_ACCOUNTS.SALES, SYSTEM_ACCOUNTS.DEFERRED_REVENUE);
  const rollOff = await renderPage(RevenuePage, { tab: "roll-forward", month: L });
  const tro = text(rollOff);
  ok("a ₹1 hand journal: the difference in red, explained", rollOff.includes('role="alert"') && /text-danger/.test(rollOff) && tro.includes(`Difference ${rupees(1)}`) && tro.includes("journal written by hand") && tro.includes(`${rupees(1)} of it was posted in ${monthLabel(L)}`));
  ok("  with a link to the account's ledger for the month", rollOff.includes(`href="/accounting/ledger/${deferredId}?from=${firstDay(L)}&amp;to=${lastDay(L)}"`) && tro.includes("Open the Deferred Revenue ledger"));
  ok("  and today's tie-out is out too", tro.includes(`Out by ${rupees(1)}`));
  await handJournal(SYSTEM_ACCOUNTS.DEFERRED_REVENUE, SYSTEM_ACCOUNTS.SALES);
  ok("  taken back out, it agrees again", text(await renderPage(RevenuePage, { tab: "roll-forward", month: L })).includes("agrees with the ledger"));

  // ── The opening wizard ─────────────────────────────────────────────────────────────────────────
  section("7. The opening wizard's steps");
  as(manager);
  const openingTab = await renderPage(RevenuePage, { tab: "opening" });
  const tot = text(openingTab);
  ok("step 1: an open month end to pick, the latest completed first", tot.includes("As at the end of") && openingTab.includes(`<option value="${L}" selected="">${monthLabel(L)}</option>`) && tot.includes("List the invoices"));
  structure("the opening wizard", openingTab);
  as(exec);
  ok("  the executive has no wizard (the tab falls back to the list)", !text(await renderPage(RevenuePage, { tab: "opening" })).includes("List the invoices"));
  const choices = Object.fromEntries(legacyCandidate.flatMap((d) => d.lines.map((l) => [l.lineId, { on: true, from: l.from ?? "", to: l.to ?? "" }])));
  const linesStep = await html(createElement(wizard.OpeningLinesStep, { asAt: L, candidates: legacyCandidate, choices, onChange: () => {} }));
  ok("step 2: the invoice, its line and the period prefilled from the line", linesStep.includes(legacy.docNumber) && text(linesStep).includes("Zz Cloud suite, legacy year") && linesStep.includes(`value="${firstDay(addMonths(L, -2))}"`) && linesStep.includes(`value="${lastDay(addMonths(L, 9))}"`));
  structure("the wizard's lines", linesStep);
  ok("  with nothing to open, it says what to do", text(await html(createElement(wizard.OpeningLinesStep, { asAt: L, candidates: [], choices: {}, onChange: () => {} }))).includes("there is nothing to open"));
  const previewStep = text(await html(createElement(wizard.OpeningPreviewStep, { preview: (preview as { ok: true; data: Parameters<typeof wizard.OpeningPreviewStep>[0]["preview"] }).data })));
  ok("step 3: the unearned part per line and the total", previewStep.includes("Total to defer") && previewStep.includes(rupees((preview as { ok: true; data: { total: number } }).data.total)));
  const badStep = badPreview.ok ? text(await html(createElement(wizard.OpeningPreviewStep, { preview: badPreview.data }))) : "";
  ok("  a line that can't be opened says why, and nothing posts", badStep.includes("nothing to defer") && badStep.includes("can't be opened as entered"), badStep.slice(0, 80));
  const postedStep = await html(createElement(wizard.OpeningPostedStep, { asAt: L, posted: (opened as { ok: true; data: { entryNumber: string; schedules: number; total: number } }).data }));
  ok("step 4: the entry, and where the schedule waits", postedStep.includes((opened as { ok: true; data: { entryNumber: string } }).data.entryNumber) && postedStep.includes('href="/accounting/revenue?tab=review"'));

  // ── The waterfall ──────────────────────────────────────────────────────────────────────────────
  section("8. The waterfall");
  as(exec);
  const wfCustomer = await renderPage(WaterfallPage);
  const twc = text(wfCustomer);
  const wf12 = await reports.waterfall(db, { by: "customer", months: 12 });
  ok("by customer, 12 months from this one: every customer, every month, the total", twc.includes("Zz Acme Cloud") && twc.includes("=SUM(1+1) Zz Formula Ltd") && twc.includes(monthLabel(M0)) && twc.includes(monthLabel(addMonths(M0, 11))) && !twc.includes(monthLabel(addMonths(M0, 12))) && twc.includes(rupees(wf12.totals.total)), rupees(wf12.totals.total));
  ok("  the remaining performance obligation equals what the schedules hold", twc.includes("Remaining performance obligation") && wf12.totals.total === (await reports.deferredTieOut(db)).schedules);
  ok("  the executive can't export (no finance export permission)", !twc.includes("Export CSV"));
  ok("  past-due months have their own column", twc.includes("Past due"));
  structure("the waterfall", wfCustomer);
  const wfItem = text(await renderPage(WaterfallPage, { by: "item", months: "24" }));
  ok("by item over 24 months (both in the URL)", wfItem.includes("Zz Cloud suite") && wfItem.includes("Zz Support plan") && wfItem.includes(monthLabel(addMonths(M0, 23))) && wfItem.includes("By item"));
  as(manager);
  ok("the manager, who may export, has the button", text(await renderPage(WaterfallPage)).includes("Export CSV"));
  const csv = await screens.exportWaterfallCsv({ by: "customer", months: 12 });
  ok("the CSV: a formula in a customer's name is neutralised", csv.ok && csv.data.csv.includes(`"'=SUM(1+1) Zz Formula Ltd"`) && !csv.data.csv.includes(`"=SUM`), csv.ok ? csv.data.filename : csv.error);
  ok("  it says what it is, and its months and total", csv.ok && csv.data.csv.includes("Revenue waterfall by customer") && csv.data.csv.includes(`"${monthLabel(M0)}"`) && csv.data.csv.includes(`"${wf12.totals.total}"`));
  as(exec);
  const csvRefused = await screens.exportWaterfallCsv({ by: "customer", months: 12 });
  ok("  somebody without the export permission is refused", !csvRefused.ok && /export permission/.test(csvRefused.error));
  as(rep);
  ok("a salesperson can't open the waterfall", text(await renderPage(WaterfallPage)).includes("permission to see revenue recognition"));

  // ── The company page ───────────────────────────────────────────────────────────────────────────
  section("9. The customer revenue card");
  const companyRef = { id: formatCompanyId(acme.companySeq) };
  as(manager);
  const figures = (await revenue.customerRevenue(acme.id))!;
  const cardManager = await renderPage(CompanyPage, {}, companyRef);
  const tcm = text(cardManager);
  ok("on the company page for the manager: invoiced, recognised, deferred, the next 12 months and MRR",
    ["Invoiced", "Recognised", "Deferred", "Next 12 months", "MRR"].every((w) => tcm.includes(w)) && tcm.includes(rupees(figures.deferred)) && tcm.includes(rupees(figures.recognised)),
    JSON.stringify({ invoiced: figures.invoiced, recognised: figures.recognised, deferred: figures.deferred, mrr: figures.mrr }));
  ok("  with a link to the list filtered to the customer", cardManager.includes(`href="/accounting/revenue?customer=${acme.id}"`));
  as(exec);
  ok("  the executive (revenue.viewReports) sees it too", (await renderPage(CompanyPage, {}, companyRef)).includes(`href="/accounting/revenue?customer=${acme.id}"`));
  as(rep);
  const cardRep = await renderPage(CompanyPage, {}, companyRef).catch((e: Error) => `FAILED ${e.message}`);
  ok("  the salesperson who owns the account sees the page without it", !cardRep.startsWith("FAILED") && cardRep.includes("Zz Acme Cloud") && !cardRep.includes("/accounting/revenue?customer=") && !text(cardRep).includes("Next 12 months"), cardRep.slice(0, 80));

  // ── The invoice ────────────────────────────────────────────────────────────────────────────────
  section("10. The invoice links each deferring line to its schedule");
  as(exec);
  const invoiceExec = await html(createElement(DocumentDetail, { id: a.id }));
  ok("\"Recognised over <period> — schedule →\" under the line", text(invoiceExec).includes(`Recognised over ${dayLabel(firstDay(addMonths(M0, -14)))} – ${dayLabel(lastDay(addMonths(M0, -3)))}`) && invoiceExec.includes(`href="/accounting/revenue/${sa.id}"`));
  const invoiceLegacy = text(await html(createElement(DocumentDetail, { id: legacy.id })));
  ok("  an opened invoice's line too, saying it is pending approval", invoiceLegacy.includes("(pending approval)"));
  as(rep);
  const invoiceRep = await html(createElement(DocumentDetail, { id: a.id })).catch((e: Error) => `FAILED ${e.message}`);
  ok("  not for somebody who can't read revenue (the link would refuse them)", !invoiceRep.startsWith("FAILED") && !invoiceRep.includes("/accounting/revenue/"), invoiceRep.slice(0, 80));

  // ── The add-on off, and out of the plan ───────────────────────────────────────────────────────
  section("11. The add-on switched off, and out of the plan");
  await db.systemModule.update({ where: { key: "revenue_close" }, data: { enabled: false } });
  as(manager);
  const offList = text(await renderPage(RevenuePage));
  ok("switched off: the Revenue page is the disabled notice", offList.includes("This module is currently disabled") && !offList.includes("Zz Acme Cloud"));
  ok("  so are the waterfall and a schedule's page", text(await renderPage(WaterfallPage)).includes("currently disabled") && text(await renderPage(SchedulePage, {}, { id: sa.id })).includes("currently disabled"));
  ok("  the company page has no revenue card", !(await renderPage(CompanyPage, {}, companyRef)).includes("/accounting/revenue?customer="));
  ok("  and the invoice no schedule link", !(await html(createElement(DocumentDetail, { id: a.id }))).includes("/accounting/revenue/"));
  await db.systemModule.update({ where: { key: "revenue_close" }, data: { enabled: true } });
  const envTenant = await tenancy.currentTenant();
  const narrow = { ...envTenant, entitlements: { v: 1 as const, all: false, modules: ["accounting", "sales_documents", "purchase_documents", "receivables", "payments", "items"], seats: null, copilotTokens: null, customDomains: null, plans: [] } };
  await tenancy.runAsTenant(narrow, async () => {
    const outList = text(await renderPage(RevenuePage));
    ok("out of the plan: the page says so", outList.includes("isn't part of this workspace's plan"), outList.slice(0, 120));
    const outCompany = await renderPage(CompanyPage, {}, companyRef).catch((e: Error) => `FAILED ${e.message}`);
    ok("  and the company page still renders, without the card", !outCompany.startsWith("FAILED") && !outCompany.includes("/accounting/revenue?customer="), outCompany.slice(0, 120));
    const outInvoice = await html(createElement(DocumentDetail, { id: a.id })).catch((e: Error) => `FAILED ${e.message}`);
    ok("  as does the invoice, without the link", !outInvoice.startsWith("FAILED") && !outInvoice.includes("/accounting/revenue/"), outInvoice.slice(0, 120));
  });

  // ── The end ────────────────────────────────────────────────────────────────────────────────────
  section("The books");
  as(manager);
  const cancelled = await revenue.cancelSchedule(sb.id, "Zz contract ended early", cask!.amount);
  ok("the cancellation, re-sent with its figure, goes through", cancelled.ok && cancelled.data.status === "cancelled");
  const unbalanced = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM (SELECT l."entryId" FROM journal_lines l GROUP BY l."entryId" HAVING SUM(l.debit) <> SUM(l.credit)) x`;
  ok("every entry balances", Number(unbalanced[0]?.n ?? 1) === 0);
  const tie = await reports.deferredTieOut(db);
  ok("the schedules and Deferred Revenue agree at the end", tie.difference === 0, `${rupees(tie.schedules)} / ${rupees(tie.ledger)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
