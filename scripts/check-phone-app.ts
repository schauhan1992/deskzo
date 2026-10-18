/**
 * check:phone-app — the Deskzo app's calling (src/lib/app, /api/app/*) through its real route handlers,
 * against this workspace's database (owner, 18 Oct 2026).
 *
 *   · Pairing: a code from somebody's own settings, good once and for ten minutes; wrong codes counted
 *     towards a lockout; the phone made a device of theirs (Security › Devices), waiting for approval where
 *     the role asks for it.
 *   · The phone's token: wrong, unknown, revoked — one 401; its person switched off — refused; its secret
 *     never stored.
 *   · Caller ID: a number in any of the ways it is written, matched only to what the person can see — never
 *     a reseller's customer, never somebody who has left.
 *   · Call sync: logged once however often it is sent, with what its length says; a number on nobody they
 *     can see, or a call from before pairing, left alone; a customer's missed call a callback owed, once;
 *     the obvious lead taken.
 *   · The after-call card: how it went, a callback with its task, the lead's timeline; nobody else's call.
 *   · "Ring my phone": a push with the number and nothing more, handed to the phone once, and the call that
 *     comes back logged with what the dialog was about.
 *   · Calls switched off for the person: refused. Signed out: the token stops at once.
 *   · Settings › Deskzo app: not there until the app is out; then a code and a QR, the phones, signing out.
 *
 * Everything is named ZZPHONE and removed at the end.
 *
 *   npm run check:phone-app
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";
import { renderHtml } from "./lib/render-html";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
process.env.TRUST_PROXY = "1";
delete process.env.DESKZO_APP_ANDROID_URL;
process.env.DESKZO_APP = "on";

const TAG = "ZZPHONE";
const MAIL = "@zzphone.invalid";
const ROLE = "ZZPHONE_APPROVED_DEVICES";
let requestHeaders = new Headers({ host: "deskzo.localhost:3000", "user-agent": "check:phone-app", "x-forwarded-for": "198.51.100.40" });
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
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
      usePathname: () => "/",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  // Sign-in as src/lib/auth.ts answers it: a checked call's person first (an API key's or a phone's), else the browser's.
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
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const companies = await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);
  const calls = await db.callLog.findMany({ where: { OR: [{ companyId: { in: companyIds } }, { userId: { in: ids } }] }, select: { id: true } });
  const tasks = await db.task.findMany({ where: { OR: [{ companyId: { in: companyIds } }, { createdByUserId: { in: ids } }, { assignedToUserId: { in: ids } }] }, select: { id: true } });
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: [...companyIds, ...calls.map((c) => c.id), ...tasks.map((t) => t.id)] } }] } });
  await db.activityLog.deleteMany({ where: { userId: { in: ids } } });
  await db.notification.deleteMany({ where: { OR: [{ userId: { in: ids } }, { title: { contains: TAG } }] } });
  await db.callLog.deleteMany({ where: { id: { in: calls.map((c) => c.id) } } });
  await db.task.deleteMany({ where: { id: { in: tasks.map((t) => t.id) } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.roleAccessPolicy.deleteMany({ where: { roleKey: ROLE } });
  await db.role.deleteMany({ where: { key: ROLE } });
}

const ROUTES: [RegExp, string, string[]][] = [
  [/^\/pair$/, "pair", []],
  [/^\/me$/, "me", []],
  [/^\/device$/, "device", []],
  [/^\/calls\/lookup$/, "calls/lookup", []],
  [/^\/calls\/sync$/, "calls/sync", []],
  [/^\/calls\/review$/, "calls/review", []],
  [/^\/calls\/callbacks$/, "calls/callbacks", []],
  [/^\/calls\/requests$/, "calls/requests", []],
  [/^\/calls\/([^/]+)$/, "calls/[id]", ["id"]],
];

type Answer = { status: number; body: { data?: unknown; error?: { code: string; message: string; fields?: Record<string, string> } } };

async function call(method: string, pathAndQuery: string, opts: { token?: string | null; auth?: string; body?: unknown } = {}): Promise<Answer> {
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
  const headers: Record<string, string> = {};
  if (opts.auth) headers.authorization = opts.auth;
  else if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  for (const [k, v] of requestHeaders) headers[k] ??= v;
  const req = new Request(`http://deskzo.localhost:3000/api/app${pathAndQuery}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const res = await handler(req, { params: Promise.resolve(params) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

const from = (ip: string) => {
  requestHeaders = new Headers({ host: "deskzo.localhost:3000", "user-agent": "check:phone-app", "x-forwarded-for": ip });
};

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const pairing = require("../src/lib/app/pairing") as typeof import("../src/lib/app/pairing");
  const tokens = require("../src/lib/app/tokens") as typeof import("../src/lib/app/tokens");
  const push = require("../src/lib/app/push") as typeof import("../src/lib/app/push");
  const { clearAccessCache } = require("../src/lib/access/gate") as typeof import("../src/lib/access/gate");
  const { canSeeCompany } = require("../src/lib/authz/company-scope") as typeof import("../src/lib/authz/company-scope");
  const { moduleAvailableForTenant } = require("../src/lib/modules-access") as typeof import("../src/lib/modules-access");
  const deviceActions = require("../src/actions/app-devices") as typeof import("../src/actions/app-devices");
  const phoneCalls = require("../src/actions/phone-calls") as typeof import("../src/actions/phone-calls");
  const { SETTINGS_ITEMS, visibleSettingsKeys } = require("../src/lib/settings/catalogue") as typeof import("../src/lib/settings/catalogue");

  await cleanup();
  try {
    if (!(await moduleAvailableForTenant("calls")) || !(await moduleAvailableForTenant("leads"))) {
      ok("Calls and Leads are in this workspace's plan and switched on — the suite needs both", false);
      return;
    }

    section("The people, their customers and their numbers");
    // Ten digits no real contact has, different every run.
    const base = 7_000_000_000 + (Date.now() % 900_000_000);
    const num = (n: number) => String(base + n);
    const rep = await db.user.create({ data: { name: `${TAG} Rep`, email: `rep${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    const other = await db.user.create({ data: { name: `${TAG} Other`, email: `other${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    const company = await db.company.create({ data: { name: `${TAG} Acme`, normalizedName: `${TAG} acme`.toLowerCase(), createdById: rep.id, ownerUserId: rep.id } });
    const ravi = await db.contact.create({ data: { companyId: company.id, name: `${TAG} Ravi`, phone: `+91 ${num(1).slice(0, 5)} ${num(1).slice(5)}`, isPrimary: true } });
    const lead = await db.lead.create({ data: { companyId: company.id, contactId: ravi.id, title: `${TAG} ERP rollout`, ownerUserId: rep.id } });
    const theirs = await db.company.create({ data: { name: `${TAG} Theirs`, normalizedName: `${TAG} theirs`.toLowerCase(), createdById: other.id, ownerUserId: other.id } });
    await db.contact.create({ data: { companyId: theirs.id, name: `${TAG} Theirs contact`, phone: num(2) } });
    const otherLead = await db.lead.create({ data: { companyId: theirs.id, title: `${TAG} theirs lead`, ownerUserId: other.id } });
    const reseller = await db.company.create({ data: { name: `${TAG} Reseller`, normalizedName: `${TAG} reseller`.toLowerCase(), createdById: rep.id, ownerUserId: rep.id } });
    const endCustomer = await db.company.create({ data: { name: `${TAG} End customer`, normalizedName: `${TAG} end customer`.toLowerCase(), createdById: rep.id, ownerUserId: rep.id, managedByResellerId: reseller.id } });
    await db.contact.create({ data: { companyId: endCustomer.id, name: `${TAG} Hidden`, phone: num(3) } });
    await db.contact.create({ data: { companyId: company.id, name: `${TAG} Gone`, phone: num(4), leftAt: new Date() } });
    const repSeesTheirs = await canSeeCompany(rep.id, theirs);
    ok("a rep with an account, its contact and lead; a colleague's account; a reseller's customer; somebody who left", !!lead.id && !!otherLead.id);

    section("Pairing");
    from("198.51.100.41");
    const code = await pairing.startPairing(rep.id);
    ok("a code: ten characters, a digest kept, ten minutes", /^[2-9A-HJ-NP-Z]{10}$/.test(code.code) && !!(await db.appPairing.findUnique({ where: { codeHash: tokens.digest(code.code) } })) && Math.abs(code.expiresAt.getTime() - Date.now() - 600_000) < 5000);
    ok("  waiting, as the page sees it", (await pairing.pairingState(rep.id, code.id)).state === "WAITING");
    ok("  and nobody else's to watch", (await pairing.pairingState(other.id, code.id)).state === "EXPIRED");
    const noPlatform = await call("POST", "/pair", { body: { code: code.code } });
    ok("pairing must say the platform", noPlatform.status === 400, noPlatform.status);
    const wrong = await call("POST", "/pair", { body: { code: "ABCDEFGHJK", platform: "android" } });
    ok("a wrong code: refused", wrong.status === 401 && wrong.body.error?.code === "wrong_code", wrong.status);
    const typed = `${code.code.slice(0, 4).toLowerCase()} ${code.code.slice(4, 8)}-${code.code.slice(8)}`;
    const paired = await call("POST", "/pair", { body: { code: typed, platform: "android", model: `${TAG} Pixel`, app_version: "1.0.0" } });
    const token = (paired.body.data as { token: string; approved: boolean } | undefined)?.token ?? "";
    ok("the code as typed — any case, spaces and dashes: a token, once", paired.status === 201 && /^dzp_[a-z0-9]{20,40}\.[A-Za-z0-9_-]{43}$/.test(token) && (paired.body.data as { approved: boolean }).approved, paired.status);
    const phoneId = token.slice(4, token.indexOf("."));
    const phoneRow = await db.appDevice.findUniqueOrThrow({ where: { id: phoneId }, include: { device: true } });
    ok("  the phone is a device of the rep's — approved, in Security › Devices — and its secret isn't stored", phoneRow.userId === rep.id && phoneRow.device.kind === "MOBILE" && phoneRow.device.status === "APPROVED" && phoneRow.device.label === `Deskzo app on ${TAG} Pixel` && !JSON.stringify(phoneRow).includes(token.split(".")[1]!));
    ok("  written to the security log", (await db.activityLog.count({ where: { userId: rep.id, kind: "NEW_DEVICE", summary: { contains: `${TAG} Pixel` } } })) === 1);
    ok("  and the page sees it arrive", (await pairing.pairingState(rep.id, code.id)).state === "PAIRED");
    ok("the same code again: refused", (await call("POST", "/pair", { body: { code: code.code, platform: "android" } })).status === 401);
    const stale = await pairing.startPairing(rep.id);
    await db.appPairing.update({ where: { id: stale.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    ok("a code run out: refused", (await call("POST", "/pair", { body: { code: stale.code, platform: "android" } })).status === 401);
    from("198.51.100.42");
    let lockedOut = false;
    for (let i = 0; i < 12 && !lockedOut; i += 1) lockedOut = (await call("POST", "/pair", { body: { code: "ZZZZZZZZZZ", platform: "android" } })).status === 429;
    ok("guessing codes from one address locks it out", lockedOut);
    from("198.51.100.41");

    section("A role that admits only approved devices");
    await db.role.create({ data: { key: ROLE, name: `${TAG} approved devices` } });
    await db.roleAccessPolicy.create({ data: { roleKey: ROLE, requireDeviceApproval: true } });
    clearAccessCache();
    const careful = await db.user.create({ data: { name: `${TAG} Careful`, email: `careful${MAIL}`, role: ROLE, passwordHash: "x".repeat(60) } });
    const carefulCode = await pairing.startPairing(careful.id);
    const carefulPaired = await call("POST", "/pair", { body: { code: carefulCode.code, platform: "android", model: `${TAG} Careful phone` } });
    const carefulToken = (carefulPaired.body.data as { token: string; approved: boolean }).token;
    ok("pairing is allowed, the phone waiting for an administrator", carefulPaired.status === 201 && (carefulPaired.body.data as { approved: boolean }).approved === false);
    const waiting = await call("GET", "/me", { token: carefulToken });
    ok("  and until approved it is told so", waiting.status === 403 && waiting.body.error?.code === "device_pending", waiting.status);
    await db.userDevice.updateMany({ where: { app: { is: { id: carefulToken.slice(4, carefulToken.indexOf(".")) } } }, data: { status: "APPROVED" } });
    const carefulMe = await call("GET", "/me", { token: carefulToken });
    ok("  approved in Security › Devices: in", carefulMe.status === 200, carefulMe.status);
    ok("  a person without Calls: the app says so, and calling is refused", (carefulMe.body.data as { can: { calls: boolean } }).can.calls === false && (await call("GET", `/calls/lookup?number=${num(1)}`, { token: carefulToken })).body.error?.code === "calls_unavailable");

    section("The phone's token");
    const me = await call("GET", "/me", { token });
    ok("/me: the person, the workspace and the phone", me.status === 200 && (me.body.data as { person: { id: string }; can: { calls: boolean } }).person.id === rep.id && (me.body.data as { can: { calls: boolean } }).can.calls);
    const bad = [
      await call("GET", "/me"),
      await call("GET", "/me", { auth: "Bearer nonsense" }),
      await call("GET", "/me", { token: `${token.split(".")[0]}.${"A".repeat(43)}` }),
      await call("GET", "/me", { token: `dzp_${"a".repeat(25)}.${token.split(".")[1]}` }),
    ];
    ok("missing, malformed, a wrong secret, an unknown phone: one answer", bad.every((b) => b.status === 401) && new Set(bad.map((b) => JSON.stringify(b.body))).size === 1, bad.map((b) => b.status).join());
    await db.user.update({ where: { id: rep.id }, data: { active: false } });
    ok("its person switched off: refused", (await call("GET", "/me", { token })).body.error?.code === "person_not_allowed");
    await db.user.update({ where: { id: rep.id }, data: { active: true } });

    section("This phone's settings");
    const notYet = await call("POST", "/calls/sync", { token, body: { calls: [{ key: "x", number: num(1), direction: "out", started_at: new Date().toISOString(), duration: 5 }] } });
    ok("call sync off: nothing is taken", notYet.status === 409 && notYet.body.error?.code === "call_sync_off", notYet.status);
    const on = await call("PATCH", "/device", { token, body: { call_sync: true, push_token: "fcm-token-zzphone-0001", app_version: "1.0.1" } });
    ok("switched on from the phone, with its push address", on.status === 200 && (on.body.data as { call_sync: boolean; push: boolean }).call_sync && (on.body.data as { push: boolean }).push);
    const syncAudit = await db.auditLog.findFirst({ where: { userId: rep.id, entityType: "AppDevice", entityLabel: { startsWith: "Call sync on" } } });
    ok("  audited as the person, naming the phone", !!syncAudit?.entityLabel.includes(`via the Deskzo app on “${TAG} Pixel”`), syncAudit?.entityLabel);

    section("Caller ID");
    const ways = [num(1), `+91${num(1)}`, `0${num(1)}`, `+91 ${num(1).slice(0, 5)}-${num(1).slice(5)}`];
    const looks = await Promise.all(ways.map((w) => call("GET", `/calls/lookup?number=${encodeURIComponent(w)}`, { token })));
    const card = looks[0]!.body.data as { contact: { name: string }; company: { name: string }; leads: { title: string }[] } | null;
    ok("the number however it is written: the contact, the company, the open lead", looks.every((l) => (l.body.data as { contact?: { name: string } } | null)?.contact?.name === `${TAG} Ravi`) && card?.company.name === `${TAG} Acme` && !!card?.leads.some((l) => l.title === `${TAG} ERP rollout`));
    ok("a number on nobody: nothing", (await call("GET", `/calls/lookup?number=${num(9)}`, { token })).body.data === null);
    const theirsLook = (await call("GET", `/calls/lookup?number=${num(2)}`, { token })).body.data;
    ok(`a colleague's customer — as the rep's screens show it (${repSeesTheirs ? "visible" : "not visible"})`, repSeesTheirs ? theirsLook !== null : theirsLook === null);
    ok("a reseller's customer: nothing — nobody here calls them directly", (await call("GET", `/calls/lookup?number=${num(3)}`, { token })).body.data === null);
    ok("somebody who has left: nothing", (await call("GET", `/calls/lookup?number=${num(4)}`, { token })).body.data === null);

    section("Call sync");
    // Paired two hours ago, so the last half hour's calls are since then.
    const pairedAt = new Date(Date.now() - 2 * 3_600_000);
    await db.appDevice.update({ where: { id: phoneId }, data: { createdAt: pairedAt } });
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const sync = await call("POST", "/calls/sync", {
      token,
      body: {
        calls: [
          { key: "k1", number: `+91 ${num(1)}`, direction: "out", started_at: at(30), duration: 95 },
          { key: "k2", number: num(9), direction: "out", started_at: at(29), duration: 40 },
          { key: "k3", number: num(1), direction: "in", started_at: at(20), duration: 0 },
          { key: "k4", number: num(1), direction: "in", started_at: at(19), duration: 0 },
          { key: "k5", number: num(1), direction: "out", started_at: new Date(pairedAt.getTime() - 3_600_000).toISOString(), duration: 30 },
          { key: "k6", number: num(3), direction: "out", started_at: at(10), duration: 30 },
        ],
      },
    });
    const results = (sync.body.data as { key: string; status: string; call_id?: string }[]) ?? [];
    const st = (k: string) => results.find((r) => r.key === k)?.status;
    ok("each call answered: logged, no_match, too_old", sync.status === 200 && st("k1") === "logged" && st("k2") === "no_match" && st("k3") === "logged" && st("k4") === "logged" && st("k5") === "too_old" && st("k6") === "no_match", JSON.stringify(results.map((r) => `${r.key}:${r.status}`)));
    const k1 = await db.callLog.findFirstOrThrow({ where: { id: results.find((r) => r.key === "k1")?.call_id } });
    ok("  a call that was answered: connected, its length, from the phone, waiting to be told how it went", k1.outcome === "CONNECTED" && k1.durationSeconds === 95 && k1.source === "PHONE" && k1.appDeviceId === phoneId && k1.reviewedAt === null && k1.userId === rep.id && k1.contactId === ravi.id);
    ok("  on the obvious lead — the one open lead with Ravi on it — and its timeline", k1.leadId === lead.id && (await db.activity.count({ where: { leadId: lead.id, type: "CALL", occurredAt: k1.startedAt } })) === 1);
    const missed = await db.callLog.findMany({ where: { appDeviceId: phoneId, phoneCallKey: { in: ["k3", "k4"] } }, orderBy: { startedAt: "asc" } });
    ok("  a customer's missed call: no answer, a callback owed, with its task — once for two rings", missed.length === 2 && missed.every((m) => m.outcome === "NO_ANSWER" && m.direction === "INBOUND") && !!missed[0]!.followUpTaskId && !missed[1]!.followUpTaskId && (await db.task.count({ where: { assignedToUserId: rep.id, title: { contains: "missed call" } } })) === 1);
    ok("  audited, naming the phone", (await db.auditLog.count({ where: { entityId: k1.id, entityLabel: { contains: `via the Deskzo app on “${TAG} Pixel”` } } })) === 1);
    const again = await call("POST", "/calls/sync", { token, body: { calls: [{ key: "k1", number: `+91 ${num(1)}`, direction: "out", started_at: k1.startedAt.toISOString(), duration: 95 }] } });
    ok("sent again: the same call, not a second one", (again.body.data as { status: string; call_id: string }[])[0]?.status === "duplicate" && (again.body.data as { call_id: string }[])[0]?.call_id === k1.id && (await db.callLog.count({ where: { appDeviceId: phoneId } })) === 3);
    const malformed = await call("POST", "/calls/sync", { token, body: { calls: [{ key: "x", number: num(1), direction: "sideways", started_at: "yesterday", duration: -1 }] } });
    ok("a call that can't be one: refused, field by field", malformed.status === 400 && !!malformed.body.error?.fields, malformed.status);

    section("The after-call card");
    const review = await call("GET", "/calls/review", { token });
    const reviewRows = (review.body.data as { id: string; open_leads: { id: string }[] }[]) ?? [];
    ok("the calls waiting for a word, with the company's open leads to pick from", reviewRows.length === 3 && reviewRows.some((r) => r.id === k1.id && r.open_leads.some((l) => l.id === lead.id)));
    const noWhen = await call("PATCH", `/calls/${k1.id}`, { token, body: { outcome: "CALLBACK_REQUESTED", notes: "Wants a demo" } });
    ok("a callback without when: refused", noWhen.status === 422 && !!noWhen.body.error?.fields?.follow_up_at, noWhen.status);
    const elsewhere = await call("PATCH", `/calls/${k1.id}`, { token, body: { outcome: "CONNECTED", lead_id: otherLead.id } });
    ok("another company's lead: refused", elsewhere.status === 422, elsewhere.status);
    const when = new Date(Date.now() + 86_400_000).toISOString();
    const reviewed = await call("PATCH", `/calls/${k1.id}`, { token, body: { outcome: "CALLBACK_REQUESTED", notes: "Wants a demo", follow_up_at: when } });
    const k1After = await db.callLog.findUniqueOrThrow({ where: { id: k1.id }, include: { followUpTask: true } });
    ok("how it went, what was said, a callback with its task", reviewed.status === 200 && k1After.outcome === "CALLBACK_REQUESTED" && k1After.notes === "Wants a demo" && !!k1After.reviewedAt && k1After.followUpTask?.assignedToUserId === rep.id && k1After.followUpTask?.dueDate?.toISOString() === when);
    ok("  the lead's timeline says so", (await db.activity.findFirst({ where: { leadId: lead.id, occurredAt: k1.startedAt } }))?.notes === "callback requested — Wants a demo");
    ok("  and it no longer waits", !((await call("GET", "/calls/review", { token })).body.data as { id: string }[]).some((r) => r.id === k1.id));
    const othersCall = await db.callLog.create({ data: { companyId: theirs.id, phoneNumber: num(2), outcome: "CONNECTED", startedAt: new Date(), userId: other.id, source: "PHONE" } });
    ok("somebody else's call: not found", (await call("PATCH", `/calls/${othersCall.id}`, { token, body: { outcome: "BUSY" } })).status === 404);
    const callbacks = (await call("GET", "/calls/callbacks", { token })).body.data as { id: string }[];
    ok("the callbacks owed: the promise and the missed call", callbacks.some((c) => c.id === k1.id) && callbacks.some((c) => c.id === missed[0]!.id));

    section("Ring my phone");
    const pushed: unknown[] = [];
    push.setTestPush(async (message) => {
      pushed.push(message);
      return 200;
    });
    browserUser = { id: rep.id, name: rep.name, email: rep.email, role: "SALES" };
    ok("the call dialog finds the rep's phone", (await phoneCalls.myCallingPhone())?.id === phoneId);
    const ring = await phoneCalls.ringMyPhone({ companyId: company.id, contactId: ravi.id, phoneNumber: ravi.phone!, leadId: lead.id });
    ok("rung: a push to the phone with the number and who — nothing more", ring.ok && ring.data.pushed && JSON.stringify(pushed[0]) === JSON.stringify({ message: { token: "fcm-token-zzphone-0001", data: { type: "call", request: ring.ok ? ring.data.id : "", number: ravi.phone, label: `${TAG} Ravi, ${TAG} Acme` }, android: { priority: "HIGH", ttl: "120s" } } }));
    const handed = (await call("GET", "/calls/requests", { token })).body.data as { id: string; number: string }[];
    ok("  handed to the phone once", handed.length === 1 && handed[0]!.number === ravi.phone && ((await call("GET", "/calls/requests", { token })).body.data as unknown[]).length === 0);
    ok("  the dialog sees the phone has it", ring.ok && (await phoneCalls.ringState(ring.data.id)) === "TAKEN");
    // Nothing obvious left: the lead is no longer Ravi's, nor the rep's.
    await db.lead.update({ where: { id: lead.id }, data: { contactId: null, ownerUserId: other.id } });
    const rang = await call("POST", "/calls/sync", { token, body: { calls: [{ key: "k7", number: ravi.phone, direction: "out", started_at: new Date().toISOString(), duration: 12 }] } });
    const k7 = await db.callLog.findFirst({ where: { appDeviceId: phoneId, phoneCallKey: "k7" } });
    ok("the call comes back with what the dialog was about — its lead, though no longer obvious", (rang.body.data as { status: string }[])[0]?.status === "logged" && k7?.leadId === lead.id && ring.ok && (await phoneCalls.ringState(ring.data.id)) === "LOGGED");
    ok("a reseller's customer: not rung", !(await phoneCalls.ringMyPhone({ companyId: endCustomer.id, phoneNumber: num(3) })).ok);
    push.setTestPush(async () => 404);
    const gone = await phoneCalls.ringMyPhone({ companyId: company.id, contactId: ravi.id, phoneNumber: ravi.phone! });
    ok("a push address that no longer works: forgotten, and the ring waits for the app to look", gone.ok && !gone.data.pushed && (await db.appDevice.findUniqueOrThrow({ where: { id: phoneId } })).pushToken === null);
    push.setTestPush(null);
    browserUser = { id: other.id, name: other.name, email: other.email, role: "SALES" };
    ok("somebody without a phone: no button, and a ring is refused", (await phoneCalls.myCallingPhone()) === null && !(await phoneCalls.ringMyPhone({ companyId: theirs.id, phoneNumber: num(2) })).ok);

    section("Settings › Deskzo app");
    const item = SETTINGS_ITEMS.find((i) => i.key === "phone")!;
    process.env.DESKZO_APP = "";
    ok("not in the menu, and the page not there, until the app is out", !visibleSettingsKeys(["calls.view"], ["calls"]).includes("phone") && !!item);
    browserUser = { id: rep.id, name: rep.name, email: rep.email, role: "SALES" };
    const PhonePage = (require("../src/app/(dashboard)/settings/phone/page") as { default: () => Promise<unknown> }).default;
    ok("  the page answers 404", await PhonePage().then(() => false, (e: Error) => e.message === "notFound"));
    process.env.DESKZO_APP = "on";
    ok("out: in everybody's own settings, where Calls is theirs", visibleSettingsKeys([], ["calls"]).includes("phone") && !visibleSettingsKeys([], []).includes("phone"));
    const started = await deviceActions.startPhonePairing();
    ok("a code and its QR — the code spaced for typing, the QR carrying this workspace", started.ok && /^[2-9A-Z]{4} [2-9A-Z]{4} [2-9A-Z]{2}$/.test(started.data.code) && started.data.qr.startsWith("<svg"));
    const mine = await deviceActions.listMyPhones();
    ok("the rep's phones", mine.some((p) => p.id === phoneId && p.status === "APPROVED" && p.callSync && p.name === `${TAG} Pixel`));
    const page = await renderHtml((await PhonePage()) as never);
    ok("  the page renders them", page.includes(`${TAG} Pixel`) && page.includes("Show a pairing code"));
    browserUser = { id: other.id, name: other.name, email: other.email, role: "SALES" };
    ok("nobody signs out somebody else's phone", !(await deviceActions.signOutPhone(phoneId)).ok);

    section("Signing out");
    const second = await pairing.startPairing(rep.id);
    const secondToken = ((await call("POST", "/pair", { body: { code: second.code, platform: "ios", model: `${TAG} iPhone` } })).body.data as { token: string }).token;
    browserUser = { id: rep.id, name: rep.name, email: rep.email, role: "SALES" };
    ok("from Settings: that phone's token stops at once", (await deviceActions.signOutPhone(secondToken.slice(4, secondToken.indexOf(".")))).ok && (await call("GET", "/me", { token: secondToken })).status === 401);
    const out = await call("DELETE", "/device", { token });
    ok("from the phone itself: signed out, and its token stops", out.status === 200 && (await call("GET", "/me", { token })).status === 401 && (await db.userDevice.findUniqueOrThrow({ where: { id: phoneRow.deviceId } })).status === "REVOKED");
    await db.appCallRequest.count({ where: { appDeviceId: phoneId, status: "WAITING" } }).then((n) => ok("  and the rings waiting for it are dropped", n === 0, n));
  } finally {
    push.setTestPush(null);
    await cleanup();
  }
}

main()
  .then(async () => {
    await db.$disconnect();
    console.log(failures === 0 ? "\nAll Deskzo app calling checks passed." : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exit(1);
  });
