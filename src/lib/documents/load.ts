import { db } from "@/lib/db";
import { viaCompanyScope } from "@/lib/authz/company-scope";
import { toPlain } from "@/lib/serialize";

/**
 * One trade document as the detail and print views need it, for a given person — scoped to the
 * accounts they manage, so one outside their book reads as missing.
 *
 * No permission check here: the caller has made it. That is the action behind the pages
 * (getTradeDocument, for the person signed in) or the print page spending a render pass (for the
 * person the pass was minted for) — see src/lib/documents/render-grant.ts.
 */
export async function findTradeDocumentFor(userId: string, id: string) {
  const document = await db.tradeDocument.findFirst({
    // `findFirst` only so the scope can travel with the id: a document belongs to whoever manages
    // the party it was raised for, and one outside that book has to read as missing — this feeds
    // the detail page and the printable copy, both of which render the customer's whole address
    // and every line they were charged for.
    where: { id, ...(await viaCompanyScope(userId)) },
    include: {
    company: {
      select: {
        id: true,
        name: true,
        relationshipType: true,
        companySeq: true,
        // The fallback contact for a document nobody was named on — see `contact` in the print
        // page. Matches what creation does and what the form's blank option says it will do.
        owner: { select: { name: true, email: true, phone: true } },
      },
    },
    location: true,
    lines: { orderBy: { sortOrder: "asc" } },
    createdBy: { select: { id: true, name: true } },
    submittedBy: { select: { id: true, name: true } },
    approvedBy: { select: { id: true, name: true } },
    // Email and phone travel with the name because they are printed on the document itself, so
    // the customer can reach whoever sent it without going back through the switchboard.
    salesperson: { select: { id: true, name: true, email: true, phone: true } },
    sourceDocument: { select: { id: true, docNumber: true, docType: true } },
    againstDocument: { select: { id: true, docNumber: true, docType: true, issueDate: true } },
    conversions: { select: { id: true, docNumber: true, docType: true, status: true } },
    creditNotes: { select: { id: true, docNumber: true, docType: true, status: true } },
    lead: { select: { id: true, title: true, status: true, leadSeq: true } },
    // Who "we" were on it: the branch it was raised from (null = written before branches, the head
    // office's) and the registration its GSTIN snapshot came from.
    branch: { select: { id: true, name: true, code: true, isHeadOffice: true, active: true } },
    gstRegistration: { select: { id: true, gstin: true, stateCode: true, code: true } },
  },
  });
  return document ? toPlain(document) : null;
}
