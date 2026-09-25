"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveStageWeight } from "@/actions/forecast";
import type { StageWeight } from "@/lib/forecast/stages";
import { MIN_SAMPLE } from "@/lib/forecast/stages";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

/**
 * How much a deal at each stage counts, and why: what the history says, how many closed deals that
 * rests on, and — for somebody allowed — an override. Clearing an override goes back to the history.
 */
export function StageWeights({ weights, canManage }: { weights: StageWeight[]; canManage: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const save = (stage: string, value: number | null) => {
    setNotice(null);
    startTransition(async () => {
      const result = await saveStageWeight(stage, value);
      if (!result.ok) setNotice({ tone: "error", text: result.error });
      else {
        setDrafts((d) => ({ ...d, [stage]: "" }));
        setNotice({ tone: "success", text: value === null ? "Back to what the history says." : "Saved." });
        router.refresh();
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-text">How deals are weighted</h2>
        <p className="text-xs text-subtle">
          Each stage counts at the share of deals that got that far and were then won, over the last twelve months. Fewer than{" "}
          {MIN_SAMPLE} closed deals behind a stage and it uses a standard figure until there are more. A later stage never counts
          for less than an earlier one.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="py-1.5 font-medium">Stage</th>
              <th className="py-1.5 text-right font-medium">Counts at</th>
              <th className="py-1.5 text-right font-medium">History says</th>
              {canManage && <th className="py-1.5 text-right font-medium">Override</th>}
            </tr>
          </thead>
          <tbody>
            {weights.map((w) => (
              <tr key={w.stage} className="border-b border-line last:border-0">
                <td className="py-1.5 text-text">{w.label}</td>
                <td className="py-1.5 text-right">
                  <span className="font-semibold tabular-nums text-text">{w.percent}%</span>{" "}
                  <Badge tone={w.source === "override" ? "amber" : w.source === "learned" ? "green" : "default"}>
                    {w.source === "override" ? "override" : w.source === "learned" ? "learned" : "standard"}
                  </Badge>
                </td>
                <td className="py-1.5 text-right text-xs text-muted">
                  {w.learned !== null ? `${w.learned}% of ${w.sample}` : `${w.sample} closed — not enough yet`}
                </td>
                {canManage && (
                  <td className="py-1.5 text-right">
                    <div className="inline-flex items-center gap-1.5">
                      <Input
                        aria-label={`Override for ${w.label}`}
                        className="h-8 w-16 text-right"
                        inputMode="numeric"
                        placeholder={w.source === "override" ? String(w.percent) : "—"}
                        value={drafts[w.stage] ?? ""}
                        onChange={(e) => setDrafts((d) => ({ ...d, [w.stage]: e.target.value.replace(/[^0-9]/g, "") }))}
                      />
                      <button
                        type="button"
                        disabled={pending || !drafts[w.stage]}
                        onClick={() => save(w.stage, Number(drafts[w.stage]))}
                        className="rounded-full border border-line px-2 py-0.5 text-[11px] font-medium text-text hover:bg-surface-sunken disabled:opacity-40"
                      >
                        Set
                      </button>
                      {w.source === "override" && (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => save(w.stage, null)}
                          className="rounded-full border border-line px-2 py-0.5 text-[11px] font-medium text-muted hover:bg-surface-sunken"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
      </CardContent>
    </Card>
  );
}
