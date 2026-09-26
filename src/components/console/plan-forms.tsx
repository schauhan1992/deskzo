"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PlanKind } from "@wroffy/control-client";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { consoleSavePlan, consoleSetLimitOverrides, consoleSetModuleOverride, consoleSetWorkspacePlans } from "@/actions/platform/console";

/** The console's plan forms: a plan itself, which plans a workspace is on, and staff overrides. */

export type CatalogueModule = { key: string; label: string; countries: readonly string[] | null; inEveryPlan: boolean; requires: readonly string[] };
export type PlanShape = {
  key: string;
  name: string;
  kind: PlanKind;
  description: string | null;
  allModules: boolean;
  modules: string[];
  countries: string[];
  seats: number | null;
  copilotTokens: number | null;
  isDefault: boolean;
  active: boolean;
  sortOrder: number;
};

const KINDS: { value: PlanKind; label: string }[] = [
  { value: "EDITION", label: "Edition — a workspace's base" },
  { value: "BUNDLE", label: "Bundle — modules sold together" },
  { value: "ADDON", label: "Add-on — one more thing" },
  { value: "INTERNAL", label: "Internal — never sold" },
];

function useSubmit() {
  const router = useRouter();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (work: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, done: string | ((data: unknown) => string)) => {
    setMessage(null);
    startTransition(async () => {
      const r = await work();
      if (!r.ok) return setMessage({ ok: false, text: r.error });
      setMessage({ ok: true, text: typeof done === "string" ? done : done(r.data) });
      router.refresh();
    });
  };
  const note = message && <p className={message.ok ? "text-xs text-success" : "text-xs text-danger"}>{message.text}</p>;
  return { run, pending, note };
}

const blank = (value: number | null) => (value === null ? "" : String(value));

