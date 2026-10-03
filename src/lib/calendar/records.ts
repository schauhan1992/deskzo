import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { isResellerManaged } from "@/lib/reseller";
import { formatTicketId } from "@/lib/tickets";
import { MEETING_RECORD_KINDS, type MeetingRecordKind, type MeetingRecordRef } from "@/lib/calendar/kinds";

/**
 * The record a meeting is scheduled from — a lead, a customer, one of its contacts, a ticket, or a
 * planned visit — and whether the person may: the same line each record's own page draws. What comes
 * back is what the meeting is linked to, who at the customer could be invited, and what the meeting
 * starts out as.
 */

export { MEETING_RECORD_KINDS, type MeetingRecordKind, type MeetingRecordRef };

export type MeetingLinks = { companyId: string | null; contactId: string | null; leadId: string | null; ticketId: string | null; visitId: string | null };

export type MeetingRecord = {
  ref: MeetingRecordRef;
  /** "Lead · Acme — ERP renewal" */
  label: string;
  href: string;
  links: MeetingLinks;
  companyName: string | null;
  /** A reseller's customer: nobody there is invited directly (src/lib/reseller.ts). */
  noDirectContact: boolean;
  /** People at the customer with an address — only for somebody who may see contacts' details. */
  contacts: { id: string; name: string; email: string }[];
  /** Invited unless taken off: the person the record is about. */
  preferredContactIds: string[];
  defaults: { title: string; location: string | null; startsAt: Date | null; durationMinutes: number; online: boolean; agenda: string | null };
};

export function readMeetingRecordRef(value: unknown): MeetingRecordRef | null {
  const v = (value ?? null) as { kind?: unknown; id?: unknown } | null;
  if (!v || typeof v.id !== "string" || !v.id.trim()) return null;
  return (MEETING_RECORD_KINDS as readonly string[]).includes(String(v.kind)) ? { kind: v.kind as MeetingRecordKind, id: v.id.trim() } : null;
}

type CompanyBits = { id: string; name: string; ownerUserId: string | null; managedByResellerId: string | null };
const COMPANY = { select: { id: true, name: true, ownerUserId: true, managedByResellerId: true } } as const;
const NO_LINKS: MeetingLinks = { companyId: null, contactId: null, leadId: null, ticketId: null, visitId: null };

async function contactsOf(userId: string, company: CompanyBits) {
  if (isResellerManaged(company) || !(await can(userId, "contacts.view"))) return [];
  const rows = await db.contact.findMany({
    where: { companyId: company.id, email: { not: null } },
    orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
    take: 50,
    select: { id: true, name: true, email: true },
  });
  return rows.filter((r): r is { id: string; name: string; email: string } => !!r.email?.trim()).map((r) => ({ ...r, email: r.email.trim() }));
}

function around(company: CompanyBits) {
  return { companyName: company.name, noDirectContact: isResellerManaged(company) };
}

/** Null when the record isn't there or isn't this person's to schedule from — the two look the same. */
export async function meetingRecordFor(userId: string, ref: MeetingRecordRef): Promise<MeetingRecord | null> {
  switch (ref.kind) {
    case "lead": {
      if (!(await can(userId, "leads.view"))) return null;
      const lead = await db.lead.findUnique({ where: { id: ref.id }, select: { id: true, title: true, contactId: true, company: COMPANY } });
      if (!lead || !(await canSeeCompany(userId, lead.company.ownerUserId))) return null;
      return {
        ref,
        label: `Lead · ${lead.company.name} — ${lead.title}`,
        href: `/leads/${lead.id}`,
        links: { ...NO_LINKS, companyId: lead.company.id, leadId: lead.id, contactId: lead.contactId },
        ...around(lead.company),
        contacts: await contactsOf(userId, lead.company),
        preferredContactIds: lead.contactId ? [lead.contactId] : [],
        defaults: { title: `${lead.company.name} — ${lead.title}`, location: null, startsAt: null, durationMinutes: 30, online: true, agenda: null },
      };
    }
    case "company": {
      const company = await db.company.findUnique({ where: { id: ref.id }, ...COMPANY });
      if (!company || !(await canSeeCompany(userId, company.ownerUserId))) return null;
      return {
        ref,
        label: company.name,
        href: `/companies/${company.id}`,
        links: { ...NO_LINKS, companyId: company.id },
        ...around(company),
        contacts: await contactsOf(userId, company),
        preferredContactIds: [],
        defaults: { title: `Meeting with ${company.name}`, location: null, startsAt: null, durationMinutes: 30, online: true, agenda: null },
      };
    }
    case "contact": {
      const contact = await db.contact.findUnique({ where: { id: ref.id }, select: { id: true, name: true, company: COMPANY } });
      if (!contact || !(await canSeeCompany(userId, contact.company.ownerUserId))) return null;
      return {
        ref,
        label: `${contact.name} · ${contact.company.name}`,
        href: `/companies/${contact.company.id}?tab=contacts`,
        links: { ...NO_LINKS, companyId: contact.company.id, contactId: contact.id },
        ...around(contact.company),
        contacts: await contactsOf(userId, contact.company),
        preferredContactIds: [contact.id],
        defaults: { title: `${contact.name} — ${contact.company.name}`, location: null, startsAt: null, durationMinutes: 30, online: true, agenda: null },
      };
    }
    case "ticket": {
      if (!(await moduleAvailableForTenant("helpdesk")) || !(await can(userId, "tickets.view"))) return null;
      const ticket = await db.ticket.findUnique({ where: { id: ref.id }, select: { id: true, ticketSeq: true, title: true, contactId: true, company: COMPANY } });
      if (!ticket || !(await canSeeCompany(userId, ticket.company.ownerUserId))) return null;
      const number = formatTicketId(ticket.ticketSeq);
      return {
        ref,
        label: `Ticket ${number} · ${ticket.company.name}`,
        href: `/tickets/${ticket.id}`,
        links: { ...NO_LINKS, companyId: ticket.company.id, ticketId: ticket.id, contactId: ticket.contactId },
        ...around(ticket.company),
        contacts: await contactsOf(userId, ticket.company),
        preferredContactIds: ticket.contactId ? [ticket.contactId] : [],
        defaults: { title: `${number} — ${ticket.title}`, location: null, startsAt: null, durationMinutes: 30, online: true, agenda: null },
      };
    }
    case "visit": {
      // A visit goes into the calendar of whoever is making it, and only they put it there.
      if (!(await moduleAvailableForTenant("visits"))) return null;
      const visit = await db.visit.findUnique({
        where: { id: ref.id },
        select: { id: true, userId: true, status: true, scheduledFor: true, address: true, agenda: true, contactId: true, leadId: true, company: COMPANY },
      });
      if (!visit || visit.userId !== userId || visit.status !== "PLANNED") return null;
      return {
        ref,
        label: `Visit · ${visit.company.name}`,
        href: `/visits/${visit.id}`,
        links: { ...NO_LINKS, companyId: visit.company.id, visitId: visit.id, contactId: visit.contactId, leadId: visit.leadId },
        ...around(visit.company),
        contacts: await contactsOf(userId, visit.company),
        preferredContactIds: visit.contactId ? [visit.contactId] : [],
        defaults: { title: `Visit — ${visit.company.name}`, location: visit.address ?? null, startsAt: visit.scheduledFor, durationMinutes: 60, online: false, agenda: visit.agenda ?? null },
      };
    }
  }
}
