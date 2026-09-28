"use client";

import { useId, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { assignSupport, setSupportPriority, setSupportStatus } from "@/actions/platform/console-support";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { SUPPORT_PRIORITY, SUPPORT_STATUS } from "@/lib/console-shared/labels";
import { SUPPORT_PRIORITIES, SUPPORT_STATUSES, type SupportAssigneeOption, type SupportPriorityKey, type SupportStatusKey } from "@/lib/support/types";
import { cn } from "@/lib/utils";

/**
 * A request's status, priority and assignee as three selects that save the moment one is changed —
 * for the staff who act on requests (the page renders pills instead for everybody else, and each
 * action checks the role again).
 *
 * Each select shows the new choice at once and a spinner beside it while it saves; a change made
 * while one is still saving is ignored, and the select is left enabled so focus is not thrown off
 * it. A refusal ("Someone changed it a moment ago") puts the select back to what the page last said
 * and is read out in the region under them. A success is said once in the page notice, and the
 * page refreshes, so the timeline gains its entry.
 */

const UNASSIGNED = "";

const LABEL = "text-sm whitespace-nowrap text-muted";
const SELECT = "h-9 max-w-52 rounded-base border border-line-strong bg-surface px-2.5 text-sm text-text aria-busy:cursor-wait";

type Shown = { status: SupportStatusKey; priority: SupportPriorityKey; assignee: string };

export function RequestControls({
  number,
  status,
  priority,
  assignee,
  assignees,
}: {
  number: number;
  status: SupportStatusKey;
  priority: SupportPriorityKey;
  assignee: { id: string; name: string } | null;
  assignees: SupportAssigneeOption[];
}) {
  const statusAction = useConsoleAction<null>();
  const priorityAction = useConsoleAction<null>();
  const assignAction = useConsoleAction<null>();
  const id = useId();
  const errorId = `${id}-error`;
  const statusId = `${id}-status`;
  const priorityId = `${id}-priority`;
  const assigneeSelectId = `${id}-assignee`;
  const assigneeId = assignee?.id ?? UNASSIGNED;

  // What each select shows: the page's value, or the choice being saved. Re-synced when the page
  // brings back different values (after a save, or somebody else's) — while rendering, not in an effect.
  const saved = `${status}|${priority}|${assigneeId}`;
  const [synced, setSynced] = useState(saved);
  const [shown, setShown] = useState<Shown>({ status, priority, assignee: assigneeId });
  if (saved !== synced) {
    setSynced(saved);
    setShown({ status, priority, assignee: assigneeId });
  }

  const error = statusAction.error ?? priorityAction.error ?? assignAction.error;
  // A refused change shows what the page says, not the choice that was refused.
  const current: Shown = {
    status: statusAction.error ? status : shown.status,
    priority: priorityAction.error ? priority : shown.priority,
    assignee: assignAction.error ? assigneeId : shown.assignee,
  };
  const busy = statusAction.pending || priorityAction.pending || assignAction.pending;

  /** Clears the last refusal, and forgets the choice that was refused, before the next change. */
  function startOver() {
    setShown(current);
    statusAction.reset();
    priorityAction.reset();
    assignAction.reset();
  }

  function changeStatus(next: SupportStatusKey) {
    if (busy) return;
    startOver();
    setShown((s) => ({ ...s, status: next }));
    statusAction.run(() => setSupportStatus(number, next), { success: `Status set to ${SUPPORT_STATUS[next].label.toLowerCase()}.` });
  }

  function changePriority(next: SupportPriorityKey) {
    if (busy) return;
    startOver();
    setShown((s) => ({ ...s, priority: next }));
    priorityAction.run(() => setSupportPriority(number, next), { success: `Priority set to ${SUPPORT_PRIORITY[next].label.toLowerCase()}.` });
  }

  function changeAssignee(next: string) {
    if (busy) return;
    startOver();
    setShown((s) => ({ ...s, assignee: next }));
    const name = assignees.find((a) => a.id === next)?.name;
    assignAction.run(() => assignSupport(number, next || null), { success: next ? `Assigned to ${name ?? "them"}.` : "Unassigned." });
  }

  // Somebody who has it but can no longer be chosen (switched off, or moved off support) is still
  // shown as who has it — as an option that cannot be picked again.
  const former = assignee && !assignees.some((a) => a.id === assignee.id) ? assignee : null;
  const describedBy = error ? errorId : undefined;
  // Written out here rather than inside the props below, where check:a11y would not see them.
  const statusLabel = (
    <label htmlFor={statusId} className={LABEL}>
      Status
    </label>
  );
  const priorityLabel = (
    <label htmlFor={priorityId} className={LABEL}>
      Priority
    </label>
  );
  const assigneeLabel = (
    <label htmlFor={assigneeSelectId} className={LABEL}>
      Assignee
    </label>
  );

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Control label={statusLabel} pending={statusAction.pending}>
          <select
            id={statusId}
            value={current.status}
            onChange={(e) => changeStatus(e.target.value as SupportStatusKey)}
            aria-busy={statusAction.pending || undefined}
            aria-describedby={describedBy}
            className={SELECT}
          >
            {SUPPORT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {SUPPORT_STATUS[s].label}
              </option>
            ))}
          </select>
        </Control>
        <Control label={priorityLabel} pending={priorityAction.pending}>
          <select
            id={priorityId}
            value={current.priority}
            onChange={(e) => changePriority(e.target.value as SupportPriorityKey)}
            aria-busy={priorityAction.pending || undefined}
            aria-describedby={describedBy}
            className={SELECT}
          >
            {SUPPORT_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {SUPPORT_PRIORITY[p].label}
              </option>
            ))}
          </select>
        </Control>
        <Control label={assigneeLabel} pending={assignAction.pending}>
          <select
            id={assigneeSelectId}
            value={current.assignee}
            onChange={(e) => changeAssignee(e.target.value)}
            aria-busy={assignAction.pending || undefined}
            aria-describedby={describedBy}
            className={SELECT}
          >
            <option value={UNASSIGNED}>Unassigned</option>
            {assignees.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
            {former && (
              <option value={former.id} disabled>
                {`${former.name} (no longer on support)`}
              </option>
            )}
          </select>
        </Control>
      </div>
      <div id={errorId} className="w-full sm:max-w-md">
        <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
      </div>
    </div>
  );
}

/** A label, its select, and a spinner beside it while the change saves. */
function Control({ label, pending, children }: { label: ReactNode; pending: boolean; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {label}
      {children}
      <LoaderCircle aria-hidden="true" className={cn("h-3.5 w-3.5 shrink-0 animate-spin text-subtle", !pending && "invisible")} />
    </div>
  );
}
