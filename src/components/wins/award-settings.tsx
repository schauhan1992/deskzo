"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AwardAudience } from "@prisma/client";
import { saveActivityAwardSettings } from "@/actions/activity-awards";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/bulk-select";
import { Input } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

export type AwardSettingsValue = { enabled: boolean; audience: AwardAudience; topCount: number; splash: boolean };

const AUDIENCES: { value: AwardAudience; label: string; hint: string }[] = [
  {
    value: "EVERYONE",
    label: "Everybody",
    hint: "A notification to all staff naming the winners, a personal note to each winner, and the splash for the whole company.",
  },
  {
    value: "MANAGERS",
    label: "Managers only",
    hint: "The ranking goes to the people who can see team performance. Nobody else — the winners included — is told.",
  },
  {
    value: "WINNERS",
    label: "Only the winners",
    hint: "A personal congratulation to each winner, and a splash only they see. Nothing company-wide.",
  },
];

/** Whether the fortnightly awards run, and who hears about them. */
export function AwardSettings({ initial }: { initial: AwardSettingsValue }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [s, setS] = useState(initial);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const set = <K extends keyof AwardSettingsValue>(key: K, value: AwardSettingsValue[K]) => setS((v) => ({ ...v, [key]: value }));

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-text">Settings</h2>
        <p className="text-xs text-subtle">A change applies from the next announcement. Past fortnights stay visible only to whoever they were announced to.</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex cursor-pointer items-start gap-2">
          <Checkbox checked={s.enabled} onChange={(e) => set("enabled", e.target.checked)} className="mt-0.5" />
          <span>
            <span className="block text-sm font-medium text-text">Announce the most active every fortnight</span>
            <span className="block text-xs text-subtle">On the 1st and the 16th, from 9 am, about the fortnight just finished.</span>
          </span>
        </label>

        {s.enabled && (
          <>
            <fieldset>
              <legend className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">Who hears about it</legend>
              <div className="space-y-2">
                {AUDIENCES.map((a) => (
                  <label key={a.value} className="flex cursor-pointer items-start gap-2">
                    <input
                      type="radio"
                      name="award-audience"
                      className="mt-1 h-4 w-4 accent-[var(--brand)]"
                      checked={s.audience === a.value}
                      onChange={() => set("audience", a.value)}
                    />
                    <span>
                      <span className="block text-sm text-text">{a.label}</span>
                      <span className="block text-xs text-subtle">{a.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-text">Name the top</span>
              <Input
                aria-label="How many to name overall"
                className="h-8 w-14"
                inputMode="numeric"
                value={String(s.topCount)}
                onChange={(e) => set("topCount", Number(e.target.value.replace(/[^0-9]/g, "")) || 1)}
              />
              <span className="text-xs text-subtle">overall, plus the leader in sales and in support.</span>
            </div>

            {s.audience !== "MANAGERS" && (
              <label className="flex cursor-pointer items-start gap-2">
                <Checkbox checked={s.splash} onChange={(e) => set("splash", e.target.checked)} className="mt-0.5" />
                <span>
                  <span className="block text-sm text-text">Full-screen splash with confetti</span>
                  <span className="block text-xs text-subtle">
                    {s.audience === "EVERYONE" ? "For everybody, for two days." : "For each winner, for two days — nobody else sees it."}
                  </span>
                </span>
              </label>
            )}
          </>
        )}

        {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await saveActivityAwardSettings(s);
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
