"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trophy } from "lucide-react";
import { archiveTaskChallenge, saveTaskChallenge } from "@/actions/task-extras";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Select, Textarea } from "@/components/ui/input";
import { formatCalendarDay } from "@/lib/time/zone";
import { dayKeyOf } from "@/lib/tasks/rules";

export type ChallengeRow = {
  id: string;
  name: string;
  description: string | null;
  startDate: Date | string | null;
  endDate: Date | string | null;
  archivedAt: Date | string | null;
  createdById: string | null;
  department: { id: string; name: string } | null;
  tasks: number;
  done: number;
  xp: number;
  xpEarned: number;
};

/**
 * Challenges (owner, 16 Oct 2026): goals tasks are grouped under — "Database migration" — each with how
 * its tasks stand and the XP they carry and have earned. Whoever makes one changes or archives it.
 */
export function ChallengesDialog({
  challenges,
  departments,
  viewerId,
  onClose,
}: {
  challenges: ChallengeRow[];
  departments: { id: string; name: string }[];
  viewerId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<ChallengeRow | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <Dialog open onClose={onClose} title="Challenges" wide>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted">Group tasks under a goal. Each task&apos;s XP adds up here, and is earned when it&apos;s done on time.</p>
          <Button type="button" size="sm" onClick={() => setEditing("new")}>
            New challenge
          </Button>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <ul className="divide-y divide-line rounded-base border border-line">
          {challenges.map((c) => {
            const pct = c.tasks ? Math.round((c.done / c.tasks) * 100) : 0;
            return (
              <li key={c.id} className={`space-y-1.5 px-4 py-3 ${c.archivedAt ? "opacity-60" : ""}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Trophy className="h-4 w-4 text-warning" />
                  <span className="font-medium text-text">{c.name}</span>
                  {c.department && <Badge>{c.department.name}</Badge>}
                  {c.archivedAt && <Badge tone="default">Archived</Badge>}
                  <span className="ml-auto text-xs text-muted">
                    {c.startDate ? formatCalendarDay(c.startDate) : "—"} → {c.endDate ? formatCalendarDay(c.endDate) : "—"}
                  </span>
                </div>
                {c.description && <p className="text-sm text-muted">{c.description}</p>}
                <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
                  <span className="flex items-center gap-2">
                    <span className="h-1.5 w-28 overflow-hidden rounded-full bg-surface-sunken">
                      <span className="block h-full bg-success" style={{ width: `${pct}%` }} />
                    </span>
                    {c.done}/{c.tasks} tasks done
                  </span>
                  <span>
                    {c.xpEarned}/{c.xp} XP earned
                  </span>
                  {c.createdById === viewerId && (
                    <span className="ml-auto flex gap-3">
                      <button type="button" className="font-medium text-brand hover:underline" onClick={() => setEditing(c)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="font-medium text-muted hover:text-text"
                        disabled={pending}
                        onClick={() =>
                          start(async () => {
                            setError(null);
                            const result = await archiveTaskChallenge(c.id, !c.archivedAt);
                            if (!result.ok) setError(result.error);
                            router.refresh();
                          })
                        }
                      >
                        {c.archivedAt ? "Bring back" : "Archive"}
                      </button>
                    </span>
                  )}
                </div>
              </li>
            );
          })}
          {challenges.length === 0 && <li className="px-4 py-8 text-center text-sm text-subtle">No challenges yet.</li>}
        </ul>
      </div>
      {editing && <ChallengeForm challenge={editing === "new" ? null : editing} departments={departments} onClose={() => setEditing(null)} />}
    </Dialog>
  );
}

function ChallengeForm({ challenge, departments, onClose }: { challenge: ChallengeRow | null; departments: { id: string; name: string }[]; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(challenge?.name ?? "");
  const [description, setDescription] = useState(challenge?.description ?? "");
  const [departmentId, setDepartmentId] = useState(challenge?.department?.id ?? "");
  const [startDate, setStartDate] = useState(challenge?.startDate ? dayKeyOf(challenge.startDate) : "");
  const [endDate, setEndDate] = useState(challenge?.endDate ? dayKeyOf(challenge.endDate) : "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <Dialog open onClose={onClose} title={challenge ? "Edit challenge" : "New challenge"}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            setError(null);
            const result = await saveTaskChallenge({ id: challenge?.id, name, description, departmentId, startDate, endDate });
            if (!result.ok) {
              setError(result.error);
              return;
            }
            onClose();
            router.refresh();
          });
        }}
      >
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-text">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Database migration" autoFocus disabled={pending} />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-text">Team</span>
          <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} disabled={pending}>
            <option value="">Any team</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-text">Starts</span>
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} disabled={pending} />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-text">Ends</span>
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} disabled={pending} />
          </label>
        </div>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-text">What it&apos;s for</span>
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} disabled={pending} />
        </label>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || name.trim().length < 2}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
