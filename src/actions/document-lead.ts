"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { leadAccess, mayAccess } from "@/lib/authz/access";
import { leadsInPlan } from "@/lib/leads/shown";
import { listLeadMasker, maskLeads } from "@/lib/leads/masking";
import { stagesOfLeads } from "@/lib/pipeline/server";
import { kindOf } from "@/lib/pipeline/rules";
import { documentWriteKey, documentWriteRefusal } from "@/lib/documents/write-permission";
import { recordAudit } from "@/lib/audit";
import { formatLeadId } from "@/lib/order-id";
import type { ActionResult } from "@/actions/company";

/**
 * Which deal a proposal is for (owner, 19 Oct 2026) — so a pipeline can show which leads have had a
 * quotation sent (src/lib/leads/quotes.ts).
 *
 * A proposal started from a lead's page is that lead's. One started from Documents asks, when the
 * customer has open leads: the form offers them, picking the only one (`listPartyLeads`). One already
 * made can be linked from its own page (`linkDocumentToLead`), and the documents made from it follow.
 * Invoices are never asked: they take the lead of what they were made from.
 *
 * Sales Documents' actions, borrowing the leads: where leads aren't in the plan, or this person can't
 * see them, there are none to offer.
 */

export type PartyLead = { id: string; leadSeq: number; ref: string; title: string; stage: string; open: boolean };

/** Whether this person may see leads to link: in the plan, and theirs to see. */
async function seesLeads(userId: string): Promise<boolean> {
  return (await leadsInPlan()) && (await can(userId, "leads.view"));
}

/**
 * The customer's leads this person may see, open ones first, newest first in each — for the proposal
 * form's "For lead" and a proposal's "Link to lead". Each named as their field access shows it in a list.
 */
export async function listPartyLeads(companyId: string): Promise<PartyLead[]> {
  const user = await requireModuleUser("sales_documents");
  if (!companyId || !(await can(user.id, "documents.view")) || !(await seesLeads(user.id))) return [];
  const rows = await db.lead.findMany({
    where: { AND: [{ companyId }, await leadAccess(user.id, "view")] },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { id: true, leadSeq: true, title: true, status: true },
  });
  const [masked, stages] = await Promise.all([maskLeads(await listLeadMasker(user.id), rows), stagesOfLeads(rows)]);
  return masked
    .map((l) => ({ id: l.id, leadSeq: l.leadSeq, ref: formatLeadId(l.leadSeq), title: l.title, stage: stages.get(l.id)?.label ?? "", open: kindOf(l.status) === "OPEN" }))
    .sort((a, b) => Number(b.open) - Number(a.open));
}

const linkSchema = z.object({ documentId: z.string().min(1), leadId: z.string().min(1).nullable() });

/**
 * Links a proposal to one of its customer's leads, or unlinks it (`leadId` null) — a draft or one already
 * issued, since which deal it is for is no part of what was sent. The proformas and invoices made from it
 * that carried its old lead carry the new one, so "which deal?" has one answer down the chain.
 */
export async function linkDocumentToLead(input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("sales_documents");
  const parsed = linkSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Choose a lead." };
  const { documentId, leadId } = parsed.data;
  const doc = await db.tradeDocument.findUnique({ where: { id: documentId }, select: { id: true, docType: true, docNumber: true, companyId: true, leadId: true, status: true } });
  if (!doc || !(await mayAccess(user.id, "documents", "edit", documentId))) return { ok: false, error: "That document no longer exists." };
  if (doc.docType !== "PROPOSAL") return { ok: false, error: "Only a proposal is linked to a lead — what is made from it follows." };
  if (!(await can(user.id, documentWriteKey(doc.docType, "issue")))) return { ok: false, error: documentWriteRefusal(doc.docType, "issue") };
  if (doc.status === "CANCELLED") return { ok: false, error: "A cancelled proposal stays as it is." };
  if (!(await seesLeads(user.id))) return { ok: false, error: "You don't have access to leads." };

  let label: string | null = null;
  if (leadId) {
    const lead = await db.lead.findUnique({ where: { id: leadId }, select: { companyId: true, leadSeq: true } });
    if (!lead || !(await mayAccess(user.id, "leads", "view", leadId))) return { ok: false, error: "That lead no longer exists." };
    if (lead.companyId !== doc.companyId) return { ok: false, error: "That lead belongs to a different company." };
    label = formatLeadId(lead.leadSeq);
  }
  if (doc.leadId === leadId) return { ok: true, data: null };

  await db.$transaction(async (tx) => {
    await tx.tradeDocument.update({ where: { id: doc.id }, data: { leadId } });
    // What was made from it, and from those, that still says the old lead (or none, as it did).
    let parents = [doc.id];
    const seen = new Set(parents);
    while (parents.length) {
      const children = await tx.tradeDocument.findMany({ where: { sourceDocumentId: { in: parents }, leadId: doc.leadId }, select: { id: true } });
      const fresh = children.map((c) => c.id).filter((id) => !seen.has(id));
      fresh.forEach((id) => seen.add(id));
      if (fresh.length) await tx.tradeDocument.updateMany({ where: { id: { in: fresh } }, data: { leadId } });
      parents = fresh;
    }
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "TradeDocument",
    entityId: doc.id,
    entityLabel: label ? `${doc.docNumber} — linked to ${label}` : `${doc.docNumber} — no longer linked to a lead`,
  });
  revalidatePath(`/documents/${doc.id}`);
  revalidatePath("/leads");
  return { ok: true, data: null };
}
