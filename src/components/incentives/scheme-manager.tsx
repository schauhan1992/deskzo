"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import type { IncentiveBasis, TargetMetric } from "@prisma/client";
import type { listSchemes } from "@/actions/incentive";
import { saveScheme, setSchemeActive } from "@/actions/incentive";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/bulk-select";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { basisHints, basisLabels, computeIncentive, validateScheme } from "@/lib/incentives/compute";
import { METRICS, formatMetric, metricByKey } from "@/lib/targets/metrics";

type Scheme = Awaited<ReturnType<typeof listSchemes>>[number];

const BASES: IncentiveBasis[] = [
  "SLAB",
  "PERCENT_OF_ACHIEVEMENT",
  "PERCENT_OF_TARGET",
  "FIXED_ON_ACHIEVEMENT",
  "PER_UNIT",
];

type SlabRow = { fromPercent: string; toPercent: string; ratePercent: string; fixedAmount: string };

/**
 * Writing the rules.
 *
 * The preview is the important part of this screen. A scheme is a set of numbers whose consequences
 * are genuinely hard to picture — the difference between a flat 2% and a banded 1.5/2.5/3.5 is a
 * few thousand rupees at one level of achievement and tens of thousands at another. So the form
 * works out what the scheme would pay at several levels as you type it, before anybody is on it.
 */
