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
 *   npx tsx scripts/grant-super-admin.ts someone@example.com --revoke
 */
import { db } from "../src/lib/db";

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  const revoking = process.argv.includes("--revoke");

  if (!email) {
    console.error("Usage: npx tsx scripts/grant-super-admin.ts <email> [--revoke]");
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

  if (revoking) {
    // The same rule the application enforces, repeated here because this path bypasses it: leaving
    // nobody with the flag is unrecoverable from inside the app, and this script would be the thing
    // you reached for — so it must not be the thing that caused it.
    const others = await db.user.count({
      where: { isSuperAdmin: true, active: true, id: { not: user.id } },
    });
    if (others === 0) {
      console.error(`Refusing: ${user.name} is the only active super admin. Promote somebody else first.`);
      process.exit(1);
    }
    await db.user.update({ where: { id: user.id }, data: { isSuperAdmin: false } });
    console.log(`Removed super admin from ${user.name} <${user.email}>. ${others} remain.`);
  } else {
    // Role and active status are forced, not merely required. The CHECK constraint refuses a super
    // admin who is not an ADMIN, and a deactivated one cannot sign in to use it — both of which
    // would turn a recovery into a second incident.
    await db.user.update({
      where: { id: user.id },
      data: { isSuperAdmin: true, role: "ADMIN", active: true },
    });
    console.log(`${user.name} <${user.email}> is now a super admin (role ADMIN, active).`);
    if (user.role !== "ADMIN") console.log(`  Their role was ${user.role} and has been changed to ADMIN.`);
    if (!user.active) console.log("  Their account was deactivated and has been reactivated.");
  }

  // Recorded against the target rather than an actor, because there is no session here. The detail
  // says how it happened, so an auditor reading the trail is not left with an unexplained change.
  await db.permissionChange.create({
    data: {
      actorUserId: user.id,
      subjectType: "USER",
      subjectUserId: user.id,
      changeKind: revoking ? "SUPER_ADMIN_REVOKED" : "SUPER_ADMIN_GRANTED",
      detail: `Applied from the command line with database access (scripts/grant-super-admin.ts), outside any session`,
    },
  });

  const remaining = await db.user.findMany({
    where: { isSuperAdmin: true },
    select: { name: true, email: true, active: true },
  });
  console.log(`\nSuper admins now: ${remaining.map((u) => `${u.name} <${u.email}>${u.active ? "" : " (inactive)"}`).join(", ") || "none"}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
