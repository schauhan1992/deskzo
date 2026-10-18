"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveCopilotSettings, type DeskzoAiSettings } from "@/actions/copilot";
import { AI_FEATURES, MILLI, creditsText } from "@/lib/ai/catalogue";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { useClock } from "@/components/time/clock-provider";

const CAPS = [10, 25, 50, 100];

/** Settings → Deskzo AI (src/app/(dashboard)/settings/copilot): the workspace's switches, its cap, its credits and who used them. */
export function CopilotSettingsForm({ settings }: { settings: DeskzoAiSettings }) {
  const router = useRouter();
  const clock = useClock();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [drafting, setDrafting] = useState(settings.draftingEnabled);
  const [cap, setCap] = useState(settings.dailyCreditLimit === null ? "" : String(settings.dailyCreditLimit));
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const c = settings.credits;

  function save() {
    setNotice(null);
    startTransition(async () => {
      const r = await saveCopilotSettings({ enabled, draftingEnabled: drafting, dailyCreditLimit: cap.trim() ? Number(cap) : null });
      if (!r.ok) {
        setNotice({ tone: "error", text: r.error });
        return;
      }
      setNotice({ tone: "success", text: "Saved." });
      router.refresh();
    });
  }

  const used = c.allowanceUsed + c.packsUsed;
  const allowanceLeft = c.allowance === null ? null : Math.max(0, c.allowance - c.allowanceUsed);

  return (
    <div className="space-y-4">
      <Card id="credits">
        <CardHeader className="text-sm font-semibold text-text">This month&apos;s credits</CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!c.metered || c.allowance === null ? (
            <p className="text-muted">This workspace has no limit on Deskzo AI.</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Figure label="Left to use" value={creditsText(c.available ?? 0)} strong />
                <Figure label="From the plan, left" value={`${creditsText(allowanceLeft ?? 0)} of ${creditsText(c.allowance)}`} />
                <Figure label="From packs, left" value={creditsText(c.packsRemaining)} />
              </div>
              <p className="text-[12px] text-subtle">
                {creditsText(used)} used so far. The plan&apos;s credits renew on {clock.date(c.renewsAt)}; what isn&apos;t used doesn&apos;t carry over. Packs are used after the
                plan&apos;s credits and last twelve months. When none are left, the copilot and drafting stop until the 1st or until a pack is bought.
              </p>
              {settings.canBuy ? (
                <Link href="/settings/billing#ai-credits" className="inline-block text-[13px] font-medium text-brand hover:underline">
                  Buy a credit pack
                </Link>
              ) : (
                <p className="text-[12px] text-subtle">Whoever manages the plan and billing can buy a credit pack.</p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 pt-4 text-sm">
          <label className="flex items-start gap-2 text-text">
            <input type="checkbox" className="mt-0.5" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>
              <span className="font-medium">The copilot is on</span>
              <span className="text-muted"> — the Copilot button shows in the header for everyone with the “Use the AI copilot” permission</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-text">
            <input type="checkbox" className="mt-0.5" checked={drafting} onChange={(e) => setDrafting(e.target.checked)} />
            <span>
              <span className="font-medium">Drafting workflows with AI is on</span>
              <span className="text-muted"> — Automate&apos;s “Draft with AI” turns a description into a draft workflow for somebody to check</span>
            </span>
          </label>

          <div className="space-y-1">
            <Label htmlFor="ai-cap">Daily cap for each person (credits)</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input id="ai-cap" type="number" min={1} step={1} value={cap} onChange={(e) => setCap(e.target.value)} placeholder="No cap" className="w-32" />
              {CAPS.map((n) => (
                <button key={n} type="button" onClick={() => setCap(String(n))} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted hover:bg-surface-sunken">
                  {n}
                </button>
              ))}
              <button type="button" onClick={() => setCap("")} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted hover:bg-surface-sunken">
                No cap
              </button>
            </div>
            <p className="text-[11px] text-subtle">
              Every AI feature together. A copilot question usually takes 2–8 credits. Resets at midnight, {clock.zone.replace(/_/g, " ")} time. Empty: nobody is
              stopped before the workspace&apos;s credits run out.
            </p>
          </div>

          <div className="space-y-2 rounded-base border border-line bg-surface-sunken px-3 py-2 text-[12px] text-muted">
            <p className="font-medium text-text">Where requests go</p>
            {settings.services.map((s) => (
              <p key={s.feature}>
                <span className="text-text">{s.label}:</span>{" "}
                {s.model ? (
                  <>
                    {s.model}, run by Deskzo AI, processed in {s.residency}
                    {s.noTraining ? "; never used to train models" : ""}. {s.sends}
                  </>
                ) : (
                  "not available yet."
                )}
              </p>
            ))}
            <p>The copilot looks up only what the person asking can already see, and never exports, sends or changes anything — tasks and notes are drafted for them to confirm.</p>
          </div>

          {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
          <Button disabled={pending} onClick={save}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </CardContent>
      </Card>

      <Card className="overflow-x-auto p-0">
        <CardHeader className="text-sm font-semibold text-text">Who used credits this month</CardHeader>
        {settings.usage.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted">Nobody has used Deskzo AI this month.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-y border-line text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2">Person</th>
                {AI_FEATURES.map((f) => (
                  <th key={f.key} className="px-4 py-2 text-right">
                    {f.key === "copilot.chat" ? "Copilot" : "Drafting"}
                  </th>
                ))}
                <th className="px-4 py-2 text-right">Today</th>
                <th className="px-4 py-2 text-right">This month</th>
              </tr>
            </thead>
            <tbody>
              {settings.usage.map((u) => (
                <tr key={u.userId} className="border-b border-line last:border-0">
                  <td className="px-4 py-2 text-text">{u.name}</td>
                  {AI_FEATURES.map((f) => (
                    <td key={f.key} className="px-4 py-2 text-right tabular-nums">
                      {creditsText(u.byFeature[f.key] ?? 0)}
                    </td>
                  ))}
                  <td className="px-4 py-2 text-right tabular-nums">{creditsText(u.today)}</td>
                  <td className="px-4 py-2 text-right font-medium tabular-nums">{creditsText(u.month)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="px-4 py-2 text-[11px] text-subtle">In credits{settings.dailyCreditLimit ? `; each person may use up to ${creditsText(settings.dailyCreditLimit * MILLI)} a day` : ""}.</p>
      </Card>
    </div>
  );
}

function Figure({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-base border border-line px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
      <p className={`tabular-nums ${strong ? "text-lg font-semibold text-text" : "text-text"}`}>{value}</p>
    </div>
  );
}
