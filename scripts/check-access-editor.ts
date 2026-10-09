/**
 * check:access-editor — the role editor's record grid (src/actions/access-levels.ts), phase 2 of
 * docs/permission-redesign.md.
 *
 * A probe role with one member, and three people to drive the editor: an admin who reaches every
 * record and may change roles, a manager who may change roles but reaches only their team's accounts,
 * and a reviewer who may only look. It proves:
 *
 *   · the grid reads every record type, every cell following its permissions until somebody chooses;
 *   · a saved level is what the role's members then reach, and "back to its permissions" removes it;
 *   · the grid's own rules — a level the record type doesn't offer, and Edit, Delete or Assign wider
 *     than the cell above — refuse the whole save, with nothing written;
 *   · the role rules — nobody but a super admin edits Admin, platform support's read-only role is
 *     fixed, a reviewer can't save, and nobody gives a role more than they reach themselves;
 *   · every change lands in the permission history, and a member's My access says where it came from.
 *
 *   npm run check:access-editor
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor = { id: "", role: "SALES" };
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actor.id, role: actor.role, name: "Zzprobe Editor", email: `actor${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const ROLE = "ZZPROBE_ED";
const MAIL = "@zzprobe-editor.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const userIds = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  await db.permissionChange.deleteMany({ where: { OR: [{ actorUserId: { in: userIds } }, { subjectRole: ROLE }] } });
  await db.roleAccessLevel.deleteMany({ where: { role: ROLE } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.rolePermission.deleteMany({ where: { role: ROLE } });
  await db.role.deleteMany({ where: { key: ROLE } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const editor = require("../src/actions/access-levels") as typeof import("../src/actions/access-levels");
  const { explainAccess } = require("../src/lib/authz/access") as typeof import("../src/lib/authz/access");
  const { RecordAccessGrid } = require("../src/components/settings/staff/record-access-grid") as typeof import("../src/components/settings/staff/record-access-grid");
  const { createElement } = require("react") as typeof import("react");
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  /* eslint-enable @typescript-eslint/no-require-imports */

  await cleanup();
  try {
    section("The fixture");
    await db.role.create({ data: { key: ROLE, name: "Zzprobe editor role" } });
    const person = (key: string, role: string) =>
      db.user.create({ data: { name: `Zzprobe ${key}`, email: `${key.toLowerCase()}${MAIL}`, role, passwordHash: "x".repeat(60) } });
    const member = await person("Member", ROLE);
    const admin = await person("Admin", "SALES");
    const narrow = await person("Narrow", "SALES");
    const reviewer = await person("Reviewer", "SALES");
    const grant = (userId: string, permission: string, allowed = true) =>
      db.userPermission.create({ data: { userId, permission, allowed, reason: ROLE } });
    // What each needs, by name, whatever this database's SALES role holds.
    for (const key of ["permissions.manage", "permissions.view", "companies.viewAll", "contacts.view", "leads.view", "orders.view", "documents.view", "payments.view"]) {
      await grant(admin.id, key);
    }
    for (const key of ["permissions.manage", "permissions.view", "contacts.view", "leads.view", "orders.view", "documents.view", "payments.view"]) await grant(narrow.id, key);
    await grant(narrow.id, "companies.viewAll", false);
    await grant(reviewer.id, "permissions.view");
    await grant(reviewer.id, "permissions.manage", false);
    // The probe role holds "View documents" and nothing that widens accounts.
    await db.rolePermission.create({ data: { role: ROLE, permission: "documents.view", allowed: true } });
    await db.rolePermission.create({ data: { role: ROLE, permission: "companies.viewAll", allowed: false } });
    ok("a probe role with a member, an admin, a narrow manager and a reviewer", true);

    section("Reading the grid");
    actor = { id: admin.id, role: "SALES" };
    const grid = await editor.roleAccessLevels(ROLE);
    ok("every record type is a row", grid?.rows.length === 7, grid?.rows.map((r) => r.key).join(", "));
    ok("nothing is stored until somebody chooses", !!grid && grid.rows.every((r) => Object.values(r.cells).every((c) => c.stored === null)));
    const docs = grid?.rows.find((r) => r.key === "documents");
    ok("documents follow the account, from \"View documents\"", docs?.cells.view.derived === "FOLLOW" && docs.cells.view.derivedFrom.held === true, docs?.cells.view.derived);
    const accounts = grid?.rows.find((r) => r.key === "companies");
    ok("customers are the team's, without \"See all companies\"", accounts?.cells.view.derived === "TEAM", accounts?.cells.view.derived);
    ok("contacts offer none, as the account, or all", JSON.stringify(grid?.rows.find((r) => r.key === "contacts")?.levels) === JSON.stringify(["NONE", "FOLLOW", "ALL"]));
    ok("the admin may edit it", grid?.editable === true, grid?.why ?? "");
    // The grid as the role dialog draws it — nobody signs in to look, so the HTML is the proof.
    const html = grid ? renderToStaticMarkup(createElement(RecordAccessGrid, { rows: grid.rows, choices: new Map(), lockedWhy: null, disabled: false, onChange: () => {} })) : "";
    ok("the grid draws a choice for every cell", (html.match(/data-access-slot=/g) ?? []).length === 28, (html.match(/data-access-slot=/g) ?? []).length);
    ok("...each starting at its permissions, saying what that is", html.includes("As its permissions — Team") && html.includes("As its permissions — As the account"));
    const contactsView = html.slice(html.indexOf("data-access-slot=\"contacts:view\""));
    const contactsSelect = contactsView.slice(0, contactsView.indexOf("</select>"));
    ok("...and contacts offer only none, as the account, or all", contactsSelect.length > 0 && !contactsSelect.includes(">Own<") && contactsSelect.includes(">As the account<"));

    section("Saving");
    const saved = await editor.setRoleAccessLevels(ROLE, [{ record: "documents", action: "view", level: "OWN" }, { record: "documents", action: "edit", level: "OWN" }]);
    ok("documents: View and Edit set to Own", saved.ok && saved.data.changed === 2, saved.ok ? saved.data.changed : saved.error);
    ok("...and the member now reaches their own documents only", (await explainAccess(member.id, "documents", "view")).level === "OWN");
    ok("...set on their role", (await explainAccess(member.id, "documents", "view")).source.via === "roleLevel");
    const history = await db.permissionChange.findMany({ where: { subjectRole: ROLE, permission: { startsWith: "access:documents" } } });
    ok("both changes are in the permission history", history.length === 2, history.map((h) => h.detail).join(" | "));
    const again = await editor.setRoleAccessLevels(ROLE, [{ record: "documents", action: "view", level: "OWN" }]);
    ok("saving what is already saved writes nothing", again.ok && again.data.changed === 0);
    const narrower = await editor.setRoleAccessLevels(ROLE, [{ record: "documents", action: "edit", level: "FOLLOW" }]);
    ok("Edit \"as the account\" under View \"Own\" is a narrowing, and allowed", narrower.ok, narrower.ok ? "" : narrower.error);
    const reset = await editor.setRoleAccessLevels(ROLE, [{ record: "documents", action: "view", level: null }, { record: "documents", action: "edit", level: null }]);
    ok("both back to following its permissions", reset.ok && reset.data.changed === 2, reset.ok ? "" : reset.error);
    ok("...the rows are gone", (await db.roleAccessLevel.count({ where: { role: ROLE } })) === 0);
    ok("...and the member follows the account again", (await explainAccess(member.id, "documents", "view")).level === "FOLLOW");
    ok("...which the history records as a reset", (await db.permissionChange.count({ where: { subjectRole: ROLE, changeKind: "RESET_TO_DEFAULT" } })) === 2);

    section("The grid's own rules, all or nothing");
    const offered = await editor.setRoleAccessLevels(ROLE, [{ record: "leads", action: "view", level: "ALL" }, { record: "contacts", action: "view", level: "OWN" }]);
    ok("a level contacts don't offer is refused", !offered.ok && offered.error.includes("Contacts"), offered.ok ? "it saved" : offered.error);
    ok("...and the leads change beside it wasn't written either", (await db.roleAccessLevel.count({ where: { role: ROLE } })) === 0);
    const tooWide = await editor.setRoleAccessLevels(ROLE, [{ record: "companies", action: "edit", level: "ALL" }]);
    ok("Edit All over View Team is refused", !tooWide.ok && tooWide.error.includes("can't be wider than View"), tooWide.ok ? "it saved" : tooWide.error);
    const overFollow = await editor.setRoleAccessLevels(ROLE, [{ record: "payments", action: "delete", level: "ALL" }]);
    ok("Delete All over Edit \"as the account\" is refused", !overFollow.ok && overFollow.error.includes("can't be wider than Edit"), overFollow.ok ? "it saved" : overFollow.error);
    const unknown = await editor.setRoleAccessLevels(ROLE, [{ record: "tickets", action: "view", level: "ALL" }]);
    ok("a record type the grid doesn't have is refused", !unknown.ok);

    section("Who may save what");
    actor = { id: reviewer.id, role: "SALES" };
    const asReviewer = await editor.roleAccessLevels(ROLE);
    ok("a reviewer reads the grid", (asReviewer?.rows.length ?? 0) === 7);
    ok("...not editable, and says why", asReviewer?.editable === false && (asReviewer.why ?? "").includes("review"), asReviewer?.why);
    const reviewerSave = await editor.setRoleAccessLevels(ROLE, [{ record: "leads", action: "view", level: "NONE" }]);
    ok("...and can't save", !reviewerSave.ok);
    actor = { id: narrow.id, role: "SALES" };
    const beyond = await editor.setRoleAccessLevels(ROLE, [{ record: "companies", action: "view", level: "ALL" }]);
    ok("a manager who reaches their team's accounts can't give a role all of them", !beyond.ok && beyond.error.includes("yourself"), beyond.ok ? "it saved" : beyond.error);
    const viewOnly = await editor.setRoleAccessLevels(ROLE, [{ record: "companies", action: "view", level: "OWN" }]);
    ok("...narrowing View alone, with Edit still the team's, is refused", !viewOnly.ok && viewOnly.error.includes("can't be wider than View"), viewOnly.ok ? "it saved" : viewOnly.error);
    const own = (["view", "edit", "delete", "assign"] as const).map((action) => ({ record: "companies", action, level: "OWN" as const }));
    const within = await editor.setRoleAccessLevels(ROLE, own);
    ok("...all four to Own — what the grid sends when View is narrowed — goes through", within.ok, within.ok ? "" : within.error);
    const adminRole = await editor.setRoleAccessLevels("ADMIN", [{ record: "leads", action: "view", level: "OWN" }]);
    ok("nobody but a super admin edits Admin", !adminRole.ok && adminRole.error.includes("super admin"), adminRole.ok ? "it saved" : adminRole.error);
    const support = await editor.setRoleAccessLevels("SUPPORT_READONLY", [{ record: "leads", action: "view", level: "NONE" }]);
    ok("platform support's read-only role is fixed", !support.ok, support.ok ? "it saved" : support.error);
    ok("no Admin or support row was written", (await db.roleAccessLevel.count({ where: { role: { in: ["ADMIN", "SUPPORT_READONLY"] } } })) === 0);

    section("What the member is told");
    actor = { id: member.id, role: ROLE };
    const mine = await editor.personAccessLevels(member.id);
    const companiesRow = mine?.find((r) => r.key === "companies");
    ok("My access shows the level set on their role", companiesRow?.cells.view.level === "OWN" && companiesRow.cells.view.why.includes("role"), companiesRow?.cells.view.why);
    ok("...and where the rest comes from", mine?.find((r) => r.key === "documents")?.cells.view.why.includes("which they hold") === true, mine?.find((r) => r.key === "documents")?.cells.view.why);
    ok("somebody else's is not theirs to read", (await editor.personAccessLevels(admin.id)) === null);
  } finally {
    await cleanup();
    const left = (await db.user.count({ where: { email: { endsWith: MAIL } } })) + (await db.role.count({ where: { key: ROLE } })) + (await db.roleAccessLevel.count({ where: { role: ROLE } }));
    ok("nothing of the fixture is left behind", left === 0, left);
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll access-editor checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
