import { ContactDesignation } from "@prisma/client";
import { db } from "@/lib/db";
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
 */

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
  const name = r.text("Name");
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

  async plan(row, line) {
    const resolved = await resolve(row);
    if ("error" in resolved) return errorRow(line, row.Name ?? "", resolved.error);
    const c = resolved.value;
    const label = `${c.name} at ${c.companyName}`;

    if (!c.existingId) {
      return createRow(line, c.email || `${c.companyName}:${c.name}`, label, {
        Name: c.name,
        Email: c.email,
        Phone: c.phone,
        Designation: c.designation,
      });
    }

    const existing = await db.contact.findUniqueOrThrow({ where: { id: c.existingId } });
    return updateRow(line, keyOf("CON", c.existingSeq!), label, [
      diff("Name", existing.name, c.name),
      c.email ? diff("Email", existing.email, c.email) : null,
      c.phone ? diff("Phone", existing.phone, c.phone) : null,
      c.designation ? diff("Designation", existing.designation, c.designation) : null,
    ]);
  },

  async apply(row, ctx: ImportContext) {
    const resolved = await resolve(row);
    if ("error" in resolved) throw new Error(resolved.error);
    const c = resolved.value;

    const data = {
      name: c.name,
      ...(c.email ? { email: c.email } : {}),
      ...(c.phone ? { phone: c.phone } : {}),
      ...(c.designation ? { designation: c.designation } : {}),
    };

    if (c.existingId) {
      await db.contact.update({ where: { id: c.existingId }, data });
    } else {
      await db.contact.create({ data: { ...data, companyId: c.companyId, createdByUserId: ctx.actorUserId } });
    }
  },
};
