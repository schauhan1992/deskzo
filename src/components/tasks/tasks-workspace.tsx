"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowUpDown, CalendarDays, CheckSquare, LayoutGrid, List, MessageSquare, Paperclip, Pencil, Plus, Star, Trash2, Trophy } from "lucide-react";
import { deleteTask, setTaskStatus, toggleTaskStar } from "@/actions/task";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { useClock } from "@/components/time/clock-provider";
import { formatCalendarDay } from "@/lib/time/zone";
import { taskDue } from "@/lib/task-due";
import {
  PRIORITY_LABELS,
  PRIORITY_TONES,
  STATUS_LABELS,
  STATUS_TONES,
  effectiveStatus,
  shownStatus,
  type TaskPriorityKey,
  type TaskSort,
  type TaskStatusKey,
} from "@/lib/tasks/rules";
import { TaskDialog, type TaskFormOptions, type TaskFormTask } from "@/components/tasks/task-dialog";
import { TaskPanel } from "@/components/tasks/task-panel";
import { ChallengesDialog, type ChallengeRow } from "@/components/tasks/challenges-dialog";

export type WorkspaceTask = TaskFormTask & {
  done: boolean;
  createdAt: Date | string;
  starred: boolean;
  checklistDone: number;
  assignedTo: { id: string; name: string; photoUpdatedAt: Date | string | null } | null;
  createdBy: { id: string; name: string };
  department: { id: string; name: string } | null;
  challenge: { id: string; name: string } | null;
  company: { id: string; name: string; companySeq: number } | null;
  lead: { id: string; title: string; leadSeq: number } | null;
  ticket: { id: string; ticketSeq: number; title: string } | null;
  _count: { checklist: number; comments: number; attachments: number };
  /** Given to the viewer by somebody else: theirs to move along, not to change or delete (src/lib/tasks/rules.ts). */
  workOnly: boolean;
};

const BOARD: { status: TaskStatusKey; label: string; panel: string; title: string }[] = [
  { status: "TODO", label: "To do", panel: "bg-surface-sunken", title: "text-muted" },
  { status: "IN_PROGRESS", label: "In progress", panel: "bg-warning-bg", title: "text-warning" },
  { status: "DONE", label: "Done", panel: "bg-success-bg", title: "text-success" },
  { status: "CANCELLED", label: "Cancelled", panel: "bg-danger-bg", title: "text-danger" },
];

/**
 * The Tasks page's body (owner, 16 Oct 2026): a table with sortable columns, or a board by status to
 * drag across; a star on what matters to you; a click opens the task in full. New tasks and challenges
 * from the toolbar.
 */
