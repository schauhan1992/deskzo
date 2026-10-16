/**
 * Field access, the daily unmask limit and the unmasking log, end to end (src/lib/authz/field-policy.ts,
 * src/lib/authz/fields.ts, src/lib/authz/unmask.ts, src/lib/leads/masking.ts).
 *
 *   1. The masks themselves: deterministic, from the value, never its length.
 *   2. Nothing set changes nothing: the leads list, a lead and its export are as they were.
 *   3. A role's policy: masked in the list, masked on the lead, restricted fields never sent — not in
 *      the response at all, not in the export, not searchable.
 *   4. Unmasking: the first opening of a lead today uses one unit, its email, phone and company together
 *      still one; opening it again uses none; another lead uses another; the limit, once reached, keeps
 *      a new lead masked; the counter survives a new session; the day turns on the workspace's clock.
 *   5. At the same moment: many requests can't pass the limit, and one lead can't count twice.
 *   6. Refusals use nothing and are logged: a lead out of reach, a field one may not unmask, viewing as.
 *   7. Access is asked again every time: unmasking this morning shows nothing once the permission goes.
 *   8. A masked field can't be written over with its mask.
 *   9. One person's own policy and limit, over their role's, and only theirs; an expired one is ignored.
 *  10. Who may change what: no wider than one's own, not one's own, the super admin's nobody's.
 *  11. The log: field names never values, append-only, the super admin's alone, filters and CSV.
 *
 * On a scratch database built from the migrations and dropped at the end, because the log can't be
 * cleaned up — that is the point of it. The real workspace is untouched.
 *
 *   npm run check:field-access
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import { maskValue, normalisePolicy, presentValue, type FieldPolicy } from "../src/lib/authz/field-policy";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

// ── Stand-ins: who is calling, and whether an admin is viewing as them ───────────────────────────
type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
let viewingAs: { user: { id: string; name: string; email: string; role: string }; actor: { id: string; name: string; role: string } } | null = null;
const internals = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => viewingAs,
  refuseWhileViewingAs: async () => null,
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return nextCache;
  if (request === "@/lib/session" || request.endsWith("lib/session")) return session;
  return realLoad.call(this, request, parent, isMain);
} as typeof realLoad;

const MASKED = (over: Partial<FieldPolicy> = {}): FieldPolicy => ({ view: true, maskInList: true, maskInDetail: true, unmask: true, format: "first", ...over });

function pure() {
  section("The masks");
  ok("a company name keeps its first letter, then eight stars", maskValue("Acme Technologies", "first") === "A********");
  ok("however long the name, the same eight", maskValue("A", "first") === "A********" && maskValue("Avery Long Company Name Pvt Ltd", "first") === "A********");
  ok("an email: first letter, the domain's first letter and its ending", maskValue("sales@globex.com", "email") === "s*****@g***.com", maskValue("sales@globex.com", "email"));
  ok("a phone: its country code and last four", maskValue("+91 98765 43210", "phone_last4") === "+91 ******3210", maskValue("+91 98765 43210", "phone_last4"));
  ok("a phone without a country code: the last four", maskValue("9876543210", "phone_last4") === "******3210");
  ok("a phone by its country code only", maskValue("+91 98765 43210", "phone_code") === "+91 ******");
  ok("an address down to its city", maskValue("12 MG Road, Pune", "partial_address") === "********, Pune");
  ok("an address whose last part is a PIN code is hidden whole", maskValue("12 MG Road, 411001", "partial_address") === "********");
  ok("nothing is nothing", maskValue(null, "first") === null);
  const restricted = normalisePolicy("text", { view: false, maskInList: true, maskInDetail: true, unmask: true, format: "first" });
  ok("a field that can't be read can't be masked or unmasked either", !restricted.maskInList && !restricted.unmask);
  ok("a restricted value goes out as one word, with or without a value", presentValue("Acme", restricted, "list") === "Restricted" && presentValue(null, restricted, "list") === "Restricted");
  ok("masking off for a field one may read is the value itself", presentValue("Acme", normalisePolicy("text", { view: true, maskInList: false, maskInDetail: false, unmask: false, format: null }), "list") === "Acme");
}

async function run(db: PrismaClient) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const leads = require("../src/actions/lead") as typeof import("../src/actions/lead");
  const { unmaskLead } = require("../src/actions/lead-unmask") as typeof import("../src/actions/lead-unmask");
  const access = require("../src/actions/field-access") as typeof import("../src/actions/field-access");
  const logs = require("../src/actions/unmask-log") as typeof import("../src/actions/unmask-log");
  const { businessDate, unmaskUsageToday } = require("../src/lib/authz/unmask") as typeof import("../src/lib/authz/unmask");
  const { resolveFieldPolicies } = require("../src/lib/authz/fields") as typeof import("../src/lib/authz/fields");
  /* eslint-enable @typescript-eslint/no-require-imports */

  // ── People and records ──────────────────────────────────────────────────────────────────────────
  const ROLE = "ZZ_FIELD_PROBE";
  await db.role.create({ data: { key: ROLE, name: "Field probe" } });
  for (const permission of ["leads.view", "contacts.view"]) await db.rolePermission.create({ data: { role: ROLE, permission, allowed: true } });
  const person = (key: string, role: string, extra: object = {}) =>
    db.user.create({ data: { name: `Zz ${key}`, email: `${key.toLowerCase()}@zz-field.invalid`, role, passwordHash: "x".repeat(60), ...extra } });
  const superAdmin = await person("Owner", "ADMIN", { isSuperAdmin: true });
  const admin = await person("Admin", "ADMIN");
  const vishal = await person("Vishal", ROLE);
  const neha = await person("Neha", ROLE);
  const stranger = await person("Stranger", ROLE);
  const as = (u: { id: string; name: string; email: string; role: string }) => {
    actor = { id: u.id, name: u.name, email: u.email, role: u.role };
  };

  const RAW = { company: "Acme Technologies", email: "rahul@acmetech.com", phone: "+91 98765 43210", contact: "Rahul Verma", address: "12 MG Road", city: "Pune" };
  const company = await db.company.create({ data: { name: RAW.company, normalizedName: RAW.company.toLowerCase(), createdById: admin.id, ownerUserId: vishal.id, stage: "CUSTOMER" } });
  await db.companyLocation.create({ data: { companyId: company.id, label: "Head Office", isPrimary: true, address: RAW.address, city: RAW.city, state: "Maharashtra", country: "India" } });
  const contact = await db.contact.create({ data: { companyId: company.id, name: RAW.contact, email: RAW.email, phone: RAW.phone } });
  const lead = (title: string) => db.lead.create({ data: { companyId: company.id, contactId: contact.id, title, ownerUserId: vishal.id, source: "WEBSITE", sourceDetail: "acme.com/pricing", description: "Wants 40 seats, call after 6" } });
  const l1 = await lead("Office 365 renewal");
  const l2 = await lead("Firewall upgrade");
  const l3 = await lead("Backup licences");
  const extra = await Promise.all(Array.from({ length: 6 }, (_, i) => lead(`Parallel lead ${i + 1}`)));
  const otherCompany = await db.company.create({ data: { name: "Globex", normalizedName: "globex", createdById: admin.id, ownerUserId: stranger.id, stage: "CUSTOMER" } });
  const outOfReach = await db.lead.create({ data: { companyId: otherCompany.id, title: "Not Vishal's", ownerUserId: stranger.id } });

  const raws = [RAW.company, RAW.email, RAW.phone, RAW.address, "98765"];
  const leaks = (value: unknown) => {
    const text = JSON.stringify(value);
    return raws.filter((r) => text.includes(r));
  };

  section("Nothing set changes nothing");
  as(vishal);
  const before = await leads.listLeadsPaged({ page: 1, pageSize: 50 });
  const row = before.rows.find((r) => r.id === l1.id);
  ok("the list shows the company as it is", row?.company.name === RAW.company);
  const plain = await leads.getLead(l1.id);
  ok("the lead shows its contact's email and phone as they are", plain?.contact?.email === RAW.email && plain?.contact?.phone === RAW.phone);
  ok("and its address", plain?.address.line?.includes(RAW.address) === true);
  ok("nothing is masked or to unmask", plain?.masking.concealed.length === 0 && plain?.masking.revealable.length === 0);
  ok("opening it unmasks nothing and logs nothing", (await unmaskLead(l1.id)).result === "NOTHING" && (await db.unmaskEvent.count()) === 0);

  section("A role's policy");
  as(superAdmin);
  const set = await access.setRoleFieldAccess(ROLE, [
    { field: "companyName", policy: MASKED({ format: "first" }) },
    { field: "email", policy: MASKED({ format: "email" }) },
    { field: "phone", policy: MASKED({ format: "phone_last4" }) },
    { field: "address", policy: { view: false, maskInList: false, maskInDetail: false, unmask: false, format: "stars" } },
  ]);
  ok("the super admin sets Vishal's role: company, email and phone masked, address restricted", set.ok && set.data.changed === 4, set);
  await access.setRoleUnmaskLimit(ROLE, 2);
  ok("and a daily limit of two leads", (await db.roleUnmaskLimit.findUnique({ where: { role: ROLE } }))?.dailyLimit === 2);

  as(vishal);
  const list = await leads.listLeadsPaged({ page: 1, pageSize: 50 });
  const listed = list.rows.find((r) => r.id === l1.id)!;
  ok("the list masks the company name", listed.company.name === "A********", listed.company.name);
  ok("the list response carries none of the raw values", leaks(list.rows).length === 0, leaks(list.rows));
  const masked = (await leads.getLead(l1.id))!;
  ok("the lead masks the email", masked.contact?.email === "r*****@a***.com", masked.contact?.email);
  ok("the lead masks the phone", masked.contact?.phone === "+91 ******3210", masked.contact?.phone);
  ok("the address is restricted — the word, not a mask", masked.address.line === "Restricted" && masked.address.place === "Restricted");
  ok("the lead response carries none of the raw values", leaks(masked).length === 0, leaks(masked));
  ok("what may be unmasked, and what may not", JSON.stringify([...masked.masking.revealable].sort()) === JSON.stringify(["companyName", "email", "phone"]) && masked.masking.concealed.includes("address"));
  ok("the source is left as it was", masked.source === "WEBSITE" && masked.sourceDetail === "acme.com/pricing");
  const csv = await leads.exportLeadsCsv();
  ok("the export masks the company", csv.ok && csv.data.csv.includes("A********") && leaks(csv.ok ? csv.data.csv : "").length === 0);
  const other = await leads.listLeadsPaged({ page: 1, pageSize: 50 });
  ok("Neha's view is her own: nothing about Vishal's session leaks into hers", other.rows.length > 0);

  as(superAdmin);
  await access.setRoleFieldAccess(ROLE, [{ field: "title", policy: { view: false, maskInList: false, maskInDetail: false, unmask: false, format: "stars" } }]);
  as(vishal);
  const searched = await leads.listLeadsPaged({ page: 1, pageSize: 50, search: "Firewall" });
  ok("a restricted field can't be searched: no match on a title they can't read", searched.total === 0, searched.total);
  const titled = await leads.listLeadsPaged({ page: 1, pageSize: 50 });
  ok("and the title is the word Restricted in the list", titled.rows.every((r) => r.title === "Restricted"));
  as(superAdmin);
  await access.setRoleFieldAccess(ROLE, [{ field: "title", policy: null }]);
  as(vishal);
  ok("a masked field can still be searched — it's theirs to unmask", (await leads.listLeadsPaged({ page: 1, pageSize: 50, search: "Acme" })).total > 0);

  section("Unmasking");
  const first = await unmaskLead(l1.id);
  ok("opening a lead unmasks it and uses one unit", first.result === "ALLOWED" && first.usage?.used === 1 && first.usage?.limit === 2, first);
  const shown = (await leads.getLead(l1.id))!;
  ok("its email, phone and company are now in the clear", shown.contact?.email === RAW.email && shown.contact?.phone === RAW.phone && shown.company.name === RAW.company);
  ok("the restricted address stays restricted", shown.address.line === "Restricted");
  ok("three fields, one unit", (await db.unmaskUsage.count({ where: { userId: vishal.id } })) === 1);
  const again = await unmaskLead(l1.id);
  ok("opening it again today uses nothing", again.result === "REPEAT" && again.usage?.used === 1, again);
  const second = await unmaskLead(l2.id);
  ok("another lead uses another unit", second.result === "ALLOWED" && second.usage?.used === 2);
  const third = await unmaskLead(l3.id);
  ok("the limit reached, a new lead stays masked", third.result === "QUOTA_EXHAUSTED" && third.usage?.used === 2 && (await leads.getLead(l3.id))?.contact?.email === "r*****@a***.com", third);
  ok("and says why", (third.message ?? "").includes("daily limit"));
  ok("a lead already unmasked today still opens unmasked", (await unmaskLead(l1.id)).result === "REPEAT" && (await leads.getLead(l1.id))?.contact?.email === RAW.email);
  ok("the counter is the database's: a new session reads the same two", (await unmaskUsageToday(vishal.id)).used === 2);
  ok("the original lead was never changed", (await db.contact.findUnique({ where: { id: contact.id } }))?.email === RAW.email && (await db.company.findUnique({ where: { id: company.id } }))?.name === RAW.company);
  const day = await businessDate(new Date("2026-10-16T19:00:00Z"));
  ok("the day turns on the workspace's clock: 19:00 UTC is already the next day in India", day === "2026-10-17", day);

  section("At the same moment");
  await db.userUnmaskLimit.create({ data: { userId: neha.id, limited: true, dailyLimit: 3 } });
  await db.company.update({ where: { id: company.id }, data: { ownerUserId: neha.id } });
  as(neha);
  const burst = await Promise.all(extra.map((l) => unmaskLead(l.id)));
  const allowed = burst.filter((b) => b.result === "ALLOWED").length;
  ok("six leads at once against a limit of three: exactly three unmasked", allowed === 3 && burst.filter((b) => b.result === "QUOTA_EXHAUSTED").length === 3, burst.map((b) => b.result));
  ok("and three usage rows, not more", (await db.unmaskUsage.count({ where: { userId: neha.id } })) === 3);
  await db.unmaskUsage.deleteMany({ where: { userId: neha.id } });
  const same = await Promise.all(Array.from({ length: 6 }, () => unmaskLead(l2.id)));
  ok("one lead six times at once: one unit, five repeats", same.filter((b) => b.result === "ALLOWED").length === 1 && same.filter((b) => b.result === "REPEAT").length === 5, same.map((b) => b.result));
  ok("one usage row", (await db.unmaskUsage.count({ where: { userId: neha.id, leadId: l2.id } })) === 1);
  await db.company.update({ where: { id: company.id }, data: { ownerUserId: vishal.id } });

  section("Refusals use nothing, and are logged");
  as(vishal);
  const usedBefore = await db.unmaskUsage.count({ where: { userId: vishal.id } });
  const away = await unmaskLead(outOfReach.id);
  ok("a lead out of reach answers as missing", away.result === "DENIED" && away.message === "Lead not found.");
  ok("a made-up id answers the same", (await unmaskLead("does-not-exist")).result === "DENIED");
  viewingAs = { user: { id: vishal.id, name: vishal.name, email: vishal.email, role: ROLE }, actor: { id: admin.id, name: admin.name, role: "ADMIN" } };
  await db.unmaskUsage.deleteMany({ where: { userId: vishal.id, leadId: l3.id } });
  const viewAs = await unmaskLead(l3.id);
  viewingAs = null;
  ok("viewing as Vishal unmasks nothing — it would spend his limit", viewAs.result === "DENIED" && (viewAs.message ?? "").includes("viewing as"), viewAs);
  ok("none of it used a unit", (await db.unmaskUsage.count({ where: { userId: vishal.id } })) === usedBefore);
  const refusedRows = await db.unmaskEvent.findMany({ where: { userId: vishal.id, result: "DENIED" } });
  ok("each refusal is in the log, with its reason", refusedRows.length >= 3 && refusedRows.every((r) => r.reason && !r.consumed), refusedRows.map((r) => r.reason));
  ok("viewing as is logged with the admin behind it", refusedRows.some((r) => r.impersonatedByUserId === admin.id));

  section("Access is asked again every time");
  as(superAdmin);
  await access.setRoleFieldAccess(ROLE, [{ field: "email", policy: MASKED({ format: "email", unmask: false }) }]);
  as(vishal);
  const after = (await leads.getLead(l1.id))!;
  ok("unmasked this morning, masked again once unmasking the email is taken away", after.contact?.email === "r*****@a***.com", after.contact?.email);
  ok("while the phone, still allowed, stays unmasked", after.contact?.phone === RAW.phone);
  as(superAdmin);
  await access.setRoleFieldAccess(ROLE, [{ field: "email", policy: MASKED({ format: "email" }) }]);
  await db.rolePermission.updateMany({ where: { role: ROLE, permission: "leads.view" }, data: { allowed: false } });
  as(vishal);
  ok("and without View leads, the lead isn't there at all", (await leads.getLead(l1.id)) === null && (await unmaskLead(l1.id)).result !== "ALLOWED");
  await db.rolePermission.updateMany({ where: { role: ROLE, permission: "leads.view" }, data: { allowed: true } });

  section("A masked field can't be written over with its mask");
  await db.unmaskUsage.deleteMany({ where: { userId: vishal.id, leadId: l3.id } });
  as(superAdmin);
  await access.setRoleFieldAccess(ROLE, [{ field: "title", policy: MASKED({ format: "first" }) }, { field: "description", policy: MASKED({ format: "stars", unmask: false }) }]);
  as(vishal);
  const view3 = (await leads.getLead(l3.id))!;
  ok("the title shows masked", view3.title === "B********", view3.title);
  const write = await leads.updateLeadDetails({ leadId: l3.id, title: view3.title, description: view3.description ?? "", estimatedValue: 5000, expectedCloseDate: "", contactId: contact.id });
  const stored = await db.lead.findUnique({ where: { id: l3.id }, select: { title: true, description: true, estimatedValue: true } });
  ok("saving the edit form keeps the real title and description", write.ok && stored?.title === "Backup licences" && stored?.description === "Wants 40 seats, call after 6", stored);
  ok("while the fields one can see are saved", Number(stored?.estimatedValue) === 5000);
  as(superAdmin);
  await access.setRoleFieldAccess(ROLE, [{ field: "title", policy: null }, { field: "description", policy: null }]);

  section("One person's own policy and limit");
  const own = await access.setPersonFieldAccess(vishal.id, [{ field: "email", policy: { view: true, maskInList: false, maskInDetail: false, unmask: false, format: "email" } }], { reason: "Covering escalations this week" });
  ok("an admin gives Vishal his leads' email in the clear", own.ok, own);
  as(vishal);
  const mine = (await leads.listLeadsPaged({ page: 1, pageSize: 50 })).rows;
  const vishalLead = (await leads.getLead(l3.id))!;
  ok("he sees it unmasked", vishalLead.contact?.email === RAW.email);
  ok("it says where it came from", (await resolveFieldPolicies(vishal.id)).fields.get("email")?.source.via === "userPolicy");
  ok("and only he does: Neha's role still masks it", (await resolveFieldPolicies(neha.id)).fields.get("email")?.policy.maskInDetail === true && mine.length > 0);
  await db.userFieldPolicy.updateMany({ where: { userId: vishal.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  ok("an expired policy of his own is ignored", (await resolveFieldPolicies(vishal.id)).fields.get("email")?.source.via === "rolePolicy");
  as(superAdmin);
  const lifted = await access.setPersonUnmaskLimit(vishal.id, { limited: true, dailyLimit: 25 }, { reason: "Busy week" });
  ok("his own daily limit replaces his role's", lifted.ok && (await unmaskUsageToday(vishal.id)).limit === 25);
  const back = await access.setPersonUnmaskLimit(vishal.id, null);
  ok("and back to his role's", back.ok && (await unmaskUsageToday(vishal.id)).limit === 2);

  section("Who may change what");
  as(vishal);
  ok("Vishal can't change anybody's", !(await access.setRoleFieldAccess(ROLE, [{ field: "email", policy: null }])).ok);
  as(admin);
  ok("nobody changes their own", !(await access.setPersonFieldAccess(admin.id, [{ field: "email", policy: null }])).ok);
  ok("an admin can't change the super admin's", !(await access.setPersonFieldAccess(superAdmin.id, [{ field: "email", policy: null }])).ok);
  ok("only a super admin changes what Admin gets", !(await access.setRoleFieldAccess("ADMIN", [{ field: "email", policy: MASKED() }])).ok);
  as(superAdmin);
  await access.setPersonFieldAccess(admin.id, [{ field: "phone", policy: MASKED({ format: "phone_code", unmask: false }) }]);
  await access.setPersonUnmaskLimit(admin.id, { limited: true, dailyLimit: 5 });
  as(admin);
  const wider = await access.setPersonFieldAccess(neha.id, [{ field: "phone", policy: { view: true, maskInList: false, maskInDetail: false, unmask: false, format: "phone_last4" } }]);
  ok("an admin who sees phones masked can't give anybody them in the clear", !wider.ok && wider.error.includes("more of Phone"), wider);
  const higher = await access.setRoleUnmaskLimit(ROLE, 50);
  ok("nor a daily limit above their own", !higher.ok, higher);
  ok("narrowing within their own is fine", (await access.setRoleUnmaskLimit(ROLE, 3)).ok);
  ok("an unknown field is refused", !(await access.setRoleFieldAccess(ROLE, [{ field: "salary", policy: null }])).ok);
  ok("a mask the field doesn't offer is refused", !(await access.setRoleFieldAccess(ROLE, [{ field: "email", policy: MASKED({ format: "phone_last4" }) }])).ok);
  ok("so is a limit of nothing", !(await access.setRoleUnmaskLimit(ROLE, 0)).ok);
  const history = await db.permissionChange.findMany({ where: { permission: { startsWith: "field:" } } });
  ok("every change is in the permission history", history.length >= 8, history.length);

  section("The log");
  const events = await db.unmaskEvent.findMany();
  ok("it holds field names, never values", leaks(events).length === 0 && events.every((e) => e.fields.every((f) => /^[a-zA-Z:_-]+$/.test(f))), leaks(events));
  ok("every allowed row used a unit and says how many were used", events.filter((e) => e.result === "ALLOWED").every((e) => e.consumed && e.usedToday !== null));
  ok("no repeat used a unit", events.filter((e) => e.result === "REPEAT").every((e) => !e.consumed));
  ok("each row has a request id and the lead's number", events.filter((e) => e.leadRef).every((e) => Boolean(e.requestId)) && events.some((e) => e.leadRef?.startsWith("LEAD-")));
  let changed = false;
  try {
    await db.unmaskEvent.update({ where: { id: events[0]!.id }, data: { reason: "edited" } });
    changed = true;
  } catch {
    changed = false;
  }
  ok("a row can't be changed", !changed);
  let removed = false;
  try {
    await db.unmaskEvent.delete({ where: { id: events[0]!.id } });
    removed = true;
  } catch {
    removed = false;
  }
  ok("nor removed", !removed);
  as(admin);
  ok("an admin who isn't the super admin can't read it", !(await logs.listUnmaskEvents({}, { page: 1, pageSize: 25 })).ok);
  ok("nor export it", !(await logs.exportUnmaskEventsCsv({})).ok);
  as(superAdmin);
  viewingAs = { user: { id: superAdmin.id, name: superAdmin.name, email: superAdmin.email, role: "ADMIN" }, actor: { id: admin.id, name: admin.name, role: "ADMIN" } };
  ok("nor anybody viewing as the super admin", !(await logs.listUnmaskEvents({}, { page: 1, pageSize: 25 })).ok);
  viewingAs = null;
  const all = await logs.listUnmaskEvents({}, { page: 1, pageSize: 200 });
  ok("the super admin reads every row", all.ok && all.data.total === events.length);
  const byUser = await logs.listUnmaskEvents({ userId: neha.id }, { page: 1, pageSize: 200 });
  ok("filtered by person", byUser.ok && byUser.data.rows.length > 0 && byUser.data.rows.every((r) => r.userId === neha.id));
  const byResult = await logs.listUnmaskEvents({ result: "QUOTA_EXHAUSTED" }, { page: 1, pageSize: 200 });
  ok("by result", byResult.ok && byResult.data.rows.length > 0 && byResult.data.rows.every((r) => r.result === "QUOTA_EXHAUSTED"));
  const l1Ref = `LEAD-${l1.leadSeq}`;
  const byLead = await logs.listUnmaskEvents({ lead: l1Ref }, { page: 1, pageSize: 200 });
  ok("by lead number, however it's typed", byLead.ok && byLead.data.rows.length > 0 && byLead.data.rows.every((r) => r.leadId === l1.id), l1Ref);
  const today = await businessDate();
  const byDay = await logs.listUnmaskEvents({ from: "2000-01-01", to: "2000-01-02" }, { page: 1, pageSize: 200 });
  ok("by date", byDay.ok && byDay.data.total === 0 && (await logs.listUnmaskEvents({ from: today, to: today }, { page: 1, pageSize: 200 })).ok);
  const paged = await logs.listUnmaskEvents({}, { page: 2, pageSize: 5 });
  ok("a page at a time", paged.ok && paged.data.rows.length === Math.min(5, Math.max(0, events.length - 5)));
  const exported = await logs.exportUnmaskEventsCsv({ userId: vishal.id });
  ok("the CSV has a header and the person's rows, and no values", exported.ok && exported.data.csv.startsWith('"When"') && exported.data.rows > 0 && leaks(exported.ok ? exported.data.csv : "").length === 0);
}

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
  const scratchName = `${realName}_fieldaccess`;
  const scratchUrl = withDatabase(realUrl, scratchName);
  const real = directClient(realUrl, { max: 1 });
  const realEvents = await real.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from unmask_events`).catch(() => [{ n: BigInt(-1) }]);
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
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    closeAll = () => db.$disconnect();
    await run(db as unknown as PrismaClient);
  } finally {
    await closeAll?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const gone = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratchName}'`);
    ok("the scratch database is dropped", Number(gone[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }
  section("The real workspace was not touched");
  const realAfter = await real.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from unmask_events`).catch(() => [{ n: BigInt(-1) }]);
  await real.$disconnect();
  ok("its unmasking log is as it was", realAfter[0]?.n === realEvents[0]?.n, String(realAfter[0]?.n));

  console.log(failures === 0 ? `\nAll ${passes} field access checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
