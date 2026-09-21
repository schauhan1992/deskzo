import { db } from "@/lib/db";
import type { Exporter } from "./types";

/**
 * The employment record behind each account — who we employ, since when, on what terms.
 *
 * Not company-scoped, and deliberately so: an employee is not somebody's account, so `ownerUserIds`
 * has nothing to filter here. The permission on the area is what decides whether these rows may
 * leave the building at all.
 *
 * ## What is not in this file
 *
 * Salary, bank details, PAN, Aadhaar, UAN, PF and ESIC are all on the model and none of them are
 * here. `entities.ts` marks pay and bank details `sensitivity: "onRequest"`, and the statutory
 * identifiers are worse than that: an export is a file that gets emailed, forwarded and left in a
 * downloads folder, and a spreadsheet of Aadhaar and PF numbers is a breach waiting for somebody's
 * laptop to go missing. The matching importer will not read them either, so neither direction can
 * move them by accident. The biometric enrolment number is out for a different reason — it is set by
 * enrolling a finger on a terminal, and a number typed into a spreadsheet would point attendance at
 * whoever actually holds that enrolment.
 *
 * Leavers are included. A deactivated account still has an employment record, and an HR export that
 * quietly dropped everybody who has left would be useless for exactly the questions people ask of
 * one. That is also why the key column is `USR-nnnnnn` rather than a name: it resolves back to the
 * same person whatever has since happened to their account, and two employees may share a name.
 */
export const peopleExporter: Exporter = async () => {
  const rows = await db.employeeProfile.findMany({
    include: { user: { select: { userSeq: true } } },
    orderBy: { user: { userSeq: "asc" } },
  });

  return rows.map((p) => ({
    User: `USR-${String(p.user.userSeq).padStart(6, "0")}`,
    "Employee code": p.employeeCode ?? "",
    Designation: p.designation ?? "",
    "Employment type": p.employmentType,
    "Work location": p.workLocation ?? "",
    "Joined on": p.joinedOn,
    "Date of birth": p.dateOfBirth,
    Gender: p.gender ?? "",
    "Personal email": p.personalEmail ?? "",
    "Personal phone": p.personalPhone ?? "",
    City: p.city ?? "",
    State: p.state ?? "",
  }));
};
