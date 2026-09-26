import { Cell, DataTable, PageTitle, Section } from "@/components/console/console-ui";
import { PlanForm } from "@/components/console/plan-forms";
import { AddPriceForm } from "@/components/console/billing-forms";
import { ConsoleAction } from "@/components/console/console-action";
import { consoleRetirePrice } from "@/actions/platform/console";
import { formatMoney } from "@/lib/billing/money";
import { consoleStaff, isOwner } from "@/lib/platform/console-page";
import { plansList } from "@/lib/platform/console-data";
import { moduleCatalogue } from "@/lib/platform/plans";

/**
 * What a workspace can be on. A change to a plan reaches every workspace on it at once — their
 * entitlements are worked out again as it is saved (src/lib/platform/plans.ts). Its prices are made
 * at their gateway as they are added (src/lib/billing/prices.ts).
 */
export default async function ConsolePlansPage() {
  const staff = await consoleStaff();
  const plans = await plansList();
  const catalogue = moduleCatalogue();
  const seller = ["OWNER", "ADMIN", "BILLING"].includes(staff.role);
  const owner = isOwner(staff);
  const hasDefault = plans.some((p) => p.isDefault && p.active);
  return (
    <>
      <PageTitle title="Plans">
        What each plan includes. Modules sold only in India go only into plans sold only there.
        {!hasDefault && " No plan is marked for new workspaces yet, so a new workspace starts with only the core."}
      </PageTitle>
      <Section title={`${plans.length} plan(s)`}>
        <DataTable head={["Plan", "Kind", "Modules", "Users", "Copilot / month", "Sold in", "Prices", "Workspaces"]} empty="None yet.">
          {plans.map((p) => (
            <tr key={p.id} className={p.active ? undefined : "opacity-60"}>
              <Cell>
                <span className="font-medium">{p.name}</span>
                {p.isDefault && <span className="ml-1 text-xs text-brand">new workspaces</span>}
                {!p.active && <span className="ml-1 text-xs text-muted">retired</span>}
                <span className="block font-mono text-xs text-muted">{p.key}</span>
              </Cell>
              <Cell>{p.kind.toLowerCase()}</Cell>
              <Cell className="max-w-[280px] text-xs text-muted">{p.allModules ? "every module" : p.modules.join(", ") || "the basics only"}</Cell>
              <Cell>{p.seats ?? "no limit"}</Cell>
              <Cell>{p.copilotTokens === null ? "no limit" : p.copilotTokens === 0 ? "none" : p.copilotTokens.toLocaleString("en-IN")}</Cell>
              <Cell>{p.countries.join(", ") || "everywhere"}</Cell>
              <Cell className="text-xs">
                {p.prices.filter((x) => x.active).map((x) => (
                  <span key={x.id} className="block whitespace-nowrap">
                    {formatMoney(x.amount, x.currency)}/{x.interval === "YEAR" ? "yr" : "mo"}
                    {x.perSeat ? " per person" : ""} <span className="text-muted">{x.gateway.toLowerCase()}</span>
                  </span>
                ))}
                {p.kind !== "INTERNAL" && !p.prices.some((x) => x.active) && <span className="text-muted">not for sale yet</span>}
              </Cell>
              <Cell>{p.workspaces}</Cell>
            </tr>
          ))}
        </DataTable>
      </Section>
      {seller && (
        <>
          <Section title="New plan">
            <PlanForm catalogue={catalogue} owner={owner} />
          </Section>
          {plans.map((p) => (
            <details key={p.id} className="mb-3 rounded-xl border border-line bg-surface px-5 py-3">
              <summary className="cursor-pointer text-sm font-medium text-text">Change {p.name}</summary>
              {p.kind !== "INTERNAL" && (
                <div className="mt-4 space-y-2 border-b border-line pb-4">
                  <p className="text-xs text-muted">
                    Prices — made at the gateway as they are added, never changed there: a new price replaces the one on sale, and workspaces already paying the old one keep it.
                  </p>
                  {p.prices.map((x) => (
                    <div key={x.id} className={x.active ? "flex flex-wrap items-center gap-2 text-sm" : "flex flex-wrap items-center gap-2 text-sm opacity-60"}>
                      <span>
                        {formatMoney(x.amount, x.currency)} {x.interval === "YEAR" ? "a year" : "a month"}
                        {x.perSeat ? ", per person" : ""} — {x.gateway.toLowerCase()} <span className="font-mono text-xs text-muted">{x.externalId}</span>
                        {!x.active && " (retired)"}
                      </span>
                      {x.active && <ConsoleAction action={consoleRetirePrice.bind(null, x.id)} label="Take off sale" variant="ghost" confirm="Take this price off sale? Workspaces already paying it keep it." />}
                    </div>
                  ))}
                  <AddPriceForm planKey={p.key} />
                </div>
              )}
              <div className="mt-4">
                <PlanForm
                  owner={owner}
                  catalogue={catalogue}
                  plan={{
                    key: p.key,
                    name: p.name,
                    kind: p.kind,
                    description: p.description,
                    allModules: p.allModules,
                    modules: p.modules,
                    countries: p.countries,
                    seats: p.seats,
                    copilotTokens: p.copilotTokens,
                    isDefault: p.isDefault,
                    active: p.active,
                    sortOrder: p.sortOrder,
                  }}
                />
              </div>
            </details>
          ))}
        </>
      )}
    </>
  );
}
