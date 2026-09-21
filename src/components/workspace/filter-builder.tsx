"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { X } from "lucide-react";
import { countWorkbook, type workbookFilterOptions } from "@/actions/workspace";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { countActiveFilters, type WorkbookFilters } from "@/lib/workspace/filters";

type Options = Awaited<ReturnType<typeof workbookFilterOptions>>;

const RELATIONSHIPS = ["CLIENT", "VENDOR", "OEM", "DISTRIBUTOR", "PARTNER", "RESELLER", "COMMISSION_PARTY"];
const STAGES = ["PROSPECT", "LEAD", "CUSTOMER", "DISQUALIFIED"];
const SOURCES = ["LINKEDIN", "REFERRAL", "INBOUND", "OTHER"];
const ORDER_TYPES = ["NEW", "RENEWAL", "NEW_TO_US_RENEWAL"];
const ORDER_STATUSES = ["PENDING_APPROVAL", "APPROVED", "PROCESSING", "FULFILLED", "REJECTED", "CANCELLED"];
const ITEM_TYPES = ["GOOD", "SERVICE", "SUBSCRIPTION", "PERPETUAL"];
const LEAD_STATUSES = ["NEW", "CONTACTED", "QUALIFYING", "QUALIFIED", "PROPOSAL_SENT", "NEGOTIATION", "WON", "LOST", "DISQUALIFIED"];

/**
 * The list builder.
 *
 * Grouped the way someone thinks about a list — who they are, who owns them, what they've bought,
 * what's expiring, where the pipeline stands — rather than by which table the column lives in. The
 * running match count is the whole point of the screen: it's what tells you a filter is too narrow
 * before you save it and hand it to someone.
 */
