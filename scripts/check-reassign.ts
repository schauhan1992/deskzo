/**
 * Who may move an account or a lead from one person to another.
 *
 * Two permissions — `accounts.reassign` (anything the holder can see) and `accounts.handOffOwn`
 * (only what is already theirs, and only to a person) — enforced in the actions and mirrored in the
 * screens. Every one of these used to be open to anybody signed in, by id; the worst of it was the
 * account manager, because the account manager *is* the account scope, so naming yourself was a way
 * to see any company.
 *
 * Probe users get explicit per-user grants and denials for exactly the keys that matter, so nothing
 * here depends on how the development database's roles happen to be configured. Everything is named
 * ZZPROBE_REASSIGN and removed in a finally.
 *
 *   npm run check:reassign
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";
import {
  mayChangeAccountManager,
  mayChangeCaller,
  mayChangeLeadOwner,
  mayLeaveUnassigned,
  type ReassignRights,
} from "../src/lib/authz/reassign-rules";
import { PERMISSION_REGISTRY } from "../src/lib/permissions";
import { ROLE_PRESETS } from "../src/lib/authz/presets";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => ({ id: actorId, role: "PROFILE" }), currentUser: async () => ({ id: actorId, role: "PROFILE" }) };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_REASSIGN";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: "@zzprobe-reassign.invalid" } }, select: { id: true } });
  const companies = await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const leads = await db.lead.findMany({ where: { companyId: { in: companies.map((c) => c.id) } }, select: { id: true } });
  await db.auditLog.deleteMany({
    where: { OR: [{ entityId: { in: [...companies.map((c) => c.id), ...leads.map((l) => l.id)] } }, { userId: { in: users.map((u) => u.id) } }] },
  });
  await db.company.deleteMany({ where: { id: { in: companies.map((c) => c.id) } } });
  await db.userPermission.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
  await db.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
}

async function main() {
  section("The rules");

  const any: ReassignRights = { any: true, own: false };
  const own: ReassignRights = { any: false, own: true };
  const none: ReassignRights = { any: false, own: false };
  const me = "me";
  const mine = { ownerUserId: me, assignedToUserId: "x" };
  const iCall = { ownerUserId: "x", assignedToUserId: me };
  const theirs = { ownerUserId: "x", assignedToUserId: "y" };
  ok("reassign may change any account's manager and caller", mayChangeAccountManager(any, me, theirs) && mayChangeCaller(any, me, theirs));
  ok("hand-off may change the manager of an account you manage", mayChangeAccountManager(own, me, mine));
  ok("  but not of one you only call", !mayChangeAccountManager(own, me, iCall));
  ok("  and may change the caller where you manage or call", mayChangeCaller(own, me, mine) && mayChangeCaller(own, me, iCall));
  ok("  but not on somebody else's account", !mayChangeAccountManager(own, me, theirs) && !mayChangeCaller(own, me, theirs));
  ok("a lead is yours to hand off only if you own it", mayChangeLeadOwner(own, me, { ownerUserId: me }) && !mayChangeLeadOwner(own, me, { ownerUserId: "x" }));
  ok("only reassign may leave something with nobody", mayLeaveUnassigned(any) && !mayLeaveUnassigned(own));
  ok("without either, nothing", !mayChangeAccountManager(none, me, mine) && !mayChangeCaller(none, me, iCall) && !mayChangeLeadOwner(none, me, { ownerUserId: me }));

  const reassignKey = PERMISSION_REGISTRY.find((p) => p.key === "accounts.reassign");
  const handOffKey = PERMISSION_REGISTRY.find((p) => p.key === "accounts.handOffOwn");
  ok("both are permissions an admin can grant", !!reassignKey && !!handOffKey);
  const preset = (key: string) => ROLE_PRESETS.find((p) => p.key === key)?.permissions as readonly string[] | undefined;
  ok(
    "the presets: managers reassign, salespeople hand off their own",
    !!preset("sales-manager")?.includes("accounts.reassign") &&
      !!preset("operations-manager")?.includes("accounts.reassign") &&
      !!preset("sales-executive")?.includes("accounts.handOffOwn") &&
      !preset("sales-executive")?.includes("accounts.reassign"),
  );

  section("Through the real actions");

  /* eslint-disable @typescript-eslint/no-require-imports */
  const companyActions = require("../src/actions/company") as typeof import("../src/actions/company");
  const leadActions = require("../src/actions/lead") as typeof import("../src/actions/lead");

  await cleanup();
  try {
    const make = (name: string, grants: Record<string, boolean>) =>
      db.user.create({
        data: {
          name: `Zzprobe ${name}`,
          email: `${name}@zzprobe-reassign.invalid`,
          role: "PROFILE",
          passwordHash: "x".repeat(60),
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
      });
    const deny = { "accounts.reassign": false, "accounts.handOffOwn": false, "companies.viewAll": false };
    const boss = await make("boss", { ...deny, "accounts.reassign": true, "companies.viewAll": true });
    const limited = await make("limited", { ...deny, "accounts.reassign": true });
    const rep = await make("rep", { ...deny, "accounts.handOffOwn": true, "companies.viewAll": true });
    const nobody = await make("nobody", { ...deny, "companies.viewAll": true });
    const other = await make("other", deny);

    const company = (name: string, ownerUserId: string, assignedToUserId: string | null = null) =>
      db.company.create({
        data: { name: `${TAG} ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), createdById: ownerUserId, ownerUserId, assignedToUserId },
      });
    const repCo = await company("repCo", rep.id);
    const repCo2 = await company("repCo2", rep.id);
    const otherCo = await company("otherCo", other.id);
    const callCo = await company("callCo", other.id, rep.id);
    const owner = async (id: string) => (await db.company.findUnique({ where: { id }, select: { ownerUserId: true } }))!.ownerUserId;
    const caller = async (id: string) => (await db.company.findUnique({ where: { id }, select: { assignedToUserId: true } }))!.assignedToUserId;

    // ── nobody ──
    actorId = nobody.id;
    const n1 = await companyActions.setCompanyOwner(otherCo.id, nobody.id);
    ok("without either permission, the account manager cannot be changed", !n1.ok && (await owner(otherCo.id)) === other.id, n1.ok ? "changed" : n1.error);
    const n2 = await companyActions.setCompanyCaller(otherCo.id, nobody.id);
    ok("  nor the caller", !n2.ok && (await caller(otherCo.id)) === null);
    const n3 = await companyActions.assignCompanies({ companyIds: [otherCo.id], userId: nobody.id });
    ok("  nor by the bulk action that has no screen", !n3.ok && (await caller(otherCo.id)) === null);

    // ── hand off your own ──
    actorId = rep.id;
    const r1 = await companyActions.setCompanyOwner(repCo.id, other.id);
    ok("an account manager hands their own account to a colleague", r1.ok && (await owner(repCo.id)) === other.id, r1.ok ? "" : r1.error);
    const audit = await db.auditLog.findFirst({ where: { entityId: repCo.id, userId: rep.id }, orderBy: { createdAt: "desc" } });
    ok("  and the activity log says who, from whom, to whom", /account manager: Zzprobe rep → Zzprobe other/.test(audit?.entityLabel ?? ""), audit?.entityLabel);
    const r2 = await companyActions.setCompanyOwner(repCo.id, rep.id);
    ok("  once handed over, it is not theirs to take back", !r2.ok && (await owner(repCo.id)) === other.id, r2.ok ? "taken back" : r2.error);
    const r3 = await companyActions.setCompanyOwner(repCo2.id, null);
    ok("  and handing off means to somebody — not leaving it with nobody", !r3.ok && (await owner(repCo2.id)) === rep.id, r3.ok ? "unassigned" : r3.error);
    const r4 = await companyActions.setCompanyCaller(callCo.id, other.id);
    ok("a caller hands on the account they were calling", r4.ok && (await caller(callCo.id)) === other.id, r4.ok ? "" : r4.error);
    const r5 = await companyActions.setCompanyOwner(otherCo.id, rep.id);
    ok("  but cannot touch somebody else's account manager", !r5.ok && /can't change who manages/.test(r5.error) && (await owner(otherCo.id)) === other.id);
    const r6 = await companyActions.setCompanyCaller(otherCo.id, rep.id);
    ok("  nor its caller", !r6.ok && (await caller(otherCo.id)) === null);
    const r7 = await companyActions.bulkUpdateCompanies({ companyIds: [repCo2.id, otherCo.id], assignedToUserId: other.id });
    ok(
      "a bulk change that includes one account not theirs is refused whole",
      !r7.ok && (await caller(repCo2.id)) === null && (await caller(otherCo.id)) === null,
      r7.ok ? "applied" : r7.error,
    );

    // ── reassign, and its limit ──
    actorId = limited.id;
    const l1 = await companyActions.setCompanyOwner(otherCo.id, limited.id);
    ok(
      "reassigning cannot reach an account you cannot see — naming yourself included",
      !l1.ok && l1.error === "Company not found." && (await owner(otherCo.id)) === other.id,
      "the account manager is the scope; this was the way round it",
    );
    const l2 = await companyActions.bulkUpdateCompanies({ companyIds: [otherCo.id], addTags: [TAG] });
    ok("  and the bulk action no longer tags accounts you cannot see", !l2.ok);

    actorId = boss.id;
    const b1 = await companyActions.setCompanyOwner(otherCo.id, rep.id);
    ok("somebody who can reassign moves any account they can see", b1.ok && (await owner(otherCo.id)) === rep.id);
    const b2 = await companyActions.setCompanyCaller(otherCo.id, null);
    const b3 = await companyActions.setCompanyOwner(otherCo.id, null);
    ok("  and may leave it with nobody", b2.ok && b3.ok && (await owner(otherCo.id)) === null);
    const b4 = await companyActions.bulkUpdateCompanies({ companyIds: [repCo2.id, otherCo.id], assignedToUserId: other.id });
    ok("  and change callers in bulk", b4.ok && (await caller(repCo2.id)) === other.id && (await caller(otherCo.id)) === other.id);
    // Two accounts changed caller in that bulk action, so two lines — and a clear that changed nothing
    // (otherCo had no caller) wrote none.
    const bulkAudit = await db.auditLog.count({
      where: { userId: boss.id, entityId: { in: [repCo2.id, otherCo.id] }, entityLabel: { contains: "caller: nobody → Zzprobe other" } },
    });
    ok("  each account's change logged on its own line", bulkAudit === 2, `${bulkAudit} caller lines`);

    // ── leads ──
    const repLead = await db.lead.create({ data: { companyId: repCo2.id, title: `${TAG} rep lead`, ownerUserId: rep.id } });
    const otherLead = await db.lead.create({ data: { companyId: repCo2.id, title: `${TAG} other lead`, ownerUserId: other.id } });
    const leadOwner = async (id: string) => (await db.lead.findUnique({ where: { id }, select: { ownerUserId: true } }))!.ownerUserId;

    actorId = rep.id;
    const k1 = await leadActions.bulkUpdateLeads({ leadIds: [repLead.id, otherLead.id], ownerUserId: other.id });
    ok("handing off leads that include one not yours is refused whole", !k1.ok && (await leadOwner(repLead.id)) === rep.id, k1.ok ? "applied" : k1.error);
    const k2 = await leadActions.bulkUpdateLeads({ leadIds: [repLead.id], ownerUserId: "unassign" });
    ok("  leaving your own lead with nobody is refused", !k2.ok && (await leadOwner(repLead.id)) === rep.id);
    const k3 = await leadActions.bulkUpdateLeads({ leadIds: [repLead.id], ownerUserId: other.id });
    const leadAudit = await db.auditLog.findFirst({ where: { entityId: repLead.id, entityLabel: { contains: "owner:" } }, orderBy: { createdAt: "desc" } });
    ok("  handing your own lead to a colleague works, and is logged", k3.ok && (await leadOwner(repLead.id)) === other.id && /owner: Zzprobe rep → Zzprobe other/.test(leadAudit?.entityLabel ?? ""), leadAudit?.entityLabel);

    actorId = nobody.id;
    const k4 = await leadActions.bulkUpdateLeads({ leadIds: [otherLead.id], ownerUserId: nobody.id });
    ok("without either permission, no lead changes hands", !k4.ok && (await leadOwner(otherLead.id)) === other.id);

    actorId = boss.id;
    const k5 = await leadActions.bulkUpdateLeads({ leadIds: [otherLead.id, repLead.id], ownerUserId: "unassign" });
    ok("reassigning leads, including to nobody", k5.ok && (await leadOwner(otherLead.id)) === null);

    const created = await leadActions.createLead({ companyId: repCo2.id, title: `${TAG} for rep`, ownerUserId: rep.id });
    ok("reassigning also lets you choose the owner of a new lead", created.ok, created.ok ? "" : created.error);
  } finally {
    await cleanup();
  }
  ok("the fixture is gone", (await db.user.count({ where: { email: { endsWith: "@zzprobe-reassign.invalid" } } })) === 0);

  section("The screens offer only what will work");

  const src = (f: string) => readFileSync(f, "utf8");
  const detail = src("src/components/companies/company-detail.tsx");
  ok(
    "the company page decides the buttons with the same rules",
    /canChange=\{canChangeManager\}/.test(detail) && /canChange=\{canChangeCaller\}/.test(detail) && /mayChangeAccountManager\(reassign, userId, holders\)/.test(detail),
  );
  for (const f of ["src/components/companies/account-manager-button.tsx", "src/components/companies/caller-button.tsx"]) {
    const s = src(f);
    ok(`${f.split("/").pop()}: a label, not a button, without the right`, /if \(!canChange\)/.test(s) && /canUnassign && <option value="">Unassigned<\/option>/.test(s));
  }
  ok("the companies bulk bar shows the caller picker only to those who may", /\{reassign\.show && \(/.test(src("src/components/companies/companies-table.tsx")));
  ok("the leads bulk bar the owner picker likewise", /\{reassign\.show && \(/.test(src("src/components/leads/leads-list-table.tsx")));
  const pages = ["companies", "customers", "vendors", "commission-parties", "leads"].filter(
    (p) => !/reassign=\{await viewerReassignControls\(\)\}/.test(src(`src/app/(dashboard)/${p}/page.tsx`)),
  );
  ok("  and every list page passes the viewer's rights", pages.length === 0, pages.join(", "));

  await db.$disconnect();
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nAll reassignment checks passed." : `\n${failures} failed.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => {});
    await db.$disconnect();
    process.exit(1);
  });
