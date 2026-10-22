/**
 * check:app-sales — the Deskzo app's sales screens (src/lib/app/sales.ts; /api/app/leads, companies, contacts,
 * pipelines, search) through their real route handlers, as paired phones, against this workspace's database
 * (owner, 22 Oct 2026 — the app made native, sales first).
 *
 *   · /me says the sales screens are open, and hands over the web's menu for the More tab.
 *   · A customer added from the phone, its duplicate refused by the web's own rule; a contact added to it.
 *   · The pipelines and their stages; a lead added on the customer, owned by the person; its history; a call
 *     logged; moved to the next stage; its title changed — each through the public API's own operations.
 *   · The customer's page: its contacts, the open lead, the call just logged.
 *   · Search finds the lead, the customer and the contact.
 *   · Lists say where they are (page, page size, total).
 *   · Another salesperson sees none of it, and opening it by id answers 404 as a lead that isn't there does.
 *   · A notification reaches the person's phone — its title and link only — unless they muted the kind; an
 *     address Firebase no longer knows is forgotten (Firebase itself stood in for).
 *
 * Everything is named ZZAPPSALES and removed at the end.
 *
 *   npm run check:app-sales
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
process.env.TRUST_PROXY = "1";
process.env.DESKZO_APP = "on";

const TAG = "ZZAPPSALES";
const MAIL = "@zzappsales.invalid";
const requestHeaders = new Headers({ host: "deskzo.localhost:3000", "user-agent": "check:app-sales", "x-forwarded-for": "198.51.100.61" });

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
  // Sign-in as src/lib/auth.ts answers it: the phone's person inside a checked call, nobody outside one.
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

async function cleanup() {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  const leads = (await db.lead.findMany({ where: { companyId: { in: companies } }, select: { id: true } })).map((l) => l.id);
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: [...companies, ...leads] } }] } });
  await db.activityLog.deleteMany({ where: { userId: { in: ids } } });
  await db.notification.deleteMany({ where: { OR: [{ userId: { in: ids } }, { title: { contains: TAG } }] } });
  await db.notificationPreference.deleteMany({ where: { userId: { in: ids } } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

const ROUTES: [RegExp, string, string[]][] = [
  [/^\/me$/, "me", []],
  [/^\/leads$/, "leads", []],
  [/^\/leads\/([^/]+)\/stage$/, "leads/[ref]/stage", ["ref"]],
  [/^\/leads\/([^/]+)\/notes$/, "leads/[ref]/notes", ["ref"]],
  [/^\/leads\/([^/]+)$/, "leads/[ref]", ["ref"]],
  [/^\/pipelines$/, "pipelines", []],
  [/^\/companies$/, "companies", []],
  [/^\/companies\/([^/]+)$/, "companies/[ref]", ["ref"]],
  [/^\/contacts$/, "contacts", []],
  [/^\/contacts\/([^/]+)$/, "contacts/[ref]", ["ref"]],
  [/^\/search$/, "search", []],
  [/^\/device$/, "device", []],
];

type Answer<T = unknown> = { status: number; data: T; page?: { page: number; page_size: number; total: number; has_more: boolean }; error?: { code: string; message: string; fields?: Record<string, string> } };

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
  const parsed = text ? JSON.parse(text) : {};
  return { status: res.status, data: parsed.data as T, page: parsed.page, error: parsed.error };
}

type Ref = { id: string; ref: string; name?: string };
type Stage = { id: string; key: string; name: string; status: string; required_fields: string[] };
type Lead = Ref & {
  title: string;
  status: string;
  stage: { id: string; key: string; name: string } | null;
  pipeline: { id: string } | null;
  company: Ref | null;
  contact: (Ref & { phone?: string | null }) | null;
  owner: { id: string } | null;
  activities?: { type: string; notes: string; by: { id: string } | null }[];
  stages?: Stage[];
};
type Company = Ref & {
  name: string;
  contacts: (Ref & { phone: string | null })[];
  open_leads: { id: string; title: string }[];
  activities: { type: string; notes: string; lead?: { id: string } }[];
};

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const pairing = require("../src/lib/app/pairing") as typeof import("../src/lib/app/pairing");
  const { moduleAvailableForTenant } = require("../src/lib/modules-access") as typeof import("../src/lib/modules-access");
  const push = require("../src/lib/app/push") as typeof import("../src/lib/app/push");
  const notify = require("../src/lib/notify") as typeof import("../src/lib/notify");
  /* eslint-enable @typescript-eslint/no-require-imports */

  await cleanup();
  try {
    for (const key of ["leads", "companies", "contacts_library"]) {
      if (!(await moduleAvailableForTenant(key))) {
        ok(`${key} is in this workspace's plan and switched on — the suite needs it`, false);
        return;
      }
    }

    section("The people and their phones");
    const seller = await db.user.create({ data: { name: `${TAG} Seller`, email: `seller${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    const other = await db.user.create({ data: { name: `${TAG} Other`, email: `other${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    const pair = async (userId: string, model: string) => {
      const code = await pairing.startPairing(userId);
      /* eslint-disable-next-line @typescript-eslint/no-require-imports */
      const mod = require("../src/app/api/app/pair/route") as { POST: (req: Request) => Promise<Response> };
      const res = await mod.POST(new Request("http://deskzo.localhost:3000/api/app/pair", { method: "POST", headers: { ...Object.fromEntries(requestHeaders), "content-type": "application/json" }, body: JSON.stringify({ code: code.code, platform: "android", model }) }));
      return ((await res.json()) as { data: { token: string } }).data.token;
    };
    const phone = await pair(seller.id, `${TAG} seller phone`);
    const otherPhone = await pair(other.id, `${TAG} other phone`);
    ok("two salespeople, both phones paired", phone.startsWith("dzp_") && otherPhone.startsWith("dzp_"));

    const me = await call<{ can: Record<string, boolean>; modules: { group: string; items: { label: string; href: string }[] }[] }>(phone, "GET", "/me");
    ok("/me: leads, companies and contacts open to a salesperson", me.status === 200 && me.data.can.leads === true && me.data.can.companies === true && me.data.can.contacts === true, json(me.data?.can));
    const hrefs = (me.data?.modules ?? []).flatMap((s) => s.items.map((i) => i.href));
    ok("  and the web's menu for the More tab, Leads in it", hrefs.includes("/leads") && (me.data?.modules ?? []).every((s) => typeof s.group === "string" && s.items.length > 0), hrefs.slice(0, 8).join(" "));

    section("A customer and a contact");
    const made = await call<Company>(phone, "POST", "/companies", { name: `${TAG} Acme Systems`, relationship_type: "CLIENT", address: { city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" } });
    ok("a customer added from the phone", made.status === 201 && made.data.ref.startsWith("COM-"), made.error?.message ?? made.status);
    const twice = await call(phone, "POST", "/companies", { name: `${TAG} Acme Systems` });
    ok("  the same name again: the web's own refusal", twice.status === 422, `${twice.status} ${twice.error?.message}`);
    const contact = await call<Ref & { phone: string }>(phone, "POST", "/contacts", { company: made.data.ref, name: `${TAG} Ravi Kumar`, designation: "IT_HEAD", phone: "+91 90000 11111", email: "ravi@zzappsales.invalid" });
    ok("a contact added to it", contact.status === 201 && contact.data.ref.startsWith("CON-") && contact.data.phone === "+91 90000 11111", contact.error?.message ?? contact.status);
    const read = await call(phone, "GET", `/contacts/${contact.data.ref}`);
    ok("  and read back by its ref", read.status === 200);

    section("Pipelines and a lead");
    const pipes = await call<{ pipelines: { id: string; key: string; stages: Stage[] }[]; sources: { value: string }[]; activity_types: { value: string }[] }>(phone, "GET", "/pipelines");
    const main = pipes.data?.pipelines.find((p) => p.stages.length > 1);
    ok("the pipelines with their stages, the sources and the kinds of activity", pipes.status === 200 && !!main && pipes.data.sources.some((s) => s.value === "WALK_IN") && pipes.data.activity_types.length === 4, pipes.error?.message ?? main?.key);

    const lead = await call<Lead>(phone, "POST", "/leads", { company: made.data.ref, contact: contact.data.ref, title: `${TAG} 25 laptops`, value: 1_250_000, owner: seller.id, source: "WALK_IN", pipeline: main?.id });
    ok("a lead on the customer, owned by the person who added it", lead.status === 201 && lead.data.owner?.id === seller.id && lead.data.company?.id === made.data.id, lead.error?.message ?? lead.status);
    const detail = await call<Lead>(phone, "GET", `/leads/${lead.data.ref}`);
    ok("its page: the contact's number to ring, its pipeline's stages, its history", detail.status === 200 && detail.data.contact?.phone === "+91 90000 11111" && (detail.data.stages?.length ?? 0) > 1 && Array.isArray(detail.data.activities), detail.error?.message ?? json(detail.data?.contact));

    const plain = await call<Lead>(phone, "POST", "/leads", { company: made.data.ref, title: `${TAG} 2 printers`, owner: seller.id });
    const plainPage = await call<Lead>(phone, "GET", `/leads/${plain.data.ref}`);
    ok("a lead in the main pipeline (it names none) still has the main one's stages to move to", plain.status === 201 && (plainPage.data.stages?.length ?? 0) > 1, plainPage.data?.stages?.length ?? plain.error?.message);

    const logged = await call(phone, "POST", `/leads/${lead.data.ref}/notes`, { type: "CALL", notes: `${TAG} spoke to Ravi, wants a quote by Friday` });
    ok("a call logged on it", logged.status === 201, logged.error?.message ?? logged.status);
    const after = await call<Lead>(phone, "GET", `/leads/${lead.data.ref}`);
    ok("  and it's in the lead's history, by the person", !!after.data.activities?.some((a) => a.type === "CALL" && a.notes.includes("quote by Friday") && a.by?.id === seller.id), json(after.data.activities?.slice(0, 2)));

    const stages = after.data.stages ?? [];
    const here = stages.findIndex((s) => s.id === after.data.stage?.id);
    const next = stages.slice(here + 1).find((s) => s.status === "OPEN" || s.status === "QUALIFIED" || (s.required_fields.length === 0 && !["WON", "LOST", "DISQUALIFIED"].includes(s.status)));
    if (next) {
      const moved = await call<Lead>(phone, "POST", `/leads/${lead.data.ref}/stage`, { stage: next.id });
      ok(`moved on to "${next.name}"`, moved.status === 200 && moved.data.stage?.id === next.id, moved.error?.message ?? moved.status);
    } else {
      ok("a next stage with no rule to move to", false, stages.map((s) => s.key).join(","));
    }
    const renamed = await call<Lead>(phone, "PATCH", `/leads/${lead.data.ref}`, { title: `${TAG} 30 laptops` });
    ok("its title changed", renamed.status === 200 && renamed.data.title === `${TAG} 30 laptops`, renamed.error?.message ?? renamed.status);

    section("The customer's page");
    const page = await call<Company>(phone, "GET", `/companies/${made.data.ref}`);
    ok("its contact, the open lead and the call just logged", page.status === 200 && page.data.contacts.some((c) => c.id === contact.data.id) && page.data.open_leads.some((l) => l.id === lead.data.id) && page.data.activities.some((a) => a.type === "CALL" && a.lead?.id === lead.data.id), page.error?.message ?? json({ c: page.data?.contacts?.length, l: page.data?.open_leads?.length, a: page.data?.activities?.length }));

    section("Lists and search");
    const leads = await call<Lead[]>(phone, "GET", `/leads?view=mine&search=${TAG}`);
    ok("my leads: the one just added, and where the list is", leads.status === 200 && leads.data.some((l) => l.id === lead.data.id) && leads.page?.page === 1 && leads.page.page_size === 25 && leads.page.total >= 1, json(leads.page));
    const customers = await call<Company[]>(phone, "GET", `/companies?search=${TAG}`);
    ok("companies: the one just added, a prospect", customers.status === 200 && customers.data.some((c) => c.id === made.data.id), customers.error?.message ?? customers.data?.length);
    ok("  a stage that isn't one: refused", (await call(phone, "GET", "/companies?stage=VENDORISH")).status === 400);
    const contacts = await call<Ref[]>(phone, "GET", `/contacts?search=${TAG}`);
    ok("contacts: the one just added", contacts.status === 200 && contacts.data.some((c) => c.id === contact.data.id), contacts.error?.message ?? contacts.data?.length);
    const found = await call<{ results: { kind: string; id: string }[] }>(phone, "GET", `/search?q=${TAG}`);
    const kinds = new Set(found.data?.results.map((r) => r.kind));
    ok("search finds the lead, the company and the contact", found.status === 200 && kinds.has("lead") && kinds.has("company") && kinds.has("contact"), json([...kinds]));
    ok("  and a one-letter search finds nothing yet", (await call<{ results: unknown[] }>(phone, "GET", "/search?q=Z")).data.results.length === 0);

    section("Another salesperson");
    const theirs = await call<Lead[]>(otherPhone, "GET", `/leads?search=${TAG}`);
    ok("doesn't see the lead in their list", theirs.status === 200 && !theirs.data.some((l) => l.id === lead.data.id), theirs.data?.length);
    const opened = await call(otherPhone, "GET", `/leads/${lead.data.id}`);
    const ghost = await call(otherPhone, "GET", "/leads/LEAD-999999999");
    ok("opening it by id answers as a lead that isn't there does", opened.status === 404 && ghost.status === 404 && opened.error?.message === ghost.error?.message, `${opened.status} ${opened.error?.message}`);
    const theirCustomer = await call(otherPhone, "GET", `/companies/${made.data.id}`);
    ok("nor the company", theirCustomer.status === 404, theirCustomer.status);
    const theirSearch = await call<{ results: { id: string }[] }>(otherPhone, "GET", `/search?q=${TAG}`);
    ok("nor finds any of it", theirSearch.status === 200 && !theirSearch.data.results.some((r) => [lead.data.id, made.data.id, contact.data.id].includes(r.id)), json(theirSearch.data?.results));

    section("Notifications on the phone");
    const sent: { message: { token: string; data: Record<string, string> } }[] = [];
    let firebaseSays = 200;
    push.setTestPush(async (message) => (sent.push(message as (typeof sent)[number]), firebaseSays));
    const token = "fcm-zzappsales-0123456789";
    const registered = await call<{ push: boolean }>(phone, "PATCH", "/device", { push_token: token });
    ok("the phone gives its push address", registered.status === 200 && registered.data.push === true, registered.error?.message ?? registered.status);
    await notify.notifyUser({ userId: seller.id, type: "LEAD_ASSIGNED", title: `${TAG} A lead for you: 30 laptops`, message: "Customer's private notes, never pushed", link: `/leads/${lead.data.ref}` });
    const got = sent.at(-1)?.message;
    ok(
      "a notification reaches it: the title and where it leads, nothing behind it",
      sent.length === 1 && got?.token === token && got.data.type === "notice" && got.data.title === `${TAG} A lead for you: 30 laptops` && got.data.link === `/leads/${lead.data.ref}` && !JSON.stringify(got).includes("private notes"),
      json(got),
    );
    await notify.notifyUser({ userId: other.id, type: "LEAD_ASSIGNED", title: `${TAG} for the other one` });
    ok("  another person's goes to nobody's phone here (theirs has no push address)", sent.length === 1);
    await db.notificationPreference.create({ data: { userId: seller.id, type: "LEAD_STATUS_CHANGED", inApp: false, email: false } });
    await notify.notifyUser({ userId: seller.id, type: "LEAD_STATUS_CHANGED", title: `${TAG} muted` });
    ok("  a kind they muted in their bell isn't pushed either", sent.length === 1);
    firebaseSays = 404;
    await notify.notifyUser({ userId: seller.id, type: "LEAD_ASSIGNED", title: `${TAG} after uninstalling` });
    const forgotten = await db.appDevice.findFirst({ where: { userId: seller.id }, select: { pushToken: true } });
    ok("an address Firebase no longer knows is forgotten", sent.length === 2 && forgotten?.pushToken === null, forgotten?.pushToken);
    push.setTestPush(null);
  } finally {
    await cleanup();
  }

  console.log(failures === 0 ? "\nAll app sales checks passed." : `\n${failures} app sales check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
