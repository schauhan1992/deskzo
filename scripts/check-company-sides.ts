/**
 * check:company-sides — vendors kept out of adding a customer or a lead (owner, 19 Oct 2026).
 *
 *   · Adding a company, reseller or commission party, the "already in the CRM" list never offers a
 *     vendor; adding a vendor, only vendors. The same name is still said whatever its kind — names are one
 *     to a company, so saving would be refused — and says it's a vendor. Without a kind (the merge wizard,
 *     the copilot) every kind is searched, as before.
 *   · A new lead's company picker offers customers only — clients and resellers — and a lead can't be
 *     opened on a vendor even by a request the form never makes.
 *   · One company, two roles (owner, 19 Oct 2026): a vendor that's also a customer, a customer that's
 *     also a vendor — in both lists and both sides' pickers, a lead and a vendor code where each belongs,
 *     the added side reached through whoever looks after it (for Himanshu to review), one added role at
 *     most, only by whoever may change the company. A workspace not migrated yet keeps every company its
 *     one kind, and nothing fails.
 *
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:company-sides
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["@/lib/session", session],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("../src/lib/session"), session],
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

async function main() {
  section("Where the forms ask");
  ok("a new lead's company picker asks for the customer side", read("src/app/(dashboard)/leads/new/page.tsx").includes('listCompanyOptions({ side: "customer" })'));
  const { mainSide, rolesAddable } = load("../src/lib/companies/roles") as typeof import("../src/lib/companies/roles");
  ok("a customer may also be a vendor; a vendor, a customer; a commission party, either", rolesAddable("CLIENT").join() === "vendor" && rolesAddable("RESELLER").join() === "vendor" && rolesAddable("OEM").join() === "customer" && rolesAddable("COMMISSION_PARTY").sort().join() === "customer,vendor");
  ok("  the main side by kind", mainSide("CLIENT") === "customer" && mainSide("DISTRIBUTOR") === "vendor" && mainSide("COMMISSION_PARTY") === null);
  const detail = read("src/components/companies/company-detail.tsx");
  ok("the company page takes its sides from its roles, with the roles card and both statements", detail.includes("const roles = await rolesOf(company);") && detail.includes("<CompanyRolesControl") && detail.includes("vendorStatement(company.id)"));
  ok("the company form says what it's adding", read("src/components/companies/new-company-form.tsx").includes(`adding={watch("relationshipType") ?? defaultRelationshipType}`));
  ok("  and the lead form's quick add, a client", read("src/components/companies/quick-create-company-dialog.tsx").includes(`adding="CLIENT"`));

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${realName}_compsides`;
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  let close: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, scratch) }, timeout: 10 * 60_000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);
    process.env.DATABASE_URL = withDatabase(url, scratch);
    process.env.CONTROL_DATABASE_URL = "";

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    close = () => db.$disconnect();
    const companies = require("../src/actions/company") as typeof import("../src/actions/company");
    const leads = require("../src/actions/lead") as typeof import("../src/actions/lead");
    const roles = require("../src/lib/companies/roles") as typeof import("../src/lib/companies/roles");
    const access = require("../src/lib/authz/access") as typeof import("../src/lib/authz/access");
    const { canSeeCompany } = require("../src/lib/authz/company-scope") as typeof import("../src/lib/authz/company-scope");
    /* eslint-enable @typescript-eslint/no-require-imports */

    const boss = await db.user.create({ data: { name: "Zz Boss", email: "boss@zz-sides.in", passwordHash: "!", role: "ADMIN", isSuperAdmin: true }, select: { id: true, name: true, email: true, role: true } });
    actor = { id: boss.id, name: boss.name, email: boss.email!, role: boss.role };
    const company = (name: string, relationshipType: string) =>
      db.company.create({ data: { name, normalizedName: name.toLowerCase(), relationshipType: relationshipType as never, createdById: boss.id, ownerUserId: boss.id }, select: { id: true, name: true } });
    const client = await company("Zz Acme Traders", "CLIENT");
    const vendor = await company("Zz Acme Supplies", "VENDOR");
    const oem = await company("Zz Acme Devices", "OEM");
    const reseller = await company("Zz Acme Partners", "RESELLER");
    await company("Zz Acme Agents", "COMMISSION_PARTY");

    section("The \"already in the CRM\" list");
    const names = (r: Awaited<ReturnType<typeof companies.findCompanyMatches>>) => r.matches.map((m) => m.name).sort().join(", ");
    const asClient = await companies.findCompanyMatches("zz acme", "CLIENT");
    ok("adding a company: customers, resellers and commission parties — never a vendor", names(asClient) === "Zz Acme Agents, Zz Acme Partners, Zz Acme Traders", names(asClient));
    const asReseller = await companies.findCompanyMatches("zz acme", "RESELLER");
    ok("  the same adding a reseller", !asReseller.matches.some((m) => m.name === vendor.name || m.name === oem.name));
    const asVendor = await companies.findCompanyMatches("zz acme", "VENDOR");
    ok("adding a vendor: only vendors, of every vendor kind", names(asVendor) === "Zz Acme Devices, Zz Acme Supplies", names(asVendor));
    const anyKind = await companies.findCompanyMatches("zz acme");
    ok("without a kind — the merge wizard, the copilot — every kind, as before", anyKind.matches.length === 5, anyKind.matches.length);
    const sameAsVendor = await companies.findCompanyMatches("Zz Acme Supplies", "CLIENT");
    ok("the same name as a vendor is still said, with what it is — saving would be refused", sameAsVendor.duplicate?.visible === true && sameAsVendor.duplicate.match.relationshipType === "VENDOR" && sameAsVendor.matches.length === 0, sameAsVendor.duplicate);
    const sameAsClient = await companies.findCompanyMatches("Zz Acme Traders", "CLIENT");
    ok("  and the same name as a customer, as before", sameAsClient.duplicate?.visible === true && sameAsClient.duplicate.match.name === client.name);
    const ui = read("src/components/companies/existing-company-matches.tsx");
    ok("  the warning says it's a vendor", ui.includes("is already in the CRM as a ${") && ui.includes('"vendor"'));

    section("A new lead");
    const options = await companies.listCompanyOptions({ side: "customer" });
    ok("the picker offers clients and resellers only", options.map((o) => o.name).sort().join(", ") === "Zz Acme Partners, Zz Acme Traders", options.map((o) => o.name));
    const onVendor = await leads.createLead({ companyId: vendor.id, title: "Zz on a vendor" });
    ok("a lead on a vendor is refused, however it's asked for", !onVendor.ok && onVendor.error.includes("vendor") && (await db.lead.count({ where: { companyId: vendor.id } })) === 0, onVendor.ok ? "MADE" : onVendor.error);
    ok("  on an OEM too", !(await leads.createLead({ companyId: oem.id, title: "Zz on an OEM" })).ok);
    const onClient = await leads.createLead({ companyId: client.id, title: "Zz on a client" });
    ok("on a client it's made", onClient.ok, onClient.ok ? "" : onClient.error);
    ok("  and on a reseller", (await leads.createLead({ companyId: reseller.id, title: "Zz on a reseller" })).ok);

    section("One company, two roles");
    const rep = await db.user.create({ data: { name: "Zz Rep", email: "rep@zz-sides.in", passwordHash: "!", role: "SALES" }, select: { id: true, name: true, email: true, role: true } });
    const buyer = await db.user.create({ data: { name: "Zz Buyer", email: "buyer@zz-sides.in", passwordHash: "!", role: "SALES" }, select: { id: true, name: true, email: true, role: true } });
    const as = <T,>(who: { id: string; name: string; email: string | null; role: string }, work: () => Promise<T>) => {
      const before = actor;
      actor = { id: who.id, name: who.name, email: who.email!, role: who.role };
      return work().finally(() => {
        actor = before;
      });
    };
    await db.company.update({ where: { id: vendor.id }, data: { ownerUserId: buyer.id } });
    const vendorFacts = { id: vendor.id, ownerUserId: buyer.id, relationshipType: "VENDOR" as const };
    ok("(the rep sees their own accounts only, not the buyer's vendor)", !(await access.mayAccessAccount(rep.id, "view", vendorFacts)));

    const refused = await as(rep, () => companies.setCompanySecondRole({ companyId: vendor.id, side: "customer", on: true }));
    ok("somebody who can't change the vendor can't give it a role", !refused.ok, refused.ok ? "ADDED" : refused.error);
    const made = await companies.setCompanySecondRole({ companyId: vendor.id, side: "customer", on: true });
    ok("a vendor made a customer too", made.ok && (await roles.isCustomerSide(vendorFacts)) && (await roles.isVendorSide(vendorFacts)), made.ok ? "" : made.error);
    ok("  handing back the company and its people, for a form that wanted it", made.ok && made.data.company.id === vendor.id && Array.isArray(made.data.company.contacts));
    ok("  audited", (await db.auditLog.count({ where: { entityType: "Company", entityId: vendor.id, entityLabel: { contains: "also a customer" } } })) === 1);
    ok("  only one added role", !(await companies.setCompanySecondRole({ companyId: vendor.id, side: "vendor", on: true })).ok);
    ok("  a client can't be made a customer — it is one", !(await companies.setCompanySecondRole({ companyId: client.id, side: "customer", on: true })).ok);

    const listNames = (rows: { name: string }[]) => rows.map((r) => r.name);
    ok("it's in the Companies list", listNames(await companies.listCompanies()).includes(vendor.name));
    ok("  and still in the Vendors list", listNames(await companies.listVendors()).includes(vendor.name));
    ok("  a lead's picker offers it", listNames(await companies.listCompanyOptions({ side: "customer" })).includes(vendor.name));
    ok("  adding a company lists it among similar names", (await companies.findCompanyMatches("zz acme sup", "CLIENT")).matches.some((m) => m.name === vendor.name));
    const dupNow = await companies.findCompanyMatches(vendor.name, "CLIENT");
    ok("  and the same name is said to be a customer already — open it", dupNow.duplicate?.visible === true && dupNow.duplicate.customer === true, dupNow.duplicate);
    const lead = await leads.createLead({ companyId: vendor.id, title: "Zz buys from us too" });
    ok("a lead on it is made", lead.ok, lead.ok ? "" : lead.error);

    ok("the rep doesn't reach it until they look after its customer side", !(await access.mayAccessAccount(rep.id, "view", vendorFacts)));
    const sideSet = await companies.setCompanySideOwner({ companyId: vendor.id, userId: rep.id });
    ok("the account manager of its customer side is set", sideSet.ok && (await db.company.findUnique({ where: { id: vendor.id }, select: { sideOwnerUserId: true } }))?.sideOwnerUserId === rep.id, sideSet.ok ? "" : sideSet.error);
    ok("  now the rep reaches it — for Himanshu to review", await access.mayAccessAccount(rep.id, "view", vendorFacts));
    ok("  in their lists too", (await db.company.count({ where: { AND: [{ id: vendor.id }, await access.companyAccess(rep.id, "view")] } })) === 1);
    ok("  the buyer still reaches it as its vendor manager", await access.mayAccessAccount(buyer.id, "view", vendorFacts));
    ok("  a check without its id is by its main kind only, as before", !(await canSeeCompany(rep.id, { ownerUserId: buyer.id, relationshipType: "VENDOR" })));
    const inactive = await db.user.create({ data: { name: "Zz Gone", email: "gone@zz-sides.in", passwordHash: "!", role: "SALES", active: false }, select: { id: true } });
    ok("  nobody inactive can be given it", !(await companies.setCompanySideOwner({ companyId: vendor.id, userId: inactive.id })).ok);
    ok("  nor can a company with one role have one", !(await companies.setCompanySideOwner({ companyId: oem.id, userId: rep.id })).ok);

    const vendorToo = await companies.setCompanySecondRole({ companyId: client.id, side: "vendor", on: true });
    const clientNow = await db.company.findUnique({ where: { id: client.id }, select: { vendorCode: true, vendorStatus: true } });
    ok("a client made a vendor too: onboarding, with a vendor code", vendorToo.ok && clientNow?.vendorStatus === "ONBOARDING" && !!clientNow.vendorCode, clientNow);
    ok("  in the Vendors list and the vendor pickers", listNames(await companies.listVendors()).includes(client.name) && listNames(await companies.listVendorOptions()).includes(client.name));
    ok("  and still in the Companies list", listNames(await companies.listCompanies()).includes(client.name));

    const off = await companies.setCompanySecondRole({ companyId: vendor.id, side: "customer", on: false });
    ok("taken off: a vendor alone again, its account manager gone", off.ok && !(await roles.isCustomerSide(vendorFacts)) && (await db.company.findUnique({ where: { id: vendor.id }, select: { sideOwnerUserId: true } }))?.sideOwnerUserId === null);
    ok("  out of the Companies list, and the rep's reach", !listNames(await companies.listCompanies()).includes(vendor.name) && !(await access.mayAccessAccount(rep.id, "view", vendorFacts)));
    ok("  its lead stays", (await db.lead.count({ where: { companyId: vendor.id } })) === 1);
    const endCustomer = await db.company.create({ data: { name: "Zz End Customer", normalizedName: "zz end customer", relationshipType: "CLIENT", createdById: boss.id, ownerUserId: boss.id, managedByResellerId: reseller.id }, select: { id: true } });
    ok("a reseller's customer can't be made a vendor", !(await companies.setCompanySecondRole({ companyId: endCustomer.id, side: "vendor", on: true })).ok);

    section("Before a workspace is migrated");
    await companies.setCompanySecondRole({ companyId: vendor.id, side: "customer", on: true });
    await db.$executeRawUnsafe('ALTER TABLE "companies" DROP COLUMN "alsoCustomer", DROP COLUMN "alsoVendor", DROP COLUMN "sideOwnerUserId"');
    ok("the columns gone: none of this is offered", !(await roles.twoRolesHere()));
    const plainList = await companies.listCompanies();
    ok("  the Companies list still loads, of clients", plainList.some((c) => c.name === client.name) && !plainList.some((c) => c.name === vendor.name));
    ok("  a vendor is a vendor, a client a client", !(await roles.isCustomerSide(vendorFacts)) && (await roles.isCustomerSide({ id: client.id, relationshipType: "CLIENT" })));
    ok("  a company read whole still reads", !!(await db.company.findUnique({ where: { id: vendor.id } })));
    ok("  access is by kind, as before", (await db.company.count({ where: { AND: [{ id: client.id }, await access.companyAccess(boss.id, "view")] } })) === 1 && !(await access.mayAccessAccount(rep.id, "view", vendorFacts)));
    ok("  the vendor pickers still load", listNames(await companies.listVendorOptions()).includes(vendor.name));
  } finally {
    actor = null;
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} company side checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
