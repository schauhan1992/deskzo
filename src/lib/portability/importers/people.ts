import { EmploymentType, Gender } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUserRef } from "./lookups";
import {
  createRow,
  diff,
  errorRow,
  keyOf,
  seqFromKey,
  updateRow,
  RowReader,
  type Importer,
  type Resolved,
} from "./types";

/**
 * The employment side of a person, keyed through their account.
 *
 * An `EmployeeProfile` is an extension of a `User` rather than a thing in its own right, so there is
 * no such thing as importing one for somebody with no account. A row naming a person we cannot place
 * is refused: creating the login to hang the record on would mean issuing credentials from a
 * spreadsheet, which is how directories fill up with accounts nobody approved.
 *
 * ## Two judgment calls
 *
 * **The key column takes three forms and they are not equivalent.** `USR-nnnnnn` is resolved
 * directly, and deliberately without the active-only filter every other lookup applies — the profile
 * of somebody who has left is still their profile, and our own export writes that key, so a file of
 * leavers has to read back. A name or an email address instead goes through `requireUserRef` like
 * everywhere else, active accounts only — and a name that more than one active account answers to is
 * refused rather than resolved, because `User.name` is not unique and an HR record written onto a
 * stranger reads as correct from every screen afterwards.
 *
 * **Pay, bank and statutory identifiers are not accepted.** Salary and bank details are marked
 * `sensitivity: "onRequest"` in entities.ts, and PAN, Aadhaar, UAN, PF and ESIC numbers have no
 * business arriving in a file somebody emailed around — there is no way to tell, on this side, that
 * the sender was entitled to hold them. They are absent from `templateColumns` and from the
 * exporter, so neither direction moves them. The biometric enrolment number is out too: it belongs
 * to whoever enrolled a finger on the terminal, and typing a different one here would silently
 * re-point somebody's attendance.
 */

type ResolvedEmployee = {
  userId: string;
  userName: string;
  userSeq: number;
  employeeCode?: string;
  designation?: string;
  employmentType?: EmploymentType;
  workLocation?: string;
  joinedOn?: Date;
  dateOfBirth?: Date;
  gender?: Gender;
  personalEmail?: string;
  personalPhone?: string;
  city?: string;
  state?: string;
};

/** Date-only columns compare as the day they stand for; a Date's own string carries a timezone. */
const day = (v: Date | null | undefined) => (v ? v.toISOString().slice(0, 10) : "");

type EmployeeUser = { id: string; name: string; userSeq: number };

async function resolveUser(column: string, raw: string): Promise<Resolved<EmployeeUser>> {
  const seq = seqFromKey("USR", raw);
  if (seq !== null) {
    const byKey = await db.user.findUnique({
      where: { userSeq: seq },
      select: { id: true, name: true, userSeq: true },
    });
    if (!byKey) return { error: `No user with key ${keyOf("USR", seq)} (${column}).` };
    return { value: byKey };
  }

  const ref = await requireUserRef(column, raw);
  if ("error" in ref) return { error: ref.error };

  // `requireUserRef` matches on the name as well as the address, and it takes the first hit —
  // `User.name` is not unique, and two people on a roster sharing a name is ordinary rather than
  // exceptional. Taking one of them here would write an employment record, a date of birth and a
  // personal phone number onto a stranger, and nothing about the row would look wrong afterwards.
  // An address is unique and settles it; so does the USR- key, which the branch above took and
  // which is what our own export writes.
  const value = raw.trim();
  if (!value.includes("@")) {
    const sharing = await db.user.count({
      where: { active: true, name: { equals: value, mode: "insensitive" } },
    });
    if (sharing > 1) {
      return {
        error: `More than one active user is called "${value}" (${column}). Use their email address or their USR- key, since an employee record written onto the wrong person reads as correct.`,
      };
    }
  }

  const user = await db.user.findUniqueOrThrow({
    where: { id: ref.value.id },
    select: { id: true, name: true, userSeq: true },
  });
  return { value: user };
}

