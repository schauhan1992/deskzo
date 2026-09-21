import { db } from "@/lib/db";
import type { Exporter } from "./types";

/**
 * Candidates and where each one has got to in the pipeline.
 *
 * Not company-scoped: a candidate is not an account, so `ownerUserIds` has nothing to filter. The
 * area permission decides who may take the list out.
 *
 * Keyed on the email address, which is how every ATS identifies somebody who does not yet have a
 * login. Note that the column is a key by convention rather than by constraint — `Candidate.email`
 * is indexed but not unique in the schema — so the importer matches the oldest row holding an
 * address and says so.
 *
 * ## What is not in this file
 *
 * The offered CTC, because pay is `sensitivity: "onRequest"` and this export is not that request.
 * The intake token, because it is a credential: anybody holding it can submit that candidate's
 * personal details as them, and a token in a spreadsheet is a token in everybody's inbox. The intake
 * data itself, because it is what the candidate typed and has not been checked by anyone yet. And
 * the conversion link, because "this candidate became that employee" is a fact the app writes at the
 * moment somebody is actually hired; exported and handed back it would be a claim.
 */
export const hiringExporter: Exporter = async () => {
  const rows = await db.candidate.findMany({
    include: { department: { select: { name: true } }, owner: { select: { name: true } } },
    orderBy: [{ email: "asc" }, { createdAt: "asc" }],
  });

  return rows.map((c) => ({
    Email: c.email,
    Name: c.name,
    Phone: c.phone ?? "",
    Designation: c.designation ?? "",
    Department: c.department?.name ?? "",
    "Employment type": c.employmentType,
    Status: c.status,
    Source: c.source ?? "",
    Owner: c.owner?.name ?? "",
    "Expected joining": c.expectedJoining,
  }));
};
