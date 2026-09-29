"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveCloseSettings } from "@/actions/close";
import type { CloseSettings } from "@/lib/close/settings";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { rupeesShort } from "@/components/close/format";

/**
 * Revenue & Close's settings: whether the nightly job posts on its own, how a new revenue schedule
 * spreads, and when a month-on-month change is large enough to need explaining.
 */
export function CloseSettingsForm({ settings }: { settings: CloseSettings }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [autoPost, setAutoPost] = useState(settings.autoPost);
  const [spreadEvenly, setSpreadEvenly] = useState(settings.spreadEvenly);
  const [percent, setPercent] = useState(String(settings.fluxPercent));
  const [amount, setAmount] = useState(String(settings.fluxAmount));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  function save() {
    setError(null);
    setSaved(null);
    startTransition(async () => {
      const result = await saveCloseSettings({ autoPost, spreadEvenly, fluxPercent: Number(percent), fluxAmount: Number(amount) });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved("Saved.");
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="text-sm font-medium text-text">Automatic posting</CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-start gap-2.5 text-sm text-text">
            <input type="checkbox" className="mt-1" checked={autoPost} onChange={(e) => setAutoPost(e.target.checked)} />
            <span>
              Post recognition and schedules automatically
              <span className="mt-1 block text-muted">
                Each night, once a month has ended, its revenue recognition and its prepaid and accrual months are posted —
                by this workspace&apos;s <span className="text-text">Automation</span> account. It is a hidden account that
                can&apos;t sign in, isn&apos;t a seat and isn&apos;t listed anywhere; entries it makes show{" "}
                <span className="text-text">“Posted automatically”</span> in the journal, and the checklist&apos;s checks it
                ticks show “Checked automatically”.
              </span>
              <span className="mt-1 block text-subtle">
                Off: nothing posts until somebody presses “Recognise through…” on the Revenue page or “Post through…” on
                Prepaids &amp; accruals. The checklist still runs and says what is left.
              </span>
            </span>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Spreading revenue</CardHeader>
        <CardContent>
          <fieldset className="space-y-2">
            <legend className="text-sm text-muted">How a new revenue schedule spreads its amount across its months. Existing schedules keep theirs.</legend>
            <label className="flex items-start gap-2.5 text-sm text-text">
              <input type="radio" name="close-spread" className="mt-1" checked={!spreadEvenly} onChange={() => setSpreadEvenly(false)} />
              <span>
                By day (exact)
                <span className="block text-muted">
                  Each month earns its share of the days: a year from 1 January puts 31/365 in January and 28/365 in February.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2.5 text-sm text-text">
              <input type="radio" name="close-spread" className="mt-1" checked={spreadEvenly} onChange={() => setSpreadEvenly(true)} />
              <span>
                Evenly by month
                <span className="block text-muted">Every month the same amount, whatever its length; the last takes the rounding.</span>
              </span>
            </label>
          </fieldset>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Flux thresholds</CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted">
            On the close page&apos;s Flux tab, an account is flagged when its change against last month is at least this
            percentage <span className="text-text">and</span> at least this amount — both, so a ₹200 account doubling isn&apos;t
            flagged, and neither is a 2% move on a crore. Every flagged account needs an explanation before the month&apos;s
            “changes explained” task passes.
          </p>
          <div className="flex flex-wrap gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="close-flux-percent">Percentage change</Label>
              <Input id="close-flux-percent" type="number" inputMode="decimal" min={0} max={9999} step="0.01" value={percent} onChange={(e) => setPercent(e.target.value)} className="w-36" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="close-flux-amount">Amount (₹)</Label>
              <Input id="close-flux-amount" type="number" inputMode="decimal" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-44" />
            </div>
          </div>
          {Number.isFinite(Number(percent)) && Number.isFinite(Number(amount)) && (
            <p className="text-xs text-subtle">
              Flagged when an account moves by at least {Number(percent).toLocaleString("en-IN")}% and {rupeesShort(Number(amount))}.
            </p>
          )}
        </CardContent>
      </Card>

      {error && <Card className="border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">{error}</Card>}
      {saved && <Card className="border-success/40 bg-success-bg px-4 py-3 text-sm text-success">{saved}</Card>}
      <Button disabled={pending} onClick={save}>
        {pending ? "Saving…" : "Save settings"}
      </Button>
    </div>
  );
}
