"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { logActivity } from "@/actions/lead";
import { activityTypeValues } from "@/lib/validation/lead";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/input";

export function ActivityForm({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [notes, setNotes] = useState("");
  const [type, setType] = useState<(typeof activityTypeValues)[number]>("CALL");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await logActivity({ leadId, type, notes });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotes("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex gap-2">
        {/* An inline pair with no captions above them — nothing on screen to point a htmlFor at. */}
        <Select
          aria-label="Activity type"
          value={type}
          onChange={(e) => setType(e.target.value as typeof type)}
          className="w-32"
        >
          {activityTypeValues
            .filter((t) => t !== "STAGE_CHANGE")
            .map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
        </Select>
        <Textarea
          aria-label="Activity notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What happened?"
          className="min-h-9 flex-1"
          required
        />
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Logging…" : "Log activity"}
        </Button>
      </div>
    </form>
  );
}