async function resolve(row: Record<string, string>): Promise<Resolved<ResolvedEmployee>> {
  const r = new RowReader(row);

  const user = await resolveUser("User", r.text("User"));
  if ("error" in user) return { error: user.error };

  const employmentType = r.enum("Employment type", EmploymentType);
  const gender = r.enum("Gender", Gender);
  const joinedOn = r.date("Joined on");
  const dateOfBirth = r.date("Date of birth");
  if (r.error) return { error: r.error };

  const employeeCode = r.text("Employee code") || undefined;
  if (employeeCode) {
    // The column is unique in the database. Letting the write discover that gives the person a
    // constraint violation against one row; checking here names who already holds the code.
    const clash = await db.employeeProfile.findFirst({
      where: { employeeCode, userId: { not: user.value.id } },
      select: { user: { select: { name: true } } },
    });
    if (clash) {
      return { error: `Employee code "${employeeCode}" already belongs to ${clash.user.name} (Employee code).` };
    }
  }

  return {
    value: {
      userId: user.value.id,
      userName: user.value.name,
      userSeq: user.value.userSeq,
      employeeCode,
      designation: r.text("Designation") || undefined,
      employmentType,
      workLocation: r.text("Work location") || undefined,
      joinedOn,
      dateOfBirth,
      gender,
      // Stored as typed. Nothing is matched on it, so lowercasing it would be an edit nobody asked
      // for, showing up as a change the first time somebody re-imports a file they never altered.
      personalEmail: r.text("Personal email") || undefined,
      personalPhone: r.text("Personal phone") || undefined,
      city: r.text("City") || undefined,
      state: r.text("State") || undefined,
    },
  };
}

export const peopleImporter: Importer = {
  templateColumns: [
    "User",
    "Employee code",
    "Designation",
    "Employment type",
    "Work location",
    "Joined on",
    "Date of birth",
    "Gender",
    "Personal email",
    "Personal phone",
    "City",
    "State",
  ],

  async plan(row, line) {
    const resolved = await resolve(row);
    if ("error" in resolved) return errorRow(line, row.User ?? "", resolved.error);
    const e = resolved.value;
    const key = keyOf("USR", e.userSeq);

    const existing = await db.employeeProfile.findUnique({ where: { userId: e.userId } });

    if (!existing) {
      return createRow(line, key, e.userName, {
        "Employee code": e.employeeCode,
        Designation: e.designation,
        "Employment type": e.employmentType,
        "Work location": e.workLocation,
        "Joined on": e.joinedOn,
        "Date of birth": e.dateOfBirth,
        Gender: e.gender,
        "Personal email": e.personalEmail,
        "Personal phone": e.personalPhone,
        City: e.city,
        State: e.state,
      });
    }

    return updateRow(line, key, e.userName, [
      e.employeeCode ? diff("Employee code", existing.employeeCode, e.employeeCode) : null,
      e.designation ? diff("Designation", existing.designation, e.designation) : null,
      e.employmentType ? diff("Employment type", existing.employmentType, e.employmentType) : null,
      e.workLocation ? diff("Work location", existing.workLocation, e.workLocation) : null,
      e.joinedOn ? diff("Joined on", day(existing.joinedOn), day(e.joinedOn)) : null,
      e.dateOfBirth ? diff("Date of birth", day(existing.dateOfBirth), day(e.dateOfBirth)) : null,
      e.gender ? diff("Gender", existing.gender, e.gender) : null,
      e.personalEmail ? diff("Personal email", existing.personalEmail, e.personalEmail) : null,
      e.personalPhone ? diff("Personal phone", existing.personalPhone, e.personalPhone) : null,
      e.city ? diff("City", existing.city, e.city) : null,
      e.state ? diff("State", existing.state, e.state) : null,
    ]);
  },

  async apply(row) {
    const resolved = await resolve(row);
    if ("error" in resolved) throw new Error(resolved.error);
    const e = resolved.value;

    const data = {
      ...(e.employeeCode ? { employeeCode: e.employeeCode } : {}),
      ...(e.designation ? { designation: e.designation } : {}),
      ...(e.employmentType ? { employmentType: e.employmentType } : {}),
      ...(e.workLocation ? { workLocation: e.workLocation } : {}),
      ...(e.joinedOn ? { joinedOn: e.joinedOn } : {}),
      ...(e.dateOfBirth ? { dateOfBirth: e.dateOfBirth } : {}),
      ...(e.gender ? { gender: e.gender } : {}),
      ...(e.personalEmail ? { personalEmail: e.personalEmail } : {}),
      ...(e.personalPhone ? { personalPhone: e.personalPhone } : {}),
      ...(e.city ? { city: e.city } : {}),
      ...(e.state ? { state: e.state } : {}),
    };

    // `userId` is unique, so a person either has a profile or is getting their first one.
    await db.employeeProfile.upsert({
      where: { userId: e.userId },
      update: data,
      create: { ...data, userId: e.userId },
    });
  },
};
