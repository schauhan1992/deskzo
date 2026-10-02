"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { OrderStatus } from "@prisma/client";
import { deleteOrderStep, moveOrderStep, restoreOrderStep, retireOrderStep, saveOrderStep } from "@/actions/pipeline";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { STAGE_COLORS, STAGE_COLOR_LABELS, type StageColor } from "@/lib/pipeline/rules";
import { STEP_LIMITS, STEP_STATUSES, stepRehomeTargets, stepStatusLabel, type OrderStepDef } from "@/lib/pipeline/order-steps";

type Step = OrderStepDef & { orders: number; placed: number };
type Draft = { id: string; label: string; status: OrderStatus; color: StageColor };

const ordersText = (n: number) => (n === 0 ? "No orders" : `${n} order${n === 1 ? "" : "s"}`);

/**
 * Settings → Pipeline → Orders (src/actions/pipeline.ts): the workspace's own steps within each order
 * status, in order, with a dialog to add or change one and one to retire one with its orders moved on.
 */
export function OrderStepsManager({ steps, stored }: { steps: Step[]; stored: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [retiring, setRetiring] = useState<{ step: Step; moveTo: string } | null>(null);
  const retired = steps.filter((s) => s.archived);
  const editing = draft?.id ? steps.find((s) => s.id === draft.id) : undefined;

  function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      after?.();
      router.refresh();
    });
  }

  if (!stored) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted">This workspace is still being updated to have order steps. Come back in a few minutes.</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {error && !draft && !retiring && (
        <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {STEP_STATUSES.map(({ status, label, hint }) => {
        const own = steps.filter((s) => s.status === status && !s.archived);
        return (
          <section key={status} className="space-y-2" aria-label={`Steps within ${label}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium text-text">{label}</h3>
                <p className="text-xs text-subtle">{hint}</p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={isPending || own.length >= STEP_LIMITS.perStatus}
                onClick={() => {
                  setError(null);
                  setDraft({ id: "", label: "", status, color: "blue" });
                }}
              >
                Add a step
              </Button>
            </div>
            {own.length === 0 ? (
              <p className="rounded-md border border-dashed border-line px-3 py-3 text-xs text-subtle">No steps — orders show only “{label}”.</p>
            ) : (
              own.map((s, index) => (
                <Card key={s.id}>
                  <CardContent className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-subtle">{index + 1}.</span>
                      <Badge tone={s.color}>{s.label}</Badge>
                      <span className="text-xs text-subtle">{ordersText(s.orders)}</span>
                    </p>
                    <div className="flex flex-wrap items-center gap-1">
                      <Button type="button" variant="ghost" size="sm" aria-label={`Move ${s.label} up`} disabled={isPending || index === 0} onClick={() => run(() => moveOrderStep(s.id, "up"))}>
                        <ArrowUp className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Move ${s.label} down`}
                        disabled={isPending || index === own.length - 1}
                        onClick={() => run(() => moveOrderStep(s.id, "down"))}
                      >
                        <ArrowDown className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={isPending}
                        onClick={() => {
                          setError(null);
                          setDraft({ id: s.id, label: s.label, status: s.status, color: s.color });
                        }}
                      >
                        Change
                      </Button>
                      {s.placed === 0 ? (
                        <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={() => run(() => deleteOrderStep(s.id))}>
                          Delete
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={isPending}
                          onClick={() => {
                            setError(null);
                            setRetiring({ step: s, moveTo: stepRehomeTargets(s, steps)[0]?.id ?? "" });
                          }}
                        >
                          Retire
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </section>
        );
      })}

      {retired.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-text">Retired steps</h3>
          {retired.map((s) => (
            <Card key={s.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm text-muted">
                <p className="flex flex-wrap items-center gap-2">
                  <Badge tone={s.color}>{s.label}</Badge>
                  within {stepStatusLabel(s.status).toLowerCase()}
                </p>
                <div className="flex items-center gap-1">
                  <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={() => run(() => restoreOrderStep(s.id))}>
                    Restore
                  </Button>
                  {s.placed === 0 && (
                    <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={() => run(() => deleteOrderStep(s.id))}>
                      Delete
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {draft && (
        <Dialog open onClose={() => setDraft(null)} title={draft.id ? `Change ${editing?.label ?? "the step"}` : `Add a step within ${stepStatusLabel(draft.status).toLowerCase()}`}>
          {error && (
            <p role="alert" className="mb-3 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="order-step-label" className="text-xs">
                Name
              </Label>
              <Input id="order-step-label" placeholder="Material ordered" maxLength={STEP_LIMITS.label} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="order-step-status" className="text-xs">
                Within
              </Label>
              {/* Fixed once made: its orders sit within the status. */}
              <Select id="order-step-status" value={draft.status} disabled={!!draft.id} onChange={(e) => setDraft({ ...draft, status: e.target.value as OrderStatus })}>
                {STEP_STATUSES.map((s) => (
                  <option key={s.status} value={s.status}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </div>
            <fieldset className="space-y-1">
              <legend className="text-xs font-medium text-text">Colour</legend>
              <div className="flex flex-wrap gap-2">
                {STAGE_COLORS.map((c) => (
                  <label key={c} className="flex cursor-pointer items-center gap-1.5 text-sm">
                    <input type="radio" name="order-step-color" value={c} checked={draft.color === c} onChange={() => setDraft({ ...draft, color: c })} />
                    <Badge tone={c}>{draft.label.trim() || STAGE_COLOR_LABELS[c]}</Badge>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="button" size="sm" disabled={isPending || !draft.label.trim()} onClick={() => run(() => saveOrderStep(draft.id ? draft : { ...draft, id: undefined }), () => setDraft(null))}>
              {isPending ? "Saving…" : draft.id ? "Save" : "Add the step"}
            </Button>
          </div>
        </Dialog>
      )}

      {retiring && (
        <Dialog open onClose={() => setRetiring(null)} title={`Retire ${retiring.step.label}`}>
          {error && (
            <p role="alert" className="mb-3 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          <div className="space-y-3 text-sm">
            <p className="text-muted">It will no longer be offered. It can be restored later.</p>
            {retiring.step.placed > 0 &&
              (stepRehomeTargets(retiring.step, steps).length === 0 ? (
                <p className="text-warning">Add another step within {stepStatusLabel(retiring.step.status).toLowerCase()} first — its {ordersText(retiring.step.placed).toLowerCase()} need somewhere to go.</p>
              ) : (
                <div className="space-y-1">
                  <Label htmlFor="order-step-retire-target" className="text-xs">
                    Move its {ordersText(retiring.step.placed).toLowerCase()} to
                  </Label>
                  <Select id="order-step-retire-target" value={retiring.moveTo} onChange={(e) => setRetiring({ ...retiring, moveTo: e.target.value })}>
                    {stepRehomeTargets(retiring.step, steps).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                </div>
              ))}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setRetiring(null)} disabled={isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isPending || (retiring.step.placed > 0 && !retiring.moveTo)}
              onClick={() => run(() => retireOrderStep(retiring.step.id, retiring.moveTo || null), () => setRetiring(null))}
            >
              {isPending ? "Retiring…" : "Retire"}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