export function PlanForm({ plan, catalogue, owner }: { plan?: PlanShape; catalogue: CatalogueModule[]; owner: boolean }) {
  const [key, setKey] = useState(plan?.key ?? "");
  const [name, setName] = useState(plan?.name ?? "");
  const [kind, setKind] = useState<PlanKind>(plan?.kind ?? "EDITION");
  const [description, setDescription] = useState(plan?.description ?? "");
  const [allModules, setAllModules] = useState(plan?.allModules ?? false);
  const [modules, setModules] = useState<string[]>(plan?.modules ?? []);
  const [countries, setCountries] = useState((plan?.countries ?? []).join(", "));
  const [seats, setSeats] = useState(blank(plan?.seats ?? null));
  const [copilot, setCopilot] = useState(blank(plan?.copilotTokens ?? null));
  const [isDefault, setIsDefault] = useState(plan?.isDefault ?? false);
  const [active, setActive] = useState(plan?.active ?? true);
  const [sortOrder, setSortOrder] = useState(String(plan?.sortOrder ?? 0));
  const { run, pending, note } = useSubmit();
  const toggle = (k: string) => setModules((m) => (m.includes(k) ? m.filter((x) => x !== k) : [...m, k]));
  const internal = kind === "INTERNAL";
  const locked = !!plan && plan.kind === "INTERNAL" && !owner;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          () =>
            consoleSavePlan({
              key,
              name,
              kind,
              description,
              allModules: internal && allModules,
              modules,
              countries: countries.split(/[,\s]+/).filter(Boolean),
              seats: seats.trim() === "" ? null : Number(seats),
              copilotTokens: copilot.trim() === "" ? null : Number(copilot),
              isDefault,
              active,
              sortOrder: Number(sortOrder) || 0,
            }),
          (data) => `Saved.${(data as { workspaces: number }).workspaces ? ` ${(data as { workspaces: number }).workspaces} workspace(s) updated.` : ""}`,
        );
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <Label htmlFor={`plan-key-${plan?.key ?? "new"}`}>Key</Label>
          <Input id={`plan-key-${plan?.key ?? "new"}`} value={key} onChange={(e) => setKey(e.target.value)} disabled={!!plan} placeholder="crm-starter" required />
        </div>
        <div>
          <Label htmlFor={`plan-name-${plan?.key ?? "new"}`}>Name</Label>
          <Input id={`plan-name-${plan?.key ?? "new"}`} value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor={`plan-kind-${plan?.key ?? "new"}`}>Kind</Label>
          <Select id={`plan-kind-${plan?.key ?? "new"}`} value={kind} onChange={(e) => setKind(e.target.value as PlanKind)} disabled={!!plan && plan.kind === "INTERNAL"}>
            {KINDS.filter((k) => owner || k.value !== "INTERNAL" || plan?.kind === "INTERNAL").map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div>
        <Label htmlFor={`plan-desc-${plan?.key ?? "new"}`}>Description</Label>
        <Textarea id={`plan-desc-${plan?.key ?? "new"}`} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <div>
          <Label htmlFor={`plan-countries-${plan?.key ?? "new"}`}>Sold in (empty: everywhere)</Label>
          <Input id={`plan-countries-${plan?.key ?? "new"}`} value={countries} onChange={(e) => setCountries(e.target.value.toUpperCase())} placeholder="IN" />
        </div>
        <div>
          <Label htmlFor={`plan-seats-${plan?.key ?? "new"}`}>Users (empty: no limit)</Label>
          <Input id={`plan-seats-${plan?.key ?? "new"}`} type="number" min={0} value={seats} onChange={(e) => setSeats(e.target.value)} />
        </div>
        <div>
          <Label htmlFor={`plan-copilot-${plan?.key ?? "new"}`}>Copilot tokens a month</Label>
          <Input id={`plan-copilot-${plan?.key ?? "new"}`} type="number" min={0} value={copilot} onChange={(e) => setCopilot(e.target.value)} placeholder="no limit" />
        </div>
        <div>
          <Label htmlFor={`plan-order-${plan?.key ?? "new"}`}>Order</Label>
          <Input id={`plan-order-${plan?.key ?? "new"}`} type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
        </div>
      </div>
      <div className="flex flex-wrap gap-4 text-sm text-text">
        {internal && (
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={allModules} onChange={(e) => setAllModules(e.target.checked)} /> Every module, including future ones
          </label>
        )}
        {!internal && (
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /> New workspaces start on it
          </label>
        )}
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Offered
        </label>
      </div>
      {!(internal && allModules) && (
        <fieldset>
          <legend className="mb-2 text-xs text-muted">Modules — what each needs comes with it; the basics are in every plan.</legend>
          <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
            {catalogue.map((m) => (
              <label key={m.key} className="inline-flex items-center gap-2 text-sm text-text">
                <input type="checkbox" checked={m.inEveryPlan || modules.includes(m.key)} disabled={m.inEveryPlan} onChange={() => toggle(m.key)} />
                <span>
                  {m.label}
                  {m.countries && <span className="ml-1 text-xs text-warning">{m.countries.join(", ")} only</span>}
                  {m.requires.length > 0 && <span className="ml-1 text-xs text-muted">needs {m.requires.join(", ")}</span>}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending || locked}>
          {pending ? "Saving…" : plan ? "Save plan" : "Create plan"}
        </Button>
        {note}
      </div>
    </form>
  );
}

type PlanChoice = { key: string; name: string; kind: PlanKind; active: boolean; countries: string[] };

export function WorkspacePlansForm({ tenantId, current, plans, country, owner }: { tenantId: string; current: { planKey: string; quantity: number }[]; plans: PlanChoice[]; country: string; owner: boolean }) {
  const [quantities, setQuantities] = useState<Record<string, string>>(Object.fromEntries(current.map((c) => [c.planKey, String(c.quantity)])));
  const { run, pending, note } = useSubmit();
  const offered = plans.filter(
    (p) => p.key in quantities || (p.active && (p.countries.length === 0 || p.countries.includes(country)) && (owner || p.kind !== "INTERNAL")),
  );
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const items = Object.entries(quantities)
          .filter(([, q]) => q.trim() !== "" && Number(q) > 0)
          .map(([planKey, q]) => ({ planKey, quantity: Number(q) }));
        run(() => consoleSetWorkspacePlans(tenantId, items), "Its plans are changed, and what it may use worked out again.");
      }}
    >
      <p className="text-xs text-muted">Tick the plans it is on; a quantity multiplies what a plan includes. Only plans offered in {country} are listed.</p>
      <div className="space-y-1">
        {offered.map((p) => {
          const on = p.key in quantities;
          return (
            <div key={p.key} className="flex flex-wrap items-center gap-3 text-sm">
              <label className="inline-flex min-w-[240px] items-center gap-2 text-text">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    setQuantities((q) => {
                      const next = { ...q };
                      if (on) delete next[p.key];
                      else next[p.key] = "1";
                      return next;
                    })
                  }
                />
                {p.name} <span className="text-xs text-muted">{p.kind.toLowerCase()}{p.active ? "" : ", retired"}</span>
              </label>
              {on && (
                <Input
                  className="h-8 w-20"
                  type="number"
                  min={1}
                  aria-label={`Quantity of ${p.name}`}
                  value={quantities[p.key]}
                  onChange={(e) => setQuantities((q) => ({ ...q, [p.key]: e.target.value }))}
                />
              )}
            </div>
          );
        })}
        {offered.length === 0 && <p className="text-sm text-muted">No plan is offered here yet — make one under Plans.</p>}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save plans"}
        </Button>
        {note}
      </div>
    </form>
  );
}

