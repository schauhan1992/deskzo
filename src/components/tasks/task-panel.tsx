"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, CalendarDays, Clock, Paperclip, Pencil, Star, Trash2, Trophy, X } from "lucide-react";
import {
  addChecklistItem,
  addTaskComment,
  clearTaskReminder,
  setTaskReminder,
  deleteChecklistItem,
  deleteTaskComment,
  deleteTaskFile,
  deleteTaskTime,
  getTaskPanel,
  logTaskTime,
  toggleChecklistItem,
  uploadTaskFile,
  type TaskPanel as Panel,
} from "@/actions/task-extras";
import { deleteTask, setTaskStatus, toggleTaskStar } from "@/actions/task";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { useClock } from "@/components/time/clock-provider";
import { formatCalendarDay } from "@/lib/time/zone";
import { taskDue } from "@/lib/task-due";
import { companyPath, leadPath, ticketPath } from "@/lib/record-links";
import { formatTicketId } from "@/lib/tickets";
import { fileSize } from "@/lib/support-mail/rules";
import {
  PRIORITY_LABELS,
  PRIORITY_TONES,
  REPEAT_LABELS,
  STATUS_LABELS,
  STATUS_TONES,
  TASK_STATUSES,
  effectiveStatus,
  minutesWords,
  REMINDER_REPEAT_LABELS,
  shownStatus,
  TASK_REMINDER_REPEATS,
  type TaskReminderRepeatKey,
  type TaskRepeatKey,
  type TaskStatusKey,
} from "@/lib/tasks/rules";
import { TaskDialog, type TaskFormOptions } from "@/components/tasks/task-dialog";

/**
 * One task in full (owner, 16 Oct 2026): where it stands and who it's for, then its checklist, files,
 * time logged against the estimate, and the conversation on it. Whoever can see a task comments on it;
 * whoever can change it ticks, attaches and logs time.
 */
