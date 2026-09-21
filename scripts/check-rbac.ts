/**
 * The invariants that keep the permission system honest.
 *
 * Every failure this catches is a silent one. A permission enforced but never declared disables a
 * module for everybody and looks like a bug in the module. A role missing from the assignable list
 * gives its holders an empty sidebar and working actions. A `"use server"` export with no
 * authorization check is an endpoint anybody can call, and nothing anywhere says so. None of these
 * throw, none appear on a screen, and all of them have happened in this codebase.
 *
 *   npm run check:rbac
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PERMISSIONS, PERMISSION_KEYS, permissionGroup, PERMISSION_GROUP_ORDER, getPermissionDefinition } from "../src/lib/permissions";
import { ROLES } from "../src/lib/roles";
import { ROLE_PRESETS, presetDiff, presetsForRole, getPreset } from "../src/lib/authz/presets";
import { db } from "../src/lib/db";
import { resolveUserPermissions } from "../src/lib/authz/resolve";
import { holdsFrom, resolveEveryone } from "../src/lib/authz/bulk";
import { MODULE_REGISTRY, navPermissionKeys } from "../src/lib/modules";
import { assertMayActOnTarget, assertNotSelf, assertNotOwnRecord, AuthzError } from "../src/lib/authz/guards";
import { SCOPE_ANCHORS } from "../src/lib/authz/scope";

let failures = 0;
function ok(label: string, pass: boolean, detail: string | number | null = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}
function eq(label: string, actual: unknown, expected: unknown, why = "") {
  const pass = actual === expected;
  console.log(
    `${pass ? "  ok  " : " FAIL "} ${label} — ${String(actual)}${pass ? "" : ` (expected ${String(expected)})`}${why ? ` · ${why}` : ""}`,
  );
  if (!pass) failures += 1;
}
function throws(label: string, fn: () => void, why = "") {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = err instanceof AuthzError;
  }
  ok(label, threw, why);
}

console.log("\n— The registry —\n");

ok("Every key has a label", PERMISSIONS.every((p) => p.label.length > 0));
ok("Every key has a description", PERMISSIONS.every((p) => p.description.length > 0), "the matrix shows it as the tooltip");
eq("No key is declared twice", new Set(PERMISSION_KEYS).size, PERMISSION_KEYS.length, `${PERMISSION_KEYS.length} keys`);
ok(
  "Every key is noun.verb",
  PERMISSIONS.every((p) => /^[a-z]+\.[a-zA-Z]+$/.test(p.key)),
  PERMISSIONS.filter((p) => !/^[a-z]+\.[a-zA-Z]+$/.test(p.key)).map((p) => p.key).join(", ") || "all conform",
);
ok(
  "Every key lands in a known section",
  PERMISSIONS.every((p) => (PERMISSION_GROUP_ORDER as readonly string[]).includes(permissionGroup(p))),
  PERMISSIONS.filter((p) => !(PERMISSION_GROUP_ORDER as readonly string[]).includes(permissionGroup(p))).map((p) => p.key).join(", ") || "all grouped",
);
ok(
  "No key lists ADMIN in defaultRoles",
  PERMISSIONS.every((p) => !(p.defaultRoles as readonly string[]).includes("ADMIN")),
  "an admin holds everything via the resolver, not via this array — listing it would make the two disagree",
);
ok(
  "Every superAdminOnly key is also non-delegable",
  PERMISSIONS.filter((p) => p.superAdminOnly).every((p) => p.delegable === false),
  "a key a super admin must grant should not arrive by inheriting it from a report",
);
ok(
  "Every critical key is non-delegable",
  PERMISSIONS.filter((p) => p.tier === "critical").every((p) => p.delegable === false),
  PERMISSIONS.filter((p) => p.tier === "critical" && p.delegable !== false).map((p) => p.key).join(", ") || "all held",
);

console.log("\n— Roles —\n");

// The bug this exists to prevent: ROLES omitted PURCHASE while three accounts held it, so those
// users had no column in the permission screen and an empty sidebar.
const PRISMA_ROLES = ["ADMIN", "PROFILE", "CALLING", "SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE"];
eq("The assignable list covers every role in the schema", ROLES.length, PRISMA_ROLES.length);
ok(
  "  and names exactly the same ones",
  PRISMA_ROLES.every((r) => (ROLES as readonly string[]).includes(r)),
  PRISMA_ROLES.filter((r) => !(ROLES as readonly string[]).includes(r)).join(", ") || "in step",
);

console.log("\n— Presets —\n");

ok("Every preset has at least one permission", ROLE_PRESETS.every((p) => p.permissions.length > 0));
eq("No preset key is duplicated", new Set(ROLE_PRESETS.map((p) => p.key)).size, ROLE_PRESETS.length);
ok(
  "Every preset names only real permissions",
  ROLE_PRESETS.every((p) => p.permissions.every((k) => getPermissionDefinition(k) !== undefined)),
  ROLE_PRESETS.flatMap((p) => p.permissions.filter((k) => !getPermissionDefinition(k)).map((k) => `${p.key}:${k}`)).join(", ") || "all real",
);
ok(
  "No preset hands out a super-admin-only key",
  ROLE_PRESETS.every((p) => p.permissions.every((k) => getPermissionDefinition(k)?.superAdminOnly !== true)),
  "those are granted one at a time by a person, never by a profile",
);
ok(
  "Every preset targets a role that exists",
  ROLE_PRESETS.every((p) => (ROLES as readonly string[]).includes(p.role)),
);

// Every key a preset is ALLOWED to contain should be reachable through one, or the preset list
// stops describing the job functions it claims to.
//
// Two exemptions, and the second was a contradiction this check used to contain: a superAdminOnly
// key is forbidden from appearing in any preset by the assertion above, while this one demanded it
// appear in at least one. No key could satisfy both. Administration keys are exempt for the
// original reason — they are granted to a person one at a time, never handed out by a profile.
const presetCovered = new Set(ROLE_PRESETS.flatMap((p) => p.permissions as readonly string[]));
const uncovered = PERMISSIONS.filter(
  (p) => permissionGroup(p) !== "Administration" && p.superAdminOnly !== true && !presetCovered.has(p.key),
).map((p) => p.key);
ok("Every non-admin permission appears in at least one preset", uncovered.length === 0, uncovered.join(", ") || "all covered");

const rolesWithPresets = new Set(ROLE_PRESETS.map((p) => p.role));
const rolesWithout = (ROLES as readonly string[]).filter((r) => r !== "ADMIN" && !rolesWithPresets.has(r as never));
ok("Every assignable role has a preset to start from", rolesWithout.length === 0, rolesWithout.join(", ") || "all covered");

const salesPresets = presetsForRole("SALES");
ok("presetsForRole finds them", salesPresets.length >= 2, `${salesPresets.length} for SALES`);
ok("getPreset resolves a known key", getPreset("accounts-manager")?.role === "ACCOUNTS");
ok("  and returns undefined for an unknown one", getPreset("not-a-preset") === undefined);

const exec = getPreset("sales-executive")!;
const noneHeld = Object.fromEntries(PERMISSIONS.map((p) => [p.key, false]));
const diffFromNothing = presetDiff(exec, noneHeld);
eq("A preset applied to nothing grants its whole list", diffFromNothing.willGrant.length, exec.permissions.length);
eq("  and revokes nothing", diffFromNothing.willRevoke.length, 0);
const allHeld = Object.fromEntries(PERMISSIONS.map((p) => [p.key, true]));
eq(
  "Applied over everything it revokes the rest",
  presetDiff(exec, allHeld).willRevoke.length,
  PERMISSIONS.length - exec.permissions.length,
  "a preset states what a role has, rather than only adding to it",
);

console.log("\n— Navigation —\n");

const navItems = MODULE_REGISTRY.flatMap((m) => m.navItems.map((i) => ({ module: m.key, ...i })));
const badNav = navItems.filter((i) => navPermissionKeys(i).some((k) => !getPermissionDefinition(k)));
ok(
  "Every gated nav item names a real permission",
  badNav.length === 0,
  badNav.map((i) => `${i.href}→${navPermissionKeys(i).join("/")}`).join(", ") ||
    `${navItems.filter((i) => navPermissionKeys(i).length > 0).length} gated of ${navItems.length}`,
);

console.log("\n— Scope anchors —\n");

ok("Every scope anchor names a column", Object.values(SCOPE_ANCHORS).every((c) => typeof c === "string" && c.length > 0));
ok(
  "Anchors end in UserId or are userId",
  Object.values(SCOPE_ANCHORS).every((c) => c === "userId" || /UserId$/.test(c)),
  Object.entries(SCOPE_ANCHORS).filter(([, c]) => c !== "userId" && !/UserId$/.test(c)).map(([k]) => k).join(", ") || "all conform",
);

console.log("\n— The guards that are code, not configuration —\n");

throws("Nobody changes their own role", () => assertNotSelf("u1", "u1", "role"), "the two-click lockout");
ok("  but may change somebody else's", (() => { assertNotSelf("u1", "u2", "role"); return true; })());

throws(
  "An ordinary admin may not act on a super admin",
  () => assertMayActOnTarget({ id: "a", isSuperAdmin: false }, { id: "b", isSuperAdmin: true }),
  "otherwise the tier is decorative",
);
ok(
  "  a super admin may",
  (() => { assertMayActOnTarget({ id: "a", isSuperAdmin: true }, { id: "b", isSuperAdmin: true }); return true; })(),
);
ok(
  "  and anyone may act on an ordinary user",
  (() => { assertMayActOnTarget({ id: "a", isSuperAdmin: false }, { id: "b", isSuperAdmin: false }); return true; })(),
);

ok(
  "A key with no selfExcluded flag allows self-action",
  (() => { assertNotOwnRecord("products.edit", "u1", "u1"); return true; })(),
);

console.log("\n— No ungated endpoint —\n");

/**
 * Every export from a `"use server"` module is a client-callable endpoint. This is the check that
 * stops the gap reopening: at the time it was written, ~536 actions existed and only ~35 files
 * checked a permission, and two of the unguarded ones could move money.
 *
 * A function counts as guarded if it calls `requireUser`, a permission check, or a local access
 * helper. That is a lower bar than "correctly authorized" — it catches the total absence of a
 * check, not a wrong one — but total absence is the failure that actually happened.
 */
