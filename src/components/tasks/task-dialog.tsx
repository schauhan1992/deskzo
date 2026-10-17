"use client";

import { useMemo, useState, useTransition } from "react";
import { Bell, CalendarClock, Link2, ListChecks, Repeat, Trophy, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { createTask, updateTask } from "@/actions/task";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Select, Textarea } from "@/components/ui/input";
import { TaskAboutPicker, aboutIds, type About } from "@/components/tasks/task-about-picker";
import {
  PRIORITY_LABELS,
  REMINDER_REPEAT_LABELS,
  REPEAT_LABELS,
  STATUS_LABELS,
  TASK_PRIORITIES,
  TASK_REMINDER_REPEATS,
  TASK_REPEATS,
  TASK_STATUSES,
  XP_MAX,
  dayKeyOf,
  type TaskPriorityKey,
  type TaskReminderRepeatKey,
  type TaskStatusKey,
} from "@/lib/tasks/rules";

export type TaskFormOptions = {
  departments: { id: string; name: string }[];
  challenges: { id: string; name: string; departmentId: string | null }[];
  people: { id: string; name: string; departmentId: string | null }[];
};

/** A task as the form edits it. */
export type TaskFormTask = {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatusKey;
  priority: TaskPriorityKey;
  startDate: Date | string | null;
  dueDate: Date | string | null;
  estimateMinutes: number | null;
  departmentId: string | null;
  challengeId: string | null;
  assignedToUserId: string | null;
  xp: number;
  badge: string | null;
  repeat: string | null;
  repeatUntil: Date | string | null;
  /** What it's about, where the list knows (the Tasks page does). */
  company?: { id: string; name: string } | null;
  lead?: { id: string; title: string } | null;
  ticket?: { id: string; title: string } | null;
};

/** The record a task is about, as the picker shows it — the most specific of ticket, lead and company. */
function aboutOf(task: TaskFormTask | null): About | null {
  if (task?.ticket) return { kind: "ticket", id: task.ticket.id, label: task.ticket.title };
  if (task?.lead) return { kind: "lead", id: task.lead.id, label: task.lead.title };
  if (task?.company) return { kind: "company", id: task.company.id, label: task.company.name };
  return null;
}

const dayInput = (value: Date | string | null | undefined) => (value ? dayKeyOf(value) : "");

/**
 * Making or changing a task (owner, 16 Oct 2026): its status, team and the person in it, the challenge
 * it counts towards, its dates, estimate, XP and badge, whether it repeats, and what it's about. XP is
 * for somebody else to set: on a task assigned to the viewer, the XP and badge aren't offered at all.
 */
