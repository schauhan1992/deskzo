"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowUpRight, CheckCircle2, ChevronDown, Circle, Clock, MinusCircle } from "lucide-react";
import type { getCloseMonth } from "@/actions/close";
import { addTaskNote, setTaskOwner, setTaskStatus } from "@/actions/close";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { PersonCombobox, type PersonOption } from "@/components/ui/person-combobox";
import { AUTO_CHECK_LABELS, CHECKED_AUTOMATICALLY, isAutoCheckKey } from "@/lib/close/catalogue";
import { cn } from "@/lib/utils";
import { CheckDetailView, asCheckDetail } from "@/components/close/check-detail";
import { TaskAttachments } from "@/components/close/task-attachments";
import { dayShort, monthOfKey, whenLong } from "@/components/close/format";

type CloseMonthView = NonNullable<Awaited<ReturnType<typeof getCloseMonth>>>;
export type CloseTaskView = CloseMonthView["tasks"][number];

/**
 * A month's checklist: every task with its owner, due date and status, and — opened — what its
 * automatic check found, its notes and its files.
 *
 * Overdue is said in words as well as amber, and a task a check ticked says so ("Checked
 * automatically"), so nobody mistakes the Automation account's tick for a person's sign-off.
 */
export function CloseChecklist({
  monthKey,
  closed,
  tasks,
  canWork,
  people,
  focusTaskId,
}: {
  monthKey: string;
  closed: boolean;
  tasks: CloseTaskView[];
  canWork: boolean;
  people: PersonOption[];
  focusTaskId: string | null;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(focusTaskId ? [focusTaskId] : []));

  // A notification links straight to its task: open, and scrolled to.
  useEffect(() => {
    if (!focusTaskId) return;
    document.getElementById(`task-${focusTaskId}`)?.scrollIntoView({ block: "start" });
  }, [focusTaskId]);

  function toggle(id: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (tasks.length === 0) {
    return (
      <Card className="px-6 py-10 text-center text-sm text-muted">
        This month has no checklist. Tasks are copied from the checklist templates in Settings → Month-end checklist; with
        none active, there is nothing to tick.
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden p-0">
      <ul aria-label={`Checklist for ${monthOfKey(monthKey, "long")}`}>
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            monthKey={monthKey}
            task={task}
            expanded={open.has(task.id)}
            onToggle={() => toggle(task.id)}
            editable={canWork && !closed}
            people={people}
          />
        ))}
      </ul>
    </Card>
  );
}

function StatusIcon({ task }: { task: CloseTaskView }) {
  if (task.status === "DONE") return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />;
  if (task.status === "NOT_APPLICABLE") return <MinusCircle className="mt-0.5 h-4 w-4 shrink-0 text-subtle" aria-hidden />;
  if (task.autoOk === false || task.overdue) return <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />;
  return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-subtle" aria-hidden />;
}

function statusBadge(task: CloseTaskView) {
  if (task.status === "DONE") return <Badge tone="green">Done</Badge>;
  if (task.status === "NOT_APPLICABLE") return <Badge tone="default">Not applicable</Badge>;
  return <Badge tone="blue">To do</Badge>;
}

/** "Checked automatically · 2 Oct 2026, 6:10 am", or who marked it and when. */
function doneLine(task: CloseTaskView): string | null {
  if (task.status === "TODO") return null;
  const when = task.doneAt ? ` · ${whenLong(task.doneAt)}` : "";
  if (task.status === "DONE" && task.doneBy?.automatic) return `${CHECKED_AUTOMATICALLY}${when}`;
  const what = task.status === "DONE" ? "Marked done" : "Marked not applicable";
  return `${what}${task.doneBy ? ` ${task.doneBy.name}` : ""}${when}`;
}

