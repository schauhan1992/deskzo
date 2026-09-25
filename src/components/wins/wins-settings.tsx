"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { SplashScope, TargetMetric } from "@prisma/client";
import { runWinsDetection, saveWinsSettings } from "@/actions/wins";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/bulk-select";
import { Input, Select } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

export type WinsSettingsValue = {
  dealWon: boolean;
  dealWonMinimum: number;
  dealWonSplash: SplashScope;
  targetHit: boolean;
  targetHitSplash: SplashScope;
  targetMetrics: TargetMetric[];
  firstOrder: boolean;
  firstOrderSplash: SplashScope;
  topPerformer: boolean;
  topPerformerSplash: SplashScope;
  topPerformerCount: number;
  showAmounts: boolean;
};

/**
 * Which wins celebrate themselves, and how loudly. "Everybody" is the full-screen splash for the
 * whole company; "the winner" is the splash for them and a line in everybody else's greeting strip.
 */
export function WinsSettings({ initial, metrics }: { initial: WinsSettingsValue; metrics: { key: TargetMetric; label: string }[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [s, setS] = useState(initial);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const set = <K extends keyof WinsSettingsValue>(key: K, value: WinsSettingsValue[K]) => setS((v) => ({ ...v, [key]: value }));

  const loud = (key: "dealWonSplash" | "targetHitSplash" | "firstOrderSplash" | "topPerformerSplash", label: string) => (
    <Select aria-label={`Who gets the splash — ${label}`} className="h-8 w-auto" value={s[key]} onChange={(e) => set(key, e.target.value as SplashScope)}>
      <option value="EVERYONE">Splash for everybody</option>
      <option value="SUBJECT">Splash for the winner, strip for everybody else</option>
    </Select>
  );

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-text">What gets celebrated</h2>
        <p className="text-xs text-subtle">Each win is celebrated once, for two days (three for the top performer), and never for anything older than two days when it is switched on.</p>
      </CardHeader>
      <CardContent>
        <Row on={s.dealWon} onChange={(v) => set("dealWon", v)} label="A big deal won" hint="When a lead is marked Won, valued at its latest proposal (or its estimate), before GST.">
          <span className="text-xs text-muted">worth at least ₹</span>
          <Input aria-label="Smallest deal to celebrate" className="h-8 w-28" inputMode="numeric" value={String(s.dealWonMinimum)} onChange={(e) => set("dealWonMinimum", Number(e.target.value.replace(/[^0-9]/g, "")) || 0)} />
          {loud("dealWonSplash", "deal won")}
        </Row>
        <Row on={s.targetHit} onChange={(v) => set("targetHit", v)} label="A target reached" hint="Measured exactly as the targets screen measures it — a person's, a team's or the company's.">
          {loud("targetHitSplash", "target reached")}
        </Row>
        {s.targetHit && (
          <div className="-mt-1 mb-2 flex flex-wrap gap-x-4 gap-y-1 pl-6">
            <span className="w-full text-[11px] text-subtle">Which targets — none ticked means every one</span>
            {metrics.map((m) => (
              <label key={m.key} className="flex cursor-pointer items-center gap-1.5 text-xs text-text">
                <Checkbox
                  checked={s.targetMetrics.includes(m.key)}
                  onChange={(e) => set("targetMetrics", e.target.checked ? [...s.targetMetrics, m.key] : s.targetMetrics.filter((k) => k !== m.key))}
                />
                {m.label}
              </label>
            ))}
          </div>
        )}
        <Row on={s.firstOrder} onChange={(v) => set("firstOrder", v)} label="A new customer's first order" hint="The first order a company has ever had booked.">
          {loud("firstOrderSplash", "first order")}
        </Row>
        <Row on={s.topPerformer} onChange={(v) => set("topPerformer", v)} label="Top performer of the month" hint="Announced in the first week of each month, by order value booked the month before.">
          <span className="text-xs text-muted">name the top</span>
          <Input aria-label="How many to name" className="h-8 w-14" inputMode="numeric" value={String(s.topPerformerCount)} onChange={(e) => set("topPerformerCount", Number(e.target.value.replace(/[^0-9]/g, "")) || 1)} />
          {loud("topPerformerSplash", "top performer")}
        </Row>
        <div className="flex items-center gap-2 pt-3">
          <Checkbox id="wins-amounts" checked={s.showAmounts} onChange={(e) => set("showAmounts", e.target.checked)} />
          <label htmlFor="wins-amounts" className="cursor-pointer text-sm text-text">
            Show rupee amounts on the wall and the TV
            <span className="block text-xs text-subtle">Off shows ranks and progress to target only.</span>
          </label>
        </div>
        {notice && <ActionNotice tone={notice.tone} className="mt-3">{notice.text}</ActionNotice>}
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await runWinsDetection();
                setNotice(result.ok ? { tone: "success", text: result.data.created ? `${result.data.created} new win${result.data.created === 1 ? "" : "s"} celebrated.` : "Nothing new to celebrate right now." } : { tone: "error", text: result.error });
                router.refresh();
              })
            }
          >
            Look for wins now
          </Button>
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await saveWinsSettings(s);
                setNotice(result.ok ? { tone: "success", text: "Saved." } : { tone: "error", text: result.error });
                if (result.ok) router.refresh();
              })
            }
          >
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Row({ on, onChange, label, hint, children }: { on: boolean; onChange: (v: boolean) => void; label: string; hint: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line py-3 last:border-0">
      <label className="flex min-w-0 cursor-pointer items-start gap-2">
        <Checkbox checked={on} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
        <span>
          <span className="block text-sm font-medium text-text">{label}</span>
          <span className="block text-xs text-subtle">{hint}</span>
        </span>
      </label>
      {on && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}
