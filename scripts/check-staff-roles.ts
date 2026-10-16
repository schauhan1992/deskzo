/**
 * Settings › Staff: Users and Roles & Permissions — what was Staff & roles, rebuilt as the owner's
 * mockup, each a page of its own.
 *
 *   1. The pieces without a page: a person's status, "58m ago", which module a permission needs.
 *   2. Users: the list (All / Active / Inactive), one person open — their header, Profile with the open
 *      leads and job title, Login & Access with the last sign-in and the account's actions — as an admin
 *      and as a read-only reviewer; and every retired Staff & roles link lands where it moved.
 *   3. Switching somebody off works, never deletes, and is refused for yourself and for the super admin.
 *   4. Add staff creates an account with a setup link and no password — and keeps `createUser`'s old
 *      callers working.
 *   5. Saving a role writes exactly the boxes ticked (a permission's wider reach is its own box), all
 *      or nothing, and nobody can take away their own way into these screens.
 *   6. A role's Module Access, as a read-only reviewer and as an admin: the reasons a box can't change;
 *      and the server refuses a reviewer anyway.
 *   7. Roles & Permissions: the roles beside the one open, its tabs and header; the permission matrix,
 *      with the exceptions and who-holds-what under it.
 *
 * The real actions and the real pages, with the session, `next/cache`, `next/navigation`, the dialog's
 * portal and the platform account hooks substituted. No mail leaves (the platform mailer is
 * replaced), no password is typed or set — fixtures that can "sign in" hold a placeholder nothing
 * matches. Everything is named ZZSTAFF / @zzstaff-check.invalid and removed in a finally; assertions
 * are about the fixtures, never about how many people the database happens to hold.
 *
 * Set STAFF_RENDERS_DIR to keep the rendered HTML of each screen.
 *
 *   npm run check:staff-roles
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const TAG = "ZZSTAFF";
const MAIL = "@zzstaff-check.invalid";
const RENDERS = process.env.STAFF_RENDERS_DIR?.trim() || "";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

// ─── Stand-ins ───────────────────────────────────────────────────────────────────────────────────
let actorId = "";
const stubHits = { session: 0, dialog: 0, hooks: 0 };
const internals = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    stubHits.session += 1;
    class UnauthorizedError extends Error {}
    const user = () => (actorId ? { id: actorId, name: "Zz Probe", email: `probe${MAIL}`, role: "ADMIN" } : null);
    return {
      UnauthorizedError,
      requireUser: async () => {
        const u = user();
        if (!u) throw new UnauthorizedError("signed out");
        return u;
      },
      currentUser: async () => user(),
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    };
  }
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("NEXT_NOT_FOUND");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {}, prefetch() {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => "/settings/users",
    };
  }
  // The dialog portals into document.body, which a server render has none of. Its contents are what
  // is being checked, so it renders them in place — open or not, exactly as the real one decides.
  if (request === "@/components/ui/dialog" || request.endsWith("components/ui/dialog")) {
    stubHits.dialog += 1;
    return {
      Dialog: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
        open ? createElement("div", { role: "dialog", "aria-label": title, "data-dialog": "in-place" }, children) : null,
    };
  }
  // The control plane's email index and linked sign-in: nothing here should reach them.
  if (request === "@/lib/platform/account-hooks" || request.endsWith("lib/platform/account-hooks")) {
    stubHits.hooks += 1;
    return { accountsChanged: async () => {} };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

/** A server component tree with its nested async components awaited, so it can be rendered. */
async function resolveAsync(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: unknown }>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    return resolveAsync(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
  }
  if (el.props && "children" in el.props) {
    const kids = await resolveAsync(el.props.children);
    return Array.isArray(kids) ? cloneElement(el, undefined, ...(kids as ReactNode[])) : cloneElement(el, undefined, kids as ReactNode);
  }
  return el;
}

const html = (el: unknown) => renderToStaticMarkup(el as ReactElement);

function keep(name: string, markup: string) {
  if (!RENDERS) return;
  fs.mkdirSync(RENDERS, { recursive: true });
  const page = `<!doctype html><meta charset="utf-8"><title>${name}</title>\n${markup}\n`;
  fs.writeFileSync(path.join(RENDERS, `${name}.html`), page);
}

/** What a person reads: the markup without its tags, React's text separators or entities. */
function text(markup: string): string {
  return markup
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
}
const count = (markup: string, pattern: RegExp) => (markup.match(pattern) ?? []).length;

