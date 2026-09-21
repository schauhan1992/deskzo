export type RenewalStatusKey = "unscheduled" | "expired" | "expiring" | "active";

export type RenewalStatus = {
  key: RenewalStatusKey;
  label: string;
  tone: "default" | "red" | "amber" | "green";
};

/** Days remaining until `endDate`, ceiling-rounded so "later today" still reads as 0, not -1. */
export function daysUntil(endDate: Date, now: Date = new Date()) {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.ceil((endDate.getTime() - now.getTime()) / msPerDay);
}

export function getRenewalStatus(
  endDate: Date | string | null,
  now: Date = new Date(),
  expiringWithinDays = 30,
): RenewalStatus {
  if (!endDate) return { key: "unscheduled", label: "No expiry set", tone: "default" };
  const days = daysUntil(new Date(endDate), now);
  if (days < 0) return { key: "expired", label: "Expired", tone: "red" };
  if (days <= expiringWithinDays) return { key: "expiring", label: `Expires in ${days}d`, tone: "amber" };
  return { key: "active", label: "Active", tone: "green" };
}
