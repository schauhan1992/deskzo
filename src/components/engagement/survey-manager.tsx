"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EyeOff, Lock, Plus, Trash2 } from "lucide-react";
import type { SurveyAudience, SurveyKind, SurveyStatus } from "@prisma/client";
import { deleteSurvey, setSurveyStatus, surveyResults, type SurveyResults } from "@/actions/survey";
import { audienceLabels, surveyKindLabels, surveyStatusLabels } from "@/lib/engagement/anonymity";
import { SurveyBuilder } from "@/components/engagement/survey-builder";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { IconButton } from "@/components/ui/icon-button";
import { formatDate } from "@/lib/utils";

type Row = {
  id: string;
  kind: SurveyKind;
  title: string;
  anonymous: boolean;
  mandatory: boolean;
  audience: SurveyAudience;
  status: SurveyStatus;
  expiresAt: string | Date | null;
  createdBy: { name: string };
  _count: { questions: number; responses: number; participations: number };
};

export function SurveyManager({
  rows,
  options,
}: {
  rows: Row[];
  options: { users: { id: string; name: string }[]; departments: { id: string; name: string }[] };
}) {
  const router = useRouter();
  const [building, setBuilding] = useState(false);
  const [results, setResults] = useState<SurveyResults | null>(null);

  return (
    <div className="space-y-4">
      {!building && (
        <div className="flex justify-end">
          <Button onClick={() => setBuilding(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            New form
          </Button>
        </div>
      )}

      {building && <SurveyBuilder options={options} onSaved={() => setBuilding(false)} />}

      {rows.map((r) => (
        <Card key={r.id}>
          <CardContent className="space-y-2">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-text">{r.title}</span>
                  <Badge tone="default">{surveyKindLabels[r.kind]}</Badge>
                  {r.anonymous ? (
                    <span className="flex items-center gap-1 text-xs text-success">
                      <Lock className="h-3 w-3" />
                      Anonymous
                    </span>
                  ) : (
                    <span className="text-xs text-muted">Attributed</span>
                  )}
                  {r.mandatory && <Badge tone="amber">Must fill</Badge>}
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  {audienceLabels[r.audience]} · {r._count.questions} questions · {r._count.responses} answered
                  {r.expiresAt && ` · closes ${formatDate(new Date(r.expiresAt))}`} · by {r.createdBy.name}
                </p>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Select
                  // One of these per card, with nothing visible naming it — so the name has to carry
                  // which form it belongs to, or every row announces the same thing.
                  aria-label={`Status — ${r.title}`}
                  value={r.status}
                  onChange={async (e) => {
                    await setSurveyStatus(r.id, e.target.value as SurveyStatus);
                    router.refresh();
                  }}
                >
                  {(Object.keys(surveyStatusLabels) as SurveyStatus[]).map((s) => (
                    <option key={s} value={s}>{surveyStatusLabels[s]}</option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={async () => setResults(await surveyResults(r.id))}
                >
                  Results
                </Button>
                <IconButton
                  icon={Trash2}
                  label="Delete"
                  tone="danger"
                  onClick={async () => {
                    const result = await deleteSurvey(r.id);
                    if (!result.ok) alert(result.error);
                    router.refresh();
                  }}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      ))}

      {results && <Results results={results} onClose={() => setResults(null)} />}
    </div>
  );
}

/**
 * What the answers add up to.
 *
 * A question under the threshold renders the refusal rather than an empty chart, and says how many
 * more are needed — an absent result with no explanation reads as a bug, and somebody eventually
 * "fixes" it.
 */
function Results({ results, onClose }: { results: SurveyResults; onClose: () => void }) {
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
        <span>{results.title} — results</span>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted">
          {results.responseCount} of {results.invited} answered
          {results.anonymous && " · answers carry no link to anybody"}
        </p>

        {results.outstanding.length > 0 && (
          <p className="text-xs text-subtle">
            Still to answer: {results.outstanding.join(", ")}
          </p>
        )}

        {results.questions.map((q) => {
          // Bound to a const so the narrowing survives into the nested callbacks below —
          // `q.result` is a property access, and TypeScript widens it again inside a closure.
          const r = q.result;
          return (
          <div key={q.id} className="space-y-2 border-t border-line pt-3">
            <div className="text-sm text-text">{q.prompt}</div>

            {r.kind === "hidden" && (
              <div className="flex items-start gap-2 rounded-base bg-surface-sunken p-3 text-xs text-muted">
                <EyeOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <p>
                  Hidden until {r.needed} more {r.needed === 1 ? "person answers" : "people answer"}.
                  With this few replies, a result and a headcount together would name people.
                </p>
              </div>
            )}

            {r.kind === "numeric" && (
              <div className="space-y-1">
                <div className="text-lg font-semibold text-text">{r.average}</div>
                <div className="space-y-0.5">
                  {r.distribution.map((d) => (
                    <div key={d.value} className="flex items-center gap-2 text-xs">
                      <span className="w-6 text-subtle">{d.value}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                        <div
                          className="h-full rounded-full bg-brand"
                          style={{ width: `${(d.count / r.count) * 100}%` }}
                        />
                      </div>
                      <span className="w-6 text-right text-muted">{d.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {r.kind === "choice" && (
              <div className="space-y-0.5">
                {r.options.map((o) => (
                  <div key={o.option} className="flex items-center gap-2 text-xs">
                    <span className="w-32 truncate text-muted">{o.option}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                      <div className="h-full rounded-full bg-brand" style={{ width: `${o.percent}%` }} />
                    </div>
                    <span className="w-12 text-right text-muted">{o.percent}%</span>
                  </div>
                ))}
              </div>
            )}

            {r.kind === "text" && (
              <ul className="space-y-1.5">
                {r.answers.map((a, i) => (
                  <li key={i} className="rounded-base bg-surface-sunken px-3 py-2 text-xs text-text">
                    {a}
                  </li>
                ))}
              </ul>
            )}
          </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
