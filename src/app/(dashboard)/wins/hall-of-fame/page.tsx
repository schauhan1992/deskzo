import { Gift, Medal } from "lucide-react";
import { getHallOfFame, type HallOfFameRow } from "@/actions/prizes";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { HandoverToggle } from "@/components/wins/handover-toggle";
import { inrSpoken } from "@/lib/wins/copy";
import { RACE_LABEL } from "@/lib/wins/prizes";
import { workspaceClock } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";

export const metadata = { title: "Hall of fame" };

const MEDAL: Record<string, string> = { "1": "#f59e0b", "2": "#94a3b8", "3": "#b45309" };

function score(r: HallOfFameRow): string {
  return r.race === "TOP_SELLERS" ? `${inrSpoken(r.score)} booked` : `${Math.round(r.score)} points`;
}

function Winner({ row, canManage, clock }: { row: HallOfFameRow; canManage: boolean; clock: Clock }) {
  return (
    <li className="flex flex-wrap items-center gap-3 py-2.5">
      <Medal className="h-4 w-4 shrink-0 text-subtle" style={MEDAL[row.slot] ? { color: MEDAL[row.slot] } : undefined} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-sm">
          <span className="font-medium text-text">{row.name}</span>
          {row.isYou && <span className="ml-1.5 text-xs text-muted">you</span>}
          <span className="ml-2 text-xs text-subtle">
            {row.slotLabel} · {score(row)}
          </span>
        </div>
        {row.prizeName && (
          <div className="mt-1 flex items-center gap-2">
            {row.prizeImage ? (
              // eslint-disable-next-line @next/next/no-img-element -- a data URL, kept as it was on the day
              <img src={row.prizeImage} alt="" className="h-9 w-12 rounded object-cover" />
            ) : (
              <Gift className="h-4 w-4 text-brand" aria-hidden />
            )}
            <span className="text-sm text-text">{row.prizeName}</span>
            {row.prizeNote && <span className="text-xs text-subtle">— {row.prizeNote}</span>}
          </div>
        )}
      </div>
      {row.prizeName &&
        (canManage ? (
          <HandoverToggle id={row.id} handedOverAt={row.handedOverAt} />
        ) : row.handedOverAt ? (
          <Badge tone="green">Handed over {clock.dayMonth(row.handedOverAt)}</Badge>
        ) : (
          <Badge tone="amber">On its way</Badge>
        ))}
    </li>
  );
}

/**
 * Everybody who has won, and what they won — the prize as it was on the day, with whether it has been
 * handed over yet.
 */
export default async function HallOfFamePage() {
  const hall = await getHallOfFame();
  if (!hall) return <ModuleDisabledNotice moduleKey="wins" />;
  const clock = await workspaceClock();

  // One card per result, newest first — the rows already come in that order.
  const groups: { key: string; title: string; rows: HallOfFameRow[] }[] = [];
  for (const row of hall.rows) {
    const key = `${row.race}:${row.period}`;
    const group = groups.find((g) => g.key === key);
    if (group) group.rows.push(row);
    else groups.push({ key, title: `${RACE_LABEL[row.race]} — ${row.periodLabel}`, rows: [row] });
  }
  const waiting = hall.canManage ? hall.rows.filter((r) => r.prizeName && !r.handedOverAt).length : 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Hall of fame</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Every month&apos;s top sellers and every fortnight&apos;s most active, with what they won.
          {hall.canManage && waiting > 0 && ` ${waiting} prize${waiting === 1 ? " is" : "s are"} still to be handed over.`}
        </p>
      </div>
      {groups.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-subtle">
            Nobody yet — the first names go up when this month&apos;s top sellers or this fortnight&apos;s most active are announced.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {groups.map((g) => (
            <Card key={g.key}>
              <CardHeader>
                <h2 className="text-sm font-semibold text-text">{g.title}</h2>
              </CardHeader>
              <CardContent>
                <ul className="divide-y divide-line">
                  {g.rows.map((r) => (
                    <Winner key={r.id} row={r} canManage={hall.canManage} clock={clock} />
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