export function FilterBuilder({
  filters,
  onChange,
  options,
}: {
  filters: WorkbookFilters;
  onChange: (update: (previous: WorkbookFilters) => WorkbookFilters) => void;
  options: Options;
}) {
  const [matches, setMatches] = useState<number | null>(null);
  const [countFailed, setCountFailed] = useState(false);
  const [counting, startCounting] = useTransition();

  // Debounced: every toggle would otherwise fire a count query while someone is still choosing.
  useEffect(() => {
    const timer = setTimeout(() => {
      startCounting(async () => {
        // An action that rejects inside a transition is an unhandled rejection, which here means the
        // error boundary replaces a panel somebody is halfway through filling in. The count is a
        // convenience — a session that lapsed, or a query that timed out, should cost the count and
        // not the filters. Caught rather than thrown, and said rather than silently zeroed.
        try {
          setMatches(await countWorkbook(filters));
          setCountFailed(false);
        } catch {
          setCountFailed(true);
        }
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [filters]);

  function set<K extends keyof WorkbookFilters>(key: K, value: WorkbookFilters[K]) {
    onChange((previous) => {
      const next = { ...previous };
      const empty =
        value === undefined || value === "" || value === false || (Array.isArray(value) && value.length === 0);
      if (empty) delete next[key];
      else next[key] = value;
      return next;
    });
  }

  const active = countActiveFilters(filters);

  return (
    <div className="space-y-4">
      <Card className="sticky top-14 z-10">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div>
            {/* "…" for every not-yet-counted state, not only while a count is in flight. The first
                350ms are the debounce, when `counting` is still false — so the panel opened saying
                "0 companies match", which is a specific and confident answer to a question it had
                not asked yet, on the one number the screen exists to show. */}
            <span className="text-lg font-semibold text-text">
              {countFailed ? "—" : matches === null ? "…" : matches.toLocaleString("en-IN")}
            </span>
            <span className="ml-2 text-sm text-muted">
              {countFailed
                ? "could not count just now — the filters are still set"
                : `compan${matches === 1 ? "y" : "ies"} match${counting ? " (updating…)" : ""}`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-subtle">
              {active} filter{active === 1 ? "" : "s"}
            </span>
            {active > 0 && (
              <Button size="sm" variant="ghost" onClick={() => onChange(() => ({}))}>
                <X className="mr-1 h-3.5 w-3.5" />
                Clear all
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Group title="Who they are">
        <Chips label="Relationship" values={RELATIONSHIPS} selected={filters.relationshipType} onChange={(v) => set("relationshipType", v)} />
        <Chips label="Stage" values={STAGES} selected={filters.stage} onChange={(v) => set("stage", v)} />
        <Chips label="Source" values={SOURCES} selected={filters.source} onChange={(v) => set("source", v)} />
        <MultiSelect
          label="Industry"
          options={options.industries.map((i) => ({ value: i.id, label: i.name }))}
          selected={filters.industryId}
          onChange={(v) => set("industryId", v)}
        />
        <MultiSelect
          label="State"
          options={options.states.map((s) => ({ value: s, label: s }))}
          selected={filters.state}
          onChange={(v) => set("state", v)}
        />
        <MultiSelect
          label="City"
          options={options.cities.map((c) => ({ value: c, label: c }))}
          selected={filters.city}
          onChange={(v) => set("city", v)}
        />
        <MultiSelect
          label="Category"
          options={options.categories.map((c) => ({ value: c, label: c }))}
          selected={filters.category}
          onChange={(v) => set("category", v)}
        />
        {options.tags.length > 0 && (
          <MultiSelect
            label="Tags"
            options={options.tags.map((t) => ({ value: t, label: t }))}
            selected={filters.tags}
            onChange={(v) => set("tags", v)}
          />
        )}
        <Range
          label="Employees"
          min={filters.employeeMin}
          max={filters.employeeMax}
          onMin={(v) => set("employeeMin", v)}
          onMax={(v) => set("employeeMax", v)}
        />
        <Tri label="Website on file" value={filters.hasWebsite} onChange={(v) => set("hasWebsite", v)} />
      </Group>

      <Group title="Who owns them">
        <MultiSelect
          label="Account manager"
          options={options.users.map((u) => ({ value: u.id, label: u.name }))}
          selected={filters.ownerUserId}
          onChange={(v) => set("ownerUserId", v)}
        />
        <MultiSelect
          label="Caller"
          options={options.users.map((u) => ({ value: u.id, label: u.name }))}
          selected={filters.assignedToUserId}
          onChange={(v) => set("assignedToUserId", v)}
        />
        <Toggle label="Nobody assigned" checked={!!filters.unowned} onChange={(v) => set("unowned", v)} />
      </Group>

      <Group title="What they've bought">
        <Tri label="Has orders" value={filters.hasOrders} onChange={(v) => set("hasOrders", v)} />
        <Chips label="Order type" values={ORDER_TYPES} selected={filters.orderBusinessType} onChange={(v) => set("orderBusinessType", v)} />
        <Chips label="Order status" values={ORDER_STATUSES} selected={filters.orderStatus} onChange={(v) => set("orderStatus", v)} />
        <Toggle label="Has an unpaid invoice" checked={!!filters.hasOutstanding} onChange={(v) => set("hasOutstanding", v)} />
      </Group>

      <Group title="Products & brands">
        <MultiSelect
          label="Brand"
          options={options.brands.map((b) => ({ value: b.id, label: b.name }))}
          selected={filters.brandId}
          onChange={(v) => set("brandId", v)}
        />
        <MultiSelect
          label="Product family"
          options={options.families.map((f) => ({ value: f.id, label: f.name }))}
          selected={filters.productFamilyId}
          onChange={(v) => set("productFamilyId", v)}
        />
        <MultiSelect
          label="Product"
          options={options.items.map((i) => ({ value: i.id, label: `${i.name} (${i.sku})` }))}
          selected={filters.itemId}
          onChange={(v) => set("itemId", v)}
        />
        <Chips label="Product type" values={ITEM_TYPES} selected={filters.itemType} onChange={(v) => set("itemType", v)} />
        <div className="@xl:col-span-2">
          <Toggle
            label="Flip this: companies who have NEVER bought the above"
            hint="Turns a 'who has' list into a cross-sell list"
            checked={!!filters.productExcludes}
            onChange={(v) => set("productExcludes", v)}
          />
        </div>
      </Group>

      <Group title="Renewals">
        <div className="space-y-1.5">
          <Label htmlFor="renewalWithin">Subscription expiring within</Label>
          <Select
            id="renewalWithin"
            value={filters.renewalWithinDays ? String(filters.renewalWithinDays) : ""}
            onChange={(e) => set("renewalWithinDays", e.target.value ? Number(e.target.value) : undefined)}
          >
            <option value="">Any time</option>
            <option value="30">30 days</option>
            <option value="60">60 days</option>
            <option value="90">90 days</option>
            <option value="180">6 months</option>
          </Select>
        </div>
        <Toggle label="Has an expired subscription" checked={!!filters.renewalExpired} onChange={(v) => set("renewalExpired", v)} />
      </Group>

      <Group title="Pipeline">
        <Chips label="Lead status" values={LEAD_STATUSES} selected={filters.leadStatus} onChange={(v) => set("leadStatus", v)} />
        <Toggle label="Has an open lead" checked={!!filters.hasOpenLead} onChange={(v) => set("hasOpenLead", v)} />
        <Toggle
          label="Every lead was lost"
          hint="Dead accounts worth a second run at"
          checked={!!filters.allLeadsLost}
          onChange={(v) => set("allLeadsLost", v)}
        />
        <Toggle label="Never had a lead" checked={!!filters.neverHadLead} onChange={(v) => set("neverHadLead", v)} />
      </Group>

      <Group title="Engagement">
        <div className="space-y-1.5">
          <Label htmlFor="noCall">Not called in</Label>
          <Select
            id="noCall"
            value={filters.noCallInDays ? String(filters.noCallInDays) : ""}
            onChange={(e) => set("noCallInDays", e.target.value ? Number(e.target.value) : undefined)}
          >
            <option value="">Any</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="60">60 days</option>
            <option value="90">90 days</option>
            <option value="180">6 months</option>
          </Select>
          <p className="text-xs text-subtle">Includes companies never called.</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="createdFrom">Added from</Label>
            <Input id="createdFrom" type="date" value={filters.createdFrom ?? ""} onChange={(e) => set("createdFrom", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="createdTo">Added up to</Label>
            <Input id="createdTo" type="date" value={filters.createdTo ?? ""} onChange={(e) => set("createdTo", e.target.value)} />
          </div>
        </div>
      </Group>

      <Group title="What their domain says">
        <MultiSelect
          label="Email provider"
          options={options.emailProviders.map((p) => ({ value: p, label: p }))}
          selected={filters.emailProvider}
          onChange={(v) => set("emailProvider", v)}
        />
        <MultiSelect
          label="Website platform"
          options={options.platforms.map((p) => ({ value: p, label: p }))}
          selected={filters.webPlatform}
          onChange={(v) => set("webPlatform", v)}
        />
        <Toggle
          label="Domain can be spoofed"
          hint="No DMARC, or DMARC set to monitor-only"
          checked={!!filters.spoofable}
          onChange={(v) => set("spoofable", v)}
        />
        <Toggle
          label="Domain not looked up yet"
          checked={!!filters.notScanned}
          onChange={(v) => set("notScanned", v)}
        />
      </Group>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">{title}</CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 @xl:grid-cols-2">{children}</CardContent>
    </Card>
  );
}

/** A short, known set of values — shown as chips because they're faster to scan than a dropdown. */
function Chips({
  label,
  values,
  selected,
  onChange,
}: {
  label: string;
  values: string[];
  selected?: string[];
  onChange: (next: string[]) => void;
}) {
  const chosen = selected ?? [];
  return (
    <div className="space-y-1.5 @xl:col-span-2">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => {
          const on = chosen.includes(value);
          return (
            <button
              key={value}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? chosen.filter((v) => v !== value) : [...chosen, value])}
              className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                on ? "bg-brand text-brand-contrast" : "border border-line-strong bg-surface text-muted hover:text-text"
              }`}
            >
              {value.replaceAll("_", " ").toLowerCase()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A long list — a native multi-select with the chosen values shown as removable badges. */
function MultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected?: string[];
  onChange: (next: string[]) => void;
}) {
  // Before the early return: a hook cannot be conditional. Unique per mount, because this filter
  // builder is rendered once per saved workbook on the same page.
  const selectId = useId();
  const chosen = selected ?? [];
  if (options.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {/* The caption above was a `<Label>` with no `htmlFor`, so it named nothing. Paired rather
          than given an aria-label, because the wording is already on screen and pairing also makes
          it clickable. */}
      <Label htmlFor={selectId}>{label}</Label>
      <Select
        id={selectId}
        value=""
        onChange={(e) => {
          if (e.target.value && !chosen.includes(e.target.value)) onChange([...chosen, e.target.value]);
        }}
      >
        <option value="">{chosen.length > 0 ? "Add another…" : `Any ${label.toLowerCase()}`}</option>
        {options
          .filter((o) => !chosen.includes(o.value))
          .map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
      </Select>
      {chosen.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chosen.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onChange(chosen.filter((v) => v !== value))}
              className="inline-flex items-center gap-1 rounded-full bg-brand-subtle px-2 py-0.5 text-xs text-brand hover:brightness-95"
            >
              {options.find((o) => o.value === value)?.label ?? value}
              <X className="h-3 w-3" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Range({
  label,
  min,
  max,
  onMin,
  onMax,
}: {
  label: string;
  min?: number;
  max?: number;
  onMin: (v: number | undefined) => void;
  onMax: (v: number | undefined) => void;
}) {
  return (
    <div className="space-y-1.5">
      {/* Two boxes under one caption, so each carries the caption *and* which end it is — "Order
          value" alone would name them identically. */}
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          aria-label={`${label}, from`}
          type="number"
          min="0"
          placeholder="From"
          value={min ?? ""}
          onChange={(e) => onMin(e.target.value ? Number(e.target.value) : undefined)}
        />
        <span className="text-subtle">–</span>
        <Input
          aria-label={`${label}, to`}
          type="number"
          min="0"
          placeholder="To"
          value={max ?? ""}
          onChange={(e) => onMax(e.target.value ? Number(e.target.value) : undefined)}
        />
      </div>
    </div>
  );
}

/** Yes / no / don't care — three states, because "no website" is as useful a filter as "has one". */
function Tri({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: "yes" | "no";
  onChange: (v: "yes" | "no" | undefined) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex gap-1.5">
        {(["yes", "no"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={value === option}
            onClick={() => onChange(value === option ? undefined : option)}
            className={`rounded-full px-3 py-1 text-xs capitalize transition-colors ${
              value === option
                ? "bg-brand text-brand-contrast"
                : "border border-line-strong bg-surface text-muted hover:text-text"
            }`}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm text-text">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-1" />
      <span>
        {label}
        {hint && <span className="block text-xs text-subtle">{hint}</span>}
      </span>
    </label>
  );
}

