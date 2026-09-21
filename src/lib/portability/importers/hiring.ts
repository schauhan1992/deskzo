import { CandidateStatus, EmploymentType } from "@prisma/client";
import { db } from "@/lib/db";
import { optionalUserRef, upsertDepartment } from "./lookups";
import {
  createRow,
  diff,
  errorRow,
  updateRow,
  RowReader,
  type Importer,
  type Resolved,
} from "./types";

/**
 * People we are hiring, before they have an account.
 *
 * A candidate is matched on their email address, lowercased, because until they join that address is
 * the only stable thing about them — they have no login and no employee code, and the name on a CV
 * is not unique. Worth knowing: `Candidate.email` is indexed but **not** unique in the schema, so
 * the key is a convention this importer keeps rather than one the database enforces. Where an
 * address already sits on two candidate rows the row is refused by name rather than matched: with
 * nothing to tell the two apart, picking either writes this row over somebody else's record and
 * leaves the record it was meant for untouched.
 *
 * ## What this importer refuses to touch
 *
 * The offered CTC, which is pay and marked `sensitivity: "onRequest"`. The intake token, which is a
 * credential — whoever holds it can submit that candidate's personal details as them, so it is not
 * something a spreadsheet gets to set. The intake data, which is the candidate's own unverified
 * account of themselves and is held unapplied on purpose. And `convertedUserId` / `convertedAt`,
 * which the app writes in one transaction at the moment somebody is genuinely hired, alongside
 * creating their login and their employee record. Importing that link would attach a candidate to an
 * account that no hiring process ever created, and nothing downstream would know the difference.
 *
 * `Status` is accepted, including JOINED, because it is the pipeline's own record of the outcome.
 * Setting it writes a label and nothing else: it creates no account and no employment record.
 */

type ResolvedCandidate = {
  email: string;
  name: string;
  phone?: string;
  designation?: string;
  departmentName?: string;
  employmentType?: EmploymentType;
  status?: CandidateStatus;
  source?: string;
  ownerId?: string;
  ownerName?: string;
  expectedJoining?: Date;
  existingId?: string;
};

/** Date-only columns compare as the day they stand for; a Date's own string carries a timezone. */
const day = (v: Date | null | undefined) => (v ? v.toISOString().slice(0, 10) : "");

async function resolve(row: Record<string, string>): Promise<Resolved<ResolvedCandidate>> {
  const r = new RowReader(row);

  const email = r.text("Email").toLowerCase();
  if (!email) return { error: "Email is required — it is how a candidate is matched." };
  const name = r.text("Name");
  if (!name) return { error: "Name is required." };

  const employmentType = r.enum("Employment type", EmploymentType);
  const status = r.enum("Status", CandidateStatus);
  const expectedJoining = r.date("Expected joining");
  if (r.error) return { error: r.error };

  const owner = await optionalUserRef("Owner", r.text("Owner"));
  if ("error" in owner) return { error: owner.error };

  // The address is the key, and the database does not enforce it. Two candidate rows really can
  // hold one — somebody who applied again a year later, or a row entered twice. Quietly taking the
  // first of them writes this row's name, status and owner over the other person's record and
  // leaves the row it was meant for untouched; worse, the export writes both of them back out, so
  // the two rows overwrite each other on every run and the file never settles. Refused and named
  // instead, which is the one thing that gets the duplicate looked at.
  const matches = await db.candidate.findMany({
    where: { email },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
    take: 2,
  });
  if (matches.length > 1) {
    return {
      error: `More than one candidate already has the address "${email}" (Email). Merge or remove the duplicate first — the address is the only thing a row can be matched on.`,
    };
  }

  return {
    value: {
      email,
      name,
      phone: r.text("Phone") || undefined,
      designation: r.text("Designation") || undefined,
      departmentName: r.text("Department") || undefined,
      employmentType,
      status,
      source: r.text("Source") || undefined,
      ownerId: owner.value?.id,
      ownerName: owner.value?.name,
      expectedJoining,
      existingId: matches[0]?.id,
    },
  };
}

export const hiringImporter: Importer = {
  templateColumns: [
    "Email",
    "Name",
    "Phone",
    "Designation",
    "Department",
    "Employment type",
    "Status",
    "Source",
    "Owner",
    "Expected joining",
  ],

  async plan(row, line) {
    const resolved = await resolve(row);
    if ("error" in resolved) return errorRow(line, row.Name || row.Email || "", resolved.error);
    const c = resolved.value;

    if (!c.existingId) {
      return createRow(line, c.email, c.name, {
        Name: c.name,
        Phone: c.phone,
        Designation: c.designation,
        Department: c.departmentName,
        "Employment type": c.employmentType,
        Status: c.status,
        Source: c.source,
        Owner: c.ownerName,
        "Expected joining": c.expectedJoining,
      });
    }

    const existing = await db.candidate.findUniqueOrThrow({
      where: { id: c.existingId },
      include: { department: { select: { name: true } }, owner: { select: { name: true } } },
    });

    return updateRow(line, c.email, c.name, [
      diff("Name", existing.name, c.name),
      c.phone ? diff("Phone", existing.phone, c.phone) : null,
      c.designation ? diff("Designation", existing.designation, c.designation) : null,
      c.departmentName ? diff("Department", existing.department?.name, c.departmentName) : null,
      c.employmentType ? diff("Employment type", existing.employmentType, c.employmentType) : null,
      c.status ? diff("Status", existing.status, c.status) : null,
      c.source ? diff("Source", existing.source, c.source) : null,
      c.ownerName ? diff("Owner", existing.owner?.name, c.ownerName) : null,
      c.expectedJoining ? diff("Expected joining", day(existing.expectedJoining), day(c.expectedJoining)) : null,
    ]);
  },

  async apply(row) {
    const resolved = await resolve(row);
    if ("error" in resolved) throw new Error(resolved.error);
    const c = resolved.value;

    // A department the file names but the system has never seen. Created here rather than in
    // resolve() so that planning stays read-only — a preview somebody abandons leaves no picklist
    // entries behind.
    const department = c.departmentName ? await upsertDepartment(c.departmentName) : null;

    const data = {
      name: c.name,
      ...(c.phone ? { phone: c.phone } : {}),
      ...(c.designation ? { designation: c.designation } : {}),
      ...(department ? { departmentId: department.id } : {}),
      ...(c.employmentType ? { employmentType: c.employmentType } : {}),
      ...(c.status ? { status: c.status } : {}),
      ...(c.source ? { source: c.source } : {}),
      ...(c.ownerId ? { ownerId: c.ownerId } : {}),
      ...(c.expectedJoining ? { expectedJoining: c.expectedJoining } : {}),
    };

    if (c.existingId) {
      await db.candidate.update({ where: { id: c.existingId }, data });
    } else {
      await db.candidate.create({ data: { ...data, email: c.email } });
    }
  },
};
