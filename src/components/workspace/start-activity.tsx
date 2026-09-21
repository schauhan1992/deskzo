"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PhoneCall, X } from "lucide-react";
import type { CallerAllocationMethod } from "@prisma/client";
import { startCallingActivity } from "@/actions/calling-activity";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { allocationMethodHints, allocationMethodLabels, allocationPreview } from "@/lib/workspace/allocation";

const METHODS: CallerAllocationMethod[] = ["ROUND_ROBIN", "BLOCKS", "BY_ACCOUNT_OWNER"];

/**
 * Turning a saved list into a calling campaign.
 *
 * The split is previewed before anything is committed, because starting an activity freezes the
 * rows and hands them out — it isn't a step anyone wants to discover was wrong afterwards.
 */
export function StartActivity({
  workbookId,
  matchCount,
  users,
}: {
  workbookId: string;
  matchCount: number;
  users: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [callerIds, setCallerIds] = useState<string[]>([]);
  const [method, setMethod] = useState<CallerAllocationMethod>("ROUND_ROBIN");
  const [dueAt, setDueAt] = useState("");
  const [note, setNote] = useState("");

  const shares = allocationPreview(matchCount, callerIds.length, method);

  function start() {
    setError(null);
    startTransition(async () => {
      const result = await startCallingActivity({ workbookId, callerIds, method, dueAt, note });
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
      <Button onClick={() => setOpen(true)}>
        <PhoneCall className="mr-1.5 h-3.5 w-3.5" />
        Start calling activity
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title="Start a calling activity">
        <div className="space-y-4">
          <p className="rounded-base border border-line bg-surface-sunken px-3 py-2 text-sm text-muted">
            This freezes the {matchCount.toLocaleString("en-IN")} compan
            {matchCount === 1 ? "y" : "ies"} matching right now into a fixed set and shares them out. The list stops
            changing as the data does — which is the point: you can&apos;t hand out work that reshuffles underneath
            the people doing it.
          </p>

          <div className="space-y-1.5">
            <Label>Who is calling?</Label>
            <div className="flex flex-wrap gap-1.5">
              {users.map((u) => {
                const on = callerIds.includes(u.id);
                return (
                  <button
                    key={u.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setCallerIds((current) =>
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
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="allocMethod">How should it be split?</Label>
            <Select
              id="allocMethod"
              value={method}
              onChange={(e) => setMethod(e.target.value as CallerAllocationMethod)}
            >
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {allocationMethodLabels[m]}
                </option>
              ))}
            </Select>
            <p className="text-xs text-subtle">{allocationMethodHints[method]}</p>
          </div>

          {shares.length > 0 && (
            <div className="rounded-base border border-line px-3 py-2 text-sm">
              <span className="text-muted">Each caller gets</span>{" "}
              <span className="font-medium text-text">
                {shares.map((s) => s.count).join(" / ")}
              </span>
              {shares[0]?.approximate && (
                <span className="ml-2 text-xs text-subtle">— roughly; depends on who owns what</span>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="activityDue">Finish by</Label>
              <Input id="activityDue" type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
              <p className="text-xs text-subtle">Sets the due date on each caller&apos;s task.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="activityNote">Brief</Label>
              <Input
                id="activityNote"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What to say, and what counts as done"
              />
            </div>
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-2">
            <Button disabled={pending || callerIds.length === 0} onClick={start}>
              {pending ? "Starting…" : `Start with ${callerIds.length} caller${callerIds.length === 1 ? "" : "s"}`}
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
