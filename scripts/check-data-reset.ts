/**
 * TEMPORARY, with the reset it checks — see src/lib/data-reset.ts. Remove both before production.
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
 *   · Through the action and the page, on the real database but only the paths that refuse: switched
 *     off without ENABLE_DATA_RESET, refused to anybody but the super admin, refused without the
 *     phrase — and the panel shown only when all three hold.
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
import { PrismaClient } from "@prisma/client";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "ADMIN", name: "Zzreset", email: "x@zzprobe-reset.invalid" });
    return { requireUser: async () => user(), currentUser: async () => user() };
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
    ["users", "roles", "backups", "post_offices", "_prisma_migrations", "departments", "companies", "contacts", "sites", "_OrderWatchers"],
    [edge("users", "departments", "departmentId"), edge("departments", "sites", "siteId"), edge("contacts", "companies"), edge("companies", "users"), edge("_OrderWatchers", "users"), edge("users", "roles", "role", true)],
  );
  ok("what a kept row points at is deleted, not truncated — and what that points at too", plan.deleteInOrder.join() === "departments,sites", plan.deleteInOrder.join());
  ok("  children before parents", plan.deleteInOrder.indexOf("departments") < plan.deleteInOrder.indexOf("sites"));
  ok("everything else is truncated at once, quoted names and all", plan.truncate.join() === "_OrderWatchers,companies,contacts", plan.truncate.join());
  ok("the kept tables and the migration log are left alone", ["users", "roles", "backups", "post_offices", "_prisma_migrations"].every((t) => plan.kept.includes(t)) && !plan.truncate.includes("users"));
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
  ok("the reference tables are among the kept, from their own list", (await import("../src/lib/reference-data")).REFERENCE_TABLES.every((t) => reset.keptTables().some((k) => k.table === t.table)));

  // ─────────────────────────────────────────────────────────────────────────────
  section("What a fresh install gets from its migrations");

  const migrationsDir = path.join(process.cwd(), "prisma", "migrations");
  const kept = new Set([...reset.keptTables().map((k) => k.table), ...reset.INSTALL_ROWS.map((r) => r.table)]);
  const fixed: string[] = [];
  for (const folder of readdirSync(migrationsDir)) {
    if (folder === "migration_lock.toml") continue;
    const sql = readFileSync(path.join(migrationsDir, folder, "migration.sql"), "utf8");
    // Fixed rows — `VALUES` — not a backfill copying rows from another table, which a reset empties anyway.
    for (const m of sql.matchAll(/INSERT INTO "([a-z_]+)"[^;]*?\)\s*VALUES/gi)) fixed.push(`${m[1]} (${folder})`);
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
  const admin = new PrismaClient({ datasourceUrl: withDatabase(url, "postgres") });
  const scratch = new PrismaClient({ datasourceUrl: scratchUrl });
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
    await scratch.postOffice.create({ data: { pincode: "012345", officeName: "ZZ PO", district: "ZZ", districtKey: "zz", stateName: "ZZ" } });
    await scratch.referenceDataset.create({ data: { key: "zz", source: "zz", checksum: "zz", rowCount: 1 } });
    await scratch.referenceSync.create({ data: { key: "zz" } });
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
    ok("the PIN directory and its key stay", (await scratch.postOffice.count()) === 1 && (await scratch.referenceDataset.count()) === 1 && (await scratch.referenceSync.count()) === 1);
    const backups = await scratch.backup.findMany({ orderBy: { filename: "asc" } });
    ok("the backup log stays, so the backup taken first can be restored", backups.length === 2 && (await scratch.backupSchedule.count()) === 1);
    ok("  forgetting only who took a backup when that person is gone", backups.find((b) => b.id === byRep.id)?.triggeredById === null && backups.find((b) => b.id === bySa.id)?.triggeredById === sa.id);
    const migrationsAfter = await scratch.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "_prisma_migrations"`;
    ok("the migration log is untouched", migrationsAfter[0]!.n === migrationsBefore[0]!.n);
    const categories = await scratch.customerCategory.findMany({ orderBy: { id: "asc" }, select: { id: true, name: true, guidance: true } });
    ok("the starter categories are back exactly as the migration wrote them", JSON.stringify(categories) === JSON.stringify(starter) && categories.length > 20, categories.length);

    const keptNames = new Set([...reset.keptTables().map((k) => k.table), "_prisma_migrations", "customer_categories"]);
    const tables = await scratch.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = current_schema()`;
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
  section("The button, on the real database — only the paths that refuse");

  const db = new PrismaClient();
  const actions = require("../src/actions/data-reset") as typeof import("../src/actions/data-reset");
  const BackupsPage = (require("../src/app/(dashboard)/settings/backups/page") as { default: () => Promise<ReactElement> }).default;
  /**
   * Every call below sends a phrase that is NOT the confirmation, so even a gate that failed to
   * refuse could not reset this database — the call would stop at the phrase instead, with a
   * different message, and the check would fail rather than the data go.
   */
  const NOT_THE_PHRASE = "reset all data please";
  const refusedBecause = async () => {
    const r = await actions.resetAllDataNow({ confirm: NOT_THE_PHRASE, backupFirst: false });
    return r.ok ? "IT RAN" : r.error;
  };
  const realSuperAdmin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  const other = await db.user.create({ data: { name: "Zzreset Other", email: `other${MAIL}`, role: "ADMIN", passwordHash: "o".repeat(60) } });
  const companiesBefore = await db.company.count();
  const wasEnabled = process.env.ENABLE_DATA_RESET;
  try {
    ok("there is a super admin to borrow", !!realSuperAdmin);
    actorId = realSuperAdmin!.id;
    delete process.env.ENABLE_DATA_RESET;
    const off = await refusedBecause();
    ok("switched off without ENABLE_DATA_RESET — even for the super admin", (await actions.getDataResetOverview()) === null && off.includes("switched off") && off.includes("ENABLE_DATA_RESET"), off);
    ok("  and the Backups page doesn't show it", !renderToStaticMarkup(await BackupsPage()).includes("Reset all data"));

    process.env.ENABLE_DATA_RESET = "true";
    actorId = other.id;
    const notSuper = await refusedBecause();
    ok("switched on, it is still only the super admin's", (await actions.getDataResetOverview()) === null && notSuper === "Only the super admin can reset data.", notSuper);
    actorId = realSuperAdmin!.id;
    const overview = await actions.getDataResetOverview();
    ok("the super admin sees how much there is before pressing anything", !!overview && overview.counts.companies === companiesBefore && overview.tables > 150 && overview.phrase === "RESET ALL DATA", overview ? JSON.stringify(overview.counts) : "");
    const wrong = await refusedBecause();
    ok("the phrase has to be typed", wrong === "Type RESET ALL DATA to confirm.", wrong);
    const html = renderToStaticMarkup(await BackupsPage());
    ok("the Backups page shows the panel, with what stays", html.includes("Reset all data — for testing only") && html.includes("India Post") && html.includes("the backup log"));
    ok("  the backup-first box starts ticked and the button waits for the phrase", /type="checkbox"[^>]*checked=""/.test(html) && /<button[^>]*disabled=""[^>]*>Reset all data<\/button>/.test(html));
    ok("nothing on the real database was reset by any of that", (await db.company.count()) === companiesBefore);
  } finally {
    if (wasEnabled === undefined) delete process.env.ENABLE_DATA_RESET;
    else process.env.ENABLE_DATA_RESET = wasEnabled;
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
