import { db } from "@/lib/db";
import { parseRecordRef } from "@/lib/record-url";
import { formatCompanyId, formatContactId, formatLeadId, formatOrderId } from "@/lib/order-id";
import { formatTicketId } from "@/lib/tickets";

/**
 * Records in the public API are named by their readable reference — COM-000123, CON-…, LEAD-…,
 * TCK-…, ORD-… — or by their id; tasks and invoices, which have no number of their own, by id.
 *
 * Turning a reference into an id says nothing about whether the key's person may see the record: the
 * action that reads or changes it decides, and answers not-found the same either way
 * (src/lib/record-url.ts explains why walking the numbers then tells nobody anything).
 */

export type RefKind = "company" | "contact" | "lead" | "ticket" | "order";

const ID = /^[a-z0-9]{20,40}$/;

/** The record's id, or null when the reference names nothing. */
export async function idOf(kind: RefKind, value: string | null | undefined): Promise<string | null> {
  const text = String(value ?? "").trim();
  if (!text || text.length > 60) return null;
  const ref = parseRecordRef(text);
  if (ref.kind === "id") return ID.test(ref.id) ? ref.id : null;
  const where = { select: { id: true } } as const;
  switch (kind) {
    case "company":
      return (await db.company.findUnique({ where: { companySeq: ref.seq }, ...where }))?.id ?? null;
    case "contact":
      return (await db.contact.findUnique({ where: { contactSeq: ref.seq }, ...where }))?.id ?? null;
    case "lead":
      return (await db.lead.findUnique({ where: { leadSeq: ref.seq }, ...where }))?.id ?? null;
    case "ticket":
      return (await db.ticket.findUnique({ where: { ticketSeq: ref.seq }, ...where }))?.id ?? null;
    case "order":
      return (await db.companyProduct.findUnique({ where: { orderSeq: ref.seq }, ...where }))?.id ?? null;
  }
}

/** A plain id, as tasks and invoices are named. */
export const plainId = (value: string | null | undefined): string | null => {
  const text = String(value ?? "").trim();
  return ID.test(text) ? text : null;
};

export const companyRef = (seq: number | null | undefined) => (typeof seq === "number" ? formatCompanyId(seq) : null);
export const contactRef = (seq: number | null | undefined) => (typeof seq === "number" ? formatContactId(seq) : null);
export const leadRef = (seq: number | null | undefined) => (typeof seq === "number" ? formatLeadId(seq) : null);
export const ticketRef = (seq: number | null | undefined) => (typeof seq === "number" ? formatTicketId(seq) : null);
export const orderRef = (seq: number | null | undefined) => (typeof seq === "number" ? formatOrderId(seq) : null);

/** A Date or ISO string as ISO; null stays null. */
export const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

/** A calendar day (a @db.Date, or a typed day) as yyyy-mm-dd. */
export const day = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString().slice(0, 10) : null);

/** A Decimal, number or numeric string as a number; anything else (a masked value) as it is. */
export function amount(value: unknown): number | string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  const n = Number(String(value));
  return Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(String(value).trim()) ? n : String(value);
}

/** An active member of the workspace by id or email — for owners and assignees named in a request. */
export async function personId(value: unknown): Promise<string | null> {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const person = await db.user.findFirst({
    where: { active: true, kind: "MEMBER", ...(text.includes("@") ? { email: { equals: text, mode: "insensitive" } } : { id: text }) },
    select: { id: true },
  });
  return person?.id ?? null;
}
