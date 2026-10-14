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
