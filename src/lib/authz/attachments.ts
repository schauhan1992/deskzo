import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { accountScopeIds } from "@/lib/authz/company-scope";

/**
 * Whether somebody may hang a note or a task on these records — each one must exist and be on an
 * account they can see.
 *
 * Shared by the note board and the AI copilot's proposals, so "attach it to Acme" means the same
 * thing from both. `undefined` scope means no restriction: the scope half of each clause drops out
 * and the count asks only whether the record is there.
 */
export async function mayAttachTo(
  userId: string,
  attachments: { companyId: string | null; leadId: string | null; ticketId: string | null },
): Promise<boolean> {
  const { companyId, leadId, ticketId } = attachments;
  if (!companyId && !leadId && !ticketId) return true;

  const scopeIds = await accountScopeIds(userId);
  const inScope: Prisma.CompanyWhereInput | undefined = scopeIds === null ? undefined : { ownerUserId: { in: scopeIds } };
  const viaCompany = inScope ? { company: inScope } : {};

  if (companyId && (await db.company.count({ where: { id: companyId, ...inScope } })) === 0) return false;
  if (leadId && (await db.lead.count({ where: { id: leadId, ...viaCompany } })) === 0) return false;
  if (ticketId && (await db.ticket.count({ where: { id: ticketId, ...viaCompany } })) === 0) return false;
  return true;
}
