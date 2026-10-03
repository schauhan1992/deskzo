"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { FileText, Plus, Trash2 } from "lucide-react";
import {
  deleteBillingMilestone,
  deleteMilestone,
  raiseBillingMilestoneInvoice,
  saveBillingMilestone,
  saveMilestone,
  setMilestoneDone,
} from "@/actions/project";
import { applyTemplateToProject } from "@/actions/project-document";
import { billingStatusLabels, billingStatusTone, milestoneProgress } from "@/lib/projects/status";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { IconButton } from "@/components/ui/icon-button";
import { Checkbox } from "@/components/ui/bulk-select";
import { useClock } from "@/components/time/clock-provider";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";

type Milestone = {
  id: string;
  name: string;
  note: string | null;
  dueDate: string | Date | null;
  completedAt: string | Date | null;
  completedBy: { name: string } | null;
};

type Billing = {
  id: string;
  label: string;
  percent: string | number | null;
  amount: string | number;
  dueOn: string | Date | null;
  status: keyof typeof billingStatusLabels;
  /** "Earned when": the delivery milestone this stage is earned on. */
  deliveryMilestoneId: string | null;
  document: { id: string; docNumber: string; docType: string; status: string; total: string | number } | null;
};

/** What a new stage can start as. Invoiced and paid come from its invoice, never from a picker. */
const NEW_STAGE_STATUSES = ["PENDING", "DUE", "WAIVED"] as const;

const asDate = (v: string | Date | null) => (v ? new Date(v) : null);

/**
 * The plan and the money against it, side by side.
 *
 * Together rather than on separate tabs because on a fixed-price project they are the same
 * conversation: the reason a stage has not been invoiced is almost always that the milestone it
 * depends on has not been signed off.
 */
