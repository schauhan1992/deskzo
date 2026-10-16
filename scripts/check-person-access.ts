/**
 * One person's access, and a role's life, end to end — the actions behind a person's page and the
 * role header (src/actions/person-access.ts, src/actions/role.ts) and the guard every new account
 * passes (src/lib/authz/guards.ts `assertMayStartInRole`).
 *
 *   1. Exceptions: Allow, Deny and Use role default, with a reason and an end date; an ended one
 *      answers nothing; nobody changes their own, the super admin's, or hands out what they don't hold
 *      — and a refusal on one change writes none of them.
 *   2. A person's own reach: within the giver's own, and never an edit wider than the view.
 *   3. Reset to role defaults: every kind of exception removed, recorded once; refused where removing
 *      a denial would hand out what the giver doesn't hold.
 *   4. The permission preview: a role's, and one person's with their exceptions.
 *   5. Switching a role off: not a built-in one, not one somebody holds; and a role switched off
 *      underneath somebody grants them nothing.
 *   6. Duplicating a role: everything it grants, reaches and masks, nobody moved — and refused, with
 *      nothing left behind, where the copy would hold more than the copier.
 *   7. A new account starts in a role only if its creator holds everything that role grants.
 *
 * On a scratch database built from the migrations and dropped at the end; the real workspace is not
 * touched.
 *
 *   npm run check:person-access
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";

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

// ── Stand-ins: who is calling; no mail and no control plane ─────────────────────────────────────
type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
const internals = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) return session;
  if (request === "@/lib/platform/account-hooks" || request.endsWith("lib/platform/account-hooks")) return { accountsChanged: async () => {} };
  return realLoad.call(this, request, parent, isMain);
} as typeof realLoad;

async function run(db: PrismaClient) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const person = require("../src/actions/person-access") as typeof import("../src/actions/person-access");
  const roles = require("../src/actions/role") as typeof import("../src/actions/role");
  const users = require("../src/actions/user") as typeof import("../src/actions/user");
  const perms = require("../src/actions/permission") as typeof import("../src/actions/permission");
  const levels = require("../src/actions/access-levels") as typeof import("../src/actions/access-levels");
  const fields = require("../src/actions/field-access") as typeof import("../src/actions/field-access");
  const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
  const { roleGrants } = require("../src/lib/authz/role-permission") as typeof import("../src/lib/authz/role-permission");
  const { PERMISSIONS } = require("../src/lib/permissions") as typeof import("../src/lib/permissions");
  const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
  const { permissionsOfModule } = require("../src/lib/staff/access-modules") as typeof import("../src/lib/staff/access-modules");
  /* eslint-enable @typescript-eslint/no-require-imports */
  mailer.setTestPlatformMailer(async () => {});

  // ── People ──────────────────────────────────────────────────────────────────────────────────────
  const LEAD_ROLE = "ZZ_TEAM_LEAD";
  await db.role.create({ data: { key: LEAD_ROLE, name: "Team lead" } });
  // A team lead may change permissions, but holds only a little: leads, contacts, the access screens.
  for (const permission of ["permissions.view", "permissions.manage", "users.manage", "leads.view", "contacts.view"]) {
    await db.rolePermission.create({ data: { role: LEAD_ROLE, permission, allowed: true } });
  }
  const make = (key: string, role: string, extra: object = {}) =>
    db.user.create({ data: { name: `Zz ${key}`, email: `${key.toLowerCase()}@zz-person.invalid`, role, passwordHash: "x".repeat(60), ...extra } });
  const superAdmin = await make("Owner", "ADMIN", { isSuperAdmin: true });
  const admin = await make("Admin", "ADMIN");
  const lead = await make("Lead", LEAD_ROLE);
  const rep = await make("Rep", "SALES");
  const as = (u: { id: string; name: string; email: string; role: string }) => {
    actor = { id: u.id, name: u.name, email: u.email, role: u.role };
  };
  const history = (where: object) => db.permissionChange.count({ where });

  section("1. Exceptions: Allow, Deny and Use role default");
  as(admin);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const allowed = await person.setPersonPermissions(rep.id, [{ key: "payments.record", state: "allow" }], { reason: "Covering collections this week", expiresAt: tomorrow });
  ok("an admin allows the rep to record payments, with a reason and an end date", allowed.ok && (await can(rep.id, "payments.record")), allowed);
  const row = await db.userPermission.findUnique({ where: { user_permission: { userId: rep.id, permission: "payments.record" } } });
  ok("  stored with its reason, ending at the end of that day", row?.reason === "Covering collections this week" && row?.expiresAt !== null && row!.expiresAt!.getTime() > Date.now());
  ok("  and in the permission history", (await history({ subjectUserId: rep.id, permission: "payments.record", changeKind: "GRANT" })) === 1);
  const denied = await person.setPersonPermissions(rep.id, [{ key: "leads.view", state: "deny" }]);
  ok("a deny beats the role: the rep no longer sees leads", denied.ok && !(await can(rep.id, "leads.view")));
  const back = await person.setPersonPermissions(rep.id, [
    { key: "payments.record", state: "inherit" },
    { key: "leads.view", state: "inherit" },
  ]);
  ok("Use role default removes both exceptions", back.ok && back.data.changed === 2 && (await db.userPermission.count({ where: { userId: rep.id } })) === 0);
  ok("  and the rep holds what Sales holds again", (await can(rep.id, "leads.view")) && !(await can(rep.id, "payments.record")));
  await db.userPermission.create({ data: { userId: rep.id, permission: "payments.record", allowed: true, expiresAt: new Date(Date.now() - 60_000) } });
  ok("an exception that has ended answers nothing", !(await can(rep.id, "payments.record")));
  await db.userPermission.deleteMany({ where: { userId: rep.id } });

  as(lead);
  const before = await db.userPermission.count({ where: { userId: rep.id } });
  const tooMuch = await person.setPersonPermissions(rep.id, [
    { key: "contacts.view", state: "deny" },
    { key: "payments.record", state: "allow" },
  ]);
  ok("a team lead can't hand out what they don't hold", !tooMuch.ok && /don't hold/i.test(tooMuch.ok ? "" : tooMuch.error), tooMuch);
  ok("  and the change before it wasn't written either", (await db.userPermission.count({ where: { userId: rep.id } })) === before);
  const own = await person.setPersonPermissions(lead.id, [{ key: "leads.view", state: "deny" }]);
  ok("nobody changes their own", !own.ok && /your own/i.test(own.ok ? "" : own.error), own);
  const onOwner = await person.setPersonPermissions(superAdmin.id, [{ key: "leads.view", state: "deny" }]);
  ok("nor the super admin's", !onOwner.ok, onOwner);
  as(admin);
  const superOnly = await person.setPersonPermissions(rep.id, [{ key: "impersonation.use", state: "allow" }]);
  ok("an ordinary admin can't grant what only a super admin grants", !superOnly.ok && !(await can(rep.id, "impersonation.use")), superOnly);
  const unknown = await person.setPersonPermissions(rep.id, [{ key: "payroll.everything", state: "allow" }]);
  ok("an unknown permission is refused", !unknown.ok);
  const sneaky = await person.setPersonPermissions(rep.id, [{ key: "leads.view", state: "sideways" as "allow" }]);
  ok("and so is a state that isn't one", !sneaky.ok);

  section("2. A person's own reach");
  const grid = (await person.personAccessGrid(rep.id))!;
  const leads = grid.find((r) => r.key === "leads")!;
  ok("the grid shows the rep's reach on leads as their role's", leads.cells.view.own === null && leads.cells.view.effective === leads.cells.view.role, leads.cells.view);
  const widened = await person.setPersonAccessLevels(rep.id, [{ record: "leads", action: "view", level: "ALL" }], { reason: "Covering the region" });
  const after = (await person.personAccessGrid(rep.id))!.find((r) => r.key === "leads")!;
  ok("an admin gives the rep every lead to look at", widened.ok && after.cells.view.own?.level === "ALL" && after.cells.view.effective === "ALL", widened);
  const wider = await person.setPersonAccessLevels(rep.id, [
    { record: "companies", action: "view", level: "OWN" },
    { record: "companies", action: "edit", level: "ALL" },
  ]);
  ok("an edit wider than the view is refused", !wider.ok && /wider than/i.test(wider.ok ? "" : wider.error), wider);
  as(lead);
  const beyond = await person.setPersonAccessLevels(rep.id, [{ record: "companies", action: "view", level: "ALL" }]);
  ok("a team lead can't give a reach wider than their own", !beyond.ok && /yourself/i.test(beyond.ok ? "" : beyond.error), beyond);

  section("3. Reset to role defaults");
  as(superAdmin);
  // An allow, and a deny on something Sales holds that the team lead doesn't: removing that deny would
  // hand it back, which is handing it out.
  await person.setPersonPermissions(rep.id, [
    { key: "payments.record", state: "allow" },
    { key: "products.edit", state: "deny" },
  ], { reason: "probe" });
  await fields.setPersonFieldAccess(rep.id, [{ field: "email", policy: { view: true, maskInList: true, maskInDetail: true, unmask: false, format: "email" } }], { reason: "probe" });
  await fields.setPersonUnmaskLimit(rep.id, { limited: true, dailyLimit: 5 }, { reason: "probe" });
  const counts = async () => ({
    permissions: await db.userPermission.count({ where: { userId: rep.id } }),
    levels: await db.userAccessLevel.count({ where: { userId: rep.id } }),
    fields: await db.userFieldPolicy.count({ where: { userId: rep.id } }),
    limit: await db.userUnmaskLimit.count({ where: { userId: rep.id } }),
  });
  const had = await counts();
  ok("the rep has an exception of every kind", had.permissions > 0 && had.levels > 0 && had.fields > 0 && had.limit > 0, had);
  as(lead);
  const leadReset = await person.resetPersonToRole(rep.id);
  ok("a team lead can't reset away a denial of something they don't hold", !leadReset.ok && /Can't reset/.test(leadReset.ok ? "" : leadReset.error), leadReset);
  ok("  and nothing was removed", JSON.stringify(await counts()) === JSON.stringify(had));
  as(admin);
  const reset = await person.resetPersonToRole(rep.id);
  const left = await counts();
  ok("an admin's reset removes every one of them", reset.ok && reset.data.removed === had.permissions + had.levels + had.fields + had.limit && Object.values(left).every((n) => n === 0), { reset, left });
  ok("  recorded as a reset", (await history({ subjectUserId: rep.id, changeKind: "RESET_TO_DEFAULT" })) >= 1);
  ok("  and the rep holds exactly their role again", !(await can(rep.id, "payments.record")) && (await can(rep.id, "products.edit")) && (await can(rep.id, "leads.view")));
  ok("  their role untouched", (await db.user.findUnique({ where: { id: rep.id }, select: { role: true } }))?.role === "SALES");

  section("4. The permission preview");
  const salesPreview = (await person.accessPreview({ role: "SALES" }))!;
  ok("a role's preview gives every module a standing", salesPreview.length > 5 && salesPreview.every((m) => ["full", "limited", "none"].includes(m.standing)));
  // A module Sales has nothing in, and one permission in it an admin may hand out.
  const repBefore = (await person.accessPreview({ userId: rep.id }))!;
  const closed = repBefore.find((m) => m.standing === "none" && permissionsOfModule(m.key).some((d) => !d.superAdminOnly));
  const key = closed ? permissionsOfModule(closed.key).find((d) => !d.superAdminOnly)!.key : "";
  ok("the rep has a module with no access at all", !!closed, repBefore.map((m) => `${m.key}:${m.standing}`));
  const opened = await person.setPersonPermissions(rep.id, [{ key, state: "allow" }]);
  const repAfter = (await person.accessPreview({ userId: rep.id }))!;
  const standing = repAfter.find((m) => m.key === closed?.key)?.standing;
  ok("a person's preview counts their exceptions: one granted in it, and it isn't No access any more", opened.ok && standing !== "none" && standing !== undefined, { module: closed?.key, key, standing });
  await person.setPersonPermissions(rep.id, [{ key, state: "inherit" }]);
  as(rep);
  ok("somebody who may not review access gets no preview", (await person.accessPreview({ role: "ADMIN" })) === null);

  section("5. Switching a role off");
  as(admin);
  const builtIn = await roles.setRoleActive("SALES", false);
  ok("a built-in role stays on", !builtIn.ok && (await can(rep.id, "leads.view")), builtIn);
  const held = await roles.setRoleActive(LEAD_ROLE, false);
  ok("a role somebody holds can't be switched off", !held.ok && /Move them/i.test(held.ok ? "" : held.error), held);
  const spare = await roles.createRole({ name: "Zz Spare" });
  const off = spare.ok ? await roles.setRoleActive(spare.data.key, false) : spare;
  // `active` is read by name, as the app reads it: a column added since some workspaces last migrated.
  ok("a custom role nobody holds is switched off", off.ok && (await db.role.findUnique({ where: { key: spare.ok ? spare.data.key : "" }, select: { active: true } }))?.active === false, off);
  ok("  and that is in the history", (await history({ subjectRole: spare.ok ? spare.data.key : "", changeKind: "ROLE_DEACTIVATED" })) === 1);
  const newcomer = spare.ok ? await users.createUser({ name: "Zz Newcomer", email: "newcomer@zz-person.invalid", role: spare.data.key }) : spare;
  ok("nobody new starts in a switched-off role", !newcomer.ok, newcomer);
  const on = spare.ok ? await roles.setRoleActive(spare.data.key, true) : spare;
  ok("and it can be switched on again", on.ok && (await history({ subjectRole: spare.ok ? spare.data.key : "", changeKind: "ROLE_ACTIVATED" })) === 1, on);
  // The backstop: a role switched off underneath somebody, as an import or a hand edit could leave it.
  await db.role.update({ where: { key: LEAD_ROLE }, data: { active: false } });
  ok("a role switched off underneath somebody grants them nothing", !(await can(lead.id, "leads.view")) && !(await can(lead.id, "permissions.manage")));
  await db.role.update({ where: { key: LEAD_ROLE }, data: { active: true } });
  ok("  until it is switched on again", await can(lead.id, "permissions.manage"));

  section("6. Duplicating a role");
  as(superAdmin);
  await levels.setRoleAccessLevels("SALES", [{ record: "leads", action: "view", level: "TEAM" }]);
  await fields.setRoleFieldAccess("SALES", [{ field: "phone", policy: { view: true, maskInList: true, maskInDetail: true, unmask: true, format: "phone_last4" } }]);
  await fields.setRoleUnmaskLimit("SALES", 25);
  as(admin);
  const copy = await roles.duplicateRole({ from: "SALES", name: "Zz Sales copy" });
  ok("an admin duplicates Sales", copy.ok, copy);
  if (copy.ok) {
    const [a, b] = await Promise.all([roleGrants("SALES"), roleGrants(copy.data.key)]);
    const differ = PERMISSIONS.filter((p) => a(p.key) !== b(p.key)).map((p) => p.key);
    ok("  the copy grants exactly what Sales grants", differ.length === 0, differ);
    const reach = await db.roleAccessLevel.findMany({ where: { role: copy.data.key }, select: { record: true, action: true, level: true } });
    ok("  reaches as Sales does", reach.some((r) => r.record === "leads" && r.action === "view" && r.level === "TEAM"), reach);
    const masked = await db.roleFieldPolicy.findUnique({ where: { role_entity_field: { role: copy.data.key, entity: "leads", field: "phone" } } });
    ok("  masks as Sales does", masked?.maskInList === true && masked?.format === "phone_last4");
    ok("  with Sales's daily limit", (await db.roleUnmaskLimit.findUnique({ where: { role: copy.data.key } }))?.dailyLimit === 25);
    ok("  and nobody moved to it", (await db.user.count({ where: { role: copy.data.key } })) === 0);
  }
  as(lead);
  const rolesBefore = await db.role.count();
  const leadCopy = await roles.duplicateRole({ from: "SALES", name: "Zz Lead's copy" });
  ok("a team lead can't copy a role that holds more than they do", !leadCopy.ok, leadCopy);
  ok("  and nothing is left behind", (await db.role.count()) === rolesBefore);

  section("7. A new account's role");
  as(lead);
  const salesAccount = await users.createUser({ name: "Zz Seller", email: "seller@zz-person.invalid", role: "SALES" });
  ok("a team lead can't start somebody in a role that holds more than they do", !salesAccount.ok && /don't hold/i.test(salesAccount.ok ? "" : salesAccount.error), salesAccount);
  const peer = await users.createUser({ name: "Zz Peer", email: "peer@zz-person.invalid", role: LEAD_ROLE });
  ok("  but can in their own", peer.ok, peer);
  as(admin);
  const custom = copy.ok ? await users.createUser({ name: "Zz Custom", email: "custom@zz-person.invalid", role: copy.data.key }) : copy;
  ok("an admin starts somebody in a custom role", custom.ok, custom);
  if (custom.ok && copy.ok) ok("  who holds what it grants", (await can(custom.data.id, "leads.view")) === (await roleGrants(copy.data.key))("leads.view"));
  void perms;
}

async function main() {
  const realUrl = process.env.DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_personaccess`;
  const scratchUrl = withDatabase(realUrl, scratchName);
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
  console.log(failures === 0 ? `\nAll ${passes} person and role access checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
