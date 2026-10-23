/**
 * check:reporting-access — Reporting & Analytics (owner, 23 Oct 2026), held to its security, against a database.
 *
 * Runs the real server actions (src/actions/reporting.ts) as real people in the workspace — an admin, a
 * salesperson, an accountant — over reports it makes and removes, named ZZRPT…:
 *
 *   · A report made from a template saves and runs; its figures are the source's own (the same total the
 *     analytics source gives for the window).
 *   · Nobody else can open, run, save, share or delete it until it is shared — and the refusal doesn't say
 *     whether it exists.
 *   · A view share opens it and runs the report as saved, never a definition the viewer sends; it can't save,
 *     share or delete. An edit share saves; a save over a later one is refused, not lost. A department share
 *     reaches the department's people.
 *   · A shared report shows each person their own rows: the salesperson's totals are never more than the
 *     admin's, and are exactly what their own access to invoices gives.
 *   · A source somebody can't open is locked for them, with its fields withheld; a definition naming a field
 *     the source doesn't have is refused in words that don't depend on it; a calculated field is arithmetic only.
 *   · A download needs the source's export permission, and its figures are the chart's.
 *   · Sharing tells the person; asking for access tells the owner, once a day.
 *
 * Tenant isolation is the workspace's own database (src/lib/tenancy): a report is a row in it, so another
 * workspace's people can't name it — there is no shared table to leak from.
 *
 *   npm run check:reporting-access
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

type Actor = { id: string; name: string; role: string; email: string };
let actor: Actor = { id: "", name: "", role: "ADMIN", email: "" };
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => ({ ...actor });
    return { requireUser: user, currentUser: user, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const PREFIX = "ZZRPT";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 300)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const ids = (await db.savedReport.findMany({ where: { name: { contains: PREFIX } }, select: { id: true } })).map((r) => r.id);
  if (ids.length) {
    await db.notification.deleteMany({ where: { link: { in: ids.map((id) => `/reports/${id}`) } } });
    await db.auditLog.deleteMany({ where: { entityType: "SavedReport", entityId: { in: ids } } });
    await db.savedReport.deleteMany({ where: { id: { in: ids } } });
  }
}

async function as(email: string): Promise<Actor> {
  const u = await db.user.findUniqueOrThrow({ where: { email }, select: { id: true, name: true, role: true, email: true } });
  actor = { id: u.id, name: u.name, role: u.role, email: u.email };
  return actor;
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const R = require("../src/actions/reporting") as typeof import("../src/actions/reporting");
  const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
  const { openSource } = require("../src/lib/reporting/sources") as typeof import("../src/lib/reporting/sources");
  const { getSource } = require("../src/lib/analytics/sources") as typeof import("../src/lib/analytics/sources");
  const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
  const { reportWindow } = require("../src/lib/analytics/request") as typeof import("../src/lib/analytics/request");
  const { rangeDays } = require("../src/lib/reporting/window") as typeof import("../src/lib/reporting/window");
  const { isModuleEnabled } = require("../src/actions/module") as typeof import("../src/actions/module");
  /* eslint-enable @typescript-eslint/no-require-imports */

  await cleanup();
  try {
    const admin = await as("admin@acme.example");
    const sales = await db.user.findUniqueOrThrow({ where: { email: "nisha.bhat12@demo.deskzo.invalid" }, select: { id: true, departmentId: true } });
    const accounts = await db.user.findUniqueOrThrow({ where: { email: "rekha.accounts@acme.example" }, select: { id: true } });

    section("A report from a template, run as its maker");
    await as("admin@acme.example");
    const made = await R.createReport({ name: `${PREFIX} Receivables`, source: "invoices", templateKey: "receivables-review" });
    ok("the admin makes a report from the Receivables review template", made.ok, made.ok ? "" : made.error);
    if (!made.ok) return;
    const id = made.data.id;
    const opened = await R.openReport(id);
    ok("…it opens, theirs, with its source's fields", opened.ok && opened.data.access === "owner" && opened.data.source.available, opened.ok ? opened.data.access : opened.error);
    if (!opened.ok) return;
    const def = opened.data.definition;
    const revenueId = def.pages[0]!.charts[0]!.id;
    const ran = await R.runReport({ reportId: id });
    const revenue = ran.ok ? ran.charts[revenueId] : null;
    ok("it runs: every chart comes back", ran.ok && Object.values(ran.charts).every((c) => c.ok), ran.ok ? Object.entries(ran.charts).filter(([, c]) => !c.ok).map(([k, c]) => `${k}: ${c.ok ? "" : c.error}`) : ran.error);
    // The same window straight through the analytics source: the figure must be the source's own.
    const clock = await workspaceClock();
    const days = rangeDays(def.dateRange, clock.today());
    const bounds = reportWindow(clock, days.from, days.to) as { from: Date; to: Date };
    const invoices = getSource("invoices")!;
    const direct = (await invoices.load({ userId: admin.id, from: bounds.from, to: bounds.to, dateColumn: "issueDate" })) as never[];
    const net = invoices.measures.find((m) => m.key === "net")!;
    const expected = direct.reduce((t, r) => t + net.value(r), 0);
    const value = revenue?.ok && revenue.result.kind === "score" ? revenue.result.value : null;
    ok("revenue is the invoices source's own total for the window", value !== null && Math.abs(value - expected) < 0.01, { value, expected, rows: direct.length });
    const viewed = await db.savedReportView.count({ where: { userId: admin.id, reportId: id } });
    ok("opening it records that the admin viewed it", viewed === 1);

    section("Nobody else, until it is shared");
    await as("nisha.bhat12@demo.deskzo.invalid");
    const notYours = await R.openReport(id);
    const missing = await R.openReport("zzrpt-no-such-report");
    ok("the salesperson can't open it — the same words as for a report that doesn't exist", !notYours.ok && !missing.ok && notYours.error === missing.error, notYours.ok ? "opened" : notYours.error);
    const runRefused = await R.runReport({ reportId: id });
    ok("…nor run it", !runRefused.ok && runRefused.code === "denied");
    const saveRefused = await R.saveReport({ id, name: "taken", definition: def, baseUpdatedAt: opened.data.updatedAt });
    ok("…nor save over it", !saveRefused.ok);
    ok("…nor delete or share it", !(await R.deleteReport(id)).ok && !(await R.shareReport({ id, shares: [{ userId: sales.id, canEdit: true }] })).ok);
    ok("…and it isn't in their lists", (await R.listReports({ tab: "all" })).ok && !((await R.listReports({ tab: "all", search: PREFIX })) as { ok: true; data: { rows: { id: string }[] } }).data.rows.some((r) => r.id === id));

    section("A view share");
    await as("admin@acme.example");
    const shared = await R.shareReport({ id, shares: [{ userId: sales.id, canEdit: false }] });
    ok("the admin shares it with the salesperson to view", shared.ok && shared.data.sharedWith === "1 person", shared.ok ? shared.data.sharedWith : shared.error);
    ok("…who is told", (await db.notification.count({ where: { userId: sales.id, type: "REPORT_SHARED", link: `/reports/${id}` } })) === 1);
    await as("nisha.bhat12@demo.deskzo.invalid");
    const asViewer = await R.openReport(id);
    ok("the salesperson opens it, to view", asViewer.ok && asViewer.data.access === "view" && asViewer.data.shares.length === 0, asViewer.ok ? asViewer.data.access : asViewer.error);
    // A viewer sending a different definition with the report's id runs the report as saved.
    const tampered = structuredClone(def);
    tampered.pages[0]!.charts = [{ ...tampered.pages[0]!.charts[0]!, id: "zz-injected" }];
    const viewerRun = await R.runReport({ reportId: id, definition: tampered });
    ok("a viewer's run is the report as saved, never a definition they send", viewerRun.ok && !("zz-injected" in viewerRun.charts) && revenueId in viewerRun.charts, viewerRun.ok ? Object.keys(viewerRun.charts) : viewerRun.error);
    const viewerSave = await R.saveReport({ id, name: `${PREFIX} renamed`, definition: def, baseUpdatedAt: opened.data.updatedAt });
    ok("a viewer can't save it", !viewerSave.ok && viewerSave.error.includes("view this report but not change it"), viewerSave.ok ? "saved" : viewerSave.error);
    ok("…nor share or delete it", !(await R.shareReport({ id, shares: [] })).ok && !(await R.deleteReport(id)).ok);

    section("Each person sees their own rows");
    const salesRevenue = viewerRun.ok && viewerRun.charts[revenueId]?.ok ? (viewerRun.charts[revenueId] as { result: { kind: string; value: number | null } }).result.value : null;
    const salesDirect = (await invoices.load({ userId: sales.id, from: bounds.from, to: bounds.to, dateColumn: "issueDate" })) as never[];
    const salesExpected = salesDirect.reduce((t, r) => t + net.value(r), 0);
    ok("the salesperson's revenue is what their own invoice access gives — never the admin's", salesRevenue !== null && Math.abs(salesRevenue - salesExpected) < 0.01 && salesRevenue <= (value ?? 0) + 0.01, { sales: salesRevenue, theirs: salesExpected, admin: value, rows: salesDirect.length });

    section("An edit share, and a save over a later one");
    await as("admin@acme.example");
    await R.shareReport({ id, shares: [{ userId: sales.id, canEdit: true }] });
    await as("nisha.bhat12@demo.deskzo.invalid");
    const asEditor = await R.openReport(id);
    ok("the salesperson can now edit it", asEditor.ok && asEditor.data.access === "edit");
    if (!asEditor.ok) return;
    const renamed = await R.saveReport({ id, name: `${PREFIX} Receivables (edited)`, definition: asEditor.data.definition, baseUpdatedAt: asEditor.data.updatedAt });
    ok("…and save it", renamed.ok, renamed.ok ? "" : renamed.error);
    const stale = await R.saveReport({ id, name: `${PREFIX} stale`, definition: asEditor.data.definition, baseUpdatedAt: asEditor.data.updatedAt });
    ok("a save from a copy opened before that one is refused, not lost", !stale.ok && stale.error.includes("saved this report after you opened it"), stale.ok ? "saved" : stale.error);
    ok("an editor still can't share or delete it", !(await R.shareReport({ id, shares: [] })).ok && !(await R.deleteReport(id)).ok);

    section("A department share");
    await as("admin@acme.example");
    if (sales.departmentId) {
      await R.shareReport({ id, shares: [{ departmentId: sales.departmentId, canEdit: false }] });
      await as("nisha.bhat12@demo.deskzo.invalid");
      const viaDept = await R.openReport(id);
      ok("shared with the salesperson's department, they can open it", viaDept.ok && viaDept.data.access === "view");
    } else ok("(the salesperson has no department — skipped)", true);

    section("Fields and sources somebody can't use");
    await as("admin@acme.example");
    const badField = structuredClone(def);
    badField.pages[0]!.charts[0]!.metrics = [{ ref: "cf:invoice:secret_cost", agg: "sum" }];
    const refusedField = await R.saveReport({ id, name: `${PREFIX} Receivables`, definition: badField, baseUpdatedAt: (await db.savedReport.findUniqueOrThrow({ where: { id } })).updatedAt.toISOString() });
    ok("a definition naming a field the source hasn't is refused, without saying whether it exists", !refusedField.ok && refusedField.error.includes("may have been removed, or not be open to you"), refusedField.ok ? "saved" : refusedField.error);
    const injected = structuredClone(def);
    injected.calculated = [{ id: "cevil", label: "Evil", expression: "process.exit(1)", format: "number" }];
    const runInjected = await R.runReport({ definition: injected });
    ok("a calculated field that isn't arithmetic never runs", !runInjected.ok && runInjected.code === "field", runInjected.ok ? "ran" : runInjected.error);
    for (const email of ["nisha.bhat12@demo.deskzo.invalid", "rekha.accounts@acme.example"]) {
      const who = await as(email);
      const setup = await R.reportingSetup();
      const stock = setup.ok ? setup.data.sources.find((s) => s.key === "stock") : null;
      const mayStock = (await openSource("stock", who.id, isModuleEnabled)).ok;
      ok(`${who.name}: stock on hand is ${mayStock ? "open" : "locked, with no fields sent"}`, !!stock && stock.available === mayStock && (stock.available || !("measures" in stock)), stock);
      if (!mayStock) {
        const stockRun = await R.runReport({ definition: { v: 1, source: "stock", dateField: "updatedAt", dateRange: { preset: "thisFy" }, filters: [], calculated: [], pages: [{ id: "p1", name: "S", charts: [] }] } });
        ok(`${who.name}: running stock anyway is refused`, !stockRun.ok && stockRun.code === "denied", stockRun.ok ? "ran" : stockRun.error);
      }
    }

    // Somebody without any inventory permission: stock is locked, its fields withheld, a run refused.
    const { canReadStock } = require("../src/lib/reporting/extra-sources") as typeof import("../src/lib/reporting/extra-sources"); // eslint-disable-line @typescript-eslint/no-require-imports
    const candidates = await db.user.findMany({ where: { active: true, role: { in: ["SUPPORT", "CALLING", "PROFILE", "SALES"] } }, select: { id: true, email: true }, take: 40 });
    let noStock: string | null = null;
    for (const c of candidates) if (!(await canReadStock(c.id))) { noStock = c.email; break; }
    if (noStock) {
      const who = await as(noStock);
      const setup = await R.reportingSetup();
      const stock = setup.ok ? setup.data.sources.find((s) => s.key === "stock") : null;
      ok(`${who.name} (no inventory permission): stock on hand is locked, no fields sent`, !!stock && !stock.available && !("measures" in stock) && !("dimensions" in stock), stock);
      const stockRun = await R.runReport({ definition: { v: 1, source: "stock", dateField: "updatedAt", dateRange: { preset: "thisFy" }, filters: [], calculated: [], pages: [{ id: "p1", name: "S", charts: [] }] } });
      ok("…running it anyway is refused", !stockRun.ok && stockRun.code === "denied", stockRun.ok ? "ran" : stockRun.error);
      const make = await R.createReport({ name: `${PREFIX} stock`, source: "stock" });
      ok("…and so is making a report over it", !make.ok, make.ok ? "made" : make.error);
    } else ok("(everybody here can read stock — the locked case wasn't exercised)", true);

    section("Downloads");
    for (const email of ["admin@acme.example", "nisha.bhat12@demo.deskzo.invalid"]) {
      const who = await as(email);
      const may = await can(who.id, "data.exportFinance");
      const csv = await R.exportReportChart({ reportId: id, chartId: revenueId });
      ok(`${who.name}: ${may ? "downloads the revenue figure" : "is refused the download, without the export permission"}`, csv.ok === may, csv.ok ? csv.data.filename : csv.error);
      if (csv.ok) ok("…and the file carries the chart's figure", csv.data.csv.includes("Run by") && csv.data.csv.includes(String(Math.round((who.id === admin.id ? (value ?? 0) : (salesRevenue ?? 0)) * 100) / 100)), csv.data.csv.split("\n").slice(-2));
    }

    section("Asking for access");
    await as("rekha.accounts@acme.example");
    ok("someone it isn't shared with can't ask for access to it", !(await R.requestReportAccess(id)).ok);
    await as("admin@acme.example");
    await R.shareReport({ id, shares: [{ userId: accounts.id, canEdit: false }] });
    await as("rekha.accounts@acme.example");
    const asked = await R.requestReportAccess(id);
    await R.requestReportAccess(id);
    ok("someone it's shared with asks; the owner is told once a day", asked.ok && (await db.notification.count({ where: { userId: admin.id, type: "REPORT_ACCESS_REQUESTED", link: `/reports/${id}` } })) === 1);

    section("Duplicate and delete");
    await as("nisha.bhat12@demo.deskzo.invalid");
    await as("admin@acme.example");
    const copy = await R.duplicateReport(id);
    ok("a copy is the duplicator's own, shared with nobody", copy.ok && (await db.savedReport.findUnique({ where: { id: copy.data.id }, include: { shares: true } }))?.shares.length === 0);
    const gone = await R.deleteReport(id);
    ok("the owner deletes it — its shares, views and favourites with it", gone.ok && (await db.savedReportShare.count({ where: { reportId: id } })) === 0 && (await db.savedReportView.count({ where: { reportId: id } })) === 0);
  } finally {
    await cleanup();
    ok("nothing of the check is left behind", (await db.savedReport.count({ where: { name: { contains: PREFIX } } })) === 0);
    await db.$disconnect();
  }
  console.log(failures === 0 ? "\nAll reporting access checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
