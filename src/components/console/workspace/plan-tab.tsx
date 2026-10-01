import { SlidersHorizontal } from "lucide-react";
import { Banner } from "@/components/console/kit/banner";
import { EmptyState } from "@/components/console/kit/empty-state";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { LabelPill, StatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { plural } from "@/lib/console-shared/format";
import { SUBSCRIPTION_STATUS, gatewayLabel, planKindLabel, subscriptionKind } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import type { PlanPanel, WorkspaceHeader } from "@/lib/platform/workspace-data";
import { AddOverrideButton, LimitsButton, ModuleGrid, RemoveOverrideButton } from "./override-dialogs";
import { PlansEditor } from "./plans-editor";

/**
 * Workspace 360 › Plan & modules: what it is on, what that lets it use, the overrides staff have
 * put in place of its plans, and its limits.
 *
 *   Plans      sellers change them here (previewed) — unless it pays at a gateway, where its plans
 *              change from its own billing page; everybody else reads the list.
 *   Modules    the catalogue with this workspace's standing on each.
 *   Overrides  managers add and remove them.
 *   Limits     sellers override seats, copilot tokens and custom domains.
 *
 * A closed workspace shows all of it read-only.
 */

const INTEGER = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

export function PlanTab({ header, plan, caps }: { header: WorkspaceHeader; plan: PlanPanel; caps: Caps }) {
  const tenant = header.tenant;
  const closed = tenant.status === "DEPROVISIONED";
  const canEditPlans = caps.sell && !closed && plan.canSetPlans;
  const canOverride = caps.manage && !closed;
  const canLimit = caps.sell && !closed;

  // What the editor changes: the plans on its subscription given by hand (a trial or a plan given free).
  const current = plan.items.filter((i) => i.gateway === "MANUAL").map((i) => ({ planKey: i.planKey, quantity: i.quantity }));
  const editorKey = current
    .map((c) => `${c.planKey}:${c.quantity}`)
    .sort()
    .join("|");
  const moduleLabels = Object.fromEntries(plan.catalogue.map((m) => [m.key, m.label]));
  const entitledCount = plan.modules.filter((m) => m.state === "plan" || m.state === "added").length;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Panel title="Plans" description="What it is on — its plans decide its modules and add up to its limits.">
            {plan.gateway && !closed && (
              <Banner tone="info" title={`This workspace pays through ${gatewayLabel(plan.gateway.gateway)}.`} className="mb-4">
                Its plans change there — from its own billing page. To give it something extra, add a module or raise a limit instead.
              </Banner>
            )}
            {canEditPlans ? (
              <PlansEditor
                key={editorKey}
                tenantId={tenant.id}
                country={tenant.country}
                current={current}
                choices={plan.choices}
                owner={caps.owner}
                moduleLabels={moduleLabels}
              />
            ) : (
              <PlanList items={plan.items} />
            )}
          </Panel>

          <Panel title="Modules" description={plan.entitlements.all ? "Every module — its plans include all of them." : `${entitledCount} of ${plural(plan.modules.length, "module")} a plan decides.`}>
            <ModuleGrid modules={plan.modules} country={tenant.country} />
          </Panel>
        </div>

        <div className="min-w-0 space-y-6">
          <Panel
            title="Limits"
            description="What its plans add up to, unless staff set a limit in their place."
            actions={
              canLimit ? (
                <LimitsButton tenantId={tenant.id} seats={plan.limits.seatOverride} copilotTokens={plan.limits.copilotTokenOverride} customDomains={plan.limits.customDomainOverride} />
              ) : undefined
            }
          >
            <dl className="divide-y divide-line">
              <LimitRow term="Seats" value={plan.limits.seats === null ? "No limit" : INTEGER.format(plan.limits.seats)} overridden={plan.limits.seatOverride !== null} />
              <LimitRow
                term="Copilot tokens a month"
                value={plan.limits.copilotTokens === null ? "No limit" : plan.limits.copilotTokens === 0 ? "None" : INTEGER.format(plan.limits.copilotTokens)}
                overridden={plan.limits.copilotTokenOverride !== null}
              />
              <LimitRow
                term="Custom domains"
                value={plan.limits.customDomains === null ? "No limit" : plan.limits.customDomains === 0 ? "None" : INTEGER.format(plan.limits.customDomains)}
                overridden={plan.limits.customDomainOverride !== null}
              />
            </dl>
            {(plan.limits.seatOverride !== null || plan.limits.copilotTokenOverride !== null || plan.limits.customDomainOverride !== null) && (
              <p className="mt-3 text-xs text-muted">An overridden limit stays when its plans change. Clear it to let the plans decide again.</p>
            )}
          </Panel>
        </div>
      </div>

      <Panel
        title="Overrides"
        description="Modules added or taken away by hand, whatever its plans say."
        actions={canOverride ? <AddOverrideButton tenantId={tenant.id} catalogue={plan.catalogue} /> : undefined}
        padded={false}
      >
        {plan.overrides.length === 0 ? (
          <EmptyState
            icon={<SlidersHorizontal className="h-5 w-5" />}
            title="No overrides"
            body="Its modules are exactly what its plans say."
          />
        ) : (
          <DataTable caption="Module overrides" minWidth={680}>
            <THead>
              <Th>Module</Th>
              <Th>Override</Th>
              <Th>Why</Th>
              <Th>By</Th>
              <Th>When</Th>
              {canOverride && <Th srOnly>Remove</Th>}
            </THead>
            <TBody>
              {plan.overrides.map((o) => (
                <Tr key={o.moduleKey}>
                  <Td className="font-medium">{o.label}</Td>
                  <Td>
                    <StatusPill tone={o.granted ? "success" : "danger"}>{o.granted ? "added" : "taken away"}</StatusPill>
                  </Td>
                  <Td muted className="max-w-md break-words">
                    {o.reason || "—"}
                  </Td>
                  <Td nowrap>{o.byName}</Td>
                  <Td muted nowrap>
                    <RelativeTime at={o.createdAt} />
                  </Td>
                  {canOverride && (
                    <RowActionsCell>
                      <RemoveOverrideButton tenantId={tenant.id} moduleKey={o.moduleKey} label={o.label} />
                    </RowActionsCell>
                  )}
                </Tr>
              ))}
            </TBody>
          </DataTable>
        )}
      </Panel>
    </div>
  );
}

