"use client";

import { useId, useState } from "react";
import { Plus, SlidersHorizontal, X } from "lucide-react";
import { consoleSetLimitOverrides, consoleSetModuleOverride } from "@/actions/platform/console";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { StatusPill } from "@/components/console/kit/status";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Label } from "@/components/ui/input";
import { OptionCombobox } from "@/components/ui/option-combobox";
import type { CatalogueModuleView } from "@/lib/console-shared/types";
import type { PlanPanel } from "@/lib/platform/workspace-data";
import { ALL_CONNECTORS, CONNECTOR_LEVELS } from "@/lib/automate/limits";
import { cn } from "@/lib/utils";
import { EntitlementImpact, useEntitlementPreview } from "./plans-editor";

/**
 * The module and limit overrides of Workspace 360's Plan & modules tab, and the modules grid.
 *
 * An override puts one workspace's module or limit in place of what its plans say — so each one is
 * previewed on the server before it is made (what the workspace gains or loses, the save's own
 * refusal), asks why, and is recorded with the reason. Removing one goes back to the plans.
 */

// ─── Modules grid ────────────────────────────────────────────────────────────────────────────────

type ModuleRow = PlanPanel["modules"][number];

const STATE: Record<ModuleRow["state"], { text: string; tone: "success" | "danger" | "neutral"; entitled: boolean; order: number }> = {
  added: { text: "added", tone: "success", entitled: true, order: 0 },
  plan: { text: "From its plans", tone: "neutral", entitled: true, order: 1 },
  taken: { text: "taken away", tone: "danger", entitled: false, order: 2 },
  none: { text: "Not included", tone: "neutral", entitled: false, order: 3 },
  country: { text: "Not sold here", tone: "neutral", entitled: false, order: 4 },
};

/**
 * Every module a plan decides, and where this workspace stands with each — in the grid by default
 * only what it has ("Entitled only"), or the whole catalogue with why each is missing.
 */
