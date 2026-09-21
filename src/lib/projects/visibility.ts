import type { Prisma } from "@prisma/client";

/**
 * Who can see a project.
 *
 * ## Stakeholders only
 *
 * Stricter than leads, tickets or companies, and chosen deliberately. An implementation project
 * carries the customer's internal systems, their supplier names, their headcount and — in this
 * module — their credentials. Being on the stakeholder list is what grants sight of it, which is
 * the thing that makes keeping that list current worth somebody's time.
 *
 * The consequence is real and has to be lived with: people will hit projects they can't open. The
 * fix is to add them, not to widen this.
 *
 * ## The three ways in
 *
 *   1. a stakeholder row with your user id,
 *   2. being the project manager, or having created it,
 *   3. holding `projects.viewAll`.
 *
 * (2) exists so a project can never be created into a state nobody can open — the manager and the
 * creator are also written as stakeholder rows, but this survives somebody deleting those by hand.
 *
 * (3) is not granted by default to anyone but Management. Without an override the module becomes
 * unadministrable the first time the only stakeholder on a project leaves the company, and an
 * access model with no way back in is one people work around rather than maintain.
 *
 * ## One filter, every read
 *
 * Every query that returns projects composes this. A second opinion about who may see one is how a
 * module like this leaks: not through the screen somebody thought about, but through the export,
 * the search, the dashboard count and the notification that nobody did.
 */
export function visibleProjectsWhere(userId: string, viewAll: boolean): Prisma.ProjectWhereInput {
  if (viewAll) return {};
  return {
    OR: [
      { stakeholders: { some: { userId } } },
      { managerId: userId },
      { createdById: userId },
    ],
  };
}

/**
 * The same question about one project, answered from a row already loaded.
 *
 * Takes the stakeholder user ids rather than re-querying, so a detail page that has just fetched
 * the project does not go back to the database to find out whether it was allowed to.
 */
export function canSeeProject(
  project: { managerId: string | null; createdById: string; stakeholderUserIds: string[] },
  userId: string,
  viewAll: boolean,
): boolean {
  if (viewAll) return true;
  return (
    project.managerId === userId ||
    project.createdById === userId ||
    project.stakeholderUserIds.includes(userId)
  );
}