/**
 * The calls that constitute a check at the bottom of the chain.
 *
 * Deliberately short. Everything else is *discovered*: most files guard through a local helper —
 * `requireAssets()`, `requirePayrollAccess()`, `access()` — and hardcoding those names produced a
 * list of 81 "holes" that were almost entirely false. A check nobody believes is worse than none,
 * because the real entries get waved through with the noise.
 */
const BASE_MARKERS = ["requireUser(", "hasEffectivePermission(", "actorContext(", "currentUser(", "auth()"];

/**
 * Local helpers in the same file that themselves reach a base marker.
 *
 * One level of indirection covers every pattern in this codebase; going deeper would mean writing a
 * call graph, and at that point the check costs more to maintain than the bug costs to find.
 */
function guardingHelpers(source: string): string[] {
  const helpers: string[] = [];
  const declarations = source.split(/\n(?:export )?async function /).slice(1);
  for (const decl of declarations) {
    const name = decl.slice(0, decl.indexOf("(")).trim();
    if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
    if (BASE_MARKERS.some((m) => decl.includes(m))) helpers.push(name);
  }
  return helpers;
}

/**
 * Exports that are deliberately reachable without a session, each for a stated reason. Anything not
 * on this list must be guarded. Adding to it is the moment to think.
 */
const PUBLIC_ACTIONS = new Set([
  // The customer-facing token flows: the person on the other end has no account, by design.
  "src/actions/feedback-public.ts",
  "src/actions/marketing-public.ts",
  "src/actions/intake.ts",
  // Sign-in itself.
  "src/actions/auth.ts",
  // The app's name, logo and colour, read by the sign-in page before anybody has a session.
  // Nothing here is confidential — it is what the login screen is painted with.
  "src/actions/branding.ts",
  /**
   * The reception tablet.
   *
   * A receptionist will not sign in for every visitor, and a shared account left permanently signed
   * in on a device in a lobby is worse than no account — it is a real identity with real
   * permissions sitting unattended on a table. So the kiosk token in the URL is the whole of the
   * authentication, exactly as it is for the customer-facing flows above.
   *
   * What that buys is bounded, and `check:visitors` holds the boundary: the directory it returns is
   * names and departments with no contact details, a deactivated tablet stops answering, sign-ins
   * are rate limited per desk so the URL cannot be used to flood somebody's notifications, and the
   * arrival time is taken by the server rather than accepted from the form.
   */
  "src/actions/visitor-public.ts",
  /**
   * The customer portal.
   *
   * The largest public surface in the app, and the one with the most to lose: it returns a
   * customer's own subscriptions, invoices and tickets to somebody holding a link. Whitelisted here
   * for the same reason as the flows above — the person on the other end has no account and never
   * will — and the boundary is held by `check:portal` rather than by this file.
   *
   * What that suite holds, because a whitelist entry is a promise: every query is scoped by the
   * company the token resolves to, the one client-supplied id in the module is re-checked against
   * that company, a switched-off portal refuses a valid link, a reseller's customer is refused
   * whatever the per-company override says, and a hidden section returns nothing rather than being
   * merely undrawn.
   */
  "src/actions/portal-public.ts",
]);

