import { db } from "@/lib/db";
import type { Exporter, ExportScope } from "./types";

/**
 * Saved calling and prospecting lists.
 *
 * A workbook is a name, a filter set, and the people working it. The filter set is the whole of it —
 * everything else is labelling — so it travels as JSON rather than being flattened into something
 * prettier that could not be read back.
 *
 * ## Why this one ignores `ownerUserIds`
 *
 * `ownerUserIds` is the set of account managers whose *companies* this person may see, and a
 * workbook is not a company: it is a saved question about them. Filtering lists by it would be
 * meaningless. What governs a list is the rule the workspace screen uses — shared lists belong to
 * everybody, private ones to whoever built them — so that rule is reproduced here rather than
 * invented. The consequence is worth stating: somebody exporting this area for a migration gets
 * every shared list and their own private ones, and not other people's private ones, even if they
 * are an administrator. Under-disclosing is the right way for this to be wrong.
 *
 * ## Records and Created are passengers
 *
 * Both are derived — a frozen row count and a timestamp — and neither can be imported. They ride
 * along because a list's size is the first thing anybody wants to know when reading the file, and
 * the importer lists them among its columns so an exported file comes back without being flagged.
 */
export const workspaceExporter: Exporter = async (scope: ExportScope) => {
  const rows = await db.workbook.findMany({
    where: { OR: [{ shared: true }, { ownerUserId: scope.userId }] },
    include: {
      owner: { select: { name: true } },
      assignees: { select: { user: { select: { name: true } } } },
      _count: { select: { records: true } },
    },
    orderBy: [{ name: "asc" }, { createdAt: "asc" }],
  });

  return rows.map((w) => ({
    Name: w.name,
    Description: w.description ?? "",
    Owner: w.owner.name,
    Shared: w.shared,
    Mode: w.mode,
    Allocation: w.allocationMethod,
    Due: w.dueAt,
    Filters: JSON.stringify(w.filters ?? {}),
    // Semicolons, not commas: a person's name is one free-text field and the odd one contains a
    // comma. Sorted so that a file nobody has edited re-imports as a skip rather than as a reshuffle.
    Assignees: w.assignees
      .map((a) => a.user.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .join("; "),
    Records: w._count.records,
    Created: w.createdAt,
  }));
};
