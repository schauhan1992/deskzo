/**
 * Console staff, from the server — above all the first owner, before anybody can sign in to add them.
 *
 *   npm run platform:staff -- list
 *   npm run platform:staff -- create --email asha@wroffy.com --name "Asha" [--role OWNER]
 *   npm run platform:staff -- link <email>          a new one-time link to choose a password
 *   npm run platform:staff -- role <email> <OWNER|ADMIN|SUPPORT|BILLING|READONLY>
 *   npm run platform:staff -- reset-2fa <email>     a lost phone: they enrol again at their next sign-in
 *   npm run platform:staff -- deactivate <email>
 *
 * No password is ever given here: `create` and `link` print a link to choose one (it is emailed too),
 * and two-factor is enrolled at the first sign-in. The last active owner cannot be demoted or switched
 * off. Everything is in the platform's audit log, as this script.
 */
import "dotenv/config";
import type { StaffRole } from "@wroffy/control-client";
import { closeControlDb, controlDb } from "../src/lib/platform/control-db";
import { createStaff, deactivateStaff, issuePasswordSetup, resetStaffTwoFactor, setStaffRole } from "../src/lib/platform/staff";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const ACTOR = "script:platform:staff";
const ROLES: StaffRole[] = ["OWNER", "ADMIN", "SUPPORT", "BILLING", "READONLY"];

function roleFrom(value: string | undefined): StaffRole {
  const role = (value ?? "").toUpperCase() as StaffRole;
  if (!ROLES.includes(role)) throw new Error(`A role is one of ${ROLES.join(", ")}.`);
  return role;
}

async function byEmail(email: string | undefined) {
  if (!email) throw new Error("Whose? Give their email address.");
  const user = await controlDb().platformUser.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user) throw new Error(`There is no staff member ${email}.`);
  return user;
}

async function main() {
  const [command, target, extra] = args;
  switch (command) {
    case "list": {
      const rows = await controlDb().platformUser.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] });
      if (!rows.length) console.log("No staff yet. Make the first owner: npm run platform:staff -- create --email … --name … --role OWNER");
      for (const r of rows) {
        const twoFactor = r.totpEnabledAt ? "2fa on " : "2fa off";
        console.log(`${r.email.padEnd(36)} ${r.role.padEnd(9)} ${twoFactor} ${r.active ? "active  " : "off     "}${r.name}`);
      }
      return;
    }
    case "create": {
      const owners = await controlDb().platformUser.count({ where: { role: "OWNER", active: true } });
      // The first account has to be an owner, or nobody could ever add anybody from the console.
      const role = flag("role") ? roleFrom(flag("role")) : owners ? "SUPPORT" : "OWNER";
      if (!owners && role !== "OWNER") throw new Error("There is no owner yet, so the first account must be one: --role OWNER.");
      const made = await createStaff({ email: flag("email") ?? "", name: flag("name") ?? "", role }, ACTOR);
      console.log(`Added as ${role}. Their link to choose a password (works once, for 3 days):\n${made.setupUrl}`);
      return;
    }
    case "link": {
      const user = await byEmail(target);
      if (!user.active) throw new Error(`${user.email} is switched off.`);
      const url = await issuePasswordSetup(user.id);
      await controlDb().platformAuditLog.create({ data: { actorKind: "SCRIPT", actor: "platform:staff", action: "staff.setup-link", detail: { email: user.email } } });
      console.log(`A new link for ${user.email} (the previous one no longer works):\n${url}`);
      return;
    }
    case "role": {
      const user = await byEmail(target);
      const role = roleFrom(extra);
      await setStaffRole(user.id, role, ACTOR);
      console.log(`${user.email} is now ${role}.`);
      return;
    }
    case "reset-2fa": {
      const user = await byEmail(target);
      await resetStaffTwoFactor(user.id, ACTOR);
      console.log(`${user.email}'s authenticator is removed and they are signed out; they enrol a new one at their next sign-in.`);
      return;
    }
    case "deactivate": {
      const user = await byEmail(target);
      await deactivateStaff(user.id, ACTOR);
      console.log(`${user.email} is switched off and signed out.`);
      return;
    }
    default:
      console.log("Commands: list, create, link, role, reset-2fa, deactivate — see the top of scripts/platform-staff.ts.");
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeControlDb());
