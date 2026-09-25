"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveCommit } from "@/actions/forecast";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { formatCurrency } from "@/lib/utils";

type Month = { month: string; commit: number | null; bestCase: number | null; note: string | null; weighted: number; bestCaseSystem: number };
export type CommitRow = { person: { id: string; name: string }; months: Month[] };

/**
 * Your own call for the next three months, beside what your deals say. The system number is there
 * to argue with, not to copy: a salesperson knows that a deal marked "Negotiation" went quiet last
 * week, and the commit is where that knowledge goes.
 */
export function CommitsPanel({ labels, mine, team }: { labels: Record<string, string>; mine: CommitRow; team: CommitRow[] }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-text">Your commit</h2>
          <p className="text-xs text-subtle">
            What you&apos;ll close, and what you could if things go your way. Before GST, like the order value target. A month
            that has ended keeps the number it had.
          </p>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {mine.months.map((m) => (
            <MonthForm key={m.month} label={labels[m.month] ?? m.month} month={m} />
          ))}
        </CardContent>
      </Card>

      {team.length > 0 && (
        <Card className="overflow-x-auto">
          <CardHeader>
            <h2 className="text-sm font-semibold text-text">Your team</h2>
          </CardHeader>
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-4 py-2 font-medium">Person</th>
                {mine.months.map((m) => (
                  <th key={m.month} className="px-3 py-2 text-right font-medium">
                    {labels[m.month] ?? m.month}
                    <div className="font-normal text-subtle">commit · deals say</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {team.map((row) => (
                <tr key={row.person.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2 text-text">{row.person.name}</td>
                  {row.months.map((m) => (
                    <td key={m.month} className="px-3 py-2 text-right tabular-nums" title={m.note ?? undefined}>
                      <span className={m.commit === null ? "text-subtle" : "text-text"}>{m.commit === null ? "no call" : formatCurrency(m.commit)}</span>
                      <div className="text-xs text-muted">{formatCurrency(m.weighted)}</div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function MonthForm({ label, month }: { label: string; month: Month }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [commit, setCommit] = useState(month.commit === null ? "" : String(month.commit));
  const [bestCase, setBestCase] = useState(month.bestCase === null ? "" : String(month.bestCase));
  const [note, setNote] = useState(month.note ?? "");
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const id = `commit-${month.month}`;

  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-text">{label}</span>
        <span className="text-[11px] text-subtle">deals say {formatCurrency(month.weighted)}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label htmlFor={`${id}-c`} className="text-[11px] font-medium text-muted">
            Commit
          </label>
          <Input id={`${id}-c`} inputMode="numeric" value={commit} onChange={(e) => setCommit(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0" />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-b`} className="text-[11px] font-medium text-muted">
            Best case
          </label>
          <Input id={`${id}-b`} inputMode="numeric" value={bestCase} onChange={(e) => setBestCase(e.target.value.replace(/[^0-9.]/g, ""))} placeholder={String(Math.round(month.bestCaseSystem))} />
        </div>
      </div>
      <Input aria-label={`Note for ${label}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What it depends on (optional)" />
      {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
      <Button
        size="sm"
        className="w-full"
        disabled={pending || commit === ""}
        onClick={() => {
          setNotice(null);
          startTransition(async () => {
            const result = await saveCommit({ month: month.month, commit: Number(commit), bestCase: bestCase === "" ? null : Number(bestCase), note });
            if (!result.ok) setNotice({ tone: "error", text: result.error });
            else {
              setNotice({ tone: "success", text: "Saved." });
              router.refresh();
            }
          });
        }}
      >
        {pending ? "Saving…" : month.commit === null ? "Commit" : "Update"}
      </Button>
    </div>
  );
}