function TaskRow({
  monthKey,
  task,
  expanded,
  onToggle,
  editable,
  people,
}: {
  monthKey: string;
  task: CloseTaskView;
  expanded: boolean;
  onToggle: () => void;
  editable: boolean;
  people: PersonOption[];
}) {
  const detail = asCheckDetail(task.autoDetail);
  const done = doneLine(task);
  const panelId = `task-${task.id}-panel`;
  // The close's own links (the Flux tab) stay on this month.
  const href = task.href?.startsWith("/accounting/close") ? `/accounting/close?month=${monthKey}&tab=flux` : task.href;
  return (
    <li id={`task-${task.id}`} className="scroll-mt-20 border-b border-line last:border-0">
      <div className="flex items-start gap-3 px-4 py-3">
        <StatusIcon task={task} />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={panelId}
            className="text-left text-sm font-medium text-text hover:underline"
          >
            {task.title}
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span className="inline-flex items-center gap-1.5">
              {task.owner ? <Avatar user={task.owner} size="xs" /> : null}
              {task.owner ? task.owner.name : <span className="text-subtle">No owner</span>}
            </span>
            <span>Due {dayShort(task.dueOn)}</span>
            {statusBadge(task)}
            {task.overdue && (
              <Badge tone="amber">
                <Clock className="h-3 w-3" aria-hidden />
                Overdue
              </Badge>
            )}
            {task.attachments.length > 0 && (
              <span>
                {task.attachments.length} file{task.attachments.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          {done && <p className="mt-1 text-xs text-subtle">{done}</p>}
          {task.status === "TODO" && detail && task.autoOk !== true && (
            <p className="mt-1 text-xs text-warning">{detail.summary}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? `Hide ${task.title}` : `Show ${task.title}`}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="rounded-base p-1 text-subtle hover:bg-surface-sunken hover:text-text"
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} aria-hidden />
        </button>
      </div>
      <div id={panelId} hidden={!expanded} className="space-y-4 border-t border-line bg-surface-sunken/40 px-4 py-4">
        {task.description && <p className="max-w-3xl text-sm text-muted">{task.description}</p>}

        <section className="space-y-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-subtle">
            {isAutoCheckKey(task.autoCheck) ? "Automatic check" : "Done by hand"}
          </h4>
          {isAutoCheckKey(task.autoCheck) ? (
            <>
              <p className="text-sm text-muted">
                {AUTO_CHECK_LABELS[task.autoCheck]}.
                {task.autoCheckedAt && <span className="ml-1 text-xs text-subtle">Last checked {whenLong(task.autoCheckedAt)}.</span>}
              </p>
              {detail ? <CheckDetailView detail={detail} ok={task.autoOk} /> : <p className="text-sm text-subtle">Not checked yet.</p>}
            </>
          ) : (
            <p className="text-sm text-muted">Nothing checks this one for you: tick it when it&apos;s done, or mark it not applicable with a reason.</p>
          )}
          {href && (
            <Link href={href} className="inline-flex items-center gap-1 text-sm text-brand hover:underline">
              Open the page it&apos;s done on
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          )}
        </section>

        {task.note && (
          <section className="space-y-1">
            <h4 className="text-xs font-medium uppercase tracking-wide text-subtle">Notes</h4>
            <p className="max-w-3xl whitespace-pre-wrap break-words text-sm text-text">{task.note}</p>
          </section>
        )}

        {editable && <TaskControls task={task} people={people} />}

        <TaskAttachments taskId={task.id} attachments={task.attachments} canEdit={editable} />
      </div>
    </li>
  );
}

/** Ticking, "not applicable" with its reason, the owner and a note — `close.work`, while the month is open. */
function TaskControls({ task, people }: { task: CloseTaskView; people: PersonOption[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notApplicable, setNotApplicable] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const ids = { reason: `task-${task.id}-na`, note: `task-${task.id}-note`, owner: `task-${task.id}-owner` };

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, onOk?: () => void) {
    setError(null);
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

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {task.status === "TODO" ? (
          <>
            <Button size="sm" disabled={pending} onClick={() => run(() => setTaskStatus(task.id, "DONE"))}>
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
              Mark done
            </Button>
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => setNotApplicable((v) => !v)} aria-expanded={notApplicable}>
              Not applicable…
            </Button>
          </>
        ) : (
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => setTaskStatus(task.id, "TODO"))}>
            Back to to-do
          </Button>
        )}
      </div>

      {notApplicable && task.status === "TODO" && (
        <div className="max-w-xl space-y-1.5">
          <Label htmlFor={ids.reason}>Why it doesn&apos;t apply this month</Label>
          <Textarea id={ids.reason} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} placeholder="No payroll: the team is paid by the parent company" />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={pending || !reason.trim()}
              onClick={() =>
                run(
                  () => setTaskStatus(task.id, "NOT_APPLICABLE", reason),
                  () => {
                    setNotApplicable(false);
                    setReason("");
                  },
                )
              }
            >
              Mark not applicable
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setNotApplicable(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={ids.owner}>Owner</Label>
          <PersonCombobox
            id={ids.owner}
            people={people}
            value={task.owner?.id ?? ""}
            disabled={pending}
            placeholder="Nobody yet — search by name"
            onSelect={(person) => {
              const next = person?.id ?? null;
              if (next === (task.owner?.id ?? null)) return;
              run(() => setTaskOwner(task.id, next));
            }}
          />
          <p className="text-xs text-subtle">They&apos;re told when it&apos;s theirs, two days before it&apos;s due, and when it&apos;s overdue.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.note}>Add a note</Label>
          <Textarea id={ids.note} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder="Agreed to the HDFC statement; two cheques uncleared" />
          <Button size="sm" variant="secondary" disabled={pending || !note.trim()} onClick={() => run(() => addTaskNote(task.id, note), () => setNote(""))}>
            Add note
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
