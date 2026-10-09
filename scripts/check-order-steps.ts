/**
 * check:order-steps — a workspace's own steps within an order's statuses (owner, 2 Oct 2026): Settings →
 * Pipeline → Orders, the order page's progress, and the orders list's Step column and filter
 * (src/lib/pipeline/order-steps.ts, src/actions/pipeline.ts, src/actions/order-progress.ts).
 *
 * The pure part needs no database: which step an order shows, and the rules for shaping steps.
 *
 * The rest builds a scratch workspace database beside the real one (as check:custom-fields does),
 * drives the real actions as a workspace pointed at it (`runAsTenant`), and drops it at the end:
 *
 *   · settings: only `pipeline.manage` shapes steps; within Approved, Processing and Fulfilled only;
 *     names unique within a status; a step's status fixed; reordering; retiring with the orders at it
 *     moved on, with a note; restore; delete only when no order is at it;
 *   · moving an order: by purchase, the salesperson or an approver, on an account they can see; only to
 *     a step of its own status; recorded with the steps' names and a note; the salesperson told; a
 *     move to where it already is recording nothing; not before approval;
 *   · an order whose status moved on reads as the first step of its new status, untouched;
 *   · the orders list filtered by step, the first step holding the orders with none; the order page
 *     and the list rendered;
 *   · a workspace still waiting for the migration: everything works as before, with no steps;
 *   · and the real workspace untouched.
 *
 *   npm run check:order-steps
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ReactElement } from "react";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import { checkStep, stepOfOrder, stepRehomeTargets, type OrderStepDef } from "../src/lib/pipeline/order-steps";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : r.error);

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const TAG = "ZZSTEPS";

// ── Who the actions think is calling ────────────────────────────────────────────────────────────

let actor: { id: string; name: string; email: string; role: string } | null = null;

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
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(),
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const email = { sendEmailNotification: async () => {} };
const viewMode = { getViewMode: async () => "list" as const, setViewMode: async () => {} };
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/navigation", navigation],
  ["@/lib/session", session],
  ["@/lib/email", email],
  ["@/actions/view-mode", viewMode],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/navigation"), navigation],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("../src/lib/email"), email],
  [load.resolve("../src/actions/view-mode"), viewMode],
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

const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

// ── The pure part ───────────────────────────────────────────────────────────────────────────────

const step = (id: string, label: string, status: OrderStepDef["status"], archived = false): OrderStepDef => ({ id, key: id, label, status, color: "blue", archived });

function pure() {
  section("Which step an order shows");
  const ordered = step("p1", "Material ordered", "PROCESSING");
  const received = step("p2", "Material received", "PROCESSING");
  const old = step("p0", "Old step", "PROCESSING", true);
  const handed = step("f1", "Handed over", "FULFILLED");
  const steps = [old, ordered, received, handed];
  ok("its own, while that is a step of the status it is in", stepOfOrder(steps, { orderStatus: "PROCESSING", stepId: "p2" })?.id === "p2");
  ok("  otherwise the first step of that status — none set yet", stepOfOrder(steps, { orderStatus: "PROCESSING", stepId: null })?.id === "p1");
  ok("  or one left from the status it was in before", stepOfOrder(steps, { orderStatus: "FULFILLED", stepId: "p2" })?.id === "f1");
  ok("  or one since retired", stepOfOrder(steps, { orderStatus: "PROCESSING", stepId: "p0" })?.id === "p1");
  ok("  and none where its status has no steps", stepOfOrder(steps, { orderStatus: "APPROVED", stepId: null }) === null);

  section("Shaping steps");
  const input = (label: string, status: OrderStepDef["status"] = "PROCESSING") => ({ label, status, color: "blue" as const });
  ok("a step needs a name, short enough", checkStep(input(" "), steps) !== null && checkStep(input("x".repeat(41)), steps) !== null);
  ok("  only within Approved, Processing or Fulfilled", checkStep(input("Checked", "PENDING_APPROVAL"), steps) !== null && checkStep(input("Checked", "CANCELLED"), steps) !== null);
  ok("  not a name its status already has", checkStep(input("material RECEIVED"), steps) !== null);
  ok("  though another status may have it, and a retired one's name is free", checkStep(input("Material received", "FULFILLED"), steps) === null && checkStep(input("Old step"), steps) === null);
  ok("a retired step's orders go to another step of its status", stepRehomeTargets(ordered, steps).map((s) => s.id).join() === "p2");
}

// ── The scratch database ────────────────────────────────────────────────────────────────────────

async function main() {
  pure();

  const realUrl = process.env.DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);

  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_ordersteps`;
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
  ok("its orders and companies are as they were", realAfter.counts === realBefore.counts, realAfter.counts);
  ok("  and nothing of this suite's is in it", realAfter.tagged === 0 && realBefore.tagged === 0, realAfter.tagged);

  console.log(failures === 0 ? `\nAll ${passes} order-steps checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** What the suite must never change in the real workspace. Read-only. */
