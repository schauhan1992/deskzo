"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check } from "lucide-react";
import { applyHandover, type AreaInventory, type HandoverOutcome } from "@/actions/handover";
import { routingModeLabels, type Routing } from "@/lib/handover/plan";
import { allocationMethodHints, allocationMethodLabels } from "@/lib/workspace/allocation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/bulk-select";

type Person = { id: string; name: string; active: boolean };

/**
 * Only the two methods that mean something here.
 *
 * `BY_ACCOUNT_OWNER` is a calling-list idea — send each row to whoever already owns that account —
 * and in a handover it would quietly degrade to round robin for every area, because these records
 * carry no owner to match on. An option that silently does something other than its label is worse
 * than one that isn't offered.
 */
type Method = "ROUND_ROBIN" | "BLOCKS";
const SPLIT_METHODS: Method[] = ["ROUND_ROBIN", "BLOCKS"];

/**
 * Deciding where one person's work goes.
 *
 * Every area starts at "Leave as is" and has to be chosen deliberately. The opposite default —
 * everything moves unless you say otherwise — turns a half-finished screen into a bulk
 * reassignment nobody reviewed, and there is no undo for this.
 *
 * The one shortcut is "send everything to one person", which sets every non-empty area at once and
 * is still editable afterwards. That covers the common case without making it the default.
 */