export function ModuleOverrideForm({ tenantId, catalogue }: { tenantId: string; catalogue: CatalogueModule[] }) {
  const [moduleKey, setModuleKey] = useState(catalogue[0]?.key ?? "");
  const [granted, setGranted] = useState("true");
  const [reason, setReason] = useState("");
  const { run, pending, note } = useSubmit();
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => consoleSetModuleOverride(tenantId, moduleKey, granted === "true", reason), "Done — what it may use is worked out again.");
        setReason("");
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <Select className="h-8 w-56" aria-label="Module" value={moduleKey} onChange={(e) => setModuleKey(e.target.value)}>
          {catalogue.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </Select>
        <Select className="h-8 w-40" aria-label="Add or take away" value={granted} onChange={(e) => setGranted(e.target.value)}>
          <option value="true">Add it</option>
          <option value="false">Take it away</option>
        </Select>
        <Input className="h-8 w-64" aria-label="Why" placeholder="Why (kept with the change)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <Button type="submit" size="sm" variant="secondary" disabled={pending || reason.trim().length < 5}>
          {pending ? "Saving…" : "Override"}
        </Button>
      </div>
      {note}
    </form>
  );
}

export function RemoveOverride({ tenantId, moduleKey }: { tenantId: string; moduleKey: string }) {
  const { run, pending, note } = useSubmit();
  return (
    <span className="inline-flex items-center gap-2">
      <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => run(() => consoleSetModuleOverride(tenantId, moduleKey, null, ""), "Back to what its plans say.")}>
        Remove
      </Button>
      {note}
    </span>
  );
}

export function LimitOverridesForm({ tenantId, seats, copilotTokens }: { tenantId: string; seats: number | null; copilotTokens: number | null }) {
  const [seatValue, setSeatValue] = useState(blank(seats));
  const [copilotValue, setCopilotValue] = useState(blank(copilotTokens));
  const { run, pending, note } = useSubmit();
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => consoleSetLimitOverrides(tenantId, { seats: seatValue.trim() || null, copilotTokens: copilotValue.trim() || null }), "Limits saved.");
      }}
    >
      <p className="text-xs text-muted">In place of what its plans add up to. Empty: the plans decide.</p>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor={`seat-override-${tenantId}`}>Users</Label>
          <Input id={`seat-override-${tenantId}`} className="h-8 w-28" type="number" min={0} value={seatValue} onChange={(e) => setSeatValue(e.target.value)} />
        </div>
        <div>
          <Label htmlFor={`copilot-override-${tenantId}`}>Copilot tokens a month</Label>
          <Input id={`copilot-override-${tenantId}`} className="h-8 w-40" type="number" min={0} value={copilotValue} onChange={(e) => setCopilotValue(e.target.value)} />
        </div>
        <Button type="submit" size="sm" variant="secondary" disabled={pending}>
          {pending ? "Saving…" : "Save limits"}
        </Button>
      </div>
      {note}
    </form>
  );
}
