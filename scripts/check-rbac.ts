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
import { PERMISSIONS, PERMISSION_KEYS, permissionGroup, PERMISSION_GROUP_ORDER, getPermissionDefinition, heldByDefaultKey } from "../src/lib/permissions";
import { SYSTEM_ROLE_KEYS } from "../src/lib/roles";
import { roleKeys } from "../src/lib/authz/role-registry";
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

// This used to compare the assignable list against the Prisma enum, because the two were written
// out by hand in two places and had drifted — PURCHASE was missing from one while three accounts
// held it, so those users had no column in the permission screen and an empty sidebar.
//
// There is no enum any more: roles are rows. What the code still names by hand is
// `SYSTEM_ROLE_KEYS`, and the drift to guard against is between that list and the database, which
// is checked in `rolesAreData()` below because it needs a query.
eq("The application names thirteen roles of its own — the eight it shipped with, HR, Recruiter, Renewal specialist, Sales manager and HR head", SYSTEM_ROLE_KEYS.length, 13);

/**
 * The three added on 8 Oct 2026 start with their preset applied, written by the migration as role rows
 * (so a workspace's own custom "HR" is never reached by a code default). Two lists of the same thing
 * drift, so the migration's starting rows are read back and compared with the presets they copy, and
 * its starting menu with the sections it leaves ticked.
 */
{
  const sql = readFileSync(join(__dirname, "..", "prisma", "migrations", "20261030110000_built_in_hr_recruiter_renewal_roles", "migration.sql"), "utf8");
  const rows = [...sql.matchAll(/\('([A-Z_]+)', '([a-zA-Z.]+)', (true|false)\)/g)].map((m) => ({ role: m[1]!, key: m[2]!, allowed: m[3] === "true" }));
  for (const [role, preset] of [["HR", "hr-executive"], ["RECRUITER", "recruiter"], ["RENEWAL_SPECIALIST", "renewal-specialist"]] as const) {
    const granted = rows.filter((r) => r.role === role && r.allowed).map((r) => r.key).sort();
    const wanted = [...(getPreset(preset)?.permissions ?? [])].map(String).sort();
    ok(`${role} starts as the ${preset} preset`, granted.join() === wanted.join(), `migration ${granted.length}, preset ${wanted.length}`);
    const unticked = rows.filter((r) => r.role === role && !r.allowed).map((r) => r.key);
    ok(`  and only unticks sections`, unticked.length > 0 && unticked.every((k) => k.startsWith("section.")), unticked.filter((k) => !k.startsWith("section.")).join(", "));
    ok(`  keeping everybody's own HR self-service`, !unticked.includes("section.hr"));
  }
  ok("hiring got the answer people records had, wherever that was set by hand", /SELECT "role", 'hiring.manage', "allowed"/.test(sql) && /SELECT "userId", 'hiring.manage', "allowed"/.test(sql));

  // Sales manager (9 Oct 2026): the preset, and Sales's own menu copied rather than a fixed one.
  const managerSql = readFileSync(join(__dirname, "..", "prisma", "migrations", "20261030120000_built_in_sales_manager_role", "migration.sql"), "utf8");
  const managerRows = [...managerSql.matchAll(/\('([A-Z_]+)', '([a-zA-Z.]+)', (true|false)\)/g)].map((m) => ({ role: m[1]!, key: m[2]!, allowed: m[3] === "true" }));
  const managerGranted = managerRows.filter((r) => r.role === "SALES_MANAGER" && r.allowed).map((r) => r.key).sort();
  const managerWanted = [...(getPreset("sales-manager")?.permissions ?? [])].map(String).sort();
  ok("SALES_MANAGER starts as the sales-manager preset", managerGranted.join() === managerWanted.join() && managerRows.every((r) => r.allowed), `migration ${managerGranted.length}, preset ${managerWanted.length}`);
  ok("  with the menu Sales has in the workspace", /rp\."role" = 'SALES' AND rp\."permission" LIKE 'section\.%'/.test(managerSql));
  const executive = (getPreset("sales-executive")?.permissions ?? []) as readonly string[];
  ok("  and everything a sales executive has, so moving up never takes anything away", executive.every((k) => managerWanted.includes(k)), executive.filter((k) => !managerWanted.includes(k)).join(", "));

  // HR head (9 Oct 2026): the preset, and HR's starting menu with the vault the preset uses.
  const headSql = readFileSync(join(__dirname, "..", "prisma", "migrations", "20261030130000_built_in_hr_head_role", "migration.sql"), "utf8");
  const headRows = [...headSql.matchAll(/\('([A-Z_]+)', '([a-zA-Z.]+)', (true|false)\)/g)].map((m) => ({ role: m[1]!, key: m[2]!, allowed: m[3] === "true" }));
  const headGranted = headRows.filter((r) => r.role === "HR_HEAD" && r.allowed).map((r) => r.key).sort();
  const headWanted = [...(getPreset("hr-head")?.permissions ?? [])].map(String).sort();
  ok("HR_HEAD starts as the hr-head preset", headRows.every((r) => r.role === "HR_HEAD") && headGranted.join() === headWanted.join(), `migration ${headGranted.length}, preset ${headWanted.length}`);
  const headUnticked = headRows.filter((r) => !r.allowed).map((r) => r.key).sort();
  const hrUnticked = rows.filter((r) => r.role === "HR" && !r.allowed).map((r) => r.key).filter((k) => k !== "section.vault").sort();
  ok("  with HR's starting menu, the credential vault kept", headUnticked.join() === hrUnticked.join() && !headUnticked.includes("section.vault"), `${headUnticked.length} unticked`);
  for (const below of ["hr-executive", "hr-manager"]) {
    const lower = (getPreset(below)?.permissions ?? []) as readonly string[];
    ok(`  and everything the ${below} preset has, so moving up never takes anything away`, lower.every((k) => headWanted.includes(k)), lower.filter((k) => !headWanted.includes(k)).join(", "));
  }
  ok("  and still no customer views — HR sees no customers", !headWanted.some((k) => /^(contacts|leads|orders|payments|documents|projects|calls|visits|tickets|emails)\.view$/.test(k)));
}

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
  ROLE_PRESETS.every((p) => (SYSTEM_ROLE_KEYS as readonly string[]).includes(p.role)),
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
  // Sections are held by every role until unticked, and no preset touches them (src/lib/permissions.ts).
  (p) => permissionGroup(p) !== "Administration" && p.superAdminOnly !== true && p.everyone !== true && !presetCovered.has(p.key),
).map((p) => p.key);
ok("Every non-admin permission appears in at least one preset", uncovered.length === 0, uncovered.join(", ") || "all covered");

