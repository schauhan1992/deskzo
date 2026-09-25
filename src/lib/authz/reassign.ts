import { hasEffectivePermission } from "@/actions/permission";
import { requireUser } from "@/lib/session";
import { mayLeaveUnassigned, mayReassignAnything, type ReassignRights } from "@/lib/authz/reassign-rules";

/** The rules themselves live in reassign-rules.ts; this adds what needs a session and the permission resolver. */
export * from "@/lib/authz/reassign-rules";

export async function reassignRights(userId: string): Promise<ReassignRights> {
  const [any, own] = await Promise.all([
    hasEffectivePermission(userId, "accounts.reassign"),
    hasEffectivePermission(userId, "accounts.handOffOwn"),
  ]);
  return { any, own };
}

/**
 * What the signed-in person's bulk controls may offer: whether to show an owner or caller picker at
 * all, and whether it may include "Unassign". For list pages, which otherwise never load the session.
 */
export async function viewerReassignControls(): Promise<{ show: boolean; canUnassign: boolean }> {
  const user = await requireUser();
  const rights = await reassignRights(user.id);
  return { show: mayReassignAnything(rights), canUnassign: mayLeaveUnassigned(rights) };
}
