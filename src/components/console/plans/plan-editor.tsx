"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, LoaderCircle, Lock, Search, X } from "lucide-react";
import { consoleSavePlan } from "@/actions/platform/console";
import { consolePreviewPlanSave } from "@/actions/platform/console-billing";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { AffectedList, DiffChips, ImpactList } from "@/components/console/kit/impact";
import { DefinitionList, InsetBlock, Panel } from "@/components/console/kit/panel";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { Checkbox } from "@/components/ui/bulk-select";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { compactNumber, plural } from "@/lib/console-shared/format";
import { planKindLabel } from "@/lib/console-shared/labels";
import type { CatalogueModuleView, PlanKindKey, Tone } from "@/lib/console-shared/types";
import { withDependencies } from "@/lib/entitlements";
import { getModuleDefinition, navGroupRank } from "@/lib/modules";
import type { PlanDetail } from "@/lib/platform/console-data";
import type { PlanSavePreview } from "@/lib/platform/entitlement-preview";
import type { PlanInput } from "@/lib/platform/plans";
import { cn } from "@/lib/utils";
import { PriceEditor } from "./price-editor";

/**
 * The plan editor (`/plans/new`, `/plans/[key]`) — a full page in place of the old hidden forms.
 *
 * Sections with a side-nav, and one sticky Save bar. Saving is a T2 confirmation fed by the server's
 * own preview (`consolePreviewPlanSave`): how many workspaces are worked out again, the modules added
 * and removed, and — when some workspace would lose a module it has now — the plan key typed to go on.
 * The checks here mirror the save's (src/lib/platform/plans.ts `checkPlanInput`) only to point at the
 * field early; the save checks everything again and its refusal is what the dialog shows.
 *
 * Read-only viewers get the same sections as definition lists, and no controls at all.
 */

type Mode = "create" | "edit" | "duplicate";
type SectionKey = "basics" | "availability" | "limits" | "modules" | "prices" | "workspaces";
type Field = "key" | "name" | "order" | "seats" | "copilot" | "domains" | "countries" | "modules";
type Problem = { section: SectionKey; field: Field; message: string };

type Draft = {
  key: string;
  name: string;
  kind: PlanKindKey;
  description: string;
  sortOrder: string;
  active: boolean;
  isDefault: boolean;
  countries: string[];
  seats: string;
  copilot: string;
  /** Custom domains per unit: blank is no limit, 0 none. */
  domains: string;
  allModules: boolean;
  modules: string[];
};

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const MAX_LIMIT = 1_000_000_000;
const MAX_DESCRIPTION = 500;
const EVERY_PLAN = "In every plan";
const PREVIEW_FAILED = "Couldn't work out what saving changes. Close this and try again.";

const KINDS: { value: PlanKindKey; title: string; body: string }[] = [
  { value: "EDITION", title: "Edition", body: "A workspace's base: the modules it runs on and the people included." },
  { value: "BUNDLE", title: "Bundle", body: "Several modules sold together, on top of an edition." },
  { value: "ADDON", title: "Add-on", body: "One more thing: a module, more people, more copilot." },
  { value: "INTERNAL", title: "Internal", body: "Never sold: the installation's own workspace and staff test workspaces." },
];

const SECTION_LABELS: Record<SectionKey, string> = {
  basics: "Basics",
  availability: "Availability",
  limits: "Limits",
  modules: "Modules",
  prices: "Prices",
  workspaces: "Workspaces on it",
};

const EMPTY: Draft = {
  key: "",
  name: "",
  kind: "EDITION",
  description: "",
  sortOrder: "0",
  active: true,
  isDefault: false,
  countries: [],
  seats: "",
  copilot: "",
  // A sold plan offers no custom domain until staff say so.
  domains: "0",
  allModules: false,
  modules: [],
};

function draftOf(plan: PlanDetail | null): Draft {
  if (!plan) return EMPTY;
  return {
    key: plan.key,
    name: plan.name,
    kind: plan.kind,
    description: plan.description ?? "",
    sortOrder: String(plan.sortOrder),
    active: plan.active,
    isDefault: plan.isDefault,
    countries: [...plan.countries],
    seats: plan.seats === null ? "" : String(plan.seats),
    copilot: plan.copilotTokens === null ? "" : String(plan.copilotTokens),
    domains: plan.customDomains === null ? "" : String(plan.customDomains),
    allModules: plan.allModules,
    modules: [...plan.modules],
  };
}

const limitOf = (text: string): number | null => (text.trim() === "" ? null : Number(text.trim()));

/** The draft as the save takes it — what the preview and the save are both sent. */
function inputOf(d: Draft): PlanInput {
  const internal = d.kind === "INTERNAL";
  const every = internal && d.allModules;
  const order = Number(d.sortOrder.trim());
  return {
    key: d.key.trim().toLowerCase(),
    name: d.name.trim(),
    kind: d.kind,
    description: d.description.trim() || null,
    allModules: every,
    modules: every ? [] : [...d.modules],
    countries: [...d.countries],
    seats: limitOf(d.seats),
    copilotTokens: limitOf(d.copilot),
    customDomains: limitOf(d.domains),
    // New workspaces never start on an internal plan, nor on a retired one — the save refuses both.
    isDefault: !internal && d.active && d.isDefault,
    active: d.active,
    sortOrder: Number.isInteger(order) ? order : 0,
  };
}