/** The plans it is on, read-only: name ×quantity, kind, and where each comes from. */
function PlanList({ items }: { items: PlanPanel["items"] }) {
  if (items.length === 0) return <p className="text-sm text-muted">No plan — it has the core modules only.</p>;
  return (
    <ul className="divide-y divide-line rounded-lg border border-line">
      {items.map((item) => (
        <li key={`${item.subscriptionId}-${item.planKey}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-3 py-2">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-text">
              {item.planName}
              {item.quantity > 1 && <span className="ml-1 text-muted tabular-nums">×{item.quantity}</span>}
            </span>
            <StatusPill tone={item.kind === "INTERNAL" ? "brand" : "neutral"}>{planKindLabel(item.kind)}</StatusPill>
            {!item.active && <StatusPill tone="warning">Retired</StatusPill>}
          </span>
          <span className="flex items-center gap-2 text-xs text-muted">
            {subscriptionKind(item.gateway, item.status)}
            {item.status !== "ACTIVE" && <LabelPill map={SUBSCRIPTION_STATUS} value={item.status} />}
          </span>
        </li>
      ))}
    </ul>
  );
}

function LimitRow({ term, value, overridden }: { term: string; value: string; overridden: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
      <dt className="text-xs text-muted">{term}</dt>
      <dd className="flex items-center gap-2">
        <span className="text-sm font-semibold text-text tabular-nums">{value}</span>
        <StatusPill tone={overridden ? "warning" : "neutral"}>{overridden ? "overridden" : "from plans"}</StatusPill>
      </dd>
    </div>
  );
}
