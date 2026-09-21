"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { HandCoins } from "lucide-react";
import { attachScheme } from "@/actions/incentive";
import { Select } from "@/components/ui/input";

/**
 * What hitting this target is worth.
 *
 * `attachScheme` has existed, complete and correct, with no caller — and it is the only writer of
 * `Target.incentiveSchemeId`. So the incentive module looked finished from both ends and could
 * never pay anybody: management built slab schemes on one screen and set targets on another, and
 * "Work out incentives" matched zero targets every time, because every target's scheme was null.
 * It returned `{ raised: 0 }` with no error, because nothing matching is a legitimate result.
 *
 * Only schemes measuring the same thing as the target are offered — `attachScheme` refuses a
 * mismatch, and a dropdown that lists options the next click rejects is worse than a short list.
 */
export function SchemePicker({
  targetId,
  metric,
  current,
  schemes,
}: {
  targetId: string;
  metric: string;
  current: string | null;
  schemes: { id: string; name: string; metric: string; active: boolean }[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [value, setValue] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eligible = schemes.filter((s) => s.metric === metric && (s.active || s.id === current));
  if (eligible.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <HandCoins className="h-3.5 w-3.5 shrink-0 text-subtle" />
      <label htmlFor={`scheme-${targetId}`} className="text-xs text-subtle">
        Pays on
      </label>
      <Select
        id={`scheme-${targetId}`}
        className="h-7 text-xs"
        value={value}
        disabled={busy}
        onChange={(e) => {
          const next = e.target.value;
          setValue(next);
          setBusy(true);
          setError(null);
          startTransition(async () => {
            const result = await attachScheme(targetId, next || null);
            setBusy(false);
            if (!result.ok) {
              setError(result.error);
              setValue(current ?? "");
              return;
            }
            router.refresh();
          });
        }}
      >
        <option value="">Nothing — this target pays no incentive</option>
        {eligible.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
            {!s.active ? " (retired)" : ""}
          </option>
        ))}
      </Select>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