export function ModuleGrid({ modules, country }: { modules: ModuleRow[]; country: string }) {
  const [view, setView] = useState<"entitled" | "all">("entitled");
  const entitled = modules.filter((m) => STATE[m.state]?.entitled);
  const shown = [...(view === "entitled" ? entitled : modules)].sort((a, b) => (STATE[a.state]?.order ?? 9) - (STATE[b.state]?.order ?? 9));

  return (
    <div className="space-y-3">
      <div role="group" aria-label="Which modules to show" className="inline-flex max-w-full rounded-base border border-line bg-surface-sunken p-0.5">
        {(
          [
            ["entitled", "Entitled only", entitled.length],
            ["all", "All modules", modules.length],
          ] as const
        ).map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            aria-pressed={view === key}
            onClick={() => setView(key)}
            className={cn(
              "inline-flex h-7 items-center rounded-[6px] px-2.5 text-xs font-medium whitespace-nowrap",
              view === key ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text",
            )}
          >
            {label}
            <span className={cn("ml-1.5 rounded-full px-1.5 text-[11px] tabular-nums", view === key ? "bg-brand-subtle text-brand" : "bg-surface text-muted")}>{count}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="py-4 text-sm text-muted">{view === "entitled" ? "It has none of the modules a plan decides — the core modules only." : "No modules."}</p>
      ) : (
        <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((m) => {
            const s = STATE[m.state] ?? STATE.none;
            const where = m.countries && m.countries.length > 0 ? `Sold only in ${m.countries.join(", ")}` : null;
            return (
              <li key={m.key} className="flex min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-surface-sunken">
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full", s.entitled ? (m.state === "added" ? "bg-success" : "bg-brand") : "bg-subtle")} />
                  <span className={cn("min-w-0 truncate text-sm", s.entitled ? "text-text" : "text-muted")} title={where ?? m.label}>
                    {m.label}
                  </span>
                </span>
                {m.state === "added" || m.state === "taken" ? (
                  <StatusPill tone={s.tone}>{s.text}</StatusPill>
                ) : (
                  <span className="shrink-0 text-[11px] whitespace-nowrap text-subtle" title={m.state === "country" && where ? `${where} — not in ${country}` : undefined}>
                    {m.state === "country" && m.countries && m.countries.length > 0 ? `${m.countries.join(", ")} only` : s.text}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─── Add an override ─────────────────────────────────────────────────────────────────────────────

/** A module added to this workspace, or taken away, whatever its plans say — previewed, with a reason. */
export function AddOverrideButton({ tenantId, catalogue }: { tenantId: string; catalogue: CatalogueModuleView[] }) {
  const [open, setOpen] = useState(false);
  const [moduleKey, setModuleKey] = useState("");
  const [granted, setGranted] = useState(true);
  const preview = useEntitlementPreview(tenantId);
  const save = useConsoleAction<null>();
  const comboId = useId();
  const radioName = useId();

  const labels = Object.fromEntries(catalogue.map((m) => [m.key, m.label]));
  const chosen = catalogue.find((m) => m.key === moduleKey) ?? null;
  const previewKey = `${moduleKey}:${granted}`;
  const ready = !!chosen && preview.key === previewKey && !preview.pending && preview.preview !== null && !preview.preview.refusal;

  function ask(key: string, add: boolean) {
    if (key) preview.request({ override: { moduleKey: key, granted: add } }, `${key}:${add}`);
    else preview.clear();
  }

  function start() {
    save.reset();
    preview.clear();
    setModuleKey("");
    setGranted(true);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    preview.clear();
    save.reset();
  }

  function confirm({ reason }: { reason: string }) {
    if (!ready || !chosen) return;
    const label = chosen.label;
    save.run(() => consoleSetModuleOverride(tenantId, chosen.key, granted, reason), {
      success: granted ? `${label} added — whatever its plans say.` : `${label} taken away — whatever its plans say.`,
      onDone: () => setOpen(false),
    });
  }

  return (
    <>
      <Button type="button" size="sm" variant="secondary" onClick={start}>
        <Plus aria-hidden="true" className="h-4 w-4" />
        Add override
      </Button>
      <ConfirmDialog
        open={open}
        onClose={close}
        title="Add an override"
        confirmLabel={granted ? "Add module" : "Take it away"}
        tone={granted ? "primary" : "danger"}
        reason={{ label: "Why", minLength: 5, maxLength: 300, placeholder: "Kept with the change — e.g. a two-week pilot of Payroll" }}
        pending={save.pending}
        error={save.error}
        confirmDisabled={!ready}
        onConfirm={confirm}
      >
        <div className="space-y-1.5">
          <Label htmlFor={comboId}>Module</Label>
          <OptionCombobox
            id={comboId}
            listLabel="Modules"
            placeholder="Search modules…"
            options={catalogue.map((m) => ({ id: m.key, name: m.label, hint: m.countries && m.countries.length > 0 ? `${m.countries.join(", ")} only` : undefined }))}
            value={moduleKey}
            onSelect={(option) => {
              const key = option?.id ?? "";
              setModuleKey(key);
              ask(key, granted);
            }}
          />
        </div>

        <fieldset className="space-y-2">
          <legend className="text-[13px] font-medium text-muted">Override</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                [true, "Add it", "It has the module whatever its plans say."],
                [false, "Take it away", "It loses the module whatever its plans say."],
              ] as const
            ).map(([value, title, note]) => (
              <label
                key={title}
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5",
                  granted === value ? "border-brand bg-brand-subtle" : "border-line hover:bg-surface-sunken",
                )}
              >
                <input
                  type="radio"
                  name={radioName}
                  checked={granted === value}
                  onChange={() => {
                    setGranted(value);
                    ask(moduleKey, value);
                  }}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand)]"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-text">{title}</span>
                  <span className="block text-xs text-muted">{note}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {moduleKey ? (
          <EntitlementImpact pending={preview.pending} error={preview.error} preview={preview.preview} moduleLabels={labels} />
        ) : (
          <p className="text-xs text-muted">Choose a module to see what changes.</p>
        )}
        <p className="text-xs text-muted">An override stays until it is removed — changing its plans does not clear it.</p>
      </ConfirmDialog>
    </>
  );
}

// ─── Remove an override ──────────────────────────────────────────────────────────────────────────

/** Back to what its plans say about one module (T1). */
export function RemoveOverrideButton({ tenantId, moduleKey, label }: { tenantId: string; moduleKey: string; label: string }) {
  const [open, setOpen] = useState(false);
  const { pending, error, run, reset } = useConsoleAction<null>();

  function close() {
    setOpen(false);
    reset();
  }

  return (
    <>
      <IconButton
        icon={X}
        tone="danger"
        label={`Remove the override on ${label}`}
        onClick={() => {
          reset();
          setOpen(true);
        }}
      />
      <ConfirmDialog
        open={open}
        onClose={close}
        title="Remove override"
        confirmLabel="Remove override"
        pending={pending}
        error={error}
        onConfirm={() => run(() => consoleSetModuleOverride(tenantId, moduleKey, null, ""), { success: `${label} follows its plans again.`, onDone: () => setOpen(false) })}
      >
        <p>{`${label} goes back to what its plans say — it keeps the module only if a plan includes it.`}</p>
      </ConfirmDialog>
    </>
  );
}

// ─── Limits ──────────────────────────────────────────────────────────────────────────────────────

/** What was typed as a limit: empty is "the plans decide" (null), a whole number 0–`max`, or invalid. */
function limitOf(text: string, max = 1_000_000_000): { ok: true; value: number | null } | { ok: false } {
  const t = text.trim();
  if (t === "") return { ok: true, value: null };
  if (!/^\d{1,10}$/.test(t)) return { ok: false };
  const n = Number(t);
  return n <= max ? { ok: true, value: n } : { ok: false };
}

const PREVIEW_DELAY_MS = 400;

type LimitKey = "seats" | "copilotTokens" | "customDomains" | "workflows" | "steps" | "historyDays" | "connectors";

/** The overrides, in the dialog's order; Deskzo Automate's four under their own heading. */
const LIMIT_FIELDS: { key: LimitKey; label: string; hint: string; automate?: true; max?: number }[] = [
  { key: "seats", label: "Seats", hint: "People who may hold an active account." },
  { key: "copilotTokens", label: "AI credits a month", hint: "Deskzo AI credits across everybody, in place of the plans'; 0 leaves only the packs it buys." },
  { key: "customDomains", label: "Custom domains", hint: "Addresses of its own, waiting or live; 0 allows none." },
  { key: "workflows", label: "Workflows switched on", hint: "At once; 0 allows none.", automate: true },
  { key: "steps", label: "Steps a month", hint: "Across everybody; 0 starts no run.", automate: true },
  { key: "historyDays", label: "Days of run history", hint: "How long a finished run is kept.", automate: true },
  {
    key: "connectors",
    label: "Connectors",
    // Each level includes the ones before it.
    hint: CONNECTOR_LEVELS.map((c) => `${c.level}: ${c.label}`).join(" · "),
    automate: true,
    max: ALL_CONNECTORS,
  },
];
const LIMIT_KEYS = LIMIT_FIELDS.map((f) => f.key);
const NO_TEXT = Object.fromEntries(LIMIT_KEYS.map((k) => [k, ""])) as Record<LimitKey, string>;

/**
 * Seats, AI credits, custom domains and Deskzo Automate's limits for this workspace alone, in place
 * of what its plans add up to — empty lets the plans decide again. The preview follows the typing
 * (after a short pause).
 */
export function LimitsButton({ tenantId, current }: { tenantId: string; current: Record<LimitKey, number | null> }) {
  const [open, setOpen] = useState(false);
  const [texts, setTexts] = useState<Record<LimitKey, string>>(NO_TEXT);
  const preview = useEntitlementPreview(tenantId);
  const save = useConsoleAction<null>();
  const baseId = useId();

  const read = (all: Record<LimitKey, string>) => {
    const values = {} as Record<LimitKey, number | null>;
    for (const f of LIMIT_FIELDS) {
      const v = limitOf(all[f.key], f.max);
      if (!v.ok) return null;
      values[f.key] = v.value;
    }
    return values;
  };
  const keyOf = (all: Record<LimitKey, string>) => LIMIT_KEYS.map((k) => all[k].trim()).join("|");
  const same = (values: Record<LimitKey, number | null>) => LIMIT_KEYS.every((k) => values[k] === current[k]);
  const changeOf = (v: Record<LimitKey, number | null>) => ({
    seats: v.seats,
    copilotTokens: v.copilotTokens,
    customDomains: v.customDomains,
    automation: { workflows: v.workflows, steps: v.steps, historyDays: v.historyDays, connectors: v.connectors },
  });

  const values = read(texts);
  const unchanged = values !== null && same(values);
  const ready = values !== null && !unchanged && preview.key === keyOf(texts) && !preview.pending && preview.preview !== null && !preview.preview.refusal;

  function type(next: Record<LimitKey, string>) {
    setTexts(next);
    const v = read(next);
    if (v === null || same(v)) {
      preview.clear();
      return;
    }
    preview.request({ limits: changeOf(v) }, keyOf(next), PREVIEW_DELAY_MS);
  }

  function start() {
    save.reset();
    preview.clear();
    setTexts(Object.fromEntries(LIMIT_KEYS.map((k) => [k, current[k] === null ? "" : String(current[k])])) as Record<LimitKey, string>);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    preview.clear();
    save.reset();
  }

  function confirm() {
    if (!ready || values === null) return;
    const all = LIMIT_KEYS.every((k) => values[k] === null);
    save.run(() => consoleSetLimitOverrides(tenantId, changeOf(values)), {
      success: all ? "Limits cleared — its plans decide again." : "Limits saved.",
      onDone: () => setOpen(false),
    });
  }

  const field = (f: (typeof LIMIT_FIELDS)[number]) => {
    const id = `${baseId}-${f.key}`;
    const ok = limitOf(texts[f.key], f.max).ok;
    return (
      <div key={f.key} className="space-y-1.5">
        <Label htmlFor={id}>{f.label}</Label>
        <Input
          id={id}
          inputMode="numeric"
          autoComplete="off"
          placeholder="Plans decide"
          value={texts[f.key]}
          aria-invalid={!ok || undefined}
          onChange={(e) => type({ ...texts, [f.key]: e.target.value })}
        />
        <p className={cn("text-xs", ok ? "text-subtle" : "text-danger")}>{ok ? f.hint : f.max !== undefined ? `A level from 0 to ${f.max}.` : "A whole number, 0 or more."}</p>
      </div>
    );
  };

  return (
    <>
      <Button type="button" size="sm" variant="secondary" onClick={start}>
        <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
        Override limits…
      </Button>
      <ConfirmDialog
        open={open}
        onClose={close}
        title="Override limits"
        confirmLabel="Save limits"
        pending={save.pending}
        error={save.error}
        confirmDisabled={!ready}
        onConfirm={confirm}
      >
        <p className="text-muted">In place of what its plans add up to. Leave a field empty to let the plans decide.</p>
        <div className="grid gap-3 sm:grid-cols-2">{LIMIT_FIELDS.filter((f) => !f.automate).map(field)}</div>
        <p className="pt-1 text-sm font-medium">Deskzo Automate</p>
        <div className="grid gap-3 sm:grid-cols-2">{LIMIT_FIELDS.filter((f) => f.automate).map(field)}</div>
        {LIMIT_KEYS.some((k) => texts[k].trim() !== "") && (
          <Button type="button" size="sm" variant="ghost" onClick={() => type(NO_TEXT)}>
            Clear all — let the plans decide
          </Button>
        )}
        {unchanged ? (
          <p className="text-xs text-muted">These are its limits now — change one to see what it does.</p>
        ) : (
          values !== null && <EntitlementImpact pending={preview.pending} error={preview.error} preview={preview.preview} scope="limits" />
        )}
      </ConfirmDialog>
    </>
  );
}