export function SchemeManager({ schemes }: { schemes: Scheme[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Scheme | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-4">
      {error && <Card className="border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">{error}</Card>}

      <div className="flex justify-end">
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New scheme
        </Button>
      </div>

      <div className="space-y-3">
        {schemes.map((s) => (
          <Card key={s.id} className="px-4 py-3.5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-text">{s.name}</span>
                  <Badge tone={s.active ? "green" : "default"}>{s.active ? "In use" : "Retired"}</Badge>
                  {s.requiresCollection && <Badge tone="amber">Pays on collection</Badge>}
                </div>
                <p className="mt-0.5 text-xs text-subtle">
                  {metricByKey[s.metric].label} · {basisLabels[s.basis]}
                  {s._count.targets > 0 && ` · on ${s._count.targets} target(s)`}
                  {s._count.earnings > 0 && ` · ${s._count.earnings} payout(s)`}
                </p>
                {s.description && <p className="mt-1 text-sm text-muted">{s.description}</p>}
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setError(null);
                    startTransition(async () => {
                      const result = await setSchemeActive(s.id, !s.active);
                      if (!result.ok) setError(result.error);
                      else router.refresh();
                    });
                  }}
                  className="rounded-base p-1.5 text-subtle hover:bg-surface-sunken hover:text-text"
                  aria-label={s.active ? `Retire ${s.name}` : `Use ${s.name}`}
                >
                  {s.active ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(s)}
                  className="rounded-base px-2 py-1 text-xs text-muted hover:bg-surface-sunken hover:text-text"
                >
                  Edit
                </button>
              </div>
            </div>

            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              {s.thresholdPercent && <span>Pays from {Number(s.thresholdPercent)}% of target</span>}
              {s.ratePercent && <span>{Number(s.ratePercent)}%</span>}
              {s.fixedAmount && <span>{formatCurrency(Number(s.fixedAmount))} flat</span>}
              {s.perUnitAmount && <span>{formatCurrency(Number(s.perUnitAmount))} per unit</span>}
              {s.capAmount && <span>Capped at {formatCurrency(Number(s.capAmount))}</span>}
            </div>

            {s.slabs.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {s.slabs.map((slab) => (
                  <span key={slab.id} className="rounded-base bg-surface-sunken px-2 py-1 text-xs text-muted">
                    {Number(slab.fromPercent)}%
                    {slab.toPercent ? `–${Number(slab.toPercent)}%` : "+"} →{" "}
                    {slab.ratePercent ? `${Number(slab.ratePercent)}%` : formatCurrency(Number(slab.fixedAmount ?? 0))}
                  </span>
                ))}
              </div>
            )}
          </Card>
        ))}

        {schemes.length === 0 && (
          <Card className="px-6 py-10 text-center text-sm text-subtle">
            No schemes yet. A scheme says what hitting a target is worth — a rate, a threshold below which nothing
            pays, and usually bands.
          </Card>
        )}
      </div>

      {(creating || editing) && (
        <SchemeDialog
          scheme={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function SchemeDialog({ scheme, onClose }: { scheme: Scheme | null; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: scheme?.name ?? "",
    description: scheme?.description ?? "",
    metric: (scheme?.metric ?? "INVOICED_VALUE") as TargetMetric,
    basis: (scheme?.basis ?? "SLAB") as IncentiveBasis,
    thresholdPercent: scheme?.thresholdPercent ? String(Number(scheme.thresholdPercent)) : "",
    ratePercent: scheme?.ratePercent ? String(Number(scheme.ratePercent)) : "",
    fixedAmount: scheme?.fixedAmount ? String(Number(scheme.fixedAmount)) : "",
    perUnitAmount: scheme?.perUnitAmount ? String(Number(scheme.perUnitAmount)) : "",
    capAmount: scheme?.capAmount ? String(Number(scheme.capAmount)) : "",
  });
  const [requiresCollection, setRequiresCollection] = useState(scheme?.requiresCollection ?? false);
  const [slabs, setSlabs] = useState<SlabRow[]>(
    scheme && scheme.slabs.length > 0
      ? scheme.slabs.map((s) => ({
          fromPercent: String(Number(s.fromPercent)),
          toPercent: s.toPercent ? String(Number(s.toPercent)) : "",
          ratePercent: s.ratePercent ? String(Number(s.ratePercent)) : "",
          fixedAmount: s.fixedAmount ? String(Number(s.fixedAmount)) : "",
        }))
      : [
          { fromPercent: "80", toPercent: "100", ratePercent: "1.5", fixedAmount: "" },
          { fromPercent: "100", toPercent: "120", ratePercent: "2.5", fixedAmount: "" },
          { fromPercent: "120", toPercent: "", ratePercent: "3.5", fixedAmount: "" },
        ],
  );
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const draft = {
    name: form.name,
    basis: form.basis,
    thresholdPercent: num(form.thresholdPercent),
    ratePercent: num(form.ratePercent),
    fixedAmount: num(form.fixedAmount),
    perUnitAmount: num(form.perUnitAmount),
    capAmount: num(form.capAmount),
    slabs:
      form.basis === "SLAB"
        ? slabs.map((s) => ({
            fromPercent: Number(s.fromPercent) || 0,
            toPercent: num(s.toPercent),
            ratePercent: num(s.ratePercent),
            fixedAmount: num(s.fixedAmount),
          }))
        : [],
  };

  const problems = validateScheme(draft);
  const unit = metricByKey[form.metric].unit;

  // What it would actually pay, worked out live. A scheme is a set of numbers whose consequences
  // are hard to picture; this makes them concrete before anybody is put on it.
  const exampleTarget = unit === "CURRENCY" ? 1000000 : 100;
  const preview = [60, 80, 100, 120, 150].map((percent) => ({
    percent,
    result: computeIncentive({
      scheme: draft,
      targetValue: exampleTarget,
      achievedValue: (exampleTarget * percent) / 100,
    }),
  }));

  return (
    <Dialog open onClose={onClose} title={scheme ? `Edit ${scheme.name}` : "New incentive scheme"}>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="sname">Name</Label>
          <Input id="sname" value={form.name} onChange={set("name")} placeholder="Sales commission — FY26" />
          <p className="text-xs text-subtle">Appears on people&apos;s payslip explanation.</p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="smetric">Pays on</Label>
            <Select id="smetric" value={form.metric} onChange={set("metric")}>
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
            <p className="text-xs text-subtle">Must match the target it&apos;s attached to.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sbasis">How it pays</Label>
            <Select id="sbasis" value={form.basis} onChange={set("basis")}>
              {BASES.map((b) => (
                <option key={b} value={b}>
                  {basisLabels[b]}
                </option>
              ))}
            </Select>
            <p className="text-xs text-subtle">{basisHints[form.basis]}</p>
          </div>
        </div>

        {form.basis === "SLAB" ? (
          <div className="space-y-2">
            <Label>Bands</Label>
            <div className="space-y-1.5">
              {slabs.map((s, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <Input
                    value={s.fromPercent}
                    onChange={(e) =>
                      setSlabs((rows) => rows.map((r, j) => (i === j ? { ...r, fromPercent: e.target.value } : r)))
                    }
                    className="w-20"
                    aria-label="From percent"
                  />
                  <span className="text-xs text-subtle">%–</span>
                  <Input
                    value={s.toPercent}
                    onChange={(e) =>
                      setSlabs((rows) => rows.map((r, j) => (i === j ? { ...r, toPercent: e.target.value } : r)))
                    }
                    className="w-20"
                    placeholder="∞"
                    aria-label="To percent"
                  />
                  <span className="text-xs text-subtle">% pays</span>
                  <Input
                    value={s.ratePercent}
                    onChange={(e) =>
                      setSlabs((rows) => rows.map((r, j) => (i === j ? { ...r, ratePercent: e.target.value } : r)))
                    }
                    className="w-20"
                    aria-label="Rate percent"
                  />
                  <span className="text-xs text-subtle">%</span>
                  <button
                    type="button"
                    onClick={() => setSlabs((rows) => rows.filter((_, j) => j !== i))}
                    className="ml-auto text-subtle hover:text-danger"
                    aria-label="Remove this band"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                setSlabs((rows) => [...rows, { fromPercent: "", toPercent: "", ratePercent: "", fixedAmount: "" }])
              }
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add a band
            </Button>
            <p className="text-xs text-subtle">
              Leave the top band&apos;s upper limit blank so it runs on — capping it stops rewarding the best month
              somebody ever has.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(form.basis === "PERCENT_OF_ACHIEVEMENT" || form.basis === "PERCENT_OF_TARGET") && (
              <div className="space-y-1.5">
                <Label htmlFor="srate">Rate (%)</Label>
                <Input id="srate" value={form.ratePercent} onChange={set("ratePercent")} />
              </div>
            )}
            {form.basis === "FIXED_ON_ACHIEVEMENT" && (
              <div className="space-y-1.5">
                <Label htmlFor="sfixed">Amount</Label>
                <Input id="sfixed" type="number" value={form.fixedAmount} onChange={set("fixedAmount")} />
              </div>
            )}
            {form.basis === "PER_UNIT" && (
              <div className="space-y-1.5">
                <Label htmlFor="sper">Per unit</Label>
                <Input id="sper" type="number" value={form.perUnitAmount} onChange={set("perUnitAmount")} />
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="sthresh">Pays from (% of target)</Label>
            <Input id="sthresh" value={form.thresholdPercent} onChange={set("thresholdPercent")} placeholder="None" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="scap">Cap on any one payout</Label>
            <Input id="scap" type="number" value={form.capAmount} onChange={set("capAmount")} placeholder="None" />
          </div>
        </div>

        <label className="flex cursor-pointer items-start gap-2 text-sm text-text">
          <Checkbox checked={requiresCollection} onChange={() => setRequiresCollection((v) => !v)} />
          <span>
            Only pay once the money is in
            <span className="block text-xs text-subtle">
              Commission on an invoice the customer never pays is commission paid out of nothing. Holding a payment is
              far easier than recovering one.
            </span>
          </span>
        </label>

        <div className="space-y-1.5">
          <Label htmlFor="sdesc">Description</Label>
          <Textarea id="sdesc" rows={2} value={form.description} onChange={set("description")} />
        </div>

        {/* What it would actually pay. */}
        <Card className="overflow-hidden p-0">
          <CardHeader className="text-xs font-medium text-text">
            What this pays against a {formatMetric(exampleTarget, unit)} target
          </CardHeader>
          <CardContent className="space-y-1">
            {preview.map(({ percent, result }) => (
              <div key={percent} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-muted">
                  {percent}% —{" "}
                  <span className="text-xs text-subtle">{formatMetric((exampleTarget * percent) / 100, unit)}</span>
                </span>
                <span className={`tabular-nums ${result.amount > 0 ? "text-text" : "text-subtle"}`}>
                  {result.amount > 0 ? formatCurrency(result.amount) : "nothing"}
                  {result.capped && <span className="ml-1 text-xs text-warning">capped</span>}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

        {problems.length > 0 && (
          <Card className="border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
            {problems.map((p) => (
              <p key={p} className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                {p}
              </p>
            ))}
          </Card>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex gap-2">
          <Button
            disabled={pending || !form.name.trim()}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await saveScheme({
                  ...(scheme ? { id: scheme.id } : {}),
                  name: form.name,
                  description: form.description,
                  metric: form.metric,
                  basis: form.basis,
                  thresholdPercent: num(form.thresholdPercent) ?? undefined,
                  ratePercent: num(form.ratePercent) ?? undefined,
                  fixedAmount: num(form.fixedAmount) ?? undefined,
                  perUnitAmount: num(form.perUnitAmount) ?? undefined,
                  capAmount: num(form.capAmount) ?? undefined,
                  requiresCollection,
                  slabs: draft.slabs.map((s) => ({
                    fromPercent: s.fromPercent,
                    toPercent: s.toPercent ?? undefined,
                    ratePercent: s.ratePercent ?? undefined,
                    fixedAmount: s.fixedAmount ?? undefined,
                  })),
                });
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                onClose();
                router.refresh();
              });
            }}
          >
            {pending ? "Saving…" : scheme ? "Save" : "Create"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
