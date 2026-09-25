import Link from "next/link";
import { ArrowLeft, Headset, Medal, TrendingUp, Trophy } from "lucide-react";
import { getActivityAwards, type AwardView } from "@/actions/activity-awards";
import { ACTIVE_HOURS_CAP, POINTS, type ActivityCounts, type AwardEntry, type Standing } from "@/lib/performance/awards";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { getPrizeShowcase } from "@/actions/prizes";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { PrizeShowcase } from "@/components/wins/prize-showcase";

export const metadata = { title: "Most active" };

const AUDIENCE_WORDS = { EVERYONE: "Told to everybody", MANAGERS: "Told to managers", WINNERS: "Told to the winners" } as const;

function breakdown(c: ActivityCounts): string {
  const hours = Math.floor(c.activeSeconds / 3600);
  return [
    c.created ? `${c.created} created` : null,
    c.edited ? `${c.edited} edited` : null,
    c.calls ? `${c.calls} call${c.calls === 1 ? "" : "s"}` : null,
    c.visits ? `${c.visits} visit${c.visits === 1 ? "" : "s"}` : null,
    c.ticketsResolved ? `${c.ticketsResolved} ticket${c.ticketsResolved === 1 ? "" : "s"} (${c.ticketsInSla} in SLA)` : null,
    c.dealsWon ? `${c.dealsWon} deal${c.dealsWon === 1 ? "" : "s"} won` : null,
    hours ? `${hours}h active` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Gold, silver, bronze — the same as the wins leaderboard. */
const MEDAL = ["#f59e0b", "#94a3b8", "#b45309"];

function Standings({ rows }: { rows: Standing[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="py-2 pr-3">#</th>
            <th className="py-2 pr-3">Person</th>
            <th className="py-2 pr-3 text-right">Points</th>
            <th className="py-2 pr-3 text-right">Sales</th>
            <th className="py-2 pr-3 text-right">Support</th>
            <th className="py-2">What for</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.userId} className="border-b border-line last:border-0">
              <td className="py-2 pr-3 text-muted">{i + 1}</td>
              <td className="py-2 pr-3 font-medium text-text">{r.name}</td>
              <td className="py-2 pr-3 text-right font-semibold tabular-nums text-text">{r.points}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-muted">{r.sales || "—"}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-muted">{r.support || "—"}</td>
              <td className="py-2 text-xs text-subtle">{breakdown(r.counts)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AreaLeader({ label, entry, area, Icon }: { label: string; entry: AwardEntry | null; area: "sales" | "support"; Icon: typeof TrendingUp }) {
  if (!entry) return null;
  return (
    <div className="flex items-center gap-2 text-sm">
      <Icon className="h-4 w-4 text-brand" aria-hidden />
      <span className="text-muted">{label}:</span>
      <span className="font-medium text-text">{entry.name}</span>
      <span className="text-xs text-subtle">{entry[area]} points</span>
    </div>
  );
}

function PastAward({ award }: { award: AwardView }) {
  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-text">{award.label}</h3>
          <div className="flex items-center gap-2">
            {award.mine && <Badge tone="green">You were named</Badge>}
            {award.ranking && <Badge>{AUDIENCE_WORDS[award.audience]}</Badge>}
          </div>
        </div>
        {award.winners.length === 0 && !award.sales && !award.support ? (
          <p className="text-sm text-subtle">Nobody had any work recorded that fortnight.</p>
        ) : (
          <>
            <ol className="space-y-1.5">
              {award.winners.map((w, i) => (
                <li key={w.userId} className="flex items-center gap-2 text-sm">
                  <Medal className="h-4 w-4 text-muted" style={MEDAL[i] ? { color: MEDAL[i] } : undefined} aria-hidden />
                  <span className="font-medium text-text">{w.name}</span>
                  <span className="text-xs text-subtle">{w.points} points</span>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <AreaLeader label="Sales" entry={award.sales} area="sales" Icon={TrendingUp} />
              <AreaLeader label="Support" entry={award.support} area="support" Icon={Headset} />
            </div>
          </>
        )}
        {award.ranking && award.ranking.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-xs text-muted">The full ranking</summary>
            <div className="mt-2">
              <Standings rows={award.ranking} />
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

export default async function MostActivePage() {
  const [awards, showcase] = await Promise.all([getActivityAwards(), getPrizeShowcase()]);
  if (!awards) return <ModuleDisabledNotice moduleKey="wins" />;
  const { canSeeStandings, settings, current, history } = awards;

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        {canSeeStandings && (
          <Link href="/performance" className="mb-2 inline-flex items-center gap-1 text-xs text-muted hover:text-text">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Performance
          </Link>
        )}
        <h1 className="flex items-center gap-2 text-xl font-semibold text-text">
          <Trophy className="h-5 w-5" style={{ color: MEDAL[0] }} aria-hidden /> Most active of the fortnight
        </h1>
        <p className="mt-1 text-sm text-muted">
          Every fortnight — the 1st to the 15th, and the 16th to the month&apos;s end — the people who got the most done, overall and in
          sales and support. Counted from work anybody could check: records, calls, visits, tickets and deals.
          {!settings.enabled && " The awards are switched off at the moment."}
        </p>
      </div>

      <PrizeShowcase races={showcase.filter((r) => r.race === "MOST_ACTIVE")} />

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-text">This fortnight — {current.label}</h2>
          <p className="text-xs text-subtle">
            {settings.enabled ? `Announced ${current.announcesOn}.` : "Not announced while the awards are switched off."} The tally
            moves as work is recorded.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border border-line bg-surface-sunken px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-muted">Your points so far</div>
            <div className="mt-0.5 text-2xl font-semibold tabular-nums text-text">{current.mine?.points ?? 0}</div>
            <div className="text-xs text-subtle">{current.mine ? breakdown(current.mine.counts) : "Nothing recorded yet this fortnight."}</div>
          </div>
          {current.standings &&
            (current.standings.length ? <Standings rows={current.standings} /> : <p className="text-sm text-subtle">Nobody has any work recorded yet.</p>)}
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-text">Past fortnights</h2>
          <Link href="/wins/hall-of-fame" className="text-xs text-brand hover:underline">
            What they won — the hall of fame
          </Link>
        </div>
        {history.length === 0 ? (
          <p className="text-sm text-subtle">None announced{canSeeStandings ? " yet" : " to you yet"}.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {history.map((a) => (
              <PastAward key={a.period} award={a} />
            ))}
          </div>
        )}
      </section>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-text">How the points work</h2>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-x-8 gap-y-1 text-sm text-muted sm:grid-cols-2">
            <li>A deal won (to its owner) — {POINTS.dealWon}</li>
            <li>A visit completed — {POINTS.visit}</li>
            <li>A ticket resolved — {POINTS.ticketResolved}, and {POINTS.ticketInSla} more inside its SLA</li>
            <li>A call logged — {POINTS.call}</li>
            <li>A record created — {POINTS.recordCreated}</li>
            <li>A record edited — {POINTS.recordEdited}, once per record per day</li>
            <li>
              Each hour active in the app — {POINTS.activeHour}, up to {ACTIVE_HOURS_CAP} a fortnight
            </li>
          </ul>
          <p className="mt-3 text-xs text-subtle">
            Time counts for little — at most {ACTIVE_HOURS_CAP} points, less than one deal — so it separates people who did the same work
            and nothing more. Nobody with no work recorded is ranked, and changes an admin makes while viewing as somebody count for nobody.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
