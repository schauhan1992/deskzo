"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ActionNotice } from "@/components/ui/action-notice";
import { setRecurringBilling, type RecurringBillingView } from "@/actions/recurring-billing";
import { documentPath } from "@/lib/trade-documents";

type Choice = "OFF" | "AUTO_RENEW" | "INSTALMENTS";

/**
 * Recurring billing on one subscription: off, renewing itself at the end of its term, or invoiced in
 * monthly or quarterly parts — and every period it has raised, with its draft. Nothing it raises is
 * issued; the drafts wait on the invoice list for somebody to check and issue.
 */
export function RecurringBillingCard({ view }: { view: RecurringBillingView }) {
  const router = useRouter();
  const current: Choice = view.setting?.mode ?? "OFF";
  const [choice, setChoice] = useState<Choice>(current);
  const [cycle, setCycle] = useState<"MONTHLY" | "QUARTERLY">(view.setting?.cycle === "QUARTERLY" ? "QUARTERLY" : "MONTHLY");
  const [billFrom, setBillFrom] = useState(view.setting?.billFrom ?? view.suggestedFrom.MONTHLY ?? view.term.start ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();

  const changed =
    choice !== current ||
    (choice === "INSTALMENTS" && (cycle !== (view.setting?.cycle ?? null) || billFrom !== (view.setting?.billFrom ?? null)));
  const unavailable = choice === "OFF" ? null : view.why[choice];

  function pickCycle(next: "MONTHLY" | "QUARTERLY") {
    setCycle(next);
    // Follow the cycle's own next part, unless a day has already been chosen and saved.
    if (!view.setting?.billFrom) setBillFrom(view.suggestedFrom[next] ?? view.term.start ?? "");
  }

  function save() {
    setError(null);
    startSave(async () => {
      const result = await setRecurringBilling(
        view.orderId,
        choice === "OFF" ? null : choice === "AUTO_RENEW" ? { mode: "AUTO_RENEW" } : { mode: "INSTALMENTS", cycle, billFrom },
      );
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Recurring billing</CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted">
          {current === "OFF"
            ? "Off — this subscription is invoiced by hand."
            : current === "AUTO_RENEW"
              ? "Renews itself: on the first day of the next term, the renewal order is punched for approval and its invoice raised as a draft."
              : `Invoiced ${view.setting?.cycle === "QUARTERLY" ? "quarterly" : "monthly"} from ${view.setting?.billFrom}: each part is raised as a draft on the day it begins.`}
          {current !== "OFF" && view.setting && <span className="text-subtle"> Set by {view.setting.setBy}.</span>}
        </p>

        {view.canManage && (
          <div className="space-y-2 rounded-base border border-line p-3">
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="recurring-mode" className="text-muted">
                Billing
              </label>
              <select
                id="recurring-mode"
                className="h-8 rounded-base border border-line bg-surface px-2 text-sm text-text"
                value={choice}
                disabled={saving}
                onChange={(e) => setChoice(e.target.value as Choice)}
              >
                <option value="OFF">Off</option>
                <option value="AUTO_RENEW">Renew itself at the end of the term</option>
                <option value="INSTALMENTS">Invoice the term in parts</option>
              </select>
              {choice === "INSTALMENTS" && (
                <>
                  <select
                    aria-label="How often"
                    className="h-8 rounded-base border border-line bg-surface px-2 text-sm text-text"
                    value={cycle}
                    disabled={saving}
                    onChange={(e) => pickCycle(e.target.value as "MONTHLY" | "QUARTERLY")}
                  >
                    <option value="MONTHLY">Monthly</option>
                    <option value="QUARTERLY">Quarterly</option>
                  </select>
                  <label htmlFor="recurring-from" className="text-muted">
                    from
                  </label>
                  <input
                    id="recurring-from"
                    type="date"
                    className="h-8 rounded-base border border-line bg-surface px-2 text-sm text-text"
                    value={billFrom}
                    min={view.term.start ?? undefined}
                    max={view.term.end ?? undefined}
                    disabled={saving}
                    onChange={(e) => setBillFrom(e.target.value)}
                  />
                </>
              )}
            </div>
            {choice === "INSTALMENTS" && !unavailable && (
              <p className="text-xs text-subtle">
                Parts that began before this day are not raised — they are taken to be invoiced already. The price is split
                evenly across every part of the term, the last part taking any paisa left over.
              </p>
            )}
            {unavailable && <p className="text-xs text-warning">{unavailable}</p>}
            <div className="flex justify-end">
              <Button type="button" size="sm" onClick={save} disabled={saving || !changed || !!unavailable}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        )}

        <div aria-live="polite">{error && <ActionNotice tone="error">{error}</ActionNotice>}</div>

        {view.raised.length > 0 && (
          <ul className="divide-y divide-line rounded-base border border-line">
            {view.raised.map((p) => (
              <li key={p.start} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="text-text">
                  {p.start} to {p.end}
                  {p.renewal && (
                    <>
                      {" "}
                      · renewed as{" "}
                      <Link href={p.renewal.path} className="text-brand hover:underline">
                        the new order
                      </Link>
                    </>
                  )}
                </span>
                {p.documentId ? (
                  <Link href={documentPath(p.documentId)} className="text-brand hover:underline">
                    {p.docNumber} · {p.status?.toLowerCase().replaceAll("_", " ")}
                  </Link>
                ) : (
                  <span className="text-subtle">{p.renewal ? "no invoice raised" : "skipped — its draft was deleted"}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
