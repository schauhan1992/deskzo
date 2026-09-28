"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Layers, RefreshCw } from "lucide-react";
import { consoleResyncSubscription } from "@/actions/platform/console-billing";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { CopyField } from "@/components/console/kit/copy-field";
import { EmptyState } from "@/components/console/kit/empty-state";
import { SearchField, SelectFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips } from "@/components/console/kit/filters";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { LabelPill, StatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { IconButton } from "@/components/ui/icon-button";
import { formatMoney } from "@/lib/billing/money";
import { dayMonthYear, gatewayDashboardUrl } from "@/lib/console-shared/format";
import { ENDS_AT_PERIOD_END, SUBSCRIPTION_STATUS, gatewayLabel, intervalLabel, subscriptionKind } from "@/lib/console-shared/labels";
import { parseSubscriptionFilters } from "@/lib/console-shared/params";
import type { SubscriptionStatusKey } from "@/lib/console-shared/types";
import type { SubscriptionListRow, SubscriptionsPage } from "@/lib/platform/revenue";
import { ListPager, istStamp } from "./invoices-tab";

/**
 * The Billing hub's Subscriptions tab: every subscription — at a gateway, on a trial, given by hand —
 * with what it charges a month, where its period stands, and its id at the gateway to copy or open
 * there. A gateway subscription can be read back from its gateway (Resync) when a webhook went
 * missing; everyone who can open this page may do that.
 */

const PATH = "/billing";

const STATUS_OPTIONS = (Object.keys(SUBSCRIPTION_STATUS) as SubscriptionStatusKey[]).map((key) => ({ value: key, label: SUBSCRIPTION_STATUS[key].label }));
const GATEWAY_OPTIONS = [
  { value: "STRIPE", label: "Stripe" },
  { value: "RAZORPAY", label: "Razorpay" },
  { value: "MANUAL", label: "Trial or given by hand" },
];
const INTERVAL_OPTIONS = [
  { value: "MONTH", label: "Monthly" },
  { value: "YEAR", label: "Yearly" },
];

const statusLabel = (status: string) => (Object.prototype.hasOwnProperty.call(SUBSCRIPTION_STATUS, status) ? SUBSCRIPTION_STATUS[status as SubscriptionStatusKey].label : status);

function resyncMessage(slug: string, d: { before: string; after: string }): string {
  return d.before === d.after
    ? `Resynced ${slug} — the gateway agrees: ${statusLabel(d.after).toLowerCase()}.`
    : `Resynced ${slug} — ${statusLabel(d.before).toLowerCase()} → ${statusLabel(d.after).toLowerCase()}.`;
}

/** A date column: "28 Sep 2026", with the exact India time on hover; "—" for none. */
function DateCell({ at, tone }: { at: Date | null; tone?: "danger" }) {
  if (!at) return <span className="text-subtle">—</span>;
  return (
    <time dateTime={at.toISOString()} title={istStamp(at)} className={tone === "danger" ? "text-danger" : undefined}>
      {dayMonthYear(at)}
    </time>
  );
}

function ExternalId({ row, modes }: { row: SubscriptionListRow; modes: SubscriptionsPage["modes"] }) {
  if (!row.externalId) return <span className="text-subtle">—</span>;
  if (row.gateway === "MANUAL") return <span className="font-mono text-xs text-muted">{row.externalId}</span>;
  const mode = row.gateway === "STRIPE" ? modes.stripe : modes.razorpay;
  return (
    <CopyField
      value={row.externalId}
      label={`${row.tenant.slug}'s ${gatewayLabel(row.gateway)} subscription id`}
      href={gatewayDashboardUrl(row.gateway, "subscription", row.externalId, mode)}
      hrefLabel={gatewayLabel(row.gateway)}
      className="max-w-56"
    />
  );
}

export function SubscriptionsTable({ list }: { list: SubscriptionsPage }) {
  const searchParams = useSearchParams();
  const params: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) if (key !== "page" && value) params[key] = value;
  params.tab = "subscriptions";
  const f = parseSubscriptionFilters(params);

  const withChange = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    return `${PATH}?${next.toString()}`;
  };
  const chips = [
    ...(f.status ? [{ key: "status", label: `Status: ${SUBSCRIPTION_STATUS[f.status].label}`, removeHref: withChange({ status: null }) }] : []),
    ...(f.gateway ? [{ key: "gateway", label: `Gateway: ${f.gateway === "MANUAL" ? "Trial or given by hand" : gatewayLabel(f.gateway)}`, removeHref: withChange({ gateway: null }) }] : []),
    ...(f.interval ? [{ key: "interval", label: `Billed ${f.interval === "YEAR" ? "yearly" : "monthly"}`, removeHref: withChange({ interval: null }) }] : []),
    ...(f.tenant ? [{ key: "tenant", label: `Workspace: ${f.tenant}`, removeHref: withChange({ tenant: null }) }] : []),
  ];
  const clearHref = `${PATH}?tab=subscriptions`;

  const [target, setTarget] = useState<SubscriptionListRow | null>(null);
  const resync = useConsoleAction<{ before: string; after: string }>();

  function closeResync() {
    setTarget(null);
    resync.reset();
  }

  function confirmResync() {
    if (!target) return;
    const { id, tenant } = target;
    resync.run(() => consoleResyncSubscription(id), { success: (d) => resyncMessage(tenant.slug, d), onDone: () => setTarget(null) });
  }

  return (
    <div>
      <FilterBar>
        <SearchField param="tenant" label="Workspace address" placeholder="Workspace address, e.g. acme" />
        <SelectFilter param="status" label="Status" options={STATUS_OPTIONS} />
        <SelectFilter param="gateway" label="Gateway" options={GATEWAY_OPTIONS} />
        <SelectFilter param="interval" label="Billed" options={INTERVAL_OPTIONS} />
      </FilterBar>
      <FilterChips chips={chips} clearHref={chips.length > 0 ? clearHref : undefined} />

      <Panel padded={false} footer={list.rows.length > 0 ? "Amount a month is before tax; a yearly price counts as a twelfth. Given-by-hand plans and trials charge nothing." : undefined}>
        {list.rows.length === 0 ? (
          chips.length > 0 ? (
            <EmptyState variant="filtered" title="No subscriptions match these filters" body="Try another status or gateway." clearHref={clearHref} />
          ) : (
            <EmptyState icon={<Layers className="h-5 w-5" />} title="No subscriptions yet" body="A subscription appears when a workspace starts a trial, is given a plan, or pays through a gateway." />
          )
        ) : (
          <DataTable caption="Subscriptions" stickyHeader minWidth={1360}>
            <THead>
              <Th>Workspace</Th>
              <Th>Gateway</Th>
              <Th>Status</Th>
              <Th>Plans</Th>
              <Th>Billed</Th>
              <Th numeric>Amount a month</Th>
              <Th>Period end</Th>
              <Th>Trial ends</Th>
              <Th>Past due since</Th>
              <Th>Cancels at period end</Th>
              <Th>Id at the gateway</Th>
              <Th>Synced</Th>
              <Th srOnly>Actions</Th>
            </THead>
            <TBody>
              {list.rows.map((row) => {
                const canResync = row.gateway !== "MANUAL" && Boolean(row.externalId);
                return (
                  <Tr key={row.id}>
                    <Td>
                      <Link href={`/workspaces/${row.tenant.slug}`} className="font-medium text-text hover:text-brand hover:underline">
                        {row.tenant.slug}
                      </Link>
                      <p className="max-w-48 truncate text-xs text-muted" title={row.tenant.name}>
                        {row.tenant.name}
                      </p>
                    </Td>
                    <Td nowrap>{subscriptionKind(row.gateway, row.status)}</Td>
                    <Td>
                      <LabelPill map={SUBSCRIPTION_STATUS} value={row.status} />
                    </Td>
                    <Td>
                      {row.plans.length === 0 ? (
                        <span className="text-subtle">—</span>
                      ) : (
                        <ul className="space-y-0.5">
                          {row.plans.map((p, i) => (
                            <li key={`${i}-${p.name}`} className="whitespace-nowrap">
                              {p.name}
                              <span className="ml-1 text-muted tabular-nums">{`×${p.quantity}`}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </Td>
                    <Td muted nowrap>
                      {row.interval || row.currency ? [row.interval ? `a ${intervalLabel(row.interval)}` : null, row.currency].filter(Boolean).join(" · ") : "—"}
                    </Td>
                    <Td numeric>{row.monthly !== null && row.currency ? formatMoney(row.monthly, row.currency) : <span className="text-subtle">—</span>}</Td>
                    <Td nowrap>
                      <DateCell at={row.currentPeriodEnd} />
                    </Td>
                    <Td nowrap>
                      <DateCell at={row.trialEndsAt} />
                    </Td>
                    <Td nowrap>
                      <DateCell at={row.pastDueSince} tone="danger" />
                    </Td>
                    <Td>
                      {row.cancelAtPeriodEnd ? <StatusPill tone={ENDS_AT_PERIOD_END.tone}>{ENDS_AT_PERIOD_END.label}</StatusPill> : <span className="text-subtle">—</span>}
                    </Td>
                    <Td>
                      <ExternalId row={row} modes={list.modes} />
                    </Td>
                    <Td muted nowrap>
                      {row.syncedAt ? <RelativeTime at={row.syncedAt} /> : row.gateway === "MANUAL" ? "—" : "Never"}
                    </Td>
                    <RowActionsCell>
                      {canResync && (
                        <IconButton icon={RefreshCw} label={`Resync ${row.tenant.slug} from ${gatewayLabel(row.gateway)}`} onClick={() => setTarget(row)} />
                      )}
                    </RowActionsCell>
                  </Tr>
                );
              })}
            </TBody>
          </DataTable>
        )}
      </Panel>
      <ListPager page={list.page} pageSize={list.pageSize} total={list.total} params={params} noun="subscription" />

      <ConfirmDialog
        open={target !== null}
        onClose={closeResync}
        title="Resync subscription"
        confirmLabel="Resync"
        pending={resync.pending}
        error={resync.error}
        onConfirm={confirmResync}
      >
        {target && (
          <p>
            {`Reads ${target.tenant.slug}'s subscription back from ${gatewayLabel(target.gateway)} now and applies what it says. Its status and period, and the workspace's billing standing, follow the gateway.`}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
