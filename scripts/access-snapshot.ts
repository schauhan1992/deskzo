/**
 * What every role and every real user can actually do, right now.
 *
 * Run before and after the role-check conversion and diff the two. The conversion's whole safety
 * property is "nothing widens" — today these checks admit admins only, and after the change they
 * must still admit exactly the same people until somebody deliberately grants more. Reading the
 * diff is the only way to know that, because a conversion that quietly hands `catalog.manage` to
 * SALES compiles, passes every check, and is invisible until a salesperson deletes a brand.
 *
 *   npm run access:snapshot > before.txt
 *   ... change permissions ...
 *   npm run access:snapshot > after.txt && diff before.txt after.txt
 */
import { db } from "../src/lib/db";
import { PERMISSIONS } from "../src/lib/permissions";
import { resolveUserPermissions } from "../src/lib/authz/resolve";
import { ROLES } from "../src/lib/roles";

async function main() {
  const keys = PERMISSIONS.map((p) => p.key).sort();

  console.log(`# Registry: ${keys.length} keys`);
  console.log(keys.join("\n"));

  console.log(`\n# Effective access, by user`);
  const users = await db.user.findMany({
    where: { active: true },
    select: { id: true, name: true, email: true, role: true, isSuperAdmin: true },
    orderBy: [{ role: "asc" }, { email: "asc" }],
  });

  for (const u of users) {
    const resolved = await resolveUserPermissions(u.id);
    const held = keys.filter((k) => {
      const s = resolved.sources.get(k);
      if (!s) return false;
      if (s.via === "none" || s.via === "inactive") return false;
      if (s.via === "userGrant" || s.via === "roleOverride") return s.allowed;
      return true;
    });
    console.log(`${u.email} [${u.role}${u.isSuperAdmin ? "+super" : ""}] ${held.length}: ${held.join(",")}`);
  }

  // Role-level view too, so a role with no current holder is still covered — otherwise a conversion
  // that widens PURCHASE goes unnoticed simply because nobody happened to be sampled.
  console.log(`\n# Registry defaults, by role`);
  for (const role of ROLES) {
    const byDefault = PERMISSIONS.filter((p) => (p.defaultRoles as readonly string[]).includes(role)).map((p) => p.key);
    console.log(`${role} ${byDefault.length}: ${byDefault.sort().join(",")}`);
  }

  console.log(`\n# Stored role overrides`);
  const overrides = await db.rolePermission.findMany({ orderBy: [{ role: "asc" }, { permission: "asc" }] });
  for (const o of overrides) console.log(`${o.role} ${o.permission} = ${o.allowed}`);
  if (overrides.length === 0) console.log("(none)");

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
