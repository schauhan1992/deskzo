/**
 * check:app-field — the Deskzo app's field work (src/lib/app/field.ts; /api/app/visits, expenses, meetings) through
 * the real route handlers, as paired phones, against this workspace's database (owner, 22 Oct 2026 — phase 2 of
 * the native app).
 *
 *   · /me says visits, expenses and the calendar are open.
 *   · A visit planned from the phone, today's list, checked in with where the phone was — once — and written up on
 *     leaving with where it was then; both places on the visit, for whoever may open it and nobody else.
 *   · A check-in that shares no place keeps none; a cancellation needs its reason.
 *   · The receipt rule (src/lib/expenses/receipts.ts): under the company's amount a claim goes in without one; over
 *     it, not without — whether submitted at once or later — and with one it does. Set by HR only.
 *   · A claim against a visit shows on the visit; a draft is taken back.
 *   · A meeting scheduled from the visit is on the calendar, and cancelled.
 *
 * Everything is named ZZAPPFIELD and removed at the end; the workspace's own receipt rule is put back.
 *
 *   npm run check:app-field
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
process.env.TRUST_PROXY = "1";
process.env.DESKZO_APP = "on";

const TAG = "ZZAPPFIELD";
const MAIL = "@zzappfield.invalid";
const requestHeaders = new Headers({ host: "deskzo.localhost:3000", "user-agent": "check:app-field", "x-forwarded-for": "198.51.100.63" });

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/headers") return { headers: async () => requestHeaders, cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }) };
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
    };
  }
  // Sign-in as src/lib/auth.ts answers it: the phone's (or the suite's) person inside a checked call, nobody outside.
  if (request === "@/lib/auth") {
    return {
      auth: async () => {
        /* eslint-disable-next-line @typescript-eslint/no-require-imports */
        const { apiActor } = require("../src/lib/api/actor") as typeof import("../src/lib/api/actor");
        const api = apiActor();
        return api ? { user: { id: api.userId, name: api.name, email: api.email, role: api.role }, expires: "" } : null;
      },
      signIn: async () => {},
      signOut: async () => {},
      handlers: {},
    };
  }
  if (request === "@/lib/email") return { sendEmailNotification: async () => {} };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const json = (v: unknown) => JSON.stringify(v);

