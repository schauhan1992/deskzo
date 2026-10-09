import type { AccessLevel } from "@prisma/client";

/**
 * Access levels as people read and compare them — one plain module, so the role editor (a client
 * component), the My access page (a server one) and the save action (src/actions/access-levels.ts)
 * use the same words and the same order. A constant exported from a "use client" file would reach a
 * server component as a client reference, not as the object.
 */

export const LEVEL_WORDS: Record<AccessLevel, string> = {
  NONE: "None",
  OWN: "Own",
  TEAM: "Team",
  BRANCH: "Branch",
  ALL: "All",
  FOLLOW: "As the account",
};

/** Narrow to wide. "As the account" has no place in it and is ranked beside Team only for the history. */
export const LEVEL_RANK: Record<AccessLevel, number> = { NONE: 0, OWN: 1, TEAM: 2, FOLLOW: 2, BRANCH: 3, ALL: 4 };

/**
 * Whether a cell claims more than the one it sits under lets it have. The engine ANDs the two, so a
 * narrower cell is a real narrowing — "As the account" under "Team" is the team's records on accounts
 * they reach — and only a cell the AND would cut down is refused. "As the account" sits beside the
 * order: nothing but All claims more than it, and it claims more than None.
 */
export function claimsMoreThan(cell: AccessLevel, over: AccessLevel): boolean {
  if (over === "ALL") return false;
  if (over === "NONE") return cell !== "NONE";
  if (over === "FOLLOW") return cell === "ALL";
  if (cell === "FOLLOW") return false;
  return LEVEL_RANK[cell] > LEVEL_RANK[over];
}

/**
 * Whether one level is inside another — for "nobody grants wider than they reach". Stricter than the
 * above: "As the account" and the person-based levels each reach records the other doesn't, so neither
 * is inside the other.
 */
export function within(level: AccessLevel, reach: AccessLevel): boolean {
  if (reach === "ALL" || level === "NONE") return true;
  if (level === "FOLLOW" || reach === "FOLLOW") return level === reach;
  return LEVEL_RANK[level] <= LEVEL_RANK[reach];
}

/** The actions an action sits under: nobody edits what they can't see, nor deletes what they can't edit. */
export const UNDER = { view: [], edit: ["view"], delete: ["edit", "view"], assign: ["edit", "view"] } as const satisfies Record<
  "view" | "edit" | "delete" | "assign",
  readonly ("view" | "edit")[]
>;
