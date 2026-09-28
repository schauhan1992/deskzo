/**
 * The website CMS's accounts, from the server — above all its first admin, before anybody can sign in
 * to add them.
 *
 *   npm run cms:user -- list
 *   npm run cms:user -- create --email asha@example.com --name "Asha" [--role ADMIN|EDITOR|AUTHOR|VIEWER]
 *   npm run cms:user -- link <email>              a new one-time link to choose a password
 *   npm run cms:user -- role <email> <ROLE>
 *   npm run cms:user -- reset-2fa <email>         a lost phone: their authenticator is forgotten
 *   npm run cms:user -- deactivate <email>
 *   npm run cms:user -- two-factor [required|optional]   show or set the CMS's two-factor policy
 *
 * No password is ever given here: `create` and `link` print a link to choose one (it is emailed too).
 * The last active admin cannot be demoted or switched off. Everything is in the CMS's activity log,
 * as "script". The CMS's address is cms.<PLATFORM_DOMAIN> (docs/runbook.md).
 */
import "dotenv/config";
import type { CmsRole } from "@wroffy/control-client";
import { cmsTwoFactorPolicy } from "../src/lib/cms/session";
import { CMS_ROLES } from "../src/lib/cms/types";
import { cmsAdminCount, createCmsUser, deactivateCmsUser, newCmsSetupLink, resetCmsUserTwoFactor, setCmsTwoFactorPolicy, setCmsUserRole } from "../src/lib/cms/users";
import { closeControlDb, controlDb } from "../src/lib/platform/control-db";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const SCRIPT = { kind: "script" } as const;

function roleFrom(value: string | undefined): CmsRole {
  const role = (value ?? "").toUpperCase() as CmsRole;
  if (!(CMS_ROLES as readonly string[]).includes(role)) throw new Error(`A role is one of ${CMS_ROLES.join(", ")}.`);
  return role;
}

async function byEmail(email: string | undefined) {
  if (!email) throw new Error("Whose? Give their email address.");
  const user = await controlDb().cmsUser.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user) throw new Error(`There is no CMS account ${email}.`);
  return user;
}

async function main() {
  const [command, target, extra] = args;
  switch (command) {
    case "list": {
      const rows = await controlDb().cmsUser.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] });
      if (!rows.length) console.log("No CMS accounts yet. Make the first admin: npm run cms:user -- create --email … --name … --role ADMIN");
      for (const r of rows) {
        const password = r.passwordHash ? "password set " : "link pending ";
        const twoFactor = r.totpEnabledAt ? "2fa on " : "2fa off";
        console.log(`${r.email.padEnd(36)} ${r.role.padEnd(7)} ${twoFactor} ${password}${r.active ? "active  " : "off     "}${r.name}`);
      }
      return;
    }
    case "create": {
      const admins = await cmsAdminCount();
      // The first account has to be an admin, or nobody could ever add anybody from inside the CMS.
      const role = flag("role") ? roleFrom(flag("role")) : admins ? "EDITOR" : "ADMIN";
      if (!admins && role !== "ADMIN") throw new Error("There is no CMS admin yet, so the first account must be one: --role ADMIN.");
      const made = await createCmsUser({ email: flag("email") ?? "", name: flag("name") ?? "", role }, SCRIPT);
      console.log(`Added as ${role}${made.emailed ? "" : " (the email could not be sent)"}. Their link to choose a password (works once, for 3 days):\n${made.setupUrl}`);
      return;
    }
    case "link": {
      const user = await byEmail(target);
      const sent = await newCmsSetupLink(user.id, SCRIPT, true);
      console.log(`A new link for ${user.email} (the previous one no longer works)${sent.emailed ? "" : " — the email could not be sent"}:\n${sent.setupUrl}`);
      return;
    }
    case "role": {
      const user = await byEmail(target);
      const role = roleFrom(extra);
      await setCmsUserRole(user.id, role, SCRIPT);
      console.log(`${user.email} is now ${role}.`);
      return;
    }
    case "reset-2fa": {
      const user = await byEmail(target);
      await resetCmsUserTwoFactor(user.id, SCRIPT);
      console.log(`${user.email}'s authenticator is removed and they are signed out.`);
      return;
    }
    case "deactivate": {
      const user = await byEmail(target);
      await deactivateCmsUser(user.id, SCRIPT);
      console.log(`${user.email} is switched off and signed out.`);
      return;
    }
    case "two-factor": {
      if (target !== "required" && target !== "optional") {
        const now = await cmsTwoFactorPolicy();
        console.log(`CMS two-factor is ${now.mode}${now.chosen ? "" : " (this environment's default — nobody has chosen)"}. Set it with: two-factor required | optional`);
        return;
      }
      await setCmsTwoFactorPolicy(target, SCRIPT);
      console.log(`CMS two-factor is now ${target}.`);
      return;
    }
    default:
      console.log("Commands: list, create, link, role, reset-2fa, deactivate, two-factor — see the top of scripts/cms-user.ts.");
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeControlDb());

