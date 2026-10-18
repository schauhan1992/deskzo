/**
 * check:public-api — the public API (src/lib/api, /api/v1/*) through its real route handlers, as a
 * person with a key, against this workspace's database.
 *
 *   · A key: made once, its secret never stored; malformed, wrong, unknown, revoked and expired keys all
 *     answered the same 401; too many wrong ones from one address locked out.
 *   · Its person: switched off, locked, the company locked, or on a network a rule blocks — refused.
 *   · Its scopes, its minute's rate, a module switched off.
 *   · Every documented operation (src/lib/api/openapi.ts) sent its own example and answering with the
 *     shape its example answer documents — so the documentation can't drift from the code.
 *   · What a key's person can't see is not found, as on the screens; what they change is audited with
 *     the key's name; a retry with the same Idempotency-Key is answered once.
 *   · The acting person is entered only by the handler, and sign-in answers with it before anything else.
 *   · /api/v1/leads still takes a website's capture key; Settings › Developers & API makes, lists and
 *     revokes keys for whoever may; the documentation pages and downloads render.
 *
 * Everything is named ZZAPI and removed at the end.
 *
 *   npm run check:public-api
 */
import "dotenv/config";
import { readFileSync, readdirSync, statSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";
import { renderHtml } from "./lib/render-html";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
process.env.TRUST_PROXY = "1";

const TAG = "ZZAPI";
const MAIL = "@zzapi.invalid";
let requestHeaders = new Headers({ host: "deskzo.localhost:3000", "user-agent": "check:public-api", "x-forwarded-for": "198.51.100.7" });
/** The person signed in to a browser, for the settings screens. */
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
  // Sign-in as src/lib/auth.ts answers it: a checked API call's person first, else the browser's.
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
const sameKeys = (a: unknown, b: unknown) => JSON.stringify(Object.keys((a ?? {}) as object).sort()) === JSON.stringify(Object.keys((b ?? {}) as object).sort());
const keyDiff = (a: unknown, b: unknown) => {
  const x = new Set(Object.keys((a ?? {}) as object));
  const y = new Set(Object.keys((b ?? {}) as object));
  return [...[...x].filter((k) => !y.has(k)).map((k) => `+${k}`), ...[...y].filter((k) => !x.has(k)).map((k) => `-${k}`)].join(" ");
};

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const companies = await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);
  const leads = await db.lead.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } });
  const tickets = await db.ticket.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } });
  const tasks = await db.task.findMany({ where: { OR: [{ companyId: { in: companyIds } }, { createdByUserId: { in: ids } }] }, select: { id: true } });
  const entityIds = [...companyIds, ...leads.map((l) => l.id), ...tickets.map((t) => t.id), ...tasks.map((t) => t.id)];
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: entityIds } }] } });
  await db.notification.deleteMany({ where: { OR: [{ userId: { in: ids } }, { title: { contains: TAG } }] } });
  await db.task.deleteMany({ where: { id: { in: tasks.map((t) => t.id) } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.leadCaptureKey.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.ipRule.deleteMany({ where: { label: { startsWith: TAG } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

/** /api/v1 paths to their route modules — as Next would route them. */
const ROUTES: [RegExp, string, string[]][] = [
  [/^\/me$/, "me", []],
  [/^\/openapi\.json$/, "openapi.json", []],
  [/^\/postman\.json$/, "postman.json", []],
  [/^\/companies$/, "companies", []],
  [/^\/companies\/([^/]+)$/, "companies/[ref]", ["ref"]],
  [/^\/contacts$/, "contacts", []],
  [/^\/contacts\/([^/]+)$/, "contacts/[ref]", ["ref"]],
  [/^\/leads$/, "leads", []],
  [/^\/leads\/([^/]+)$/, "leads/[ref]", ["ref"]],
  [/^\/leads\/([^/]+)\/stage$/, "leads/[ref]/stage", ["ref"]],
  [/^\/leads\/([^/]+)\/notes$/, "leads/[ref]/notes", ["ref"]],
  [/^\/tasks$/, "tasks", []],
  [/^\/tasks\/([^/]+)$/, "tasks/[id]", ["id"]],
  [/^\/tickets$/, "tickets", []],
  [/^\/tickets\/([^/]+)$/, "tickets/[ref]", ["ref"]],
  [/^\/tickets\/([^/]+)\/comments$/, "tickets/[ref]/comments", ["ref"]],
  [/^\/orders$/, "orders", []],
  [/^\/orders\/([^/]+)$/, "orders/[ref]", ["ref"]],
  [/^\/invoices$/, "invoices", []],
  [/^\/invoices\/([^/]+)$/, "invoices/[id]", ["id"]],
];

type Answer = { status: number; body: { data?: unknown; page?: Record<string, unknown>; error?: { code: string; message: string; fields?: Record<string, string> }; ok?: boolean }; headers: Headers };

async function call(method: string, pathAndQuery: string, opts: { token?: string | null; auth?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Answer> {
  const [pathOnly] = pathAndQuery.split("?");
  const route = ROUTES.find(([re]) => re.test(pathOnly!));
  if (!route) throw new Error(`no route for ${pathOnly}`);
  const [re, dir, names] = route;
  const match = re.exec(pathOnly!)!;
  const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(match[i + 1]!)]));
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const mod = require(`../src/app/api/v1/${dir}/route`) as Record<string, (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>>;
  const handler = mod[method];
  if (!handler) throw new Error(`${dir} has no ${method}`);
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.auth) headers.authorization = opts.auth;
  else if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  for (const [k, v] of requestHeaders) headers[k] ??= v;
  const req = new Request(`http://deskzo.localhost:3000/api/v1${pathAndQuery}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const res = await handler(req, { params: Promise.resolve(params) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {}, headers: res.headers };
}

/** Replaces the documented example references with this run's records, everywhere in a body. */
function withRefs<T>(value: T, refs: Record<string, string>): T {
  return JSON.parse(Object.entries(refs).reduce((json, [from, to]) => json.split(`"${from}"`).join(`"${to}"`), JSON.stringify(value))) as T;
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const keys = require("../src/lib/api/keys") as typeof import("../src/lib/api/keys");
  const openapi = require("../src/lib/api/openapi") as typeof import("../src/lib/api/openapi");
  const scopesLib = require("../src/lib/api/scopes") as typeof import("../src/lib/api/scopes");
  const lock = require("../src/lib/access/lock") as typeof import("../src/lib/access/lock");
  const { clearAccessCache } = require("../src/lib/access/gate") as typeof import("../src/lib/access/gate");
  const { canSeeCompany } = require("../src/lib/authz/company-scope") as typeof import("../src/lib/authz/company-scope");
  const { digestSecret } = require("../src/lib/crypto") as typeof import("../src/lib/crypto");
  const apiKeyActions = require("../src/actions/api-keys") as typeof import("../src/actions/api-keys");

  await cleanup();
  try {
    section("Who calls it");
    const boss = await db.user.create({ data: { name: `${TAG} Boss`, email: `boss${MAIL}`, role: "ADMIN", passwordHash: "x".repeat(60) } });
    const rep = await db.user.create({ data: { name: `${TAG} Rep`, email: `rep${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    const all = await keys.createApiKey(boss.id, { name: `${TAG} full`, scopes: [...scopesLib.API_SCOPE_KEYS] });
    const stored = await db.apiKey.findUniqueOrThrow({ where: { id: all.id } });
    ok("a key: dzk_….dzs_…, made once — its secret never stored, only a digest of it", /^dzk_[0-9a-f]{20}\.dzs_[A-Za-z0-9_-]{43}$/.test(all.token) && stored.secretDigest === (await digestSecret(all.token.split(".")[1]!)) && !JSON.stringify(stored).includes(all.token.split(".")[1]!));
    ok("  a key needs a name and something to touch", /Name the key/.test(await keys.createApiKey(boss.id, { name: "x", scopes: ["leads:read"] }).then(() => "", (e: Error) => e.message)) && /at least one/.test(await keys.createApiKey(boss.id, { name: `${TAG} none`, scopes: [] }).then(() => "", (e: Error) => e.message)));

    section("Keys that don't work: all the same 401");
    requestHeaders = new Headers({ host: "deskzo.localhost:3000", "user-agent": "check:public-api", "x-forwarded-for": "198.51.100.11" });
    const revoked = await keys.createApiKey(boss.id, { name: `${TAG} revoked`, scopes: ["leads:read"] });
    await db.apiKey.update({ where: { id: revoked.id }, data: { revokedAt: new Date() } });
    const expired = await keys.createApiKey(boss.id, { name: `${TAG} expired`, scopes: ["leads:read"], expiresAt: new Date(Date.now() + 60_000) });
    await db.apiKey.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const tries = [
      await call("GET", "/me"),
      await call("GET", "/me", { auth: "Bearer not-a-key" }),
      await call("GET", "/me", { token: `${all.token.split(".")[0]}.dzs_${"A".repeat(43)}` }),
      await call("GET", "/me", { token: `dzk_${"0".repeat(20)}.${all.token.split(".")[1]}` }),
      await call("GET", "/me", { token: revoked.token }),
      await call("GET", "/me", { token: expired.token }),
    ];
    ok("missing, malformed, a wrong secret, an unknown key, revoked, expired: one answer", tries.every((t) => t.status === 401) && new Set(tries.map((t) => JSON.stringify(t.body))).size === 1, tries.map((t) => t.status).join());
    for (let i = 0; i < 4; i += 1) await call("GET", "/me", { auth: "Bearer nope" });
    const lockedOut = await call("GET", "/me", { token: all.token });
    ok("  and too many from one address lock it out, a good key too", lockedOut.status === 429 && lockedOut.body.error?.code === "too_many_failures", lockedOut.status);
    requestHeaders = new Headers({ host: "deskzo.localhost:3000", "user-agent": "check:public-api", "x-forwarded-for": "198.51.100.7" });

    section("A key that works");
    const me = await call("GET", "/me", { token: all.token });
    ok("/me: the key and the person it acts as — the documented shape", me.status === 200 && (me.body.data as { person: { id: string } }).person.id === boss.id && sameKeys(me.body.data, openapi.EXAMPLES.me), keyDiff(me.body.data, openapi.EXAMPLES.me));
    ok("  with how many calls are left this minute", Number(me.headers.get("x-ratelimit-remaining")) === scopesLib.API_RATE_PER_MINUTE - 1, me.headers.get("x-ratelimit-remaining"));

    section("Its person, where they are");
    await db.user.update({ where: { id: boss.id }, data: { active: false } });
    ok("switched off: refused", (await call("GET", "/me", { token: all.token })).body.error?.code === "person_not_allowed");
    await db.user.update({ where: { id: boss.id }, data: { active: true, lockedAt: new Date() } });
    ok("locked: refused", (await call("GET", "/me", { token: all.token })).body.error?.code === "person_not_allowed");
    await db.user.update({ where: { id: boss.id }, data: { lockedAt: null } });
    lock.setTestCompanyLock({ enabled: true, until: null, message: null, lockedAt: new Date(), lockedById: null });
    ok("the company locked: refused", (await call("GET", "/me", { token: all.token })).body.error?.code === "person_not_allowed");
    lock.setTestCompanyLock(undefined);
    await db.ipRule.create({ data: { cidr: "198.51.100.0/24", action: "BLOCK", label: `${TAG} blocked`, roleKeys: [] } });
    clearAccessCache();
    ok("from a network a rule blocks: refused", (await call("GET", "/me", { token: all.token })).body.error?.code === "person_not_allowed");
    await db.ipRule.deleteMany({ where: { label: { startsWith: TAG } } });
    clearAccessCache();
    ok("  and back in when it's lifted", (await call("GET", "/me", { token: all.token })).status === 200);

    section("Scopes, rate, modules");
    const narrow = await keys.createApiKey(boss.id, { name: `${TAG} leads only`, scopes: ["leads:read"] });
    ok("a scope the key doesn't have: refused, naming it", (await call("GET", "/companies", { token: narrow.token })).body.error?.code === "insufficient_scope" && (await call("POST", "/leads", { token: narrow.token, body: {} })).body.error?.code === "insufficient_scope");
    await db.apiKey.update({ where: { id: narrow.id }, data: { windowStart: new Date(), windowCount: scopesLib.API_RATE_PER_MINUTE } });
    const limited = await call("GET", "/leads", { token: narrow.token });
    ok("past its minute's calls: 429, with when to try again", limited.status === 429 && limited.body.error?.code === "rate_limited" && limited.headers.get("retry-after") === "60");
    const helpdesk = await db.systemModule.findUnique({ where: { key: "helpdesk" } });
    await db.systemModule.upsert({ where: { key: "helpdesk" }, create: { key: "helpdesk", enabled: false }, update: { enabled: false } });
    const off = await call("GET", "/tickets", { token: all.token });
    if (helpdesk) await db.systemModule.update({ where: { key: "helpdesk" }, data: { enabled: helpdesk.enabled } });
    else await db.systemModule.delete({ where: { key: "helpdesk" } });
    ok("a module switched off: refused, saying so", off.status === 403 && off.body.error?.code === "module_unavailable", off.body.error?.message);

    section("Every documented operation, sent its own example");
    const done = new Set<string>();
    const op = (id: string) => openapi.API_OPERATIONS.find((o) => o.id === id)!;
    const asDocumented = (id: string, answer: Answer) => {
      const o = op(id);
      done.add(id);
      const expected = o.list ? openapi.listRowExample(o.example) : openapi.EXAMPLES[o.example];
      const got = o.list ? (answer.body.data as unknown[])[0] : answer.body.data;
      return answer.status === o.status && (got === undefined ? o.list === true : sameKeys(got, expected));
    };
    const detail = (a: Answer) => `${a.status} ${a.body.error?.message ?? ""} ${a.body.data && !Array.isArray(a.body.data) ? keyDiff(a.body.data, {}) : ""}`.slice(0, 300);

    const companyBody = { ...op("createCompany").bodyExample, name: `${TAG} Zenith Pharma Pvt Ltd` };
    const company = await call("POST", "/companies", { token: all.token, body: companyBody });
    const C = company.body.data as { id: string; ref: string; contacts: { ref: string }[] };
    ok("createCompany — 201, as documented, with its contact", asDocumented("createCompany", company) && C.contacts.length === 1, detail(company));
    const audit = await db.auditLog.findFirst({ where: { entityType: "Company", entityId: C.id }, orderBy: { createdAt: "desc" } });
    ok("  audited as the key's person, naming the key", audit?.userId === boss.id && audit.entityLabel.includes(`via API key “${TAG} full”`), audit?.entityLabel);
    const refs = { "COM-000123": C.ref, "CON-000456": C.contacts[0]!.ref };
    ok("getCompany", asDocumented("getCompany", await call("GET", `/companies/${C.ref}`, { token: all.token })));
    ok("listCompanies", asDocumented("listCompanies", await call("GET", `/companies?search=${TAG}`, { token: all.token })));
    const patched = await call("PATCH", `/companies/${C.ref}`, { token: all.token, body: op("updateCompany").bodyExample });
    ok("updateCompany — only what was sent changes", asDocumented("updateCompany", patched) && (patched.body.data as { website: string; name: string }).website === "https://zenith.example" && (patched.body.data as { name: string }).name === companyBody.name, detail(patched));

    const contact = await call("POST", "/contacts", { token: all.token, body: withRefs(op("createContact").bodyExample, refs) });
    ok("createContact", asDocumented("createContact", contact), detail(contact));
    const conRef = (contact.body.data as { ref: string }).ref;
    ok("getContact", asDocumented("getContact", await call("GET", `/contacts/${conRef}`, { token: all.token })));
    ok("listContacts", asDocumented("listContacts", await call("GET", `/contacts?search=${encodeURIComponent("Vikram")}`, { token: all.token })));
    ok("updateContact", asDocumented("updateContact", await call("PATCH", `/contacts/${conRef}`, { token: all.token, body: op("updateContact").bodyExample })));

    const lead = await call("POST", "/leads", { token: all.token, body: withRefs(op("createLead").bodyExample, refs) });
    ok("createLead — on the API's own address, shared with lead capture", asDocumented("createLead", lead), detail(lead));
    const L = lead.body.data as { id: string; ref: string };
    ok("getLead", asDocumented("getLead", await call("GET", `/leads/${L.ref}`, { token: all.token })));
    ok("listLeads", asDocumented("listLeads", await call("GET", `/leads?search=${encodeURIComponent("Microsoft 365 for 25")}`, { token: all.token })));
    const leadPatched = await call("PATCH", `/leads/${L.ref}`, { token: all.token, body: op("updateLead").bodyExample });
    ok("updateLead", asDocumented("updateLead", leadPatched) && (leadPatched.body.data as { value: number }).value === 175000, detail(leadPatched));
    const moved = await call("POST", `/leads/${L.ref}/stage`, { token: all.token, body: op("moveLead").bodyExample });
    ok("moveLead — by the stage's meaning", asDocumented("moveLead", moved) && (moved.body.data as { status: string }).status === "PROPOSAL_SENT", detail(moved));
    ok("noteLead", asDocumented("noteLead", await call("POST", `/leads/${L.ref}/notes`, { token: all.token, body: op("noteLead").bodyExample })));

    const idem = { "idempotency-key": `${TAG}-task-0001` };
    const task = await call("POST", "/tasks", { token: all.token, body: withRefs(op("createTask").bodyExample, refs), headers: idem });
    ok("createTask — with its checklist", asDocumented("createTask", task) && (task.body.data as { checklist: unknown[] }).checklist.length === 2, detail(task));
    const T = task.body.data as { id: string };
    const again = await call("POST", "/tasks", { token: all.token, body: withRefs(op("createTask").bodyExample, refs), headers: idem });
    ok("  sent again with the same Idempotency-Key: the first answer, nothing made twice", again.status === 201 && (again.body.data as { id: string }).id === T.id && again.headers.get("idempotent-replayed") === "true" && (await db.task.count({ where: { title: "Send the renewal quote", companyId: C.id } })) === 1);
    ok("  the same key for another request: refused", (await call("POST", "/tickets", { token: all.token, body: {}, headers: idem })).body.error?.code === "idempotency_key_reused");
    ok("getTask", asDocumented("getTask", await call("GET", `/tasks/${T.id}`, { token: all.token })));
    ok("listTasks", asDocumented("listTasks", await call("GET", `/tasks?search=${encodeURIComponent("renewal quote")}`, { token: all.token })));
    const taskMoved = await call("PATCH", `/tasks/${T.id}`, { token: all.token, body: op("updateTask").bodyExample });
    ok("updateTask", asDocumented("updateTask", taskMoved) && (taskMoved.body.data as { status: string }).status === "IN_PROGRESS", detail(taskMoved));

    const ticket = await call("POST", "/tickets", { token: all.token, body: withRefs(op("createTicket").bodyExample, refs) });
    ok("createTicket", asDocumented("createTicket", ticket), detail(ticket));
    const K = ticket.body.data as { ref: string };
    ok("getTicket", asDocumented("getTicket", await call("GET", `/tickets/${K.ref}`, { token: all.token })));
    ok("listTickets", asDocumented("listTickets", await call("GET", `/tickets?company=${C.ref}`, { token: all.token })));
    const ticketPatched = await call("PATCH", `/tickets/${K.ref}`, { token: all.token, body: op("updateTicket").bodyExample });
    ok("updateTicket", asDocumented("updateTicket", ticketPatched) && (ticketPatched.body.data as { priority: string }).priority === "URGENT", detail(ticketPatched));
    ok("commentTicket", asDocumented("commentTicket", await call("POST", `/tickets/${K.ref}/comments`, { token: all.token, body: op("commentTicket").bodyExample })));

    const orders = await call("GET", "/orders?page_size=1", { token: all.token });
    ok("listOrders", asDocumented("listOrders", orders), detail(orders));
    const anyOrder = (orders.body.data as { ref: string }[])[0];
    const oneOrder = anyOrder ? await call("GET", `/orders/${anyOrder.ref}`, { token: all.token }) : await call("GET", "/orders/ORD-999999999", { token: all.token });
    ok(anyOrder ? "getOrder" : "getOrder — none here to read: not found", anyOrder ? asDocumented("getOrder", oneOrder) : oneOrder.status === 404 && !!done.add("getOrder"), detail(oneOrder));
    ok("  never what we pay a vendor", !JSON.stringify(orders.body).match(/purchase|vendor/i));
    const invoices = await call("GET", "/invoices?page_size=1", { token: all.token });
    ok("listInvoices", asDocumented("listInvoices", invoices), detail(invoices));
    const anyInvoice = (invoices.body.data as { id: string }[])[0];
    const oneInvoice = anyInvoice ? await call("GET", `/invoices/${anyInvoice.id}`, { token: all.token }) : await call("GET", "/invoices/cm2k9x0aa0000nothing0000", { token: all.token });
    ok(anyInvoice ? "getInvoice — with its lines" : "getInvoice — none here to read: not found", anyInvoice ? asDocumented("getInvoice", oneInvoice) : oneInvoice.status === 404 && !!done.add("getInvoice"), detail(oneInvoice));
    done.add("me");
    const missed = openapi.API_OPERATIONS.filter((o) => !done.has(o.id)).map((o) => o.id);
    ok("every documented operation was sent", missed.length === 0, missed.join(", "));

    section("Refused the app's way");
    const noTitle = await call("POST", "/tasks", { token: all.token, body: { title: "x" } });
    ok("a body that isn't valid: 400, naming the field", noTitle.status === 400 && !!noTitle.body.error?.fields?.title);
    ok("  a field the API doesn't take: 400", (await call("POST", "/tasks", { token: all.token, body: { title: `${TAG} t`, colour: "red" } })).status === 400);
    ok("  a duplicate company name: 422, in the app's own words", (await call("POST", "/companies", { token: all.token, body: companyBody })).body.error?.code === "refused");
    ok("a reference to nothing: 404", (await call("GET", "/leads/LEAD-999999999", { token: all.token })).status === 404);

    section("A key acts as its person — and never as more");
    const repKey = await keys.createApiKey(rep.id, { name: `${TAG} rep`, scopes: ["companies:read", "leads:read"] });
    const repSees = await canSeeCompany(rep.id, await db.company.findUniqueOrThrow({ where: { id: C.id } }));
    const repCompany = await call("GET", `/companies/${C.ref}`, { token: repKey.token });
    ok(`the rep's key sees the boss's company exactly as the rep's screens would (${repSees ? "visible" : "not found"})`, repSees ? repCompany.status === 200 : repCompany.status === 404, repCompany.status);
    const repList = await call("GET", `/leads?search=${encodeURIComponent("Microsoft 365 for 25")}`, { token: repKey.token });
    ok("  and its lists hold only what reaches the rep", repSees || ((repList.body.data as unknown[]) ?? []).length === 0, (repList.body.data as unknown[])?.length);

    section("Only the handler makes somebody the acting person");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) files.push(full);
      }
    };
    walk(path.join(process.cwd(), "src"));
    const entering = files.filter((f) => readFileSync(f, "utf8").includes("runAsApiActor(")).map((f) => path.relative(process.cwd(), f).split(path.sep).join("/")).sort();
    // And the Deskzo app's handler, which checks a paired phone the same way (src/lib/app/handler.ts).
    ok("runAsApiActor is called in the two handlers that check a key or a phone, and nowhere else", JSON.stringify(entering) === JSON.stringify(["src/lib/api/handler.ts", "src/lib/app/handler.ts"]), entering.join(", "));
    const authSource = readFileSync(path.join(process.cwd(), "src/lib/auth.ts"), "utf8");
    const authFn = authSource.slice(authSource.indexOf("export async function auth()"));
    ok("sign-in answers with an API call's person before it reads a browser session", authFn.indexOf("apiActor()") > -1 && authFn.indexOf("apiActor()") < authFn.indexOf("nextAuth.auth()"));

    section("The lead capture API, on the same address");
    const capture = await db.leadCaptureKey.create({ data: { name: `${TAG} site`, keyId: "lck_0123456789abcdef0123", secretDigest: await digestSecret("lcs_zzapi-capture-secret-0001") } });
    void capture;
    const basic = `Basic ${Buffer.from("lck_0123456789abcdef0123:lcs_zzapi-capture-secret-0001").toString("base64")}`;
    const captured = await call("GET", "/leads", { auth: basic });
    ok("a website's Basic capture key still gets the capture API's answer", captured.status === 200 && captured.body.ok === true, JSON.stringify(captured.body));

    section("Settings › Developers & API");
    browserUser = { id: rep.id, name: rep.name, email: rep.email, role: "SALES" };
    ok("somebody without “Make API keys”: nothing", (await apiKeyActions.listApiKeys()) === null && !(await apiKeyActions.makeApiKey({ name: `${TAG} x`, scopes: ["leads:read"], expiresInDays: null })).ok);
    const SettingsPage = (require("../src/app/(dashboard)/settings/developers/page") as { default: () => Promise<unknown> }).default;
    ok("  and the page is not found", await SettingsPage().then(() => false, (e: Error) => e.message === "notFound"));
    browserUser = { id: boss.id, name: boss.name, email: boss.email, role: "ADMIN" };
    const madeHere = await apiKeyActions.makeApiKey({ name: `${TAG} made here`, scopes: ["tasks:read"], expiresInDays: 90 });
    ok("an admin makes a key: its token shown once", madeHere.ok && /^dzk_/.test(madeHere.data.token));
    const listed = await apiKeyActions.listApiKeys();
    ok("  and lists their keys, never a secret", !!listed?.keys.some((k) => k.name === `${TAG} made here` && k.expiresAt) && !JSON.stringify(listed).includes(madeHere.ok ? madeHere.data.token.split(".")[1]! : "zz"));
    const repKeyRow = await db.apiKey.findUniqueOrThrow({ where: { id: repKey.id } });
    browserUser = { id: rep.id, name: rep.name, email: rep.email, role: "SALES" };
    ok("  somebody else can't revoke it", !(await apiKeyActions.revokeApiKey(madeHere.ok ? (await db.apiKey.findUniqueOrThrow({ where: { keyId: madeHere.data.keyId } })).id : "")).ok);
    browserUser = { id: boss.id, name: boss.name, email: boss.email, role: "ADMIN" };
    ok("an admin, who looks after security, may revoke anybody's", (await apiKeyActions.revokeApiKey(repKeyRow.id)).ok && (await call("GET", "/me", { token: repKey.token })).status === 401);
    const page = await renderHtml((await SettingsPage()) as never);
    ok("  the page renders the keys and where the documentation is", page.includes(`${TAG} made here`) && page.includes("/api/v1/openapi.json") && page.includes("/developers"));

    section("The documentation");
    const doc = openapi.openApiDocument("http://deskzo.localhost:3000") as { openapi: string; paths: Record<string, Record<string, unknown>>; servers: { url: string }[]; components: { schemas: Record<string, { properties?: Record<string, unknown> }> } };
    ok("OpenAPI 3.1: every operation, at this workspace's address", doc.openapi === "3.1.0" && doc.servers[0]!.url === "http://deskzo.localhost:3000/api/v1" && openapi.API_OPERATIONS.every((o) => !!doc.paths[o.path]?.[o.method.toLowerCase()]));
    ok("  its request bodies are the endpoints' own schemas", Object.keys(doc.components.schemas.createLeadBody?.properties ?? {}).sort().join() === Object.keys(require("../src/lib/api/v1/schemas").leadCreateSchema.shape).sort().join());
    const served = await call("GET", "/openapi.json");
    ok("  served for download without a key", served.status === 200 && (served.body as unknown as { openapi: string }).openapi === "3.1.0");
    const postman = await call("GET", "/postman.json");
    const items = ((postman.body as unknown as { item: { item: unknown[] }[] }).item ?? []).flatMap((f) => f.item);
    ok("the Postman collection: every operation, the key a variable left empty", items.length === openapi.API_OPERATIONS.length && JSON.stringify(postman.body).includes('"key":"apiKey","value":""'));
    const DevelopersPage = (require("../src/app/platform-site/developers/page") as { default: () => unknown }).default;
    const devHtml = (await renderHtml(DevelopersPage() as never)).replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
    ok("deskzo.com/developers: every operation, its scope and an example", openapi.API_OPERATIONS.every((o) => devHtml.includes(o.summary)) && devHtml.includes("leads:write") && devHtml.includes("Idempotency-Key"));
  } finally {
    lock.setTestCompanyLock(undefined);
    browserUser = null;
    await cleanup();
  }
  console.log(failures === 0 ? "\nAll public API checks passed." : `\n${failures} public API check(s) FAILED.`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
