import { Badge } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";
import { formatIstDateTime } from "@/lib/india-time";
import { followUpChannelLabels, longDay, shortDay, type PromiseTone } from "@/lib/collections/rules";
import type { FollowUpView } from "@/lib/collections/load";

/**
 * Payment follow-ups as every screen shows them — the invoice, the order, the customer statement and
 * a due on the Collections page: who, when, how, what the client said, and any promise with how it
 * stands. No hooks and no actions, so a server component can render it anywhere.
 */

const TONE: Record<PromiseTone, "amber" | "red" | "green" | "default"> = { amber: "amber", red: "red", green: "green", default: "default" };

/** "₹5,000 by 15 Oct" — or "to pay by 15 Oct" when no amount was promised. */
export function promiseText(view: Pick<FollowUpView, "promisedAmount" | "promisedOn" | "currency">, long = false): string {
  if (!view.promisedOn) return "";
  const day = new Date(`${view.promisedOn}T00:00:00Z`);
  const on = long ? longDay(day) : shortDay(day);
  return view.promisedAmount !== null ? `${formatMoney(view.promisedAmount, view.currency)} by ${on}` : `to pay by ${on}`;
}

/** The promise, in words and a colour — never the colour alone. */
export function PromiseBadge({ view }: { view: FollowUpView }) {
  if (!view.promise) return null;
  return <Badge tone={TONE[view.promise.tone]}>{view.promise.text}</Badge>;
}

export function FollowUpHistory({
  history,
  showTarget = false,
  emptyText = "No follow-ups logged yet.",
}: {
  history: FollowUpView[];
  /** Name the invoice or order on each entry — on a statement, which covers several. */
  showTarget?: boolean;
  emptyText?: string;
}) {
  if (history.length === 0) return <p className="text-sm text-subtle">{emptyText}</p>;
  return (
    <ol className="space-y-3">
      {history.map((f) => (
        <li key={f.id} className="border-b border-line pb-3 text-sm last:border-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-text">{f.byName ?? "Someone no longer here"}</span>
            <span className="text-xs text-subtle">{formatIstDateTime(f.createdAt)}</span>
            <Badge tone="default">{followUpChannelLabels[f.channel]}</Badge>
            {showTarget && f.targetLabel && <span className="font-mono text-xs text-muted">{f.targetLabel}</span>}
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-text">{f.remarks}</p>
          {f.promisedOn && (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-muted">
              <span>Promised {promiseText(f, true)}</span>
              <PromiseBadge view={f} />
            </p>
          )}
          {f.nextFollowUpOn && (
            <p className="mt-0.5 text-xs text-subtle">Next follow-up {longDay(new Date(`${f.nextFollowUpOn}T00:00:00Z`))}</p>
          )}
        </li>
      ))}
    </ol>
  );
}