export function TasksWorkspace({
  tasks,
  options,
  challenges,
  viewerId,
  view,
  sort,
  dir,
}: {
  tasks: WorkspaceTask[];
  options: TaskFormOptions;
  challenges: ChallengeRow[];
  viewerId: string;
  view: "list" | "board";
  sort?: TaskSort;
  dir?: "asc" | "desc";
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const clock = useClock();
  const today = clock.today();
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<WorkspaceTask | "new" | null>(null);
  const [showChallenges, setShowChallenges] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();

  const href = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    next.delete("page");
    return `${pathname}?${next.toString()}`;
  };
  const run = (work: () => Promise<{ ok: true } | { ok: false; error: string }>) =>
    start(async () => {
      setError(null);
      const result = await work();
      if (!result.ok) setError(result.error);
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex overflow-hidden rounded-base border border-line">
          <Link
            href={href({ view: null })}
            aria-label="List"
            aria-current={view === "list" ? "page" : undefined}
            className={`px-3 py-1.5 ${view === "list" ? "bg-brand text-brand-contrast" : "bg-surface text-muted hover:text-text"}`}
          >
            <List className="h-4 w-4" />
          </Link>
          <Link
            href={href({ view: "board" })}
            aria-label="Board"
            aria-current={view === "board" ? "page" : undefined}
            className={`px-3 py-1.5 ${view === "board" ? "bg-brand text-brand-contrast" : "bg-surface text-muted hover:text-text"}`}
          >
            <LayoutGrid className="h-4 w-4" />
          </Link>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={() => setShowChallenges(true)}>
            <Trophy className="mr-1.5 h-4 w-4" />
            Challenges
          </Button>
          <Button type="button" onClick={() => setEditing("new")}>
            <Plus className="mr-1.5 h-4 w-4" />
            New task
          </Button>
        </div>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}

      {view === "board" ? (
        <TaskBoard tasks={tasks} today={today} onOpen={setOpenId} onMove={(id, status) => run(() => setTaskStatus(id, status))} />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs font-medium text-muted">
              <tr>
                <th className="w-8 px-3 py-2.5" aria-label="Starred" />
                <SortHeader label="Task" sortKey="title" sort={sort} dir={dir} href={href} />
                <th className="px-3 py-2.5">Team</th>
                <th className="px-3 py-2.5">Challenge</th>
                <th className="px-3 py-2.5">Assigned to</th>
                <SortHeader label="Start" sortKey="start" sort={sort} dir={dir} href={href} />
                <SortHeader label="Due" sortKey="due" sort={sort} dir={dir} href={href} />
                <SortHeader label="Priority" sortKey="priority" sort={sort} dir={dir} href={href} />
                <SortHeader label="XP" sortKey="xp" sort={sort} dir={dir} href={href} />
                <SortHeader label="Status" sortKey="status" sort={sort} dir={dir} href={href} />
                <th className="px-3 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => {
                const shown = shownStatus(t, today);
                const due = t.dueDate ? taskDue(t.dueDate, clock) : null;
                const overdue = !!due && !t.done && due.key < today;
                return (
                  <tr key={t.id} className="border-b border-line last:border-0 hover:bg-surface-sunken/60">
                    <td className="px-3 py-3">
                      <button type="button" aria-label={t.starred ? "Unstar" : "Star"} onClick={() => run(() => toggleTaskStar(t.id))}>
                        <Star className={`h-4 w-4 ${t.starred ? "fill-warning text-warning" : "text-subtle hover:text-warning"}`} />
                      </button>
                    </td>
                    <td className="max-w-72 px-3 py-3">
                      <button type="button" onClick={() => setOpenId(t.id)} className={`text-left font-medium hover:underline ${t.done ? "text-muted line-through" : "text-text"}`}>
                        {t.title}
                      </button>
                      <TaskCounts task={t} />
                    </td>
                    <td className="px-3 py-3 text-muted">{t.department?.name ?? "—"}</td>
                    <td className="px-3 py-3 text-muted">{t.challenge?.name ?? "—"}</td>
                    <td className="px-3 py-3">
                      {t.assignedTo ? (
                        <span className="flex items-center gap-2 whitespace-nowrap">
                          <Avatar user={t.assignedTo} size="xs" />
                          {t.assignedTo.name}
                        </span>
                      ) : (
                        <span className="text-subtle">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-muted">{t.startDate ? formatCalendarDay(t.startDate) : "—"}</td>
                    <td className={`whitespace-nowrap px-3 py-3 ${overdue ? "font-medium text-danger" : "text-muted"}`}>{due?.label ?? "—"}</td>
                    <td className="px-3 py-3">
                      <Badge tone={PRIORITY_TONES[t.priority]}>{PRIORITY_LABELS[t.priority]}</Badge>
                    </td>
                    <td className="px-3 py-3 tabular-nums text-text">{t.xp > 0 ? t.xp : "—"}</td>
                    <td className="px-3 py-3">
                      <Badge tone={STATUS_TONES[shown]}>{STATUS_LABELS[shown]}</Badge>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right">
                      {t.workOnly ? (
                        <span className="text-xs text-subtle" title={`${t.createdBy.name} gave you this task — open it to move it along`}>
                          Given by {t.createdBy.name.split(" ")[0]}
                        </span>
                      ) : (
                        <>
                          <button type="button" aria-label="Edit" onClick={() => setEditing(t)} className="rounded-base p-1 text-info hover:bg-info-bg">
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            aria-label="Delete"
                            onClick={() => window.confirm(`Delete "${t.title}"?`) && run(() => deleteTask(t.id))}
                            className="rounded-base p-1 text-danger hover:bg-danger-bg"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {tasks.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-4 py-10 text-center text-subtle">
                    No tasks match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      )}

      {openId && <TaskPanel taskId={openId} onClose={() => setOpenId(null)} options={options} />}
      {editing && (
        <TaskDialog open onClose={() => setEditing(null)} options={options} viewerId={viewerId} task={editing === "new" ? null : { ...editing, status: effectiveStatus(editing) }} />
      )}
      {showChallenges && <ChallengesDialog challenges={challenges} departments={options.departments} viewerId={viewerId} onClose={() => setShowChallenges(false)} />}
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  dir,
  href,
}: {
  label: string;
  sortKey: TaskSort;
  sort?: TaskSort;
  dir?: "asc" | "desc";
  href: (changes: Record<string, string | null>) => string;
}) {
  const active = sort === sortKey;
  return (
    <th className="px-3 py-2.5">
      <Link href={href({ sort: sortKey, dir: active && dir !== "desc" ? "desc" : "asc" })} className={`inline-flex items-center gap-1 hover:text-text ${active ? "text-text" : ""}`}>
        {label}
        <ArrowUpDown className="h-3 w-3" aria-hidden />
      </Link>
    </th>
  );
}

/** The little counts under a task's name: its checklist, comments and files. */
function TaskCounts({ task }: { task: WorkspaceTask }) {
  const { checklist, comments, attachments } = task._count;
  if (!checklist && !comments && !attachments) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-2 text-xs text-subtle">
      {checklist > 0 && (
        <span className="inline-flex items-center gap-0.5">
          <CheckSquare className="h-3 w-3" />
          {task.checklistDone}/{checklist}
        </span>
      )}
      {comments > 0 && (
        <span className="inline-flex items-center gap-0.5">
          <MessageSquare className="h-3 w-3" />
          {comments}
        </span>
      )}
      {attachments > 0 && (
        <span className="inline-flex items-center gap-0.5">
          <Paperclip className="h-3 w-3" />
          {attachments}
        </span>
      )}
    </span>
  );
}

/** The board: a column a status, dragged across to move one. */
function TaskBoard({
  tasks,
  today,
  onOpen,
  onMove,
}: {
  tasks: WorkspaceTask[];
  today: string;
  onOpen: (id: string) => void;
  onMove: (id: string, status: TaskStatusKey) => void;
}) {
  const clock = useClock();
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<TaskStatusKey | null>(null);
  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {BOARD.map((col) => {
        const items = tasks.filter((t) => effectiveStatus(t) === col.status);
        return (
          <section
            key={col.status}
            aria-label={col.label}
            className={`flex min-h-[55vh] w-72 flex-shrink-0 flex-col rounded-xl ${col.panel} ${over === col.status ? "ring-2 ring-brand" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              if (over !== col.status) setOver(col.status);
            }}
            onDragLeave={() => setOver((o) => (o === col.status ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const task = tasks.find((t) => t.id === dragged);
              setDragged(null);
              if (task && effectiveStatus(task) !== col.status) onMove(task.id, col.status);
            }}
          >
            <header className="flex items-center gap-2 px-3 pb-2 pt-3">
              <h2 className={`text-sm font-medium ${col.title}`}>{col.label}</h2>
              <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-medium tabular-nums text-muted">{items.length}</span>
            </header>
            <div className="flex-1 space-y-2.5 px-2 pb-3">
              {items.map((t) => {
                const shown = shownStatus(t, today);
                const due = t.dueDate ? taskDue(t.dueDate, clock) : null;
                const overdue = !!due && !t.done && due.key < today;
                return (
                  <div
                    key={t.id}
                    draggable
                    onDragStart={(e) => {
                      setDragged(t.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => setDragged(null)}
                    onClick={() => onOpen(t.id)}
                    className={`cursor-grab rounded-lg border border-line bg-surface p-3 shadow-sm hover:border-line-strong ${dragged === t.id ? "opacity-40" : ""}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium text-text">{t.title}</span>
                      {t.starred && <Star className="h-3.5 w-3.5 shrink-0 fill-warning text-warning" />}
                    </div>
                    {(t.department || t.challenge) && (
                      <div className="mt-0.5 truncate text-xs text-muted">{[t.department?.name, t.challenge?.name].filter(Boolean).join(" · ")}</div>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Badge tone={PRIORITY_TONES[t.priority as TaskPriorityKey]}>{PRIORITY_LABELS[t.priority as TaskPriorityKey]}</Badge>
                      {shown === "UPCOMING" && <Badge tone="blue">Upcoming</Badge>}
                      {t.xp > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-xs text-warning">
                          <Trophy className="h-3 w-3" />
                          {t.xp} XP
                        </span>
                      )}
                    </div>
                    <TaskCounts task={t} />
                    <div className="mt-2 flex items-center justify-between gap-2">
                      {t.assignedTo ? <Avatar user={t.assignedTo} size="sm" /> : <span className="text-xs text-subtle">Unassigned</span>}
                      {due && (
                        <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs ${overdue ? "bg-danger-bg text-danger" : "bg-surface-sunken text-muted"}`}>
                          <CalendarDays className="h-3 w-3" />
                          {due.label}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              {items.length === 0 && <div className="rounded-lg border border-dashed border-line-strong/60 p-3 text-center text-xs text-subtle">Drop a task here</div>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