export function TaskPanel({ taskId, onClose, options }: { taskId: string; onClose: () => void; options: TaskFormOptions }) {
  const router = useRouter();
  const clock = useClock();
  const today = clock.today();
  const [panel, setPanel] = useState<Panel | null | undefined>(undefined);
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let alive = true;
    getTaskPanel(taskId).then((p) => {
      if (alive) setPanel(p);
    });
    return () => {
      alive = false;
    };
  }, [taskId, version]);

  /** A change, then the panel and the page behind it read again. */
  const run = (work: () => Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void) =>
    start(async () => {
      setError(null);
      const result = await work();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      after?.();
      setVersion((v) => v + 1);
      router.refresh();
    });

  if (panel === undefined) {
    return (
      <Dialog open onClose={onClose} title="Task" wide>
        <p className="py-8 text-center text-sm text-subtle">Loading…</p>
      </Dialog>
    );
  }
  if (panel === null) {
    return (
      <Dialog open onClose={onClose} title="Task" wide>
        <p className="py-8 text-center text-sm text-subtle">This task no longer exists, or isn&apos;t one you can see.</p>
      </Dialog>
    );
  }

  const status = effectiveStatus(panel);
  const shown = shownStatus(panel, today);
  const doneSteps = panel.checklist.filter((c) => c.done).length;
  const due = panel.dueDate ? taskDue(panel.dueDate, clock) : null;
  const overdue = !!due && !panel.done && due.key < today;

  return (
    <Dialog open onClose={onClose} title={panel.title} wide>
      <div className="space-y-5">
        {/* Where it stands, and the controls on it. */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => run(() => toggleTaskStar(panel.id))}
            aria-label={panel.starred ? "Unstar" : "Star"}
            className="rounded-base p-1 hover:bg-surface-sunken"
          >
            <Star className={`h-5 w-5 ${panel.starred ? "fill-warning text-warning" : "text-subtle"}`} />
          </button>
          <Badge tone={STATUS_TONES[shown]}>{STATUS_LABELS[shown]}</Badge>
          <Badge tone={PRIORITY_TONES[panel.priority]}>{PRIORITY_LABELS[panel.priority]} priority</Badge>
          {panel.canWork && (
            <Select
              aria-label="Move to"
              value={status}
              onChange={(e) => run(() => setTaskStatus(panel.id, e.target.value))}
              disabled={pending}
              className="h-8 w-40 text-sm"
            >
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          )}
          <span className="ml-auto flex gap-2">
            {panel.canChange && (
              <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(true)}>
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Edit
              </Button>
            )}
            {panel.canDelete && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-danger"
                disabled={pending}
                onClick={() => window.confirm("Delete this task, with its checklist, files, time and comments?") && run(() => deleteTask(panel.id), onClose)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </span>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        {panel.workOnly && (
          <p className="rounded-base bg-surface-sunken px-3 py-2 text-xs text-muted">
            {panel.createdBy.name} gave you this task — move it along, tick its steps, comment, attach files and log your time. Changing it is theirs.
          </p>
        )}

        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Meta label="Assigned to">
            {panel.assignedTo ? (
              <span className="flex items-center gap-2">
                <Avatar user={panel.assignedTo} size="xs" />
                {panel.assignedTo.name}
              </span>
            ) : (
              <span className="text-subtle">Nobody yet</span>
            )}
          </Meta>
          <Meta label="Team">{panel.department?.name ?? <span className="text-subtle">Any</span>}</Meta>
          <Meta label="Challenge">{panel.challenge?.name ?? <span className="text-subtle">None</span>}</Meta>
          <Meta label="Dates">
            <span className="flex flex-wrap items-center gap-1.5">
              <CalendarDays className="h-3.5 w-3.5 text-subtle" />
              {panel.startDate ? formatCalendarDay(panel.startDate) : "—"} → <span className={overdue ? "text-danger" : ""}>{due?.label ?? "—"}</span>
            </span>
          </Meta>
          <Meta label="Time">
            <span className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-subtle" />
              {minutesWords(panel.loggedMinutes)} logged{panel.estimateMinutes ? ` of ${minutesWords(panel.estimateMinutes)}` : ""}
            </span>
          </Meta>
          <Meta label="XP">
            <span className="flex flex-wrap items-center gap-1.5">
              <Trophy className="h-3.5 w-3.5 text-warning" />
              {panel.xp > 0 ? `${panel.xp} XP` : "None"}
              {panel.badge && <Badge tone="brand">{panel.badge}</Badge>}
              {panel.xpEarned !== null && panel.xpEarnedBy && <span className="text-success">— earned by {panel.xpEarnedBy.name}</span>}
            </span>
          </Meta>
          {panel.repeat && (
            <Meta label="Repeats">
              {REPEAT_LABELS[panel.repeat as TaskRepeatKey]}
              {panel.repeatUntil ? `, until ${formatCalendarDay(panel.repeatUntil)}` : ""}
            </Meta>
          )}
          {(panel.company || panel.lead || panel.ticket) && (
            <Meta label="About">
              {panel.company ? (
                <Link className="text-brand hover:underline" href={companyPath(panel.company.companySeq)}>
                  {panel.company.name}
                </Link>
              ) : panel.lead ? (
                <Link className="text-brand hover:underline" href={leadPath(panel.lead.leadSeq)}>
                  {panel.lead.title}
                </Link>
              ) : panel.ticket ? (
                <Link className="text-brand hover:underline" href={ticketPath(panel.ticket.ticketSeq)}>
                  {formatTicketId(panel.ticket.ticketSeq)}
                </Link>
              ) : null}
            </Meta>
          )}
          <Meta label="Made by">
            {panel.createdBy.name}, {clock.date(panel.createdAt)}
          </Meta>
        </dl>

        {panel.description && <p className="whitespace-pre-wrap rounded-base bg-surface-sunken px-3 py-2 text-sm text-text">{panel.description}</p>}

        {!panel.done && (
          <Section title="Reminder">
            <Reminder
              reminder={panel.myReminder}
              pending={pending}
              onSet={(at, repeat) => run(() => setTaskReminder({ taskId: panel.id, at, repeat }))}
              onClear={() => run(() => clearTaskReminder(panel.id))}
            />
          </Section>
        )}

        <Section title={`Checklist${panel.checklist.length ? ` · ${doneSteps}/${panel.checklist.length}` : ""}`}>
          {panel.checklist.length > 0 && (
            <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
              <div className="h-full bg-success" style={{ width: `${Math.round((doneSteps / panel.checklist.length) * 100)}%` }} />
            </div>
          )}
          <ul className="space-y-1">
            {panel.checklist.map((item) => (
              <li key={item.id} className="group flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={item.done}
                  disabled={!panel.canWork || pending}
                  onChange={() => run(() => toggleChecklistItem(item.id))}
                  aria-label={item.title}
                />
                <span className={item.done ? "text-subtle line-through" : "text-text"}>{item.title}</span>
                {panel.canChange && (
                  <button type="button" aria-label="Remove step" onClick={() => run(() => deleteChecklistItem(item.id))} className="ml-auto opacity-0 group-hover:opacity-100">
                    <X className="h-3.5 w-3.5 text-subtle hover:text-danger" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {panel.canChange && <AddLine placeholder="Add a step" onAdd={(text) => run(() => addChecklistItem(panel.id, text))} pending={pending} />}
        </Section>

        <Section title={`Files${panel.attachments.length ? ` · ${panel.attachments.length}` : ""}`}>
          <ul className="flex flex-wrap gap-2">
            {panel.attachments.map((f) => (
              <li key={f.id} className="flex items-center gap-1 rounded-base border border-line px-2 py-1 text-xs">
                <Paperclip className="h-3 w-3 text-subtle" />
                <a href={`/api/tasks/files/${f.id}`} target="_blank" rel="noreferrer" className="text-text hover:underline">
                  {f.fileName}
                </a>
                <span className="text-subtle">({fileSize(f.size)})</span>
                {(f.uploadedBy.id === panel.viewerId || panel.canChange) && (
                  <button type="button" aria-label={`Remove ${f.fileName}`} onClick={() => run(() => deleteTaskFile(f.id))}>
                    <X className="h-3 w-3 text-subtle hover:text-danger" />
                  </button>
                )}
              </li>
            ))}
            {panel.attachments.length === 0 && <li className="text-sm text-subtle">No files yet.</li>}
          </ul>
          {panel.canWork && (
            <label className="mt-2 inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-brand hover:underline">
              <Paperclip className="h-3.5 w-3.5" />
              Attach a file
              <input
                type="file"
                className="sr-only"
                disabled={pending}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  const form = new FormData();
                  form.set("taskId", panel.id);
                  form.set("file", file);
                  run(() => uploadTaskFile(form));
                }}
              />
            </label>
          )}
        </Section>

        <Section title="Time logged">
          {panel.canWork && <LogTime onLog={(minutes, note, day) => run(() => logTaskTime({ taskId: panel.id, minutes, note, spentOn: day }))} pending={pending} today={today} />}
          <ul className="mt-2 space-y-1 text-sm">
            {panel.timeLogs.map((t) => (
              <li key={t.id} className="flex items-center gap-2">
                <span className="w-16 tabular-nums text-text">{minutesWords(t.minutes)}</span>
                <span className="text-muted">
                  {t.user.name} · {formatCalendarDay(t.spentOn)}
                  {t.note ? ` · ${t.note}` : ""}
                </span>
                {t.user.id === panel.viewerId && (
                  <button type="button" aria-label="Remove this time" onClick={() => run(() => deleteTaskTime(t.id))} className="ml-auto">
                    <X className="h-3.5 w-3.5 text-subtle hover:text-danger" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Section>

        <Section title={`Comments${panel.comments.length ? ` · ${panel.comments.length}` : ""}`}>
          <ul className="space-y-3">
            {panel.comments.map((c) => (
              <li key={c.id} className="flex gap-2.5">
                <Avatar user={c.user} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-muted">
                    <span className="font-medium text-text">{c.user.name}</span> · {clock.dateTime(c.createdAt)}
                    {(c.user.id === panel.viewerId || panel.canChange) && (
                      <button type="button" onClick={() => run(() => deleteTaskComment(c.id))} className="ml-2 text-subtle hover:text-danger">
                        Remove
                      </button>
                    )}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-sm text-text">{c.body}</p>
                </div>
              </li>
            ))}
          </ul>
          <AddComment onAdd={(text) => run(() => addTaskComment(panel.id, text))} pending={pending} />
        </Section>
      </div>

      {editing && (
        <TaskDialog
          open
          onClose={() => {
            setEditing(false);
            setVersion((v) => v + 1);
          }}
          options={options}
          viewerId={panel.viewerId}
          task={{ ...panel, status: status as TaskStatusKey, assignedToUserId: panel.assignedToUserId }}
        />
      )}
    </Dialog>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-24 shrink-0 text-xs text-subtle">{label}</dt>
      <dd className="min-w-0 text-text">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line pt-3">
      <h3 className="mb-2 text-sm font-medium text-text">{title}</h3>
      {children}
    </section>
  );
}

function AddLine({ placeholder, onAdd, pending }: { placeholder: string; onAdd: (text: string) => void; pending: boolean }) {
  const [text, setText] = useState("");
  return (
    <form
      className="mt-2 flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        onAdd(text);
        setText("");
      }}
    >
      <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} className="h-8 text-sm" disabled={pending} />
      <Button type="submit" size="sm" variant="secondary" disabled={pending || !text.trim()}>
        Add
      </Button>
    </form>
  );
}

function AddComment({ onAdd, pending }: { onAdd: (text: string) => void; pending: boolean }) {
  const [text, setText] = useState("");
  return (
    <form
      className="mt-3 space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        onAdd(text);
        setText("");
      }}
    >
      <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a comment…" disabled={pending} />
      <Button type="submit" size="sm" disabled={pending || !text.trim()}>
        Comment
      </Button>
    </form>
  );
}

/**
 * Your own reminder on the task (owner, 17 Oct 2026): when, and how often until it's done. It comes as a
 * notification and chimes like a task falling due; nobody else who can see the task is reminded.
 */
function Reminder({
  reminder,
  pending,
  onSet,
  onClear,
}: {
  reminder: { nextAt: Date | string; repeat: TaskReminderRepeatKey } | null;
  pending: boolean;
  onSet: (at: string, repeat: TaskReminderRepeatKey) => void;
  onClear: () => void;
}) {
  const clock = useClock();
  const [changing, setChanging] = useState(false);
  const [at, setAt] = useState(() => (reminder ? clock.input(reminder.nextAt) : ""));
  const [repeat, setRepeat] = useState<TaskReminderRepeatKey>(reminder?.repeat ?? "ONCE");
  if (reminder && !changing) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Bell className="h-4 w-4 text-warning" />
        <span className="text-text">{clock.dateTimeShort(reminder.nextAt)}</span>
        <span className="text-muted">{REMINDER_REPEAT_LABELS[reminder.repeat]}</span>
        <span className="ml-auto flex gap-3">
          <button type="button" className="font-medium text-brand hover:underline" onClick={() => setChanging(true)} disabled={pending}>
            Change
          </button>
          <button type="button" className="font-medium text-muted hover:text-danger" onClick={onClear} disabled={pending}>
            Remove
          </button>
        </span>
      </div>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (at) onSet(at, repeat);
        setChanging(false);
      }}
    >
      <Input type="datetime-local" aria-label="Remind me at" value={at} onChange={(e) => setAt(e.target.value)} className="w-56" disabled={pending} />
      <Select aria-label="How often" value={repeat} onChange={(e) => setRepeat(e.target.value as TaskReminderRepeatKey)} className="w-60" disabled={pending}>
        {TASK_REMINDER_REPEATS.map((r) => (
          <option key={r} value={r}>
            {REMINDER_REPEAT_LABELS[r]}
          </option>
        ))}
      </Select>
      <Button type="submit" size="sm" disabled={pending || !at}>
        {reminder ? "Save" : "Remind me"}
      </Button>
      {reminder && (
        <Button type="button" size="sm" variant="ghost" onClick={() => setChanging(false)} disabled={pending}>
          Cancel
        </Button>
      )}
      <span className="basis-full text-xs text-subtle">Yours alone — it comes as a notification, and stops once the task is done.</span>
    </form>
  );
}

function LogTime({ onLog, pending, today }: { onLog: (minutes: number, note: string, day: string) => void; pending: boolean; today: string }) {
  const [minutes, setMinutes] = useState("");
  const [note, setNote] = useState("");
  const [day, setDay] = useState(today);
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!Number(minutes)) return;
        onLog(Number(minutes), note, day);
        setMinutes("");
        setNote("");
      }}
    >
      <Input type="number" min={1} max={1440} aria-label="Minutes" placeholder="Minutes" value={minutes} onChange={(e) => setMinutes(e.target.value)} className="h-8 w-28 text-sm" disabled={pending} />
      <Input type="date" aria-label="Day" max={today} value={day} onChange={(e) => setDay(e.target.value)} className="h-8 w-40 text-sm" disabled={pending} />
      <Input aria-label="What it was spent on" placeholder="What on (optional)" value={note} onChange={(e) => setNote(e.target.value)} className="h-8 min-w-40 flex-1 text-sm" disabled={pending} />
      <Button type="submit" size="sm" variant="secondary" disabled={pending || !Number(minutes)}>
        Log time
      </Button>
    </form>
  );
}
