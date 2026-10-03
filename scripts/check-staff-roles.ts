/**
 * Staff & roles: the workspace's "Users & access", rebuilt in the owner's reference layout.
 *
 *   1. The pieces without a page: a person's status, "58m ago", which module a permission needs.
 *   2. The Staff tab: its counts and statuses, the leads and last-sign-in columns, the row actions —
 *      as an admin and as a read-only reviewer.
 *   3. Switching somebody off from the Staff tab works, never deletes, and is refused for yourself and
 *      for the super admin.
 *   4. Add staff creates an account with a setup link and no password — and keeps `createUser`'s old
 *      callers working.
 *   5. The role dialog saves exactly the boxes ticked (a permission's wider reach is its own box), all
 *      or nothing, and nobody can take away their own way into these screens.
 *   6. A read-only reviewer sees the same dialog, disabled, and the server refuses them anyway.
 *   7. The Roles tab: the super admin's card has no edit; the matrix is still there as Compare roles.
 *
 * The real actions and the real page, with the session, `next/cache`, `next/navigation`, the dialog's
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
      usePathname: () => "/settings/access",
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

/** The table row holding this text, so an assertion is about that person and nobody else. */
function rowOf(markup: string, text: string): string {
  return markup.split("<tr").find((chunk) => chunk.includes(text)) ?? "";
}
/** The role card holding this name. */
function cardOf(markup: string, name: string): string {
  return markup.split("<li").find((chunk) => chunk.includes(`>${name}</p>`)) ?? "";
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
  const PAGE = require("../src/app/(dashboard)/settings/access/page") as typeof import("../src/app/(dashboard)/settings/access/page");
  const ADD = require("../src/app/(dashboard)/settings/access/new/page") as typeof import("../src/app/(dashboard)/settings/access/new/page");
  const { RoleDialog } = require("../src/components/settings/staff/role-dialog") as typeof import("../src/components/settings/staff/role-dialog");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const mail: { to: string; subject: string; text: string }[] = [];
  mailer.setTestPlatformMailer(async (m) => void mail.push(m));

  const renderPage = async (tab: string, extra: Record<string, string> = {}) =>
    html(await resolveAsync(await PAGE.default({ searchParams: Promise.resolve({ tab, ...extra }) })));

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
    const staffHtml = await renderPage("staff");
    keep("staff-tab-admin", staffHtml);
    ok("the page is Staff & roles", staffHtml.includes("Staff &amp; roles") && staffHtml.includes("Who can sign in, and exactly what each of them may do."));
    const activeNow = await db.user.count({ where: { active: true } });
    const staffTabCount = /Staff<span class="sr-only">, <\/span><span[^>]*>(\d+)<\/span>/.exec(staffHtml)?.[1];
    ok("the Staff tab's count is everybody active or invited, read out as \"Staff, N\"", Number(staffTabCount) === activeNow, `${staffTabCount} vs ${activeNow}`);
    const rolesTabCount = /Roles &amp; permissions<span class="sr-only">, <\/span><span[^>]*>(\d+)<\/span>/.exec(staffHtml)?.[1];
    ok("  and Roles & permissions counts every role card, the super admin's included", Number(rolesTabCount) === (await db.role.count()) + 1, rolesTabCount);
    ok("Exceptions and Who can are still tabs", staffHtml.includes("tab=exceptions") && staffHtml.includes("tab=who"));
    ok("the card says who is listed, with Add staff", staffHtml.includes("Everyone who can sign in to this workspace.") && staffHtml.includes('href="/settings/access/new"'));
    const akashRow = rowOf(staffHtml, `${TAG} Akash`);
    const binaRow = rowOf(staffHtml, `${TAG} Bina`);
    ok("Akash is Active, with his initials in the avatar", akashRow.includes(">Active<") && akashRow.includes(">ZA<"));
    ok("  Bina, who hasn't chosen a password, is Invited", binaRow.includes(">Invited<"));
    ok("  Chetan, switched off, is hidden until the filter asks for him", !staffHtml.includes(`${TAG} Chetan`));
    ok("  the filter offers the switched-off, the invited and the exceptions", staffHtml.includes('value="off"') && staffHtml.includes('value="invited"') && staffHtml.includes('value="exceptions"'));
    ok("Leads: 2, in red, with the overdue one read out", akashRow.includes("text-danger") && akashRow.includes(">2<") && akashRow.includes("1 past their expected close date"));
    ok("Last signed in: \"58m ago\", with the exact time on hover", /<time dateTime="[^"]+" title="[^"]+">58m ago<\/time>/.test(akashRow));
    ok("  and Never for somebody who hasn't", binaRow.includes(">Never<"));
    ok("the role pill and the access line under it", akashRow.includes(">Sales<") && /Holds \d+ of \d+/.test(akashRow));
    const adminRow = rowOf(staffHtml, `${TAG} Admin`);
    ok("\"(you)\" on the viewer's own row", adminRow.includes(`${TAG} Admin</span><span class="text-xs text-muted">(you)</span>`));
    ok("a pencil and a switch-off on somebody else's row, each naming them", akashRow.includes(`aria-label="Edit ${TAG} Akash"`) && akashRow.includes(`aria-label="Switch off ${TAG} Akash"`));
    ok("  no switch-off on your own row", adminRow.includes(`aria-label="Edit ${TAG} Admin"`) && !adminRow.includes("Switch off"));
    const saRow = rowOf(staffHtml, `>${superAdmin.name}</span>`);
    ok("  nor on the super admin's, whose pill is the brand's", saRow.includes(">Super admin<") && saRow.includes("bg-brand-subtle") && !saRow.includes("Switch off") && !saRow.includes(`aria-label="Edit ${superAdmin.name}"`));
    ok("everybody keeps the access drawer", akashRow.includes(`Review ${TAG} Akash&#x27;s access`));
    ok("on a phone the table scrolls inside its card", staffHtml.includes('class="overflow-x-auto"><table class="w-full min-w-[760px]'));
    ok("departments are kept under the table", staffHtml.includes(">Departments<"));

    actorId = auditor.id;
    const staffReviewer = await renderPage("staff");
    keep("staff-tab-reviewer", staffReviewer);
    ok("a reviewer is told it's read-only", staffReviewer.includes("You can review access but not change it."));
    ok("  and gets no Add staff, pencil or switch-off", !staffReviewer.includes("/settings/access/new") && !staffReviewer.includes(`Edit ${TAG} Akash`) && !staffReviewer.includes("Switch off"));
    ok("  but can still open anybody's access", staffReviewer.includes(`Review ${TAG} Akash&#x27;s access`));
    ok("  and sees no Leads or Last signed in without the permissions behind them", !staffReviewer.includes(">Leads<") && !staffReviewer.includes(">Last signed in<"));
    ok("an old link to People lands on Staff", (await renderPage("people")).includes("Everyone who can sign in to this workspace."));

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("3. Switching off from the Staff tab");

    actorId = admin.id;
    const off = await USER.setUserActive(akash.id, false);
    ok("the trash switches Akash off", off.ok, off.ok ? "" : off.error);
    ok("  and only switches him off — the account and everything he owns are still there", (await db.user.findUnique({ where: { id: akash.id }, select: { active: true } }))?.active === false && (await db.lead.count({ where: { ownerUserId: akash.id } })) === 3);
    const offHtml = rowOf(await renderPage("staff"), `${TAG} Akash`);
    ok("  he leaves the default list", offHtml === "");
    const back = await USER.setUserActive(akash.id, true);
    ok("  and can be switched back on", back.ok, back.ok ? "" : back.error);
    const self = await USER.setUserActive(admin.id, false);
    ok("switching yourself off is refused", !self.ok && /own account/.test(self.error), self.ok ? "allowed" : self.error);
    const sa = await USER.setUserActive(superAdmin.id, false);
    ok("  and so is switching off the super admin, by an admin", !sa.ok, sa.ok ? "allowed" : sa.error);
    const confirmSource = fs.readFileSync(path.join(__dirname, "../src/components/settings/staff/staff-table.tsx"), "utf8");
    ok("the confirmation says nothing is deleted", confirmSource.includes("Nothing is deleted.") && confirmSource.includes("Switch off ${switchingOff.name}"));

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
    section("5. The role dialog saves exactly what was ticked");

    const createdRole = await ROLE.createRole({ name: `${TAG} Dialog Role`, description: "Probe" });
    ok("New role makes a role", createdRole.ok, createdRole.ok ? "" : createdRole.error);
    if (!createdRole.ok) return;
    const DIALOG = createdRole.data.key;
    const heldBy = async (role: string) => {
      const held: string[] = [];
      for (const def of PERMISSIONS) if (await rolePermits(role, def.key)) held.push(def.key);
      return held.sort();
    };
    const same = (x: string[], y: string[]) => x.length === y.length && [...x].sort().every((k, i) => k === [...y].sort()[i]);

    // "View all field visits" is how a permission's reach widens here: its own box, saved like any other.
    const first = ["tickets.create", "leads.view", "visits.view", "visits.viewAll"];
    const savedFirst = await PERM.setRolePermissions(DIALOG, first.map((key) => ({ key, allowed: true })));
    ok("Save role writes the ticked boxes", savedFirst.ok && savedFirst.data.changed === 4, savedFirst.ok ? savedFirst.data : savedFirst.error);
    ok("  and the role then grants exactly those — the wider-reach box included", same(await heldBy(DIALOG), first), await heldBy(DIALOG));
    const matrix = await PERM.getPermissionMatrix();
    ok("  which is what the dialog opens with next time", same(matrix.filter((p) => p.roles[DIALOG]).map((p) => p.key), first));

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
    const groups = new Set(catalogue.map((c) => c.group));
    const card = {
      key: DIALOG,
      name: `${TAG} Dialog Role`,
      description: "Probe",
      isSystem: false,
      headcount: 0,
      activeStaff: 0,
      held: second,
    };
    const dialogProps = {
      role: card,
      catalogue,
      modules: moduleStates,
      viewerIsSuperAdmin: false,
      viewerRole: AUDITOR,
      ownAccessThroughRole: ["permissions.view"],
      onClose: () => {},
    };
    const asReviewer = html(createElement(RoleDialog, { ...dialogProps, mayManage: false, viewerHolds: ["permissions.view"] }));
    keep("role-dialog-reviewer", asReviewer);
    const boxes = count(asReviewer, /type="checkbox"/g);
    ok("the reviewer sees the same dialog: a box for every permission and a Select all per group", boxes === PERMISSIONS.length + groups.size, boxes);
    ok("  every one disabled", count(asReviewer, /<input type="checkbox"[^>]*disabled=""/g) === boxes);
    ok("  with no Save — only Close", !asReviewer.includes("Save role") && asReviewer.includes(">Close<") && asReviewer.includes("You can review roles but not change them."));

    const asAdminProps = { ...dialogProps, mayManage: true, viewerRole: "ADMIN", ownAccessThroughRole: ["permissions.view", "permissions.manage"], viewerHolds: PERMISSIONS.filter((p) => !p.superAdminOnly).map((p) => p.key) };
    const asAdmin = html(createElement(RoleDialog, asAdminProps));
    keep("role-dialog-admin", asAdmin);
    ok("an admin's dialog is titled with the role, under the reference's subtitle", asAdmin.includes(`aria-label="Edit role: ${TAG} Dialog Role"`) && asAdmin.includes("Permissions are enforced on the server for every action, not just hidden in the UI."));
    ok("  Role name and Description", asAdmin.includes(">Role name<") || asAdmin.includes(">Role name *<"));
    ok("  \"Permissions (3 selected)\" and a search box", asAdmin.includes("Permissions (3 selected)") && asAdmin.includes('aria-label="Search permissions"'));
    ok("  one fieldset per catalogue group, with its legend", [...groups].every((g) => asAdmin.includes(`<legend class="px-1 text-sm font-medium text-text">${g.replace("&", "&amp;")}</legend>`)) && count(asAdmin, /<fieldset class="rounded-base/g) === groups.size);
    ok("  each with a Select all that names its group", [...groups].every((g) => asAdmin.includes(`aria-label="Select all in ${g.replace("&", "&amp;")}"`)));
    ok("  and its boxes in two columns, one on a phone", asAdmin.includes("grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2"));
    ok("  every box inside its label, Select all included", count(asAdmin, /<label[^>]*><input type="checkbox"/g) === PERMISSIONS.length + groups.size);
    const tickedKeys = (asAdmin.match(/<input type="checkbox"[^>]*>/g) ?? [])
      .filter((tag) => tag.includes('checked=""') && tag.includes("data-permission="))
      .map((tag) => /data-permission="([^"]+)"/.exec(tag)?.[1] ?? "");
    ok("  ticked exactly as the role holds", same(tickedKeys, second), tickedKeys);
    ok("  a super-admin-only box is disabled, saying why", /title="Only a super admin can grant this permission\."[^>]*><input type="checkbox"[^>]*disabled=""[^>]*data-permission="users\.assignRole"/.test(asAdmin));
    ok("  Payroll's boxes under their module, with a note that it is off", asAdmin.includes("Payroll is switched off for the company"));
    ok("  and Save role in the footer", asAdmin.includes(">Save role<") && asAdmin.includes("sticky bottom-0"));
    const fresh = html(createElement(RoleDialog, { ...asAdminProps, role: null }));
    keep("role-dialog-new", fresh);
    ok("New role opens empty", fresh.includes('aria-label="New role"') && fresh.includes("Permissions (0 selected)") && fresh.includes("A new role starts holding nothing."));
    const adminRoleCard = { ...card, key: "ADMIN", name: "Admin", isSystem: true, held: PERMISSIONS.map((p) => p.key) };
    const adminByAdmin = html(createElement(RoleDialog, { ...asAdminProps, role: adminRoleCard }));
    ok("Admin's own role is locked for a non-super admin, who may still rename it", adminByAdmin.includes("Only a super admin can change what admins can do") && count(adminByAdmin, /<input type="checkbox"[^>]*disabled=""/g) === PERMISSIONS.length + groups.size && adminByAdmin.includes(">Save role<"));

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("7. The Roles tab");

    actorId = admin.id;
    const rolesHtml = await renderPage("roles");
    keep("roles-tab-admin", rolesHtml);
    ok("the card is Roles and permissions, under the reference's subtitle", rolesHtml.includes("Roles and permissions") && rolesHtml.includes("Every action in this workspace is checked against these on the server."));
    const saCard = cardOf(rolesHtml, "Super admin");
    ok("the super admin's card: every permission, built in", saCard.includes("Every permission · Unrestricted access to every part of the workspace.") && saCard.includes(">Built in<"));
    ok("  and no pencil", !saCard.includes("aria-label=\"Edit role") && !rolesHtml.includes('aria-label="Edit role Super admin"'));
    const salesCard = cardOf(rolesHtml, "Sales");
    const salesActive = await db.user.count({ where: { role: "SALES", active: true, isSuperAdmin: false } });
    ok("a built-in role: shield, count, \"N staff\", Built in, pencil", salesCard.includes(`>${salesActive} staff<`) && salesCard.includes(">Built in<") && salesCard.includes('aria-label="Edit role Sales"') && /\d+ permissions?/.test(salesCard));
    ok("  but no ⋯, since a built-in role can't be deleted", !salesCard.includes("More actions for"));
    const dialogCard = cardOf(rolesHtml, `${TAG} Dialog Role`);
    ok("a custom role nobody holds: \"3 permissions · Probe\" and a ⋯ with Delete", dialogCard.includes("3 permissions · Probe") && dialogCard.includes(`aria-label="More actions for ${TAG} Dialog Role"`) && !dialogCard.includes(">Built in<"));
    ok("+ New role and Compare roles", rolesHtml.includes(">New role<") && rolesHtml.includes('href="/settings/access?tab=roles&amp;view=compare"'));
    ok("recent role changes stay on the tab", rolesHtml.includes("Recent role changes"));
    const compareHtml = await renderPage("roles", { view: "compare" });
    keep("roles-compare-admin", compareHtml);
    ok("Compare roles is the matrix, presets and all", compareHtml.includes(">Compare roles<") && compareHtml.includes('aria-label="Find a permission"'));

    actorId = auditor.id;
    const rolesReviewer = await renderPage("roles");
    keep("roles-tab-reviewer", rolesReviewer);
    ok("a reviewer can open every role to read it, and change none", rolesReviewer.includes('aria-label="View role Sales"') && !rolesReviewer.includes('aria-label="Edit role') && !rolesReviewer.includes(">New role<") && !rolesReviewer.includes("More actions for"));

    actorId = admin.id;
    ok("the Exceptions tab still renders", (await renderPage("exceptions")).includes("Every permission granted or denied to one person"));
    ok("  and so does Who can", (await renderPage("who")).includes("The reverse of every other screen here."));

    section("8. The name");
    ok("Settings lists it as Staff & roles", SETTINGS_ITEMS.find((i) => i.key === "access")?.label === "Staff & roles");
    ok("  and the browser tab says so", (PAGE as unknown as { metadata?: { title?: string } }).metadata?.title === "Staff & roles");
    const sidebar = fs.readFileSync(path.join(__dirname, "../src/components/layout/sidebar.tsx"), "utf8");
    ok("  as does the sidebar", sidebar.includes('label: "Staff & roles"') && !sidebar.includes('label: "Users & Access"'));
  } finally {
    actorId = "";
    mailer.setTestPlatformMailer(null);
    await cleanup(db);
    await db.$disconnect();
  }

  console.log(failures === 0 ? `\nStaff & roles: all ${passes} checks passed.\n` : `\n${failures} FAILED, ${passes} passed\n`);
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
