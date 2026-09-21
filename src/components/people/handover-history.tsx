import Link from "next/link";
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import type { HandoverEntry } from "@/actions/handover";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";

/**
 * What has been handed over, on the record of whoever it concerns.
 *
 * Both directions in one list. "Where did these forty accounts come from" is asked far more often
 * than "where did his go", and until this existed only the audit log could answer either — in a
 * sentence, without naming who actually received what.
 */
export function HandoverHistory({
  entries,
  personId,
  personName,
  canHandOver,
}: {
  entries: HandoverEntry[];
  personId: string;
  personName: string;
  canHandOver: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
        Handovers
        {canHandOver && (
          <Link href={`/people/${personId}/handover`} className="text-xs font-normal text-brand hover:underline">
            Hand over work
          </Link>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {entries.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing has been handed to or from {personName}.
          </p>
        ) : (
          entries.map((entry) => (
            <div key={`${entry.direction}-${entry.id}`} className="border-b border-line pb-4 last:border-0 last:pb-0">
              <div className="flex flex-wrap items-baseline gap-2">
                {entry.direction === "given" ? (
                  <ArrowUpRight className="h-3.5 w-3.5 shrink-0 translate-y-0.5 text-warning" />
                ) : (
                  <ArrowDownLeft className="h-3.5 w-3.5 shrink-0 translate-y-0.5 text-success" />
                )}
                <span className="text-sm text-text">
                  {entry.direction === "given"
                    ? `${entry.total} item${entry.total === 1 ? "" : "s"} handed over`
                    : `${entry.total} item${entry.total === 1 ? "" : "s"} taken over from ${entry.counterpartName}`}
                </span>
                <span className="text-xs text-subtle">
                  {formatDate(entry.at)} · by {entry.performedByName}
                </span>
              </div>

              {entry.reason && <p className="mt-1 pl-5 text-xs text-muted">{entry.reason}</p>}

              <div className="mt-2 space-y-1 pl-5">
                {groupByArea(entry.lines).map((area) => (
                  <div key={area.label} className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                    <span className="text-muted">{area.label}</span>
                    <span className="text-text">
                      {/* On the receiver's own record every line names them, which reads as noise. */}
                      {entry.direction === "given"
                        ? area.parts.map((part) => `${part.personName} · ${part.count}`).join(", ")
                        : area.total}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

/**
 * One row per area, however many people it was split between.
 *
 * A splittable area produces one line per successor, so a leaver whose stored logins went to two
 * people showed "Stored logins they own" twice in a row with a different name beside each — which
 * reads as a duplicate rather than as a split. Grouped, the split becomes the point of the line
 * rather than an accident of how it happens to be stored.
 *
 * Insertion order is kept, so the areas stay in the order the handover screen offered them rather
 * than being re-sorted into something nobody chose.
 */
function groupByArea(lines: HandoverEntry["lines"]) {
  const byLabel = new Map<string, { label: string; parts: HandoverEntry["lines"]; total: number }>();
  for (const line of lines) {
    const group = byLabel.get(line.areaLabel) ?? { label: line.areaLabel, parts: [], total: 0 };
    group.parts.push(line);
    group.total += line.count;
    byLabel.set(line.areaLabel, group);
  }
  return [...byLabel.values()];
}
