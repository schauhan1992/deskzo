"use client";

import { useId, useState, useTransition } from "react";
import type { z } from "zod";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { createTaskSchema, updateTaskSchema, type CreateTaskInput, type UpdateTaskInput } from "@/lib/validation/task";
import { createTask, updateTask, toggleTaskDone, deleteTask } from "@/actions/task";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton, RowActions } from "@/components/ui/icon-button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { formatDate } from "@/lib/utils";
import { formatTicketId } from "@/lib/tickets";

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
  company: { id: string; name: string } | null;
  lead: { id: string; title: string } | null;
  ticket: { id: string; ticketSeq: number; title: string } | null;
};

type AddFormValues = z.input<typeof createTaskSchema>;
type EditFormValues = z.input<typeof updateTaskSchema>;

function toDateInputValue(d: Date | string | null) {
  if (!d) return "";
  return new Date(d).toISOString().slice(0, 10);
}

function dueBadge(task: TaskRow) {
  if (task.done) return <Badge tone="green">Done</Badge>;
  if (!task.dueDate) return null;
  const due = new Date(task.dueDate);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  if (due < startOfToday) return <Badge tone="red">Overdue</Badge>;
  if (due.getTime() === startOfToday.getTime()) return <Badge tone="amber">Due today</Badge>;
  return null;
}

function LinkedRecord({ task }: { task: TaskRow }) {
  if (task.company) {
    return (
      <Link href={`/companies/${task.company.id}`} className="hover:underline">
        {task.company.name}
      </Link>
    );
  }
  if (task.lead) {
    return (
      <Link href={`/leads/${task.lead.id}`} className="hover:underline">
        {task.lead.title}
      </Link>
    );
  }
  if (task.ticket) {
    return (
      <Link href={`/tickets/${task.ticket.id}`} className="hover:underline">
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
      dueDate: toDateInputValue(task.dueDate),
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
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskRow | null>(null);
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
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

  const columnCount = 5 + (showLinkedRecord ? 1 : 0);

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

  function toggleDone(task: TaskRow) {
    startTransition(async () => {
      await toggleTaskDone(task.id);
      router.refresh();
    });
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
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2.5">Task</th>
              <th className="px-3 py-2.5">Due</th>
              <th className="px-3 py-2.5">Assigned to</th>
              {showLinkedRecord && <th className="px-3 py-2.5">Related to</th>}
              <th className="px-3 py-2.5">Added by</th>
              <th className="px-3 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const canDelete = canDeleteAny || task.createdBy.id === currentUserId || task.assignedTo?.id === currentUserId;

              if (editingId === task.id) {
                return <EditTaskForm key={task.id} task={task} users={users} columnCount={columnCount} onClose={() => setEditingId(null)} />;
              }

              return (
                <tr key={task.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                  <td className="px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      {/*
                        One of these per row, so the name has to say which task — "checkbox, checked"
                        eleven times over tells a screen-reader user nothing about what they ticked.
                      */}
                      <input
                        type="checkbox"
                        checked={task.done}
                        onChange={() => toggleDone(task)}
                        disabled={isPending}
                        aria-label={`Done: ${task.title}`}
                        className="mt-1 h-4 w-4 rounded border-line-strong"
                      />
                      <div>
                        <div className={task.done ? "font-medium text-subtle line-through" : "font-medium text-text"}>
                          {task.title}
                        </div>
                        {task.description && <div className="text-muted">{task.description}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="text-muted">{formatDate(task.dueDate)}</div>
                    <div className="mt-1">{dueBadge(task)}</div>
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
                      <IconButton icon={Pencil} label="Edit task" onClick={() => setEditingId(task.id)} />
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
