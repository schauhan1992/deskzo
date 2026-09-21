"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Hand, Play, Plus, Wallet, X } from "lucide-react";
import type { incentiveCapabilities, listEarnings } from "@/actions/incentive";
import { awardOneOff, decideEarning, generateEarnings } from "@/actions/incentive";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { statusLabels, statusTone } from "@/lib/incentives/compute";
import { metricByKey } from "@/lib/targets/metrics";

type Earning = Awaited<ReturnType<typeof listEarnings>>[number];
type Caps = Awaited<ReturnType<typeof incentiveCapabilities>>;

/**
 * The queue of what is owed.
 *
 * Every row carries its own workings, because "₹18,450" on its own invites a conversation nobody
 * can settle. The collection position sits beside it where the scheme depends on one — commission
 * on an invoice the customer never paid is the thing this screen exists to stop.
 */
export function EarningQueue({
  earnings,
  caps,
  people,
}: {
  earnings: Earning[];
  caps: Caps;
  people: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<{ earning: Earning; decision: "HOLD" | "CANCEL" } | null>(null);
  const [awarding, setAwarding] = useState(false);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "That didn't work.");
        return;
      }
      after?.();
      router.refresh();
    });
  }

  const due = earnings.filter((e) => e.status === "DUE");
  const approved = earnings.filter((e) => e.status === "APPROVED");
  const owed = approved.reduce((t, e) => t + Number(e.amount), 0);
  const blocked = approved.filter((e) => !e.payable.payable).length;

  return (
    <div className="space-y-4">
      {error && <Card className="border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">{error}</Card>}
      {message && <Card className="border-success/40 bg-success-bg px-4 py-3 text-sm text-success">{message}</Card>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Waiting on a decision" value={String(due.length)} />
          <Stat label="Approved, not yet paid" value={String(approved.length)} />
          <Stat label="Owed" value={formatCurrency(owed)} />
          <Stat
            label="Held by collection"
            value={String(blocked)}
            hint={blocked > 0 ? "the money isn't in yet" : undefined}
          />
        </div>
      </div>

      {caps.manage && (
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={pending}
            onClick={() =>
              run(async () => {
                const result = await generateEarnings();
                if (result.ok) {
                  setMessage(
                    `Worked out ${result.data.raised} incentive(s) — ${result.data.nil} came to nothing, ${result.data.skipped} were already done.`,
                  );
                }
                return result;
              })
            }
          >
            <Play className="mr-1.5 h-3.5 w-3.5" />
            {pending ? "Working them out…" : "Work out what's owed"}
          </Button>
          <Button variant="secondary" onClick={() => setAwarding(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            One-off award
          </Button>
        </div>
      )}

      <p className="text-xs text-subtle">
        Only finished periods are worked out. An incentive computed mid-month is a figure somebody sees, expects, and
        then watches fall when a late credit note lands.
      </p>

      <div className="space-y-3">
        {earnings.map((e) => (
          <Card key={e.id} className="px-4 py-3.5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/targets/${e.user.id}`} className="font-medium text-text hover:underline">
                    {e.user.name}
                  </Link>
                  <Badge tone={statusTone[e.status]}>{statusLabels[e.status]}</Badge>
                  {e.metric && <span className="text-xs text-subtle">{metricByKey[e.metric].label}</span>}
                </div>
                <p className="mt-0.5 text-xs text-subtle">
                  {e.label}
                  {e.scheme && ` · ${e.scheme.name}`}
                  {e.payslip && ` · paid on the ${e.payslip.run.month}/${e.payslip.run.year} payslip`}
                </p>
              </div>
              <div className="text-right">
                <div className="text-lg font-semibold tabular-nums text-text">{formatCurrency(Number(e.amount))}</div>
                {e.achievedPercent !== null && (
                  <div className="text-xs text-subtle">{Math.round(Number(e.achievedPercent))}% of target</div>
                )}
              </div>
            </div>

            {/* The frozen explanation. This is what makes the figure arguable-with rather than just asserted. */}
            <p className="mt-2 text-sm text-muted">{e.workings}</p>

            {e.heldReason && (
              <p className="mt-1 text-sm text-danger">{e.heldReason}</p>
            )}

            {/* Only where the scheme actually depends on it. */}
            {e.scheme?.requiresCollection && e.status !== "PAID" && (
              <p
                className={`mt-2 flex items-start gap-1.5 text-xs ${e.payable.payable ? "text-success" : "text-warning"}`}
              >
                {!e.payable.payable && <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />}
                {e.payable.reason}
              </p>
            )}

            {caps.approve && e.status !== "PAID" && e.status !== "CANCELLED" && (
              <div className="mt-3 flex flex-wrap gap-2">
                {e.status === "DUE" && (
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() => run(() => decideEarning({ id: e.id, decision: "APPROVE" }))}
                  >
                    <Check className="mr-1.5 h-3.5 w-3.5" />
                    Approve
                  </Button>
                )}
                {e.status === "APPROVED" && (
                  <Button
                    size="sm"
                    disabled={pending || !e.payable.payable}
                    title={e.payable.payable ? undefined : e.payable.reason}
                    onClick={() => run(() => decideEarning({ id: e.id, decision: "PAY" }))}
                  >
                    <Wallet className="mr-1.5 h-3.5 w-3.5" />
                    Mark paid
                  </Button>
                )}
                {e.status !== "HELD" && (
                  <Button size="sm" variant="secondary" onClick={() => setDeciding({ earning: e, decision: "HOLD" })}>
                    <Hand className="mr-1.5 h-3.5 w-3.5" />
                    Hold
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setDeciding({ earning: e, decision: "CANCEL" })}>
                  <X className="mr-1.5 h-3.5 w-3.5" />
                  Cancel
                </Button>
              </div>
            )}

            {e.status === "APPROVED" && e.payable.payable && (
              <p className="mt-2 text-xs text-subtle">
                Will go out on the next payroll run automatically, as a taxable earning on the payslip.
              </p>
            )}
          </Card>
        ))}

        {earnings.length === 0 && (
          <Card className="px-6 py-10 text-center text-sm text-subtle">
            Nothing here. Attach a scheme to a target, and this fills in once the period ends.
          </Card>
        )}
      </div>

      {deciding && (
        <ReasonDialog
          earning={deciding.earning}
          decision={deciding.decision}
          onClose={() => setDeciding(null)}
          pending={pending}
          run={run}
        />
      )}
      {awarding && <AwardDialog people={people} onClose={() => setAwarding(false)} pending={pending} run={run} />}
    </div>
  );
}

function ReasonDialog({
  earning,
  decision,
  onClose,
  pending,
  run,
}: {
  earning: Earning;
  decision: "HOLD" | "CANCEL";
  onClose: () => void;
  pending: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${decision === "HOLD" ? "Hold" : "Cancel"} ${earning.user.name}'s incentive`}
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">
          {formatCurrency(Number(earning.amount))} for {earning.label}.{" "}
          {decision === "HOLD"
            ? "Holding keeps it on the books — it can be released later."
            : "Cancelling closes it off. The row stays, so what was decided can still be read."}
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="reason">Why</Label>
          <Textarea id="reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          <p className="text-xs text-subtle">They&apos;ll be told, and this is what they&apos;ll read.</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={decision === "CANCEL" ? "danger" : "primary"}
            disabled={pending || !reason.trim()}
            onClick={() => run(() => decideEarning({ id: earning.id, decision, reason }), onClose)}
          >
            {decision === "HOLD" ? "Hold it" : "Cancel it"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Back
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function AwardDialog({
  people,
  onClose,
  pending,
  run,
}: {
  people: { id: string; name: string }[];
  onClose: () => void;
  pending: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => void;
}) {
  const [userId, setUserId] = useState("");
  const [amount, setAmount] = useState("");
  const [label, setLabel] = useState("");
  const [reason, setReason] = useState("");

  return (
    <Dialog open onClose={onClose} title="One-off award">
      <div className="space-y-3">
        <p className="text-sm text-muted">
          For something no target produced — a referral, a rescue, a piece of work that deserved it. It goes through
          the same approval and reaches the payslip the same way.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="awho">Who</Label>
            <Select id="awho" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Choose…</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="aamt">How much</Label>
            <Input id="aamt" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="alabel">What to call it</Label>
          <Input id="alabel" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Referral bonus" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="areason">What it&apos;s for</Label>
          <Textarea id="areason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          <p className="text-xs text-subtle">Appears on their payslip explanation.</p>
        </div>
        <div className="flex gap-2">
          <Button
            disabled={pending || !userId || !amount || !reason.trim()}
            onClick={() =>
              run(() => awardOneOff({ userId, amount: Number(amount), label, reason }), onClose)
            }
          >
            Award it
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-text">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </Card>
  );
}
