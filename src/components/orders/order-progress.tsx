"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { setOrderStep } from "@/actions/order-progress";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import type { StageColor } from "@/lib/pipeline/rules";
import { formatDate } from "@/lib/utils";

type Step = { id: string; label: string; color: StageColor };
type Move = { id: string; fromLabel: string | null; toLabel: string; note: string | null; createdAt: string; by: string };

/**
 * Where an order has got to within its status — the workspace's own steps (Settings → Pipeline →
 * Orders) — with a way to move it on for whoever works it through (`setOrderStep`), and the moves so
 * far. Shown only where the status has steps or the order has history.
 */
export function OrderProgress({
  orderId,
  statusLabel,
  steps,
  currentId,
  editable,
  history,
}: {
  orderId: string;
  statusLabel: string;
  steps: Step[];
  currentId: string | null;
  editable: boolean;
  history: Move[];
}) {
  const router = useRouter();
  const id = useId();
  const [isPending, startTransition] = useTransition();
  const [target, setTarget] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const at = steps.findIndex((s) => s.id === currentId);

  function move() {
    if (!target) return;
    setError(null);
    startTransition(async () => {
      const result = await setOrderStep(orderId, target, note);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setTarget("");
      setNote("");
      router.refresh();
    });
  }

  if (steps.length === 0 && history.length === 0) return null;

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Progress — {statusLabel}</CardHeader>
      <CardContent className="space-y-4 text-sm">
        {steps.length > 0 && (
          <ol className="flex flex-wrap items-center gap-1.5" aria-label={`Steps within ${statusLabel}`}>
            {steps.map((s, i) => (
              <li key={s.id} className="flex items-center gap-1.5" aria-current={i === at ? "step" : undefined}>
                {i > 0 && <span className="text-subtle" aria-hidden="true">→</span>}
                {i === at ? (
                  <Badge tone={s.color} className="ring-1 ring-current">
                    {s.label}
                  </Badge>
                ) : (
                  <span className={`inline-flex items-center gap-1 text-xs ${i < at ? "text-muted" : "text-subtle"}`}>
                    {i < at && <Check className="h-3 w-3" aria-label="done" />}
                    {s.label}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}

        {editable && steps.length > 1 && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor={`${id}-step`} className="text-xs">
                Move to
              </Label>
              <Select id={`${id}-step`} value={target} onChange={(e) => setTarget(e.target.value)} className="h-9 w-48" disabled={isPending}>
                <option value="">Choose a step…</option>
                {steps
                  .filter((s) => s.id !== currentId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
              </Select>
            </div>
            <div className="min-w-48 flex-1 space-y-1">
              <Label htmlFor={`${id}-note`} className="text-xs">
                Note (optional)
              </Label>
              <Input id={`${id}-note`} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Delivered to site, signed by the store manager" disabled={isPending} />
            </div>
            <Button type="button" size="sm" disabled={isPending || !target} onClick={move}>
              {isPending ? "Moving…" : "Move"}
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}

        {history.length > 0 && (
          <ul className="space-y-1.5 border-t border-line pt-3 text-xs">
            {history.map((m) => (
              <li key={m.id} className="text-muted">
                <span className="text-text">
                  {m.fromLabel ? `${m.fromLabel} → ` : ""}
                  {m.toLabel}
                </span>{" "}
                · {m.by} · {formatDate(m.createdAt)}
                {m.note && <span className="block text-subtle">{m.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
