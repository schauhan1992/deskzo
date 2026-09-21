"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserPlus, X } from "lucide-react";
import { assignWorkbook } from "@/actions/workspace";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";

type Assignee = { userId: string; note: string | null; user: { id: string; name: string } };

/**
 * Who is working this list.
 *
 * The whole set is chosen at once rather than added one at a time, because assignment is thought
 * about as "these three people" — and a bare add would make removing somebody a separate step that
 * gets forgotten, leaving a list assigned to someone who stopped working it months ago.
 */
export function AssignWorkbook({
  workbookId,
  assignees,
  users,
  canAssign,
}: {
  workbookId: string;
  assignees: Assignee[];
  users: { id: string; name: string }[];
  canAssign: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>(assignees.map((a) => a.userId));
  const [note, setNote] = useState("");

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await assignWorkbook({ id: workbookId, userIds: selected, note });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {assignees.map((a) => (
          <Badge key={a.userId} tone="blue">
            {a.user.name}
          </Badge>
        ))}
        {assignees.length === 0 && <span className="text-xs text-subtle">Nobody assigned</span>}
        {canAssign && (
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
            <UserPlus className="mr-1 h-3.5 w-3.5" />
            {assignees.length > 0 ? "Change" : "Assign"}
          </Button>
        )}
      </div>

      <Dialog open={open} onClose={() => setOpen(false)} title="Who is working this list?">
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {users.map((u) => {
              const on = selected.includes(u.id);
              return (
                <button
                  key={u.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setSelected((current) =>
                      current.includes(u.id) ? current.filter((id) => id !== u.id) : [...current, u.id],
                    )
                  }
                  className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-sm transition-colors ${
                    on ? "bg-brand text-brand-contrast" : "border border-line-strong bg-surface text-muted hover:text-text"
                  }`}
                >
                  {u.name}
                  {on && <X className="h-3 w-3" />}
                </button>
              );
            })}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="assignNote">What should they do with it?</Label>
            <Input
              id="assignNote"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Call through by Friday, log every outcome"
            />
            <p className="text-xs text-subtle">
              Sent with the notification to anyone newly assigned. People already on the list aren&apos;t notified again.
            </p>
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-2">
            <Button disabled={pending} onClick={save}>
              {pending ? "Saving…" : selected.length === 0 ? "Remove everyone" : `Assign ${selected.length}`}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