export function ProjectPlan({
  projectId,
  milestones,
  billing,
  hasType,
  canManage,
  canRaiseInvoice = false,
  now,
}: {
  projectId: string;
  milestones: Milestone[];
  billing: Billing[];
  hasType: boolean;
  canManage: boolean;
  /**
   * Whether "Raise invoice" is offered: this person can edit the billing, Sales Documents is available
   * and they may raise invoices. The page decides; the action checks again.
   */
  canRaiseInvoice?: boolean;
  /**
   * Passed in rather than read here. Reading the clock during render makes the component
   * non-idempotent — React may re-render it at any time, and "overdue" would then flip on a
   * re-render that had nothing to do with the date.
   */
  now: number;
}) {
  const router = useRouter();
  const clock = useClock();
  const progress = milestoneProgress(milestones.map((m) => ({ completedAt: asDate(m.completedAt) })));

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
          Milestones
          {progress.percent !== null && (
            <span className="text-xs font-normal text-muted">
              {progress.done} of {progress.total} · {progress.percent}%
            </span>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {milestones.length === 0 ? (
            <div className="space-y-3 py-4 text-center">
              <p className="text-sm text-muted">No plan yet, so there is no progress to report.</p>
              {canManage && hasType && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={async () => {
                    const result = await applyTemplateToProject(projectId);
                    if (!result.ok) alert(result.error);
                    router.refresh();
                  }}
                >
                  Use this project type&apos;s standard plan
                </Button>
              )}
            </div>
          ) : (
            <>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                <div className="h-full rounded-full bg-brand" style={{ width: `${progress.percent ?? 0}%` }} />
              </div>
              {milestones.map((m) => {
                const done = asDate(m.completedAt);
                const due = asDate(m.dueDate);
                // The due day is typed (midnight UTC): overdue once that day has passed on the workspace's calendar.
                const overdue = !done && due && due.toISOString().slice(0, 10) < clock.today(new Date(now));
                return (
                  <div key={m.id} className="flex items-start gap-2.5 border-b border-line pb-2.5 last:border-0 last:pb-0">
                    <span className="pt-0.5">
                      <Checkbox
                        checked={!!done}
                        disabled={!canManage}
                        onChange={async () => {
                          await setMilestoneDone(m.id, !done);
                          router.refresh();
                        }}
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className={`text-sm ${done ? "text-muted line-through" : "text-text"}`}>{m.name}</div>
                      <div className="mt-0.5 text-xs text-subtle">
                        {/* The due day as typed, held as midnight UTC; when it was done is a moment. */}
                        {due && <span className={overdue ? "text-danger" : ""}>Due {formatCalendarDay(due)}</span>}
                        {done && <span> · done {clock.date(done)}{m.completedBy ? ` by ${m.completedBy.name}` : ""}</span>}
                      </div>
                      {m.note && <p className="mt-0.5 text-xs text-muted">{m.note}</p>}
                    </div>
                    {canManage && (
                      <IconButton
                        icon={Trash2}
                        label="Remove"
                        tone="danger"
                        onClick={async () => {
                          const result = await deleteMilestone(m.id);
                          // Refused while revenue on a billing stage waits for it.
                          if (!result.ok) alert(result.error);
                          router.refresh();
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </>
          )}
          {canManage && <AddMilestone projectId={projectId} nextOrder={milestones.length} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Billing stages</CardHeader>
        <CardContent className="space-y-3">
          {billing.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted">
              Nothing scheduled. Add the stages the contract bills at.
            </p>
          ) : (
            billing.map((b) => (
              <BillingStage
                key={b.id}
                projectId={projectId}
                stage={b}
                milestones={milestones}
                canManage={canManage}
                canRaiseInvoice={canRaiseInvoice}
              />
            ))
          )}
          {billing.length > 0 && (
            <div className="flex justify-between border-t border-line pt-2 text-sm font-semibold text-text">
              <span>Scheduled</span>
              <span>{formatCurrency(billing.reduce((sum, b) => sum + Number(b.amount), 0))}</span>
            </div>
          )}
          {canManage && <AddBilling projectId={projectId} nextOrder={billing.length} milestones={milestones} />}
        </CardContent>
      </Card>
    </div>
  );
}

function AddMilestone({ projectId, nextOrder }: { projectId: string; nextOrder: number }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
      <div className="min-w-40 flex-1 space-y-1.5">
        <Label htmlFor="ms-name">Add a milestone</Label>
        <Input id="ms-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Pilot batch migrated" />
      </div>
      <Input
        aria-label="Due date"
        type="date"
        value={dueDate}
        onChange={(e) => setDueDate(e.target.value)}
        className="w-40"
      />
      <Button
        size="sm"
        variant="secondary"
        disabled={pending || !name.trim()}
        onClick={() =>
          startTransition(async () => {
            await saveMilestone({ projectId, name, dueDate, sortOrder: nextOrder });
            setName("");
            setDueDate("");
            router.refresh();
          })
        }
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

/**
 * One billing stage: what it bills, what it is earned on, and the invoice raised for it.
 *
 * "Earned when" links the stage to a delivery milestone on the left: Revenue & Close waits for that
 * milestone before recognising what the stage invoiced. "Raise invoice" writes the draft and opens it.
 */
function BillingStage({
  projectId,
  stage,
  milestones,
  canManage,
  canRaiseInvoice,
}: {
  projectId: string;
  stage: Billing;
  milestones: Milestone[];
  canManage: boolean;
  canRaiseInvoice: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const earnedOn = milestones.find((m) => m.id === stage.deliveryMilestoneId) ?? null;
  const invoiceable = !stage.document && (stage.status === "PENDING" || stage.status === "DUE") && Number(stage.amount) > 0;

  function linkDelivery(deliveryMilestoneId: string) {
    setError(null);
    startTransition(async () => {
      // The stage as it stands, with only the link changed — the action keeps its status and invoice.
      const result = await saveBillingMilestone({
        id: stage.id,
        projectId,
        label: stage.label,
        amount: String(stage.amount),
        percent: stage.percent !== null ? String(stage.percent) : undefined,
        // Held as midnight UTC of the day typed, so its UTC day is that day, in any zone.
        dueOn: stage.dueOn ? new Date(stage.dueOn).toISOString().slice(0, 10) : undefined,
        deliveryMilestoneId,
      });
      if (!result.ok) setError(result.error);
      router.refresh();
    });
  }

  function raiseInvoice() {
    setError(null);
    startTransition(async () => {
      const result = await raiseBillingMilestoneInvoice(stage.id);
      if (!result.ok) {
        setError(result.error);
        router.refresh();
        return;
      }
      router.push(`/documents/${result.data.id}`);
    });
  }

  return (
    <div className="border-b border-line pb-2.5 last:border-0 last:pb-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm text-text">
            {stage.label}
            {stage.percent !== null && <span className="text-muted"> · {Number(stage.percent)}%</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-subtle">
            <Badge tone={billingStatusTone[stage.status]}>{billingStatusLabels[stage.status]}</Badge>
            {stage.dueOn && <span>due {formatCalendarDay(stage.dueOn)}</span>}
            {stage.document && (
              <Link href={`/documents/${stage.document.id}`} className="text-brand hover:underline">
                {stage.document.docNumber}
              </Link>
            )}
            {!canManage && earnedOn && <span>earned when {earnedOn.name} is done</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="text-sm font-medium text-text">{formatCurrency(Number(stage.amount))}</span>
          {canManage && (
            <IconButton
              icon={Trash2}
              label="Remove"
              tone="danger"
              onClick={async () => {
                setError(null);
                const result = await deleteBillingMilestone(stage.id);
                if (!result.ok) setError(result.error);
                router.refresh();
              }}
            />
          )}
        </div>
      </div>
      {canManage && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {milestones.length > 0 && (
            <label className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-subtle">
              <span className="shrink-0">Earned when</span>
              <Select
                value={stage.deliveryMilestoneId ?? ""}
                onChange={(e) => linkDelivery(e.target.value)}
                disabled={pending}
                className="h-8 min-w-0 flex-1 text-xs"
              >
                <option value="">Not linked to a milestone</option>
                {milestones.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} is done
                  </option>
                ))}
              </Select>
            </label>
          )}
          {canRaiseInvoice && invoiceable && (
            <Button size="sm" variant="secondary" disabled={pending} onClick={raiseInvoice}>
              <FileText className="h-3.5 w-3.5" />
              {pending ? "Raising…" : "Raise invoice"}
            </Button>
          )}
        </div>
      )}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

function AddBilling({ projectId, nextOrder, milestones }: { projectId: string; nextOrder: number; milestones: Milestone[] }) {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<(typeof NEW_STAGE_STATUSES)[number]>("PENDING");
  const [deliveryMilestoneId, setDeliveryMilestoneId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-2 border-t border-line pt-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-32 flex-1 space-y-1.5">
          <Label htmlFor="bill-label">Add a stage</Label>
          <Input id="bill-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="On UAT sign-off" />
        </div>
        <Input
          aria-label="Amount"
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount"
          className="w-32"
        />
        <Select
          aria-label="Billing status"
          value={status}
          onChange={(e) => setStatus(e.target.value as (typeof NEW_STAGE_STATUSES)[number])}
        >
          {NEW_STAGE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {billingStatusLabels[s]}
            </option>
          ))}
        </Select>
        {milestones.length > 0 && (
          <Select
            aria-label="Earned when"
            value={deliveryMilestoneId}
            onChange={(e) => setDeliveryMilestoneId(e.target.value)}
            className="min-w-0 max-w-full sm:w-56"
          >
            <option value="">Earned when… (optional)</option>
            {milestones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} is done
              </option>
            ))}
          </Select>
        )}
        <Button
          size="sm"
          variant="secondary"
          aria-label="Add the stage"
          disabled={pending || !label.trim() || !amount}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const result = await saveBillingMilestone({ projectId, label, amount, status, deliveryMilestoneId, sortOrder: nextOrder });
              if (!result.ok) {
                setError(result.error);
                return;
              }
              setLabel("");
              setAmount("");
              setDeliveryMilestoneId("");
              router.refresh();
            })
          }
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
