/**
 * Who can see what, for every person in the workspace, written to a file — and two such files
 * compared.
 *
 * Phase 0 of the permission redesign (docs/permission-redesign.md). The redesign moves the rules
 * about *which records* somebody sees from a dozen helpers onto one engine, and every phase promises
 * that nothing changes for anybody until an admin changes it. This is how that promise is checked
 * rather than hoped: take a snapshot before a phase, take one after, compare. An empty comparison is
 * the proof; anything else is a list of exactly who gained or lost what.
 *
 * ## What it records, per person
 *
 *   · every permission they hold, as the resolver answers today;
 *   · for each record type — customers, vendors, contacts, leads, orders, documents, payments — the
 *     set of rows they can list, as a count and a fingerprint of the ids (so the same count with
 *     different rows is still caught);
 *   · which account managers' companies they can open one at a time (`canSeeCompany`), over every
 *     manager in the workspace and "nobody";
 *   · for each "see everyone's" permission elsewhere (visits, expenses, activity…), whose records
 *     they reach — the reporting-line answer those modules use.
 *
 * And per role, what the role itself grants — its stored answers over the registry's defaults — so a
 * role nobody holds today is still covered. (This replaces the first version of this script, which
 * printed the same per-person and per-role permissions to the screen for diffing by hand.)
 *
 * People are recorded by id and role only. The comparison looks names up from the database when it
 * prints, so the files themselves hold no names or addresses.
 *
 * ## Why the rules are asked of the app, not re-derived here
 *
 * Each question is answered by calling the helpers the app itself calls (`companyScope`,
 * `contactScope`, `canSeeCompany`…). When a later phase rewrites those helpers on the new engine, the
 * same script calling the same names compares the old answers with the new ones. Re-deriving the
 * rules here would only ever compare this file with itself.
 *
 *   npm run access:snapshot                       — snapshot the workspace (label "snapshot")
 *   npm run access:snapshot -- --label before     — with a label of your own
 *   npm run access:snapshot -- --compare          — the two latest snapshots of this database
 *   npm run access:snapshot -- --compare a.json b.json
 *
 * Read-only. Snapshots go to access-snapshots/ (not committed).
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";

/**
 * Each person's questions are asked as that person, signed in. Some helpers only answer for the
 * session's own user (`hasEffectivePermission` refuses anybody else's id), so the session is stubbed
 * to be whoever is being recorded — exactly the answer that person gets in the app. Nothing here
 * writes, so nothing is done in anybody's name.
 */
let signedIn: { id: string; role: string } | null = null;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => {
      if (!signedIn) throw new Error("access-snapshot: a question was asked with nobody signed in");
      return { ...signedIn, name: "", email: "" };
    };
    return { requireUser: user, currentUser: user, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const OUT_DIR = path.join(__dirname, "..", "access-snapshots");
const VERSION = 1;

type SetFingerprint = { count: number; hash: string };
type PersonSnapshot = {
  id: string;
  role: string;
  active: boolean;
  kind: string;
  superAdmin: boolean;
  keys: string[];
  sets: Record<string, SetFingerprint>;
  /** Account managers whose customers `canSeeCompany` lets this person open; "" stands for nobody. */
  opens: string[];
  /**
   * The same for vendors, which have a level of their own since the redesign. Absent from snapshots
   * taken before it, when the two could not differ — `opens` answered for both.
   */
  opensVendors?: string[];
  /** For each "see everyone's" key: "all", or a fingerprint of the people whose records are reached. */
  reach: Record<string, string>;
};
type RoleSnapshot = { role: string; keys: string[] };
type Snapshot = {
  version: number;
  label: string;
  takenAt: string;
  database: string;
  commit: string | null;
  totals: Record<string, number>;
  roles: RoleSnapshot[];
  people: PersonSnapshot[];
};

const fingerprint = (ids: string[]): SetFingerprint => {
  const sorted = [...ids].sort();
  return { count: sorted.length, hash: createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 16) };
};

function arg(name: string): string | null {
  const at = process.argv.indexOf(name);
  return at >= 0 ? (process.argv[at + 1] ?? null) : null;
}

