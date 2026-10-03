/**
 * An admin resetting somebody's password (src/actions/user.ts `sendPasswordResetEmail`,
 * `resetPasswordToTemporary`; src/lib/admin-password.ts).
 *
 *   1. The temporary password: twelve characters, a capital, a small letter and a digit always, none of
 *      0/O/1/l/I, never the same twice.
 *   2. The one-click email: to their own address, a link for 24 hours that replaces any earlier one; their
 *      current password and sessions untouched. When it can't be sent, the link comes back only to an admin
 *      who holds everything they hold.
 *   3. The temporary password: the account's new password, to be changed at next sign-in; signed out
 *      everywhere; any emailed link dead; told by email without the password; audited.
 *   4. Who may: users.manage, as themselves; not yourself, not the super admin, not a switched-off or
 *      never-set-up account, not somebody a password can't let in; a temporary password only for an admin
 *      who holds all they hold.
 *   5. The person then chooses their own, with the temporary one as their current password.
 *   6. What the Staff screen draws: the row's one-click button and the dialog's Password section, only
 *      where they apply.
 *
 * The real actions, with the session, `next/cache`, the dialog's portal and the platform account hooks
 * substituted. No mail leaves (the platform mailer is replaced). Fixtures are named ZZPWRESET /
 * @zzpwreset-check.invalid and removed in a finally.
 *
 *   npm run check:admin-password
 */
import "dotenv/config";
import Module from "node:module";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import bcrypt from "bcryptjs";

const TAG = "ZZPWRESET";
const MAIL = "@zzpwreset-check.invalid";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