// Adding a staff account takes "Create and edit users" and "Review who can do what" together
// (src/app/(dashboard)/settings/access/new/page.tsx): a preset with the first alone hands out a key with
// no screen — which HR manager did until 9 Oct 2026.
const usersWithoutScreen = ROLE_PRESETS.filter((p) => (p.permissions as readonly string[]).includes("users.manage") && !(p.permissions as readonly string[]).includes("permissions.view")).map((p) => p.key);
ok("Every preset that manages users can open Staff & roles to do it", usersWithoutScreen.length === 0, usersWithoutScreen.join(", ") || `${ROLE_PRESETS.filter((p) => (p.permissions as readonly string[]).includes("users.manage")).length} presets`);

// Who holds what, as the owner set it on 9 Oct 2026 — in the presets and in the defaults a role with
// nothing configured falls back to, so the two can't disagree.
{
  const has = (preset: string, key: string) => ((getPreset(preset)?.permissions ?? []) as readonly string[]).includes(key);
  ok("A sales executive sees their own targets and pipeline, not everybody's", !has("sales-executive", "targets.viewAll") && !heldByDefaultKey("targets.viewAll", "SALES") && has("sales-manager", "targets.viewAll"));
  const money = ["payments.view", "documents.view"];
  ok(
    "The profiler and the calling agent see no payments, quotes or invoices — in their presets or by default",
    ["data-profiler", "calling-agent"].every((p) => money.every((k) => !has(p, k))) && ["PROFILE", "CALLING"].every((r) => money.every((k) => !heldByDefaultKey(k, r))),
  );
  ok("  while a salesperson, support and accounts still do", ["SALES", "SUPPORT", "ACCOUNTS"].every((r) => money.every((k) => heldByDefaultKey(k, r))));
  ok(
    "Managing IT assets (licence keys included) is the support lead's, not every support agent's",
    !has("support-agent", "assets.manage") && has("support-agent", "assets.viewAll") && has("support-lead", "assets.manage") && !heldByDefaultKey("assets.manage", "SUPPORT"),
  );
}

