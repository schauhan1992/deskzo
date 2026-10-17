import { Badge } from "@/components/ui/card";

/** A workflow's, run's or step's state, in words and a colour that means the same everywhere on Automate's pages. */

const RUN: Record<string, { label: string; tone: "default" | "green" | "blue" | "red" | "amber" | "brand" }> = {
  QUEUED: { label: "Queued", tone: "default" },
  RUNNING: { label: "Running", tone: "blue" },
  WAITING: { label: "Waiting", tone: "brand" },
  SUCCEEDED: { label: "Succeeded", tone: "green" },
  FAILED: { label: "Failed", tone: "red" },
  CANCELLED: { label: "Cancelled", tone: "default" },
  NEEDS_ATTENTION: { label: "Needs a decision", tone: "amber" },
  SKIPPED: { label: "Skipped", tone: "default" },
  UNKNOWN: { label: "Outcome unknown", tone: "amber" },
  ACTIVE: { label: "On", tone: "green" },
  PAUSED: { label: "Paused", tone: "amber" },
  DRAFT: { label: "Draft", tone: "default" },
  ARCHIVED: { label: "Archived", tone: "default" },
};

export function StatusBadge({ status }: { status: string }) {
  const known = RUN[status] ?? { label: status, tone: "default" as const };
  return <Badge tone={known.tone}>{known.label}</Badge>;
}
