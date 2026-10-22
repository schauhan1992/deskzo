"use client";

import { useId, useState, useTransition } from "react";
import type { z } from "zod";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { createTaskSchema, updateTaskSchema, type CreateTaskInput, type UpdateTaskInput } from "@/lib/validation/task";
import { createTask, updateTask, setTaskStatus, deleteTask } from "@/actions/task";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton, RowActions } from "@/components/ui/icon-button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { useClock } from "@/components/time/clock-provider";
import { formatTicketId } from "@/lib/tickets";
import { companyPath, leadPath, ticketPath } from "@/lib/record-links";
import { taskDue } from "@/lib/task-due";
import type { Clock } from "@/lib/time/zone";
import { STATUS_LABELS, STATUS_TONES, TASK_STATUSES, effectiveStatus, type TaskStatusKey } from "@/lib/tasks/rules";
import { useStatusMove } from "@/components/tasks/status-note";

type AssignableUser = { id: string; name: string; role: string };

export type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  dueDate: Date | string | null;
  done: boolean;
  doneAt: Date | string | null;
  createdAt: Date | string;
  assignedTo: { id: string; name: string } | null;
  createdBy: { id: string; name: string };
  company: { id: string; name: string; companySeq: number } | null;
  lead: { id: string; title: string; leadSeq: number } | null;
  ticket: { id: string; ticketSeq: number; title: string } | null;
  /** To do, In progress, Need help, Done or Cancelled (src/lib/tasks/rules.ts) — read with `done`. */
  status?: TaskStatusKey | null;
  /** Why it's stuck or cancelled: the note its move left (owner, 22 Oct 2026). */
  statusNote?: { text: string; by: string; at: Date | string } | null;
  /** Given to the viewer by somebody else: theirs to move along, not to change or delete (src/lib/tasks/rules.ts). */
  workOnly?: boolean;
  /** What the viewer may do with it (src/lib/tasks/server.ts, taskRights), where the list was given it. */
  canWork?: boolean;
  canChange?: boolean;
  canDelete?: boolean;
};

type AddFormValues = z.input<typeof createTaskSchema>;
type EditFormValues = z.input<typeof updateTaskSchema>;

/** Overdue or due today by the workspace's calendar, not the browser's. */
function dueBadge(task: TaskRow, clock: Clock) {
  if (task.done) return null;
  if (!task.dueDate) return null;
  const due = taskDue(task.dueDate, clock).key;
  const today = clock.today();
  if (due < today) return <Badge tone="red">Overdue</Badge>;
  if (due === today) return <Badge tone="amber">Due today</Badge>;
  return null;
}

function LinkedRecord({ task }: { task: TaskRow }) {
  if (task.company) {
    return (
      <Link href={companyPath(task.company.companySeq)} className="hover:underline">
        {task.company.name}
      </Link>
    );
  }
  if (task.lead) {
    return (
      <Link href={leadPath(task.lead.leadSeq)} className="hover:underline">
        {task.lead.title}
      </Link>
    );
  }
  if (task.ticket) {
    return (
      <Link href={ticketPath(task.ticket.ticketSeq)} className="hover:underline">
        {formatTicketId(task.ticket.ticketSeq)}
      </Link>
    );
  }
  return <span className="text-subtle">—</span>;
}

