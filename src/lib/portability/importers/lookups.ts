import { db } from "@/lib/db";
import { normalizeCompanyName } from "@/lib/validation/company";
import type { Resolved } from "./types";

/**
 * Turning a name in a spreadsheet into a record in the database.
 *
 * Every one of these refuses rather than guesses. That is the whole point of them: a row that names
 * a company we do not have, or a person who does not work here, is a row somebody has to look at.
 * Creating the missing record silently would turn one typo into a near-duplicate account, which is
 * far harder to unpick afterwards than a failed row is to fix at the time.
 */

export type CompanyRef = { id: string; name: string; normalizedName: string };

export async function findCompany(nameOrKey: string): Promise<CompanyRef | null> {
  const value = nameOrKey.trim();
  if (!value) return null;
  return db.company.findUnique({
    where: { normalizedName: normalizeCompanyName(value) },
    select: { id: true, name: true, normalizedName: true },
  });
}

/** For a required company column. The error names the column so a wide file stays navigable. */
export async function requireCompany(column: string, value: string): Promise<Resolved<CompanyRef>> {
  if (!value.trim()) return { error: `${column} is required.` };
  const company = await findCompany(value);
  if (!company) {
    return { error: `No company named "${value}" (${column}). Import the company first, or correct the spelling.` };
  }
  return { value: company };
}

export type UserRef = { id: string; name: string; email: string; active: boolean };

const SELECT = { id: true, name: true, email: true, active: true } as const;

/**
 * A person, by full name or email address.
 *
 * ## Why leavers are found, and where they are then refused
 *
 * The obvious rule is "active accounts only", and for deciding who works on something it is the
 * right one: an account manager who has left takes the account out of everybody's scoped view, and
 * a ticket assigned to them is one nobody will ever look at.
 *
 * But the same columns also carry history. A visit somebody made in March, a ticket they closed, a
 * candidate they interviewed — those rows are correct, and they export with that person's name on
 * them. Refusing the name outright makes our own export un-importable the moment anybody leaves,
 * which is not a rule that survives contact with a real company.
 *
 * So the lookup can find them and the caller decides. `includeInactive` belongs on a column that
 * records who did something; it does not belong on one that decides who may see the record from
 * here on.
 */
export async function findUser(nameOrEmail: string, includeInactive = false): Promise<UserRef | null> {
  const value = nameOrEmail.trim();
  if (!value) return null;
  const match = {
    OR: [{ email: value.toLowerCase() }, { name: { equals: value, mode: "insensitive" as const } }],
  };
  // Active first: where a leaver and a current employee share a name, the current one is meant.
  const current = await db.user.findFirst({ where: { active: true, ...match }, select: SELECT });
  if (current || !includeInactive) return current;
  return db.user.findFirst({ where: match, select: SELECT });
}

/** Whether a cell names this person, the way `findUser` matches: their email address, or their full name in any case. */
export function names(value: string, person: { name: string; email: string }): boolean {
  const cell = value.trim().toLowerCase();
  return cell === person.email.toLowerCase() || cell === person.name.trim().toLowerCase();
}

function notFound(column: string, value: string, includeInactive: boolean): string {
  const who = includeInactive ? "No user" : "No active user";
  return `${who} matches "${value}" (${column}). Use their full name or their email address.`;
}

export async function requireUserRef(
  column: string,
  value: string,
  includeInactive = false,
  /** Who the record has in this column today: see `optionalUserRef`. */
  current?: UserRef | null,
): Promise<Resolved<UserRef>> {
  if (!value.trim()) return { error: `${column} is required.` };
  if (current && names(value, current)) return { value: current };
  const user = await findUser(value, includeInactive);
  if (!user) return { error: notFound(column, value, includeInactive) };
  return { value: user };
}

/**
 * An optional person column: absent is fine, present but unknown is not.
 *
 * The distinction matters most for ownership. Silently falling back to whoever ran the import files
 * the record in the wrong person's view, and under the account scoping rules that decides who can
 * see it at all — so a name we cannot place is refused, not approximated.
 */
export async function optionalUserRef(
  column: string,
  value: string,
  includeInactive = false,
  /**
   * Who the record has in this column today. A cell naming them is no change, even after they have
   * left: our own export writes their name, and reading it back must not refuse the row. Naming
   * somebody new still has to name a current person.
   */
  current?: UserRef | null,
): Promise<Resolved<UserRef | null>> {
  if (!value.trim()) return { value: null };
  if (current && names(value, current)) return { value: current };
  const user = await findUser(value, includeInactive);
  if (!user) return { error: `${notFound(column, value, includeInactive)} Or leave the cell empty.` };
  return { value: user };
}

/**
 * A department, matched without regard to case.
 *
 * `Department.name` is unique exactly as typed, so an exact-match lookup on "engineering" misses a
 * stored "Engineering" and creates a second row — after which half the staff are in one department
 * and half in a homograph of it, and every report that groups by department is quietly wrong.
 */
export async function findDepartment(name: string): Promise<{ id: string; name: string } | null> {
  const value = name.trim();
  if (!value) return null;
  return db.department.findFirst({
    where: { name: { equals: value, mode: "insensitive" } },
    select: { id: true, name: true },
  });
}

/** The same lookup, creating the department when it is genuinely new. Never called from `plan`. */
export async function upsertDepartment(name: string): Promise<{ id: string; name: string } | null> {
  const value = name.trim();
  if (!value) return null;
  return (
    (await findDepartment(value)) ??
    (await db.department.create({ data: { name: value }, select: { id: true, name: true } }))
  );
}
