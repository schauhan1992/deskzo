import { db } from "@/lib/db";
import { ownScope, viaCompany, type Exporter, type ExportScope } from "./types";

/**
 * The four kinds of party, their people, and the records that hang off them.
 *
 * Companies, vendors, resellers and commission parties are one table separated by
 * `relationshipType`, so each area filters on its own kind. Without that filter an export of
 * "vendors" returns the customer list too, and a target system merges your suppliers into it.
 */

function partyExporter(area: string): Exporter {
  const relationshipType =
    area === "vendors"
      ? "VENDOR"
      : area === "resellers"
        ? "RESELLER"
        : area === "commission-parties"
          ? "COMMISSION_PARTY"
          : "CLIENT";

  return async (scope: ExportScope) => {
    const rows = await db.company.findMany({
      where: {
        ...ownScope(scope),
        relationshipType,
        // A customer is a company that has actually bought something, as distinct from one marked
        // CUSTOMER by somebody optimistic.
        ...(area === "customers" ? { stage: "CUSTOMER", products: { some: {} } } : {}),
      },
      include: {
        owner: { select: { name: true } },
        industry: { select: { name: true } },
        managedByReseller: { select: { name: true } },
        _count: { select: { contacts: true, products: true } },
      },
      orderBy: { name: "asc" },
    });

    return rows.map((c) => ({
      Key: c.normalizedName,
      Name: c.name,
      Type: c.relationshipType,
      "Managed by reseller": c.managedByReseller?.name ?? "",
      Stage: c.stage,
      Industry: c.industry?.name ?? "",
      Source: c.source ?? "",
      // Exported because the importer accepts it: a column somebody can edit but never receives is
      // a round trip that quietly drops their change.
      Website: c.website ?? "",
      "Account manager": c.owner?.name ?? "",
      Contacts: c._count.contacts,
      Orders: c._count.products,
      "Added on": c.createdAt,
    }));
  };
}

export const companiesExporter = partyExporter("companies");
export const customersExporter = partyExporter("customers");
export const vendorsExporter = partyExporter("vendors");
export const resellersExporter = partyExporter("resellers");
export const commissionPartiesExporter = partyExporter("commission-parties");

export const contactsExporter: Exporter = async (scope) => {
  const rows = await db.contact.findMany({
    where: viaCompany(scope),
    include: { company: { select: { name: true } } },
    orderBy: { contactSeq: "asc" },
  });
  return rows.map((c) => ({
    Key: `CON-${String(c.contactSeq).padStart(6, "0")}`,
    Name: c.name,
    Company: c.company.name,
    Designation: c.designation,
    Email: c.email ?? "",
    Phone: c.phone ?? "",
    Primary: c.isPrimary,
    "Email status": c.emailStatus,
  }));
};

export const ticketsExporter: Exporter = async (scope) => {
  const rows = await db.ticket.findMany({
    where: viaCompany(scope),
    include: { company: { select: { name: true } }, assignedTo: { select: { name: true } } },
    orderBy: { ticketSeq: "asc" },
  });
  return rows.map((t) => ({
    Ticket: `TKT-${String(t.ticketSeq).padStart(6, "0")}`,
    Company: t.company.name,
    Title: t.title,
    Status: t.status,
    Priority: t.priority,
    "Assigned to": t.assignedTo?.name ?? "",
    Raised: t.createdAt,
  }));
};

export const suppressionExporter: Exporter = async () => {
  const rows = await db.suppression.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map((s) => ({
    Scope: s.scope,
    Value: s.value,
    Reason: s.reason,
    Added: s.createdAt,
    Expires: s.expiresAt,
  }));
};