// ─── Stand-ins ───────────────────────────────────────────────────────────────────────────────────
let actor: { id: string; name: string } | null = null;
let viewingAs = false;
const internals = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    class UnauthorizedError extends Error {}
    const user = () => (actor ? { id: actor.id, name: actor.name, email: `probe${MAIL}`, role: "ADMIN" } : null);
    return {
      UnauthorizedError,
      requireUser: async () => {
        const u = user();
        if (!u) throw new UnauthorizedError("signed out");
        return u;
      },
      currentUser: async () => user(),
      viewAsContext: async () => (viewingAs ? { user: user() } : null),
      refuseWhileViewingAs: async () => (viewingAs ? "Not while viewing as somebody else." : null),
    };
  }
  if (request === "next/navigation") {
    return {
      useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {}, prefetch() {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => "/settings/access",
    };
  }
  if (request === "@/components/ui/dialog" || request.endsWith("components/ui/dialog")) {
    return {
      Dialog: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
        open ? createElement("div", { role: "dialog", "aria-label": title }, children) : null,
    };
  }
  if (request === "@/lib/platform/account-hooks" || request.endsWith("lib/platform/account-hooks")) {
    return { accountsChanged: async () => {} };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

// ─── Main ────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
  const { temporaryPassword } = require("../src/lib/admin-password") as typeof import("../src/lib/admin-password");
  const { noPasswordYet } = require("../src/lib/no-password") as typeof import("../src/lib/no-password");
  const USER = require("../src/actions/user") as typeof import("../src/actions/user");
  const PROFILE = require("../src/actions/profile") as typeof import("../src/actions/profile");
  const { EditStaffDialog } = require("../src/components/settings/staff/edit-staff-dialog") as typeof import("../src/components/settings/staff/edit-staff-dialog");
  const { StaffTable } = require("../src/components/settings/staff/staff-table") as typeof import("../src/components/settings/staff/staff-table");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const mail: { to: string; subject: string; text: string }[] = [];
  let mailDown = false;
  mailer.setTestPlatformMailer(async (m) => {
    if (mailDown) throw new Error("SMTP unreachable");
    mail.push(m);
  });

  await cleanup(db);
  try {
    section("1. The temporary password");
    const made = Array.from({ length: 300 }, () => temporaryPassword());
    ok("three groups of four", made.every((p) => /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/.test(p)), made[0]);
    ok("  always a capital, a small letter and a digit", made.every((p) => /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p)));
    ok("  never a character somebody would misread", made.every((p) => !/[0O1lI]/.test(p)));
    ok("  never the same twice", new Set(made).size === made.length);

    // ── Fixtures ──────────────────────────────────────────────────────────────────────────────────
    const LIMITED = `${TAG}_USERS`;
    await db.role.create({ data: { key: LIMITED, name: `${TAG} User manager`, sortOrder: 995 } });
    await db.rolePermission.createMany({ data: [{ role: LIMITED, permission: "users.manage", allowed: true }] });
    // A placeholder nothing can match — not a password anybody knows, and not "awaiting setup" either.
    const signedUp = "zz-fixture-placeholder";
    const mk = (name: string, local: string, role: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name: `${TAG} ${name}`, email: `${local}${MAIL}`, role, passwordHash: signedUp, ...extra }, select: { id: true, name: true, email: true } });
    const admin = await mk("Admin", "admin", "ADMIN");
    const limited = await mk("Limited", "limited", LIMITED);
    const asha = await mk("Asha", "asha", "SALES");
    const invited = await mk("Invited", "invited", "SALES", { passwordHash: noPasswordYet() });
    const off = await mk("Off", "off", "SALES", { active: false });
    const ssoOnly = await mk("Sso", "sso", "SALES");
    await db.signInRule.create({ data: { userId: ssoOnly.id, method: "MICROSOFT" } });
    const superAdmin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
    const as = (u: { id: string; name: string }) => {
      actor = u;
    };
    const ashaRow = () => db.user.findUniqueOrThrow({ where: { id: asha.id }, select: { passwordHash: true, mustChangePassword: true } });
    const openLinks = () => db.passwordResetToken.findMany({ where: { userId: asha.id, usedAt: null } });

    section("2. The one-click email");
    as(admin);
    const session = await db.signIn.create({ data: { sid: `${TAG}-sid-1`, userId: asha.id, provider: "credentials" }, select: { id: true } });
    const sent = await USER.sendPasswordResetEmail(asha.id);
    ok("an admin sends it", sent.ok && sent.data.emailed === true, sent.ok ? sent.data : sent.error);
    const letter = mail.find((m) => m.to === asha.email);
    ok("  to their own address", Boolean(letter) && /^Set a new password for /.test(letter!.subject), letter?.subject);
    ok("  with a link to choose a new one", /\/reset-password\?t=[\w-]+/.test(letter?.text ?? "") && (letter?.text ?? "").includes(`${TAG} Admin sent you a link`));
    let links = await openLinks();
    ok("  one link, for 24 hours", links.length === 1 && Math.abs(links[0]!.expiresAt.getTime() - Date.now() - 24 * 3_600_000) < 60_000);
    ok("  their current password is untouched", (await ashaRow()).passwordHash === signedUp && (await ashaRow()).mustChangePassword === false);
    ok("  and they're still signed in", (await db.signIn.findUniqueOrThrow({ where: { id: session.id } })).endedAt === null);
    const first = links[0]!.tokenHash;
    await USER.sendPasswordResetEmail(asha.id);
    links = await openLinks();
    ok("sending again replaces the link", links.length === 1 && links[0]!.tokenHash !== first);
    const audit = await db.auditLog.findFirst({ where: { entityId: asha.id, userId: admin.id }, orderBy: { createdAt: "desc" } });
    ok("  and it is audited", audit?.entityLabel === `${TAG} Asha — sent a password reset email`, audit?.entityLabel);

    mailDown = true;
    const fallback = await USER.sendPasswordResetEmail(asha.id);
    ok(
      "when the email can't be sent, an admin who holds all they hold gets the link once",
      fallback.ok && fallback.data.emailed === false && /\/reset-password\?t=/.test(fallback.data.resetUrl),
      fallback.ok ? fallback.data : fallback.error,
    );
    as(limited);
    const limitedFallback = await USER.sendPasswordResetEmail(asha.id);
    ok("  anybody else is only told it failed", !limitedFallback.ok && /couldn't be sent/.test(limitedFallback.error), limitedFallback.ok ? limitedFallback.data : limitedFallback.error);
    mailDown = false;
    const limitedSent = await USER.sendPasswordResetEmail(asha.id);
    ok("  though they may send the email itself", limitedSent.ok && limitedSent.data.emailed === true, limitedSent.ok ? "" : limitedSent.error);

    section("3. The temporary password");
    const limitedReset = await USER.resetPasswordToTemporary(asha.id);
    ok("an admin who doesn't hold all they hold can't", !limitedReset.ok && /only the super admin/.test(limitedReset.error), limitedReset.ok ? "reset" : limitedReset.error);
    ok("  and nothing changed", (await ashaRow()).passwordHash === signedUp);
    as(admin);
    mail.length = 0;
    const reset = await USER.resetPasswordToTemporary(asha.id);
    ok("an admin who does resets it", reset.ok, reset.ok ? "" : reset.error);
    const password = reset.ok ? reset.data.password : "";
    const row = await ashaRow();
    ok("  it is their password now", Boolean(password) && (await bcrypt.compare(password, row.passwordHash)));
    ok("  to be changed at next sign-in", row.mustChangePassword === true);
    ok("  they're signed out everywhere", (await db.signIn.findUniqueOrThrow({ where: { id: session.id } })).endedAt !== null);
    ok("  the emailed link no longer works", (await openLinks()).length === 0);
    const notice = mail.find((m) => m.to === asha.email);
    ok("  they're told by email", /was reset$/.test(notice?.subject ?? ""), notice?.subject);
    ok("  without the password in it", Boolean(notice) && !notice!.text.includes(password));
    const resetAudit = await db.auditLog.findFirst({ where: { entityId: asha.id, entityLabel: { contains: "temporary" } } });
    ok("  audited", resetAudit?.userId === admin.id, resetAudit?.entityLabel);
    const activity = await db.activityLog.findFirst({ where: { userId: asha.id, kind: "PASSWORD_CHANGED" }, orderBy: { createdAt: "desc" } });
    ok("  and in their activity", /reset to a temporary one by/.test(activity?.summary ?? ""), activity?.summary);

    section("4. Who may");
    const refused = async (label: string, run: () => Promise<{ ok: boolean; error?: string }>, expect: RegExp) => {
      const r = (await run()) as { ok: boolean; error?: string };
      ok(label, !r.ok && expect.test(r.error ?? ""), r.ok ? "allowed" : r.error);
    };
    await refused("not yourself", () => USER.resetPasswordToTemporary(admin.id), /That's you/);
    if (superAdmin) await refused("not the super admin, by an ordinary admin", () => USER.resetPasswordToTemporary(superAdmin.id), /./);
    await refused("not somebody who hasn't set up yet", () => USER.sendPasswordResetEmail(invited.id), /setup email instead/);
    await refused("not a switched-off account", () => USER.resetPasswordToTemporary(off.id), /Switch them on first/);
    await refused("not somebody a password can't let in", () => USER.resetPasswordToTemporary(ssoOnly.id), /sign/);
    await refused("not without users.manage", async () => {
      as(asha);
      const r = await USER.sendPasswordResetEmail(limited.id);
      as(admin);
      return r;
    }, /can't reset passwords/);
    viewingAs = true;
    await refused("not while viewing as somebody", () => USER.resetPasswordToTemporary(asha.id), /viewing as/);
    viewingAs = false;
    await refused("not somebody who isn't there", () => USER.sendPasswordResetEmail("nobody"), /no longer exists/);
    const before = await ashaRow();
    ok("  none of those changed her password", before.passwordHash === row.passwordHash);

    section("5. They choose their own");
    as(asha);
    const own = `${temporaryPassword()}${temporaryPassword()}`;
    const changed = await PROFILE.changeOwnPassword({ currentPassword: password, newPassword: own, confirmPassword: own });
    ok("with the temporary one as their current password", changed.ok, changed.ok ? "" : changed.error);
    const after = await ashaRow();
    ok("  and then it's theirs, and nothing more is asked", after.mustChangePassword === false && (await bcrypt.compare(own, after.passwordHash)));
    as(admin);

    section("6. What the Staff screen draws");
    const staffRow = (over: Record<string, unknown> = {}) => ({
      id: asha.id,
      name: `${TAG} Asha`,
      email: asha.email,
      role: "SALES",
      roleName: "Sales",
      isSuperAdmin: false,
      status: "active" as const,
      active: true,
      setupPending: false,
      setupLinkIssued: false,
      tempPassword: false,
      photoUpdatedAt: null,
      jobTitle: null,
      phone: null,
      departmentId: null,
      departmentName: null,
      managerId: null,
      managerName: null,
      branchId: null,
      twoFactorOn: false,
      holds: 10,
      total: 100,
      exceptions: 0,
      lapsingSoon: false,
      openLeads: null,
      overdueLeads: null,
      lastSignIn: null,
      isYou: false,
      ...over,
    });
    const dialog = (over: Record<string, unknown> = {}) =>
      renderToStaticMarkup(
        createElement(EditStaffDialog, {
          row: staffRow(over),
          onClose: () => {},
          roles: [{ key: "SALES", name: "Sales" }],
          departments: [],
          people: [],
          branches: null,
          mayAssignRole: true,
          mayChangeManager: true,
        }) as ReactElement,
      );
    const plain = dialog();
    ok("the dialog has a Password section with both ways", plain.includes(">Password") && plain.includes("Send reset email") && plain.includes("Reset password"));
    ok("  marks a temporary password", dialog({ tempPassword: true }).includes("Temporary"));
    ok("  not for yourself", !dialog({ isYou: true }).includes("Send reset email"));
    ok("  not before they've set up — that's the setup email", !dialog({ setupPending: true, status: "invited" }).includes("Send reset email"));
    ok("  not for a switched-off account", !dialog({ active: false, status: "off" }).includes("Send reset email"));

    const table = (rows: ReturnType<typeof staffRow>[]) =>
      renderToStaticMarkup(
        createElement(StaffTable, {
          rows,
          roles: [{ key: "SALES", name: "Sales" }],
          departments: [],
          branches: null,
          mayEdit: true,
          mayAssignRole: true,
          mayManageAccess: true,
          viewerIsSuperAdmin: false,
          showLeads: false,
          showSignIns: false,
        }) as ReactElement,
      );
    const listed = table([staffRow(), staffRow({ id: "you", name: `${TAG} You`, isYou: true }), staffRow({ id: "inv", name: `${TAG} Inv`, setupPending: true, status: "invited" }), staffRow({ id: "tmp", name: `${TAG} Tmp`, tempPassword: true })]);
    ok("the row has the one-click button", listed.includes(`aria-label="Send ${TAG} Asha a password reset email"`));
    ok("  not on your own row", !listed.includes(`Send ${TAG} You a password reset email`));
    ok("  nor an invited one's", !listed.includes(`Send ${TAG} Inv a password reset email`));
    ok("  and a temporary password shows on its row", listed.includes("Temporary password"));
    const readOnly = renderToStaticMarkup(
      createElement(StaffTable, {
        rows: [staffRow()],
        roles: [],
        departments: [],
        branches: null,
        mayEdit: false,
        mayAssignRole: false,
        mayManageAccess: false,
        viewerIsSuperAdmin: false,
        showLeads: false,
        showSignIns: false,
      }) as ReactElement,
    );
    ok("  and nobody without users.manage is offered it", !readOnly.includes("password reset email"));
  } finally {
    mailer.setTestPlatformMailer(null);
    await cleanup(db);
    const left = await db.user.count({ where: { email: { endsWith: MAIL } } });
    ok("the fixtures are gone", left === 0, left);
  }

  console.log(failures === 0 ? `\nAll ${passes} admin password checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** Everything the fixtures made, found by their address and names. */
async function cleanup(db: typeof import("../src/lib/db").db) {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await db.activityLog.deleteMany({ where: { userId: { in: ids } } });
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: ids } }] } });
  await db.passwordResetToken.deleteMany({ where: { userId: { in: ids } } });
  await db.signIn.deleteMany({ where: { userId: { in: ids } } });
  await db.signInRule.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.rolePermission.deleteMany({ where: { role: { startsWith: TAG } } });
  await db.role.deleteMany({ where: { key: { startsWith: TAG } } });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