/** Order-free, so ticking a module off and on again is not a change. */
const signature = (input: PlanInput) => JSON.stringify({ ...input, modules: [...input.modules].sort(), countries: [...input.countries].sort() });

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 50)
    .replace(/-+$/, "");

const labelOf = (key: string) => getModuleDefinition(key)?.label ?? key;

const limitText = (value: number | null, none = "No limit") => (value === null ? none : value.toLocaleString("en-IN"));

function problemsOf(d: Draft, mode: Mode, takenKeys: readonly string[], byKey: Map<string, CatalogueModuleView>): Problem[] {
  const out: Problem[] = [];
  const input = inputOf(d);
  if (mode !== "edit") {
    if (!KEY_PATTERN.test(input.key)) out.push({ section: "basics", field: "key", message: "A key is 3–50 lower-case letters, digits and dashes, like crm-starter." });
    else if (input.key === "new") out.push({ section: "basics", field: "key", message: "“new” is the address of this page — choose another key." });
    else if (takenKeys.includes(input.key)) out.push({ section: "basics", field: "key", message: "A plan with this key already exists — open it from Plans to change it." });
  }
  if (input.name.length < 2 || input.name.length > 80) out.push({ section: "basics", field: "name", message: "Give the plan a name of 2–80 characters." });
  if (d.sortOrder.trim() !== "" && !Number.isInteger(Number(d.sortOrder.trim()))) out.push({ section: "basics", field: "order", message: "Order is a whole number." });
  const badLimit = (n: number | null) => n !== null && !(Number.isInteger(n) && n >= 0 && n <= MAX_LIMIT);
  if (badLimit(input.seats)) out.push({ section: "limits", field: "seats", message: "Users per unit is a whole number, 0 or more — or empty for no limit." });
  if (badLimit(input.copilotTokens)) out.push({ section: "limits", field: "copilot", message: "Copilot tokens is a whole number, 0 or more — or empty for no limit." });
  if (badLimit(input.customDomains ?? null)) out.push({ section: "limits", field: "domains", message: "Custom domains is a whole number, 0 or more — or empty for no limit." });
  if (!input.allModules) {
    for (const key of input.modules) {
      const only = byKey.get(key)?.countries;
      if (only && (input.countries.length === 0 || input.countries.some((c) => !only.includes(c)))) {
        const label = byKey.get(key)?.label ?? key;
        out.push({ section: "modules", field: "modules", message: `${label} is sold only in ${only.join(", ")} — limit the plan to ${only.join(", ")} under Availability, or leave it out.` });
      }
    }
  }
  return out;
}

