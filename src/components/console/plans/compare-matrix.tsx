import type { ReactNode } from "react";
import Link from "next/link";
import { Check, Minus } from "lucide-react";
import { Panel } from "@/components/console/kit/panel";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, DayHeaderRow, TBody, Td, Tr } from "@/components/console/kit/table";
import { compactNumber } from "@/lib/console-shared/format";
import { gatewayLabel, planKindLabel } from "@/lib/console-shared/labels";
import type { CatalogueModuleView } from "@/lib/console-shared/types";
import { withDependencies } from "@/lib/entitlements";
import { getModuleDefinition, navGroupRank } from "@/lib/modules";
import type { PlanListRow } from "@/lib/platform/console-data";
import { cn } from "@/lib/utils";
import { priceLine } from "./plan-cards";

/**
 * Plans side by side: the facts that decide a sale first (limits, where it is sold, prices, who is on
 * it), then every module as a row. A module a plan lists is a tick; one it gets because a listed
 * module needs it is a tick "with …" — entitlements add what a module needs (src/lib/entitlements.ts),
 * so a dash there would be wrong; a module sold only in some countries says so. Server-safe.
 */

const EVERY_PLAN = "In every plan";

/** The row heading column stays put while a wide matrix scrolls sideways. */
const ROW_HEAD = "sticky left-0 z-[1] bg-surface py-2.5 pr-4 pl-5 text-left align-top text-sm font-normal text-text [[data-density=compact]_&]:py-1.5";
const SUMMARY_HEAD = cn(ROW_HEAD, "text-xs font-medium text-muted");

type Membership = { state: "listed" | "every" | "needed" | "none"; by: string[] };

function membership(plan: PlanListRow, module: CatalogueModuleView, needs: Map<string, string[]>): Membership {
  if (plan.allModules) return { state: "listed", by: [] };
  if (module.inEveryPlan) return { state: "every", by: [] };
  if (plan.modules.includes(module.key)) return { state: "listed", by: [] };
  const by = needs.get(module.key);
  return by?.length ? { state: "needed", by } : { state: "none", by: [] };
}

/** For each module a plan gets only through another's needs: the listed modules that need it. */
function neededBy(plan: PlanListRow, labelOf: (key: string) => string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (plan.allModules) return out;
  for (const key of plan.modules) {
    for (const dep of withDependencies([key])) {
      if (dep === key || plan.modules.includes(dep)) continue;
      out.set(dep, [...(out.get(dep) ?? []), labelOf(key)]);
    }
  }
  return out;
}

function Cell({ m, countries }: { m: Membership; countries: readonly string[] | null }) {
  if (m.state === "none") {
    return (
      <>
        <Minus aria-hidden="true" className="mx-auto h-4 w-4 text-subtle" />
        <span className="sr-only">Not included</span>
      </>
    );
  }
  const limited = countries && countries.length > 0 ? `${countries.join(", ")} only` : null;
  const note = m.state === "every" ? "In every plan" : m.state === "needed" ? `Comes with ${m.by.join(", ")}` : "Included";
  return (
    <span className="inline-flex flex-col items-center" title={limited ? `${note} · sold only in ${countries!.join(", ")}` : note}>
      <Check aria-hidden="true" className={cn("h-4 w-4", m.state === "listed" ? "text-success" : "text-subtle")} />
      <span className="sr-only">{note}</span>
      {m.state === "needed" && (
        <span aria-hidden="true" className="mt-0.5 max-w-32 truncate text-[11px] leading-4 text-subtle">
          with {m.by[0]}
          {m.by.length > 1 ? ` +${m.by.length - 1}` : ""}
        </span>
      )}
      {limited && <span className="mt-0.5 text-[11px] leading-4 whitespace-nowrap text-warning">{limited}</span>}
    </span>
  );
}

function SummaryRow({ label, plans, render }: { label: string; plans: PlanListRow[]; render: (plan: PlanListRow) => ReactNode }) {
  return (
    <Tr>
      <th scope="row" className={SUMMARY_HEAD}>
        {label}
      </th>
      {plans.map((plan) => (
        <Td key={plan.key} className="text-center align-top">
          {render(plan)}
        </Td>
      ))}
    </Tr>
  );
}