function EditTaskForm({
  task,
  users,
  columnCount,
  onClose,
}: {
  task: TaskRow;
  users: AssignableUser[];
  columnCount: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const clock = useClock();
  // The quick-add form below carries the same two labels, and an edit row can be open while it is —
  // so the ids have to be generated rather than written, or both labels point at one control.
  const fieldId = useId();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<EditFormValues, unknown, UpdateTaskInput>({
    resolver: zodResolver(updateTaskSchema),
    defaultValues: {
      id: task.id,
      title: task.title,
      description: task.description ?? "",
      dueDate: task.dueDate ? taskDue(task.dueDate, clock).key : "",
      assignedToUserId: task.assignedTo?.id ?? "",
    },
  });

  async function onSubmit(values: UpdateTaskInput) {
    setServerError(null);
    const result = await updateTask(values);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    router.refresh();
    onClose();
  }

  return (
    <tr className="border-b border-line bg-surface-sunken last:border-0">
      <td colSpan={columnCount} className="p-3">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-2 rounded-md border border-line bg-surface p-3">
          {serverError && <p className="text-xs text-danger">{serverError}</p>}
          {/* Title and description carry a placeholder and nothing else, so the name has to be spoken. */}
          <Input aria-label="Title" placeholder="Title" {...register("title")} />
          {errors.title && <p className="text-xs text-danger">{errors.title.message}</p>}
          <Textarea aria-label="Description" placeholder="Description (optional)" {...register("description")} />
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor={`${fieldId}-due`} className="text-xs">
                Due date
              </Label>
              <Input id={`${fieldId}-due`} type="date" {...register("dueDate")} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${fieldId}-assignee`} className="text-xs">
                Assign to
              </Label>
              <Select id={`${fieldId}-assignee`} {...register("assignedToUserId")}>
                <option value="">Unassigned</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </td>
    </tr>
  );
}

export function TaskList({
  tasks,
  users,
  currentUserId,
  canDeleteAny,
  showLinkedRecord = false,
  showQuickAdd = true,
  context,
}: {
  tasks: TaskRow[];
  users: AssignableUser[];
  currentUserId: string;
  canDeleteAny: boolean;
  showLinkedRecord?: boolean;
  showQuickAdd?: boolean;
  context?: { companyId?: string; leadId?: string; ticketId?: string };
}) {
  const router = useRouter();
  const clock = useClock();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskRow | null>(null);
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  // Moving a task: whoever it's for, and whoever may change it. Need help and Cancelled ask for their note first.
  const { move, dialog: noteDialog } = useStatusMove((taskId, status, note) =>
    startTransition(async () => {
      setMoveError(null);
      const result = await setTaskStatus(taskId, status, note);
      if (!result.ok) setMoveError(result.error);
      router.refresh();
    }),
  );
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<AddFormValues, unknown, CreateTaskInput>({
    resolver: zodResolver(createTaskSchema),
    defaultValues: {
      companyId: context?.companyId ?? "",
      leadId: context?.leadId ?? "",
      ticketId: context?.ticketId ?? "",
    },
  });

  const columnCount = 6 + (showLinkedRecord ? 1 : 0);

  async function onSubmit(values: CreateTaskInput) {
    setServerError(null);
    const result = await createTask(values);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    reset({
      title: "",
      description: "",
      dueDate: "",
      assignedToUserId: "",
      companyId: context?.companyId ?? "",
      leadId: context?.leadId ?? "",
      ticketId: context?.ticketId ?? "",
    });
    setOpen(false);
    router.refresh();
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    startTransition(async () => {
      await deleteTask(id);
      setDeleteTarget(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {moveError && (
        <p role="alert" className="text-sm text-danger">
          {moveError}
        </p>
      )}
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2.5">Task</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5">Due</th>
              <th className="px-3 py-2.5">Assigned to</th>
              {showLinkedRecord && <th className="px-3 py-2.5">Related to</th>}
              <th className="px-3 py-2.5">Added by</th>
              <th className="px-3 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const canDelete = task.canDelete ?? (!task.workOnly && (canDeleteAny || task.createdBy.id === currentUserId || task.assignedTo?.id === currentUserId));
              const canChange = task.canChange ?? !task.workOnly;
              const status = effectiveStatus({ done: task.done, status: task.status ?? null });

              if (editingId === task.id) {
                return <EditTaskForm key={task.id} task={task} users={users} columnCount={columnCount} onClose={() => setEditingId(null)} />;
              }

              return (
                <tr key={task.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                  <td className="px-3 py-2.5">
                    <div className={task.done ? "font-medium text-subtle line-through" : "font-medium text-text"}>{task.title}</div>
                    {task.description && <div className="text-muted">{task.description}</div>}
                    {task.statusNote && (
                      <div className={`mt-1 text-xs ${status === "NEED_HELP" ? "text-danger" : "text-muted"}`}>
                        {task.statusNote.text} <span className="text-subtle">— {task.statusNote.by}, {clock.dateTimeShort(task.statusNote.at)}</span>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {task.canWork === false ? (
                      <Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>
                    ) : (
                      // One of these per row, so the name says which task.
                      <Select
                        aria-label={`Status: ${task.title}`}
                        value={status}
                        disabled={isPending}
                        onChange={(e) => move(task.id, e.target.value as TaskStatusKey, task.title)}
                        className="h-8 w-36 text-sm"
                      >
                        {TASK_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {STATUS_LABELS[s]}
                          </option>
                        ))}
                      </Select>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="text-muted">{task.dueDate ? taskDue(task.dueDate, clock).label : "—"}</div>
                    <div className="mt-1">{dueBadge(task, clock)}</div>
                  </td>
                  <td className="px-3 py-2.5 text-muted">{task.assignedTo?.name ?? "Unassigned"}</td>
                  {showLinkedRecord && (
                    <td className="px-3 py-2.5 text-muted">
                      <LinkedRecord task={task} />
                    </td>
                  )}
                  <td className="px-3 py-2.5 text-muted">{task.createdBy.name}</td>
                  <td className="px-3 py-2.5 text-right">
                    <RowActions>
                      {canChange && <IconButton icon={Pencil} label="Edit task" onClick={() => setEditingId(task.id)} />}
                      {canDelete && (
                        <IconButton
                          icon={Trash2}
                          label="Delete task"
                          tone="danger"
                          disabled={isPending && deleteTarget?.id === task.id}
                          onClick={() => setDeleteTarget(task)}
                        />
                      )}
                    </RowActions>
                  </td>
                </tr>
              );
            })}
            {tasks.length === 0 && (
              <tr>
                <td colSpan={columnCount} className="px-3 py-6 text-center text-subtle">
                  No tasks yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showQuickAdd &&
        (!open ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
            + New task
          </Button>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-2 rounded-md border border-line p-3">
            {serverError && <p className="text-xs text-danger">{serverError}</p>}
            <Input aria-label="Title" placeholder="Title" {...register("title")} />
            {errors.title && <p className="text-xs text-danger">{errors.title.message}</p>}
            <Textarea aria-label="Description" placeholder="Description (optional)" {...register("description")} />
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor={`${fieldId}-due`} className="text-xs">
                  Due date
                </Label>
                <Input id={`${fieldId}-due`} type="date" {...register("dueDate")} />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${fieldId}-assignee`} className="text-xs">
                  Assign to
                </Label>
                <Select id={`${fieldId}-assignee`} {...register("assignedToUserId")}>
                  <option value="">Unassigned</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={isSubmitting}>
                {isSubmitting ? "Adding…" : "Add"}
              </Button>
            </div>
          </form>
        ))}

      {noteDialog}

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete task">
        <p className="text-sm text-muted">
          Delete <span className="font-medium text-text">{deleteTarget?.title}</span>? This can&apos;t be undone.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setDeleteTarget(null)} disabled={isPending}>
            Cancel
          </Button>
          <Button type="button" variant="danger" size="sm" onClick={confirmDelete} disabled={isPending}>
            {isPending ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