const rolesWithPresets = new Set(ROLE_PRESETS.map((p) => p.role));
const rolesWithout = (SYSTEM_ROLE_KEYS as readonly string[]).filter((r) => r !== "ADMIN" && !rolesWithPresets.has(r as never));
ok("Every assignable role has a preset to start from", rolesWithout.length === 0, rolesWithout.join(", ") || "all covered");

// HR has two (executive and manager); Sales and Sales manager one each since the manager got a role.
const hrPresets = presetsForRole("HR");
ok("presetsForRole finds them", hrPresets.length >= 2 && presetsForRole("SALES").length === 1 && presetsForRole("SALES_MANAGER").length === 1 && presetsForRole("HR_HEAD").length === 1, `${hrPresets.length} for HR`);
ok("getPreset resolves a known key", getPreset("accounts-manager")?.role === "ACCOUNTS");
ok("  and returns undefined for an unknown one", getPreset("not-a-preset") === undefined);

const exec = getPreset("sales-executive")!;
const noneHeld = Object.fromEntries(PERMISSIONS.map((p) => [p.key, false]));
const diffFromNothing = presetDiff(exec, noneHeld);
eq("A preset applied to nothing grants its whole list", diffFromNothing.willGrant.length, exec.permissions.length);
eq("  and revokes nothing", diffFromNothing.willRevoke.length, 0);
const allHeld = Object.fromEntries(PERMISSIONS.map((p) => [p.key, true]));
eq(
  "Applied over everything it revokes the rest — but never a section, which presets leave alone",
  presetDiff(exec, allHeld).willRevoke.length,
  PERMISSIONS.filter((p) => !p.everyone).length - exec.permissions.length,
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
// requireStaff: the platform console's actions are gated by a staff session, not a workspace's.
// requireModuleUser: requireUser, plus the workspace's plan (src/lib/modules-access.ts).
// requireCms / cmsAction: the website CMS's actions are gated by a CMS session and its roles (src/lib/cms/guard.ts).
// requirePartner: the partner portal's, by a partner session and its roles (src/lib/partners/guard.ts).
const BASE_MARKERS = ["requireUser(", "hasEffectivePermission(", "actorContext(", "currentUser(", "auth()", "requireStaff(", "requireModuleUser(", "requireCms(", "cmsAction(", "requirePartner("];

/**
 * Local helpers in the same file that themselves reach a base marker.
 *
 * One level of indirection covers every pattern in this codebase; going deeper would mean writing a
 * call graph, and at that point the check costs more to maintain than the bug costs to find.
 */
function guardingHelpers(source: string): string[] {
  const helpers: string[] = [];
  const declarations = source
    .split(/\n(?:export )?async function /)
    .slice(1)
    // A generic helper — `asStaff<T>(…)` — is named without its type parameters.
    .map((decl) => ({ name: decl.slice(0, decl.indexOf("(")).replace(/<.*$/, "").trim(), decl }))
    .filter((d) => d.name && /^[A-Za-z_$][\w$]*$/.test(d.name));
  // Transitively: a helper that calls a guarding helper guards too — `workable()` calling `who()`
  // calling `requireUser()`. Repeated until nothing new is found.
  for (let grew = true; grew; ) {
    grew = false;
    for (const { name, decl } of declarations) {
      if (helpers.includes(name)) continue;
      const markers = [...BASE_MARKERS, ...helpers.map((h) => `${h}(`)];
      if (markers.some((m) => decl.includes(m))) {
        helpers.push(name);
        grew = true;
      }
    }
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
  // "Forgot your password?" — asked by somebody who cannot sign in, by definition. It answers the
  // same whether or not the address has an account, and a reset needs the emailed one-time link.
  "src/actions/password-reset.ts",
  // Signing up for a workspace, on the platform's own address, where there are no accounts yet. By
  // invitation, limited per address, and it touches only the control plane.
  "src/actions/platform/signup.ts",
  // Signing in to the platform console: its own sign-in, enrolling two-factor, choosing a password from
  // a one-time link, signing out — each touching only the caller's own console session.
  "src/actions/platform/staff-auth.ts",
  // Signing in to the website CMS, the same four (cmsSignIn, cmsFinishEnrolment, cmsSetPassword,
  // cmsSignOut) — each touching only the caller's own CMS session or one-time link. The file's other
  // exports go through `cmsAction` like every CMS action; check:cms holds the lockouts and the links.
  "src/actions/cms/auth.ts",
  // Signing in to the partner portal, the same four (partnerSignIn, partnerFinishEnrolment,
  // partnerSetPassword, partnerSignOut): each touches only the caller's own partner session or one-time
  // link. The file's other exports go through its local asPartner → requirePartner.
  "src/actions/partners/auth.ts",
  // The public website's two forms, "find my workspaces" and "contact us", for people with no account
  // anywhere: a honeypot, limits per address and per caller, the same answer whatever was found, and
  // nothing of a workspace's returned. check:site and check:cms hold them.
  "src/actions/platform/site.ts",
  // The public website's "become a partner" form (applyToPartnerProgramme), the same kind: a honeypot,
  // limits per address, per caller and in all, the control plane only, nothing returned but a field
  // error. check:partners holds it.
  "src/actions/platform/partner-site.ts",
  // The access page: a person held at the door shares their location or signs out. `requireUser`
  // refuses exactly these people by design, so the session is read directly — and each action does
  // one narrow thing to the caller's own session. See src/actions/access-gate.ts.
  "src/actions/access-gate.ts",
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
   * PIN lookups for the address forms.
   *
   * Reachable without a session because the new-joiner intake form is — a candidate fills in their
   * home address from a link, signed in to nothing. What it returns is India Post's published
   * directory: post office names, districts and states for a PIN, which the Department of Posts
   * gives to anybody. Nothing from this business's own data is read. The work is bounded instead —
   * inputs are length-checked before any query and every answer is capped (`check:address`).
   */
  "src/actions/geo.ts",
  /**
   * A digital card's public page (/c/<name>).
   *
   * Whoever was handed the card has no account and never will. What it takes is bounded, and
   * `check:cards` holds it: a share-back reaches only a live card that asks for one, is checked field
   * by field, answers a bot with the thanks a person gets, is limited per card and per workspace by
   * count rather than by address, and writes the person's own details and nothing else; a tap is a
   * count against a card of a known kind.
   */
  "src/actions/card-public.ts",
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

/**
 * Single exports reachable without a session in a file whose other exports are guarded, each for a
 * stated reason. The rest of the file is still scanned — listing the whole file in PUBLIC_ACTIONS
 * would stop the scan checking its guarded exports.
 */
const PUBLIC_EXPORTS: Record<string, string> = {
  // Linked sign-in's /switch page (spec §4.3): the person switching in has no session here yet. Each
  // needs the `deskzo.switch` cookie, a MAC-bound secret held only by the browser that presented the
  // ticket, and acts only on that ticket. check:linked-signin holds them.
  "src/actions/linked-sign-in.ts:submitSwitchCode": "the two-factor step of a switch-in",
  "src/actions/linked-sign-in.ts:continueSwitchWithSso": "the single sign-on step of a switch-in (Microsoft, Google or Zoho)",
};

const actionsDir = join(process.cwd(), "src", "actions");
// Every action file, in subfolders too (src/actions/platform/…): one the scan cannot see is one it
// would wrongly pass.
const files = (readdirSync(actionsDir, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts")).map((f) => f.split("\\").join("/"));
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
    if (!markers.some((m) => part.includes(m)) && !PUBLIC_EXPORTS[`${rel}:${name}`]) {
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

/**
 * Exactly one super admin, and no way to make another from inside the app.
 *
 * The super admin is the account `resolve.ts` short-circuits for: it holds everything
 * unconditionally and no permission row is consulted for it. One account outside the permission
 * system is a decision; a button that makes more of them is a policy nobody chose, and every extra
 * holder is a person whose access cannot be reviewed on the access screen.
 *
 * Enforced from both sides in the database rather than by convention:
 *   · `users_one_super_admin` (partial unique index) refuses a second — the ceiling.
 *   · `users_require_remaining_super_admin` (trigger) refuses to remove the last — the floor.
 *
 * Asserted here because both are invisible from the TypeScript: nothing fails to compile if the
 * index is dropped, and the first anybody would know is a second holder appearing.
 */
async function superAdminIsSingular() {
  console.log("\n— Exactly one super admin —\n");

  const holders = await db.user.findMany({ where: { isSuperAdmin: true }, select: { email: true, role: true, active: true } });
  ok(
    "exactly one account holds super admin",
    holders.length === 1,
    holders.map((h) => `${h.email} (${h.role}${h.active ? "" : ", inactive"})`).join(", ") || "none",
  );
  ok(
    "  and it is an active ADMIN",
    holders.length === 1 && holders[0]!.role === "ADMIN" && holders[0]!.active,
    "a super admin who is not an ADMIN is invisible to every role === ADMIN comparison in the app",
  );

  /**
   * Both attempts below are matched on what the database says, never on a sentinel of our own.
   *
   * Prisma's error message quotes the surrounding source lines of the call that failed. The first
   * version of this check threw `new Error("NO_OTHER_USER")` a line above the update, looked for
   * that string in the resulting message, found Prisma's echo of its own source, and concluded the
   * database had *allowed* a second super admin. A test that reads its own source back as evidence
   * is worse than no test: it fails when the rule holds.
   */
  const violated = (err: unknown, fragment: RegExp) => fragment.test((err as Error).message);

  // ── The ceiling ────────────────────────────────────────────────────────────────────────────
  const victim = await db.user.findFirst({ where: { isSuperAdmin: false }, select: { id: true } });
  let secondRefused = false;
  let ceilingDetail = "no ordinary account to promote, so the ceiling could not be exercised";
  if (victim) {
    try {
      await db.$transaction(async (tx) => {
        await tx.user.update({ where: { id: victim.id }, data: { isSuperAdmin: true, role: "ADMIN" } });
        // Reached only if the index is gone. Rolls the attempt back either way.
        throw new Error("rollback");
      });
      ceilingDetail = "the update was accepted — users_one_super_admin is missing";
    } catch (err) {
      secondRefused = violated(err, /Unique constraint failed/i);
      if (!secondRefused) ceilingDetail = "the update was accepted — users_one_super_admin is missing";
    }
  }
  ok("the database refuses a second super admin", secondRefused, secondRefused ? "users_one_super_admin" : ceilingDetail);

  // ── The floor ──────────────────────────────────────────────────────────────────────────────
  const only = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  let lastRefused = false;
  try {
    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: only!.id }, data: { isSuperAdmin: false } });
      throw new Error("rollback");
    });
  } catch (err) {
    // The trigger's own words — "is the only active super admin" — rather than the absence of a
    // sentinel, for the same reason as above.
    lastRefused = violated(err, /only active super admin/i);
  }
  ok(
    "the database refuses to remove the last one",
    lastRefused,
    lastRefused
      ? "floor and ceiling at one: no window where a script could leave none, or three"
      : "users_require_remaining_super_admin did not fire",
  );

  // ── And no way in from the application ─────────────────────────────────────────────────────
  /**
   * Writes, not reads.
   *
   * `select: { isSuperAdmin: true }` is how every one of these files *reads* the flag, and matching
   * the bare pair flagged all of them — the check failed while the code was correct, which teaches
   * people to ignore it. Only a `data:` block setting it true is a grant.
   */
  const grantingFiles = readdirSync("src/actions")
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => /data:\s*\{[^}]*isSuperAdmin:\s*true/.test(readFileSync(join("src/actions", f), "utf8")));
  ok(
    "no server action grants super admin",
    grantingFiles.length === 0,
    grantingFiles.length === 0
      ? "the access drawer's Make super admin button is gone; the app must not offer what the database refuses"
      : grantingFiles.join(", "),
  );

  const registry = readFileSync("src/lib/permissions.ts", "utf8");
  ok(
    "  and no permission key grants it either",
    !/manageSuperAdmin|grantSuperAdmin/.test(registry),
    "a grantable key is a key that can be escalated to",
  );

  /**
   * The thing a super admin *can* still do, which is the point of the whole arrangement.
   *
   * Making somebody an admin is `users.assignRole`, and it is `superAdminOnly` — only a super
   * admin may hand it out. An admin sits inside the permission system, so what they can do is
   * reviewable, narrowable and revocable. That is the difference being preserved.
   */
  const assignRole = PERMISSIONS.find((x) => x.key === "users.assignRole");
  ok(
    "a super admin can still make somebody an admin",
    assignRole?.superAdminOnly === true && assignRole?.delegable === false,
    "users.assignRole is superAdminOnly and non-delegable — grantable by a super admin, and by nobody else",
  );
}

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

