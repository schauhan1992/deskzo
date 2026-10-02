"use server";

import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fieldOfChoice, getTableDefinition, isFieldChoice, normaliseSelection, TABLE_KEYS } from "@/lib/tables/registry";
import { definitionsFor } from "@/lib/custom-fields/server";
import type { ActionResult } from "@/actions/company";

/**
 * Reading and writing one person's column choices.
 *
 * Deliberately not scoped by any permission: which columns *you* look at is not an access-control
 * question, and gating it would be the kind of rule that makes a permission system feel arbitrary.
 * The rows a table returns are governed elsewhere — see src/lib/authz/company-scope.ts. Hiding a
 * column has never been a way to keep a secret, and treating it as one would be worse than useless
 * because somebody might believe it.
 */

/**
 * Every table preference this user has, in one query.
 *
 * One read for the whole session rather than one per table: the provider in the dashboard layout
 * holds these, so a page with three tables on it does not make three round trips, and a table deep
 * in a tab does not flash its default columns before correcting itself.
 */
export async function getTablePreferences(): Promise<Record<string, string[]>> {
  const user = await requireUser();
  const rows = await db.tablePreference.findMany({
    where: { userId: user.id, tableKey: { in: TABLE_KEYS } },
    select: { tableKey: true, columns: true },
  });
  return Object.fromEntries(rows.map((r) => [r.tableKey, r.columns]));
}

export async function setTableColumns(tableKey: string, columns: string[]): Promise<ActionResult<null>> {
  const user = await requireUser();

  const def = getTableDefinition(tableKey);
  if (!def) return { ok: false, error: "Unknown table." };

  // Filtered through the registry rather than stored as sent: a key that no longer exists would
  // otherwise sit in the row forever, and a hand-crafted request could fill the column with
  // anything at all.
  let clean = normaliseSelection(tableKey, columns);
  // The same for a choice about one of the workspace's own fields, which the registry can't know:
  // kept for a field the workspace has. A retired one counts — restoring it brings the choice back.
  if (def.customFields && clean.some(isFieldChoice)) {
    const known = new Set((await definitionsFor(def.customFields)).map((d) => d.key));
    clean = clean.filter((entry) => !isFieldChoice(entry) || known.has(fieldOfChoice(entry)));
  }

  await db.tablePreference.upsert({
    where: { user_table: { userId: user.id, tableKey } },
    update: { columns: clean },
    create: { userId: user.id, tableKey, columns: clean },
  });

  return { ok: true, data: null };
}

/** Deletes the row, which is what returns somebody to the defaults — see `resolveColumns`. */
export async function resetTableColumns(tableKey: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  await db.tablePreference.deleteMany({ where: { userId: user.id, tableKey } });
  return { ok: true, data: null };
}