async function snapshot(client: PrismaClient) {
  const [orders, companies, tagged] = await Promise.all([client.companyProduct.count(), client.company.count(), client.company.count({ where: { name: { startsWith: TAG } } })]);
  return { counts: JSON.stringify({ orders, companies }), tagged };
}

// ── The suite ───────────────────────────────────────────────────────────────────────────────────

async function run(scratchUrl: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const settings = require("../src/actions/pipeline") as typeof import("../src/actions/pipeline");
  const progress = require("../src/actions/order-progress") as typeof import("../src/actions/order-progress");
  const orders = require("../src/actions/order") as typeof import("../src/actions/order");
  const server = require("../src/lib/pipeline/order-steps-server") as typeof import("../src/lib/pipeline/order-steps-server");
  const { OrderDetail } = require("../src/components/orders/order-detail") as typeof import("../src/components/orders/order-detail");
  const OrdersPage = (require("../src/app/(dashboard)/orders/page") as { default: (p: unknown) => Promise<ReactElement> }).default;
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const tenant = {
    id: randomUUID(),
    slug: "zzsteps",
    name: "zzsteps",
    status: "ACTIVE" as const,
    dbUrl: scratchUrl,
    primaryHost: "zzsteps.localhost",
    hosts: ["zzsteps.localhost"],
    source: "env" as const,
    isDefault: false,
    keyBundleCipher: null,
    country: "IN",
    entitlements: { v: 1 as const, all: true, modules: [], seats: null, copilotTokens: null, customDomains: null, plans: [] },
    holdReason: null,
  };

  await runAsTenant(tenant, async () => {
    // ── Fixture ────────────────────────────────────────────────────────────────────────────────
    section("Fixture");
    const user = (key: string, grants: Record<string, boolean>, extra: { isSuperAdmin?: boolean; role?: string } = {}) =>
      db.user.create({
        data: {
          name: `${TAG} ${key}`,
          email: `${TAG.toLowerCase()}-${key.toLowerCase()}@example.test`,
          passwordHash: "!",
          role: extra.role ?? "PROFILE",
          isSuperAdmin: extra.isSuperAdmin ?? false,
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
        select: { id: true, name: true, email: true, role: true },
      });
    const quiet = { "orders.process": false, "orders.approve": false, "pipeline.manage": false };
    const owner = await user("Owner", {}, { isSuperAdmin: true, role: "ADMIN" });
    const manager = await user("Manager", { ...quiet, "pipeline.manage": true, "orders.view": true, "companies.viewAll": true });
    const sales = await user("Sales", { ...quiet, "orders.view": true, "companies.viewAll": false });
    const purchase = await user("Purchase", { ...quiet, "orders.process": true, "orders.view": true, "companies.viewAll": true });
    const viewer = await user("Viewer", { ...quiet, "orders.view": true, "companies.viewAll": true });
    const outsider = await user("Outsider", { ...quiet, "orders.process": true, "orders.view": true, "companies.viewAll": false });
    const as = (u: { id: string; name: string; email: string; role: string }) => {
      actor = u;
    };
    const item = await db.item.create({
      data: { name: `${TAG} Rack server`, sku: `${TAG}-SRV`, type: "GOOD", sellingPrice: 250000, createdById: owner.id },
      select: { id: true },
    });
    const company = await db.company.create({
      data: { name: `${TAG} Alpha Hospital`, normalizedName: `${TAG} alpha hospital`.toLowerCase(), createdById: owner.id, ownerUserId: sales.id, stage: "CUSTOMER" },
      select: { id: true },
    });
    const location = await db.companyLocation.create({ data: { companyId: company.id, label: "Head Office", isPrimary: true }, select: { id: true } });
    const order = (orderStatus: "PENDING_APPROVAL" | "APPROVED" | "PROCESSING" | "FULFILLED") =>
      db.companyProduct.create({
        data: { companyId: company.id, locationId: location.id, itemId: item.id, quantity: 2, unitPrice: 250000, orderStatus, addedByUserId: sales.id },
        select: { id: true, orderSeq: true },
      });
    const inProcess = await order("PROCESSING");
    const another = await order("PROCESSING");
    const waiting = await order("PENDING_APPROVAL");
    ok("a manager, the salesperson, purchase, somebody who only looks, and an outsider; orders in purchase and one waiting", !!inProcess.id && !!waiting.id);

    // ── Settings ───────────────────────────────────────────────────────────────────────────────
    section("Settings → Pipeline → Orders");
    as(sales);
    ok("the salesperson can't shape steps", (await settings.listOrderStepsForManage()) === null && !(await settings.saveOrderStep({ label: "Packed", status: "PROCESSING", color: "blue" })).ok);
    as(manager);
    const idOf = (r: Awaited<ReturnType<typeof settings.saveOrderStep>>) => (r.ok ? r.data.id : "");
    const ordered = idOf(await settings.saveOrderStep({ label: "Material ordered", status: "PROCESSING", color: "blue" }));
    const received = idOf(await settings.saveOrderStep({ label: "Material received", status: "PROCESSING", color: "amber" }));
    const installed = idOf(await settings.saveOrderStep({ label: "Installed", status: "PROCESSING", color: "green" }));
    const handed = idOf(await settings.saveOrderStep({ label: "Handed over", status: "FULFILLED", color: "green" }));
    ok("steps added within Processing and Fulfilled", !!ordered && !!received && !!installed && !!handed);
    const waitingStep = await settings.saveOrderStep({ label: "Checked", status: "PENDING_APPROVAL", color: "blue" });
    ok("  never within an order still waiting for approval", !waitingStep.ok, errorOf(waitingStep));
    const twice = await settings.saveOrderStep({ label: "installed", status: "PROCESSING", color: "blue" });
    const elsewhere = await settings.saveOrderStep({ label: "Installed", status: "FULFILLED", color: "blue" });
    ok("a name its status already has is refused; another status may use it", !twice.ok && elsewhere.ok, `${errorOf(twice)} / ${errorOf(elsewhere)}`);
    if (elsewhere.ok) await settings.deleteOrderStep(elsewhere.data.id);
    const moved = await settings.saveOrderStep({ id: installed, label: "Installed on site", status: "FULFILLED", color: "green" });
    const installedNow = (await server.orderSteps()).steps.find((s) => s.id === installed);
    ok("a step renamed keeps its status, whatever is sent", moved.ok && installedNow?.label === "Installed on site" && installedNow.status === "PROCESSING", JSON.stringify(installedNow));
    await settings.moveOrderStep(installed, "up");
    const processingOrder = (await server.orderSteps()).steps.filter((s) => s.status === "PROCESSING" && !s.archived).map((s) => s.label);
    ok("  and moved up among its status's steps", processingOrder.join(" → ") === "Material ordered → Installed on site → Material received", processingOrder.join(" → "));
    await settings.moveOrderStep(installed, "down");

    // ── Moving orders ──────────────────────────────────────────────────────────────────────────
    section("Moving an order along");
    const shown = async (id: string) => (await server.stepsOfOrders([{ id, orderStatus: (await db.companyProduct.findUniqueOrThrow({ where: { id }, select: { orderStatus: true } })).orderStatus }])).get(id);
    ok("an order in purchase starts at the first step", (await shown(inProcess.id))?.id === ordered);
    as(purchase);
    const toReceived = await progress.setOrderStep(inProcess.id, received, "Two of two boxes, unopened");
    const placed = await db.companyProduct.findUniqueOrThrow({ where: { id: inProcess.id }, select: { stepId: true, stepChangedAt: true } });
    const history = await server.stepHistory(inProcess.id);
    ok(
      "purchase moves it to Material received, with a note",
      toReceived.ok && placed.stepId === received && !!placed.stepChangedAt && history[0]?.fromLabel === "Material ordered" && history[0]?.toLabel === "Material received" && history[0]?.note === "Two of two boxes, unopened",
      `${errorOf(toReceived)} ${JSON.stringify(history[0] ?? null)}`,
    );
    const told = await db.notification.findFirst({ where: { userId: sales.id, title: { contains: "Material received" } }, select: { title: true } });
    ok("  and the salesperson is told", !!told, told?.title);
    const again = await progress.setOrderStep(inProcess.id, received);
    ok("  moved there again: nothing is recorded", again.ok && (await server.stepHistory(inProcess.id)).length === 1);
    const wrongStatus = await progress.setOrderStep(inProcess.id, handed);
    ok("a step of another status is refused", !wrongStatus.ok, errorOf(wrongStatus));
    as(sales);
    const bySales = await progress.setOrderStep(inProcess.id, installed);
    ok("the salesperson who punched it may move it too", bySales.ok, errorOf(bySales));
    as(viewer);
    const byViewer = await progress.setOrderStep(inProcess.id, received);
    ok("somebody who only looks may not", !byViewer.ok, errorOf(byViewer));
    as(outsider);
    const byOutsider = await progress.setOrderStep(inProcess.id, received);
    ok("  nor somebody outside the account — it doesn't exist for them", !byOutsider.ok && byOutsider.error === "Order not found.", errorOf(byOutsider));
    as(purchase);
    const early = await progress.setOrderStep(waiting.id, ordered);
    ok("an order still waiting for approval has no steps yet", !early.ok, errorOf(early));

    // ── Forward only, exactly once ─────────────────────────────────────────────────────────────
    // A reseller's "PO placed with distributor → Licences issued": at the last step the page offered the
    // step before it, and a page left open could still move it. Moves now go forward only, decided on
    // the locked row, and the page says the order is done here.
    section("Forward only, exactly once");
    as(purchase);
    const historyOf = async (id: string) => (await server.stepHistory(id)).length;
    const atLast = textOf(renderToStaticMarkup((await OrderDetail({ id: inProcess.id })) as ReactElement));
    ok("at the last step of Processing the page says so, and what moves it on", atLast.includes("Installed on site is the last step of Processing") && atLast.includes("marks it fulfilled"));
    ok("  and offers no move — not the step it is at, nor an earlier one", !atLast.includes("Choose the next step") && !atLast.includes("Move to"));
    const before = await historyOf(inProcess.id);
    const back = await progress.setOrderStep(inProcess.id, received);
    ok("moving it back by a hand-made request is refused", !back.ok && /only moves forward/.test(errorOf(back) ?? ""), errorOf(back));
    const same = await progress.setOrderStep(inProcess.id, installed, "again");
    ok("  and asking for the step it is at records nothing", same.ok && (await historyOf(inProcess.id)) === before);
    as(viewer);
    ok("  nor may somebody who only looks move it", !(await progress.setOrderStep(inProcess.id, installed)).ok);
    as(purchase);

    const racer = await order("PROCESSING");
    const raced = await Promise.all(Array.from({ length: 6 }, () => progress.setOrderStep(racer.id, received, "issued", ordered)));
    const racerSteps = await server.stepHistory(racer.id);
    ok("six clicks at once move it once", raced.every((r) => r.ok) && racerSteps.length === 1 && racerSteps[0]?.toLabel === "Material received", `${racerSteps.length} recorded`);
    const stale = await progress.setOrderStep(racer.id, installed, null, ordered);
    ok("a page still showing the step it has left is refused, not applied", !stale.ok && /moved on/.test(errorOf(stale) ?? "") && (await historyOf(racer.id)) === 1, errorOf(stale));
    const fresh = await progress.setOrderStep(racer.id, installed, null, received);
    const racerNow = textOf(renderToStaticMarkup((await OrderDetail({ id: racer.id })) as ReactElement));
    ok("  from the step it is at, it goes on — and the page, read again, agrees", fresh.ok && racerNow.includes("Installed on site is the last step of Processing") && racerNow.includes("Material received → Installed on site"));
    const cancelled = await orders.cancelOrder(racer.id, "Customer withdrew the order");
    ok("an order at its last step can still be cancelled", cancelled.ok, errorOf(cancelled));
    ok("  and, cancelled, takes no step", !(await progress.setOrderStep(racer.id, ordered)).ok);
    // Gone again, so the list checks below see the orders they always have.
    await db.orderStepChange.deleteMany({ where: { orderId: racer.id } });
    await db.companyProduct.delete({ where: { id: racer.id } });

    // ── The list ───────────────────────────────────────────────────────────────────────────────
    section("The orders list by step");
    const keyOf = async (id: string) => (await server.orderSteps()).steps.find((s) => s.id === id)!.key;
    const listed = async (stepKey: string) => (await orders.listOrdersPaged({ page: 1, pageSize: 50, step: stepKey })).rows.map((r) => r.id).sort();
    ok("at Installed on site: the order moved there", (await listed(await keyOf(installed))).join() === [inProcess.id].join());
    ok("  at the first step: the order nobody has moved yet", (await listed(await keyOf(ordered))).join() === [another.id].join());
    const html = textOf(renderToStaticMarkup(await OrdersPage({ searchParams: Promise.resolve({}) })));
    ok("the list shows the Step column and each order's step", html.includes("Step") && html.includes("Installed on site") && html.includes("Material ordered"));
    await db.companyProduct.update({ where: { id: inProcess.id }, data: { orderStatus: "FULFILLED" } });
    ok("fulfilled, it reads as the first step of Fulfilled — nothing about its step was touched", (await shown(inProcess.id))?.id === handed);
    ok("  and the list finds it there", (await listed(await keyOf(handed))).join() === [inProcess.id].join());
    const page = textOf(renderToStaticMarkup((await OrderDetail({ id: inProcess.id })) as ReactElement));
    ok("its page shows where it is and how it got there", page.includes("Progress — Fulfilled") && page.includes("Handed over") && page.includes("Material ordered → Material received"));

    // ── Retiring ───────────────────────────────────────────────────────────────────────────────
    section("Retiring a step");
    as(purchase);
    await progress.setOrderStep(another.id, received);
    as(manager);
    const noTarget = await settings.retireOrderStep(received, null);
    ok("a step with orders at it is retired only once you say where they go", !noTarget.ok, errorOf(noTarget));
    const retired = await settings.retireOrderStep(received, installed);
    const rehomed = await db.companyProduct.findUniqueOrThrow({ where: { id: another.id }, select: { stepId: true } });
    ok(
      "  they move on, with a note saying why",
      retired.ok && rehomed.stepId === installed && (await server.stepHistory(another.id))[0]?.note === "Material received was retired",
      `${errorOf(retired)} ${JSON.stringify(rehomed)}`,
    );
    const deleteBusy = await settings.deleteOrderStep(installed);
    const restored = await settings.restoreOrderStep(received);
    ok("a step an order is at can't be deleted; a retired one can be restored", !deleteBusy.ok && restored.ok, `${errorOf(deleteBusy)} / ${errorOf(restored)}`);
    const listedSteps = await settings.listOrderStepsForManage();
    ok("the screen counts the orders at each step", listedSteps?.steps.find((s) => s.id === installed)?.placed === 1, JSON.stringify(listedSteps?.steps.map((s) => `${s.label}:${s.orders}/${s.placed}`)));

    // ── Before the migration ───────────────────────────────────────────────────────────────────
    section("A workspace still waiting for the migration");
    await db.$executeRawUnsafe(`ALTER TABLE "company_products" DROP CONSTRAINT "company_products_stepId_fkey"`);
    await db.$executeRawUnsafe(`DROP TABLE "order_step_changes"`);
    await db.$executeRawUnsafe(`ALTER TABLE "company_products" DROP COLUMN "stepId", DROP COLUMN "stepChangedAt"`);
    await db.$executeRawUnsafe(`DROP TABLE "order_steps"`);
    const waitingSteps = await server.orderSteps();
    ok("it has no steps, and says so", !waitingSteps.stored && waitingSteps.steps.length === 0);
    as(purchase);
    const stillListed = await orders.listOrdersPaged({ page: 1, pageSize: 50, step: "material_ordered" });
    ok("  its orders list as before, a step in the link narrowing nothing", stillListed.rows.length === 3, stillListed.rows.length);
    const stillPage = textOf(renderToStaticMarkup((await OrderDetail({ id: another.id })) as ReactElement));
    ok("  an order's page opens, with no progress card", stillPage.includes(`ORD-`) && !stillPage.includes("Progress —"));
    const blocked = await progress.setOrderStep(another.id, "anything");
    ok("  and nothing can be moved", !blocked.ok, errorOf(blocked));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