export function TaskDialog({
  open,
  onClose,
  options,
  viewerId,
  task = null,
  link = {},
}: {
  open: boolean;
  onClose: () => void;
  options: TaskFormOptions;
  viewerId: string;
  task?: TaskFormTask | null;
  /** The record a new task is made on (a company, a lead, a ticket). */
  link?: { companyId?: string; leadId?: string; ticketId?: string };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(task?.title ?? "");
  const [status, setStatus] = useState<TaskStatusKey>(task?.status ?? "TODO");
  const [priority, setPriority] = useState<TaskPriorityKey>(task?.priority ?? "MEDIUM");
  const [departmentId, setDepartmentId] = useState(task?.departmentId ?? "");
  const [challengeId, setChallengeId] = useState(task?.challengeId ?? "");
  const [assignee, setAssignee] = useState(task?.assignedToUserId ?? "");
  const [startDate, setStartDate] = useState(dayInput(task?.startDate));
  const [dueDate, setDueDate] = useState(dayInput(task?.dueDate));
  const [estimate, setEstimate] = useState(task?.estimateMinutes ? String(task.estimateMinutes) : "");
  const [xp, setXp] = useState(task ? String(task.xp) : "0");
  const [badge, setBadge] = useState(task?.badge ?? "");
  const [repeat, setRepeat] = useState(task?.repeat ?? "");
  const [repeatUntil, setRepeatUntil] = useState(dayInput(task?.repeatUntil));
  const [description, setDescription] = useState(task?.description ?? "");
  const [about, setAbout] = useState<About | null>(() => aboutOf(task));
  const [steps, setSteps] = useState("");
  // A reminder for whoever makes it — new tasks only; the task panel sets and changes one after.
  const [remindAt, setRemindAt] = useState("");
  const [remindRepeat, setRemindRepeat] = useState<TaskReminderRepeatKey>("ONCE");
  // Made on a record's page, the task is about that record — no picker.
  const madeOnRecord = !!(link.companyId || link.leadId || link.ticketId);

  // A team narrows the people and the challenges to its own; with none, everybody and every one.
  const people = useMemo(
    () => (departmentId ? options.people.filter((p) => p.departmentId === departmentId || p.id === assignee) : options.people),
    [options.people, departmentId, assignee],
  );
  const challenges = useMemo(
    () => (departmentId ? options.challenges.filter((c) => !c.departmentId || c.departmentId === departmentId || c.id === challengeId) : options.challenges),
    [options.challenges, departmentId, challengeId],
  );
  // Nobody sets the XP on their own task, so on one assigned to the viewer the XP and badge aren't offered
  // — what the task already carries goes back unchanged (src/actions/task.ts, OWN_XP).
  const ownTask = assignee === viewerId;

  // The form's essentials stay in view; the rest is a click away (owner, 17 Oct 2026: the whole form
  // didn't fit without scrolling). A section already holding something starts open, so an edit shows it.
  type SectionKey = "schedule" | "xp" | "repeat" | "reminder" | "about" | "checklist";
  const sections = [
    { key: "schedule", label: "Start & estimate", icon: CalendarClock },
    ...(ownTask ? [] : [{ key: "xp", label: "XP & badge", icon: Trophy }]),
    { key: "repeat", label: "Repeat", icon: Repeat },
    ...(task ? [] : [{ key: "reminder", label: "Reminder", icon: Bell }]),
    ...(madeOnRecord ? [] : [{ key: "about", label: "About", icon: Link2 }]),
    ...(task ? [] : [{ key: "checklist", label: "Checklist", icon: ListChecks }]),
  ] as { key: SectionKey; label: string; icon: LucideIcon }[];
  const [shown, setShown] = useState<Set<SectionKey>>(
    () =>
      new Set<SectionKey>([
        ...(task?.startDate || task?.estimateMinutes ? (["schedule"] as const) : []),
        ...((task?.xp ?? 0) > 0 || task?.badge ? (["xp"] as const) : []),
        ...(task?.repeat ? (["repeat"] as const) : []),
        ...(aboutOf(task) ? (["about"] as const) : []),
      ]),
  );
  // Only what this form offers opens — an own task's XP stays shut though it carries some.
  const isOpen = (key: SectionKey) => shown.has(key) && sections.some((s) => s.key === key);
  const toggle = (key: SectionKey) =>
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  function save() {
    setError(null);
    const fields = {
      title,
      description,
      dueDate,
      assignedToUserId: assignee,
      status,
      priority,
      startDate,
      estimateMinutes: estimate ? Number(estimate) : null,
      departmentId,
      challengeId,
      xp: ownTask ? (task?.xp ?? 0) : Number(xp) || 0,
      badge: ownTask ? (task?.badge ?? "") : badge,
      repeat,
      repeatUntil: repeat ? repeatUntil : "",
    };
    start(async () => {
      // The link goes only where the form decides it: a new task's, or one changed on an edit — an edit
      // that leaves it alone sends none, so a task stays on a record its editor can't open.
      const aboutChanged = JSON.stringify(aboutIds(about)) !== JSON.stringify(aboutIds(aboutOf(task)));
      const checklist = steps.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const result = task
        ? await updateTask({ id: task.id, ...fields, ...(aboutChanged ? { about: aboutIds(about) } : {}) })
        : await createTask({ ...fields, ...(madeOnRecord ? link : aboutIds(about)), steps: checklist, ...(remindAt ? { remindAt, remindRepeat } : {}) });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onClose={onClose} title={task ? "Edit task" : "New task"} large>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {/* What it is: the name, and a line or two about it. */}
        <div className="space-y-2">
          <Input aria-label="Task name" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task name — what needs doing" autoFocus disabled={pending} className="h-11 text-base font-medium" />
          <Textarea aria-label="Description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description — what done looks like (optional)" disabled={pending} />
        </div>

        {/* Who, when and how urgent; where it sits. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="Assigned to">
            <Select value={assignee} onChange={(e) => setAssignee(e.target.value)} disabled={pending}>
              <option value="">Nobody yet</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.id === viewerId ? " (you)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Due date">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} disabled={pending} />
          </Field>
          <Field label="Priority">
            <Select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriorityKey)} disabled={pending}>
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as TaskStatusKey)} disabled={pending}>
              {(task ? TASK_STATUSES : (["TODO", "IN_PROGRESS"] as const)).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Team">
            <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} disabled={pending}>
              <option value="">Any team</option>
              {options.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Challenge">
            <Select value={challengeId} onChange={(e) => setChallengeId(e.target.value)} disabled={pending}>
              <option value="">None</option>
              {challenges.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {/* The rest, a click away — each opens where it is; one already holding something starts open. */}
        <div className="flex flex-wrap gap-2">
          {sections.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => toggle(s.key)}
              aria-expanded={isOpen(s.key)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${isOpen(s.key) ? "border-brand bg-brand-soft text-brand" : "border-line text-muted hover:border-line-strong hover:text-text"}`}
            >
              <s.icon className="h-3.5 w-3.5" />
              {s.label}
            </button>
          ))}
        </div>

        {sections.some((s) => isOpen(s.key)) && (
          <div className="space-y-3 rounded-base border border-line bg-surface-sunken/50 p-3">
            {isOpen("schedule") && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Start date" hint="Before it, the task shows as Upcoming.">
                  <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} disabled={pending} />
                </Field>
                <Field label="Estimate (minutes)" hint={estimate && Number(estimate) >= 60 ? `${(Number(estimate) / 60).toFixed(1)} hours` : undefined}>
                  <Input type="number" min={0} step={5} value={estimate} onChange={(e) => setEstimate(e.target.value)} placeholder="e.g. 90" disabled={pending} />
                </Field>
              </div>
            )}
            {isOpen("xp") && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Earned XP" hint="When it's done by its due date.">
                  <Input type="number" min={0} max={XP_MAX} value={xp} onChange={(e) => setXp(e.target.value)} disabled={pending} />
                </Field>
                <Field label="Badge">
                  <Input value={badge} onChange={(e) => setBadge(e.target.value)} placeholder="e.g. Bug squasher" maxLength={40} disabled={pending} />
                </Field>
              </div>
            )}
            {isOpen("repeat") && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Repeats">
                  <Select value={repeat} onChange={(e) => setRepeat(e.target.value)} disabled={pending}>
                    <option value="">Doesn&apos;t repeat</option>
                    {TASK_REPEATS.map((r) => (
                      <option key={r} value={r}>
                        {REPEAT_LABELS[r]}
                      </option>
                    ))}
                  </Select>
                </Field>
                {repeat && (
                  <Field label="Until (optional)">
                    <Input type="date" value={repeatUntil} onChange={(e) => setRepeatUntil(e.target.value)} disabled={pending} />
                  </Field>
                )}
              </div>
            )}
            {isOpen("reminder") && (
              // Not a <label>: a time and how often.
              <div className="space-y-1">
                <span className="block text-xs font-medium text-muted">Remind me</span>
                <div className="grid grid-cols-2 gap-3">
                  <Input type="datetime-local" aria-label="Remind me at" value={remindAt} onChange={(e) => setRemindAt(e.target.value)} disabled={pending} />
                  <Select aria-label="How often" value={remindRepeat} onChange={(e) => setRemindRepeat(e.target.value as TaskReminderRepeatKey)} disabled={pending || !remindAt}>
                    {TASK_REMINDER_REPEATS.map((r) => (
                      <option key={r} value={r}>
                        {REMINDER_REPEAT_LABELS[r]}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
            )}
            {isOpen("about") && (
              // Not a <label>: the picker holds a choice, a search and its results.
              <div className="space-y-1">
                <span className="block text-xs font-medium text-muted">About — a company, lead or ticket</span>
                <TaskAboutPicker value={about} onChange={setAbout} disabled={pending} />
              </div>
            )}
            {isOpen("checklist") && (
              <Field label="Checklist — a step a line">
                <Textarea rows={3} value={steps} onChange={(e) => setSteps(e.target.value)} placeholder={"Collect the documents\nPrepare the working\nSend it for review"} disabled={pending} />
              </Field>
            )}
          </div>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
          {ownTask && <span className="mr-auto text-xs text-subtle">It&apos;s your task — its XP is for somebody else to set.</span>}
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || title.trim().length < 2}>
            {pending ? "Saving…" : task ? "Save task" : "Create task"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function Field({ label, required = false, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    // One <label> round its input names it; the text inside is a span, not a second label.
    <label className="block space-y-1">
      <span className="flex items-center gap-0.5 text-xs font-medium text-muted">
        {label}
        {required && <span className="text-danger">*</span>}
      </span>
      {children}
      {hint && <span className="block text-[11px] text-subtle">{hint}</span>}
    </label>
  );
}
