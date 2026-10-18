"use client";

import { useState, useTransition } from "react";
import { buyCreditPack, type BillingView } from "@/actions/billing";
import { creditsText } from "@/lib/ai/catalogue";
import { formatMoney } from "@/lib/billing/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ActionNotice } from "@/components/ui/action-notice";
import { useClock } from "@/components/time/clock-provider";

/**
 * Settings → Plan & billing's Deskzo AI credits (src/lib/ai): this month's, the packs with credits left,
 * and the packs on sale — each bought once through Razorpay's page in India (src/lib/ai/packs.ts).
 */
export function AiCreditsCard({ credits, justBought }: { credits: BillingView["aiCredits"]; justBought: boolean }) {
  const clock = useClock();
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [buying, setBuying] = useState<string | null>(null);

  function buy(key: string) {
    setNotice(null);
    setBuying(key);
    startTransition(async () => {
      const r = await buyCreditPack(key);
      if (!r.ok) {
        setNotice(r.error);
        setBuying(null);
        return;
      }
      window.location.assign(r.data.url);
    });
  }

  const unlimited = !credits.metered || credits.allowance === null;
  return (
    <Card id="ai-credits">
      <CardHeader className="text-sm font-medium text-text">Deskzo AI credits</CardHeader>
      <CardContent className="space-y-3 text-sm">
        {justBought && (
          <p className="rounded-base border border-info/30 bg-info-bg px-3 py-2 text-info">Thank you — the credits are added as soon as Razorpay confirms the payment, usually within a minute. Reload to see them.</p>
        )}
        {unlimited ? (
          <p className="text-muted">This workspace has no limit on Deskzo AI.</p>
        ) : (
          <p className="text-text">
            <span className="text-lg font-semibold tabular-nums">{creditsText(credits.available ?? 0)}</span> credits left to use ·{" "}
            <span className="text-muted">
              {creditsText(Math.max(0, credits.allowance! - credits.allowanceUsed))} of the plan&apos;s {creditsText(credits.allowance!)} this month, renewing {clock.date(credits.renewsAt)}
            </span>
          </p>
        )}
        {credits.packs.length > 0 && (
          <ul className="space-y-0.5 text-xs text-muted">
            {credits.packs.map((p, i) => (
              <li key={i}>
                A pack of {creditsText(p.credits)}: {creditsText(p.remaining)} left, until {clock.date(p.expiresAt)}
                {p.source === "STAFF" ? " (given by Deskzo)" : ""}
              </li>
            ))}
          </ul>
        )}
        {!unlimited && (
          <>
            <p className="text-xs text-muted">The copilot and Automate&apos;s drafting use credits — a copilot question usually 2–8. Packs are used after the plan&apos;s credits and last twelve months.</p>
            {credits.offer.open ? (
              <div className="flex flex-wrap gap-2">
                {credits.offer.packs.map((p) => (
                  <Button key={p.key} variant="secondary" size="sm" disabled={pending} onClick={() => buy(p.key)} title={`${formatMoney(p.amount, "INR")} + 18% GST`}>
                    {buying === p.key ? "Opening Razorpay…" : `${creditsText(p.credits * 1000)} credits · ${formatMoney(p.total, "INR")}`}
                  </Button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted">{credits.offer.reason}</p>
            )}
            {credits.offer.open && <p className="text-[11px] text-subtle">Prices include 18% GST. A tax invoice is issued with the plan&apos;s invoices below.</p>}
          </>
        )}
        {notice && <ActionNotice tone="error">{notice}</ActionNotice>}
      </CardContent>
    </Card>
  );
}
