/**
 * check:app-daily — the Deskzo app's everyday screens (src/lib/app/daily.ts; /api/app/today, attendance, tasks,
 * leave, approvals) through their real route handlers, as a paired phone, against this workspace's database
 * (owner, 18 Oct 2026).
 *
 *   · /me says which screens the person may use.
 *   · Clocking in and out: the web's own rule (once a day); where the phone was kept with the day when it says,
 *     nothing when it doesn't or sends what can't be a place; HR's day dialog shows it to the person and their
 *     manager, to nobody else.
 *   · Today: clocked in, the tasks due today, what waits for a decision, leave left and coming.
 *   · Tasks: a quick one for themselves, the views, ticked off and opened again; somebody else's only as the
 *     web's own rule allows.
 *   · Leave: the days a span takes, asking, cancelling before it starts.
 *   · Approvals: the manager sees the report's leave and never their own; decided from the phone, by the leave
 *     action's own rule; a kind there isn't, a 404.
 *   · On an iPhone (owner, 22 Oct 2026): what the bell says goes to the person's iPhone too, as on Android — leave
 *     asked for to the approver, the decision to the one who asked; the title and where it leads, never the
 *     request; and nothing for a kind they muted.
 *   · Screen rules: the app is told the screenshot allowance and the watermark; a screenshot taken in it counts
 *     where the website's do, and past the allowance is logged as blocked. The workspace's own rules are put back.
 *
 * Everything is named ZZAPPDAY and removed at the end. Leave is asked for six weeks out, so the suite passes on
 * any day.
 *
 *   npm run check:app-daily
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
process.env.TRUST_PROXY = "1";
process.env.DESKZO_APP = "on";
// Never Apple's real service from a check: iPhones' pushes go to the stand-in.
delete process.env.DESKZO_APP_APNS_KEY;

const TAG = "ZZAPPDAY";
const MAIL = "@zzappday.invalid";
const requestHeaders = new Headers({ host: "deskzo.localhost:3000", "user-agent": "check:app-daily", "x-forwarded-for": "198.51.100.60" });
let browserUser: { id: string; name: string; email: string; role: string } | null = null;

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
  // Sign-in as src/lib/auth.ts answers it: the phone's person inside a checked call, else the browser's.
  if (request === "@/lib/auth") {
    return {
      auth: async () => {
        /* eslint-disable-next-line @typescript-eslint/no-require-imports */
        const { apiActor } = require("../src/lib/api/actor") as typeof import("../src/lib/api/actor");
        const api = apiActor();
        if (api) return { user: { id: api.userId, name: api.name, email: api.email, role: api.role }, expires: "" };
        return browserUser ? { user: browserUser, expires: "" } : null;
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

