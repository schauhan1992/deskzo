import type { TicketPriority, TicketStatus, TicketType } from "@prisma/client";
import type { Clock } from "@/lib/time/zone";

export function formatTicketId(seq: number) {
  return `TCK-${String(seq).padStart(6, "0")}`;
}

type BadgeTone = "default" | "green" | "blue" | "red" | "amber";

export const ticketStatusTones: Record<TicketStatus, BadgeTone> = {
  OPEN: "blue",
  IN_PROGRESS: "amber",
  ON_HOLD: "default",
  RESOLVED: "green",
  CLOSED: "default",
};

export const ticketPriorityTones: Record<TicketPriority, BadgeTone> = {
  LOW: "default",
  MEDIUM: "blue",
  HIGH: "amber",
  URGENT: "red",
};

export const ticketTypeLabels: Record<TicketType, string> = {
  PRODUCT_SUPPORT: "Product Support",
  DEMO: "Demo",
  INSTALLATION: "Installation",
  TRAINING: "Training",
  OTHER: "Other",
};

export const SLA_HOURS: Record<TicketPriority, number> = {
  URGENT: 4,
  HIGH: 24,
  MEDIUM: 72,
  LOW: 168,
};

export type TicketSlaStatus = {
  key: "resolved" | "closed" | "overdue" | "on-track";
  label: string;
  tone: "default" | "red" | "green";
};

/**
 * SLA is a fixed target-response window per priority, counted from ticket creation. Not configurable per admin yet.
 *
 * The label's time is on `clock` — the workspace's (`workspaceClock()`, `useClock()`), so the server and
 * the browser print the same words. It used an Intl formatter with no zone: the server's, or the reader's.
 */
export function getTicketSlaStatus(
  priority: TicketPriority,
  status: TicketStatus,
  createdAt: Date | string,
  clock: Clock,
  now: Date = new Date(),
): TicketSlaStatus {
  if (status === "RESOLVED") return { key: "resolved", label: "Resolved", tone: "default" };
  if (status === "CLOSED") return { key: "closed", label: "Closed", tone: "default" };

  const dueBy = new Date(new Date(createdAt).getTime() + SLA_HOURS[priority] * 60 * 60 * 1000);
  if (now.getTime() > dueBy.getTime()) {
    return { key: "overdue", label: `Overdue since ${clock.dateTimeShort(dueBy)}`, tone: "red" };
  }
  return { key: "on-track", label: `Due by ${clock.dateTimeShort(dueBy)}`, tone: "green" };
}
