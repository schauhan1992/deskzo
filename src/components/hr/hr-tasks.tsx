"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Circle, ListPlus } from "lucide-react";
import type { hrTasksFor } from "@/actions/hr";
import { raiseOffboardingTasks } from "@/actions/hr";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useClock } from "@/components/time/clock-provider";
import { taskDue } from "@/lib/task-due";

type Task = Awaited<ReturnType<typeof hrTasksFor>>[number];

/**
 * The joining and leaving tasks raised for one person.
 *
 * Shown on their record rather than only in the task list because that is where somebody asks the
 * question — "has their laptop come back?" is a question about a person, not about a queue.
 */
export function HrTasks({
  userId,
  tasks,
  canManage,
  hasExited,
}: {
  userId: string;
  tasks: Task[];
  canManage: boolean;
  hasExited: boolean;
}) {
  const router = useRouter();
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const offboarding = tasks.filter((t) => t.hrStage === "OFFBOARDING");
  const open = tasks.filter((t) => !t.done).length;
  const canRaise = canManage && hasExited && offboarding.length === 0;

  if (tasks.length === 0 && !canRaise) return null;

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
        <span>Joining &amp; leaving tasks</span>
        {tasks.length > 0 && (
          <span className="text-xs font-normal text-muted">
            {open === 0 ? "all done" : `${open} open`}
          </span>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        {canRaise && (
          <div className="space-y-2 rounded-base border border-line bg-surface-sunken px-3 py-2.5">
            <p className="text-xs text-muted">
              Their exit is recorded but nothing has been raised. The tasks are dated from the last working day —
              revoking access on the day, not a week later, is the whole reason for raising them rather than
              remembering.
            </p>
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await raiseOffboardingTasks(userId);
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  router.refresh();
                });
              }}
            >
              <ListPlus className="mr-1.5 h-3.5 w-3.5" />
              {pending ? "Raising…" : "Raise offboarding tasks"}
            </Button>
            {error && <p className="text-sm text-danger">{error}</p>}
          </div>
        )}

        {tasks.length > 0 && (
          <ul className="divide-y divide-line">
            {tasks.map((task) => {
              // "Overdue" is only meaningful while the thing is still outstanding.
              // By the workspace's calendar: a day picked on the form is overdue once it has passed, not at midnight UTC.
              const overdue = !task.done && !!task.dueDate && taskDue(task.dueDate, clock).key < clock.today();
              return (
                <li key={task.id} className="flex items-start gap-2 py-2">
                  {task.done ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                  ) : (
                    <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />
                  )}
                  <span className="min-w-0 flex-1">
                    <Link
                      href="/tasks"
                      className={`block text-sm hover:underline ${task.done ? "text-muted line-through decoration-line" : "text-text"}`}
                    >
                      {task.title}
                    </Link>
                    <span className="block text-xs text-subtle">
                      {task.assignedTo?.name ?? "Unassigned"}
                      {task.dueDate && ` · due ${taskDue(task.dueDate, clock).label}`}
                    </span>
                  </span>
                  {overdue && <Badge tone="red">Overdue</Badge>}
                  {task.hrStage === "OFFBOARDING" && !overdue && <Badge tone="default">Exit</Badge>}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