/**
 * Roles are rows, and the rows the code names must actually be there.
 *
 * The enum used to guarantee this: a role the application mentioned existed by definition, because
 * mentioning it and declaring it were the same act. Now they are two, and the gap between them is
 * a foreign key violation on the next person assigned that role, or a preset that silently applies
 * to nothing.
 */
async function rolesAreData() {
  console.log(`
— Roles are data —
`);

  const rows = await db.role.findMany({ select: { key: true, isSystem: true } });
  const byKey = new Map(rows.map((r) => [r.key, r]));

  const missing = SYSTEM_ROLE_KEYS.filter((k) => !byKey.has(k));
  ok(
    "every role the code names exists as a row",
    missing.length === 0,
    missing.length === 0 ? SYSTEM_ROLE_KEYS.join(", ") : `missing: ${missing.join(", ")}`,
  );
  ok(
    "  and each is marked as a system role, so it cannot be deleted",
    SYSTEM_ROLE_KEYS.every((k) => byKey.get(k)?.isSystem === true),
    "ADMIN is named by the permission resolver and the super-admin constraint; the rest by the built-in presets",
  );

  const presetRoles = [...new Set(ROLE_PRESETS.map((p) => p.role))];
  const orphanPresets = presetRoles.filter((r) => !byKey.has(r));
  ok(
    "every preset names a role that exists",
    orphanPresets.length === 0,
    orphanPresets.length === 0 ? `${presetRoles.length} roles have presets` : orphanPresets.join(", "),
  );

  const held = await db.user.groupBy({ by: ["role"], _count: { _all: true } });
  const unknownHeld = held.filter((h) => !byKey.has(h.role));
  ok(
    "nobody holds a role that does not exist",
    unknownHeld.length === 0,
    unknownHeld.length === 0
      ? held.map((h) => `${h.role} ${h._count._all}`).join(", ")
      : unknownHeld.map((h) => h.role).join(", "),
  );
}
compareResolvers()
  .then(superAdminIsSingular)
  .then(rolesAreData)
  .catch((err) => {
    console.error(" FAIL  The bulk resolver comparison threw", err);
    failures += 1;
  })
  .then(() => {
    console.log(failures === 0 ? "\nAll RBAC checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
    process.exit(failures === 0 ? 0 : 1);
  });