const actionsDir = join(process.cwd(), "src", "actions");
const files = readdirSync(actionsDir).filter((f) => f.endsWith(".ts"));
const ungated: string[] = [];
let examined = 0;

/**
 * Exports this scan could not classify, which must never be silently skipped.
 *
 * The scan splits on `\nexport async function ` and inspects each piece. Every action in the app is
 * written that way today, so it works — but it works by coincidence, and the failure mode if that
 * ever stops being true is the worst kind: `export const deleteEverything = async () => {...}` in a
 * `"use server"` file is a live, callable, completely ungated endpoint that this scan would not see
 * at all. The suite would print "every one resolves a session or checks a permission" and be wrong.
 *
 * A check that cannot see something must say so rather than pass. So every export in a server file
 * is counted independently, and an export this scan did not examine is itself a failure — it forces
 * whoever introduces a new export style to teach the scan about it.
 */
const unscannable: string[] = [];

for (const file of files) {
  const rel = `src/actions/${file}`;
  if (PUBLIC_ACTIONS.has(rel)) continue;
  const source = readFileSync(join(actionsDir, file), "utf8");
  if (!source.includes('"use server"')) continue;

  const helpers = guardingHelpers(source);
  const markers = [...BASE_MARKERS, ...helpers.map((h) => `${h}(`)];

  /**
   * Every exported runtime value in the file, by any syntax — the denominator.
   *
   * Types are excluded: `export type` and `export interface` vanish at compile time and are not
   * endpoints. Everything else that leaves a `"use server"` module is callable from a browser.
   */
  const allExports = [...source.matchAll(/^export\s+(?:async\s+)?(?:function\s*\*?\s+|const\s+|let\s+|var\s+|class\s+)([A-Za-z_$][\w$]*)/gm)]
    .map((m) => m[1]!)
    .filter((name) => !/^(type|interface)$/.test(name));
  const reExports = [...source.matchAll(/^export\s*\{([^}]*)\}/gm)].flatMap((m) =>
    m[1]!.split(",").map((part) => part.split(/\s+as\s+/).pop()!.trim()).filter(Boolean),
  );

  // Split on export boundaries and inspect each function body.
  const parts = source.split(/\nexport async function /).slice(1);
  const seen = new Set<string>();
  for (const part of parts) {
    const name = part.slice(0, part.indexOf("(")).trim();
    // The body runs to the next export, which is where the split already put the boundary.
    examined += 1;
    seen.add(name);
    if (!markers.some((m) => part.includes(m))) {
      ungated.push(`${rel}:${name}`);
    }
  }

  for (const name of [...allExports, ...reExports]) {
    if (!seen.has(name)) unscannable.push(`${rel}:${name}`);
  }
}

