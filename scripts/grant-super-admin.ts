/**
 * The break-glass path.
 *
 * Every other route to super admin runs through the application, and the application is exactly what
 * is unavailable when you need this: nobody holds the flag, the only holder has left, or a bad
 * change has locked the access screen. So this needs no session and no running app — only the
 * database.
 *
 * Guard it the way you guard database access itself, because that is precisely what it is.
 *
 *   npx tsx scripts/grant-super-admin.ts someone@example.com
 *
 * ## It transfers, it does not add
 *
 * There is exactly one super admin and the database enforces it from both sides —
 * `users_one_super_admin` refuses a second, `users_require_remaining_super_admin` refuses to remove
 * the last. So "grant" here means *move*: the current holder is demoted and the named account
 * promoted, in one transaction, because for the instant between those two statements the rule would
 * otherwise be broken in one direction or the other.
 *
 * `--revoke` is gone with the same reasoning. Revoking the only holder is exactly the state the
 * trigger exists to prevent, and it was the state this script existed to recover from — a flag that
 * could only ever produce a refusal or a disaster.
 */
import { db } from "../src/lib/db";
import { legacyTenant } from "../src/lib/tenancy/registry";
import { runAsTenant } from "../src/lib/tenancy/resolve";

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();

  if (!email) {
    console.error("Usage: npx tsx scripts/grant-super-admin.ts <email>");
    console.error("Moves super admin to that account. There is only ever one.");
    process.exit(1);
  }
  if (process.argv.includes("--revoke")) {
    console.error("--revoke is gone: there is exactly one super admin, so revoking is a transfer.");
    console.error("Name the account it should move to instead.");
    process.exit(1);
  }

  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true, role: true, active: true, isSuperAdmin: true },
  });
  if (!user) {
    console.error(`No account with the address ${email}.`);
    const nearby = await db.user.findMany({ select: { email: true }, orderBy: { email: "asc" }, take: 10 });
    console.error(`Known addresses include: ${nearby.map((u) => u.email).join(", ")}`);
    process.exit(1);
  }

  const current = await db.user.findFirst({
    where: { isSuperAdmin: true },
    select: { id: true, name: true, email: true },
  });

  if (current?.id === user.id) {
    console.log(`${user.name} <${user.email}> already holds it. Nothing to do.`);
    process.exit(0);
  }

  /**
   * Demote then promote, inside one transaction.
   *
   * The order matters and so does the atomicity. Promoting first hits `users_one_super_admin`,
   * because for that statement there are briefly two. Demoting first outside a transaction leaves a
   * window with none — and if the promote then fails, that window never closes and the only tool
   * for fixing it is this script, which has just caused the problem.
   *
   * Inside a transaction both are true at once from every other session's point of view, and a
   * failure at either statement leaves the holder exactly where it was.
   */
  await db.$transaction(async (tx) => {
    if (current) {
      await tx.user.update({ where: { id: current.id }, data: { isSuperAdmin: false } });
    }
    // Role and active status are forced, not merely required. The CHECK constraint refuses a super
    // admin who is not an ADMIN, and a deactivated one cannot sign in to use it — both of which
    // would turn a recovery into a second incident.
    await tx.user.update({
      where: { id: user.id },
      data: { isSuperAdmin: true, role: "ADMIN", active: true },
    });
  });

  if (current) console.log(`Moved super admin from ${current.name} <${current.email}>.`);
  console.log(`${user.name} <${user.email}> is now the super admin (role ADMIN, active).`);
  if (user.role !== "ADMIN") console.log(`  Their role was ${user.role} and has been changed to ADMIN.`);
  if (!user.active) console.log("  Their account was deactivated and has been reactivated.");

  // Recorded against the target rather than an actor, because there is no session here. The detail
  // says how it happened, so an auditor reading the trail is not left with an unexplained change.
  await db.permissionChange.create({
    data: {
      actorUserId: user.id,
      subjectType: "USER",
      subjectUserId: user.id,
      changeKind: "SUPER_ADMIN_GRANTED",
      detail: `Applied from the command line with database access (scripts/grant-super-admin.ts), outside any session`,
    },
  });

  const remaining = await db.user.findMany({
    where: { isSuperAdmin: true },
    select: { name: true, email: true, active: true },
  });
  console.log(`\nSuper admin now: ${remaining.map((u) => `${u.name} <${u.email}>${u.active ? "" : " (inactive)"}`).join(", ") || "none"}`);
  if (remaining.length !== 1) {
    // Should be unreachable — the index and the trigger both forbid it — so if it ever prints,
    // something has been done to this database outside the application.
    console.error(`WARNING: ${remaining.length} accounts hold super admin. There should be exactly one.`);
  }
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
