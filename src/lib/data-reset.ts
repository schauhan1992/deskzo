import { readFileSync } from "node:fs";
import path from "node:path";
import { Prisma, type PrismaClient } from "@prisma/client";
import { REFERENCE_TABLES } from "@/lib/reference-data";

/**
 * TEMPORARY — resetting the whole database to a fresh install, for the testing phase. Remove this
 * file, `src/actions/data-reset.ts`, `src/components/backups/data-reset-panel.tsx`, the panel on
 * the Backups page and `scripts/check-data-reset.ts` before production; nothing else depends on it.
 *
 * Switched off unless `ENABLE_DATA_RESET=true` is in the environment, and then only for the super
 * admin — so a build that reaches production with this still in it cannot use it by accident.
 *
 * ## What survives
 *
 *   · the super admin — their account, password and two-factor, so whoever pressed the button can
 *     still sign in;
 *   · the PIN directory and its data.gov.in key (`REFERENCE_TABLES`) — never wiped, by the standing
 *     rule in src/lib/reference-data.ts;
 *   · the backup log and schedule — they describe copies on disk, and the backup taken just before
 *     the reset has to stay listed to be restorable;
 *   · the built-in roles, which every user row needs.
 *
 * Everything else is emptied — other users, every record, and the settings too — and then the rows
 * a fresh install gets from its migrations are put back (the starter customer categories). Numbering
 * restarts: the next company is COM-000001 again.
 *
 * ## How it stays in order
 *
 * The list of tables and the links between them are read from Postgres itself, so a table added
 * next week is wiped without anybody remembering to add it here. Most tables go in one TRUNCATE;
 * the few the kept rows point at (a department, say) can't be truncated while a foreign key names
 * them, so the kept rows let go of them first and they are deleted instead. All of it is one
 * transaction: a failure part-way leaves the database exactly as it was.
 */

/** Typed to confirm. */
export const RESET_PHRASE = "RESET ALL DATA";

export function dataResetEnabled(): boolean {
  return process.env.ENABLE_DATA_RESET === "true";
}

const tableOf = (model: string) => Prisma.dmmf.datamodel.models.find((m) => m.name === model)?.dbName ?? model;

/** The tables left alone, and why — shown on the reset panel. */
export function keptTables(): { table: string; what: string }[] {
  return [
    { table: tableOf("User"), what: "you — every other user is removed" },
    { table: tableOf("Role"), what: "the built-in roles — ones added since are removed" },
    { table: tableOf("Backup"), what: "the backup log, so a backup taken before the reset can be restored" },
    { table: tableOf("BackupSchedule"), what: "when backups are taken" },
    ...REFERENCE_TABLES.map((t) => ({ table: t.table, what: t.what })),
  ];
}

/**
 * Rows a fresh install gets from its migrations rather than from anybody using it. Wiped with
 * everything else, then put back exactly as the migration wrote them. `check:data-reset` fails if a
 * migration inserts fixed rows into a table that is neither kept nor listed here.
 */
export const INSTALL_ROWS = [
  {
    table: "customer_categories",
    migration: "20260924180000_customer_categories",
    // The statement's own ending — its values contain semicolons, so it can't be split on one.
    from: 'INSERT INTO "customer_categories"',
    to: 'ON CONFLICT ("id") DO NOTHING;',
  },
] as const;

function installStatement(row: (typeof INSTALL_ROWS)[number]): string {
  const sql = readFileSync(path.join(process.cwd(), "prisma", "migrations", row.migration, "migration.sql"), "utf8");
  const start = sql.indexOf(row.from);
  const end = sql.indexOf(row.to, start);
  if (start < 0 || end < 0) throw new Error(`Couldn't find the rows ${row.migration} inserts into ${row.table}`);
  return sql.slice(start, end + row.to.length);
}

type Edge = { child: string; parent: string; column: string; notnull: boolean };

