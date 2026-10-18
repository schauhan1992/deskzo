import Link from "next/link";
import type { CallReportView } from "@/actions/call-report";
import { Card } from "@/components/ui/card";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { formatDuration } from "@/lib/calls";
import { minuteOfDay, waited, type CallReportRow } from "@/lib/call-report";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * Calls › Team report, drawn (owner, 18 Oct 2026): the period, the team's totals, calls a day and each person's
 * row. Given the report (src/actions/call-report.ts); asks nothing itself but the workspace's clock.
 */

const shift = (key: string, days: number) => new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export async function TeamReport({ report }: { report: CallReportView }) {
  const clock = await workspaceClock();
  const today = report.today;
  const weekday = clock.parts(new Date()).weekday;
  const presets = [
    { label: "Today", from: today, to: today },
    { label: "Yesterday", from: shift(today, -1), to: shift(today, -1) },
    { label: "This week", from: shift(today, -((weekday + 6) % 7)), to: today },
    { label: "Last 7 days", from: shift(today, -6), to: today },
    { label: "This month", from: `${today.slice(0, 8)}01`, to: today },
  ];
  const oneDay = report.from === report.to;
  const period = oneDay ? (report.from === today ? "today" : clock.date(clock.startOfDay(report.from))) : `${clock.dayMonth(clock.startOfDay(report.from))} – ${clock.date(clock.startOfDay(report.to))}`;
  const t = report.totals;
  const busiest = Math.max(1, ...report.days.map((d) => d.calls));

  return (
    <div className="animate-fade-rise">
      <h1 className="text-xl font-semibold text-text">Calls</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">Each person&apos;s calling {period}: how much reached somebody, when the day&apos;s calling started and stopped, and how fast new leads were called.</p>

      <div className="mt-5 flex flex-wrap gap-2">
        <Link href="/calls" className="rounded-full border border-line-strong bg-surface px-3 py-1 text-sm text-muted transition-colors hover:text-text">
          All calls
        </Link>
        <Link href={{ pathname: "/calls", query: { view: "due" } }} className="rounded-full border border-line-strong bg-surface px-3 py-1 text-sm text-muted transition-colors hover:text-text">
          Callbacks owed
        </Link>
        <span className="rounded-full bg-brand px-3 py-1 text-sm text-brand-contrast" aria-current="page">
          Team report
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {presets.map((p) => {
          const on = p.from === report.from && p.to === report.to;
          return (
            <Link
              key={p.label}
              href={{ pathname: "/calls/report", query: { from: p.from, to: p.to } }}
              aria-current={on ? "true" : undefined}
              className={`rounded-base px-2.5 py-1 text-sm ${on ? "bg-surface-sunken font-medium text-text" : "text-muted hover:text-text"}`}
            >
              {p.label}
            </Link>
          );
        })}
        <DateRangePicker fromParam="from" toParam="to" label="Period" />
      </div>
      {report.clamped && <p className="mt-2 text-xs text-warning">A report covers three months at most — showing the last three months of the period you chose.</p>}

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Calls" value={String(t.calls)} note={`${t.outgoing} made · ${t.incoming} taken`} />
        <Stat label="Connected" value={String(t.connected)} note={`${t.connectRate}% reached a person`} />
        <Stat label="Talk time" value={formatDuration(t.talkSeconds)} note={t.connected ? `${formatDuration(t.averageSeconds)} a connected call` : "—"} />
        <Stat label="Callbacks overdue" value={String(t.callbacksOverdue)} note="promised and past their time" warn={t.callbacksOverdue > 0} />
        {t.leads ? (
          <Stat label="New leads" value={String(t.leads.new)} note={!t.leads.new ? "none came in" : !t.leads.called ? "none called yet" : `first call in ${waited(t.leads.medianMinutes)}${t.leads.notCalled ? ` · ${t.leads.notCalled} not yet` : ""}`} warn={t.leads.notCalled > 0} />
        ) : (
          <Stat label="From the Deskzo app" value={String(t.fromApp)} note={`${t.waitingForWord} waiting for a word`} />
        )}
      </div>

      {!oneDay && (
        <Card className="mt-5 px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Calls a day — darker reached a person</div>
          <div className="mt-3 flex h-28 items-end gap-1" role="img" aria-label={`Calls each day, ${report.from} to ${report.to}`}>
            {report.days.map((d) => (
              <div key={d.day} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${clock.dayMonth(clock.startOfDay(d.day))}: ${d.calls} calls, ${d.connected} connected`}>
                <div className="w-full rounded-t-sm bg-brand/25" style={{ height: `${((d.calls - d.connected) / busiest) * 100}%` }} />
                <div className="w-full bg-brand" style={{ height: `${(d.connected / busiest) * 100}%` }} />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-subtle">
            <span>{clock.dayMonth(clock.startOfDay(report.from))}</span>
            <span>{clock.dayMonth(clock.startOfDay(report.to))}</span>
          </div>
        </Card>
      )}

      <Card className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[60rem] text-sm">
          <caption className="sr-only">Each person&apos;s calling, {period}</caption>
          <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="px-4 py-2">Person</th>
              <th scope="col" className="px-3 py-2 text-right">Calls</th>
              <th scope="col" className="px-3 py-2 text-right">Connected</th>
              <th scope="col" className="px-3 py-2 text-right">Talk time</th>
              <th scope="col" className="px-3 py-2">{oneDay ? "First – last call" : "Usual first – last call"}</th>
              <th scope="col" className="px-3 py-2 text-right">From the app</th>
              <th scope="col" className="px-3 py-2 text-right">Callbacks overdue</th>
              {report.leadsShown && <th scope="col" className="px-4 py-2">New leads</th>}
            </tr>
          </thead>
          <tbody>
            {report.rows.length === 0 ? (
              <tr>
                <td colSpan={report.leadsShown ? 8 : 7} className="px-4 py-6 text-center text-muted">
                  Nobody you can see has logged a call in the last month.
                </td>
              </tr>
            ) : (
              report.rows.map((r) => <Row key={r.userId} row={r} oneDay={oneDay} leads={report.leadsShown} />)
            )}
          </tbody>
        </table>
      </Card>

      <p className="mt-3 max-w-3xl text-xs text-subtle">
        Connected counts calls that reached a person — connected, callback requested, not interested. First and last call are in this workspace&apos;s time; over several days, the
        middle value of the days they called. A new lead&apos;s first call is the first call about it or to its company after it came in. Everybody here is somebody whose calls you can
        see.
      </p>
    </div>
  );
}

function Stat({ label, value, note, warn }: { label: string; value: string; note: string; warn?: boolean }) {
  return (
    <Card className={`px-4 py-3 ${warn ? "border-warning/40" : ""}`}>
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${warn ? "text-warning" : "text-text"}`}>{value}</div>
      <div className="mt-0.5 text-xs text-muted">{note}</div>
    </Card>
  );
}

function Row({ row: r, oneDay, leads }: { row: CallReportRow; oneDay: boolean; leads: boolean }) {
  const none = r.calls === 0;
  return (
    <tr className="border-b border-line last:border-0">
      <th scope="row" className="px-4 py-2 text-left font-medium text-text">
        {r.name}
        {!oneDay && r.daysCalling > 0 && <span className="block text-xs font-normal text-muted">{r.daysCalling} day(s) calling</span>}
      </th>
      <td className={`px-3 py-2 text-right tabular-nums ${none ? "text-warning" : "text-text"}`}>{r.calls}</td>
      <td className="px-3 py-2 text-right tabular-nums text-text">
        {r.connected}
        {r.calls > 0 && <span className="ml-1 text-xs text-muted">{r.connectRate}%</span>}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-text">
        {formatDuration(r.talkSeconds)}
        {r.connected > 0 && <span className="block text-xs text-muted">{formatDuration(r.averageSeconds)} each</span>}
      </td>
      <td className="px-3 py-2 tabular-nums text-text">{r.calls ? `${minuteOfDay(r.firstCallMinute)} – ${minuteOfDay(r.lastCallMinute)}` : "—"}</td>
      <td className="px-3 py-2 text-right tabular-nums text-text">
        {r.fromApp}
        {r.waitingForWord > 0 && <span className="block text-xs text-warning">{r.waitingForWord} need a word</span>}
      </td>
      <td className={`px-3 py-2 text-right tabular-nums ${r.callbacksOverdue ? "font-medium text-warning" : "text-text"}`}>{r.callbacksOverdue}</td>
      {leads && (
        <td className="px-4 py-2 text-text">
          {r.leads && r.leads.new > 0 && r.leads.called === 0 ? (
            <>
              {r.leads.new}
              <span className="block text-xs text-warning">none called yet</span>
            </>
          ) : r.leads && r.leads.new > 0 ? (
            <>
              {r.leads.new} · first call in {waited(r.leads.medianMinutes)}
              <span className={`block text-xs ${r.leads.notCalled ? "text-warning" : "text-muted"}`}>
                {r.leads.withinHour} within the hour{r.leads.notCalled ? ` · ${r.leads.notCalled} not called yet` : ""}
              </span>
            </>
          ) : (
            <span className="text-muted">—</span>
          )}
        </td>
      )}
    </tr>
  );
}
