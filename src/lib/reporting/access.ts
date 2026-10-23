import type { Prisma } from "@prisma/client";

/**
 * Who may do what with a saved report (Reporting & Analytics, owner 23 Oct 2026).
 *
 * Opening a report and reading its rows are separate questions, and only the first is answered here: the owner and
 * anybody it is shared with — by name, or through their department — may open it; an edit share may change it in
 * the builder; only the owner shares it on or deletes it. What it then shows each of them is their own rows, through
 * their own access to its source (src/lib/reporting/run.ts) — so being given a report never gives anybody data.
 *
 * Pure: the actions read the rows and ask.
 */

export type ReportAccess = "owner" | "edit" | "view";

export type ReportViewer = { id: string; departmentId: string | null };

export type ShareRow = { userId: string | null; departmentId: string | null; canEdit: boolean };

export function accessTo(report: { ownerId: string; shares: readonly ShareRow[] }, viewer: ReportViewer): ReportAccess | null {
  if (report.ownerId === viewer.id) return "owner";
  const mine = report.shares.filter((s) => s.userId === viewer.id || (!!viewer.departmentId && s.departmentId === viewer.departmentId));
  if (mine.length === 0) return null;
  return mine.some((s) => s.canEdit) ? "edit" : "view";
}

export const canEdit = (a: ReportAccess | null) => a === "owner" || a === "edit";

/** The reports a person may open, as a query: their own, and those shared with them or their department. */
export function visibleWhere(viewer: ReportViewer): Prisma.SavedReportWhereInput {
  return {
    OR: [
      { ownerId: viewer.id },
      { shares: { some: { OR: [{ userId: viewer.id }, ...(viewer.departmentId ? [{ departmentId: viewer.departmentId }] : [])] } } },
    ],
  };
}

/** Shared with them — not theirs. */
export function sharedWithWhere(viewer: ReportViewer): Prisma.SavedReportWhereInput {
  return { AND: [{ ownerId: { not: viewer.id } }, visibleWhere(viewer)] };
}

/** "Only you", "Finance team", "3 people", "Finance team and 2 people" — who else can open it. */
export function sharedWithWords(shares: readonly { userId: string | null; department: { name: string } | null }[]): string {
  const people = shares.filter((s) => s.userId).length;
  const teams = shares.flatMap((s) => (s.department ? [s.department.name] : []));
  if (people === 0 && teams.length === 0) return "Only you";
  const teamWords = teams.length === 1 ? `${teams[0]} team` : teams.length > 1 ? `${teams.length} departments` : "";
  const peopleWords = people === 0 ? "" : `${people} ${people === 1 ? "person" : "people"}`;
  return [teamWords, peopleWords].filter(Boolean).join(" and ");
}
