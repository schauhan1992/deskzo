import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { GRADE_LABELS, gradeFor, type LeadScore } from "@/lib/leads/score";

const TONE = { HOT: "red", WARM: "amber", COLD: "blue", CLOSED: "default" } as const;

/** "72 · Hot" — for the list and the lead's header. Closed leads show nothing: they have no score. */
export function LeadScoreBadge({ score }: { score: number | null | undefined }) {
  if (score === null || score === undefined) return null;
  const grade = gradeFor(score);
  return (
    <Badge tone={TONE[grade]} title={`Lead score ${score} of 100 — ${GRADE_LABELS[grade]}`}>
      {score} · {GRADE_LABELS[grade]}
    </Badge>
  );
}

/**
 * The score with every point it is made of.
 *
 * The breakdown is the point of it: a salesperson who can see "Gone quiet: 34 days −10" knows what
 * to do next, where "41" alone tells them nothing.
 */
export function LeadScoreCard({ result }: { result: LeadScore }) {
  if (result.score === null) return null;
  const gains = result.factors.filter((f) => f.points > 0);
  const losses = result.factors.filter((f) => f.points < 0);

  return (
    <Card>
      <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
        <span>Lead score</span>
        <LeadScoreBadge score={result.score} />
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="h-2 overflow-hidden rounded-full bg-surface-sunken" aria-hidden>
          <div className={`h-full rounded-full ${result.grade === "HOT" ? "bg-danger" : result.grade === "WARM" ? "bg-warning" : "bg-brand"}`} style={{ width: `${result.score}%` }} />
        </div>
        <ul className="space-y-1">
          {gains.map((f) => (
            <li key={f.label} className="flex justify-between gap-3">
              <span className="text-muted">{f.label}</span>
              <span className="tabular-nums text-success">+{f.points}</span>
            </li>
          ))}
          {losses.map((f) => (
            <li key={f.label} className="flex justify-between gap-3">
              <span className="text-muted">{f.label}</span>
              <span className="tabular-nums text-danger">{f.points}</span>
            </li>
          ))}
        </ul>
        <p className="text-[11px] text-subtle">
          Out of 100: fit, intent, engagement and stage, less anything going cold. 70 and over is hot, under 40 cold.
        </p>
      </CardContent>
    </Card>
  );
}
