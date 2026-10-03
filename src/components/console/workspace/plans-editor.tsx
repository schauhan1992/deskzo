"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { LoaderCircle, Lock, Minus, Plus, RotateCcw } from "lucide-react";
import { consoleSetWorkspacePlans } from "@/actions/platform/console";
import { consolePreviewEntitlements } from "@/actions/platform/console-workspace";
import { Banner } from "@/components/console/kit/banner";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { DiffChips, ImpactList } from "@/components/console/kit/impact";
import { StatusPill } from "@/components/console/kit/status";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { useClock } from "@/components/time/clock-provider";
import { ActionNotice } from "@/components/ui/action-notice";
import { Checkbox } from "@/components/ui/bulk-select";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { plural } from "@/lib/console-shared/format";
import { planKindLabel, standingLabel } from "@/lib/console-shared/labels";
import type { Tone } from "@/lib/console-shared/types";
import { productRefusal } from "@/lib/billing/plan-choice";
import type { EntitlementChange, EntitlementPreview } from "@/lib/platform/entitlement-preview";
import type { PlanPanel } from "@/lib/platform/workspace-data";
import { PRODUCTS, productByKey } from "@/lib/products";
import { cn } from "@/lib/utils";

/**
 * The plans a workspace is on, as a checklist it can be changed in (Workspace 360 › Plan & modules).
 *
 * Nothing is saved blind: "Save plans" asks the server what the change would do — the modules it
 * gains and loses, seats and copilot tokens before and after, the billing standing it lands in —
 * and the save's own refusal, word for word, when it would refuse. The confirmation stays off
 * until that preview is in and says yes.
 *
 * Offered: every plan on sale in the workspace's country, and anything it is on already (a retired
 * plan may stay; it cannot come back once taken off). Internal plans are an owner's to give.
 *
 * Grouped as they are sold: Deskzo One, each product in src/lib/products.ts's order, editions of
 * their own, then bundles and add-ons, then internal plans. One plan for each product, and Deskzo
 * One with no other — the save refuses otherwise (src/lib/billing/plan-choice.ts), and the list says
 * so as soon as the ticks break the rule.
 */

const QUANTITY_MAX = 10_000;
const INTEGER = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

type Choice = PlanPanel["choices"][number];

