"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Users } from "lucide-react";
import type { TargetMetric, TargetScope } from "@prisma/client";
import { recentActual, saveTarget, setTeamTargets } from "@/actions/target";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import {
  METRICS,
  formatMetric,
  metricByKey,
  scopeLabels,
  suggestedWindows,
  type PeriodWindow,
} from "@/lib/targets/metrics";
import { useClock } from "@/components/time/clock-provider";

type Options = {
  people: { id: string; name: string; role: string; department: { id: string; name: string } | null }[];
  departments: { id: string; name: string }[];
};

const SCOPES: TargetScope[] = ["USER", "DEPARTMENT", "COMPANY"];

/**
 * Handing out targets.
 *
 * Two modes, because there are two ways this actually happens: one person gets a number, or a sales
 * head sets the month for the whole team in one sitting. Doing the second one form at a time
 * guarantees somebody is missed.
 *
 * The last period's actual is shown beside each box on request, because a target invented out of
 * the air is how targets lose credibility — "they did ₹18L last month" is the only sensible place
 * to start from.
 */
export function SetTargetsDialog({ options }: { options: Options }) {
  const router = useRouter();
  const clock = useClock();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [bulk, setBulk] = useState(false);

  // The periods around the workspace's today, given as a day is held (midnight UTC) — how
  // `suggestedWindows` reads the date it is handed.
  const windows = suggestedWindows(clock.calendarDate(new Date()));
  const [windowIndex, setWindowIndex] = useState(0);
  const [metric, setMetric] = useState<TargetMetric>("INVOICED_VALUE");
  const [scope, setScope] = useState<TargetScope>("USER");
  const [userId, setUserId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<Record<string, string>>({});
  const [lastPeriod, setLastPeriod] = useState<Record<string, number>>({});

  const period: PeriodWindow = windows[windowIndex];
  const definition = metricByKey[metric];

  // The equivalent window immediately before this one, for the "what did they do last time" figure.
  // Whole days counted on the windows' own `yyyy-mm-dd` keys, in UTC: no zone enters into it.
  function previousWindow(w: PeriodWindow) {
    const from = new Date(`${w.fromDate}T00:00:00.000Z`);
    const to = new Date(`${w.toDate}T00:00:00.000Z`);
    const span = to.getTime() - from.getTime() + 86400000;
    return {
      fromDate: new Date(from.getTime() - span).toISOString().slice(0, 10),
      toDate: new Date(to.getTime() - span).toISOString().slice(0, 10),
    };
  }

  function loadLastPeriod(ids: string[]) {
    const prev = previousWindow(period);
    startTransition(async () => {
      const results = await Promise.all(
        ids.map(async (id) => [id, await recentActual({ metric, userId: id, ...prev })] as const),
      );
      setLastPeriod(Object.fromEntries(results));
    });
  }

  const team = departmentId ? options.people.filter((p) => p.department?.id === departmentId) : options.people;

  function submitOne() {
    setError(null);
    startTransition(async () => {
      const result = await saveTarget({
        metric,
        period: period.period,
        fromDate: period.fromDate,
        toDate: period.toDate,
        label: period.label,
        scope,
        userId: scope === "USER" ? userId : undefined,
        departmentId: scope === "DEPARTMENT" ? departmentId : undefined,
        value: Number(value),
        note,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setValue("");
      router.refresh();
    });
  }

  function submitMany() {
    setError(null);
    startTransition(async () => {
      const result = await setTeamTargets({
        metric,
        period: period.period,
        fromDate: period.fromDate,
        toDate: period.toDate,
        label: period.label,
        note,
        targets: Object.entries(rows).map(([id, v]) => ({ userId: id, value: Number(v) })),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setRows({});
      router.refresh();
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        Set a target
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title={bulk ? "Set the team's targets" : "Set a target"}>
        <div className="space-y-4">
          <div className="flex gap-2">
            <Button size="sm" variant={bulk ? "secondary" : "primary"} onClick={() => setBulk(false)}>
              One person
            </Button>
            <Button size="sm" variant={bulk ? "primary" : "secondary"} onClick={() => setBulk(true)}>
              <Users className="mr-1.5 h-3.5 w-3.5" />
              A whole team
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="metric">What&apos;s being measured</Label>
              <Select id="metric" value={metric} onChange={(e) => setMetric(e.target.value as TargetMetric)}>
                {[...new Set(METRICS.map((m) => m.team))].map((team) => (
                  <optgroup key={team} label={team}>
                    {METRICS.filter((m) => m.team === team).map((m) => (
                      <option key={m.key} value={m.key}>
                        {m.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="period">Over what period</Label>
              <Select id="period" value={String(windowIndex)} onChange={(e) => setWindowIndex(Number(e.target.value))}>
                {windows.map((w, i) => (
                  <option key={w.label} value={i}>
                    {w.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {/* Said up front, because it's what somebody will query in three weeks. */}
          <Card className="px-3 py-2 text-xs text-muted">
            <span className="font-medium text-text">What counts:</span> {definition.counts}
            {definition.excludes && (
              <span className="mt-1 block text-subtle">Not counted: {definition.excludes}</span>
            )}
          </Card>

          {!bulk ? (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="scope">Who carries it</Label>
                  <Select id="scope" value={scope} onChange={(e) => setScope(e.target.value as TargetScope)}>
                    {SCOPES.map((s) => (
                      <option key={s} value={s}>
                        {scopeLabels[s]}
                      </option>
                    ))}
                  </Select>
                </div>
                {scope === "USER" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="who">Person</Label>
                    <Select
                      id="who"
                      value={userId}
                      onChange={(e) => {
                        setUserId(e.target.value);
                        if (e.target.value) loadLastPeriod([e.target.value]);
                      }}
                    >
                      <option value="">Choose…</option>
                      {options.people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                          {p.department ? ` — ${p.department.name}` : ""}
                        </option>
                      ))}
                    </Select>
                  </div>
                )}
                {scope === "DEPARTMENT" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="dept">Team</Label>
                    <Select id="dept" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                      <option value="">Choose…</option>
                      {options.departments.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="value">The number to hit</Label>
                <Input id="value" type="number" value={value} onChange={(e) => setValue(e.target.value)} />
                {scope === "USER" && userId && lastPeriod[userId] !== undefined && (
                  <p className="text-xs text-subtle">
                    They managed {formatMetric(lastPeriod[userId], definition.unit)} in the equivalent period before
                    this one.
                    {lastPeriod[userId] > 0 && (
                      <button
                        type="button"
                        onClick={() => setValue(String(Math.round(lastPeriod[userId] * 1.1)))}
                        className="ml-1.5 text-brand hover:underline"
                      >
                        Use +10%
                      </button>
                    )}
                  </p>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="bteam">Team</Label>
                <Select
                  id="bteam"
                  value={departmentId}
                  onChange={(e) => {
                    setDepartmentId(e.target.value);
                    setRows({});
                    setLastPeriod({});
                  }}
                >
                  <option value="">Everybody</option>
                  {options.departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="flex items-center justify-between">
                <Label>Numbers ({Object.values(rows).filter(Boolean).length} set)</Label>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => loadLastPeriod(team.map((p) => p.id))}
                  className="text-xs text-brand hover:underline"
                >
                  Show what they did last period
                </button>
              </div>

              <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-base border border-line p-2">
                {team.map((p) => (
                  <div key={p.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-text">
                      {p.name}
                      {lastPeriod[p.id] !== undefined && (
                        <Badge tone="default" className="ml-1.5">
                          was {formatMetric(lastPeriod[p.id], definition.unit)}
                        </Badge>
                      )}
                    </span>
                    <Input
                      type="number"
                      value={rows[p.id] ?? ""}
                      onChange={(e) => setRows((r) => ({ ...r, [p.id]: e.target.value }))}
                      className="w-32"
                      aria-label={`Target for ${p.name}`}
                    />
                  </div>
                ))}
                {team.length === 0 && <p className="py-4 text-center text-sm text-subtle">Nobody in that team.</p>}
              </div>
              <p className="text-xs text-subtle">
                Anybody left blank is skipped — this won&apos;t give somebody a target of nothing.
              </p>
            </>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="tnote">Note</Label>
            <Textarea id="tnote" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-2">
            <Button
              disabled={
                pending ||
                (bulk
                  ? Object.values(rows).filter((v) => Number(v) > 0).length === 0
                  : !value || (scope === "USER" && !userId) || (scope === "DEPARTMENT" && !departmentId))
              }
              onClick={bulk ? submitMany : submitOne}
            >
              {pending ? "Saving…" : bulk ? "Set them" : "Set it"}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