// ─── Main ────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  // Required here, after the stand-ins are in place: a top-of-file import would load these (and what
  // they import) before `Module._load` is replaced, and the real session would answer.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
  const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
  const { rolePermits } = require("../src/lib/authz/role-permission") as typeof import("../src/lib/authz/role-permission");
  const { PERMISSIONS, permissionGroup } = require("../src/lib/permissions") as typeof import("../src/lib/permissions");
  const { MODULE_REGISTRY } = require("../src/lib/modules") as typeof import("../src/lib/modules");
  const { noPasswordYet, AWAITING_SETUP } = require("../src/lib/no-password") as typeof import("../src/lib/no-password");
  const { indiaClock } = require("../src/lib/time/zone") as typeof import("../src/lib/time/zone");
  const { staffFacts } = require("../src/lib/staff/roster") as typeof import("../src/lib/staff/roster");
  const { staffStatus, relativeAgo } = require("../src/lib/staff/status") as typeof import("../src/lib/staff/status");
  const { permissionModules, moduleNote } = require("../src/lib/staff/permission-modules") as typeof import("../src/lib/staff/permission-modules");
  const { SETTINGS_ITEMS } = require("../src/lib/settings/catalogue") as typeof import("../src/lib/settings/catalogue");
  const USER = require("../src/actions/user") as typeof import("../src/actions/user");
  const ROLE = require("../src/actions/role") as typeof import("../src/actions/role");
  const PERM = require("../src/actions/permission") as typeof import("../src/actions/permission");
  const USERS = require("../src/app/(dashboard)/settings/users/page") as typeof import("../src/app/(dashboard)/settings/users/page");
  const ROLES = require("../src/app/(dashboard)/settings/roles/page") as typeof import("../src/app/(dashboard)/settings/roles/page");
  const MATRIX = require("../src/app/(dashboard)/settings/roles/matrix/page") as typeof import("../src/app/(dashboard)/settings/roles/matrix/page");
  const RETIRED = require("../src/app/(dashboard)/settings/access/page") as typeof import("../src/app/(dashboard)/settings/access/page");
  const RETIRED_PERSON = require("../src/app/(dashboard)/settings/access/users/[id]/page") as typeof import("../src/app/(dashboard)/settings/access/users/[id]/page");
  const ADD = require("../src/app/(dashboard)/settings/users/new/page") as typeof import("../src/app/(dashboard)/settings/users/new/page");
  const { RoleModulesWorkspace } = require("../src/components/settings/roles/role-modules-workspace") as typeof import("../src/components/settings/roles/role-modules-workspace");
  const { RoleRecordAccess } = require("../src/components/settings/roles/role-record-access") as typeof import("../src/components/settings/roles/role-record-access");
  const { actionRowsOf } = require("../src/lib/staff/access-modules") as typeof import("../src/lib/staff/access-modules");
  const { userPath, rolePath } = require("../src/lib/staff/staff-paths") as typeof import("../src/lib/staff/staff-paths");
  const { roleAccessLevels } = require("../src/actions/access-levels") as typeof import("../src/actions/access-levels");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const mail: { to: string; subject: string; text: string }[] = [];
  mailer.setTestPlatformMailer(async (m) => void mail.push(m));

  const renderUsers = async (sp: Record<string, string> = {}) => html(await resolveAsync(await USERS.default({ searchParams: Promise.resolve(sp) })));
  const renderRoles = async (sp: Record<string, string> = {}) => html(await resolveAsync(await ROLES.default({ searchParams: Promise.resolve(sp) })));
  /** Where a retired page sends you: the stand-in `redirect` throws with the address. */
  const landsOn = async (page: () => unknown) => {
    try {
      await page();
      return null;
    } catch (err) {
      return /^redirect (.*)$/.exec((err as Error).message)?.[1] ?? (err as Error).message;
    }
  };

  await cleanup(db);
  try {
    section("Set-up");
    ok("the session stand-in is the one the actions load", stubHits.session > 0);
    ok("the dialog renders in place, not into a portal", stubHits.dialog > 0);
    ok("the platform account hooks are stood in for", stubHits.hooks > 0);

    const superAdmin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true, name: true } });
    ok("there is a super admin to look at (borrowed, never changed)", superAdmin !== null);
    if (!superAdmin) return;

    // Two fixture roles: a reviewer who may only look, and a manager who may change roles but holds
    // only a few keys — the shape the dialog's refusals are about.
    const AUDITOR = `${TAG}_AUDITOR`;
    const MANAGER = `${TAG}_MANAGER`;
    await db.role.create({ data: { key: AUDITOR, name: `${TAG} Auditor`, sortOrder: 990 } });
    await db.role.create({ data: { key: MANAGER, name: `${TAG} Manager`, sortOrder: 991 } });
    await db.rolePermission.createMany({
      data: [
        { role: AUDITOR, permission: "permissions.view", allowed: true },
        ...["permissions.view", "permissions.manage", "tickets.create", "leads.view", "visits.view"].map((permission) => ({
          role: MANAGER,
          permission,
          allowed: true,
        })),
      ],
    });

    // A placeholder nothing can match — not a password, and nobody's. Not "awaiting setup" either.
    const signedUp = "zz-fixture-placeholder";
    const mk = (name: string, local: string, role: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name, email: `${local}${MAIL}`, role, passwordHash: signedUp, ...extra }, select: { id: true, name: true } });
    const admin = await mk(`${TAG} Admin`, "admin", "ADMIN");
    const auditor = await mk(`${TAG} Reviewer`, "auditor", AUDITOR);
    const manager = await mk(`${TAG} Manager Person`, "manager", MANAGER);
    const akash = await mk(`${TAG} Akash`, "akash", "SALES", {
      phone: "+91 90000 00001",
      employeeProfile: { create: { designation: "Zz Field Engineer" } },
    });
    const bina = await mk(`${TAG} Bina`, "bina", "SALES", { passwordHash: noPasswordYet() });
    const chetan = await mk(`${TAG} Chetan`, "chetan", "SALES", { active: false });

    const now = new Date();
    // Today on the workspace's clock, which is India's here.
    const today = indiaClock.parts(now);
    const startOfToday = indiaClock.midnight(today.year, today.month, today.day);
    const company = await db.company.create({
      data: { name: `${TAG} Leads Co`, normalizedName: `${TAG.toLowerCase()} leads co`, createdById: admin.id, ownerUserId: akash.id },
      select: { id: true },
    });
    await db.lead.createMany({
      data: [
        { companyId: company.id, title: `${TAG} upcoming`, status: "NEW", ownerUserId: akash.id, expectedCloseDate: new Date(startOfToday.getTime() + 2 * 86_400_000) },
        { companyId: company.id, title: `${TAG} slipped`, status: "QUALIFIED", ownerUserId: akash.id, expectedCloseDate: new Date(startOfToday.getTime() - 3 * 86_400_000) },
        { companyId: company.id, title: `${TAG} won`, status: "WON", ownerUserId: akash.id, expectedCloseDate: new Date(startOfToday.getTime() - 10 * 86_400_000) },
      ],
    });
    const signedInAt = new Date(now.getTime() - 58 * 60_000);
    await db.signIn.create({ data: { sid: `${TAG}-${Date.now()}`, userId: akash.id, provider: "credentials", at: signedInAt, lastSeenAt: signedInAt } });

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("1. The pieces, without a page");

    ok("switched off wins over invited", staffStatus({ active: false, setupPending: true }) === "off");
    ok("  invited is active with no password yet", staffStatus({ active: true, setupPending: true }) === "invited");
    ok("  and active is the rest", staffStatus({ active: true, setupPending: false }) === "active");
    const ago = (ms: number) => relativeAgo(new Date(now.getTime() - ms), now);
    ok("\"58m ago\", \"3h ago\", \"2d ago\", \"just now\"", ago(58 * 60_000) === "58m ago" && ago(3 * 3_600_000) === "3h ago" && ago(2 * 86_400_000) === "2d ago" && ago(20_000) === "just now");
    ok("Run payroll belongs to the Payroll module", permissionModules("payroll.manage").join() === "payroll");
    ok("  View leads to none — leads are the core of the app", permissionModules("leads.view").length === 0);
    ok("  View quotes & invoices to both documents modules", permissionModules("documents.view").join() === "sales_documents,purchase_documents");
    const moduleKeys = new Set(MODULE_REGISTRY.map((m) => m.key));
    const strays = PERMISSIONS.flatMap((p) => permissionModules(p.key)).filter((k) => !moduleKeys.has(k));
    ok("every module the dialog files a permission under exists", strays.length === 0, strays.join(", "));
    const payrollOff = { payroll: { key: "payroll", label: "Payroll", entitled: true, switchedOn: false } };
    ok("a module that is off says so", (moduleNote(["payroll"], payrollOff) ?? "").includes("switched off"));
    ok("  and one that is on says nothing", moduleNote(["payroll"], { payroll: { ...payrollOff.payroll, switchedOn: true } }) === null);

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("2. The Staff tab: counts and statuses");

    const facts = await staffFacts([akash.id, bina.id, chetan.id], { leads: true, signIns: true, now });
    const a = facts.get(akash.id);
    ok("Leads: the open leads they own — Won doesn't count", a?.openLeads === 2, a);
    ok("  and the one past its expected close date is counted as overdue", a?.overdueLeads === 1, a);
    ok("  last signed in is their newest sign-in", a?.lastSignInAt?.getTime() === signedInAt.getTime());
    ok("  job title from the HR record, phone from the account", a?.jobTitle === "Zz Field Engineer" && a?.phone === "+91 90000 00001");
    ok("somebody with none has 0 leads and no sign-in", facts.get(bina.id)?.openLeads === 0 && facts.get(bina.id)?.lastSignInAt === null);
    const quiet = await staffFacts([akash.id], { leads: false, signIns: false, now });
    ok("  and nothing is fetched that wasn't asked for", quiet.get(akash.id)?.openLeads === null && quiet.get(akash.id)?.lastSignInAt === null);

    actorId = admin.id;
    const usersHtml = await renderUsers({ user: akash.id, tab: "profile" });
    keep("users-akash-profile-admin", usersHtml);
    const usersText = text(usersHtml);
    ok("the page is Users", usersHtml.includes(">Users<") && usersHtml.includes("Manage users and configure individual permissions."));
    const everybody = await db.user.count();
    const activeNow = await db.user.count({ where: { active: true } });
    const tabCount = (label: string) => Number(new RegExp(`${label} \\((\\d+)\\)`).exec(usersText)?.[1]);
    ok("All, Active and Inactive, each counted", tabCount("All") === everybody && tabCount("Active") === activeNow && tabCount("Inactive") === everybody - activeNow, `${tabCount("All")}/${tabCount("Active")}/${tabCount("Inactive")} vs ${everybody}/${activeNow}`);
    ok("  with search, department and role filters", usersHtml.includes('placeholder="Search users…"') && usersHtml.includes(">All departments<") && usersHtml.includes(">All roles<"));
    ok("  and + to add somebody", usersHtml.includes('href="/settings/users/new"'));
    const listed = (name: string) => usersHtml.split("<li").find((chunk) => chunk.includes(`>${name}</span>`)) ?? "";
    ok("everybody is listed with role • department, opening on the tab already open", listed(`${TAG} Akash`).includes(`href="${userPath(akash.id, "profile").replaceAll("&", "&amp;")}"`) && text(listed(`${TAG} Akash`)).includes("Sales"));
    ok("  Bina, who hasn't chosen a password, says invited", text(listed(`${TAG} Bina`)).includes("• invited"));
    ok("  and Chetan, switched off, inactive", text(listed(`${TAG} Chetan`)).includes("• inactive"));
    ok("Akash is open: his initials, Active, his phone", usersHtml.includes(">ZA<") && usersHtml.includes(">Active<") && usersHtml.includes("+91 90000 00001") && usersHtml.includes('aria-current="page"'));
    ok("  with Reset to role defaults, View as user and Save changes", usersHtml.includes("Reset to role defaults") && usersHtml.includes("View as user") && usersHtml.includes("Save changes"));
    ok("  and the mockup's tabs", ["Profile", "Role", "Permissions", "Record Access", "Field Permissions", "Business Rules", "Login &amp; Access", "Activity"].every((t) => usersHtml.includes(`>${t}</a>`)));
    ok("Profile: job title, and open leads with the overdue one", usersText.includes("Zz Field Engineer") && usersText.includes("2 (1 past their expected close date)"));
    ok("  and Edit profile", usersHtml.includes("Edit profile"));
    const akashLogin = await renderUsers({ user: akash.id, tab: "login" });
    keep("users-akash-login-admin", akashLogin);
    ok("Login & Access: when he last signed in", text(akashLogin).includes("Last sign-in:") && !text(akashLogin).includes("Last sign-in: never"));
    ok("  Switch off and Send password reset, each through its own action", akashLogin.includes("Switch off") && akashLogin.includes("Send password reset"));
    const binaLogin = text(await renderUsers({ user: bina.id, tab: "login" }));
    ok("  Bina is Invited, and never signed in", binaLogin.includes("Invited — no password chosen yet") && binaLogin.includes("Last sign-in: never"));
    const ownLogin = await renderUsers({ user: admin.id, tab: "login" });
    ok("no Switch off on your own account", !ownLogin.includes("Switch off"));
    const saLogin = await renderUsers({ user: superAdmin.id, tab: "login" });
    ok("  nor on the super admin's, nor Edit profile for an admin who isn't one", !saLogin.includes("Switch off") && !(await renderUsers({ user: superAdmin.id, tab: "profile" })).includes("Edit profile"));
    const akashPermissions = await renderUsers({ user: akash.id });
    keep("users-akash-permissions-admin", akashPermissions);
    ok("Permissions opens by default: CRM's actions, the daily limit, field masking and effective access", ["Permissions for", "Lead actions", "Unmasking limits (Daily)", "Sensitive field masking", "Effective access for"].every((t) => akashPermissions.includes(t)));

    actorId = auditor.id;
    const usersReviewer = await renderUsers({ user: akash.id, tab: "profile" });
    keep("users-akash-profile-reviewer", usersReviewer);
    ok("a reviewer is told it's read-only", usersReviewer.includes("You can review access but not change it."));
    ok("  and gets no add, Edit profile or Reset", !usersReviewer.includes("/settings/users/new") && !usersReviewer.includes("Edit profile") && !usersReviewer.includes("Reset to role defaults"));
    ok("  nor Switch off", !(await renderUsers({ user: akash.id, tab: "login" })).includes("Switch off"));
    ok("  and sees no open leads or sign-ins without the permissions behind them", !text(usersReviewer).includes("Open leads") && !text(await renderUsers({ user: akash.id, tab: "login" })).includes("Last sign-in"));

    actorId = admin.id;
    ok("an old link to Staff or People lands on Users", (await landsOn(() => RETIRED.default({ searchParams: Promise.resolve({ tab: "people" }) }))) === "/settings/users" && (await landsOn(() => RETIRED.default({ searchParams: Promise.resolve({}) }))) === "/settings/users");
    ok("  one to a role, on the same role and tab", (await landsOn(() => RETIRED.default({ searchParams: Promise.resolve({ tab: "roles", role: "SALES", rtab: "summary" }) }))) === rolePath("SALES", "summary"));
    ok("  Compare roles, Exceptions and Who can to the permission matrix", (await landsOn(() => RETIRED.default({ searchParams: Promise.resolve({ tab: "roles", view: "compare" }) }))) === "/settings/roles/matrix" && (await landsOn(() => RETIRED.default({ searchParams: Promise.resolve({ tab: "exceptions" }) }))) === "/settings/roles/matrix#exceptions" && (await landsOn(() => RETIRED.default({ searchParams: Promise.resolve({ tab: "who" }) }))) === "/settings/roles/matrix#who-can");
    ok("  and a person's old page to them under Users, on the same tab", (await landsOn(() => RETIRED_PERSON.default({ params: Promise.resolve({ id: akash.id }), searchParams: Promise.resolve({ tab: "fields" }) }))) === userPath(akash.id, "fields"));

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("3. Switching somebody off");

    actorId = admin.id;
    const off = await USER.setUserActive(akash.id, false);
    ok("Switch off switches Akash off", off.ok, off.ok ? "" : off.error);
    ok("  and only switches him off — the account and everything he owns are still there", (await db.user.findUnique({ where: { id: akash.id }, select: { active: true } }))?.active === false && (await db.lead.count({ where: { ownerUserId: akash.id } })) === 3);
    const offHtml = await renderUsers({ user: akash.id, tab: "login" });
    ok("  he shows as inactive, with Switch on", text(offHtml).includes("• inactive") && offHtml.includes(">Inactive<") && offHtml.includes("Switch on"));
    const back = await USER.setUserActive(akash.id, true);
    ok("  and can be switched back on", back.ok, back.ok ? "" : back.error);
    const self = await USER.setUserActive(admin.id, false);
    ok("switching yourself off is refused", !self.ok && /own account/.test(self.error), self.ok ? "allowed" : self.error);
    const sa = await USER.setUserActive(superAdmin.id, false);
    ok("  and so is switching off the super admin, by an admin", !sa.ok, sa.ok ? "allowed" : sa.error);
    const confirmSource = fs.readFileSync(path.join(__dirname, "../src/components/settings/people/user-account-actions.tsx"), "utf8");
    ok("the confirmation says nothing is deleted", confirmSource.includes("Nothing is deleted.") && confirmSource.includes("Switch off ${row.name}"));

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("4. Add staff: a setup link, never a password");

    const addHtml = html(await resolveAsync(await ADD.default()));
    keep("add-staff-admin", addHtml);
    ok("the Add staff page has the reference's fields", ["Full name", "Email address", "Job title", "Phone", "Role", "Status", "Department", "Reporting manager"].every((l) => addHtml.includes(`>${l}<`)));
    ok("  Role says what it decides, and Admin is not on offer", addHtml.includes("Decides what they can do.") && !addHtml.includes('<option value="ADMIN"'));
    ok("  and there is no password field, only the note about the setup email", !/type="password"/.test(addHtml) && addHtml.includes("No password to set."));
    ok("  ending in Create account", addHtml.includes(">Create account<"));
    actorId = auditor.id;
    const addReviewer = html(await resolveAsync(await ADD.default()));
    keep("add-staff-reviewer", addReviewer);
    ok("a reviewer can't add staff", addReviewer.includes("You can&#x27;t add staff.") && !addReviewer.includes("Create account"));
    const refusedCreate = await USER.createUser({ name: `${TAG} Nope`, email: `nope${MAIL}`, role: "SALES" });
    ok("  and the action refuses them too", !refusedCreate.ok);

    actorId = admin.id;
    const sentBefore = mail.length;
    const made = await USER.createUser({
      name: `${TAG} Devika`,
      email: `devika${MAIL}`,
      role: "SALES",
      departmentId: "",
      jobTitle: "Zz Engineer",
      phone: "+91 90000 00002",
      active: true,
    });
    ok("Create account makes the account", made.ok, made.ok ? "" : made.error);
    if (made.ok) {
      const row = await db.user.findUnique({
        where: { id: made.data.id },
        select: { active: true, phone: true, mustChangePassword: true, employeeProfile: { select: { designation: true } } },
      });
      ok("  emails a setup link to them", made.data.emailed === true && mail.length === sentBefore + 1 && mail.at(-1)?.to === `devika${MAIL}` && /reset-password\?t=[^\s]+setup=1/.test(mail.at(-1)?.text ?? ""));
      ok("  with no password: the account is waiting for them to choose one", (await db.user.count({ where: { id: made.data.id, ...AWAITING_SETUP } })) === 1 && row?.mustChangePassword === false);
      ok("  job title on the HR record, phone on the account", row?.employeeProfile?.designation === "Zz Engineer" && row?.phone === "+91 90000 00002" && row?.active === true);
    }
    const offMade = await USER.createUser({ name: `${TAG} Esha`, email: `esha${MAIL}`, role: "SALES", active: false });
    ok("Status: Switched off makes the account switched off, and emails nobody", offMade.ok && offMade.data.startsSwitchedOff === true && offMade.data.emailed === false && mail.length === sentBefore + 1);
    if (offMade.ok) {
      ok("  so it takes no seat until switched on", (await db.user.findUnique({ where: { id: offMade.data.id }, select: { active: true } }))?.active === false);
      const early = await USER.resendSetupEmail(offMade.data.id);
      ok("  and its setup email waits until then", !early.ok);
    }
    const legacy = await USER.createUser({ name: `${TAG} Farhan`, email: `farhan${MAIL}`, role: "SALES", departmentId: "" });
    ok("an older caller's input (no job title, phone or status) works as before", legacy.ok && legacy.data.emailed === true && !("startsSwitchedOff" in legacy.data));
    const twice = await USER.createUser({ name: `${TAG} Devika again`, email: `DEVIKA${MAIL}`, role: "SALES" });
    ok("the same email twice is refused", !twice.ok && /already exists/.test(twice.error));

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("5. Saving a role writes exactly what was ticked");

    const createdRole = await ROLE.createRole({ name: `${TAG} Dialog Role`, description: "Probe" });
    ok("New role makes a role", createdRole.ok, createdRole.ok ? "" : createdRole.error);
    if (!createdRole.ok) return;
    const DIALOG = createdRole.data.key;
    const heldBy = async (role: string) => {
      const held: string[] = [];
      // Its permissions: the sections every role sees until unticked are no capability of its own.
      for (const def of PERMISSIONS) if (!def.everyone && (await rolePermits(role, def.key))) held.push(def.key);
      return held.sort();
    };
    const same = (x: string[], y: string[]) => x.length === y.length && [...x].sort().every((k, i) => k === [...y].sort()[i]);

    // "View all field visits" is how a permission's reach widens here: its own box, saved like any other.
    const first = ["tickets.create", "leads.view", "visits.view", "visits.viewAll"];
    const savedFirst = await PERM.setRolePermissions(DIALOG, first.map((key) => ({ key, allowed: true })));
    ok("Save role writes the ticked boxes", savedFirst.ok && savedFirst.data.changed === 4, savedFirst.ok ? savedFirst.data : savedFirst.error);
    ok("  and the role then grants exactly those — the wider-reach box included", same(await heldBy(DIALOG), first), await heldBy(DIALOG));
    const matrix = await PERM.getPermissionMatrix();
    ok("  which is what the dialog opens with next time", same(matrix.filter((p) => p.roles[DIALOG] && !p.key.startsWith("section.")).map((p) => p.key), first));

    const second = ["leads.view", "visits.view", "contacts.view"];
    const diff = PERMISSIONS.filter((p) => first.includes(p.key) !== second.includes(p.key)).map((p) => ({ key: p.key, allowed: second.includes(p.key) }));
    const savedSecond = await PERM.setRolePermissions(DIALOG, diff);
    ok("editing it writes only the boxes that changed", savedSecond.ok && savedSecond.data.changed === 3, savedSecond.ok ? savedSecond.data : savedSecond.error);
    ok("  and it grants exactly the new set", same(await heldBy(DIALOG), second), await heldBy(DIALOG));
    ok("  every change recorded, as one click in the matrix is", (await db.permissionChange.count({ where: { subjectRole: DIALOG } })) === 1 + 4 + 3);

    const salesRowBefore = await db.rolePermission.findUnique({ where: { role_permission: { role: "SALES", permission: "tickets.create" } } });
    if (salesRowBefore === null) {
      const untouched = await PERM.setRolePermissions("SALES", [{ key: "tickets.create", allowed: true }]);
      ok("a box left as it was keeps following the registry default — nothing is written", untouched.ok && untouched.data.changed === 0 && (await db.rolePermission.findUnique({ where: { role_permission: { role: "SALES", permission: "tickets.create" } } })) === null);
    } else {
      console.log("  (skipped: SALES already stores an answer for Create tickets on this database)");
    }

    actorId = manager.id;
    const partial = await PERM.setRolePermissions(DIALOG, [
      { key: "tickets.create", allowed: true },
      { key: "payroll.manage", allowed: true },
    ]);
    ok("one box the saver can't grant refuses the whole save", !partial.ok && /don't hold it yourself/.test(partial.error), partial.ok ? "saved" : partial.error);
    ok("  and the boxes before it were not written", !(await rolePermits(DIALOG, "tickets.create")));
    const unknown = await PERM.setRolePermissions(DIALOG, [{ key: "nothing.real", allowed: true }]);
    ok("an unknown permission is refused", !unknown.ok);
    const adminRole = await PERM.setRolePermissions("ADMIN", [{ key: "tickets.create", allowed: false }]);
    ok("only a super admin changes what Admin holds", !adminRole.ok && /super admin/.test(adminRole.error));
    const lockout = await PERM.setRolePermissions(MANAGER, [{ key: "permissions.manage", allowed: false }]);
    ok("nobody takes Change roles and permissions away from their own role", !lockout.ok && /your own role/.test(lockout.error), lockout.ok ? "saved" : lockout.error);
    const lockoutOne = await PERM.setRolePermission(MANAGER, "permissions.manage", false);
    const lockoutReset = await PERM.resetRolePermission(MANAGER, "permissions.manage");
    ok("  nor through the matrix's switch or its reset arrow", !lockoutOne.ok && !lockoutReset.ok);
    ok("  so they still hold it", await can(manager.id, "permissions.manage"));
    const otherBox = await PERM.setRolePermissions(MANAGER, [{ key: "tickets.create", allowed: false }]);
    ok("  while any other box on their own role is theirs to change", otherBox.ok);
    await db.userPermission.create({ data: { userId: manager.id, permission: "permissions.view", allowed: true, reason: `${TAG} personal grant` } });
    const personally = await PERM.setRolePermissions(MANAGER, [{ key: "permissions.view", allowed: false }]);
    ok("  and somebody who also holds it personally may take it off the role", personally.ok && (await can(manager.id, "permissions.view")));

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("6. A read-only reviewer can't save");

    actorId = auditor.id;
    const heldBefore = await heldBy(DIALOG);
    const reviewerSave = await PERM.setRolePermissions(DIALOG, [{ key: "leads.view", allowed: false }]);
    const reviewerRename = await ROLE.updateRole({ key: DIALOG, name: `${TAG} Renamed` });
    const reviewerCreate = await ROLE.createRole({ name: `${TAG} Sneaky` });
    ok("the server refuses a reviewer's save, rename and new role", !reviewerSave.ok && !reviewerRename.ok && !reviewerCreate.ok);
    ok("  and nothing changed", same(await heldBy(DIALOG), heldBefore));

    const moduleStates = Object.fromEntries(MODULE_REGISTRY.map((m) => [m.key, { key: m.key, label: m.label, entitled: true, switchedOn: m.key !== "payroll" }]));
    const catalogue = PERMISSIONS.map((def) => ({
      key: def.key,
      label: def.label,
      description: def.description,
      group: permissionGroup(def),
      tier: def.tier ?? "standard",
      superAdminOnly: def.superAdminOnly === true,
      modules: permissionModules(def.key),
    }));
    // The role's Module Access (src/components/settings/roles/role-modules-workspace.tsx): one module at
    // a time, an Allow box per action, the server's reasons on a box that can't be changed.
    const grid = await roleAccessLevels(DIALOG);
    const records = (grid?.rows ?? []).map((r) => ({ key: r.key, label: r.label, actions: r.actions }));
    const crmRows = actionRowsOf("crm", records);
    const crmKeyRows = crmRows.flatMap((r) => (r.kind === "key" ? [r] : []));
    const esc = (t: string) => t.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;");
    /** The Allow box of the row with this label — its tag, or "" when there is none. */
    const box = (markup: string, label: string) => (markup.match(/<input type="checkbox"[^>]*>/g) ?? []).find((tag) => tag.includes(`aria-label="Allow ${esc(label)}"`)) ?? "";
    const workspace = (roleKey: string, held: string[], viewer: { mayManage: boolean; isSuperAdmin: boolean; holds: string[]; role: string; ownAccessThroughRole: string[] }) =>
      html(
        createElement(RoleModulesWorkspace, {
          roleKey,
          catalogue,
          held,
          grid: grid?.rows ?? [],
          gridWhy: null,
          selfExcluded: [],
          moduleStates,
          viewer,
          people: [],
          roleSummaryHref: rolePath(roleKey, "summary"),
        }),
      );
    const asReviewer = workspace(DIALOG, second, { mayManage: false, isSuperAdmin: false, holds: ["permissions.view"], role: AUDITOR, ownAccessThroughRole: ["permissions.view"] });
    keep("role-modules-reviewer", asReviewer);
    const boxes = count(asReviewer, /type="checkbox"/g);
    ok("the reviewer sees the role's first module, CRM: an Allow box for each of its actions", crmRows.length > 0 && crmRows.every((r) => box(asReviewer, r.label) !== ""), `${boxes} boxes, ${crmRows.length} rows`);
    ok("  every one disabled, saying why", crmRows.every((r) => /disabled=""/.test(box(asReviewer, r.label)) && box(asReviewer, r.label).includes('title="You can review roles but not change them."')));
    ok("  and every module listed to move to", count(asReviewer, /aria-label="Modules"/g) === 1 && asReviewer.includes(">Sales<") && asReviewer.includes(">Settings<") && asReviewer.includes(">Permission preview<"));

    const viewerHolds = PERMISSIONS.filter((p) => !p.superAdminOnly).map((p) => p.key);
    const adminViewer = { mayManage: true, isSuperAdmin: false, holds: viewerHolds, role: "ADMIN", ownAccessThroughRole: ["permissions.view", "permissions.manage"] };
    const asAdmin = workspace(DIALOG, second, adminViewer);
    keep("role-modules-admin", asAdmin);
    ok("an admin's boxes are ticked exactly as the role holds, in this module", crmKeyRows.every((r) => box(asAdmin, r.label).includes('checked=""') === second.includes(r.key)));
    ok("  and open to change, but for what only a super admin grants", crmKeyRows.every((r) => /disabled=""/.test(box(asAdmin, r.label)) === (PERMISSIONS.find((p) => p.key === r.key)?.superAdminOnly === true)));
    ok("  with Module enabled for its place in the menu", asAdmin.includes("Module enabled"));
    const adminRoleScreen = workspace("ADMIN", PERMISSIONS.map((p) => p.key), adminViewer);
    ok("Admin's own role is locked for a non-super admin", crmKeyRows.every((r) => box(adminRoleScreen, r.label).includes('title="Only a super admin can change what admins can do."')));
    const recordsHtml = html(createElement(RoleRecordAccess, { roleKey: DIALOG, grid: grid?.rows ?? [], gridWhy: null, mayManage: true }));
    keep("role-records", recordsHtml);
    ok("Record Access is the whole grid: a choice per record and action", (grid?.rows.length ?? 0) > 0 && count(recordsHtml, /<select/g) >= (grid?.rows.length ?? 1));
    const recordsReviewer = html(createElement(RoleRecordAccess, { roleKey: DIALOG, grid: grid?.rows ?? [], gridWhy: null, mayManage: false }));
    ok("  and read-only for a reviewer, saying why", recordsReviewer.includes("You can review roles but not change them.") && !recordsReviewer.includes("Save changes"));

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("7. Roles & Permissions");

    actorId = admin.id;
    const rolesHtml = await renderRoles({ role: "SALES" });
    keep("roles-sales-admin", rolesHtml);
    ok("the page is Roles & Permissions, with Permission matrix and Create role", rolesHtml.includes("Roles &amp; Permissions") && rolesHtml.includes("Create and manage roles with fine-grained access control") && rolesHtml.includes('href="/settings/roles/matrix"') && rolesHtml.includes("Create role"));
    ok("the roles are listed, searchable, beside the one open", rolesHtml.includes('placeholder="Search roles…"') && rolesHtml.includes('aria-current="page"'));
    ok("  the super admin first, marked System", rolesHtml.includes(">Super Admin<") && rolesHtml.includes(">System<"));
    const salesActive = await db.user.count({ where: { role: "SALES", active: true, isSuperAdmin: false } });
    ok("  Sales with its people counted", rolesHtml.includes(`href="${rolePath("SALES")}"`) && text(rolesHtml).includes(`${salesActive} ${salesActive === 1 ? "user" : "users"}`));
    ok("  and a custom role", rolesHtml.includes(`role=${encodeURIComponent(DIALOG)}`) && rolesHtml.includes("Create custom role"));
    ok("the open role's tabs: Module Access, Record Access, Field Permissions, Business Rules, Users (n), Summary", ["Module Access", "Record Access", "Field Permissions", "Business Rules", `Users (${salesActive})`, "Summary"].every((t) => text(rolesHtml).includes(t)));
    ok("  its header: Active, Rename, Duplicate — and Delete off on a built-in role", rolesHtml.includes('aria-label="Role switched on"') && rolesHtml.includes('aria-label="Rename ') && rolesHtml.includes("Duplicate") && /<button[^>]*disabled=""[^>]*title="One of the roles this application was built around/.test(rolesHtml));
    ok("  and the permission preview", rolesHtml.includes(">Permission preview<") && rolesHtml.includes("Select a user (optional)"));
    const customHtml = await renderRoles({ role: DIALOG, tab: "summary" });
    keep("roles-custom-summary", customHtml);
    ok("a custom role can be deleted", !/<button[^>]*disabled=""[^>]*title="One of the roles this application was built around/.test(customHtml) && customHtml.includes("Delete"));
    ok("  and its Summary keeps its history", customHtml.includes("This role&#x27;s history") && !customHtml.includes("Nothing has changed yet."));
    const matrixHtml = html(await resolveAsync(await MATRIX.default()));
    keep("roles-matrix-admin", matrixHtml);
    ok("the permission matrix, presets and all", matrixHtml.includes(">Permission matrix<") && matrixHtml.includes('aria-label="Find a permission"'));
    ok("  with the exceptions to roles and who holds a permission under it", matrixHtml.includes('id="exceptions"') && matrixHtml.includes("Every permission granted or denied to one person") && matrixHtml.includes('id="who-can"') && matrixHtml.includes("Who holds a permission"));

    actorId = auditor.id;
    const rolesReviewer = await renderRoles({ role: "SALES" });
    keep("roles-sales-reviewer", rolesReviewer);
    ok("a reviewer can open every role to read it, and change none", rolesReviewer.includes(`href="${rolePath("SALES")}"`) && !rolesReviewer.includes("Create custom role") && !rolesReviewer.includes('aria-label="Rename ') && !rolesReviewer.includes("Duplicate") && rolesReviewer.includes("You can review roles but not change them."));

    section("8. The names");
    ok("Settings › Staff lists Roles & Permissions, Users and Departments", SETTINGS_ITEMS.find((i) => i.key === "roles")?.label === "Roles & Permissions" && SETTINGS_ITEMS.find((i) => i.key === "users")?.label === "Users" && SETTINGS_ITEMS.some((i) => i.href === "/settings/departments"));
    ok("  and nothing points at the retired page", !SETTINGS_ITEMS.some((i) => i.href.startsWith("/settings/access")));
    ok("  and the browser tabs say so", (USERS as unknown as { metadata?: { title?: string } }).metadata?.title === "Users" && (ROLES as unknown as { metadata?: { title?: string } }).metadata?.title === "Roles & Permissions");
    // The menu's links are built in src/lib/navigation.ts; the sidebar only draws them.
    const sidebar = fs.readFileSync(path.join(__dirname, "../src/lib/navigation.ts"), "utf8");
    ok("  as does the sidebar", sidebar.includes('label: "Users"') && sidebar.includes('label: "Roles & Permissions"') && !sidebar.includes('label: "Staff & roles"'));
  } finally {
    actorId = "";
    mailer.setTestPlatformMailer(null);
    await cleanup(db);
    await db.$disconnect();
  }

  console.log(failures === 0 ? `\nUsers and Roles & Permissions: all ${passes} checks passed.\n` : `\n${failures} FAILED, ${passes} passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** Everything the fixtures made, found by their address and names — and by whose they are. */
async function cleanup(db: typeof import("../src/lib/db").db) {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const roles = await db.role.findMany({ where: { key: { startsWith: TAG } }, select: { key: true } });
  const keys = roles.map((r) => r.key);
  const companies = await db.company.findMany({
    where: { OR: [{ name: { startsWith: TAG } }, { createdById: { in: ids } }] },
    select: { id: true },
  });
  const companyIds = companies.map((c) => c.id);
  await db.lead.deleteMany({ where: { OR: [{ companyId: { in: companyIds } }, { ownerUserId: { in: ids } }] } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.permissionChange.deleteMany({
    where: { OR: [{ actorUserId: { in: ids } }, { subjectUserId: { in: ids } }, { subjectRole: { startsWith: TAG } }] },
  });
  await db.activityLog.deleteMany({ where: { userId: { in: ids } } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.passwordResetToken.deleteMany({ where: { userId: { in: ids } } });
  await db.signIn.deleteMany({ where: { userId: { in: ids } } });
  await db.employeeProfile.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.rolePermission.deleteMany({ where: { role: { in: keys } } });
  await db.role.deleteMany({ where: { key: { in: keys } } });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
