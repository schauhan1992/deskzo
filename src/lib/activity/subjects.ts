import { db } from "@/lib/db";

/**
 * Which customer or vendor, and which lead, an audit entry belongs to (owner, 19 Oct 2026) — so a contact
 * edited, an invoice issued or a call logged shows on that company's and that lead's Activity tab.
 *
 * Looked up as the entry is written, from the record it's about: one small read, never failing the work
 * (src/lib/audit.ts). The same mapping fills the entries written before it, in
 * prisma/migrations/20261119110000_activity_subjects — check:activity holds the two in step. A record
 * already deleted when its entry is written has nothing to look up: the caller says whose it was.
 */

export type AuditSubject = { companyId: string | null; leadId: string | null };

const NONE: AuditSubject = { companyId: null, leadId: null };
const of = (companyId: string | null | undefined, leadId: string | null | undefined = null): AuditSubject => ({ companyId: companyId ?? null, leadId: leadId ?? null });

/** The kinds of entry this knows the company or lead of, by how each is looked up. */
const RESOLVERS: Record<string, (id: string) => Promise<AuditSubject>> = {
  Company: async (id) => of(id),
  DomainProfile: async (id) => of(id),
  Lead: async (id) => {
    const r = await db.lead.findUnique({ where: { id }, select: { companyId: true } });
    return r ? of(r.companyId, id) : NONE;
  },
  Contact: async (id) => of((await db.contact.findUnique({ where: { id }, select: { companyId: true } }))?.companyId),
  // A consent's entry is filed under its contact.
  ContactConsent: async (id) => of((await db.contact.findUnique({ where: { id }, select: { companyId: true } }))?.companyId),
  CompanyBankAccount: async (id) => of((await db.companyBankAccount.findUnique({ where: { id }, select: { companyId: true } }))?.companyId),
  Order: async (id) => of((await db.companyProduct.findUnique({ where: { id }, select: { companyId: true } }))?.companyId),
  CompanyProduct: async (id) => of((await db.companyProduct.findUnique({ where: { id }, select: { companyId: true } }))?.companyId),
  OrderRebate: async (id) => of((await db.orderRebate.findUnique({ where: { id }, select: { companyProduct: { select: { companyId: true } } } }))?.companyProduct.companyId),
  TradeDocument: async (id) => {
    const r = await db.tradeDocument.findUnique({ where: { id }, select: { companyId: true, leadId: true } });
    return r ? of(r.companyId, r.leadId) : NONE;
  },
  EwayBill: async (id) => {
    const r = await db.ewayBill.findUnique({ where: { id }, select: { document: { select: { companyId: true, leadId: true } } } });
    return r ? of(r.document.companyId, r.document.leadId) : NONE;
  },
  Consignment: async (id) => {
    const r = await db.consignment.findUnique({ where: { id }, select: { document: { select: { companyId: true, leadId: true } } } });
    return r?.document ? of(r.document.companyId, r.document.leadId) : NONE;
  },
  Payment: async (id) => of((await db.payment.findUnique({ where: { id }, select: { companyId: true } }))?.companyId),
  PaymentFollowUp: async (id) => of((await db.paymentFollowUp.findUnique({ where: { id }, select: { companyId: true } }))?.companyId),
  Ticket: async (id) => of((await db.ticket.findUnique({ where: { id }, select: { companyId: true } }))?.companyId),
  Task: async (id) => {
    const r = await db.task.findUnique({ where: { id }, select: { companyId: true, leadId: true } });
    return r ? of(r.companyId, r.leadId) : NONE;
  },
  CalendarEvent: async (id) => {
    const r = await db.calendarEvent.findUnique({ where: { id }, select: { companyId: true, leadId: true } });
    return r ? of(r.companyId, r.leadId) : NONE;
  },
  Visit: async (id) => {
    const r = await db.visit.findUnique({ where: { id }, select: { companyId: true, leadId: true } });
    return r ? of(r.companyId, r.leadId) : NONE;
  },
  CallLog: async (id) => {
    const r = await db.callLog.findUnique({ where: { id }, select: { companyId: true, leadId: true } });
    return r ? of(r.companyId, r.leadId) : NONE;
  },
  Booking: async (id) => {
    const r = await db.booking.findUnique({ where: { id }, select: { companyId: true, leadId: true } });
    return r ? of(r.companyId, r.leadId) : NONE;
  },
  Expense: async (id) => {
    const r = await db.expense.findUnique({ where: { id }, select: { companyId: true, leadId: true } });
    return r ? of(r.companyId, r.leadId) : NONE;
  },
  Project: async (id) => of((await db.project.findUnique({ where: { id }, select: { companyId: true } }))?.companyId),
  ProjectDocument: async (id) => of((await db.projectDocument.findUnique({ where: { id }, select: { project: { select: { companyId: true } } } }))?.project.companyId),
  ProjectBillingMilestone: async (id) => of((await db.projectBillingMilestone.findUnique({ where: { id }, select: { project: { select: { companyId: true } } } }))?.project.companyId),
  VendorCredit: async (id) => of((await db.vendorCredit.findUnique({ where: { id }, select: { vendorId: true } }))?.vendorId),
  VendorStatement: async (id) => of((await db.vendorStatement.findUnique({ where: { id }, select: { vendorId: true } }))?.vendorId),
  FeedbackRequest: async (id) => of((await db.feedbackRequest.findUnique({ where: { id }, select: { companyId: true } }))?.companyId),
  PortalLogin: async (id) => of((await db.portalLogin.findUnique({ where: { id }, select: { companyId: true } }))?.companyId),
};

/** The kinds the Activity tab can file under a company or a lead. */
export const SUBJECT_KINDS: readonly string[] = Object.keys(RESOLVERS);

/** Whose an entry is; nothing for a kind that belongs to no company, or a record not found. Never throws. */
export async function auditSubject(entityType: string, entityId: string): Promise<AuditSubject> {
  const resolve = RESOLVERS[entityType];
  if (!resolve) return NONE;
  try {
    return await resolve(entityId);
  } catch {
    return NONE;
  }
}
