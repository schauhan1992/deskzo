import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { getDownlineUserIds } from "@/lib/org-chart";
import { workspaceClock } from "@/lib/time/workspace";
import { viaCompany, type Exporter } from "./types";

/**
 * Field visits — who went where, when they were due, and what came of it.
 *
 * Scoped two ways, and it has to be both.
 *
 * The account scope is the obvious one: a visit belongs to the company it was to. On its own,
 * though, it is wider than the visits screen, which limits reading to yourself and your downline
 * unless you hold `visits.viewAll` — on the stated grounds that a visit log is a record of where a
 * person spent their day, not only of what happened to an account. Exporting on account scope alone
 * would hand somebody their colleagues' movements, which is precisely the thing export must never
 * do: the permission decides whether rows may leave the building, never which rows exist.
 *
 * So both filters apply, and the narrower one wins. The cost is that a colleague's call on your own
 * customer is missing from your export — real, and the right way round, because the alternative
 * leaks something the screen deliberately withholds.
 *
 * The headings below are the visits import template, in this order, so a file taken out of here can
 * be edited and handed straight back.
 *
 * The three moments are written as the workspace's own wall time, "2026-03-04 01:30", not as Dates. A
 * spreadsheet has no time zones: an xlsx date cell is a wall time, which is how Excel shows one and how
 * the importer reads one a person typed. A Date written there is shown in UTC, so a visit at 1:30 am in
 * India read as the evening before, and came back from the file as that day's.
 */
export const visitsExporter: Exporter = async (scope) => {
  // The same rule as visibleUserIds() in src/actions/visit.ts, which is what the screen uses.
  const visitors = (await can(scope.userId, "visits.viewAll"))
    ? null
    : [scope.userId, ...(await getDownlineUserIds(scope.userId))];

  const rows = await db.visit.findMany({
    where: {
      ...viaCompany(scope),
      ...(visitors ? { userId: { in: visitors } } : {}),
    },
    include: { company: { select: { name: true } }, user: { select: { name: true } } },
    orderBy: { visitSeq: "asc" },
  });

  const clock = await workspaceClock();
  const wall = (at: Date | null) => (at ? clock.input(at).replace("T", " ") : "");
  return rows.map((v) => ({
    Visit: `VIS-${String(v.visitSeq).padStart(6, "0")}`,
    Company: v.company.name,
    By: v.user.name,
    Purpose: v.purpose,
    Status: v.status,
    "Scheduled for": wall(v.scheduledFor),
    "Checked in": wall(v.checkInAt),
    "Checked out": wall(v.checkOutAt),
    Address: v.address ?? "",
    Outcome: v.outcome ?? "",
  }));
};