console.log(`  examined ${examined} exported actions across ${files.length} files`);
ok(
  "Every export in a server module was actually examined",
  unscannable.length === 0,
  unscannable.length === 0
    ? "nothing slipped past the scan"
    : `${unscannable.length} not seen by the scan: ${unscannable.slice(0, 8).join(", ")}${unscannable.length > 8 ? " …" : ""} — teach the scan this export syntax before trusting the line below`,
);
ok(
  "No exported action is completely ungated",
  ungated.length === 0,
  ungated.length === 0 ? "every one resolves a session or checks a permission" : `${ungated.length}: ${ungated.slice(0, 12).join(", ")}${ungated.length > 12 ? " …" : ""}`,
);

async function compareResolvers() {
  console.log("\n— The two resolvers agree —\n");

  /**
   * `resolveEveryone` states the precedence a second time.
   *
   * That is a deliberate and dangerous thing to do — two implementations of an authorization rule is
   * the exact shape of defect this file exists to catch — and it is only acceptable because of this
   * check. The bulk path exists because resolving a hundred people one at a time did not finish; it
   * is used for reporting screens only, never as a gate, so a disagreement shows up as a wrong number
   * rather than as somebody getting in. This asserts there is no disagreement at all.
   *
   * Compared for **every user in the database and every key in the registry**, not a sample.
   */
  {
    const everyone = await resolveEveryone();
    const users = await db.user.findMany({ select: { id: true, name: true } });

    ok("Every user resolves in the bulk pass", everyone.size === users.length, `${everyone.size} of ${users.length}`);

    const mismatches: string[] = [];
    for (const user of users) {
      const bulk = everyone.get(user.id);
      const single = await resolveUserPermissions(user.id);
      for (const def of PERMISSIONS) {
        const a = holdsFrom(bulk?.sources.get(def.key));
        const b = holdsFrom(single.sources.get(def.key));
        if (a !== b) mismatches.push(`${user.name}/${def.key}: bulk ${a}, single ${b}`);
        const viaA = bulk?.sources.get(def.key)?.via;
        const viaB = single.sources.get(def.key)?.via;
        // The *reason* has to match too: every "why" string on the access screens comes from it, and
        // a right answer for the wrong stated reason is how an access review reaches a wrong
        // conclusion.
        if (viaA !== viaB) mismatches.push(`${user.name}/${def.key}: via ${viaA} vs ${viaB}`);
      }
    }

    ok(
      "  and holds exactly what the single-user resolver holds, with the same reason",
      mismatches.length === 0,
      mismatches.length === 0
        ? `${users.length} users × ${PERMISSIONS.length} keys`
        : `${mismatches.length}: ${mismatches.slice(0, 6).join("; ")}${mismatches.length > 6 ? " …" : ""}`,
    );
  }

  await db.$disconnect();


}

compareResolvers()
  .catch((err) => {
    console.error(" FAIL  The bulk resolver comparison threw", err);
    failures += 1;
  })
  .then(() => {
    console.log(failures === 0 ? "\nAll RBAC checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
    process.exit(failures === 0 ? 0 : 1);
  });
