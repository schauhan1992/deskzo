import { ContactDesignation, type Prisma } from "@prisma/client";
import { contactDetailFieldKeys, seesResellerContactDetails } from "@/lib/authz/contact-access";
import { valuesFor } from "@/lib/custom-fields/server";
import { db } from "@/lib/db";
import { isResellerManaged } from "@/lib/reseller";
import { requireCompany } from "./lookups";
import {
  createRow,
  diff,
  errorRow,
  keyOf,
  seqFromKey,
  updateRow,
  RowReader,
  type Importer,
  type ImportContext,
  type Resolved,
} from "./types";

/**
 * People at the companies.
 *
 * Matched on the stable key where the file carries one, otherwise on email within the company. Email
 * alone would be wrong: the same address legitimately appears under two companies when somebody
 * changes employer, and matching across them would move the old contact rather than create the new.
 *
 * A reseller's end customer's contact details — the email, the phone, and the workspace's own contact
 * fields of those kinds — are hidden from somebody without `contacts.viewRestricted`
 * (src/lib/authz/contact-access.ts), and their import neither shows nor changes them on a contact that
 * exists: those cells are read as blank, and the preview says so where they held something. A match
 * on email still finds the contact, as the contacts list's search does — what stays hidden is what is
 * stored. A new contact takes what the row gives it, as the add form does.
 */

const HIDDEN_NOTICE =
  "A reseller's customer's email, phone and other contact details are hidden from you — those cells were left as they are.";

/** The contact-detail custom fields to leave alone on this contact, or null when this person sees its details. */
async function hiddenDetailKeys(existing: { company: { managedByResellerId: string | null } }, ctx: ImportContext): Promise<string[] | null> {
  if (!isResellerManaged(existing.company) || (await seesResellerContactDetails(ctx.actorUserId))) return null;
  return contactDetailFieldKeys();
}

type ResolvedContact = {
  name: string;
  companyId: string;
  companyName: string;
  email?: string;
  phone?: string;
  designation?: ContactDesignation;
  existingId?: string;
  existingSeq?: number;
};

async function resolve(row: Record<string, string>): Promise<Resolved<ResolvedContact>> {
  const r = new RowReader(row);
  // A whole name, or another system's two halves of one (`extraColumns`).
  const name = r.text("Name") || [r.text("First name"), r.text("Last name")].filter(Boolean).join(" ");
  if (!name) return { error: "Name is required." };

  const company = await requireCompany("Company", r.text("Company"));
  if ("error" in company) return { error: company.error };

  const designation = r.enum("Designation", ContactDesignation);
  if (r.error) return { error: r.error };

  const email = r.text("Email").toLowerCase() || undefined;
  const seq = seqFromKey("CON", r.text("Key"));
  const existing = seq
    ? await db.contact.findUnique({ where: { contactSeq: seq } })
    : email
      ? await db.contact.findFirst({ where: { companyId: company.value.id, email } })
      : null;

  if (seq && !existing) {
    return { error: `No contact with key CON-${seq}. Remove the Key cell to create a new contact.` };
  }

  return {
    value: {
      name,
      companyId: company.value.id,
      companyName: company.value.name,
      email,
      phone: r.text("Phone") || undefined,
      designation,
      existingId: existing?.id,
      existingSeq: existing?.contactSeq,
    },
  };
}

