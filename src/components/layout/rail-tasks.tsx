"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { createTask, myOpenTasks, toggleTaskDone, type RailTask } from "@/actions/task";
import { Checkbox } from "@/components/ui/bulk-select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useClock } from "@/components/time/clock-provider";
import { taskDue } from "@/lib/task-due";

/**
 * What is on this person's plate, without leaving the page.
 *
 * Deliberately only open tasks assigned to them, soonest first. The tasks page is where you plan;
 * this is where you tick something off while the thing that reminded you is still on screen — and a
 * panel that reproduced the whole list with its filters would just be the page in a narrower box.
 *
 * Fetched when the panel opens rather than shipped with every page. Most page views never open it.
 */
export function RailTasks() {
  const router = useRouter();
  const clock = useClock();
  const [rows, setRows] = useState<RailTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let live = true;
    myOpenTasks()
      .then((result) => {
        if (!live) return;
        setRows(result);
      })
      .catch(() => live && setError("Could not load your tasks."));
    return () => {
      live = false;
    };
  }, []);

  async function refresh() {
    setRows(await myOpenTasks());
    // The page behind may be showing a count of these. Refreshing it costs a round trip and stops
    // the panel and the page disagreeing about how much is outstanding.
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const text = title.trim();
          if (!text) return;
          startTransition(async () => {
            const result = await createTask({ title: text });
            if (!result.ok) {
              setError(result.error);
              return;
            }
            setTitle("");
            setError(null);
            await refresh();
          });
        }}
      >
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add a task…"
          aria-label="Add a task"
          autoComplete="off"
        />
        <Button type="submit" size="icon" variant="secondary" disabled={pending || !title.trim()} aria-label="Add">
          <Plus className="h-4 w-4" />
        </Button>
      </form>

      {error && <p className="text-xs text-danger">{error}</p>}
      {!rows && !error && <p className="text-sm text-muted">Loading…</p>}

      {rows?.length === 0 && (
        <p className="rounded-base bg-surface-sunken px-3 py-6 text-center text-sm text-muted">
          Nothing outstanding.
        </p>
      )}

      {rows && rows.length > 0 && (
        <ul className="space-y-1">
          {rows.map((task) => {
            // A typed day or a callback's promised moment (taskDue), overdue by the workspace's calendar —
            // a callback due later today is not overdue yet.
            const due = task.dueDate ? taskDue(task.dueDate, clock) : null;
            const overdue = due !== null && due.key < clock.today();
            return (
              <li key={task.id} className="flex items-start gap-2 rounded-base px-1 py-1.5 hover:bg-surface-sunken">
                <Checkbox
                  className="mt-0.5"
                  checked={false}
                  aria-label={`Mark "${task.title}" done`}
                  onChange={() => {
                    startTransition(async () => {
                      await toggleTaskDone(task.id);
                      await refresh();
                    });
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-text">{task.title}</div>
                  {(due || task.companyName) && (
                    <div className="text-xs text-subtle">
                      {task.companyName}
                      {task.companyName && due ? " · " : ""}
                      {due && (
                        <span className={overdue ? "text-danger" : undefined}>
                          {overdue ? "Overdue " : "Due "}
                          {due.label}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Link href="/tasks" className="block text-xs text-brand hover:underline">
        Open the tasks page →
      </Link>
    </div>
  );
}