/** A quantity as typed: a whole number from 1 to 10,000, or null. */
function quantityOf(text: string): number | null {
  if (!/^\d{1,5}$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= 1 && n <= QUANTITY_MAX ? n : null;
}

/** Each ticked plan with its quantity as a number (null while what was typed is not one). */
function pairs(record: Record<string, string>): [string, number | null][] {
  return Object.entries(record).map(([key, text]): [string, number | null] => [key, quantityOf(text)]);
}

/** "crm:1|seats:2" — the same plans in any order read the same. */
function signature(entries: [string, number | null][]): string {
  return entries
    .map(([key, q]) => `${key}:${q ?? "?"}`)
    .sort()
    .join("|");
}

/** The plans offered, grouped as they are sold — see the top of this file. Empty groups are left out. */
function groupChoices(plans: Choice[]): { key: string; title: string; plans: Choice[] }[] {
  const groups = [
    ...PRODUCTS.map((p) => ({ key: p.key, title: p.name, plans: plans.filter((c) => c.kind === "EDITION" && c.productKey === p.key) })),
    { key: "own", title: "Editions of their own", plans: plans.filter((c) => c.kind === "EDITION" && !productByKey(c.productKey)) },
    { key: "extras", title: "Bundles and add-ons", plans: plans.filter((c) => c.kind === "BUNDLE" || c.kind === "ADDON") },
    { key: "internal", title: "Internal", plans: plans.filter((c) => c.kind === "INTERNAL") },
  ];
  return groups.filter((g) => g.plans.length > 0);
}

/** The current plans by key, added up — a key listed twice is one line with both quantities. */
function merge(current: { planKey: string; quantity: number }[]): Record<string, string> {
  const out: Record<string, number> = {};
  for (const c of current) out[c.planKey] = (out[c.planKey] ?? 0) + Math.max(1, Math.floor(c.quantity) || 1);
  return Object.fromEntries(Object.entries(out).map(([k, q]) => [k, String(q)]));
}

export function PlansEditor({
  tenantId,
  country,
  current,
  choices,
  owner,
  moduleLabels,
}: {
  tenantId: string;
  country: string;
  current: { planKey: string; quantity: number }[];
  choices: PlanPanel["choices"];
  owner: boolean;
  /** Module key → label, for the preview's gained/lost chips (the page has the catalogue). */
  moduleLabels?: Record<string, string>;
}) {
  const [initial] = useState(() => merge(current));
  const [chosen, setChosen] = useState<Record<string, string>>(initial);
  const [open, setOpen] = useState(false);
  const preview = useEntitlementPreview(tenantId);
  const save = useConsoleAction<null>();

  const onIt = new Set(Object.keys(initial));
  const offered = choices.filter((p) => onIt.has(p.key) || (p.active && (p.countries.length === 0 || p.countries.includes(country)) && (owner || p.kind !== "INTERNAL")));

  const entries = pairs(chosen);
  const invalid = entries.filter(([, q]) => q === null).map(([key]) => choices.find((c) => c.key === key)?.name ?? key);
  const dirty = signature(entries) !== signature(pairs(initial));
  const items = entries.flatMap(([planKey, quantity]) => (quantity === null ? [] : [{ planKey, quantity }]));
  const ready = preview.key === signature(entries) && !preview.pending && preview.preview !== null && !preview.preview.refusal;
  // The product rules, said as soon as the ticks break them — the save's own words.
  const clash = productRefusal(choices.filter((c) => c.key in chosen).map((c) => ({ ...c, modules: [] })));
  const removed = preview.preview?.diff.modulesRemoved.length ?? 0;

  function toggle(plan: Choice, on: boolean) {
    setChosen((prev) => {
      const next = { ...prev };
      if (on) next[plan.key] = prev[plan.key] ?? "1";
      else delete next[plan.key];
      return next;
    });
  }

  function setQuantity(key: string, text: string) {
    setChosen((prev) => ({ ...prev, [key]: text.replace(/[^\d]/g, "").slice(0, 5) }));
  }

  function step(key: string, by: number) {
    setChosen((prev) => {
      const q = quantityOf(prev[key] ?? "") ?? 1;
      return { ...prev, [key]: String(Math.min(QUANTITY_MAX, Math.max(1, q + by))) };
    });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!dirty || invalid.length > 0) return;
    save.reset();
    setOpen(true);
    preview.request({ plans: items }, signature(entries));
  }

  function close() {
    setOpen(false);
    preview.clear();
    save.reset();
  }

  function confirm() {
    if (!ready) return;
    save.run(() => consoleSetWorkspacePlans(tenantId, items), {
      success: items.length === 0 ? "Plans taken off — it has the core modules only." : "Plans saved — what it may use is worked out again.",
      onDone: () => setOpen(false),
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-xs text-muted">
        Tick the plans it is on; a quantity multiplies what a plan includes. Plans offered in {country}
        {owner ? ", internal ones included" : ""}.
      </p>

      {offered.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
          No plan is offered in {country} yet —{" "}
          <Link href="/plans" className="font-medium text-brand hover:underline">
            see Plans
          </Link>
          .
        </p>
      ) : (
        <div className="space-y-3">
          {groupChoices(offered).map((group) => (
            <div key={group.key}>
              <p className="mb-1 text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase">{group.title}</p>
              <ul className="divide-y divide-line rounded-lg border border-line">
                {group.plans.map((plan) => {
                  const on = plan.key in chosen;
                  // An internal plan already on it stays in view, but only an owner changes it.
                  const locked = plan.kind === "INTERNAL" && !owner;
                  const text = chosen[plan.key] ?? "";
                  const q = quantityOf(text);
                  const was = initial[plan.key];
                  return (
                    <li key={plan.key} className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2", on && "bg-surface-sunken/60")}>
                      <label className={cn("flex min-w-0 items-center gap-2.5", locked ? "cursor-not-allowed" : "cursor-pointer")}>
                        <Checkbox checked={on} disabled={locked} onChange={(e) => toggle(plan, e.target.checked)} className="shrink-0" />
                        <span className="min-w-0 truncate text-sm font-medium text-text">{plan.name}</span>
                        <StatusPill tone={plan.kind === "INTERNAL" ? "brand" : "neutral"}>{planKindLabel(plan.kind)}</StatusPill>
                        {!plan.active && <StatusPill tone="warning">Retired</StatusPill>}
                        {was !== undefined && <span className="text-[11px] whitespace-nowrap text-subtle">{`on it now${was !== "1" ? ` ×${was}` : ""}`}</span>}
                        {locked && (
                          <span className="inline-flex items-center gap-1 text-[11px] whitespace-nowrap text-subtle">
                            <Lock aria-hidden="true" className="h-3 w-3" />
                            an owner&apos;s to change
                          </span>
                        )}
                      </label>
                      {on && !locked && (
                        <span className="inline-flex items-center rounded-base border border-line-strong bg-surface shadow-sm">
                          <IconButton icon={Minus} label={`Fewer of ${plan.name}`} onClick={() => step(plan.key, -1)} disabled={q !== null && q <= 1} />
                          <input
                            type="text"
                            inputMode="numeric"
                            aria-label={`Quantity of ${plan.name}`}
                            aria-invalid={q === null || undefined}
                            value={text}
                            onChange={(e) => setQuantity(plan.key, e.target.value)}
                            className={cn("h-7 w-12 border-x border-line bg-transparent text-center text-sm text-text tabular-nums", q === null && "text-danger")}
                          />
                          <IconButton icon={Plus} label={`More of ${plan.name}`} onClick={() => step(plan.key, 1)} disabled={q !== null && q >= QUANTITY_MAX} />
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      {clash && <ActionNotice tone="error">{clash}</ActionNotice>}
      {invalid.length > 0 && <ActionNotice tone="error">{`A quantity is a whole number from 1 to 10,000 — check ${invalid.join(", ")}.`}</ActionNotice>}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button type="submit" size="sm" disabled={!dirty || invalid.length > 0}>
          Save plans
        </Button>
        {dirty && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setChosen(initial)}>
            <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
            Undo changes
          </Button>
        )}
        <span className="text-xs text-muted">
          {dirty ? "Not saved yet — the next step shows what changes." : entries.length === 0 ? "On no plan: the core modules only." : `${plural(entries.length, "plan")} ticked.`}
        </span>
      </div>

      <ConfirmDialog
        open={open}
        onClose={close}
        title="Save plans"
        confirmLabel="Save plans"
        pending={save.pending}
        error={save.error}
        confirmDisabled={!ready}
        checks={removed > 0 ? [`It loses ${plural(removed, "module")} at once — its people can no longer open ${removed === 1 ? "it" : "them"}.`] : undefined}
        onConfirm={confirm}
      >
        <p>
          {items.length === 0
            ? "Every plan comes off: it keeps the core modules only."
            : `It will be on ${items.map((i) => `${choices.find((c) => c.key === i.planKey)?.name ?? i.planKey}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`).join(", ")}.`}
        </p>
        <EntitlementImpact pending={preview.pending} error={preview.error} preview={preview.preview} moduleLabels={moduleLabels} />
      </ConfirmDialog>
    </form>
  );
}

// ─── The preview, shared with the override and limit dialogs ─────────────────────────────────────

type PreviewState = { key: string | null; preview: EntitlementPreview | null; error: string | null };
const NO_PREVIEW: PreviewState = { key: null, preview: null, error: null };
const PREVIEW_FAILED = "The preview could not be worked out — close this and try again.";

/**
 * What a change would do, asked of the server from an event handler (never on render). `key` names
 * the inputs a preview was worked out for, so a dialog can tell a preview of what is on screen now
 * from one of what was there a keystroke ago; an answer to an older question is dropped.
 */
export function useEntitlementPreview(tenantId: string): PreviewState & {
  pending: boolean;
  request(change: EntitlementChange, key: string, delayMs?: number): void;
  clear(): void;
} {
  const [state, setState] = useState<PreviewState>(NO_PREVIEW);
  const [pending, setPending] = useState(false);
  const seq = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const pendingTimer = timer;
    return () => window.clearTimeout(pendingTimer.current);
  }, []);

  const request = useCallback(
    (change: EntitlementChange, key: string, delayMs = 0) => {
      window.clearTimeout(timer.current);
      const asked = ++seq.current;
      setState(NO_PREVIEW);
      setPending(true);
      const ask = async () => {
        let next: PreviewState;
        try {
          const result = await consolePreviewEntitlements(tenantId, change);
          next = result.ok ? { key, preview: result.data, error: null } : { key, preview: null, error: result.error || PREVIEW_FAILED };
        } catch {
          next = { key, preview: null, error: PREVIEW_FAILED };
        }
        if (asked !== seq.current) return;
        setState(next);
        setPending(false);
      };
      if (delayMs > 0) timer.current = window.setTimeout(() => void ask(), delayMs);
      else void ask();
    },
    [tenantId],
  );

  const clear = useCallback(() => {
    window.clearTimeout(timer.current);
    seq.current++;
    setState(NO_PREVIEW);
    setPending(false);
  }, []);

  return { ...state, pending, request, clear };
}

const seatsText = (n: number | null) => (n === null ? "No limit" : INTEGER.format(n));
const tokensText = (n: number | null) => (n === null ? "No limit" : n === 0 ? "None" : INTEGER.format(n));

/** Null is "no limit" — more than any number. */
const lessThan = (a: number | null, b: number | null) => b !== null && (a === null || b < a);

function limitChange(pair: [number | null, number | null], text: (n: number | null) => string): { value: string; tone?: Tone } {
  const [before, after] = pair;
  if (before === after) return { value: `${text(after)} · no change` };
  return { value: `${text(before)} → ${text(after)}`, tone: lessThan(before, after) ? "warning" : "success" };
}

/**
 * The preview in a confirmation: the save's refusal first (it is why the button is off), then the
 * modules gained and lost, the limits before and after, and the billing standing it lands in.
 * `limits` shows the limits alone — a limit changes no module.
 */
export function EntitlementImpact({
  pending,
  error,
  preview,
  moduleLabels,
  scope = "all",
}: {
  pending: boolean;
  error: string | null;
  preview: EntitlementPreview | null;
  moduleLabels?: Record<string, string>;
  scope?: "all" | "limits";
}) {
  const clock = useClock();
  let body: ReactNode = null;
  if (pending) {
    body = (
      <p className="flex items-center gap-2 text-xs text-muted">
        <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
        Working out what changes…
      </p>
    );
  } else if (error) {
    body = <ActionNotice tone="error">{error}</ActionNotice>;
  } else if (preview) {
    const label = (key: string) => moduleLabels?.[key] ?? key;
    const seats = limitChange(preview.diff.seats, seatsText);
    const tokens = limitChange(preview.diff.copilotTokens, tokensText);
    const domains = limitChange(preview.diff.customDomains, tokensText);
    const standing = standingLabel(preview.standingAfter, null, "", clock);
    body = (
      <div className="space-y-3">
        {preview.refusal && (
          <Banner tone="danger" title="This can't be saved">
            {preview.refusal}
          </Banner>
        )}
        {scope === "all" && (
          <DiffChips added={preview.diff.modulesAdded.map(label)} removed={preview.diff.modulesRemoved.map(label)} addedLabel="Modules gained" removedLabel="Modules lost" />
        )}
        <ImpactList
          items={[
            { label: "Seats", value: seats.value, tone: seats.tone },
            { label: "Copilot tokens a month", value: tokens.value, tone: tokens.tone },
            { label: "Custom domains", value: domains.value, tone: domains.tone },
            ...(scope === "all" ? [{ label: "Billing standing after", value: <StatusPill tone={standing.tone}>{standing.label}</StatusPill> }] : []),
          ]}
        />
      </div>
    );
  }
  // Always mounted, so the preview arriving is read out.
  return (
    <div aria-live="polite" aria-busy={pending || undefined}>
      {body}
    </div>
  );
}
