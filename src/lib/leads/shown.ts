import { moduleAvailableForTenant } from "@/lib/modules-access";

/**
 * Leads are a module of their own since 14 Oct 2026, sold with Deskzo Pipeline, CRM and One. A workspace
 * without them — one that never had them, or has stopped paying for them — keeps any it had, out of
 * sight: a task, call, visit, note or expense made against one still opens, without the lead. Asked of
 * the plan and the switch, not the person: who may see a lead is the lead's own rule, as before.
 */
export async function leadsInPlan(): Promise<boolean> {
  return moduleAvailableForTenant("leads");
}

/** The rows as they are where leads are in the plan; elsewhere each one's lead left off. */
export function withoutHiddenLeads<T extends { lead?: unknown }>(rows: T[], shown: boolean): T[] {
  return shown ? rows : rows.map((row) => ({ ...row, lead: null }));
}

/**
 * The rows as one person may see their leads: left off where leads aren't in the plan, and each lead's
 * name as their field access shows it in a list (src/lib/leads/masking.ts) — for every screen that
 * names the lead a task, call, visit, note, claim or form response was made against.
 */
export async function leadsSeenBy<T extends { lead?: unknown }>(userId: string, rows: T[]): Promise<T[]> {
  if (!(await leadsInPlan())) return withoutHiddenLeads(rows, false);
  const { listLeadMasker, maskLeadRefs } = await import("@/lib/leads/masking");
  return maskLeadRefs(await listLeadMasker(userId), rows as (T & { lead?: { title?: string | null } | null })[]);
}
