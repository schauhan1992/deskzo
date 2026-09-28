import type { Metadata } from "next";
import Link from "next/link";
import { Layers, Plus } from "lucide-react";
import { ChartFrame, ChartTable } from "@/components/console/charts/chart-frame";
import { HBarChart } from "@/components/console/charts/hbar-chart";
import { Banner } from "@/components/console/kit/banner";
import { EmptyState } from "@/components/console/kit/empty-state";
import { SelectFilter, ToggleFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips, ViewTabs } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { CompareMatrix } from "@/components/console/plans/compare-matrix";
import { KIND_ORDER, PlanCards } from "@/components/console/plans/plan-cards";
import { plural } from "@/lib/console-shared/format";
import { planKindLabel } from "@/lib/console-shared/labels";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { parsePlanCatalogueFilters, withParams } from "@/lib/console-shared/params";
import { capsFor } from "@/lib/console-shared/roles";
import { plansList } from "@/lib/platform/console-data";
import { consoleStaff } from "@/lib/platform/console-page";
import { moduleCatalogue } from "@/lib/platform/plans";

export const metadata: Metadata = { title: "Plans" };

const PRIMARY_LINK =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-base bg-brand px-3 text-[13px] font-medium whitespace-nowrap text-brand-contrast shadow-sm hover:brightness-110";

/**
 * What a workspace can be on (spec §3.10): the catalogue as cards grouped by kind, or every plan side
 * by side. A change to a plan reaches every workspace on it as it is saved — entitlements are worked
 * out again (src/lib/platform/plans.ts) — so the editor is its own page, and this one is for reading
 * and finding. Sellers get New plan, Edit, Duplicate and Retire; an internal plan only the owner.
 */
export default async function ConsolePlansPage({ searchParams }: PageProps<"/platform-console/plans">) {
  const staff = await consoleStaff(PAGE_ROLES.plans);
  const caps = capsFor(staff.role);
  const sp = await searchParams;
  const f = parsePlanCatalogueFilters(sp);
  const plans = await plansList();
  const catalogue = moduleCatalogue();

  const onSale = plans.filter((p) => p.active).length;
  const retired = plans.length - onSale;
  const hasDefault = plans.some((p) => p.isDefault && p.active);
  const countries = [...new Set(plans.flatMap((p) => p.countries))].sort();
  // Sold in a country: limited to it, or sold everywhere.
  const visible = plans.filter(
    (p) => (f.retired || p.active) && (!f.kind || p.kind === f.kind) && (!f.country || p.countries.length === 0 || p.countries.includes(f.country)),
  );

  const view = f.view === "compare" ? "compare" : null;
  const chips = [
    ...(f.kind ? [{ key: "kind", label: `Kind: ${planKindLabel(f.kind)}`, removeHref: withParams("/plans", sp, { kind: null }) }] : []),
    ...(f.country ? [{ key: "country", label: `Sold in ${f.country}`, removeHref: withParams("/plans", sp, { country: null }) }] : []),
    ...(f.retired ? [{ key: "retired", label: "Retired shown", removeHref: withParams("/plans", sp, { retired: null }) }] : []),
  ];
  const clearHref = view ? "/plans?view=compare" : "/plans";

  const bars = [...visible]
    .sort((a, b) => b.workspaces - a.workspaces || a.name.localeCompare(b.name))
    .map((p) => ({
      key: p.key,
      label: p.name,
      value: p.workspaces,
      href: `/workspaces?plan=${encodeURIComponent(p.key)}`,
      tone: p.active ? ("chart-1" as const) : ("muted" as const),
      note: p.active ? undefined : "retired",
    }));
  const onAnyPlan = bars.some((b) => b.value > 0);

  return (
    <>
      <PageHeader
        title="Plans"
        subtitle={
          plans.length === 0
            ? "What a workspace can be on — nothing yet."
            : `${plural(onSale, "plan")} on sale · ${retired} retired. A change to a plan reaches every workspace on it as it is saved.`
        }
        actions={
          caps.sell ? (
            <Link href="/plans/new" className={PRIMARY_LINK}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              New plan
            </Link>
          ) : undefined
        }
      />

      <div className="space-y-6">
        {plans.length > 0 && !hasDefault && (
          <Banner tone="warning" title="No plan is the default for new workspaces — signups without an invitation plan have nothing to start on.">
            {caps.sell ? "Open the edition new workspaces should start on and tick “Default for new workspaces”." : undefined}
          </Banner>
        )}

        {plans.length === 0 ? (
          <Panel>
            <EmptyState
              icon={<Layers className="h-5 w-5" />}
              title="No plans yet"
              body="Create the first edition — the plan new workspaces start on, with the modules they run on and the people included."
              action={
                caps.sell ? (
                  <Link href="/plans/new" className={PRIMARY_LINK}>
                    <Plus aria-hidden="true" className="h-4 w-4" />
                    New plan
                  </Link>
                ) : undefined
              }
            />
          </Panel>
        ) : (
          <div>
            <FilterBar
              trailing={
                <ViewTabs
                  label="View"
                  items={[
                    { key: "cards", label: "Cards", href: withParams("/plans", sp, { view: null }), active: view === null },
                    { key: "compare", label: "Compare", href: withParams("/plans", sp, { view: "compare" }), active: view === "compare" },
                  ]}
                />
              }
            >
              <SelectFilter param="kind" label="Kind" allLabel="All kinds" options={KIND_ORDER.map((k) => ({ value: k, label: planKindLabel(k) }))} />
              {countries.length > 0 && <SelectFilter param="country" label="Sold in" allLabel="Any country" options={countries.map((c) => ({ value: c, label: c }))} />}
              {(retired > 0 || f.retired) && <ToggleFilter param="retired" label={`Show retired (${retired})`} />}
            </FilterBar>
            <FilterChips chips={chips} clearHref={chips.length ? clearHref : undefined} />

            {visible.length === 0 ? (
              <Panel>
                <EmptyState variant="filtered" title="No plan matches these filters" body="Plans sold everywhere count as sold in every country." clearHref={clearHref} />
              </Panel>
            ) : view === "compare" ? (
              <CompareMatrix plans={visible} catalogue={catalogue} />
            ) : (
              <PlanCards plans={visible} catalogue={catalogue} caps={caps} />
            )}
          </div>
        )}

        {onAnyPlan && (
          <ChartFrame
            title="Workspaces per plan"
            description="Workspaces on each plan through a live subscription. One workspace can be on several plans — an edition and its add-ons."
            table={<ChartTable columns={["Plan", "Key", "Workspaces"]} rows={bars.map((b) => [b.label, b.key, b.value])} numericFrom={2} />}
          >
            <HBarChart bars={bars} label="Workspaces per plan" />
          </ChartFrame>
        )}
      </div>
    </>
  );
}