export function HandoverPlanner({
  fromUserId,
  fromName,
  areas,
  people,
}: {
  fromUserId: string;
  fromName: string;
  areas: AreaInventory[];
  people: Person[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ outcomes: HandoverOutcome[]; total: number } | null>(null);

  const [routings, setRoutings] = useState<Record<string, Routing>>(
    Object.fromEntries(areas.map((a) => [a.key, { mode: "KEEP" } as Routing])),
  );
  const [reason, setReason] = useState("");

  // Only people who can actually receive work. A deactivated account is refused by the action
  // anyway; leaving it out of the list is how somebody avoids finding that out at the end.
  const eligible = people.filter((p) => p.active && p.id !== fromUserId);
  const holding = areas.filter((a) => a.count > 0);
  const empty = areas.filter((a) => a.count === 0);

  const set = (key: string, routing: Routing) => setRoutings((prev) => ({ ...prev, [key]: routing }));

  const moving = holding.filter((a) => routings[a.key]?.mode !== "KEEP");
  const movingCount = moving.reduce((sum, a) => sum + a.count, 0);

  function sendEverythingTo(userId: string) {
    if (!userId) return;
    setRoutings((prev) => {
      const next = { ...prev };
      for (const area of holding) next[area.key] = { mode: "ONE", userId };
      return next;
    });
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await applyHandover({
        fromUserId,
        reason,
        routings: areas.map((a) => ({ key: a.key, routing: routings[a.key] ?? { mode: "KEEP" } })),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone(result.data);
      router.refresh();
    });
  }

  if (done) {
    return (
      <Card>
        <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
          <Check className="h-4 w-4 text-success" />
          {done.total} item{done.total === 1 ? "" : "s"} moved
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {done.outcomes.map((o) => (
            <div key={o.areaKey} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2 last:border-0">
              <span className="text-text">{o.label}</span>
              <span className="text-muted">
                {o.moves.map((m) => `${m.name} (${m.count})`).join(" · ")}
              </span>
            </div>
          ))}
          <p className="pt-1 text-xs text-subtle">
            Everyone who received something has been notified. Equipment still has to be confirmed by whoever
            now holds it.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (holding.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted">
          {fromName} isn&apos;t holding anything that needs handing over.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="everything">Send everything to</Label>
            <Select
              id="everything"
              defaultValue=""
              onChange={(e) => {
                sendEverythingTo(e.target.value);
                e.target.value = "";
              }}
              className="min-w-56"
            >
              <option value="">Choose a person…</option>
              {eligible.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <p className="flex-1 pb-2 text-xs text-subtle">
            A shortcut, not a decision — it fills every row below and you can change any of them afterwards.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">
          What {fromName} is holding
        </CardHeader>
        <CardContent className="space-y-4">
          {holding.map((area) => (
            <AreaRow
              key={area.key}
              area={area}
              people={eligible}
              routing={routings[area.key] ?? { mode: "KEEP" }}
              onChange={(r) => set(area.key, r)}
            />
          ))}
        </CardContent>
      </Card>

      {empty.length > 0 && (
        <p className="text-xs text-subtle">
          Nothing to move in: {empty.map((a) => a.label.toLowerCase()).join(", ")}.
        </p>
      )}

      <Card>
        <CardContent className="space-y-1.5">
          <Label htmlFor="reason">Why (optional)</Label>
          <Input
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Resigned · maternity cover · moved to the Gujarat territory"
          />
          <p className="text-xs text-subtle">
            Kept on both people&apos;s records. In six months this is the only thing that explains why forty
            accounts changed hands on one afternoon.
          </p>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={submit} disabled={pending || movingCount === 0}>
          {pending ? "Moving…" : `Hand over ${movingCount} item${movingCount === 1 ? "" : "s"}`}
        </Button>
        <span className="text-xs text-subtle">
          {movingCount === 0
            ? "Nothing is set to move yet."
            : `${moving.length} area${moving.length === 1 ? "" : "s"}. This can't be undone in one step.`}
        </span>
      </div>
    </div>
  );
}

function AreaRow({
  area,
  people,
  routing,
  onChange,
}: {
  area: AreaInventory;
  people: Person[];
  routing: Routing;
  onChange: (r: Routing) => void;
}) {
  const splitIds = routing.mode === "SPLIT" ? routing.userIds : [];
  const method: Method = routing.mode === "SPLIT" ? (routing.method as Method) : "ROUND_ROBIN";

  function setMode(mode: Routing["mode"]) {
    if (mode === "KEEP") return onChange({ mode: "KEEP" });
    if (mode === "ONE") return onChange({ mode: "ONE", userId: routing.mode === "ONE" ? routing.userId : "" });
    onChange({ mode: "SPLIT", userIds: splitIds, method });
  }

  function toggle(id: string) {
    const next = splitIds.includes(id) ? splitIds.filter((x) => x !== id) : [...splitIds, id];
    onChange({ mode: "SPLIT", userIds: next, method });
  }

  return (
    <div className="border-b border-line pb-4 last:border-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-md">
          <div className="text-sm font-medium text-text">
            {area.label} <span className="text-muted">({area.count})</span>
          </div>
          <p className="mt-0.5 text-xs text-subtle">{area.detail}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={routing.mode}
            onChange={(e) => setMode(e.target.value as Routing["mode"])}
            aria-label={`How to route ${area.label}`}
          >
            <option value="KEEP">{routingModeLabels.KEEP}</option>
            <option value="ONE">{routingModeLabels.ONE}</option>
            {/* Absent rather than disabled where it makes no sense: an option you can pick and then
                be told off for is worse than one that was never offered. */}
            {area.splittable && <option value="SPLIT">{routingModeLabels.SPLIT}</option>}
          </Select>

          {routing.mode === "ONE" && (
            <>
              <ArrowRight className="h-3.5 w-3.5 text-subtle" />
              <Select
                value={routing.userId}
                onChange={(e) => onChange({ mode: "ONE", userId: e.target.value })}
                aria-label={`Who takes over ${area.label}`}
              >
                <option value="">Choose…</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </>
          )}
        </div>
      </div>

      {routing.mode === "SPLIT" && (
        <div className="mt-3 space-y-2 rounded-lg bg-surface-sunken p-3">
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {people.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-sm text-text">
                <Checkbox checked={splitIds.includes(p.id)} onChange={() => toggle(p.id)} />
                {p.name}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Label htmlFor={`method-${area.key}`} className="text-xs">
              How
            </Label>
            <Select
              id={`method-${area.key}`}
              value={method}
              onChange={(e) => onChange({ mode: "SPLIT", userIds: splitIds, method: e.target.value as Method })}
            >
              {SPLIT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {allocationMethodLabels[m]}
                </option>
              ))}
            </Select>
          </div>
          <p className="text-xs text-subtle">{allocationMethodHints[method]}</p>
          {splitIds.length > 0 && (
            <p className="text-xs text-muted">
              Roughly {Math.floor(area.count / splitIds.length)}–{Math.ceil(area.count / splitIds.length)} each.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
