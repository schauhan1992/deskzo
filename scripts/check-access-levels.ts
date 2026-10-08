/**
 * Access levels (docs/permission-redesign.md, phase 1): how far somebody reaches over a kind of
 * record — none, their own, their team's, their branch's, all, or as far as the account.
 *
 * What it proves, because the failure that matters is the silent one — a filter too wide shows
 * somebody everybody's records and nobody reports it:
 *
 *   · with no level stored, every answer is the one the old helpers gave (derived from permissions);
 *   · each level reaches exactly the records it names — no more — for customers, vendors, contacts,
 *     leads, orders, documents and payments;
 *   · a list and a single-record check never disagree: for every probe record, "is it in the list"
 *     and "may I open it" give the same answer at every level;
 *   · edit never reaches wider than view, nor delete and assign wider than edit;
 *   · a person's own level beats their role's, an expired one doesn't count, a level a record type
 *     doesn't offer answers nothing, and the deactivated and the Automation account reach nothing;
 *   · customers and vendors are separate rows, and a single-company check tells them apart.
 *
 * Everything probe is named ZZPROBE_ACCESS — a custom role of its own, a branch, five people and
 * their records — and removed in a finally. The real workspace's roles are never given a level.
 *
 *   npm run check:access-levels
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => ({ id: actorId, role: ROLE, name: "Zzprobe", email: `actor${MAIL}` });
    return { requireUser: user, currentUser: user, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_ACCESS";
const ROLE = "ZZPROBE_ACCESS";
const MAIL = "@zzprobe-access.invalid";
const BRANCH_CODE = "ZZPAC";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
const show = (ids: string[], names: Map<string, string>) => ids.map((i) => names.get(i) ?? i).sort().join(", ") || "nothing";

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const companies = await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);
  await db.userAccessLevel.deleteMany({ where: { userId: { in: userIds } } });
  await db.roleAccessLevel.deleteMany({ where: { role: ROLE } });
  await db.payment.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.tradeDocument.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.companyProduct.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.lead.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.contact.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.companyLocation.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.item.deleteMany({ where: { sku: { startsWith: TAG } } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.updateMany({ where: { id: { in: userIds } }, data: { managerId: null } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.role.deleteMany({ where: { key: ROLE } });
  await db.branch.deleteMany({ where: { code: BRANCH_CODE } });
}

type Level = "NONE" | "OWN" | "TEAM" | "BRANCH" | "ALL" | "FOLLOW";
type Record = "companies" | "vendors" | "contacts" | "leads" | "orders" | "documents" | "payments";
type Action = "view" | "edit" | "delete" | "assign";

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const access = require("../src/lib/authz/access") as typeof import("../src/lib/authz/access");
  const scope = require("../src/lib/authz/company-scope") as typeof import("../src/lib/authz/company-scope");
  const contacts = require("../src/lib/authz/contact-access") as typeof import("../src/lib/authz/contact-access");
  const { getPermissionDefinition } = require("../src/lib/permissions") as typeof import("../src/lib/permissions");
  const { db: appDb } = require("../src/lib/db") as typeof import("../src/lib/db");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("The record types");
  ok("every record type the engine names is described, once", same(access.ACCESS_RECORDS.map((r) => r.key), [...access.ACCESS_RECORD_KEYS]));
  ok("each one is derived from a real permission", access.ACCESS_RECORDS.every((r) => !!getPermissionDefinition(r.derivedFrom.key)), access.ACCESS_RECORDS.map((r) => r.derivedFrom.key).join(", "));
  ok("each offers NONE and ALL", access.ACCESS_RECORDS.every((r) => r.levels.includes("NONE") && r.levels.includes("ALL")));
  ok("records that hang off an account may follow it; accounts themselves may not", access.ACCESS_RECORDS.every((r) => r.levels.includes("FOLLOW") === !["companies", "vendors"].includes(r.key)));
  ok("contacts have no person of their own — none, as the account, or all", same([...access.accessRecordDefinition("contacts").levels], ["NONE", "FOLLOW", "ALL"]));

  await cleanup();
  try {
    section("The fixture");
    await db.role.create({ data: { key: ROLE, name: "Zzprobe access" } });
    const branch = await db.branch.create({ data: { name: `${TAG} branch`, code: BRANCH_CODE } });
    const person = (key: string, extra: { branchId?: string; managerId?: string } = {}) =>
      db.user.create({ data: { name: `Zzprobe ${key}`, email: `${key.toLowerCase()}${MAIL}`, role: ROLE, passwordHash: "x".repeat(60), ...extra } });
    const boss = await person("Boss");
    const rep = await person("Rep", { branchId: branch.id, managerId: boss.id });
    const junior = await person("Junior", { branchId: branch.id, managerId: rep.id });
    const branchmate = await person("Branchmate", { branchId: branch.id });
    const peer = await person("Peer");

    const company = (key: string, ownerUserId: string | null, relationshipType: "CLIENT" | "VENDOR" = "CLIENT") =>
      db.company.create({ data: { name: `${TAG} ${key}`, normalizedName: `${TAG} ${key}`.toLowerCase(), createdById: boss.id, ownerUserId, relationshipType, stage: "CUSTOMER" } });
    const cRep = await company("Rep's customer", rep.id);
    const cJunior = await company("Junior's customer", junior.id);
    const cBranchmate = await company("Branchmate's customer", branchmate.id);
    const cPeer = await company("Peer's customer", peer.id);
    const cNobody = await company("Nobody's customer", null);
    const vRep = await company("Rep's vendor", rep.id, "VENDOR");
    const vPeer = await company("Peer's vendor", peer.id, "VENDOR");
    const accounts = [cRep, cJunior, cBranchmate, cPeer, cNobody, vRep, vPeer];
    const location = new Map<string, string>();
    for (const c of accounts) location.set(c.id, (await db.companyLocation.create({ data: { companyId: c.id, label: "Head Office", isPrimary: true } })).id);
    const item = await db.item.create({ data: { name: `${TAG} Licence`, sku: `${TAG}-1`, type: "SUBSCRIPTION", sellingPrice: 100, createdById: boss.id } });

    const kRep = await db.contact.create({ data: { companyId: cRep.id, name: "Zzprobe Rep contact" } });
    const kPeer = await db.contact.create({ data: { companyId: cPeer.id, name: "Zzprobe Peer contact" } });
    const kVendor = await db.contact.create({ data: { companyId: vPeer.id, name: "Zzprobe Vendor contact" } });

    const lead = (title: string, companyId: string, ownerUserId: string | null) => db.lead.create({ data: { companyId, title: `${TAG} ${title}`, ownerUserId } });
    const lRepOnPeer = await lead("Rep's lead on Peer's customer", cPeer.id, rep.id);
    const lJunior = await lead("Junior's lead", cJunior.id, junior.id);
    const lBranchmate = await lead("Branchmate's lead", cBranchmate.id, branchmate.id);
    const lPeer = await lead("Peer's lead", cPeer.id, peer.id);
    const lUnowned = await lead("Unowned lead on Rep's customer", cRep.id, null);

    const order = (companyId: string, addedByUserId: string) => db.companyProduct.create({ data: { companyId, locationId: location.get(companyId)!, itemId: item.id, addedByUserId } });
    const oRepOnPeer = await order(cPeer.id, rep.id);
    const oJunior = await order(cJunior.id, junior.id);
    const oBranchmate = await order(cBranchmate.id, branchmate.id);
    const oPeer = await order(cPeer.id, peer.id);
    const oPeerOnRep = await order(cRep.id, peer.id);

    let docN = 0;
    const doc = (companyId: string, salespersonId: string | null, createdById: string, branchId: string | null) =>
      db.tradeDocument.create({ data: { docNumber: `${TAG}-${(docN += 1)}`, docType: "INVOICE", direction: "SALES", companyId, salespersonId, createdById, branchId } });
    const dRepInBranch = await doc(cPeer.id, rep.id, peer.id, branch.id);
    const dPeerAtHead = await doc(cPeer.id, peer.id, peer.id, null);
    const dJunior = await doc(cJunior.id, junior.id, junior.id, null);
    const dRaisedByRep = await doc(cPeer.id, peer.id, rep.id, null);
    const dOnRepsCustomer = await doc(cRep.id, peer.id, peer.id, null);

    const pay = (companyId: string, recordedByUserId: string, branchId: string | null) =>
      db.payment.create({ data: { companyId, amount: 100, paidOn: new Date(), method: "UPI", recordedByUserId, branchId } });
    const pRepInBranch = await pay(cPeer.id, rep.id, branch.id);
    const pPeerAtHead = await pay(cPeer.id, peer.id, null);
    const pJunior = await pay(cJunior.id, junior.id, null);
    const pOnRepsCustomer = await pay(cRep.id, peer.id, null);

    const names = new Map<string, string>([
      ...accounts.map((c) => [c.id, c.name.replace(`${TAG} `, "")] as const),
      ...[kRep, kPeer, kVendor].map((k) => [k.id, k.name.replace("Zzprobe ", "")] as const),
      ...[lRepOnPeer, lJunior, lBranchmate, lPeer, lUnowned].map((l) => [l.id, l.title.replace(`${TAG} `, "")] as const),
      [oRepOnPeer.id, "order Rep added on Peer's"], [oJunior.id, "order Junior added"], [oBranchmate.id, "order Branchmate added"], [oPeer.id, "order Peer added"], [oPeerOnRep.id, "order Peer added on Rep's"],
      [dRepInBranch.id, "doc Rep sells, branch"], [dPeerAtHead.id, "doc Peer sells, head office"], [dJunior.id, "doc Junior sells"], [dRaisedByRep.id, "doc Rep raised"], [dOnRepsCustomer.id, "doc on Rep's customer"],
      [pRepInBranch.id, "payment Rep recorded, branch"], [pPeerAtHead.id, "payment Peer recorded"], [pJunior.id, "payment Junior recorded"], [pOnRepsCustomer.id, "payment on Rep's customer"],
    ]);
    ok("a manager, a rep in a branch with a junior, a branch-mate outside the team, a peer at the head office — and one of each record", true);

    // ── Asking ────────────────────────────────────────────────────────────────────────────────────
    const fixture: { [K in Record]: string[] } = {
      companies: accounts.map((c) => c.id),
      vendors: accounts.map((c) => c.id),
      contacts: [kRep.id, kPeer.id, kVendor.id],
      leads: [lRepOnPeer.id, lJunior.id, lBranchmate.id, lPeer.id, lUnowned.id],
      orders: [oRepOnPeer.id, oJunior.id, oBranchmate.id, oPeer.id, oPeerOnRep.id],
      documents: [dRepInBranch.id, dPeerAtHead.id, dJunior.id, dRaisedByRep.id, dOnRepsCustomer.id],
      payments: [pRepInBranch.id, pPeerAtHead.id, pJunior.id, pOnRepsCustomer.id],
    };
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
    /** The probe records of a type that this person's list shows for an action. */
    const listed = async (userId: string, record: Record, action: Action = "view"): Promise<string[]> => {
      const only = { id: { in: fixture[record] } };
      switch (record) {
        case "companies":
        case "vendors":
          return ids(await appDb.company.findMany({ where: { AND: [only, await access.companyAccess(userId, action)] }, select: { id: true } }));
        case "contacts":
          return ids(await appDb.contact.findMany({ where: { AND: [only, await access.contactAccess(userId, action)] }, select: { id: true } }));
        case "leads":
          return ids(await appDb.lead.findMany({ where: { AND: [only, await access.leadAccess(userId, action)] }, select: { id: true } }));
        case "orders":
          return ids(await appDb.companyProduct.findMany({ where: { AND: [only, await access.orderAccess(userId, action)] }, select: { id: true } }));
        case "documents":
          return ids(await appDb.tradeDocument.findMany({ where: { AND: [only, await access.documentAccess(userId, action)] }, select: { id: true } }));
        case "payments":
          return ids(await appDb.payment.findMany({ where: { AND: [only, await access.paymentAccess(userId, action)] }, select: { id: true } }));
      }
    };
    /** The same question one record at a time — must agree with the list, record for record. */
    const oneByOne = async (userId: string, record: Record, action: Action = "view"): Promise<string[]> => {
      const out: string[] = [];
      for (const id of fixture[record]) if (await access.mayAccess(userId, record, action, id)) out.push(id);
      return out;
    };
    const roleLevel = async (record: Record, action: Action, level: Level) =>
      db.roleAccessLevel.upsert({ where: { role_record_action: { role: ROLE, record, action } }, create: { role: ROLE, record, action, level }, update: { level } });
    const clearLevels = async () => {
      await db.roleAccessLevel.deleteMany({ where: { role: ROLE } });
      await db.userAccessLevel.deleteMany({ where: { userId: { in: [boss.id, rep.id, junior.id, branchmate.id, peer.id] } } });
    };
    const grant = async (userId: string, permission: string, allowed = true) =>
      db.userPermission.upsert({ where: { user_permission: { userId, permission } }, create: { userId, permission, allowed, reason: TAG }, update: { allowed } });
    const ungrant = async (userId: string, permission: string) => db.userPermission.deleteMany({ where: { userId, permission } });

    /** One level: the list is exactly `expected`, and one-by-one agrees with the list. */
    const expectReach = async (label: string, userId: string, record: Record, expected: string[], action: Action = "view") => {
      const list = await listed(userId, record, action);
      const each = await oneByOne(userId, record, action);
      ok(label, same(list, expected), `reaches ${show(list, names)}${same(list, expected) ? "" : `; expected ${show(expected, names)}`}`);
      ok(`  and one record at a time says the same`, same(each, list), same(each, list) ? "" : `one-by-one ${show(each, names)}`);
    };

    // ── Derived, nothing stored ───────────────────────────────────────────────────────────────────
    section("With no level stored, the old answers");
    const repTeam = [cRep.id, cJunior.id, vRep.id];
    await expectReach("the rep reaches the accounts they and their junior manage — customers and vendors alike", rep.id, "companies", repTeam);
    const scopeWhere = await scope.companyScope(rep.id);
    ok("  companyScope is the old single clause, owner in [rep, junior]", JSON.stringify(scopeWhere) === JSON.stringify({ ownerUserId: { in: [rep.id, junior.id] } }), JSON.stringify(scopeWhere));
    ok("  viaCompanyScope too, one hop", JSON.stringify(await scope.viaCompanyScope(rep.id)) === JSON.stringify({ company: { ownerUserId: { in: [rep.id, junior.id] } } }));
    ok("  and accountScopeIds names the same people", JSON.stringify(await scope.accountScopeIds(rep.id)) === JSON.stringify([rep.id, junior.id]));
    const opened = [] as string[];
    for (const c of accounts) if (await scope.canSeeCompany(rep.id, c)) opened.push(c.id);
    ok("  canSeeCompany opens exactly those, one at a time", same(opened, repTeam), show(opened, names));
    ok("  and nothing at all for a company that wasn't found", !(await scope.canSeeCompany(rep.id, null)));
    for (const record of ["contacts", "leads", "orders", "documents", "payments"] as const) {
      await expectReach(`without its view permission the rep reaches no ${record}`, rep.id, record, []);
    }
    const derived = await access.explainAccess(rep.id, "leads", "view");
    ok("  and says why — derived from leads.view, not held", derived.source.via === "derived" && derived.source.from === "leads.view" && !derived.source.held, JSON.stringify(derived.source));

    for (const key of ["contacts.view", "leads.view", "orders.view", "documents.view", "payments.view"]) await grant(rep.id, key);
    await expectReach("with leads.view, the leads on the accounts the rep reaches — as the old list", rep.id, "leads", [lJunior.id, lUnowned.id]);
    await expectReach("with orders.view, the orders on them", rep.id, "orders", [oJunior.id, oPeerOnRep.id]);
    await expectReach("with documents.view, the documents on them", rep.id, "documents", [dJunior.id, dOnRepsCustomer.id]);
    await expectReach("with payments.view, the payments on them", rep.id, "payments", [pJunior.id, pOnRepsCustomer.id]);
    await expectReach("with contacts.view, the contacts at them", rep.id, "contacts", [kRep.id]);
    // The contact helpers answer for the signed-in person only, as the app asks them.
    actorId = rep.id;
    ok("  contacts one company at a time: the rep's customer yes, the peer's no", (await contacts.mayWorkWithContactsOf(rep.id, cRep.id)) && !(await contacts.mayWorkWithContactsOf(rep.id, cPeer.id)));
    await grant(rep.id, "companies.viewAll");
    await expectReach("with companies.viewAll, every account", rep.id, "companies", fixture.companies);
    ok("  companyScope is no condition at all, as before", JSON.stringify(await scope.companyScope(rep.id)) === "{}" && JSON.stringify(await scope.viaCompanyScope(rep.id)) === "{}" && (await scope.accountScopeIds(rep.id)) === null);
    await expectReach("  and every lead, through every account", rep.id, "leads", fixture.leads);
    await ungrant(rep.id, "companies.viewAll");
    ok("edit, delete and assign derive the same as view", same(await listed(rep.id, "leads", "edit"), await listed(rep.id, "leads", "view")) && same(await listed(rep.id, "leads", "delete"), await listed(rep.id, "leads", "view")) && same(await listed(rep.id, "companies", "assign"), repTeam));

    // ── Each level, each record ───────────────────────────────────────────────────────────────────
    section("Accounts, level by level");
    const accountExpect: [Level, string[]][] = [
      ["NONE", []],
      ["OWN", [cRep.id, vRep.id]],
      ["TEAM", [cRep.id, cJunior.id, vRep.id]],
      ["BRANCH", [cRep.id, cJunior.id, cBranchmate.id, vRep.id]],
      ["ALL", fixture.companies],
    ];
    for (const [level, expected] of accountExpect) {
      await roleLevel("companies", "view", level);
      await roleLevel("vendors", "view", level);
      await expectReach(`${level}: customers and vendors`, rep.id, "companies", expected);
    }
    await roleLevel("companies", "view", "ALL");
    await roleLevel("vendors", "view", "OWN");
    await expectReach("customers ALL and vendors OWN: every customer, and only the rep's own vendor", rep.id, "companies", [cRep.id, cJunior.id, cBranchmate.id, cPeer.id, cNobody.id, vRep.id]);
    ok("  the clause splits by relationship type only now that the two differ", JSON.stringify(await scope.companyScope(rep.id)).includes("relationshipType"));
    ok("  a single-company check tells them apart: Peer's customer yes, Peer's vendor no", (await scope.canSeeCompany(rep.id, cPeer)) && !(await scope.canSeeCompany(rep.id, vPeer)) && (await scope.canSeeCompany(rep.id, vRep)));
    ok("  accountScopeIds follows customers — the selling side", (await scope.accountScopeIds(rep.id)) === null);
    await clearLevels();

    section("Leads, level by level");
    const leadExpect: [Level, string[]][] = [
      ["NONE", []],
      ["OWN", [lRepOnPeer.id]],
      ["TEAM", [lRepOnPeer.id, lJunior.id]],
      ["BRANCH", [lRepOnPeer.id, lJunior.id, lBranchmate.id]],
      ["ALL", fixture.leads],
      ["FOLLOW", [lJunior.id, lUnowned.id]],
    ];
    for (const [level, expected] of leadExpect) {
      await roleLevel("leads", "view", level);
      await expectReach(`${level}`, rep.id, "leads", expected);
    }
    await roleLevel("companies", "view", "ALL");
    await roleLevel("vendors", "view", "ALL");
    await expectReach("FOLLOW, with every account reachable: every lead", rep.id, "leads", fixture.leads);
    await clearLevels();

    section("Orders, level by level — own means whoever added it");
    const orderExpect: [Level, string[]][] = [
      ["NONE", []],
      ["OWN", [oRepOnPeer.id]],
      ["TEAM", [oRepOnPeer.id, oJunior.id]],
      ["BRANCH", [oRepOnPeer.id, oJunior.id, oBranchmate.id]],
      ["ALL", fixture.orders],
      ["FOLLOW", [oJunior.id, oPeerOnRep.id]],
    ];
    for (const [level, expected] of orderExpect) {
      await roleLevel("orders", "view", level);
      await expectReach(`${level}`, rep.id, "orders", expected);
    }
    await clearLevels();

    section("Documents, level by level — own means its salesperson or whoever raised it; branch is the document's");
    const docExpect: [Level, string[]][] = [
      ["NONE", []],
      ["OWN", [dRepInBranch.id, dRaisedByRep.id]],
      ["TEAM", [dRepInBranch.id, dRaisedByRep.id, dJunior.id]],
      ["BRANCH", [dRepInBranch.id]],
      ["ALL", fixture.documents],
      ["FOLLOW", [dJunior.id, dOnRepsCustomer.id]],
    ];
    for (const [level, expected] of docExpect) {
      await roleLevel("documents", "view", level);
      await expectReach(`${level}`, rep.id, "documents", expected);
    }
    await roleLevel("documents", "view", "BRANCH");
    await expectReach("BRANCH for somebody at the head office: documents with no branch recorded count as the head office's", peer.id, "documents", [dPeerAtHead.id, dJunior.id, dRaisedByRep.id, dOnRepsCustomer.id]);
    await clearLevels();

    section("Payments, level by level — own means whoever recorded it; branch is the payment's");
    const payExpect: [Level, string[]][] = [
      ["NONE", []],
      ["OWN", [pRepInBranch.id]],
      ["TEAM", [pRepInBranch.id, pJunior.id]],
      ["BRANCH", [pRepInBranch.id]],
      ["ALL", fixture.payments],
      ["FOLLOW", [pJunior.id, pOnRepsCustomer.id]],
    ];
    for (const [level, expected] of payExpect) {
      await roleLevel("payments", "view", level);
      await expectReach(`${level}`, rep.id, "payments", expected);
    }
    await clearLevels();

    section("Contacts — nobody's, the account's, or everybody's");
    const contactExpect: [Level, string[]][] = [
      ["NONE", []],
      ["FOLLOW", [kRep.id]],
      ["ALL", fixture.contacts],
    ];
    for (const [level, expected] of contactExpect) {
      await roleLevel("contacts", "view", level);
      await expectReach(`${level}`, rep.id, "contacts", expected);
    }
    await roleLevel("contacts", "view", "OWN");
    await expectReach("a level contacts don't offer (OWN) answers nothing — corrupt access data hides", rep.id, "contacts", []);
    await clearLevels();

    // ── Actions under actions ─────────────────────────────────────────────────────────────────────
    section("You can only change what you can see");
    await roleLevel("leads", "view", "OWN");
    await roleLevel("leads", "edit", "ALL");
    await expectReach("leads view OWN, edit ALL: edit reaches only what view does", rep.id, "leads", [lRepOnPeer.id], "edit");
    await roleLevel("leads", "view", "ALL");
    await roleLevel("leads", "edit", "OWN");
    await roleLevel("leads", "delete", "ALL");
    await expectReach("edit OWN, delete ALL: delete reaches only what edit does", rep.id, "leads", [lRepOnPeer.id], "delete");
    await roleLevel("leads", "assign", "TEAM");
    await expectReach("assign TEAM under edit OWN: only the rep's own", rep.id, "leads", [lRepOnPeer.id], "assign");
    await clearLevels();
    await roleLevel("companies", "edit", "OWN");
    await roleLevel("vendors", "edit", "OWN");
    await expectReach("accounts view TEAM (derived), edit OWN: edits only the rep's own", rep.id, "companies", [cRep.id, vRep.id], "edit");
    ok("  one company at a time: the junior's customer is seen but not editable", (await scope.canSeeCompany(rep.id, cJunior)) && !(await access.mayAccessAccount(rep.id, "edit", cJunior)) && (await access.mayAccessAccount(rep.id, "edit", cRep)));
    await roleLevel("contacts", "view", "FOLLOW");
    await roleLevel("contacts", "edit", "FOLLOW");
    ok("  contacts following the account follow its edit level too", (await access.mayAccessContactsOf(rep.id, "edit", cRep)) && !(await access.mayAccessContactsOf(rep.id, "edit", cJunior)) && (await access.mayAccessContactsOf(rep.id, "view", cJunior)));
    await clearLevels();

    // ── Who wins ──────────────────────────────────────────────────────────────────────────────────
    section("A person's own level, and the people who reach nothing");
    await roleLevel("leads", "view", "NONE");
    await db.userAccessLevel.create({ data: { userId: rep.id, record: "leads", action: "view", level: "ALL", reason: TAG } });
    await expectReach("the rep's own ALL beats the role's NONE", rep.id, "leads", fixture.leads);
    await expectReach("  and is the rep's alone — the junior keeps the role's NONE", junior.id, "leads", []);
    const own = await access.explainAccess(rep.id, "leads", "view");
    ok("  explained as the person's own level", own.source.via === "userLevel" && own.source.reason === TAG);
    await db.userAccessLevel.update({ where: { user_record_action: { userId: rep.id, record: "leads", action: "view" } }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await expectReach("an expired own level no longer counts — back to the role's", rep.id, "leads", []);
    await clearLevels();

    await roleLevel("leads", "view", "ALL");
    await db.user.update({ where: { id: peer.id }, data: { active: false } });
    await expectReach("a deactivated person reaches nothing, whatever the role says", peer.id, "leads", []);
    ok("  not even the accounts they managed", (await listed(peer.id, "companies")).length === 0 && !(await scope.canSeeCompany(peer.id, cPeer)));
    await db.user.update({ where: { id: peer.id }, data: { active: true } });
    await clearLevels();

    const automation = await db.user.findFirst({ where: { kind: "AUTOMATION" }, select: { id: true } });
    if (automation) {
      ok("the Automation account reaches nothing", (await access.accessLevel(automation.id, "companies", "view")) === "NONE" && (await listed(automation.id, "companies")).length === 0);
    } else {
      ok("(no Automation account in this workspace — not checked)", true);
    }
    const superAdmin = await db.user.findFirst({ where: { isSuperAdmin: true, active: true }, select: { id: true } });
    if (superAdmin) {
      const sa = await access.explainAccess(superAdmin.id, "payments", "delete");
      ok("the super admin reaches everything, whatever is stored", sa.level === "ALL" && sa.source.via === "superAdmin");
    }
  } finally {
    await cleanup();
    const left = (await db.user.count({ where: { email: { endsWith: MAIL } } })) + (await db.company.count({ where: { name: { startsWith: TAG } } })) + (await db.role.count({ where: { key: ROLE } }));
    ok("nothing of the fixture is left behind", left === 0, left);
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll access-level checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