/** Highlights the section being read in the side-nav. The state is set from the observer's callback, never in the effect body. */
function useActiveSection(keys: readonly SectionKey[]): SectionKey {
  const [active, setActive] = useState<SectionKey>(keys[0] ?? "basics");
  const joined = keys.join(",");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const ids = joined.split(",") as SectionKey[];
    const visible = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting);
        const first = ids.find((k) => visible.get(`plan-${k}`));
        if (first) setActive(first);
      },
      // Below the sticky top bar, and only the upper part of the screen counts as "reading".
      { rootMargin: "-72px 0px -55% 0px" },
    );
    for (const k of ids) {
      const el = document.getElementById(`plan-${k}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [joined]);
  return active;
}

export function PlanEditor({
  initial,
  catalogue,
  owner,
  mode,
  readOnly,
  takenKeys = [],
}: {
  initial: PlanDetail | null;
  catalogue: CatalogueModuleView[];
  owner: boolean;
  mode: Mode;
  readOnly: boolean;
  /** Keys already used, so a new plan never quietly saves over one (the save creates or changes by key). */
  takenKeys?: string[];
}) {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial));
  const [keyTouched, setKeyTouched] = useState(mode !== "create");
  const [attempted, setAttempted] = useState(false);

  const byKey = useMemo(() => new Map(catalogue.map((m) => [m.key, m])), [catalogue]);
  const initialInput = useMemo(() => inputOf(draftOf(initial)), [initial]);
  const input = inputOf(draft);
  const dirty = mode !== "edit" || signature(input) !== signature(initialInput);
  const problems = problemsOf(draft, mode, takenKeys, byKey);
  const errors: Partial<Record<Field, string>> = {};
  for (const p of problems) if (attempted || p.field === "modules") errors[p.field] ??= p.message;

  const savedKind = initial?.kind ?? draft.kind;
  const sections: SectionKey[] = ["basics", "availability", "limits", "modules"];
  if (mode === "edit" && savedKind !== "INTERNAL") sections.push("prices");
  if (mode === "edit") sections.push("workspaces");
  const active = useActiveSection(sections);
  const flagged = new Set(attempted ? problems.map((p) => p.section) : []);

  const update = <K extends keyof Draft>(field: K, value: Draft[K]) => setDraft((d) => ({ ...d, [field]: value }));

  // ─── Saving ────────────────────────────────────────────────────────────────────────────────────
  const [saveOpen, setSaveOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<PlanInput | null>(null);
  const [preview, setPreview] = useState<PlanSavePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, startPreview] = useTransition();
  const ticket = useRef(0);
  const save = useConsoleAction<{ id: string; workspaces: number }>();

  function requestSave() {
    setAttempted(true);
    if (problems.length > 0) {
      rootRef.current?.querySelector<HTMLElement>(`[data-plan-field="${problems[0]!.field}"]`)?.focus();
      return;
    }
    const sent = input;
    save.reset();
    setSnapshot(sent);
    setPreview(null);
    setPreviewError(null);
    setSaveOpen(true);
    const mine = ++ticket.current;
    startPreview(async () => {
      try {
        const result = await consolePreviewPlanSave(sent);
        if (mine !== ticket.current) return;
        if (result.ok) setPreview(result.data);
        else setPreviewError(result.error);
      } catch {
        if (mine === ticket.current) setPreviewError(PREVIEW_FAILED);
      }
    });
  }

  function closeSave() {
    ticket.current++;
    setSaveOpen(false);
  }

  function confirmSave() {
    if (!snapshot) return;
    const sent = snapshot;
    save.run(() => consoleSavePlan(sent), {
      success: (data) =>
        mode === "edit" ? (data.workspaces > 0 ? `Plan saved — ${plural(data.workspaces, "workspace")} worked out again.` : "Plan saved.") : `${sent.name} created.`,
      refresh: mode === "edit",
      onDone: () => {
        setSaveOpen(false);
        if (mode !== "edit") router.push(`/plans/${encodeURIComponent(sent.key)}`);
      },
    });
  }

  function discard() {
    setDraft(draftOf(initial));
    setAttempted(false);
  }

  const losing = preview?.losingModules ?? [];
  const createLabel = mode === "edit" ? "Save plan" : "Create plan";

  return (
    <div ref={rootRef} className="grid gap-6 lg:grid-cols-[176px_minmax(0,1fr)]">
      <nav aria-label="Plan sections" className="min-w-0">
        <ol className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:sticky lg:top-20 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
          {sections.map((key) => (
            <li key={key} className="shrink-0">
              <a
                href={`#plan-${key}`}
                aria-current={active === key ? "location" : undefined}
                className={cn(
                  "flex h-8 items-center justify-between gap-2 rounded-base px-3 text-[13px] font-medium whitespace-nowrap",
                  active === key ? "bg-surface text-text shadow-sm lg:shadow-none lg:bg-surface-sunken" : "text-muted hover:text-text",
                )}
              >
                {SECTION_LABELS[key]}
                {flagged.has(key) && (
                  <span className="inline-flex items-center">
                    <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-danger" />
                    <span className="sr-only">(needs a fix)</span>
                  </span>
                )}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="min-w-0 space-y-6">
        <BasicsSection draft={draft} update={update} mode={mode} owner={owner} readOnly={readOnly} savedKind={initial?.kind ?? null} errors={errors} keyTouched={keyTouched} onKeyTouched={() => setKeyTouched(true)} />
        <AvailabilitySection draft={draft} update={update} readOnly={readOnly} />
        <LimitsSection draft={draft} update={update} readOnly={readOnly} errors={errors} />
        <ModulesSection draft={draft} update={update} readOnly={readOnly} catalogue={catalogue} errors={errors} />

        {mode === "edit" && initial && savedKind !== "INTERNAL" && (
          <div id="plan-prices" className="scroll-mt-20">
            <PriceEditor planKey={initial.key} prices={initial.prices} editable={!readOnly} />
          </div>
        )}
        {mode !== "edit" && draft.kind !== "INTERNAL" && (
          <InsetBlock className="text-sm text-muted">Prices are made at the gateway, so they are added once the plan exists — on its page, right after you create it.</InsetBlock>
        )}
        {mode === "edit" && initial && <WorkspacesSection plan={initial} />}

        {!readOnly && (
          // Above the table's lifted row actions (z-[1]–z-[3]) and below the top bar (z-20).
          <div className="sticky bottom-4 z-[4] rounded-xl border border-line bg-surface/95 px-4 py-3 shadow-lg backdrop-blur-md">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 text-xs" aria-live="polite">
                {attempted && problems.length > 0 ? (
                  <p className="text-danger">
                    <span className="font-medium">{plural(problems.length, "thing")} to fix before saving.</span> {problems[0]!.message}
                  </p>
                ) : mode === "edit" ? (
                  dirty ? (
                    <p className="flex items-center gap-2 text-text">
                      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-warning" />
                      Unsaved changes — they reach every workspace on this plan when you save.
                    </p>
                  ) : (
                    <p className="text-muted">No changes yet.</p>
                  )
                ) : (
                  <p className="text-muted">Nothing is saved until you create the plan.</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {mode === "edit" && dirty && (
                  <Button type="button" variant="ghost" size="sm" onClick={discard}>
                    Discard changes
                  </Button>
                )}
                <Button type="button" size="sm" onClick={requestSave} disabled={!dirty}>
                  {createLabel}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {!readOnly && (
        <ConfirmDialog
          open={saveOpen}
          onClose={closeSave}
          title={mode === "edit" ? `Save ${snapshot?.name ?? "plan"}` : `Create ${snapshot?.name ?? "plan"}`}
          confirmLabel={createLabel}
          pending={save.pending}
          error={previewError ?? save.error}
          confirmDisabled={previewing || preview === null}
          typed={losing.length > 0 ? snapshot?.key : undefined}
          onConfirm={confirmSave}
        >
          {preview && snapshot ? (
            <SaveImpact mode={mode} preview={preview} sent={snapshot} before={initialInput} />
          ) : (
            !previewError && (
              <p className="flex items-center gap-2 text-muted">
                <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                Working out what this changes…
              </p>
            )
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}

// ─── Sections ────────────────────────────────────────────────────────────────────────────────────

type Update = <K extends keyof Draft>(field: K, value: Draft[K]) => void;

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-danger">{message}</p>;
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted">{children}</p>;
}

function BasicsSection({
  draft,
  update,
  mode,
  owner,
  readOnly,
  savedKind,
  errors,
  keyTouched,
  onKeyTouched,
}: {
  draft: Draft;
  update: Update;
  mode: Mode;
  owner: boolean;
  readOnly: boolean;
  savedKind: PlanKindKey | null;
  errors: Partial<Record<Field, string>>;
  keyTouched: boolean;
  onKeyTouched: () => void;
}) {
  const nameId = "plan-field-name";
  const keyId = "plan-field-key";
  const descriptionId = "plan-field-description";
  const orderId = "plan-field-order";

  if (readOnly) {
    return (
      <Panel id="plan-basics" title="Basics">
        <DefinitionList
          items={[
            { term: "Name", value: draft.name },
            { term: "Key", value: <span className="font-mono text-xs">{draft.key}</span> },
            { term: "Kind", value: planKindLabel(draft.kind) },
            { term: "Order", value: <span className="tabular-nums">{draft.sortOrder}</span> },
            { term: "Description", value: draft.description || <span className="text-muted">None</span>, wide: true },
          ]}
        />
      </Panel>
    );
  }

  // An internal plan stays internal (the save refuses the change); only an owner makes one.
  const kindLocked = mode === "edit" && savedKind === "INTERNAL";
  const kinds = KINDS.filter((k) => k.value !== "INTERNAL" || owner);

  return (
    <Panel id="plan-basics" title="Basics" description="What the plan is called, and what kind of plan it is.">
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={nameId}>Name</Label>
            <Input
              id={nameId}
              data-plan-field="name"
              value={draft.name}
              maxLength={80}
              autoComplete="off"
              aria-invalid={errors.name ? true : undefined}
              onChange={(e) => {
                const name = e.target.value;
                update("name", name);
                // A new plan's key follows its name until somebody types a key of their own.
                if (!keyTouched && mode === "create") update("key", slugOf(name));
              }}
              placeholder="CRM Starter"
            />
            <FieldError message={errors.name} />
          </div>
          <div className="space-y-1.5">
            {mode === "edit" ? (
              <>
                <p className="text-[13px] font-medium text-muted">Key</p>
                <p className="flex h-9 items-center gap-2 rounded-base border border-line bg-surface-sunken px-3 font-mono text-sm text-text">
                  <Lock aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-subtle" />
                  <span className="truncate">{draft.key}</span>
                </p>
                <Hint>Invitations and scripts name the plan by its key, so it never changes.</Hint>
              </>
            ) : (
              <>
                <Label htmlFor={keyId}>Key</Label>
                <Input
                  id={keyId}
                  data-plan-field="key"
                  value={draft.key}
                  maxLength={50}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={errors.key ? true : undefined}
                  onChange={(e) => {
                    onKeyTouched();
                    update("key", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
                  }}
                  placeholder="crm-starter"
                  className="font-mono"
                />
                {errors.key ? <FieldError message={errors.key} /> : <Hint>Lower-case letters, digits and dashes. It can&apos;t change once the plan exists.</Hint>}
              </>
            )}
          </div>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-[13px] font-medium text-muted">Kind</legend>
          {kindLocked ? (
            <p className="flex items-center gap-2 text-sm text-text">
              <Lock aria-hidden="true" className="h-3.5 w-3.5 text-subtle" />
              Internal — an internal plan stays internal.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {kinds.map((k) => {
                const chosen = draft.kind === k.value;
                return (
                  <label
                    key={k.value}
                    className={cn(
                      "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5",
                      chosen ? "border-brand bg-brand-subtle" : "border-line hover:bg-surface-sunken",
                    )}
                  >
                    <input
                      type="radio"
                      name="plan-kind"
                      value={k.value}
                      checked={chosen}
                      onChange={() => update("kind", k.value)}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand)]"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-text">{k.title}</span>
                      <span className="block text-xs text-muted">{k.body}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          {!kindLocked && draft.kind === "INTERNAL" && savedKind !== "INTERNAL" && (
            <p className="text-xs text-warning">Once saved as internal it stays internal: never sold, never the default.</p>
          )}
        </fieldset>

        <div className="space-y-1.5">
          <Label htmlFor={descriptionId}>Description</Label>
          <Textarea
            id={descriptionId}
            value={draft.description}
            maxLength={MAX_DESCRIPTION}
            rows={3}
            onChange={(e) => update("description", e.target.value)}
            placeholder="Who it is for, in a sentence."
          />
          <p className="text-xs text-subtle tabular-nums">
            {draft.description.length} / {MAX_DESCRIPTION}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={orderId}>Order</Label>
          <Input
            id={orderId}
            data-plan-field="order"
            type="number"
            step={1}
            value={draft.sortOrder}
            onChange={(e) => update("sortOrder", e.target.value)}
            aria-invalid={errors.order ? true : undefined}
            className="w-32 tabular-nums"
          />
          {errors.order ? <FieldError message={errors.order} /> : <Hint>Lower numbers are listed first.</Hint>}
        </div>
      </div>
    </Panel>
  );
}

/** "United Arab Emirates" for AE, when the browser knows it — only ever shown for what is being typed. */
function regionName(code: string): string | null {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(code);
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}

function AvailabilitySection({ draft, update, readOnly }: { draft: Draft; update: Update; readOnly: boolean }) {
  const countryId = "plan-field-countries";
  const countryHintId = "plan-field-countries-hint";
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const internal = draft.kind === "INTERNAL";

  if (readOnly) {
    return (
      <Panel id="plan-availability" title="Availability">
        <DefinitionList
          items={[
            { term: "Offered to new sales", value: draft.active ? "Yes" : "No — retired" },
            { term: "Default for new workspaces", value: !internal && draft.isDefault ? "Yes" : "No" },
            { term: "Sold in", value: draft.countries.length ? draft.countries.join(", ") : "Everywhere", wide: true },
          ]}
        />
      </Panel>
    );
  }

  function addCodes(raw: string) {
    const codes = raw.toUpperCase().split(/[\s,;]+/).filter(Boolean);
    const good = codes.filter((c) => COUNTRY_PATTERN.test(c));
    const bad = codes.filter((c) => !COUNTRY_PATTERN.test(c));
    if (good.length) update("countries", [...new Set([...draft.countries, ...good])]);
    setError(bad.length ? `${bad.join(", ")} ${bad.length === 1 ? "is not a two-letter country code" : "are not two-letter country codes"}, like IN or AE.` : null);
    setText(bad.join(" "));
  }

  const typed = text.trim().toUpperCase();
  const typedName = COUNTRY_PATTERN.test(typed) ? regionName(typed) : null;

  return (
    <Panel id="plan-availability" title="Availability" description="Whether it is sold, whether new workspaces start on it, and where.">
      <div className="space-y-5">
        <div className="divide-y divide-line rounded-lg border border-line">
          <label className="flex cursor-pointer items-start gap-3 px-4 py-3">
            <Checkbox
              checked={draft.active}
              onChange={(e) => {
                update("active", e.target.checked);
                // A retired plan cannot be the one new workspaces start on.
                if (!e.target.checked) update("isDefault", false);
              }}
              className="mt-0.5 shrink-0"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-text">Offered to new sales</span>
              <span className="block text-xs text-muted">
                Given to new workspaces and named in invitations. Untick to retire it — workspaces already on it keep it.
              </span>
            </span>
          </label>
          {internal ? (
            <p className="px-4 py-3 text-xs text-muted">An internal plan is never the default for new workspaces.</p>
          ) : (
            <label className={cn("flex items-start gap-3 px-4 py-3", draft.active ? "cursor-pointer" : "cursor-not-allowed")}>
              <Checkbox checked={draft.isDefault} disabled={!draft.active} onChange={(e) => update("isDefault", e.target.checked)} className="mt-0.5 shrink-0" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-text">Default for new workspaces</span>
                <span className="block text-xs text-muted">
                  {draft.active
                    ? "Signups without an invitation plan start on it. Only one plan is the default — saving this one takes it from any other."
                    : "A retired plan can't be the default."}
                </span>
              </span>
            </label>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={countryId}>Sold in</Label>
          <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-base border border-line-strong bg-surface px-2 py-1 shadow-sm focus-within:border-brand">
            {draft.countries.map((code) => (
              <span key={code} className="inline-flex h-6 items-center gap-0.5 rounded-full border border-line bg-surface-sunken pl-2 font-mono text-xs text-text">
                {code}
                <IconButton
                  icon={X}
                  label={`Remove ${code}`}
                  onClick={() => update("countries", draft.countries.filter((c) => c !== code))}
                  className="h-5 w-5 rounded-full [&_svg]:h-3 [&_svg]:w-3"
                />
              </span>
            ))}
            <input
              id={countryId}
              data-plan-field="countries"
              value={text}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={countryHintId}
              aria-invalid={error ? true : undefined}
              onChange={(e) => {
                setText(e.target.value.toUpperCase().replace(/[^A-Z,; ]/g, "").slice(0, 40));
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "," || e.key === " ") {
                  e.preventDefault();
                  if (text.trim()) addCodes(text);
                } else if (e.key === "Backspace" && text === "" && draft.countries.length > 0) {
                  update("countries", draft.countries.slice(0, -1));
                }
              }}
              onBlur={() => {
                if (text.trim()) addCodes(text);
              }}
              placeholder={draft.countries.length ? "Add another" : "Everywhere"}
              className="h-7 min-w-28 flex-1 bg-transparent px-1 font-mono text-sm text-text uppercase outline-none placeholder:font-sans placeholder:normal-case placeholder:text-subtle"
            />
          </div>
          {error ? (
            <p id={countryHintId} className="text-xs text-danger">
              {error}
            </p>
          ) : (
            <p id={countryHintId} className="text-xs text-muted">
              {typedName
                ? `Enter adds ${typed} — ${typedName}.`
                : "Two-letter country codes, each followed by Enter. Leave empty for everywhere."}
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
}

function LimitsSection({ draft, update, readOnly, errors }: { draft: Draft; update: Update; readOnly: boolean; errors: Partial<Record<Field, string>> }) {
  const seatsId = "plan-field-seats";
  const copilotId = "plan-field-copilot";
  const domainsId = "plan-field-domains";
  const seats = limitOf(draft.seats);
  const copilot = limitOf(draft.copilot);
  const domains = limitOf(draft.domains);

  if (readOnly) {
    return (
      <Panel id="plan-limits" title="Limits">
        <DefinitionList
          items={[
            { term: "Users per unit", value: <span className="tabular-nums">{limitText(seats)}</span> },
            { term: "Copilot tokens a month", value: <span className="tabular-nums">{copilot === 0 ? "None" : limitText(copilot)}</span> },
            { term: "Custom domains", value: <span className="tabular-nums">{domains === 0 ? "None" : limitText(domains)}</span> },
          ]}
        />
      </Panel>
    );
  }

  const valid = (n: number | null) => n !== null && Number.isInteger(n) && n >= 0;
  return (
    <Panel id="plan-limits" title="Limits" description="For each unit of quantity a workspace takes. Empty means no limit.">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={seatsId}>Users per unit</Label>
          <Input
            id={seatsId}
            data-plan-field="seats"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={draft.seats}
            placeholder="No limit"
            aria-invalid={errors.seats ? true : undefined}
            onChange={(e) => update("seats", e.target.value)}
            className="tabular-nums"
          />
          {errors.seats ? (
            <FieldError message={errors.seats} />
          ) : (
            <Hint>{seats === null ? "No limit on the people who may hold an account." : valid(seats) ? `${plural(seats, "person", "people")} for each unit.` : "A whole number."}</Hint>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={copilotId}>Copilot tokens a month</Label>
          <Input
            id={copilotId}
            data-plan-field="copilot"
            type="number"
            min={0}
            step={1000}
            inputMode="numeric"
            value={draft.copilot}
            placeholder="No limit"
            aria-invalid={errors.copilot ? true : undefined}
            onChange={(e) => update("copilot", e.target.value)}
            className="tabular-nums"
          />
          {errors.copilot ? (
            <FieldError message={errors.copilot} />
          ) : (
            <Hint>
              {copilot === null
                ? "No limit. 0 means no copilot at all."
                : copilot === 0
                  ? "No copilot on this plan."
                  : valid(copilot)
                    ? `${compactNumber(copilot)} tokens a month for each unit.`
                    : "A whole number."}
            </Hint>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={domainsId}>Custom domains</Label>
          <Input
            id={domainsId}
            data-plan-field="domains"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={draft.domains}
            placeholder="No limit"
            aria-invalid={errors.domains ? true : undefined}
            onChange={(e) => update("domains", e.target.value)}
            className="tabular-nums"
          />
          {errors.domains ? (
            <FieldError message={errors.domains} />
          ) : (
            <Hint>
              {domains === null
                ? draft.kind === "ADDON"
                  ? "Empty adds none — an add-on without a number gives nothing."
                  : "No limit. 0 means none."
                : domains === 0
                  ? "No custom domain on this plan."
                  : valid(domains)
                    ? `${plural(domains, "address", "addresses")} of a workspace's own for each unit.`
                    : "A whole number."}
            </Hint>
          )}
        </div>
      </div>
    </Panel>
  );
}

type ModuleGroup = { title: string; modules: CatalogueModuleView[] };

function groupModules(catalogue: CatalogueModuleView[]): ModuleGroup[] {
  const map = new Map<string, CatalogueModuleView[]>();
  for (const m of catalogue) {
    const title = m.inEveryPlan ? EVERY_PLAN : (getModuleDefinition(m.key)?.navGroup ?? "Other");
    map.set(title, [...(map.get(title) ?? []), m]);
  }
  const rank = (title: string) => (title === EVERY_PLAN ? Number.MAX_SAFE_INTEGER : navGroupRank(title));
  return [...map].sort(([a], [b]) => rank(a) - rank(b)).map(([title, modules]) => ({ title, modules }));
}

function ModulesSection({
  draft,
  update,
  readOnly,
  catalogue,
  errors,
}: {
  draft: Draft;
  update: Update;
  readOnly: boolean;
  catalogue: CatalogueModuleView[];
  errors: Partial<Record<Field, string>>;
}) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => groupModules(catalogue), [catalogue]);
  const internal = draft.kind === "INTERNAL";
  const every = internal && draft.allModules;
  const explicit = new Set(draft.modules);

  // What comes with each listed module: entitlements add what a module needs (src/lib/entitlements.ts).
  const comesWith = new Map<string, string[]>();
  for (const key of draft.modules) {
    for (const dep of withDependencies([key])) {
      if (dep === key || explicit.has(dep)) continue;
      comesWith.set(dep, [...(comesWith.get(dep) ?? []), labelOf(key)]);
    }
  }
  const chosen = catalogue.filter((m) => !m.inEveryPlan && (explicit.has(m.key) || comesWith.has(m.key))).length;
  const sellable = catalogue.filter((m) => !m.inEveryPlan).length;

  if (readOnly) {
    return (
      <Panel id="plan-modules" title="Modules" description={every ? undefined : `${chosen} of ${sellable}, plus the basics in every plan.`}>
        {every ? (
          <p className="text-sm text-text">Every module, including ones added later.</p>
        ) : chosen === 0 ? (
          <p className="text-sm text-muted">Only the basics every workspace has.</p>
        ) : (
          <div className="space-y-3">
            {groups
              .filter((g) => g.title !== EVERY_PLAN)
              .map((g) => {
                const inGroup = g.modules.filter((m) => explicit.has(m.key) || comesWith.has(m.key));
                if (inGroup.length === 0) return null;
                return (
                  <div key={g.title}>
                    <p className="text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase">{g.title}</p>
                    <ul className="mt-1.5 flex flex-wrap gap-1">
                      {inGroup.map((m) => (
                        <li key={m.key} className="rounded-md border border-line bg-surface-sunken px-1.5 py-0.5 text-xs text-text">
                          {m.label}
                          {!explicit.has(m.key) && <span className="text-subtle"> · with {comesWith.get(m.key)?.join(", ")}</span>}
                          {m.countries && <span className="text-warning"> · {m.countries.join(", ")} only</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
          </div>
        )}
      </Panel>
    );
  }

  const q = query.trim().toLowerCase();
  const matches = (m: CatalogueModuleView, group: string) => !q || m.label.toLowerCase().includes(q) || m.key.includes(q) || group.toLowerCase().includes(q);
  const shown = groups.map((g) => ({ ...g, modules: g.modules.filter((m) => matches(m, g.title)) })).filter((g) => g.modules.length > 0);

  function toggle(key: string) {
    update("modules", explicit.has(key) ? draft.modules.filter((k) => k !== key) : [...draft.modules, key]);
  }

  return (
    <Panel
      id="plan-modules"
      title="Modules"
      description="What a workspace on this plan may use. A module brings what it needs with it; the basics are in every plan."
    >
      <div className="space-y-4">
        {internal && (
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line px-4 py-3">
            <Checkbox checked={draft.allModules} onChange={(e) => update("allModules", e.target.checked)} className="mt-0.5 shrink-0" />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-text">All modules</span>
              <span className="block text-xs text-muted">Every module there is, including ones added later — for internal plans only.</span>
            </span>
          </label>
        )}

        {every ? (
          <InsetBlock className="text-sm text-text">Every module is included, including ones added later.</InsetBlock>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="relative w-full sm:w-64">
                <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-subtle" />
                <input
                  data-plan-field="modules"
                  type="search"
                  value={query}
                  aria-label="Find a module"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setQuery(e.target.value.slice(0, 60))}
                  placeholder="Find a module"
                  className="h-9 w-full rounded-base border border-line-strong bg-surface pr-3 pl-8 text-sm text-text placeholder:text-subtle"
                />
              </div>
              <p className="text-xs text-muted tabular-nums">
                {chosen} of {sellable} modules
              </p>
            </div>
            {errors.modules && (
              <p role="alert" className="rounded-lg border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
                {errors.modules}
              </p>
            )}
            {shown.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted">No module matches “{query.trim()}”.</p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                {shown.map((g) => {
                  const on = g.modules.filter((m) => m.inEveryPlan || explicit.has(m.key) || comesWith.has(m.key)).length;
                  return (
                    <fieldset key={g.title} className="min-w-0 rounded-lg border border-line">
                      <legend className="sr-only">{g.title}</legend>
                      <div aria-hidden="true" className="flex items-center justify-between gap-2 rounded-t-lg border-b border-line bg-surface-sunken px-3 py-1.5">
                        <span className="text-xs font-medium text-text">{g.title}</span>
                        <span className="text-[11px] text-subtle tabular-nums">
                          {on}/{g.modules.length}
                        </span>
                      </div>
                      <div className="space-y-0.5 p-1.5">
                        {g.modules.map((m) => (
                          <ModuleRow key={m.key} module={m} explicit={explicit.has(m.key)} comesWith={comesWith.get(m.key)} countries={draft.countries} onToggle={toggle} />
                        ))}
                      </div>
                    </fieldset>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

function ModuleRow({
  module: m,
  explicit,
  comesWith,
  countries,
  onToggle,
}: {
  module: CatalogueModuleView;
  explicit: boolean;
  comesWith: string[] | undefined;
  countries: string[];
  onToggle: (key: string) => void;
}) {
  const locked = m.inEveryPlan || (!explicit && !!comesWith);
  const checked = m.inEveryPlan || explicit || !!comesWith;
  const conflict = explicit && !!m.countries && (countries.length === 0 || countries.some((c) => !m.countries!.includes(c)));
  const hints: { text: string; tone?: Tone }[] = [];
  if (m.inEveryPlan) hints.push({ text: "In every plan" });
  else if (!explicit && comesWith) hints.push({ text: `Comes with ${comesWith.join(", ")}` });
  if (!m.inEveryPlan && m.requires.length > 0) hints.push({ text: `Needs ${m.requires.map(labelOf).join(", ")}` });
  if (m.countries) hints.push({ text: conflict ? `${m.countries.join(", ")} only — limit the plan to ${m.countries.join(", ")}` : `${m.countries.join(", ")} only`, tone: conflict ? "danger" : "warning" });

  return (
    <label className={cn("flex items-start gap-2.5 rounded-md px-2 py-1.5", locked ? "cursor-default" : "cursor-pointer hover:bg-surface-sunken")}>
      <Checkbox checked={checked} disabled={locked} onChange={() => onToggle(m.key)} className="mt-0.5 shrink-0" />
      <span className="min-w-0">
        <span className={cn("block text-sm", locked ? "text-muted" : "text-text")}>{m.label}</span>
        {hints.length > 0 && (
          <span className="block text-[11px] leading-4">
            {hints.map((h, i) => (
              <span key={h.text} className={h.tone === "danger" ? "text-danger" : h.tone === "warning" ? "text-warning" : "text-subtle"}>
                {i > 0 && " · "}
                {h.text}
              </span>
            ))}
          </span>
        )}
      </span>
    </label>
  );
}

function WorkspacesSection({ plan }: { plan: PlanDetail }) {
  const all = `/workspaces?plan=${encodeURIComponent(plan.key)}`;
  return (
    <Panel
      id="plan-workspaces"
      title="Workspaces on it"
      description={plan.workspaces > 0 ? `${plural(plan.workspaces, "workspace")} through a live subscription — every save works their entitlements out again.` : undefined}
      actions={
        plan.workspaces > 0 ? (
          <Link href={all} className="inline-flex items-center gap-1 rounded-base text-xs font-medium text-brand hover:underline">
            See all {compactNumber(plan.workspaces)}
            <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
          </Link>
        ) : undefined
      }
    >
      {plan.sample.length === 0 ? (
        <p className="text-sm text-muted">No workspace is on this plan yet.</p>
      ) : (
        <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
          {plan.sample.map((w) => (
            <li key={w.slug} className="min-w-0">
              <Link href={`/workspaces/${encodeURIComponent(w.slug)}`} className="group flex min-w-0 items-baseline gap-2 rounded-base py-1 hover:text-brand">
                <span className="truncate text-sm font-medium text-text group-hover:text-brand">{w.name}</span>
                <span className="shrink-0 font-mono text-xs text-muted">{w.slug}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ─── The save's impact ───────────────────────────────────────────────────────────────────────────

function SaveImpact({ mode, preview, sent, before }: { mode: Mode; preview: PlanSavePreview; sent: PlanInput; before: PlanInput }) {
  const added = preview.modulesAdded.map(labelOf);
  const removed = preview.modulesRemoved.map(labelOf);
  const change = (a: string, b: string) => (a === b ? null : `${a} → ${b}`);
  const yesNo = (v: boolean | undefined) => (v ? "Yes" : "No");
  const items: { label: string; value: string; tone?: Tone }[] = [];

  if (mode === "edit") {
    const seats = change(limitText(preview.seats[0]), limitText(preview.seats[1]));
    const copilot = change(limitText(preview.copilotTokens[0]), limitText(preview.copilotTokens[1]));
    const domainText = (n: number | null) => (n === 0 ? "None" : limitText(n));
    const domains = change(domainText(preview.customDomains[0]), domainText(preview.customDomains[1]));
    const offered = change(yesNo(before.active !== false), yesNo(sent.active !== false));
    const byDefault = change(yesNo(before.isDefault), yesNo(sent.isDefault));
    const soldIn = change(before.countries.join(", ") || "Everywhere", sent.countries.join(", ") || "Everywhere");
    if (seats) items.push({ label: "Users per unit", value: seats });
    if (copilot) items.push({ label: "Copilot tokens a month", value: copilot });
    if (domains) items.push({ label: "Custom domains", value: domains });
    if (soldIn) items.push({ label: "Sold in", value: soldIn });
    if (offered) items.push({ label: "Offered to new sales", value: offered, tone: sent.active === false ? "warning" : "success" });
    if (byDefault) items.push({ label: "Default for new workspaces", value: byDefault, tone: sent.isDefault ? "brand" : "warning" });
  } else {
    items.push({ label: "Kind", value: planKindLabel(sent.kind) });
    items.push({ label: "Users per unit", value: limitText(sent.seats) });
    items.push({ label: "Copilot tokens a month", value: sent.copilotTokens === 0 ? "None" : limitText(sent.copilotTokens) });
    items.push({ label: "Custom domains", value: preview.customDomains[1] === 0 ? "None" : limitText(preview.customDomains[1]) });
    items.push({ label: "Sold in", value: sent.countries.join(", ") || "Everywhere" });
    items.push({ label: "Offered to new sales", value: yesNo(sent.active !== false) });
    if (sent.isDefault) items.push({ label: "Default for new workspaces", value: "Yes — in place of any other", tone: "brand" });
  }

  return (
    <>
      {mode === "edit" ? (
        <p>
          {preview.workspaces > 0 ? `Updates entitlements for ${plural(preview.workspaces, "workspace")} now.` : "No workspace is on this plan, so no workspace changes."} Modules
          added: {added.length ? added.join(", ") : "—"} · removed: {removed.length ? removed.join(", ") : "—"}.
        </p>
      ) : (
        <p>
          Creates <span className="font-medium">{sent.name}</span> (<span className="font-mono text-xs">{sent.key}</span>). No workspace is on it yet.
        </p>
      )}
      {(added.length > 0 || removed.length > 0) && (
        <DiffChips added={added} removed={removed} addedLabel={mode === "edit" ? "Modules added" : "Modules"} removedLabel="Modules removed" />
      )}
      {sent.allModules && <p className="text-muted">Every module, including ones added later.</p>}
      <ImpactList items={items} />
      <LosingModules preview={preview} />
      {mode === "edit" && preview.workspaces > 0 && preview.losingModules.length === 0 && preview.sample.length > 0 && (
        <p className="text-xs text-muted">
          Including {preview.sample.slice(0, 5).join(", ")}
          {preview.workspaces > 5 ? ` and ${plural(preview.workspaces - 5, "more", "more")}` : ""}.
        </p>
      )}
      {sent.isDefault && !before.isDefault && mode === "edit" && (
        <p className="text-xs text-muted">Signups without an invitation plan start on it from now on, in place of any other default.</p>
      )}
    </>
  );
}

function LosingModules({ preview }: { preview: PlanSavePreview }) {
  if (preview.losingModules.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="font-medium text-danger">
        {plural(preview.losingModules.length, "workspace")} {preview.losingModules.length === 1 ? "loses" : "lose"} modules {preview.losingModules.length === 1 ? "it has" : "they have"} now
        {preview.workspaces > 200 ? " (of the first 200 checked)" : ""}.
      </p>
      <AffectedList
        rows={preview.losingModules.map((row) => ({ key: row.slug, label: row.slug, note: row.modules.map(labelOf).join(", "), tone: "danger" as const }))}
      />
      <p className="text-xs text-muted">Their people lose those modules as soon as this is saved.</p>
    </div>
  );
}

