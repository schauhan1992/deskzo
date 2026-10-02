"use client";

import { useState, useTransition, useId } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { endPlatformSupport, grantPlatformSupport, type SupportAccessState } from "@/actions/support-access";
import { formatIstDateTime } from "@/lib/india-time";

/**
 * The super admin letting Deskzo's support staff in (src/actions/support-access.ts): read-only, or an
 * administrator's access, for a few hours, with a reason. Ending it signs them out at once.
 */
/** `compact`: stacked, for the right rail's panel (src/components/layout/rail-support-access.tsx). */
export function SupportAccessCard({ state, compact = false }: { state: SupportAccessState; compact?: boolean }) {
  // Its own ids wherever it is drawn: the Security page and the rail can both show it at once.
  const uid = useId();
  const router = useRouter();
  const [level, setLevel] = useState<"READONLY" | "ADMIN">("READONLY");
  const [hours, setHours] = useState("24");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (work: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const r = await work();
      if (!r.ok) setError(r.error ?? "That didn't work.");
      else router.refresh();
    });
  };

  if (state.grant) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-text">
          Platform support can come in as <span className="font-medium">{state.grant.level === "ADMIN" ? "an administrator" : "read-only"}</span> until{" "}
          {formatIstDateTime(state.grant.expiresAt)}.
        </p>
        <p className="text-xs text-muted">
          Granted by {state.grant.grantedByName}: {state.grant.reason}
        </p>
        <p className="text-xs text-muted">Everything they do is in the activity log under their own name. They never appear among your people and are never a seat.</p>
        <Button type="button" variant="danger" size="sm" disabled={pending} onClick={() => run(endPlatformSupport)}>
          {pending ? "Ending…" : "End support access now"}
        </Button>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => grantPlatformSupport({ level, hours: Number(hours), reason }));
      }}
    >
      <p className="text-sm text-muted">
        Deskzo&apos;s support staff cannot see inside this workspace unless you let them. Access ends on its own after the time you choose, or when you end it.
      </p>
      <div className={compact ? "grid grid-cols-1 gap-3" : "grid grid-cols-1 gap-3 sm:grid-cols-2"}>
        <div>
          <Label htmlFor={`${uid}-level`}>What they can do</Label>
          <Select id={`${uid}-level`} value={level} onChange={(e) => setLevel(e.target.value === "ADMIN" ? "ADMIN" : "READONLY")}>
            <option value="READONLY">Look only — read-only</option>
            <option value="ADMIN">Change things — an administrator&apos;s access</option>
          </Select>
        </div>
        <div>
          <Label htmlFor={`${uid}-hours`}>For how many hours (up to {state.maxHours})</Label>
          <Input id={`${uid}-hours`} type="number" min={1} max={state.maxHours} value={hours} onChange={(e) => setHours(e.target.value)} />
        </div>
      </div>
      <div>
        <Label htmlFor={`${uid}-reason`}>What it is for</Label>
        <Textarea id={`${uid}-reason`} rows={2} maxLength={500} required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="The payroll run for March shows the wrong totals" />
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button type="submit" size="sm" disabled={pending || reason.trim().length < 5}>
        {pending ? "Granting…" : "Let support in"}
      </Button>
    </form>
  );
}
