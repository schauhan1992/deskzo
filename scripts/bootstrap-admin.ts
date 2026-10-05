/**
 * Creates the first account on an empty database.
 *
 * The alternative is `npm run db:seed`, which creates four demo staff with the password
 * `ChangeMe123!` — a password published in this repository's README. That is fine for a throwaway
 * development database and wrong for one somebody is about to start entering real customers into,
 * because the demo accounts are real logins that outlive everyone's memory of them.
 *
 * So this creates exactly one super admin and nothing else. The password comes from the
 * environment, never from a file in the repository, and is hashed before it touches the database.
 *
 *   ADMIN_EMAIL=you@deskzo.com ADMIN_PASSWORD='a real password' ADMIN_NAME='Your Name' npm run db:bootstrap
 *
 * On Windows PowerShell:
 *
 *   $env:ADMIN_EMAIL="you@deskzo.com"; $env:ADMIN_PASSWORD="a real password"; npm run db:bootstrap
 *
 * Clear the variables afterwards, or your shell history keeps the password.
 */
import bcrypt from "bcryptjs";
import { db, getTenantDb } from "../src/lib/db";
import { bootstrapOwner } from "../src/lib/platform/bootstrap-owner";
import { legacyTenant } from "../src/lib/tenancy/registry";
import { runAsTenant } from "../src/lib/tenancy/resolve";

async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME?.trim() || "Administrator";

  if (!email || !password) {
    console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD. See the comment at the top of this file.");
    process.exit(1);
  }
  if (!email.includes("@")) {
    console.error("ADMIN_EMAIL does not look like an address.");
    process.exit(1);
  }
  /**
   * A floor rather than a policy.
   *
   * Eight is the refusal point; anything below twelve is warned about but allowed. The distinction
   * is deliberate: a hard minimum set where *I* think it should be turns into an obstacle somebody
   * routes around — by picking `Password12345`, or by editing this line — and neither outcome is
   * better than a weak password chosen knowingly. This account holds every permission, cannot be
   * locked out and cannot be deleted, so the warning says so and then gets out of the way.
   */
  if (password.length < 8) {
    console.error("ADMIN_PASSWORD must be at least 8 characters.");
    process.exit(1);
  }

  const warnings: string[] = [];
  if (password.length < 12) warnings.push(`only ${password.length} characters`);
  if (/^change/i.test(password)) {
    warnings.push("starts with “change”, like the ChangeMe123! published in this repo's README");
  }
  if (!/[^A-Za-z0-9]/.test(password)) warnings.push("no symbols");

  const existing = await db.user.count();
  if (existing > 0) {
    // Refusing rather than upserting: on a database that already has accounts, the thing somebody
    // usually wants is scripts/grant-super-admin.ts, and silently creating a second admin here
    // would be a way to add one without anybody noticing.
    console.error(
      `Refusing: this database already has ${existing} account(s). ` +
        `Use \`npx tsx scripts/grant-super-admin.ts <email>\` to promote one instead.`,
    );
    process.exit(1);
  }

  // The same account a signup's owner gets (src/lib/platform/bootstrap-owner.ts). Not forced to
  // change the password: it was chosen by the person running this, not issued to them.
  const user = await bootstrapOwner(await getTenantDb(), { name, email, passwordHash: await bcrypt.hash(password, 10) });

  console.log(`\nCreated super admin: ${user.name} <${user.email}>`);
  console.log("Sign in at /login. Nothing else was created — no demo data, no other accounts.");

  if (warnings.length > 0) {
    console.log(`\n  ⚠  This password has ${warnings.join(", ")}.`);
    console.log("     It belongs to the one account that holds every permission, cannot be locked");
    console.log("     out by any setting, and cannot be deleted. Change it from /profile before");
    console.log("     anybody else uses this installation.");
  }
  console.log("");
  process.exit(0);
}

/**
 * As the first workspace, named here: a script has no request to say which, and only a development
 * .env switches on the fallback that would otherwise pick it (DESKZO_TENANCY_FALLBACK).
 */
async function asFirstWorkspace() {
  const tenant = await legacyTenant();
  if (!tenant) {
    console.error("There is no first workspace: set DATABASE_URL, or run npm run platform:adopt.");
    process.exit(1);
  }
  await runAsTenant(tenant, main);
}

asFirstWorkspace().catch((err) => {
  console.error(err);
  process.exit(1);
});