async function schemaFacts(client: PrismaClient | Prisma.TransactionClient) {
  const [tables, edges] = await Promise.all([
    client.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = current_schema()`,
    client.$queryRaw<Edge[]>`
      SELECT ch.relname AS child, pa.relname AS parent, a.attname AS "column", a.attnotnull AS notnull
      FROM pg_constraint c
      JOIN pg_class ch ON ch.oid = c.conrelid
      JOIN pg_class pa ON pa.oid = c.confrelid
      JOIN pg_namespace n ON n.oid = c.connamespace
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND n.nspname = current_schema()`,
  ]);
  return { tables: tables.map((t) => t.tablename), edges };
}

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

export type ResetPlan = {
  /** Emptied in one TRUNCATE. */
  truncate: string[];
  /** Emptied by DELETE, children first, because a kept row's foreign key names them. */
  deleteInOrder: string[];
  kept: string[];
};

/** Which tables go how. Throws when a kept row can't let go of something that is going — nothing has been touched then. */
export function planReset(tables: string[], edges: Edge[]): ResetPlan {
  const kept = new Set([...keptTables().map((k) => k.table), "_prisma_migrations"]);
  const wiped = tables.filter((t) => !kept.has(t));

  for (const e of edges) {
    if (kept.has(e.child) && !kept.has(e.parent) && e.notnull) {
      throw new Error(`${e.child}.${e.column} must point at a row in ${e.parent}, which the reset empties — keep ${e.parent} or make the column optional`);
    }
  }

  // Anything a kept table points at can't be truncated, and neither can anything those point at.
  const blocked = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of edges) {
      if ((kept.has(e.child) || blocked.has(e.child)) && !kept.has(e.parent) && !blocked.has(e.parent)) {
        blocked.add(e.parent);
        grew = true;
      }
    }
  }

  // Children before parents; a table pointing at itself is fine within one DELETE.
  const deleteInOrder: string[] = [];
  const pending = new Set(blocked);
  while (pending.size) {
    const ready = [...pending].filter((t) => !edges.some((e) => e.parent === t && e.child !== t && pending.has(e.child)));
    if (!ready.length) throw new Error(`These tables point at each other and can't be emptied in order: ${[...pending].join(", ")}`);
    for (const t of ready.sort()) {
      deleteInOrder.push(t);
      pending.delete(t);
    }
  }
  return { truncate: wiped.filter((t) => !blocked.has(t)).sort(), deleteInOrder, kept: [...kept].sort() };
}

export type ResetOutcome = { tablesEmptied: number; usersRemoved: number };

/**
 * Empties the database down to the super admin. One transaction; the caller decides who may, and
 * takes the backup first.
 */
export async function resetAllData(client: PrismaClient, superAdminId: string): Promise<ResetOutcome> {
  return client.$transaction(
    async (tx) => {
      const admin = await tx.user.findUnique({ where: { id: superAdminId }, select: { id: true, isSuperAdmin: true, role: true } });
      if (!admin?.isSuperAdmin) throw new Error("Only the super admin's account is kept, and that isn't it.");
      // Waiting behind a long query is fine; waiting forever behind a stuck one is not.
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '30s'`);

      const { tables, edges } = await schemaFacts(tx);
      const plan = planReset(tables, edges);
      const kept = new Set(plan.kept);
      const users = tableOf("User");

      // 1. The kept rows let go of what is going: a department, a manager, whoever triggered a backup.
      for (const e of edges) {
        if (!kept.has(e.child)) continue;
        const [child, column] = [quote(e.child), quote(e.column)];
        if (e.parent === users) {
          await tx.$executeRawUnsafe(`UPDATE ${child} SET ${column} = NULL WHERE ${column} IS NOT NULL AND ${column} <> $1`, superAdminId);
        } else if (!kept.has(e.parent)) {
          await tx.$executeRawUnsafe(`UPDATE ${child} SET ${column} = NULL WHERE ${column} IS NOT NULL`);
        }
      }

      // 2. Everything else, at once.
      if (plan.truncate.length) await tx.$executeRawUnsafe(`TRUNCATE TABLE ${plan.truncate.map(quote).join(", ")} RESTART IDENTITY`);
      for (const t of plan.deleteInOrder) await tx.$executeRawUnsafe(`DELETE FROM ${quote(t)}`);

      // 3. The people, then the roles only they had.
      const usersRemoved = await tx.user.deleteMany({ where: { id: { not: superAdminId } } });
      await tx.role.deleteMany({ where: { isSystem: false, key: { not: admin.role } } });

      // 4. What a fresh install starts with.
      for (const row of INSTALL_ROWS) await tx.$executeRawUnsafe(installStatement(row));

      return { tablesEmptied: plan.truncate.length + plan.deleteInOrder.length, usersRemoved: usersRemoved.count };
    },
    { timeout: 300_000, maxWait: 20_000 },
  );
}

/** How much is there — for the panel, so "reset" has a size before it is pressed. */
export async function resetOverview(client: PrismaClient) {
  const [users, companies, contacts, leads, orders, documents, payments, tickets] = await Promise.all([
    client.user.count(),
    client.company.count(),
    client.contact.count(),
    client.lead.count(),
    client.companyProduct.count(),
    client.tradeDocument.count(),
    client.payment.count(),
    client.ticket.count(),
  ]);
  const { tables, edges } = await schemaFacts(client);
  const plan = planReset(tables, edges);
  return { counts: { users, companies, contacts, leads, orders, documents, payments, tickets }, tables: plan.truncate.length + plan.deleteInOrder.length };
}
