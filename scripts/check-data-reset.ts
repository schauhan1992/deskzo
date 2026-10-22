/**
 * The reset engine (src/lib/data-reset.ts) and the workspace reset built on it (src/lib/workspace-reset.ts).
 *
 *   · Without a database: the plan — which tables are truncated, which are deleted and in what
 *     order, and what it refuses (a kept row that can't let go, tables that point at each other).
 *   · Against the migrations: every migration that writes fixed rows writes them into a table the
 *     reset keeps or puts back, so a fresh install and a reset one stay the same.
 *   · For real, in a scratch database built from the migrations beside the real one and dropped
 *     afterwards — the reset is never run against the database in DATABASE_URL: everything but the
 *     super admin, the PIN directory, the backup log and the built-in roles emptied; the starter
 *     categories back as the migration wrote them; numbering restarted; a second reset harmless;
 *     anybody but the super admin refused.
 *   · The workspace reset, on the real database but only the paths that refuse: not the super admin,
 *     not the workspace's address, not their password, not once an e-invoice exists — and the panel on
 *     the Backups page. The whole reset, scheduled and run, is exercised on a scratch workspace instead.
 *
 *   npm run check:data-reset
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Module from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { directClient } from "../src/lib/tenancy/direct-client";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "ADMIN", name: "Zzreset", email: "x@zzprobe-reset.invalid" });
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => "/settings/backups",
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const MAIL = "@zzprobe-reset.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const reset = require("../src/lib/data-reset") as typeof import("../src/lib/data-reset");

  // ─────────────────────────────────────────────────────────────────────────────
  section("The plan");

  const edge = (child: string, parent: string, column = "x", notnull = false) => ({ child, parent, column, notnull });
  const plan = reset.planReset(
    ["users", "roles", "backups", "_prisma_migrations", "departments", "companies", "contacts", "sites", "_OrderWatchers"],
    [edge("users", "departments", "departmentId"), edge("departments", "sites", "siteId"), edge("contacts", "companies"), edge("companies", "users"), edge("_OrderWatchers", "users"), edge("users", "roles", "role", true)],
  );
  ok("what a kept row points at is deleted, not truncated — and what that points at too", plan.deleteInOrder.join() === "departments,sites", plan.deleteInOrder.join());
  ok("  children before parents", plan.deleteInOrder.indexOf("departments") < plan.deleteInOrder.indexOf("sites"));
  ok("everything else is truncated at once, quoted names and all", plan.truncate.join() === "_OrderWatchers,companies,contacts", plan.truncate.join());
  ok("the kept tables and the migration log are left alone", ["users", "roles", "backups", "_prisma_migrations"].every((t) => plan.kept.includes(t)) && !plan.truncate.includes("users"));
  const refusal = (() => {
    try {
      reset.planReset(["users", "departments"], [edge("users", "departments", "departmentId", true)]);
      return "";
    } catch (err) {
      return (err as Error).message;
    }
  })();
  ok("a kept row that must point at something going is refused before anything is touched", refusal.includes("users.departmentId"), refusal);
  const cycle = (() => {
    try {
      reset.planReset(["users", "a", "b"], [edge("users", "a"), edge("a", "b"), edge("b", "a")]);
      return "";
    } catch (err) {
      return (err as Error).message;
    }
  })();
  ok("  and so are tables that point at each other with nothing to delete first", cycle.includes("point at each other"), cycle);
  ok(
    "the reference tables are not a workspace's to keep or wipe — they are the shared reference database's",
    (await import("../src/lib/reference-data")).REFERENCE_TABLES.every((t) => !reset.keptTables().some((k) => k.table === t.table)),
  );

  // ─────────────────────────────────────────────────────────────────────────────
  section("What a fresh install gets from its migrations");

  const migrationsDir = path.join(process.cwd(), "prisma", "migrations");
  const kept = new Set([...reset.keptTables().map((k) => k.table), ...reset.INSTALL_ROWS.map((r) => r.table)]);
  const fixed: string[] = [];
  for (const folder of readdirSync(migrationsDir)) {
    if (folder === "migration_lock.toml") continue;
    const sql = readFileSync(path.join(migrationsDir, folder, "migration.sql"), "utf8");
    // A temporary table lives only while its migration runs (20261110120000_retire_report_inheritance
    // keeps the registry's facts in one), so there is nothing of it for a reset to keep or wipe.
    const temporary = new Set([...sql.matchAll(/CREATE TEMP(?:ORARY)? TABLE "([a-z_]+)"/gi)].map((m) => m[1]!));
    // Fixed rows — `VALUES` — not a backfill copying rows from another table, which a reset empties anyway.
    for (const m of sql.matchAll(/INSERT INTO "([a-z_]+)"[^;]*?\)\s*VALUES/gi)) if (!temporary.has(m[1]!)) fixed.push(`${m[1]} (${folder})`);
  }
  const unhandled = fixed.filter((f) => !kept.has(f.split(" ")[0]!));
  ok("every table a migration writes fixed rows into is kept or put back", unhandled.length === 0 && fixed.length >= 2, unhandled.join(", ") || fixed.join(", "));

  // ─────────────────────────────────────────────────────────────────────────────
  section("A reset, for real, in a scratch database");

  const url = process.env.DATABASE_URL!;
  const host = new URL(url).hostname;
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${new URL(url).pathname.slice(1)}_reset_check`;
  const scratchUrl = withDatabase(url, scratchName);
  ok("  and the scratch one is never the real one", scratchUrl !== url && scratchName !== new URL(url).pathname.slice(1));
  const admin = directClient(withDatabase(url, "postgres"));
  const scratch = directClient(scratchUrl);
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60 * 1000 });

    const systemRoles = await scratch.role.count({ where: { isSystem: true } });
    const starter = await scratch.customerCategory.findMany({ orderBy: { id: "asc" }, select: { id: true, name: true, guidance: true } });
    const dept = await scratch.department.create({ data: { name: "ZZ Sales" } });
    await scratch.role.create({ data: { key: "ZZ_CUSTOM", name: "Custom" } });
    const boss = await scratch.user.create({ data: { name: "Boss", email: `boss${MAIL}`, role: "ADMIN", passwordHash: "b".repeat(60), departmentId: dept.id } });
    const sa = await scratch.user.create({
      data: { name: "Super", email: `super${MAIL}`, role: "ADMIN", passwordHash: "s".repeat(60), isSuperAdmin: true, departmentId: dept.id, managerId: boss.id },
    });
    const rep = await scratch.user.create({ data: { name: "Rep", email: `rep${MAIL}`, role: "ZZ_CUSTOM", passwordHash: "r".repeat(60), managerId: sa.id } });
    await scratch.rolePermission.create({ data: { role: "ZZ_CUSTOM", permission: "leads.view" } });
    await scratch.userPermission.create({ data: { userId: rep.id, permission: "leads.view", allowed: true } });
    const industry = await scratch.industry.create({ data: { name: "ZZ Industry" } });
    const company = await scratch.company.create({ data: { name: "ZZ Acme", normalizedName: "zz acme", createdById: rep.id, ownerUserId: rep.id, industryId: industry.id } });
    await scratch.contact.create({ data: { companyId: company.id, name: "Ravi" } });
    await scratch.lead.create({ data: { companyId: company.id, title: "ZZ lead" } });
    await scratch.customerCategory.update({ where: { id: "cc_strategic" }, data: { name: "Renamed by somebody" } });
    await scratch.customerCategory.create({ data: { name: "Added by somebody", icon: "star", color: "#000000" } });
    await scratch.notification.create({ data: { userId: sa.id, type: "NOTE_REMINDER", title: "ZZ" } });
    await scratch.auditLog.create({ data: { userId: rep.id, action: "CREATE", entityType: "Company", entityId: company.id, entityLabel: "ZZ Acme" } });
    await scratch.organisationSettings.create({ data: {} });
    const byRep = await scratch.backup.create({ data: { filename: "zz-rep.dump", directory: "zz", triggeredById: rep.id } });
    const bySa = await scratch.backup.create({ data: { filename: "zz-sa.dump", directory: "zz", triggeredById: sa.id } });
    await scratch.backupSchedule.create({ data: {} });
    const migrationsBefore = await scratch.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "_prisma_migrations"`;

    const refusedOther = await reset.resetAllData(scratch, rep.id).then(() => "") .catch((err: Error) => err.message);
    ok("the account kept has to be the super admin's", refusedOther.includes("super admin"), refusedOther);
    ok("  and refusing it changed nothing", (await scratch.user.count()) === 3 && (await scratch.company.count()) === 1);

    const outcome = await reset.resetAllData(scratch, sa.id);
    ok("it resets", outcome.usersRemoved === 2 && outcome.tablesEmptied > 150, JSON.stringify(outcome));

    const people = await scratch.user.findMany();
    ok("the super admin is the only user left", people.length === 1 && people[0]!.id === sa.id);
    ok("  with their sign-in intact, and let go of the department and manager that went", people[0]!.passwordHash === sa.passwordHash && people[0]!.departmentId === null && people[0]!.managerId === null && people[0]!.role === "ADMIN");
    ok("the built-in roles stay; one added since goes", (await scratch.role.count({ where: { isSystem: true } })) === systemRoles && (await scratch.role.count({ where: { key: "ZZ_CUSTOM" } })) === 0);
    const leftover = await scratch.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('post_offices', 'geo_cities', 'reference_syncs')`;
    ok("a workspace's database has no reference tables for a reset to reach", Number(leftover[0]!.n) === 0);
    const backups = await scratch.backup.findMany({ orderBy: { filename: "asc" } });
    ok("the backup log stays, so the backup taken first can be restored", backups.length === 2 && (await scratch.backupSchedule.count()) === 1);
    ok("  forgetting only who took a backup when that person is gone", backups.find((b) => b.id === byRep.id)?.triggeredById === null && backups.find((b) => b.id === bySa.id)?.triggeredById === sa.id);
    const migrationsAfter = await scratch.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "_prisma_migrations"`;
    ok("the migration log is untouched", migrationsAfter[0]!.n === migrationsBefore[0]!.n);
    const categories = await scratch.customerCategory.findMany({ orderBy: { id: "asc" }, select: { id: true, name: true, guidance: true } });
    ok("the starter categories are back exactly as the migration wrote them", JSON.stringify(categories) === JSON.stringify(starter) && categories.length > 20, categories.length);

    const stages = await scratch.leadStage.findMany({ orderBy: { sortOrder: "asc" }, select: { id: true } });
    ok(
      "  and so are the pipeline stages every workspace starts with",
      stages.map((s) => s.id).join() === "lstg_new,lstg_contacted,lstg_qualifying,lstg_qualified,lstg_proposal_sent,lstg_negotiation,lstg_won,lstg_lost,lstg_disqualified",
      stages.length,
    );

    // Kept, and the rows a fresh install gets from its migrations, which are put back.
    const keptNames = new Set([...reset.keptTables().map((k) => k.table), "_prisma_migrations", ...reset.INSTALL_ROWS.map((r) => r.table)]);
    const tables = await scratch.$queryRaw<{ tablename: string }[]>`SELECT tablename::text AS tablename FROM pg_tables WHERE schemaname = current_schema()`;
    const notEmpty: string[] = [];
    for (const { tablename } of tables) {
      if (keptNames.has(tablename)) continue;
      const [{ n }] = await scratch.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${tablename.replace(/"/g, '""')}"`);
      if (n > BigInt(0)) notEmpty.push(`${tablename}:${n}`);
    }
    ok("every other table is empty — settings included", notEmpty.length === 0, notEmpty.join(", ") || `${tables.length - keptNames.size} tables`);
    const fresh = await scratch.company.create({ data: { name: "First", normalizedName: "first", createdById: sa.id } });
    ok("numbering starts again — the next company is COM-000001", fresh.companySeq === 1, fresh.companySeq);
    await scratch.company.delete({ where: { id: fresh.id } });
    const again = await reset.resetAllData(scratch, sa.id).then(() => "").catch((err: Error) => err.message);
    ok("resetting an empty database again is harmless", again === "" && (await scratch.user.count()) === 1, again);
  } finally {
    await scratch.$disconnect();
    try {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    } finally {
      await admin.$disconnect();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  section("The workspace reset, on the real database — only the paths that refuse");

  const db = directClient();
  const lib = require("../src/lib/workspace-reset") as typeof import("../src/lib/workspace-reset");
  const actions = require("../src/actions/workspace-reset") as typeof import("../src/actions/workspace-reset");
  const BackupsPage = (require("../src/app/(dashboard)/settings/backups/page") as { default: () => Promise<ReactElement> }).default;
  /**
   * Nothing below can reset this database: every request is refused before it is scheduled — a password
   * nobody has, a confirmation that isn't the address — and a scheduled one would still wait a day.
   */
  const realSuperAdmin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  const other = await db.user.create({ data: { name: "Zzreset Other", email: `other${MAIL}`, role: "ADMIN", passwordHash: "o".repeat(60) } });
  const companiesBefore = await db.company.count();
  const resetsBefore = await db.workspaceReset.count();
  let irnDoc: string | null = null;
  try {
    ok("there is a super admin to borrow", !!realSuperAdmin);
    actorId = other.id;
    const notSuper = await actions.scheduleWorkspaceReset({ confirm: "deskzo", password: "x" });
    ok("only the super admin can ask for it", !notSuper.ok && notSuper.error === "Only the workspace's super admin can reset it.", notSuper.ok ? "IT RAN" : notSuper.error);
    actorId = realSuperAdmin!.id;
    const wrongName = await actions.scheduleWorkspaceReset({ confirm: "not-this-workspace", password: "x" });
    ok("the workspace's address has to be typed", !wrongName.ok && wrongName.error.startsWith("Type the workspace's address"), wrongName.ok ? "IT RAN" : wrongName.error);
    const state = await lib.workspaceResetState(realSuperAdmin!.id);
    const wrongPassword = await actions.scheduleWorkspaceReset({ confirm: state?.slug ?? "", password: "not the password, certainly" });
    // A database with e-invoices or e-way bills (the demo data has them) refuses before the password.
    const blockedHere = await lib.resetBlockers();
    if (blockedHere.length) ok("with tax records here, it is refused before the password is asked", !wrongPassword.ok && wrongPassword.error === blockedHere[0]!.message, wrongPassword.ok ? "IT RAN" : wrongPassword.error);
    else ok("and the super admin's own password", !wrongPassword.ok && wrongPassword.error === "That password isn't right.", wrongPassword.ok ? "IT RAN" : wrongPassword.error);
    ok("the super admin sees how much there is before asking", !!state?.overview && state.overview.counts.companies === companiesBefore && state.overview.tables > 150 && state.isSuperAdmin, state?.overview ? JSON.stringify(state.overview.counts) : "");
    ok("somebody else sees the panel only when they look after backups", (await lib.workspaceResetState(other.id))?.isSuperAdmin === false);

    // A tax document filed with the GST system: the reset is refused.
    const company = await db.company.findFirst({ select: { id: true } });
    if (company) {
      const doc = await db.tradeDocument.create({ data: { docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: company.id, docNumber: `ZZRESET-IRN-${Date.now()}`, taxableValue: 1, total: 1, createdById: realSuperAdmin!.id, issueDate: new Date(), irn: `zzreset-${Date.now()}` } as never, select: { id: true } });
      irnDoc = doc.id;
      const blockers = await lib.resetBlockers();
      ok("once an e-invoice has been generated, it is refused", blockers.some((b) => b.key === "einvoices"), blockers.map((b) => b.message).join(" "));
    }

    const html = renderToStaticMarkup(await BackupsPage());
    const refusedHere = (await lib.resetBlockers()).filter((b) => b.key !== "einvoices" || !irnDoc);
    ok(
      "the Backups page shows the reset to the super admin — the form, or why it can't be",
      html.includes("Reset the workspace") && html.includes("kept 30 days") && (html.includes("Schedule the reset") || html.includes("must be kept")),
      html.includes("Reset the workspace") ? (refusedHere.length ? "refused here" : "") : "no panel",
    );
    ok("  and no trace of the testing button", !html.includes("for testing only") && !html.includes("ENABLE_DATA_RESET"));
    ok("nothing on the real database was reset or scheduled by any of that", (await db.company.count()) === companiesBefore && (await db.workspaceReset.count()) === resetsBefore);
  } finally {
    if (irnDoc) await db.tradeDocument.delete({ where: { id: irnDoc } });
    await db.auditLog.deleteMany({ where: { userId: other.id } });
    await db.user.delete({ where: { id: other.id } });
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll data-reset checks passed." : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
