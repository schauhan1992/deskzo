import Link from "next/link";
import { notFound } from "next/navigation";
import { Globe, Phone } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { can } from "@/lib/authz/resolve";
import { db } from "@/lib/db";
import { REPORT_DAYS, durationText, inboxReport, shareText, type ReportDays } from "@/lib/inbox/report";
import { currentUser } from "@/lib/session";
import { workspaceClock } from "@/lib/time/workspace";
import { cn } from "@/lib/utils";

/**
 * The Customer inbox's response times (src/lib/inbox/report.ts): how quickly customers hear from a person,
 * what the bot handles alone, and — for those who see every conversation — who answered what. `?days=`
 * 7, 30 or 90 (30 by default) and `?channel=`.
 */
export default async function InboxReportsPage({ searchParams }: { searchParams: Promise<{ days?: string; channel?: string }> }) {
  if (!(await isModuleEnabled("inbox"))) return <ModuleDisabledNotice moduleKey="inbox" />;
  const user = await currentUser();
  if (!user) notFound();
  const viewer = { id: user.id, viewAll: await can(user.id, "inbox.viewAll") };
  const sp = await searchParams;
  const days: ReportDays = (REPORT_DAYS as readonly number[]).includes(Number(sp.days)) ? (Number(sp.days) as ReportDays) : 30;
  const channels = await db.inboxChannel.findMany({ select: { id: true, name: true }, orderBy: { createdAt: "asc" } });
  const channelId = channels.some((c) => c.id === sp.channel) ? sp.channel! : null;
  const [report, clock] = await Promise.all([inboxReport(viewer, { days, channelId }), workspaceClock()]);
  const { totals } = report;
  const dayLabel = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: clock.zone });
  const labelOf = (key: string) => dayLabel.format(clock.startOfDay(key) ?? new Date());
  const peak = Math.max(1, ...report.byDay.map((d) => d.started));
  const href = (d: number) => `/inbox/reports?days=${d}${channelId ? `&channel=${channelId}` : ""}`;

  const stat = (label: string, value: string, hint?: string, tone?: "warn") => (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums", tone === "warn" ? "text-danger" : "text-text")}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-subtle">{hint}</p>}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Inbox reports</h1>
          <p className="mt-1 text-sm text-muted">
            How quickly customers hear from a person, from {labelOf(report.from)}.{" "}
            <Link href="/inbox" className="text-brand hover:underline">
              Back to the inbox
            </Link>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <nav aria-label="Period" className="flex gap-1 rounded-base bg-surface-sunken p-1">
            {REPORT_DAYS.map((d) => (
              <Link
                key={d}
                href={href(d)}
                aria-current={d === days ? "page" : undefined}
                className={cn("rounded px-2.5 py-1 text-xs font-medium", d === days ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text")}
              >
                {d} days
              </Link>
            ))}
          </nav>
          {channels.length > 1 && <SelectParamFilter paramName="channel" label="Channel" allLabel="Every channel" options={channels.map((c) => ({ value: c.id, label: c.name }))} resetParams={[]} />}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {stat("First response (median)", durationText(totals.firstResponse.median), `90% within ${durationText(totals.firstResponse.p90)}${report.officeHours ? ` · clock time ${durationText(totals.firstResponse.clockMedian)}` : ""}`)}
        {stat("Answered within an hour", shareText(totals.firstResponse.within[1]?.share ?? null), `${shareText(totals.firstResponse.within[0]?.share ?? null)} within 5 minutes · ${shareText(totals.firstResponse.within[2]?.share ?? null)} within a day`)}
        {stat("Every reply (median wait)", durationText(totals.replies.median), `${totals.replies.count.toLocaleString("en-IN")} replies · 90% within ${durationText(totals.replies.p90)}`)}
        {stat("Waiting for a person now", totals.waitingNow.toLocaleString("en-IN"), totals.oldestWaitMs !== null ? `the longest for ${durationText(totals.oldestWaitMs)}` : "nobody waiting", totals.waitingNow > 0 ? "warn" : undefined)}
        {stat("Conversations", totals.started.toLocaleString("en-IN"), `${totals.neededPerson.toLocaleString("en-IN")} needed a person`)}
        {stat("The bot handled alone", shareText(totals.started ? totals.botOnly / totals.started : null), `${totals.botOnly.toLocaleString("en-IN")} without anybody from the team`)}
        {stat("Leads made", totals.leads.toLocaleString("en-IN"), "from these conversations")}
        {stat("Tickets made", totals.tickets.toLocaleString("en-IN"), "from these conversations")}
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-medium text-text">Day by day</h2>
          <p className="mt-0.5 text-xs text-muted">Conversations started each day — the darker part needed a person — and that day&apos;s median first response.</p>
        </CardHeader>
        <CardContent>
          <div role="img" aria-label={`Conversations a day over the last ${days} days, at most ${peak} in a day`} className="flex h-40 items-end gap-px">
            {report.byDay.map((d) => (
              <div
                key={d.date}
                title={`${labelOf(d.date)}: ${d.started} started, ${d.neededPerson} needed a person, first response ${durationText(d.firstMedian)}`}
                className="relative flex min-w-0 flex-1 flex-col justify-end rounded-t-sm"
                style={{ height: `${(d.started / peak) * 100}%`, background: "color-mix(in srgb, var(--brand) 30%, var(--surface))" }}
              >
                <div className="rounded-t-sm" style={{ height: d.started ? `${(d.neededPerson / d.started) * 100}%` : 0, background: "var(--brand)" }} />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-subtle">
            <span>{labelOf(report.byDay[0]!.date)}</span>
            <span>{labelOf(report.byDay[report.byDay.length - 1]!.date)}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-medium text-text">By channel</h2>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {report.byChannel.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th scope="col" className="py-2 pr-3 font-medium">Channel</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Conversations</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Needed a person</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Bot alone</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">First response</th>
                  <th scope="col" className="py-2 text-right font-medium">Within an hour</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {report.byChannel.map((c) => (
                  <tr key={c.id}>
                    <th scope="row" className="py-2 pr-3 text-left font-medium text-text">
                      <span className="inline-flex items-center gap-1.5">
                        {c.kind === "WHATSAPP" ? <Phone aria-hidden="true" className="h-3.5 w-3.5 text-success" /> : <Globe aria-hidden="true" className="h-3.5 w-3.5 text-info" />}
                        {c.name}
                      </span>
                    </th>
                    <td className="py-2 pr-3 text-right tabular-nums">{c.started.toLocaleString("en-IN")}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{c.neededPerson.toLocaleString("en-IN")}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{c.botOnly.toLocaleString("en-IN")}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{durationText(c.firstMedian)}</td>
                    <td className="py-2 text-right tabular-nums">{shareText(c.withinHour)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted">No conversations in this period.</p>
          )}
        </CardContent>
      </Card>

      {report.byPerson && (
        <Card>
          <CardHeader>
            <h2 className="text-sm font-medium text-text">By person</h2>
            <p className="mt-0.5 text-xs text-muted">Who answered first, and every reply each person sent with how long the customer had waited for it.</p>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {report.byPerson.length ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th scope="col" className="py-2 pr-3 font-medium">Person</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">First responses</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">Their median</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">Replies</th>
                    <th scope="col" className="py-2 text-right font-medium">Median wait</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {report.byPerson.map((p) => (
                    <tr key={p.id}>
                      <th scope="row" className="py-2 pr-3 text-left font-medium text-text">
                        {p.name}
                      </th>
                      <td className="py-2 pr-3 text-right tabular-nums">{p.firstResponses.toLocaleString("en-IN")}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{durationText(p.firstMedian)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{p.replies.toLocaleString("en-IN")}</td>
                      <td className="py-2 text-right tabular-nums">{durationText(p.replyMedian)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-muted">Nobody from the team replied in this period.</p>
            )}
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-subtle">
        First response runs from when the customer first needed a person — the bot handed over, or the conversation began without it — to the first reply by
        somebody on the team, so time with the bot isn&apos;t counted against anyone.
        {report.officeHours ? " Where a channel has office hours, only the time the team was in counts; the clock time is shown beside it." : ""} Medians, and the
        time 90% were answered within, so one conversation left over a weekend doesn&apos;t hide the rest.
        {!viewer.viewAll ? " Over the conversations you can see." : ""}
      </p>
    </div>
  );
}