async function cleanup() {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  const types = (await db.leaveType.findMany({ where: { code: { startsWith: TAG } }, select: { id: true } })).map((t) => t.id);
  const tasks = (await db.task.findMany({ where: { OR: [{ createdByUserId: { in: ids } }, { assignedToUserId: { in: ids } }] }, select: { id: true } })).map((t) => t.id);
  const requests = (await db.leaveRequest.findMany({ where: { OR: [{ userId: { in: ids } }, { typeId: { in: types } }] }, select: { id: true } })).map((r) => r.id);
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: [...tasks, ...requests] } }] } });
  await db.activityLog.deleteMany({ where: { userId: { in: ids } } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.attendanceDay.deleteMany({ where: { userId: { in: ids } } });
  await db.task.deleteMany({ where: { id: { in: tasks } } });
  await db.leaveRequest.deleteMany({ where: { id: { in: requests } } });
  await db.leaveBalance.deleteMany({ where: { OR: [{ userId: { in: ids } }, { typeId: { in: types } }] } });
  await db.leaveType.deleteMany({ where: { id: { in: types } } });
  await db.user.updateMany({ where: { id: { in: ids } }, data: { managerId: null } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

const ROUTES: [RegExp, string, string[]][] = [
  [/^\/pair$/, "pair", []],
  [/^\/me$/, "me", []],
  [/^\/device$/, "device", []],
  [/^\/today$/, "today", []],
  [/^\/attendance$/, "attendance", []],
  [/^\/tasks$/, "tasks", []],
  [/^\/tasks\/([^/]+)\/comments$/, "tasks/[id]/comments", ["id"]],
  [/^\/tasks\/([^/]+)$/, "tasks/[id]", ["id"]],
  [/^\/leave$/, "leave", []],
  [/^\/leave\/preview$/, "leave/preview", []],
  [/^\/leave\/([^/]+)$/, "leave/[id]", ["id"]],
  [/^\/approvals$/, "approvals", []],
  [/^\/screenshot$/, "screenshot", []],
  [/^\/approvals\/([^/]+)\/([^/]+)$/, "approvals/[kind]/[id]", ["kind", "id"]],
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
  if (body !== undefined) headers["content-type"] = "application/json";
  for (const [k, v] of requestHeaders) headers[k] ??= v;
  const req = new Request(`http://deskzo.localhost:3000/api/app${pathAndQuery}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await handler(req, { params: Promise.resolve(params) });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  return { status: res.status, data: json.data as T, error: json.error };
}

type Today = {
  date: string;
  attendance: { status: string | null; check_in_at: string | null; check_out_at: string | null } | null;
  tasks: { due_today: { id: string; title: string }[]; open: number; overdue: number } | null;
  approvals_waiting: number;
  leave: { balances: { type_id: string }[]; upcoming: { id: string; status: string; days: number }[] } | null;
};
type Task = { id: string; title: string; due: string | null; status: string };
type Approval = { kind: string; id: string; title: string; from: string | null };

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const pairing = require("../src/lib/app/pairing") as typeof import("../src/lib/app/pairing");
  const { moduleAvailableForTenant } = require("../src/lib/modules-access") as typeof import("../src/lib/modules-access");
  const { attendanceLocations } = require("../src/actions/attendance-location") as typeof import("../src/actions/attendance-location");
  const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
  const { workableTask } = require("../src/lib/tasks/server") as typeof import("../src/lib/tasks/server");
  const push = require("../src/lib/app/push") as typeof import("../src/lib/app/push");
  /* eslint-enable @typescript-eslint/no-require-imports */

  await cleanup();
  try {
    if (!(await moduleAvailableForTenant("hr")) || !(await moduleAvailableForTenant("tasks"))) {
      ok("HR and Tasks are in this workspace's plan and switched on — the suite needs both", false);
      return;
    }
    const clock = await workspaceClock();
    const today = clock.today();

    section("The people and their phones");
    const manager = await db.user.create({ data: { name: `${TAG} Manager`, email: `manager${MAIL}`, role: "SALES_MANAGER", passwordHash: "x".repeat(60) } });
    const worker = await db.user.create({ data: { name: `${TAG} Worker`, email: `worker${MAIL}`, role: "SALES", passwordHash: "x".repeat(60), managerId: manager.id } });
    const stranger = await db.user.create({ data: { name: `${TAG} Stranger`, email: `stranger${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    const pair = async (userId: string, model: string, platform = "android") => {
      const code = await pairing.startPairing(userId);
      /* eslint-disable-next-line @typescript-eslint/no-require-imports */
      const mod = require("../src/app/api/app/pair/route") as { POST: (req: Request) => Promise<Response> };
      const res = await mod.POST(new Request("http://deskzo.localhost:3000/api/app/pair", { method: "POST", headers: { ...Object.fromEntries(requestHeaders), "content-type": "application/json" }, body: JSON.stringify({ code: code.code, platform, model }) }));
      return ((await res.json()) as { data: { token: string } }).data.token;
    };
    const workerPhone = await pair(worker.id, `${TAG} worker phone`);
    const managerPhone = await pair(manager.id, `${TAG} manager phone`);
    ok("a worker, their manager and somebody else; both phones paired", workerPhone.startsWith("dzp_") && managerPhone.startsWith("dzp_"));
    const me = await call<{ can: { calls: boolean; attendance: boolean; tasks: boolean } }>(workerPhone, "GET", "/me");
    ok("/me: attendance and tasks open to them", me.status === 200 && me.data.can.attendance === true && me.data.can.tasks === true, JSON.stringify(me.data?.can));

    section("Clocking in and out");
    const before = await call<Today>(workerPhone, "GET", "/today");
    ok("Today, first thing: not clocked in", before.status === 200 && before.data.date === today && before.data.attendance?.check_in_at === null, before.status);
    const clockedIn = await call<Today["attendance"]>(workerPhone, "POST", "/attendance", { action: "in", latitude: 28.6139, longitude: 77.209, accuracy: 18.4 });
    ok("clocked in from the phone, with where it was", clockedIn.status === 200 && !!clockedIn.data?.check_in_at, clockedIn.error?.message ?? clockedIn.status);
    const place = await db.attendanceLocation.findMany({ where: { userId: worker.id } });
    const phoneRow = await db.appDevice.findFirst({ where: { userId: worker.id } });
    ok("  the place kept with today, rounded to the metre, naming the phone", place.length === 1 && place[0]!.kind === "IN" && place[0]!.latitude === 28.6139 && place[0]!.accuracyM === 18 && place[0]!.date.toISOString().slice(0, 10) === today && place[0]!.appDeviceId === phoneRow?.id, JSON.stringify(place[0]));
    const twice = await call(workerPhone, "POST", "/attendance", { action: "in", latitude: 28.6, longitude: 77.2 });
    ok("clocking in twice: the web's own refusal, and no second place", twice.status === 422 && twice.error?.message === "You're already clocked in today." && (await db.attendanceLocation.count({ where: { userId: worker.id } })) === 1, twice.error?.message);
    const out = await call<Today["attendance"]>(workerPhone, "POST", "/attendance", { action: "out", latitude: 123, longitude: 77.2 });
    // Every clocking is kept now (owner, 22 Oct 2026), so a terminal's punches merge with it — with no place when none came.
    const outRows = await db.attendanceLocation.findMany({ where: { userId: worker.id, kind: "OUT" }, select: { latitude: true, longitude: true } });
    ok("clocked out, sending a latitude that can't be: out, the clocking kept with no place", out.status === 200 && !!out.data?.check_out_at && outRows.length === 1 && outRows[0]!.latitude === null && outRows[0]!.longitude === null, out.status);
    ok("an action that isn't one: refused", (await call(workerPhone, "POST", "/attendance", { action: "lunch" })).status === 400);
    browserUser = { id: worker.id, name: worker.name, email: worker.email, role: worker.role };
    const own = await attendanceLocations(worker.id, today);
    browserUser = { id: manager.id, name: manager.name, email: manager.email, role: manager.role };
    const managers = await attendanceLocations(worker.id, today);
    browserUser = { id: stranger.id, name: stranger.name, email: stranger.email, role: stranger.role };
    const strangers = await attendanceLocations(worker.id, today);
    browserUser = null;
    ok("HR's day dialog: the person and their manager see where; somebody else sees nothing", own.length === 2 && managers.length === 2 && managers[0]!.latitude === 28.6139 && managers[1]!.latitude === null && strangers.length === 0, `${own.length}/${managers.length}/${strangers.length}`);

    section("Tasks");
    const added = await call<{ id: string }>(workerPhone, "POST", "/tasks", { title: `${TAG} call the bank`, due: today });
    ok("a quick task for themselves, due today", added.status === 201 && (await db.task.findUnique({ where: { id: added.data.id } }))?.assignedToUserId === worker.id, added.error?.message ?? added.status);
    const dueToday = await call<Task[]>(workerPhone, "GET", "/tasks?view=today");
    ok("  in Today's view", dueToday.status === 200 && dueToday.data.some((t) => t.id === added.data.id && t.due === today));
    const todayScreen = await call<Today>(workerPhone, "GET", "/today");
    ok("  and on the Today screen, with the day's attendance", !!todayScreen.data.tasks?.due_today.some((t) => t.id === added.data.id) && !!todayScreen.data.attendance?.check_out_at);
    const done = await call<{ status: string }>(workerPhone, "PATCH", `/tasks/${added.data.id}`, { status: "DONE" });
    ok("ticked off from the phone", done.status === 200 && (await db.task.findUnique({ where: { id: added.data.id } }))?.status === "DONE", done.error?.message ?? done.status);
    ok("  now in Done, out of Today", (await call<Task[]>(workerPhone, "GET", "/tasks?view=done")).data.some((t) => t.id === added.data.id) && !(await call<Task[]>(workerPhone, "GET", "/tasks?view=today")).data.some((t) => t.id === added.data.id));
    ok("  and opened again", (await call(workerPhone, "PATCH", `/tasks/${added.data.id}`, { status: "TODO" })).status === 200 && (await db.task.findUnique({ where: { id: added.data.id } }))?.status === "TODO");
    const comment = await call<{ id: string }>(workerPhone, "POST", `/tasks/${added.data.id}/comments`, { body: "Bank closes at four" });
    ok("a comment from the phone", comment.status === 201, comment.error?.message ?? comment.status);
    const theirs = await db.task.create({ data: { title: `${TAG} the stranger's`, createdByUserId: stranger.id, assignedToUserId: stranger.id } });
    // The web's own rule (workableTask) decides — this workspace's roles may let a colleague move it along.
    const webAllows = !!(await workableTask(worker.id, theirs.id));
    const meddle = await call(workerPhone, "PATCH", `/tasks/${theirs.id}`, { status: "DONE" });
    const after = (await db.task.findUnique({ where: { id: theirs.id } }))?.status;
    ok(`somebody else's task: as the web's rule says (${webAllows ? "this role may" : "refused"})`, webAllows ? meddle.status === 200 && after === "DONE" : meddle.status === 422 && after !== "DONE", meddle.status);
    ok("a status that isn't one: refused", (await call(workerPhone, "PATCH", `/tasks/${added.data.id}`, { status: "SOMEDAY" })).status === 400);

    section("Leave");
    const type = await db.leaveType.create({ data: { code: `${TAG}`, name: `${TAG} unpaid`, annualQuota: 0, paid: false, active: true } });
    const leave = await call<{ types: { id: string }[]; balances: { type_id: string }[] }>(workerPhone, "GET", "/leave");
    ok("the leave types and the person's balances", leave.status === 200 && leave.data.types.some((t) => t.id === type.id), leave.status);
    // A working Wednesday six weeks out, and the Thursday after.
    let from = "";
    let preview: Answer<{ days: number }> | null = null;
    for (let weeks = 6; weeks < 12 && !(preview?.data?.days === 2); weeks += 1) {
      const d = new Date(`${today}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + weeks * 7 + ((3 - d.getUTCDay() + 7) % 7));
      from = d.toISOString().slice(0, 10);
      const to = new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10);
      preview = await call<{ days: number }>(workerPhone, "POST", "/leave/preview", { from, to });
    }
    const to = new Date(Date.parse(`${from}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    ok("the days a span takes, worked out before asking", preview?.status === 200 && preview.data.days === 2, JSON.stringify(preview?.data));
    const half = await call<{ days: number }>(workerPhone, "POST", "/leave/preview", { from, to, to_half_day: true });
    ok("  a half day on the last day: one and a half", half.data.days === 1.5, half.data.days);
    ok("  dates not as Deskzo takes them: refused", (await call(workerPhone, "POST", "/leave/preview", { from: "next week", to })).status === 400);
    // Both of them with an iPhone too, to hear what waits for them.
    const managerIphone = await pair(manager.id, `${TAG} manager iPhone`, "ios");
    const workerIphone = await pair(worker.id, `${TAG} worker iPhone`, "ios");
    await call(managerIphone, "PATCH", "/device", { push_token: "apns-zzappday-manager" });
    await call(workerIphone, "PATCH", "/device", { push_token: "apns-zzappday-worker" });
    type Pushed = { apns?: { token: string; payload: { aps: { alert: { title: string; body?: string } }; body: Record<string, string> } }; message?: unknown };
    const pushed: Pushed[] = [];
    push.setTestPush(async (message) => {
      pushed.push(message as Pushed);
      return 200;
    });
    const asked = await call<{ id: string; days: number }>(workerPhone, "POST", "/leave", { type_id: type.id, from, to, reason: `${TAG} family wedding` });
    ok("asked for from the phone: the web's own applyForLeave", asked.status === 201 && asked.data.days === 2 && (await db.leaveRequest.findUnique({ where: { id: asked.data.id } }))?.status === "PENDING", asked.error?.message ?? asked.status);
    const toManager = pushed.filter((p) => p.apns?.token === "apns-zzappday-manager");
    ok(
      "  the manager's iPhone told, as their bell is — the title and where it leads, never the request — and nothing to the worker",
      toManager.length === 1 &&
        toManager[0]!.apns!.payload.aps.alert.title === "Leave request" &&
        toManager[0]!.apns!.payload.body.type === "notice" &&
        toManager[0]!.apns!.payload.body.kind === "LEAVE_REQUESTED" &&
        toManager[0]!.apns!.payload.body.link.startsWith("/") &&
        !pushed.some((p) => p.apns?.token === "apns-zzappday-worker") &&
        !JSON.stringify(pushed).includes("wedding"),
      JSON.stringify(pushed),
    );
    pushed.length = 0;
    const mine = await call<{ requests: { id: string; status: string; days: number }[] }>(workerPhone, "GET", "/leave");
    ok("  in their requests, its days a number", mine.data.requests.some((r) => r.id === asked.data.id && r.status === "PENDING" && r.days === 2));
    const coming = await call<Today>(workerPhone, "GET", "/today");
    ok("  and coming up on Today", !!coming.data.leave?.upcoming.some((l) => l.id === asked.data.id && l.days === 2));
    ok("no reason: refused in the action's words", (await call(workerPhone, "POST", "/leave", { type_id: type.id, from, to, reason: "" })).status === 422);

    section("Approvals");
    const managerToday = await call<Today>(managerPhone, "GET", "/today");
    const queue = await call<Approval[]>(managerPhone, "GET", "/approvals");
    const item = queue.data?.find((a) => a.kind === "leave" && a.id === asked.data.id);
    ok("the manager sees the report's leave waiting, counted on Today", queue.status === 200 && !!item && item.from === worker.name && managerToday.data.approvals_waiting >= 1, queue.status);
    ok("  the worker doesn't see their own", !(await call<Approval[]>(workerPhone, "GET", "/approvals")).data.some((a) => a.id === asked.data.id));
    const selfDecide = await call(workerPhone, "POST", `/approvals/leave/${asked.data.id}`, { approve: true });
    ok("  nor decide it: the leave action's own refusal", selfDecide.status === 422 && (await db.leaveRequest.findUnique({ where: { id: asked.data.id } }))?.status === "PENDING", selfDecide.error?.message);
    ok("a kind there isn't: 404", (await call(managerPhone, "POST", `/approvals/payslip/${asked.data.id}`, { approve: true })).status === 404);
    const approved = await call(managerPhone, "POST", `/approvals/leave/${asked.data.id}`, { approve: true, note: "Enjoy" });
    const decided = await db.leaveRequest.findUnique({ where: { id: asked.data.id } });
    ok("approved from the manager's phone, with the note, as the manager", approved.status === 200 && decided?.status === "APPROVED" && decided.decisionNote === "Enjoy" && decided.approverId === manager.id, approved.error?.message ?? approved.status);
    ok(
      "  the worker told in Deskzo, and on their iPhone — the title, never the note — and nothing to the manager",
      (await db.notification.count({ where: { userId: worker.id, type: "LEAVE_DECIDED" } })) >= 1 &&
        pushed.length === 1 &&
        pushed[0]!.apns?.token === "apns-zzappday-worker" &&
        pushed[0]!.apns.payload.body.kind === "LEAVE_DECIDED" &&
        !JSON.stringify(pushed).includes("Enjoy"),
      JSON.stringify(pushed),
    );
    ok("  gone from the queue", !(await call<Approval[]>(managerPhone, "GET", "/approvals")).data.some((a) => a.id === asked.data.id));
    ok("  and approved on the worker's Today", !!(await call<Today>(workerPhone, "GET", "/today")).data.leave?.upcoming.some((l) => l.id === asked.data.id && l.status === "APPROVED"));
    const again = await call(managerPhone, "POST", `/approvals/leave/${asked.data.id}`, { approve: false });
    ok("deciding it twice: refused", again.status === 422, again.error?.message);

    section("Screen rules");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SECURITY_POLICY_ID, invalidateSecurityPolicyCache } = require("../src/lib/security/store") as typeof import("../src/lib/security/store");
    const policyBefore = await db.securityPolicy.findUnique({ where: { id: SECURITY_POLICY_ID } });
    const rules = { screenshotLimitPerDay: 1, screenshotNotifyAdmins: false, watermarkEnabled: true, exemptRoles: [] as string[] };
    await db.securityPolicy.upsert({ where: { id: SECURITY_POLICY_ID }, create: { id: SECURITY_POLICY_ID, ...rules }, update: rules });
    invalidateSecurityPolicyCache();
    try {
      type Screen = { screenshots: { limit: number; used: number } | null; watermark: { label: string; opacity: number; scope: string } | null };
      const told = (await call<{ screen: Screen }>(workerPhone, "GET", "/me")).data.screen;
      ok("the app is told the allowance and the watermark — the person's name and address", told.screenshots?.limit === 1 && told.screenshots.used === 0 && told.watermark?.label === `${worker.name} · ${worker.email}`, JSON.stringify(told));
      type Shot = { allowed: boolean; remaining: number | null; enforced: boolean; message: string };
      const first = await call<Shot>(workerPhone, "POST", "/screenshot", { screen: "tasks" });
      ok("a screenshot in the app counts where the website's do: the last one today", first.status === 200 && first.data.allowed && first.data.remaining === 0 && first.data.enforced, JSON.stringify(first.data));
      const second = await call<Shot>(workerPhone, "POST", "/screenshot", { screen: "calls" });
      ok("  past it: not allowed, so the app blocks them", second.data.allowed === false && second.data.remaining === 0);
      const logged = await db.activityLog.findMany({ where: { userId: worker.id, kind: { in: ["SCREENSHOT", "SCREENSHOT_BLOCKED"] } }, select: { kind: true, path: true } });
      ok("  both in the security log, naming the app's screen", logged.length === 2 && logged.every((l) => (l.path ?? "").includes("Deskzo app") ) && logged.some((l) => l.kind === "SCREENSHOT_BLOCKED" && (l.path ?? "").endsWith("calls")), JSON.stringify(logged));
      ok("  and the next who-am-I says so", (await call<{ screen: Screen }>(workerPhone, "GET", "/me")).data.screen.screenshots?.used === 2);
      await db.securityPolicy.update({ where: { id: SECURITY_POLICY_ID }, data: { exemptRoles: ["SALES"] } });
      invalidateSecurityPolicyCache();
      const exempt = (await call<{ screen: Screen }>(workerPhone, "GET", "/me")).data.screen;
      ok("a role the rules don't apply to: nothing to follow", exempt.screenshots === null && exempt.watermark === null);
    } finally {
      // The four this section changed, back as they were.
      if (policyBefore) {
        const { screenshotLimitPerDay, screenshotNotifyAdmins, watermarkEnabled, exemptRoles } = policyBefore;
        await db.securityPolicy.update({ where: { id: SECURITY_POLICY_ID }, data: { screenshotLimitPerDay, screenshotNotifyAdmins, watermarkEnabled, exemptRoles } });
      } else await db.securityPolicy.delete({ where: { id: SECURITY_POLICY_ID } });
      invalidateSecurityPolicyCache();
    }

    section("Cancelling leave");
    const cancelled = await call(workerPhone, "DELETE", `/leave/${asked.data.id}`);
    ok("the worker cancels it before it starts", cancelled.status === 200 && (await db.leaveRequest.findUnique({ where: { id: asked.data.id } }))?.status === "CANCELLED", cancelled.error?.message ?? cancelled.status);
    // The manager no longer wants to hear of leave asked for: not in Deskzo, so not on the iPhone either.
    await db.notificationPreference.upsert({ where: { userId_type: { userId: manager.id, type: "LEAVE_REQUESTED" } }, create: { userId: manager.id, type: "LEAVE_REQUESTED", inApp: false }, update: { inApp: false } });
    pushed.length = 0;
    const toldBefore = await db.notification.count({ where: { userId: manager.id, type: "LEAVE_REQUESTED" } });
    const second = await call<{ id: string }>(workerPhone, "POST", "/leave", { type_id: type.id, from, to: from, reason: `${TAG} errand` });
    ok("a kind the manager muted: neither told nor pushed", second.status === 201 && pushed.length === 0 && (await db.notification.count({ where: { userId: manager.id, type: "LEAVE_REQUESTED" } })) === toldBefore, JSON.stringify(pushed));
    push.setTestPush(null);
    const notTheirs = await call(managerPhone, "DELETE", `/leave/${second.data.id}`);
    ok("somebody else's: refused, and left as it was", notTheirs.status === 422 && (await db.leaveRequest.findUnique({ where: { id: second.data.id } }))?.status === "PENDING", notTheirs.error?.message);
  } finally {
    push.setTestPush(null);
    await cleanup();
  }
}

main()
  .catch((e) => {
    console.error(e);
    failures += 1;
  })
  .finally(async () => {
    console.log(failures ? `\n${failures} failed.` : "\nAll passed.");
    process.exit(failures ? 1 : 0);
  });
