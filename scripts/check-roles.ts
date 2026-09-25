/**
 * That a role somebody creates is a real role.
 *
 * Roles stopped being a Postgres enum and became rows, which means the eight the application ships
 * with are no longer the eight that exist. Everything downstream has to cope: the permission matrix
 * has to grow a column, the resolver has to answer for a key it has never seen, and the foreign keys
 * have to refuse the two deletions that would leave somebody holding nothing.
 *
 * Run against the real actions with a substituted session, so what is checked is the path the
 * screen takes rather than a re-implementation of it. Everything it creates is prefixed ZZPROBE and
 * removed in a finally, so it is safe against a database with real data in it.
 *
 *   npm run check:roles
 */
import "dotenv/config";
import Module from "node:module";
import { db } from "../src/lib/db";

const KEY = "ZZPROBE_REGIONAL_MANAGER";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};

/** The actions need a session; substitute one, the way the other suites do. */
const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const original = internals._load;
let actorId = "";
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") {
    // revalidatePath wants a render store. Which pages re-render is not what this is testing.
    return { revalidatePath: () => {}, revalidateTag: () => {} };
  }
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    return { requireUser: async () => ({ id: actorId, name: "Probe" }), currentUser: async () => ({ id: actorId, name: "Probe" }) };
  }
  return original.call(this, request, parent, isMain);
} as typeof original;

async function main() {
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin");
  actorId = admin.id;

  const { createRole, updateRole, deleteRole, listRolesForScreen } = await import("../src/actions/role");
  const { getPermissionMatrix } = await import("../src/actions/permission");

  await db.role.deleteMany({ where: { key: KEY } });

  try {
    // ── Create ──────────────────────────────────────────────────────────────────────────────────
    const made = await createRole({ name: "ZZprobe Regional Manager", description: "Runs a territory" });
    ok("a role can be created", made.ok, made.ok ? made.data.key : made.error);
    if (!made.ok) return;
    ok("  and its key is derived from the name", made.data.key === KEY, made.data.key);

    // ── It is a real column in the matrix ────────────────────────────────────────────────────────
    const matrix = await getPermissionMatrix();
    const row = matrix[0];
    ok("it appears as a column in the permission matrix", row !== undefined && KEY in row.roles, Object.keys(row?.roles ?? {}).length + " columns");
    ok(
      "  holding nothing to begin with",
      matrix.every((r) => r.roles[KEY] === false),
      "a role that arrives holding a guess is worse than one that arrives empty",
    );

    // ── It can be granted a permission like any other ────────────────────────────────────────────
    await db.rolePermission.create({ data: { role: KEY, permission: "tickets.create", allowed: true } });
    const after = await getPermissionMatrix();
    ok(
      "a permission granted to it sticks",
      after.find((r) => r.key === "tickets.create")?.roles[KEY] === true,
      "the matrix reads role_permissions, which now has a foreign key to the role",
    );

    // ── Rename is free ───────────────────────────────────────────────────────────────────────────
    const renamed = await updateRole({ key: KEY, name: "ZZprobe Area Head" });
    ok("it can be renamed", renamed.ok, renamed.ok ? "" : renamed.error);
    const reread = await db.role.findUnique({ where: { key: KEY }, select: { key: true, name: true } });
    ok("  the name changed and the key did not", reread?.name === "ZZprobe Area Head" && reread?.key === KEY, `${reread?.name} / ${reread?.key}`);
    ok(
      "  and the permission survived the rename",
      (await db.rolePermission.count({ where: { role: KEY } })) === 1,
      "nothing is keyed on the name, which is the whole reason renaming is safe",
    );

    // ── Refusals ─────────────────────────────────────────────────────────────────────────────────
    const builtin = await deleteRole("SALES");
    ok("a built-in role cannot be deleted", !builtin.ok, builtin.ok ? "it was deleted" : builtin.error.slice(0, 80));

    const user = await db.user.findFirst({ where: { role: "SALES" }, select: { id: true, role: true } });
    await db.user.update({ where: { id: user!.id }, data: { role: KEY } });
    const held = await deleteRole(KEY);
    ok("a role somebody holds cannot be deleted", !held.ok, held.ok ? "it was deleted" : held.error.slice(0, 90));
    await db.user.update({ where: { id: user!.id }, data: { role: user!.role } });

    // Against a built-in, because a rename does not move the key — so reusing the *new* name would
    // have produced a different key and correctly created a second role. The first version of this
    // check did exactly that and read the right answer as a failure.
    const clash = await createRole({ name: "sales" });
    ok("a name that reduces to an existing key is refused, by name", !clash.ok, clash.ok ? "it was created" : clash.error.slice(0, 95));

    // ── Delete ───────────────────────────────────────────────────────────────────────────────────
    const gone = await deleteRole(KEY);
    ok("an unused custom role can be deleted", gone.ok, gone.ok ? "" : gone.error);
    ok(
      "  and its permission rows went with it",
      (await db.rolePermission.count({ where: { role: KEY } })) === 0,
      "ON DELETE CASCADE — they describe the role and mean nothing without it",
    );
    ok(
      "  while the audit trail still names it",
      (await db.permissionChange.count({ where: { subjectRole: KEY } })) >= 2,
      "no foreign key on subjectRole, on purpose: history must outlive the thing it describes",
    );

    const listed = await listRolesForScreen();
    ok("the screen lists the built-ins with headcounts", listed.ok && listed.data.length === 8,
       listed.ok ? listed.data.map((r) => `${r.name} ${r.headcount}`).join(", ") : listed.error);
  } finally {
    await db.rolePermission.deleteMany({ where: { role: { startsWith: "ZZPROBE" } } });
    await db.role.deleteMany({ where: { key: { startsWith: "ZZPROBE" } } });
    await db.permissionChange.deleteMany({ where: { subjectRole: { startsWith: "ZZPROBE" } } });
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nRoles can be created, renamed and deleted.\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
