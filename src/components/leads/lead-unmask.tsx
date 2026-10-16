"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { EyeOff, ShieldCheck } from "lucide-react";
import { unmaskLead, type UnmaskOutcome } from "@/actions/lead-unmask";
import type { UnmaskUsageStatus } from "@/lib/authz/unmask";

/**
 * Opening a lead unmasks it — the strip at the top of its page that does it and says what happened.
 *
 * Mounted on the lead's page (and in the Leads split view) only when some of its fields are masked for
 * this person. Opening the lead *is* the request to see it, so there is nothing to click: it asks once
 * per visit (`unmaskLead`), and when that unmasks the lead the page reads itself again — the values come
 * from the server's own render, never from here. Nothing is kept in the browser: tomorrow, or once the
 * access is taken away, the same page comes back masked.
 *
 * Asking is a deliberate visit, not a render: a link prefetching the page renders it without mounting
 * this, so nothing is spent before somebody actually opens the lead.
 */
export function LeadUnmask({
  leadId,
  revealable,
  revealed,
  concealed,
  usage,
}: {
  leadId: string;
  /** Whether any masked field here is one this person may unmask. */
  revealable: boolean;
  /** Already unmasked today: the page is showing it unmasked. */
  revealed: boolean;
  /** How many fields stay masked or restricted for them on this page. */
  concealed: number;
  usage: UnmaskUsageStatus | null;
}) {
  const router = useRouter();
  // One request per lead per visit. An effect that runs again for the same lead (React does this on
  // purpose in development, and on a refresh) listens to the request already made instead of asking
  // twice — or, worse, not listening at all.
  const request = useRef<{ leadId: string; answer: Promise<UnmaskOutcome> } | null>(null);
  const [outcome, setOutcome] = useState<UnmaskOutcome | null>(null);
  const [pending, setPending] = useState(revealable);

  useEffect(() => {
    if (!revealable) return;
    if (request.current?.leadId !== leadId) request.current = { leadId, answer: unmaskLead(leadId) };
    let live = true;
    request.current.answer
      .then((result) => {
        if (!live) return;
        setOutcome(result);
        setPending(false);
        // Newly unmasked: the page reads the lead again, now in the clear.
        if ((result.result === "ALLOWED" || result.result === "REPEAT") && !revealed) router.refresh();
      })
      .catch(() => {
        if (!live) return;
        setPending(false);
        setOutcome({ result: "DENIED", message: "Couldn't unmask this lead just now. Try opening it again.", usage: null });
      });
    return () => {
      live = false;
    };
  }, [leadId, revealable, revealed, router]);

  const shownUsage = outcome?.usage ?? usage;
  const counter = shownUsage ? (shownUsage.limit === null ? `${shownUsage.used} unmasked today` : `${shownUsage.used} / ${shownUsage.limit} leads unmasked today`) : null;
  const open = revealed || outcome?.result === "ALLOWED" || outcome?.result === "REPEAT";

  if (open) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-base border border-brand/30 bg-brand/5 px-3 py-2 text-sm">
        <ShieldCheck className="h-4 w-4 shrink-0 text-brand" aria-hidden />
        <span className="text-text">Unmasked for today.</span>
        <span className="text-muted">Opening it again today won&apos;t count against your limit.</span>
        {counter && <span className="ml-auto rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand">{counter}</span>}
      </div>
    );
  }

  return (
    <div
      role={outcome && outcome.result !== "NOTHING" ? "status" : undefined}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-base border border-line bg-surface-sunken px-3 py-2 text-sm"
    >
      <EyeOff className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
      <span className="text-text">
        {pending
          ? "Unmasking…"
          : outcome?.message ??
            (concealed === 1 ? "One field on this lead is masked for you." : `${concealed} fields on this lead are masked for you.`)}
      </span>
      {counter && <span className="ml-auto rounded-full bg-surface px-2 py-0.5 text-xs font-medium text-muted">{counter}</span>}
    </div>
  );
}
