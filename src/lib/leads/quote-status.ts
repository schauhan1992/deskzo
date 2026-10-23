import { db } from "@/lib/db";
import { documentAccess } from "@/lib/authz/access";
import { moduleAccessFor, moduleAvailableForTenant } from "@/lib/modules-access";
import { leadQuoteOf, QUOTE_SENT_WHERE, QUOTE_TYPES, type LeadQuote } from "@/lib/leads/quotes";

/**
 * Leads' quotations as one person may see them (src/lib/leads/quotes.ts) — for the leads list, the board
 * and the stage rule. Server only.
 */

/**
 * Whether this person sees quotations on leads: Sales Documents in the plan, switched on, and theirs to
 * see (`documents.view`). Without it the column, the filter and the board's badge aren't there at all,
 * rather than every lead reading "no quote".
 */
export async function seesLeadQuotes(userId: string): Promise<boolean> {
  return (await moduleAccessFor(userId, "sales_documents")) === "available";
}

/**
 * Each lead's quotation (`leadQuoteOf`), or null — the documents this person may see only, so a row
 * never names one they couldn't open. One query for the whole page.
 */
export async function leadQuotes(userId: string, leadIds: string[]): Promise<Record<string, LeadQuote | null>> {
  const out: Record<string, LeadQuote | null> = {};
  if (leadIds.length === 0) return out;
  const rows = await db.tradeDocument.findMany({
    where: { AND: [{ leadId: { in: leadIds } }, { docType: { in: [...QUOTE_TYPES] } }, { status: { not: "CANCELLED" } }, await documentAccess(userId, "view")] },
    select: { id: true, leadId: true, docNumber: true, docType: true, status: true, total: true, currency: true, issueDate: true, createdAt: true },
  });
  const byLead = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.leadId) continue;
    const list = byLead.get(row.leadId) ?? [];
    list.push(row);
    byLead.set(row.leadId, list);
  }
  for (const id of leadIds) out[id] = leadQuoteOf(byLead.get(id) ?? []);
  return out;
}

/**
 * Whether a stage's "an issued quotation" rule can be asked of this workspace's leads: only where it can
 * raise one. A workspace without Sales Documents — Deskzo Pipeline on its own, or the module switched
 * off — would otherwise have a stage nobody could ever move a lead into.
 */
export async function quoteRuleApplies(): Promise<boolean> {
  return moduleAvailableForTenant("sales_documents");
}

/**
 * Whether the lead has had a quotation sent — for its stage's rule. Every document linked to it counts,
 * whoever may see it: the rule is about the deal, not the person moving it.
 */
export async function hasQuoteSent(leadId: string): Promise<boolean> {
  return (await db.tradeDocument.count({ where: { leadId, ...QUOTE_SENT_WHERE } })) > 0;
}
