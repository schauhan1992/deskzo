"use client";

import { useId, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { consoleGrantAiCredits } from "@/actions/platform/console-ai";
import { Panel } from "@/components/console/kit/panel";
import { StatusPill } from "@/components/console/kit/status";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { creditsText, featureLabel } from "@/lib/ai/catalogue";
import type { ConsoleCreditView } from "@/lib/ai/credits";
import { formatMoney } from "@/lib/billing/money";
import { useClock } from "@/components/time/clock-provider";

const SOURCE: Record<string, string> = { RAZORPAY: "Bought (Razorpay)", STRIPE: "Bought (Stripe)", OFFLINE: "Paid by bank transfer", STAFF: "Given by staff" };

/**
 * Workspace 360 › Usage: the workspace's Deskzo AI credits this month on its own clock (src/lib/ai), its
 * packs, what it used by feature and model, and — for sellers — credits added by hand, always with a reason.
 */
export function AiCreditsPanel({ tenantId, view, canGrant }: { tenantId: string; view: ConsoleCreditView; canGrant: boolean }) {
  const clock = useClock();
  const [granting, setGranting] = useState(false);
  const used = view.allowanceUsed + view.packsUsed + view.overdraft;
  return (
    <Panel
      title={`Deskzo AI credits, ${view.month}`}
      description="The plan's allowance renews on the workspace's 1st; packs are used after it and last twelve months. Turns already under way when nothing was left are absorbed as overdraft."
      actions={
        canGrant ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => setGranting(true)}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            Add credits
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4 text-sm">
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            Allowance: {view.allowance === null ? "no limit" : `${creditsText(view.allowanceUsed)} of ${creditsText(view.allowance)} used`}
          </span>
          <span>Packs left: {creditsText(view.packsRemaining)}</span>
          <span>Used this month: {creditsText(used)}</span>
          {view.overdraft > 0 && <StatusPill tone="warning">{`Overdraft ${creditsText(view.overdraft)}`}</StatusPill>}
          <span className="text-muted">Renews {clock.date(view.renewsAt)}</span>
        </p>
        {view.byModel.length > 0 && (
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-1.5">Feature</th>
                <th className="py-1.5">Model</th>
                <th className="py-1.5 text-right">Turns</th>
                <th className="py-1.5 text-right">Credits</th>
                <th className="py-1.5 text-right">Cost to Deskzo</th>
              </tr>
            </thead>
            <tbody>
              {view.byModel.map((m) => (
                <tr key={`${m.feature}|${m.modelKey}`} className="border-b border-line last:border-0">
                  <td className="py-1.5">{featureLabel(m.feature)}</td>
                  <td className="py-1.5 font-mono text-[12px]">{m.modelKey}</td>
                  <td className="py-1.5 text-right tabular-nums">{m.turns.toLocaleString("en-IN")}</td>
                  <td className="py-1.5 text-right tabular-nums">{creditsText(m.credits)}</td>
                  <td className="py-1.5 text-right tabular-nums">{m.cost === null ? "—" : formatMoney(m.cost, "INR")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {view.packs.length > 0 && (
          <ul className="space-y-1 text-xs text-muted">
            {view.packs.map((p) => (
              <li key={p.id}>
                {creditsText(p.credits)} credits — {SOURCE[p.source] ?? p.source}, {clock.date(p.createdAt)}; {creditsText(p.remaining)} left
                {p.expiresAt <= new Date() ? ", lapsed" : `, until ${clock.date(p.expiresAt)}`}
                {p.reason ? ` · “${p.reason}”` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
      {granting && <GrantDialog tenantId={tenantId} onClose={() => setGranting(false)} />}
    </Panel>
  );
}

function GrantDialog({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const [credits, setCredits] = useState("");
  const [reason, setReason] = useState("");
  const [paid, setPaid] = useState(false);
  const grant = useConsoleAction<null>();
  const id = useId();

  function submit(e: FormEvent) {
    e.preventDefault();
    grant.run(() => consoleGrantAiCredits({ tenantId, credits: Number(credits), reason, paid }), { success: "Credits added.", onDone: onClose });
  }

  return (
    <Dialog open onClose={() => !grant.pending && onClose()} title="Add Deskzo AI credits">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-credits`}>Credits</Label>
          <Input id={`${id}-credits`} inputMode="numeric" value={credits} onChange={(e) => setCredits(e.target.value)} readOnly={grant.pending} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-reason`}>Why</Label>
          <Input id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="A pack paid by NEFT, UTR …; goodwill for an outage" readOnly={grant.pending} />
          <p className="text-xs text-muted">Kept with the credits, and in the audit log.</p>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={paid} onChange={(e) => setPaid(e.target.checked)} disabled={grant.pending} />
          <span>Paid by bank transfer (otherwise given). Record the payment&apos;s invoice separately.</span>
        </label>
        <ActionNoticeRegion notice={grant.error ? { tone: "error", message: grant.error } : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={grant.pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={grant.pending}>
            {grant.pending ? "Adding…" : "Add credits"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