/** A 1×1 PNG: a receipt as far as the checks are concerned. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

async function cleanup() {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  const visits = (await db.visit.findMany({ where: { OR: [{ companyId: { in: companies } }, { userId: { in: ids } }] }, select: { id: true } })).map((v) => v.id);
  const expenses = (await db.expense.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((e) => e.id);
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: [...companies, ...visits, ...expenses] } }] } });
  await db.activityLog.deleteMany({ where: { userId: { in: ids } } });
  await db.notification.deleteMany({ where: { OR: [{ userId: { in: ids } }, { title: { contains: TAG } }] } });
  await db.calendarEvent.deleteMany({ where: { OR: [{ title: { startsWith: TAG } }, { visitId: { in: visits } }] } }).catch(() => {});
  await db.expense.deleteMany({ where: { id: { in: expenses } } });
  await db.visit.deleteMany({ where: { id: { in: visits } } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

const ROUTES: [RegExp, string, string[]][] = [
  [/^\/me$/, "me", []],
  [/^\/visits$/, "visits", []],
  [/^\/visits\/options$/, "visits/options", []],
  [/^\/visits\/([^/]+)\/check-in$/, "visits/[id]/check-in", ["id"]],
  [/^\/visits\/([^/]+)\/complete$/, "visits/[id]/complete", ["id"]],
  [/^\/visits\/([^/]+)\/status$/, "visits/[id]/status", ["id"]],
  [/^\/visits\/([^/]+)$/, "visits/[id]", ["id"]],
  [/^\/expenses$/, "expenses", []],
  [/^\/expenses\/options$/, "expenses/options", []],
  [/^\/expenses\/([^/]+)\/submit$/, "expenses/[id]/submit", ["id"]],
  [/^\/expenses\/([^/]+)$/, "expenses/[id]", ["id"]],
  [/^\/companies$/, "companies", []],
  [/^\/meetings$/, "meetings", []],
  [/^\/meetings\/([^/]+)\/cancel$/, "meetings/[id]/cancel", ["id"]],
];

type Answer<T = unknown> = { status: number; data: T; error?: { code: string; message: string } };

async function call<T = unknown>(token: string, method: string, pathAndQuery: string, body?: unknown): Promise<Answer<T>> {
  const [pathOnly] = pathAndQuery.split("?");
  const route = ROUTES.find(([re]) => re.test(pathOnly!));
  if (!route) throw new Error(`no route for ${pathOnly}`);
  const [re, dir, names] = route;
  const match = re.exec(pathOnly!)!;
  const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(match[i + 1]!)]));
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const mod = require(`../src/app/api/app/${dir}/route`) as Record<string, (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>>;
  const handler = mod[method];
  if (!handler) throw new Error(`${dir} has no ${method}`);
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const isForm = body instanceof FormData;
  if (body !== undefined && !isForm) headers["content-type"] = "application/json";
  for (const [k, v] of requestHeaders) headers[k] ??= v;
  const req = new Request(`http://deskzo.localhost:3000/api/app${pathAndQuery}`, { method, headers, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body) });
  const res = await handler(req, { params: Promise.resolve(params) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  return { status: res.status, data: parsed.data as T, error: parsed.error };
}

type Visit = { id: string; ref: string; status: string; company: { id: string } | null; places?: { kind: string; latitude: number; accuracy_m: number | null }[]; expenses?: { id: string }[] };

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const pairing = require("../src/lib/app/pairing") as typeof import("../src/lib/app/pairing");
  const { moduleAvailableForTenant } = require("../src/lib/modules-access") as typeof import("../src/lib/modules-access");
  const { runAsApiActor } = require("../src/lib/api/actor") as typeof import("../src/lib/api/actor");
  const receipts = require("../src/lib/expenses/receipts") as typeof import("../src/lib/expenses/receipts");
  const expenseActions = require("../src/actions/expense") as typeof import("../src/actions/expense");
  const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const before = await db.expenseSettings.findUnique({ where: { id: "global" }, select: { receiptRequiredAbove: true } });
  await cleanup();
  try {
    for (const key of ["visits", "expenses", "companies"]) {
      if (!(await moduleAvailableForTenant(key))) {
        ok(`${key} is in this workspace's plan and switched on — the suite needs it`, false);
        return;
      }
    }
    const today = (await workspaceClock()).today();
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

    section("The people and their phones");
    const seller = await db.user.create({ data: { name: `${TAG} Seller`, email: `seller${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    const other = await db.user.create({ data: { name: `${TAG} Other`, email: `other${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    const hr = await db.user.create({ data: { name: `${TAG} HR`, email: `hr${MAIL}`, role: "ADMIN", passwordHash: "x".repeat(60) } });
    const pair = async (userId: string, model: string) => {
      const code = await pairing.startPairing(userId);
      /* eslint-disable-next-line @typescript-eslint/no-require-imports */
      const mod = require("../src/app/api/app/pair/route") as { POST: (req: Request) => Promise<Response> };
      const res = await mod.POST(new Request("http://deskzo.localhost:3000/api/app/pair", { method: "POST", headers: { ...Object.fromEntries(requestHeaders), "content-type": "application/json" }, body: JSON.stringify({ code: code.code, platform: "android", model }) }));
      return ((await res.json()) as { data: { token: string } }).data.token;
    };
    const phone = await pair(seller.id, `${TAG} seller phone`);
    const otherPhone = await pair(other.id, `${TAG} other phone`);
    const me = await call<{ can: Record<string, boolean> }>(phone, "GET", "/me");
    ok("/me: visits and expenses open to a salesperson", me.status === 200 && me.data.can.visits === true && me.data.can.expenses === true && typeof me.data.can.calendar === "boolean", json(me.data?.can));

    const company = await call<{ id: string; ref: string }>(phone, "POST", "/companies", { name: `${TAG} Acme`, relationship_type: "CLIENT", contacts: [{ name: `${TAG} Ravi`, phone: "+91 90000 22222", is_primary: true }] });
    ok("a customer of theirs to visit", company.status === 201, company.error?.message ?? company.status);
    const companyId = company.data.ref;

    section("A visit, from planning to write-up");
    const options = await call<{ purposes: { value: string }[]; contacts: { id: string }[] }>(phone, "GET", `/visits/options?company=${companyId}`);
    ok("what a visit offers: the purposes, and the company's people", options.status === 200 && options.data.purposes.length > 5 && options.data.contacts.length === 1, options.error?.message ?? json(options.data));
    const planned = await call<{ id: string; ref: string }>(phone, "POST", "/visits", { company: companyId, contact: options.data.contacts[0]?.id, purpose: "PRODUCT_DEMO", scheduled_for: `${today}T11:00`, agenda: `${TAG} demo the firewall` });
    ok("a visit planned for today, from the phone", planned.status === 201 && planned.data.ref.startsWith("VIS-"), planned.error?.message ?? planned.status);
    const todays = await call<Visit[]>(phone, "GET", "/visits?view=today");
    ok("  on today's list", todays.status === 200 && todays.data.some((v) => v.id === planned.data.id), todays.error?.message ?? todays.data?.length);

    const inAt = await call<{ place_kept: boolean }>(phone, "POST", `/visits/${planned.data.ref}/check-in`, { latitude: 18.5204, longitude: 73.8567, accuracy: 12.6, mocked: false });
    ok("checked in at the door, by its ref, with where the phone was", inAt.status === 200 && inAt.data.place_kept === true, inAt.error?.message ?? inAt.status);
    const twice = await call(phone, "POST", `/visits/${planned.data.id}/check-in`, { latitude: 18.5, longitude: 73.8 });
    ok("  checking in twice: the web's own refusal, and no second place", twice.status === 422 && (await db.visitLocation.count({ where: { visitId: planned.data.id } })) === 1, twice.error?.message);
    const done = await call<{ place_kept: boolean }>(phone, "POST", `/visits/${planned.data.id}/complete`, { outcome: `${TAG} demo went well, quote next week`, distance_km: 14, latitude: 18.5206, longitude: 73.857, accuracy: 30 });
    ok("written up on leaving, with where the phone was then", done.status === 200 && done.data.place_kept === true, done.error?.message ?? done.status);
    const visit = await call<Visit>(phone, "GET", `/visits/${planned.data.id}`);
    ok(
      "  the visit: completed, both places in order, how sure the phone was",
      visit.status === 200 && visit.data.status === "COMPLETED" && json(visit.data.places?.map((p) => [p.kind, p.latitude, p.accuracy_m])) === json([["IN", 18.5204, 13], ["OUT", 18.5206, 30]]),
      json(visit.data?.places),
    );
    const theirs = await call(otherPhone, "GET", `/visits/${planned.data.id}`);
    ok("another salesperson can't open it, nor see where it was", theirs.status === 404, theirs.status);

    const quiet = await call<{ id: string; ref: string }>(phone, "POST", "/visits", { company: companyId, scheduled_for: `${today}T15:00` });
    const noPlace = await call<{ place_kept: boolean }>(phone, "POST", `/visits/${quiet.data.id}/check-in`, {});
    ok("a check-in that shares no place: checked in, and nothing kept", noPlace.status === 200 && noPlace.data.place_kept === false && (await db.visitLocation.count({ where: { visitId: quiet.data.id } })) === 0, noPlace.error?.message);
    const third = await call<{ id: string }>(phone, "POST", "/visits", { company: companyId, scheduled_for: `${tomorrow}T10:00` });
    const bare = await call(phone, "POST", `/visits/${third.data.id}/status`, { status: "CANCELLED" });
    const why = await call(phone, "POST", `/visits/${third.data.id}/status`, { status: "CANCELLED", note: "Customer travelling" });
    ok("cancelling needs its reason; with one, cancelled", bare.status === 422 && why.status === 200, `${bare.status} ${bare.error?.message} / ${why.status}`);

    section("The receipt rule");
    ok("receiptRefusal: under or at the amount, none needed", receipts.receiptRefusal(500, false, 500) === null && receipts.receiptRefusal(100, false, 500) === null);
    ok("  over it, refused without one; with one, fine; no amount set, never", !!receipts.receiptRefusal(501, false, 500) && receipts.receiptRefusal(501, true, 500) === null && receipts.receiptRefusal(99_999, false, null) === null);
    const actor = (u: { id: string; name: string; email: string; role: string }) => ({ userId: u.id, name: u.name, email: u.email, role: u.role, keyId: "suite", keyName: TAG, scopes: [], channel: "app" as const });
    const bySales = await runAsApiActor(actor(seller), () => expenseActions.setExpenseReceiptRule({ above: 500 }));
    ok("a salesperson can't set it", !bySales.ok, bySales.ok ? "" : bySales.error);
    const byHr = await runAsApiActor(actor(hr), () => expenseActions.setExpenseReceiptRule({ above: 500 }));
    ok("HR sets it: a receipt over ₹500", byHr.ok && byHr.data.above === 500, byHr.ok ? "" : byHr.error);
    const opts = await call<{ receipt_required_above: number | null; categories: { value: string }[] }>(phone, "GET", "/expenses/options");
    ok("  the app is told so, with the categories", opts.status === 200 && opts.data.receipt_required_above === 500 && opts.data.categories.some((c) => c.value === "FUEL"), json(opts.data?.receipt_required_above));

    const claim = (amount: number, submit: boolean, receipt: boolean, extra: Record<string, string> = {}) => {
      const form = new FormData();
      form.append("category", "FUEL");
      form.append("amount", String(amount));
      form.append("spent_on", today);
      form.append("description", `${TAG} fuel to Acme`);
      form.append("submit", String(submit));
      for (const [k, v] of Object.entries(extra)) form.append(k, v);
      if (receipt) form.append("receipt", new File([PNG], "receipt.png", { type: "image/png" }));
      return call<{ id: string; ref: string }>(phone, "POST", "/expenses", form);
    };
    const small = await claim(300, true, false);
    ok("₹300 without a receipt: submitted", small.status === 201, small.error?.message ?? small.status);
    const big = await claim(900, true, false);
    ok("₹900 without a receipt: refused, saying why", big.status === 422 && /receipt/i.test(big.error?.message ?? ""), big.error?.message);
    const withPhoto = await claim(900, true, true, { visit: planned.data.ref });
    ok("₹900 with its photo, against the visit: submitted", withPhoto.status === 201, withPhoto.error?.message ?? withPhoto.status);
    const read = await call<{ has_receipt: boolean; status: string; visit: { id: string } | null }>(phone, "GET", `/expenses/${withPhoto.data.id}`);
    ok("  read back: its receipt, submitted, on the visit", read.status === 200 && read.data.has_receipt && read.data.status === "SUBMITTED" && read.data.visit?.id === planned.data.id, json(read.data));
    const onVisit = await call<Visit>(phone, "GET", `/visits/${planned.data.id}`);
    ok("  and the visit lists it", !!onVisit.data.expenses?.some((e) => e.id === withPhoto.data.id));
    const draft = await claim(900, false, false);
    const later = await call(phone, "POST", `/expenses/${draft.data.id}/submit`);
    ok("a ₹900 draft saved without a receipt; submitting it later: refused", draft.status === 201 && later.status === 422 && /receipt/i.test(later.error?.message ?? ""), later.error?.message);
    const mine = await call<{ id: string }[]>(phone, "GET", "/expenses");
    ok("my claims: all three", mine.status === 200 && [small, withPhoto, draft].every((c) => mine.data.some((m) => m.id === c.data.id)), mine.data?.length);
    const gone = await call(phone, "DELETE", `/expenses/${draft.data.id}`);
    ok("the draft taken back", gone.status === 200 && (await db.expense.count({ where: { id: draft.data.id } })) === 0, gone.error?.message ?? gone.status);
    ok("another salesperson can't open a claim", (await call(otherPhone, "GET", `/expenses/${withPhoto.data.id}`)).status === 404);

    section("Meetings");
    if (me.data.can.calendar) {
      const meeting = await call<{ id: string }>(phone, "POST", "/meetings", { record: { kind: "company", id: company.data.id }, title: `${TAG} pricing call`, starts_at: `${tomorrow}T11:30`, duration_minutes: 30, online: true });
      if (meeting.status === 201) {
        const list = await call<{ id: string; title: string }[]>(phone, "GET", `/meetings?from=${tomorrow}&to=${tomorrow}`);
        ok("a meeting scheduled from the company is on tomorrow's calendar", list.status === 200 && list.data.some((m) => m.title === `${TAG} pricing call`), list.error?.message ?? json(list.data?.map((m) => m.title)));
        const cancelled = await call(phone, "POST", `/meetings/${meeting.data.id}/cancel`, { note: "Moved to next week" });
        ok("  and cancelled", cancelled.status === 200, cancelled.error?.message ?? cancelled.status);
      } else {
        ok("scheduling a meeting: refused in the web's own words (this workspace's calendar rules)", meeting.status === 422 && !!meeting.error?.message, meeting.error?.message ?? meeting.status);
      }
    } else {
      console.log("  (the calendar isn't open to a salesperson in this workspace — meetings not tried)");
    }
  } finally {
    await db.expenseSettings.upsert({ where: { id: "global" }, create: { id: "global", receiptRequiredAbove: before?.receiptRequiredAbove ?? null }, update: { receiptRequiredAbove: before?.receiptRequiredAbove ?? null } }).catch(() => {});
    await cleanup();
  }

  console.log(failures === 0 ? "\nAll app field-work checks passed." : `\n${failures} app field-work check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
