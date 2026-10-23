"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setRemindersPaused } from "@/actions/payment-collection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * A customer's payment reminders paused or resumed (owner, 23 Oct 2026 — src/lib/collect/reminders.ts) — for
 * a dispute, or an arrangement to pay. Monthly statements stop with them.
 */
export function ReminderPauseControl({ companyId, paused, reason, on, mayChange }: { companyId: string; paused: boolean; reason: string | null; on: boolean; mayChange: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState(false);
  const [why, setWhy] = useState("");
  const [error, setError] = useState<string | null>(null);

  const set = (next: boolean) => {
    setError(null);
    startTransition(async () => {
      const result = await setRemindersPaused(companyId, next, why);
      if (!result.ok) return setError(result.error);
      setAsking(false);
      setWhy("");
      router.refresh();
    });
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-base border border-line px-4 py-3 text-sm">
      <span className="text-muted">
        {!on
          ? "Payment reminders are off for everyone (Settings › Payment collection)."
          : paused
            ? `Payment reminders and statements are paused for this customer${reason ? ` — ${reason}` : ""}.`
            : "This customer gets payment reminders and a monthly statement."}
      </span>
      {mayChange &&
        (paused ? (
          <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => set(false)}>
            Resume reminders
          </Button>
        ) : asking ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label="Why reminders are paused" placeholder="Why — a dispute, an arrangement…" value={why} onChange={(e) => setWhy(e.target.value)} className="h-8 w-64" maxLength={300} />
            <Button type="button" size="sm" disabled={pending} onClick={() => set(true)}>
              Pause
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button type="button" variant="secondary" size="sm" onClick={() => setAsking(true)}>
            Pause reminders
          </Button>
        ))}
      {error && <p role="alert" className="w-full text-danger">{error}</p>}
    </div>
  );
}
