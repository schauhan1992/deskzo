"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Trash2 } from "lucide-react";
import {
  deleteBillingMilestone,
  deleteMilestone,
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
import { formatCurrency, formatDate } from "@/lib/utils";

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
  document: { id: string; docNumber: string; docType: string; status: string; total: string | number } | null;
};

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
  now,
}: {
  projectId: string;
  milestones: Milestone[];
  billing: Billing[];
  hasType: boolean;
  canManage: boolean;
  /**
   * Passed in rather than read here. Reading the clock during render makes the component
   * non-idempotent — React may re-render it at any time, and "overdue" would then flip on a
   * re-render that had nothing to do with the date.
   */
  now: number;
}) {
  const router = useRouter();
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
                const overdue = !done && due && due.getTime() < now;
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
                        {due && <span className={overdue ? "text-danger" : ""}>Due {formatDate(due)}</span>}
                        {done && <span> · done {formatDate(done)}{m.completedBy ? ` by ${m.completedBy.name}` : ""}</span>}
                      </div>
                      {m.note && <p className="mt-0.5 text-xs text-muted">{m.note}</p>}
                    </div>
                    {canManage && (
                      <IconButton
                        icon={Trash2}
                        label="Remove"
                        tone="danger"
                        onClick={async () => {
                          await deleteMilestone(m.id);
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
              <div key={b.id} className="flex items-start justify-between gap-2 border-b border-line pb-2.5 last:border-0 last:pb-0">
                <div className="min-w-0">
                  <div className="text-sm text-text">
                    {b.label}
                    {b.percent !== null && <span className="text-muted"> · {Number(b.percent)}%</span>}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-subtle">
                    <Badge tone={billingStatusTone[b.status]}>{billingStatusLabels[b.status]}</Badge>
                    {b.dueOn && <span>due {formatDate(asDate(b.dueOn)!)}</span>}
                    {b.document && (
                      <Link href={`/documents/${b.document.id}`} className="text-brand hover:underline">
                        {b.document.docNumber}
                      </Link>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <span className="text-sm font-medium text-text">{formatCurrency(Number(b.amount))}</span>
                  {canManage && (
                    <IconButton
                      icon={Trash2}
                      label="Remove"
                      tone="danger"
                      onClick={async () => {
                        await deleteBillingMilestone(b.id);
                        router.refresh();
                      }}
                    />
                  )}
                </div>
              </div>
            ))
          )}
          {billing.length > 0 && (
            <div className="flex justify-between border-t border-line pt-2 text-sm font-semibold text-text">
              <span>Scheduled</span>
              <span>{formatCurrency(billing.reduce((sum, b) => sum + Number(b.amount), 0))}</span>
            </div>
          )}
          {canManage && <AddBilling projectId={projectId} nextOrder={billing.length} />}
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

function AddBilling({ projectId, nextOrder }: { projectId: string; nextOrder: number }) {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<keyof typeof billingStatusLabels>("PENDING");
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
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
        onChange={(e) => setStatus(e.target.value as keyof typeof billingStatusLabels)}
      >
        {(Object.keys(billingStatusLabels) as (keyof typeof billingStatusLabels)[]).map((s) => (
          <option key={s} value={s}>
            {billingStatusLabels[s]}
          </option>
        ))}
      </Select>
      <Button
        size="sm"
        variant="secondary"
        disabled={pending || !label.trim() || !amount}
        onClick={() =>
          startTransition(async () => {
            await saveBillingMilestone({ projectId, label, amount, status, sortOrder: nextOrder });
            setLabel("");
            setAmount("");
            router.refresh();
          })
        }
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
