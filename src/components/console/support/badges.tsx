import { CircleAlert } from "lucide-react";
import { StatusPill } from "@/components/console/kit/status";
import { SUPPORT_PRIORITY, SUPPORT_STATUS } from "@/lib/console-shared/labels";
import type { SupportPriorityKey, SupportStatusKey } from "@/lib/support/types";

/**
 * A support request's status and priority as pills, from the one label map (labels.ts) — so
 * "Urgent" is the same red in the inbox, on the request, on a workspace's 360 and in the audit
 * log. Server-safe. A value a newer release wrote shows as itself rather than failing the page.
 */

export function SupportStatusPill({ status }: { status: SupportStatusKey }) {
  const entry = SUPPORT_STATUS[status] ?? { label: String(status), tone: "neutral" as const };
  return (
    <StatusPill tone={entry.tone} dot>
      {entry.label}
    </StatusPill>
  );
}

/** Urgent carries an icon as well as its colour, so it is not told by red alone. */
export function SupportPriorityPill({ priority }: { priority: SupportPriorityKey }) {
  const entry = SUPPORT_PRIORITY[priority] ?? { label: String(priority), tone: "neutral" as const };
  return (
    <StatusPill tone={entry.tone} icon={priority === "URGENT" ? <CircleAlert className="h-3 w-3" /> : undefined}>
      {entry.label}
    </StatusPill>
  );
}