export function CompareMatrix({ plans, catalogue }: { plans: PlanListRow[]; catalogue: CatalogueModuleView[] }) {
  const labels = new Map(catalogue.map((m) => [m.key, m.label]));
  const labelOf = (key: string) => labels.get(key) ?? getModuleDefinition(key)?.label ?? key;
  const needs = new Map(plans.map((p) => [p.key, neededBy(p, labelOf)]));

  // Modules in the order and groups of the workspace's own sidebar; the every-plan basics last.
  const grouped = new Map<string, CatalogueModuleView[]>();
  for (const m of catalogue) {
    const group = m.inEveryPlan ? EVERY_PLAN : (getModuleDefinition(m.key)?.navGroup ?? "Other");
    grouped.set(group, [...(grouped.get(group) ?? []), m]);
  }
  const rank = (group: string) => (group === EVERY_PLAN ? Number.MAX_SAFE_INTEGER : navGroupRank(group));
  const groups = [...grouped].sort(([a], [b]) => rank(a) - rank(b));
  const columns = plans.length + 1;

  return (
    <Panel
      title="Compare plans"
      description="Limits, prices and modules side by side. Scroll sideways for more plans."
      padded={false}
      footer={
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1">
            <Check aria-hidden="true" className="h-3.5 w-3.5 text-success" /> listed on the plan
          </span>
          <span className="inline-flex items-center gap-1">
            <Check aria-hidden="true" className="h-3.5 w-3.5 text-subtle" /> in every plan, or comes with a module that needs it
          </span>
          <span>
            <span className="text-warning">IN only</span> sold only in those countries
          </span>
        </span>
      }
    >
      <DataTable caption="Plans compared" minWidth={220 + plans.length * 170}>
        <thead className="[&>tr]:border-b [&>tr]:border-line">
          <tr>
            <th scope="col" className={cn(ROW_HEAD, "align-bottom text-xs font-medium text-muted")}>
              Plan
            </th>
            {plans.map((plan) => (
              <th key={plan.key} scope="col" className="min-w-[150px] px-4 py-3 text-center align-bottom last:pr-5">
                <Link href={`/plans/${encodeURIComponent(plan.key)}`} className="text-sm font-semibold break-words text-text hover:text-brand">
                  {plan.name}
                </Link>
                <span className="mt-0.5 block font-mono text-[11px] font-normal break-all text-muted">{plan.key}</span>
                {(plan.isDefault || !plan.active) && (
                  <span className="mt-1.5 flex flex-wrap justify-center gap-1">
                    {plan.isDefault && <StatusPill tone="brand">Default</StatusPill>}
                    {!plan.active && <StatusPill tone="neutral">Retired</StatusPill>}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <TBody>
          <SummaryRow label="Kind" plans={plans} render={(p) => <span className="text-sm text-text">{planKindLabel(p.kind)}</span>} />
          <SummaryRow
            label="Users per unit"
            plans={plans}
            render={(p) => <span className="text-sm text-text tabular-nums">{p.seats === null ? "No limit" : compactNumber(p.seats)}</span>}
          />
          <SummaryRow
            label="Copilot a month"
            plans={plans}
            render={(p) => (
              <span className="text-sm text-text tabular-nums">{p.copilotTokens === null ? "No limit" : p.copilotTokens === 0 ? "None" : `${compactNumber(p.copilotTokens)} tokens`}</span>
            )}
          />
          <SummaryRow
            label="Custom domains"
            plans={plans}
            render={(p) => <span className="text-sm text-text tabular-nums">{p.customDomains === null ? "No limit" : p.customDomains === 0 ? "None" : compactNumber(p.customDomains)}</span>}
          />
          <SummaryRow label="Sold in" plans={plans} render={(p) => <span className="text-sm text-text">{p.countries.length ? p.countries.join(", ") : "Everywhere"}</span>} />
          <SummaryRow
            label="Prices"
            plans={plans}
            render={(p) => {
              const live = p.prices.filter((x) => x.active);
              if (p.kind === "INTERNAL") return <span className="text-xs text-muted">Never sold</span>;
              if (live.length === 0) return <span className="text-xs text-warning">No price yet</span>;
              return (
                <span className="flex flex-col items-center gap-0.5">
                  {live.map((x) => (
                    <span key={x.id} className="text-xs whitespace-nowrap text-text tabular-nums">
                      {priceLine(x)}
                      <span className="text-muted"> · {gatewayLabel(x.gateway)}</span>
                    </span>
                  ))}
                </span>
              );
            }}
          />
          <SummaryRow
            label="Workspaces"
            plans={plans}
            render={(p) =>
              p.workspaces > 0 ? (
                <Link href={`/workspaces?plan=${encodeURIComponent(p.key)}`} className="text-sm font-medium text-brand tabular-nums hover:underline">
                  {compactNumber(p.workspaces)}
                </Link>
              ) : (
                <span className="text-sm text-subtle tabular-nums">0</span>
              )
            }
          />
        </TBody>
        {groups.map(([group, modules]) => (
          <TBody key={group}>
            <DayHeaderRow label={group} colSpan={columns} />
            {modules.map((m) => (
              <Tr key={m.key}>
                <th scope="row" className={ROW_HEAD}>
                  {m.label}
                  {m.requires.length > 0 && <span className="block text-[11px] leading-4 text-subtle">Needs {m.requires.map(labelOf).join(", ")}</span>}
                </th>
                {plans.map((plan) => (
                  <Td key={plan.key} className="text-center align-top">
                    <Cell m={membership(plan, m, needs.get(plan.key) ?? new Map())} countries={m.countries} />
                  </Td>
                ))}
              </Tr>
            ))}
          </TBody>
        ))}
      </DataTable>
    </Panel>
  );
}
