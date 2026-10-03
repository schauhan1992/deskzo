"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Boxes, Play, Plus } from "lucide-react";
import type { DepreciationMethod } from "@prisma/client";
import type { listAssets, previewDepreciation } from "@/actions/asset";
import { disposeAsset, runDepreciation, saveAsset } from "@/actions/asset";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay, indiaClock } from "@/lib/time/zone";
import { Amount } from "@/components/accounting/report-chrome";
import { depreciationMethodLabels } from "@/lib/ledger/depreciation";
import { monthName } from "@/lib/ledger/period";

type Asset = Awaited<ReturnType<typeof listAssets>>[number];
type Preview = Awaited<ReturnType<typeof previewDepreciation>>[number];

/**
 * The asset register.
 *
 * The register answers what the ledger can't: which laptop, bought when, held by whom, and what it
 * is worth now. The depreciation run is here rather than on a schedule because somebody has to
 * decide a month is finished, and that is a judgement, not a timer.
 */
export function AssetsManager({
  assets,
  preview,
  accounts,
  departments,
  people,
  month,
  year,
}: {
  assets: Asset[];
  preview: Preview[];
  accounts: { id: string; code: string; name: string }[];
  departments: { id: string; name: string }[];
  people: { id: string; name: string }[];
  month: number;
  year: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [disposing, setDisposing] = useState<Asset | null>(null);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, onOk?: () => void) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "That didn't work.");
        return;
      }
      onOk?.();
      router.refresh();
    });
  }

  const live = assets.filter((a) => !a.disposedOn);
  const totalCost = live.reduce((t, a) => t + Number(a.cost), 0);
  const totalBookValue = live.reduce((t, a) => t + a.bookValue, 0);
  const dueThisMonth = preview.filter((p) => !p.already);
  const chargeTotal = dueThisMonth.reduce((t, p) => t + p.charge, 0);

  return (
    <div className="space-y-4">
      {error && <Card className="border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">{error}</Card>}
      {message && <Card className="border-success/40 bg-success-bg px-4 py-3 text-sm text-success">{message}</Card>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Assets held" value={null} hint={`${live.length} on the register`} />
        <Stat label="At cost" value={totalCost} hint="what was paid" />
        <Stat label="Written down to" value={totalBookValue} hint="what the books say they're worth" />
        <Stat
          label="Written off so far"
          value={totalCost - totalBookValue}
          hint="accumulated depreciation"
        />
      </div>

      {/* ── The run ───────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
          <span>
            Depreciation for {monthName(month)} {year}
          </span>
          <Button
            size="sm"
            disabled={pending || dueThisMonth.length === 0}
            onClick={() =>
              run(async () => {
                const result = await runDepreciation({ month, year });
                if (result.ok) {
                  setMessage(
                    `Charged ${formatCurrency(result.data.total)} across ${result.data.charged} asset(s).` +
                      (result.data.alreadyCharged > 0 ? ` ${result.data.alreadyCharged} already charged for this month.` : "") +
                      (result.data.skipped - result.data.alreadyCharged > 0 ? ` ${result.data.skipped - result.data.alreadyCharged} needed nothing.` : ""),
                  );
                }
                return result;
              })
            }
          >
            <Play className="mr-1.5 h-3.5 w-3.5" />
            {pending ? "Running…" : `Charge ${formatCurrency(chargeTotal)}`}
          </Button>
        </CardHeader>
        <CardContent>
          {preview.length === 0 ? (
            <p className="text-sm text-subtle">
              Nothing to depreciate this month — either the register is empty, or everything on it is fully written
              down.
            </p>
          ) : (
            <>
              <p className="mb-3 text-xs text-muted">
                Safe to run twice: a charge is unique per asset and month, so a second run adds nothing.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                    <tr>
                      <th className="py-2 pr-4">Asset</th>
                      <th className="py-2 pr-4 text-right">Cost</th>
                      <th className="py-2 pr-4 text-right">Written off</th>
                      <th className="py-2 pr-4 text-right">Book value</th>
                      <th className="py-2 text-right">This month</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((p) => (
                      <tr key={p.id} className="border-b border-line last:border-0">
                        <td className="py-2 pr-4">
                          <span className="font-mono text-xs text-subtle">{p.tag}</span> {p.name}
                        </td>
                        <td className="py-2 pr-4 text-right">
                          <Amount value={p.cost} muted />
                        </td>
                        <td className="py-2 pr-4 text-right">
                          <Amount value={p.accumulated} muted />
                        </td>
                        <td className="py-2 pr-4 text-right">
                          <Amount value={p.bookValue} />
                        </td>
                        <td className="py-2 text-right">
                          {p.already ? (
                            <Badge tone="green">Charged</Badge>
                          ) : (
                            <Amount value={p.charge} bold />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── The register ──────────────────────────────────────────────── */}
      <Card className="overflow-hidden p-0">
        <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
          <span className="flex items-center gap-1.5">
            <Boxes className="h-3.5 w-3.5 text-subtle" />
            The register
          </span>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add an asset
          </Button>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-y border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5">Tag</th>
                <th className="px-4 py-2.5">Asset</th>
                <th className="px-4 py-2.5">Bought</th>
                <th className="px-4 py-2.5">Method</th>
                <th className="px-4 py-2.5">Held by</th>
                <th className="px-4 py-2.5 text-right">Cost</th>
                <th className="px-4 py-2.5 text-right">Book value</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => (
                <tr key={a.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                  <td className="px-4 py-2.5 font-mono text-xs text-muted">{a.tag}</td>
                  <td className="px-4 py-2.5">
                    <span className="text-text">{a.name}</span>
                    {a.department && <span className="block text-xs text-subtle">{a.department.name}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{formatCalendarDay(a.purchasedOn)}</td>
                  <td className="px-4 py-2.5 text-muted">
                    {depreciationMethodLabels[a.method]}
                    <span className="block text-xs text-subtle">
                      {a.method === "WRITTEN_DOWN_VALUE" ? `${Number(a.ratePercent ?? 0)}%` : `${a.usefulLifeYears} yr`}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted">{a.custodian?.name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-right">
                    <Amount value={Number(a.cost)} muted />
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Amount value={a.bookValue} bold />
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {a.disposedOn ? (
                      <Badge tone="default">Disposed {formatCalendarDay(a.disposedOn)}</Badge>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setDisposing(a)}
                        className="text-xs text-muted hover:text-text hover:underline"
                      >
                        Dispose
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {assets.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-subtle">
                    Nothing on the register. Add the laptops and equipment the company owns — depreciation then
                    reaches the P&amp;L every month instead of being remembered at year end.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <NewAssetDialog
        open={adding}
        onClose={() => setAdding(false)}
        accounts={accounts}
        departments={departments}
        people={people}
        pending={pending}
        run={run}
      />
      <DisposeDialog asset={disposing} onClose={() => setDisposing(null)} pending={pending} run={run} setMessage={setMessage} />
    </div>
  );
}

function NewAssetDialog({
  open,
  onClose,
  accounts,
  departments,
  people,
  pending,
  run,
}: {
  open: boolean;
  onClose: () => void;
  accounts: { id: string; code: string; name: string }[];
  departments: { id: string; name: string }[];
  people: { id: string; name: string }[];
  pending: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>, onOk?: () => void) => void;
}) {
  const [form, setForm] = useState({
    tag: "",
    name: "",
    description: "",
    // Today in India, not UTC's today: the register and its depreciation keep India's calendar.
    purchasedOn: indiaClock.today(),
    cost: "",
    salvageValue: "",
    usefulLifeYears: "3",
    method: "STRAIGHT_LINE" as DepreciationMethod,
    ratePercent: "40",
    assetAccountId: accounts[0]?.id ?? "",
    departmentId: "",
    custodianUserId: "",
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Dialog open={open} onClose={onClose} title="Add an asset">
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="aTag">Tag</Label>
            <Input id="aTag" value={form.tag} onChange={set("tag")} className="uppercase" placeholder="WRF-LAP-014" />
            <p className="text-xs text-subtle">What&apos;s stuck on the thing itself.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="aName">What it is</Label>
            <Input id="aName" value={form.name} onChange={set("name")} placeholder="ThinkPad T14" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="aDate">Bought on</Label>
            <Input id="aDate" type="date" value={form.purchasedOn} onChange={set("purchasedOn")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="aCost">Cost</Label>
            <Input id="aCost" type="number" value={form.cost} onChange={set("cost")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="aMethod">Method</Label>
            <Select id="aMethod" value={form.method} onChange={set("method")}>
              <option value="STRAIGHT_LINE">Straight line</option>
              <option value="WRITTEN_DOWN_VALUE">Written down value</option>
            </Select>
            <p className="text-xs text-subtle">
              {form.method === "STRAIGHT_LINE"
                ? "The same amount every year — how the Companies Act schedule is usually applied."
                : "A fixed percentage of what's left — how the Income Tax blocks work."}
            </p>
          </div>
          {form.method === "STRAIGHT_LINE" ? (
            <div className="space-y-1.5">
              <Label htmlFor="aLife">Useful life (years)</Label>
              <Input id="aLife" type="number" value={form.usefulLifeYears} onChange={set("usefulLifeYears")} />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="aRate">Rate (% a year)</Label>
              <Input id="aRate" type="number" value={form.ratePercent} onChange={set("ratePercent")} />
              <p className="text-xs text-subtle">40% for computers, 15% for most plant.</p>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="aSalvage">Salvage value</Label>
            <Input id="aSalvage" type="number" value={form.salvageValue} onChange={set("salvageValue")} />
            <p className="text-xs text-subtle">Depreciation stops here. Leave blank if it&apos;ll be worth nothing.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="aAccount">Sits in</Label>
            <Select id="aAccount" value={form.assetAccountId} onChange={set("assetAccountId")}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="aDept">Cost centre</Label>
            <Select id="aDept" value={form.departmentId} onChange={set("departmentId")}>
              <option value="">—</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="aCustodian">Held by</Label>
            <Select id="aCustodian" value={form.custodianUserId} onChange={set("custodianUserId")}>
              <option value="">—</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="aNotes">Notes</Label>
          <Textarea id="aNotes" rows={2} value={form.description} onChange={set("description")} />
        </div>
        <div className="flex gap-2 pt-1">
          <Button
            disabled={pending || !form.tag.trim() || !form.name.trim() || !form.cost}
            onClick={() =>
              run(
                () =>
                  saveAsset({
                    tag: form.tag,
                    name: form.name,
                    description: form.description,
                    purchasedOn: form.purchasedOn,
                    cost: Number(form.cost),
                    salvageValue: Number(form.salvageValue) || 0,
                    usefulLifeYears: Number(form.usefulLifeYears) || 3,
                    method: form.method,
                    ratePercent: form.method === "WRITTEN_DOWN_VALUE" ? Number(form.ratePercent) : undefined,
                    assetAccountId: form.assetAccountId,
                    departmentId: form.departmentId || undefined,
                    custodianUserId: form.custodianUserId || undefined,
                  }),
                onClose,
              )
            }
          >
            {pending ? "Saving…" : "Add"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function DisposeDialog({
  asset,
  onClose,
  pending,
  run,
  setMessage,
}: {
  asset: Asset | null;
  onClose: () => void;
  pending: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>, onOk?: () => void) => void;
  setMessage: (m: string) => void;
}) {
  const [proceeds, setProceeds] = useState("0");
  // A disposal is posted to the books, so today is India's.
  const [date, setDate] = useState(() => indiaClock.today());
  const [note, setNote] = useState("");

  if (!asset) return null;
  const expected = Number(proceeds || 0) - asset.bookValue;

  return (
    <Dialog open onClose={onClose} title={`Dispose of ${asset.tag}`}>
      <div className="space-y-3">
        <p className="text-sm text-muted">
          The cost comes off the books, the depreciation written off against it is cleared, and whatever is left over
          is the gain or loss — which falls out of the figures rather than being typed.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="dDate">Disposed on</Label>
            <Input id="dDate" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dProceeds">Sold for</Label>
            <Input id="dProceeds" type="number" value={proceeds} onChange={(e) => setProceeds(e.target.value)} />
            <p className="text-xs text-subtle">Zero if it was scrapped.</p>
          </div>
        </div>
        <div className="rounded-base border border-line px-3 py-2.5 text-sm">
          <span className="text-muted">Book value today</span>
          <span className="float-right tabular-nums text-text">{formatCurrency(asset.bookValue)}</span>
          <span className="mt-1 block text-muted">
            {expected >= 0 ? "Gain" : "Loss"} on disposal
            <span className={`float-right tabular-nums ${expected >= 0 ? "text-success" : "text-danger"}`}>
              {formatCurrency(Math.abs(expected))}
            </span>
          </span>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dNote">Note</Label>
          <Input id="dNote" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Sold to a staff member" />
        </div>
        <div className="flex gap-2 pt-1">
          <Button
            disabled={pending}
            onClick={() =>
              run(
                async () => {
                  const result = await disposeAsset({
                    id: asset.id,
                    disposedOn: date,
                    proceeds: Number(proceeds) || 0,
                    note,
                  });
                  if (result.ok) {
                    setMessage(
                      `${asset.tag} disposed — ${result.data.gainOrLoss >= 0 ? "gain" : "loss"} of ${formatCurrency(Math.abs(result.data.gainOrLoss))}.`,
                    );
                  }
                  return result;
                },
                onClose,
              )
            }
          >
            {pending ? "Posting…" : "Dispose"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function Stat({ label, value, hint }: { label: string; value: number | null; hint: string }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      {value !== null ? (
        <div className="mt-1 text-xl font-semibold tabular-nums text-text">{formatCurrency(value)}</div>
      ) : (
        <div className="mt-1 text-xl font-semibold text-text">{hint.split(" ")[0]}</div>
      )}
      <div className="mt-0.5 text-xs text-muted">{hint}</div>
    </Card>
  );
}