async function take(): Promise<string> {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { permissionsFor } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
  const { companyScope, canSeeCompany } = require("../src/lib/authz/company-scope") as typeof import("../src/lib/authz/company-scope");
  const access = require("../src/lib/authz/access") as typeof import("../src/lib/authz/access");
  const { scopeUserIds } = require("../src/lib/authz/scope") as typeof import("../src/lib/authz/scope");
  const { vendorRelationshipTypeValues } = require("../src/lib/validation/company") as typeof import("../src/lib/validation/company");
  const { PERMISSIONS, heldByDefault } = require("../src/lib/permissions") as typeof import("../src/lib/permissions");
  const { roleKeys } = require("../src/lib/authz/role-registry") as typeof import("../src/lib/authz/role-registry");
  /* eslint-enable @typescript-eslint/no-require-imports */

  // Everyone, including the accounts the app's own user lists leave out — a support account on a
  // grant is somebody who can see things, and the Automation account must keep seeing nothing.
  const direct = directClient();
  const [{ name: database }] = await direct.$queryRaw<{ name: string }[]>`SELECT current_database()::text AS name`;
  const people = await direct.user.findMany({
    select: { id: true, role: true, active: true, kind: true, isSuperAdmin: true },
    orderBy: { createdAt: "asc" },
  });
  const owners = (await direct.company.findMany({ distinct: ["ownerUserId"], select: { ownerUserId: true } })).map((c) => c.ownerUserId);

  const vendorTypes = [...vendorRelationshipTypeValues];
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
  // The "see everyone's" keys whose reach follows the reporting line, outside the six record types.
  const reachKeys = ["visits.viewAll", "expenses.viewAll", "activities.viewAll", "targets.viewAll", "hr.viewAll", "assets.viewAll", "vault.viewAll", "feedback.viewAll", "marketing.viewAll", "projects.viewAll"];

  const totals = {
    companies: await direct.company.count(),
    contacts: await direct.contact.count(),
    leads: await direct.lead.count(),
    orders: await direct.companyProduct.count(),
    documents: await direct.tradeDocument.count(),
    payments: await direct.payment.count(),
  };

  /**
   * What each role grants on its own: a stored answer where there is one, otherwise the registry's
   * default — and for Admin, everything not taken away. The resolver's rule 4 and the admin default,
   * without anything a person adds or inherits.
   */
  const stored = await direct.rolePermission.findMany({ select: { role: true, permission: true, allowed: true } });
  const storedByRole = new Map<string, Map<string, boolean>>();
  for (const row of stored) {
    const map = storedByRole.get(row.role) ?? new Map<string, boolean>();
    map.set(row.permission, row.allowed);
    storedByRole.set(row.role, map);
  }
  const roles: RoleSnapshot[] = [];
  for (const role of (await roleKeys()).map(String).sort()) {
    const answers = storedByRole.get(role) ?? new Map<string, boolean>();
    const keys = PERMISSIONS.filter((def) => answers.get(def.key) ?? (role === "ADMIN" || heldByDefault(def, role)))
      .map((def) => def.key)
      .sort();
    roles.push({ role, keys });
  }

  const out: PersonSnapshot[] = [];
  let n = 0;
  for (const person of people) {
    n += 1;
    process.stdout.write(`\r  ${n}/${people.length} people`);
    signedIn = { id: person.id, role: person.role };
    const keys = (await permissionsFor(person.id)).map(String).sort();

    /**
     * Each list as the access engine answers it (src/lib/authz/access.ts) — the fragments the lists
     * themselves use. The first snapshot, taken before the engine, asked the old way: the view
     * permission as the gate and the account scope as the narrowing; comparing against it is what
     * proves the engine kept every answer. Customers and vendors are one table split by relationship
     * type, recorded apart because the redesign gives them separate rows.
     */
    const companyWhere = await companyScope(person.id);
    const sets: Record<string, SetFingerprint> = {
      "customers.view": fingerprint(ids(await db.company.findMany({ where: { AND: [companyWhere, { relationshipType: { notIn: vendorTypes } }] }, select: { id: true } }))),
      "vendors.view": fingerprint(ids(await db.company.findMany({ where: { AND: [companyWhere, { relationshipType: { in: vendorTypes } }] }, select: { id: true } }))),
      "contacts.view": fingerprint(ids(await db.contact.findMany({ where: await access.contactAccess(person.id, "view"), select: { id: true } }))),
      "leads.view": fingerprint(ids(await db.lead.findMany({ where: await access.leadAccess(person.id, "view"), select: { id: true } }))),
      "orders.view": fingerprint(ids(await db.companyProduct.findMany({ where: await access.orderAccess(person.id, "view"), select: { id: true } }))),
      "documents.view": fingerprint(ids(await db.tradeDocument.findMany({ where: await access.documentAccess(person.id, "view"), select: { id: true } }))),
      "payments.view": fingerprint(ids(await db.payment.findMany({ where: await access.paymentAccess(person.id, "view"), select: { id: true } }))),
    };

    // A customer and a vendor of each manager: the two rows a single-company check now tells apart.
    const opens: string[] = [];
    const opensVendors: string[] = [];
    for (const owner of owners) {
      if (await canSeeCompany(person.id, { ownerUserId: owner, relationshipType: "CLIENT" })) opens.push(owner ?? "");
      if (await canSeeCompany(person.id, { ownerUserId: owner, relationshipType: "VENDOR" })) opensVendors.push(owner ?? "");
    }
    opens.sort();
    opensVendors.sort();

    const reach: Record<string, string> = {};
    for (const key of reachKeys) {
      const reached = await scopeUserIds(person.id, key as Parameters<typeof scopeUserIds>[1]);
      reach[key] = reached === null ? "all" : fingerprint(reached).hash;
    }

    out.push({ id: person.id, role: person.role, active: person.active, kind: person.kind, superAdmin: person.isSuperAdmin, keys, sets, opens, opensVendors, reach });
  }
  process.stdout.write("\n");

  let commit: string | null = null;
  try {
    commit = execSync("git rev-parse --short HEAD", { cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    commit = null;
  }
  const label = (arg("--label") ?? "snapshot").replace(/[^a-z0-9-]+/gi, "-").slice(0, 40) || "snapshot";
  const takenAt = new Date().toISOString();
  const snapshot: Snapshot = { version: VERSION, label, takenAt, database, commit, totals, roles, people: out };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${database}-${takenAt.replace(/[:.]/g, "-")}-${label}.json`);
  writeFileSync(file, JSON.stringify(snapshot, null, 1));
  await direct.$disconnect();
  await (db as unknown as { $disconnect?: () => Promise<void> }).$disconnect?.();
  return file;
}

/** The two latest snapshots of the database this workspace points at. */
async function latestTwo(): Promise<[string, string]> {
  const direct = directClient();
  const [{ name: database }] = await direct.$queryRaw<{ name: string }[]>`SELECT current_database()::text AS name`;
  await direct.$disconnect();
  const files = existsSync(OUT_DIR)
    ? readdirSync(OUT_DIR)
        .filter((f) => f.startsWith(`${database}-`) && f.endsWith(".json"))
        .map((f) => path.join(OUT_DIR, f))
        .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
    : [];
  if (files.length < 2) throw new Error(`Fewer than two snapshots of ${database} in access-snapshots/ — take one before and one after.`);
  return [files[files.length - 2]!, files[files.length - 1]!];
}

async function compare(beforeFile: string, afterFile: string): Promise<number> {
  const before = JSON.parse(readFileSync(beforeFile, "utf8")) as Snapshot;
  const after = JSON.parse(readFileSync(afterFile, "utf8")) as Snapshot;
  console.log(`Before: ${path.basename(beforeFile)}  (${before.commit ?? "no commit"})`);
  console.log(`After:  ${path.basename(afterFile)}  (${after.commit ?? "no commit"})`);
  if (before.database !== after.database) console.log(`  Note: different databases — ${before.database} and ${after.database}.`);

  // Rows added or removed between the two shift everybody's counts; said first, so a difference that
  // is only new data is read as that.
  const totalsMoved = Object.keys({ ...before.totals, ...after.totals }).filter((k) => before.totals[k] !== after.totals[k]);
  if (totalsMoved.length > 0) {
    console.log(`\n  The data itself changed between the two — differences below may be new rows, not new rules:`);
    for (const k of totalsMoved) console.log(`    ${k}: ${before.totals[k] ?? 0} → ${after.totals[k] ?? 0}`);
  }

  const direct = directClient();
  const names = new Map((await direct.user.findMany({ select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  await direct.$disconnect();
  const who = (p: PersonSnapshot) => `${names.get(p.id) ?? p.id} (${p.role}${p.superAdmin ? ", super admin" : ""}${p.active ? "" : ", inactive"})`;

  const lines: string[] = [];
  let differences = 0;

  // Roles first: a role nobody holds today is a role somebody will hold tomorrow.
  const rolesBefore = new Map(before.roles.map((r) => [r.role, r.keys]));
  const rolesAfter = new Map(after.roles.map((r) => [r.role, r.keys]));
  for (const role of new Set([...rolesBefore.keys(), ...rolesAfter.keys()])) {
    const b = rolesBefore.get(role);
    const a = rolesAfter.get(role);
    if (!a || !b) {
      lines.push(`  Role ${role}: ${a ? "new" : "removed"}`);
      differences += 1;
      continue;
    }
    const gained = a.filter((k) => !b.includes(k));
    const lost = b.filter((k) => !a.includes(k));
    if (gained.length || lost.length) {
      const parts = [gained.length ? `grants ${gained.join(", ")}` : "", lost.length ? `no longer grants ${lost.join(", ")}` : ""].filter(Boolean);
      lines.push(`  Role ${role}: ${parts.join("; ")}`);
      differences += 1;
    }
  }

  const beforeById = new Map(before.people.map((p) => [p.id, p]));
  const afterById = new Map(after.people.map((p) => [p.id, p]));

  for (const id of new Set([...beforeById.keys(), ...afterById.keys()])) {
    const b = beforeById.get(id);
    const a = afterById.get(id);
    if (!b || !a) {
      lines.push(`  ${who((a ?? b)!)}: ${a ? "new person" : "no longer in the workspace"}`);
      differences += 1;
      continue;
    }
    const mine: string[] = [];
    if (b.role !== a.role || b.active !== a.active || b.superAdmin !== a.superAdmin) mine.push(`account changed (${b.role} → ${a.role}, active ${b.active} → ${a.active})`);
    const gained = a.keys.filter((k) => !b.keys.includes(k));
    const lost = b.keys.filter((k) => !a.keys.includes(k));
    if (gained.length) mine.push(`gained ${gained.join(", ")}`);
    if (lost.length) mine.push(`lost ${lost.join(", ")}`);
    for (const q of new Set([...Object.keys(b.sets), ...Object.keys(a.sets)])) {
      const x = b.sets[q];
      const y = a.sets[q];
      if (!x || !y) {
        mine.push(`${q}: only in the ${x ? "before" : "after"} snapshot`);
      } else if (x.hash !== y.hash) {
        mine.push(x.count === y.count ? `${q}: same count (${y.count}), different rows` : `${q}: ${x.count} → ${y.count} rows`);
      }
    }
    const opened = a.opens.filter((o) => !b.opens.includes(o));
    const closed = b.opens.filter((o) => !a.opens.includes(o));
    const managerName = (o: string) => (o === "" ? "unowned companies" : (names.get(o) ?? o));
    if (opened.length) mine.push(`can now open the companies of ${opened.map(managerName).join(", ")}`);
    if (closed.length) mine.push(`can no longer open the companies of ${closed.map(managerName).join(", ")}`);
    // Before the split there was one answer for both; a vendor answer is compared with it.
    const vendorsBefore = b.opensVendors ?? b.opens;
    const vendorsAfter = a.opensVendors ?? a.opens;
    const vendorsOpened = vendorsAfter.filter((o) => !vendorsBefore.includes(o));
    const vendorsClosed = vendorsBefore.filter((o) => !vendorsAfter.includes(o));
    if (vendorsOpened.length) mine.push(`can now open the vendors of ${vendorsOpened.map(managerName).join(", ")}`);
    if (vendorsClosed.length) mine.push(`can no longer open the vendors of ${vendorsClosed.map(managerName).join(", ")}`);
    for (const key of new Set([...Object.keys(b.reach), ...Object.keys(a.reach)])) {
      if (b.reach[key] !== a.reach[key]) mine.push(`${key}: reach changed (${b.reach[key] === "all" ? "everyone" : "some"} → ${a.reach[key] === "all" ? "everyone" : "some"})`);
    }
    if (mine.length) {
      differences += mine.length;
      lines.push(`  ${who(a)}:`);
      for (const m of mine) lines.push(`    · ${m}`);
    }
  }

  if (differences === 0) {
    console.log(`\nIdentical: ${after.roles.length} roles, ${after.people.length} people, ${Object.keys(after.people[0]?.sets ?? {}).length} record types, every permission and every reach.`);
    return 0;
  }
  console.log(`\n${differences} difference(s):\n`);
  console.log(lines.join("\n"));
  return 1;
}

async function main() {
  if (process.argv.includes("--compare")) {
    const at = process.argv.indexOf("--compare");
    const a = process.argv[at + 1];
    const b = process.argv[at + 2];
    const [before, after] = a && b && !a.startsWith("--") ? [a, b] : await latestTwo();
    process.exit(await compare(before, after));
  }
  console.log("Taking an access snapshot…");
  const file = await take();
  console.log(`Written: ${path.relative(process.cwd(), file)}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
