/**
 * A person's standing on Staff & roles, and how long ago something was. Dependency-free, so the
 * client table and the server page share one wording.
 */

/** Active, invited (no password chosen yet — src/lib/account-setup.ts), or switched off. */
export type StaffStatus = "active" | "invited" | "off";

export const STAFF_STATUS_LABEL: Record<StaffStatus, string> = {
  active: "Active",
  invited: "Invited",
  off: "Switched off",
};

/** Switched off wins: an invitation to an account nobody can sign in to is not pending anything. */
export function staffStatus(person: { active: boolean; setupPending?: boolean }): StaffStatus {
  if (!person.active) return "off";
  return person.setupPending ? "invited" : "active";
}

/** "58m ago". Coarse on purpose — the exact time goes in the tooltip beside it. */
export function relativeAgo(at: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