export const contactsImporter: Importer = {
  templateColumns: ["Key", "Name", "Company", "Designation", "Email", "Phone"],
  /**
   * Another system's export as it comes (owner, 18 Oct 2026), from each vendor's own field lists:
   *   · Zoho CRM Contacts — https://help.zoho.com/portal/kb/articles/standard-fields-contacts
   *   · Salesforce Contacts — https://help.salesforce.com/s/articleView?id=sales.contacts_fields.htm&type=5
   *   · HubSpot Contacts — https://knowledge.hubspot.com/properties/hubspots-default-contact-properties
   *   · Pipedrive People — the field reference in its sample import sheet, linked from
   *     https://support.pipedrive.com/en/article/importing-sample-import-spreadsheets
   *   · Zoho Books — https://zoho.com/books/help/migration/quickbooks-online.html
   * Left out on purpose: "Title"/"Job title" (Designation is Deskzo's own list, and a free-text title would
   * refuse the row); "Mobile" and the other phones (each export also has "Phone"); "Secondary Email".
   */
  headerAliases: {
    Name: ["Full Name", "Person - Name"],
    Company: ["Account Name", "Company name", "Organization"],
    Email: ["Email ID", "Person - Email"],
    Phone: ["Phone number"],
    "First name": ["Person - First name"],
    "Last name": ["Person - Last name"],
  },
  // Most systems split a person's name; a Deskzo file holds it whole, so these aren't exported.
  extraColumns: ["First name", "Last name"],
  customEntity: "CONTACT",

  async plan(row, line, ctx) {
    const resolved = await resolve(row);
    if ("error" in resolved) return errorRow(line, row.Name ?? "", resolved.error);
    const c = resolved.value;
    const label = `${c.name} at ${c.companyName}`;
    const existing = c.existingId
      ? await db.contact.findUniqueOrThrow({ where: { id: c.existingId }, include: { company: { select: { managedByResellerId: true } } } })
      : null;
    const hidden = existing ? await hiddenDetailKeys(existing, ctx) : null;
    // The workspace's own fields in this row, checked against what the contact holds (sheets.ts).
    const custom = ctx.custom ? await ctx.custom.merge(existing ? await valuesFor("CONTACT", existing.id) : {}, row, { skip: hidden ?? [] }) : null;
    if (custom && !custom.ok) return errorRow(line, label, custom.error);

    if (!existing) {
      return createRow(line, c.email || `${c.companyName}:${c.name}`, label, {
        Name: c.name,
        Email: c.email,
        Phone: c.phone,
        Designation: c.designation,
        ...(custom?.ok ? Object.fromEntries(custom.changes.map((ch) => [ch.field, ch.to])) : {}),
      });
    }

    const planned = updateRow(line, keyOf("CON", c.existingSeq!), label, [
      diff("Name", existing.name, c.name),
      // Hidden from this person: not compared, so nothing about the stored value shows.
      c.email && !hidden ? diff("Email", existing.email, c.email) : null,
      c.phone && !hidden ? diff("Phone", existing.phone, c.phone) : null,
      c.designation ? diff("Designation", existing.designation, c.designation) : null,
      ...(custom?.ok ? custom.changes : []),
    ]);
    const heldHidden = hidden !== null && (!!c.email || !!c.phone || (custom?.ok === true && custom.ignored.length > 0));
    return heldHidden ? { ...planned, notice: HIDDEN_NOTICE } : planned;
  },

  async apply(row, ctx: ImportContext) {
    const resolved = await resolve(row);
    if ("error" in resolved) throw new Error(resolved.error);
    const c = resolved.value;
    const existing = c.existingId
      ? await db.contact.findUniqueOrThrow({ where: { id: c.existingId }, select: { company: { select: { managedByResellerId: true } } } })
      : null;
    const hidden = existing ? await hiddenDetailKeys(existing, ctx) : null;

    const custom = ctx.custom ? await ctx.custom.merge(c.existingId ? await valuesFor("CONTACT", c.existingId) : {}, row, { skip: hidden ?? [] }) : null;
    if (custom && !custom.ok) throw new Error(custom.error);

    const data = {
      name: c.name,
      ...(custom?.ok && custom.changes.length > 0 ? { customFields: custom.values as Prisma.InputJsonValue } : {}),
      // Hidden from this person on a reseller's customer: left as stored.
      ...(c.email && !hidden ? { email: c.email } : {}),
      ...(c.phone && !hidden ? { phone: c.phone } : {}),
      ...(c.designation ? { designation: c.designation } : {}),
    };

    if (c.existingId) {
      await db.contact.update({ where: { id: c.existingId }, data });
    } else {
      await db.contact.create({ data: { ...data, companyId: c.companyId, createdByUserId: ctx.actorUserId } });
    }
  },
};
