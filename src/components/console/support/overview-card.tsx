import Link from "next/link";
import { ArrowRight, LifeBuoy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The Overview's support line: "Support: 3 open (1 urgent)", the whole card one link to the inbox.
 * Open counts requests not yet waiting on the customer or done (open and in progress). Amber while
 * anything is open, red while anything urgent is. Server-safe.
 */
export function SupportOverviewCard({ open, urgent }: { open: number; urgent: number }) {
  const tone = urgent > 0 ? "bg-danger-bg text-danger" : open > 0 ? "bg-warning-bg text-warning" : "bg-surface-sunken text-muted";
  return (
    <Link
      href="/support"
      className="flex items-center gap-3 rounded-xl border border-line bg-surface p-4 shadow-sm transition-colors hover:border-line-strong"
    >
      <span aria-hidden="true" className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", tone)}>
        <LifeBuoy className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-text tabular-nums">{`Support: ${open.toLocaleString("en-IN")} open (${urgent.toLocaleString("en-IN")} urgent)`}</span>
        <span className="block text-xs text-muted">Requests from Contact Support in the workspaces</span>
      </span>
      <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle" />
    </Link>
  );
}
