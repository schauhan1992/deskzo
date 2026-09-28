"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Eye, EyeOff, LoaderCircle, RotateCcw, Webhook } from "lucide-react";
import { consoleBillingEvent, consoleReplayBillingEvent } from "@/actions/platform/console-billing";
import { Banner } from "@/components/console/kit/banner";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { CopyField } from "@/components/console/kit/copy-field";
import { EmptyState } from "@/components/console/kit/empty-state";
import { DateRangeFilter, SearchField, SelectFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips } from "@/components/console/kit/filters";
import { ImpactList } from "@/components/console/kit/impact";
import { useConsoleNotice } from "@/components/console/kit/notice";
import { DefinitionList, Panel } from "@/components/console/kit/panel";
import { LabelPill, StatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { SidePane } from "@/components/ui/side-pane";
import { dayMonthYear, plural } from "@/lib/console-shared/format";
import { EVENT_STATE, gatewayLabel } from "@/lib/console-shared/labels";
import { parseEventFilters } from "@/lib/console-shared/params";
import type { Caps } from "@/lib/console-shared/roles";
import type { BillingEventDetail, BillingEventRow, BillingEventsPage } from "@/lib/platform/billing-events";
import { cn } from "@/lib/utils";
import { ListPager, istStamp, rangeLabel } from "./invoices-tab";

/**
 * The Billing hub's Events tab: what the gateways' webhooks said, and what became of each one.
 *
 * A row opens the event in a side pane, which asks the server for it then — the list never carries
 * a payload. The payload arrives with the customer's personal details replaced; an owner can ask for
 * it as the gateway sent it, which is recorded. An event that never went through can be replayed:
 * run through the same handler again from what was stored, one at a time, so each outcome is seen.
 */

const PATH = "/billing";

const GATEWAY_OPTIONS = [
  { value: "STRIPE", label: "Stripe" },
  { value: "RAZORPAY", label: "Razorpay" },
];
const STATE_OPTIONS = (["processed", "failed", "waiting"] as const).map((key) => ({ value: key, label: EVENT_STATE[key].label }));

const LOAD_FAILED = "Couldn't load this event. Close it and try again.";

function payloadText(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2) ?? "—";
  } catch {
    return "This payload can't be shown.";
  }
}

export function EventsTable({ list, caps }: { list: BillingEventsPage; caps: Caps }) {
  const searchParams = useSearchParams();
  const params: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) if (key !== "page" && value) params[key] = value;
  params.tab = "events";
  const f = parseEventFilters(params);

  const withChange = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    return `${PATH}?${next.toString()}`;
  };
  const chips = [
    ...(f.gateway ? [{ key: "gateway", label: `Gateway: ${gatewayLabel(f.gateway)}`, removeHref: withChange({ gateway: null }) }] : []),
    ...(f.state ? [{ key: "state", label: `Outcome: ${EVENT_STATE[f.state].label}`, removeHref: withChange({ state: null }) }] : []),
    ...(f.type ? [{ key: "type", label: `Type: ${f.type}`, removeHref: withChange({ type: null }) }] : []),
    ...(f.tenant ? [{ key: "tenant", label: `Workspace: ${f.tenant}`, removeHref: withChange({ tenant: null }) }] : []),
    ...(f.from || f.to ? [{ key: "received", label: `Received ${rangeLabel(f.from, f.to)}`, removeHref: withChange({ from: null, to: null }) }] : []),
  ];
  const clearHref = `${PATH}?tab=events`;

  // ── The side pane ──────────────────────────────────────────────────────────────────────────────
  const [openRow, setOpenRow] = useState<BillingEventRow | null>(null);
  const [detail, setDetail] = useState<BillingEventDetail | null>(null);
  const [raw, setRaw] = useState<BillingEventDetail | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [loading, setLoading] = useState<"detail" | "raw" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Each load is numbered: an answer for an event the pane has since left is dropped.
  const loads = useRef(0);

  async function load(row: BillingEventRow, asRaw: boolean) {
    const mine = ++loads.current;
    setLoading(asRaw ? "raw" : "detail");
    setLoadError(null);
    try {
      const result = await consoleBillingEvent(row.id, asRaw ? true : undefined);
      if (mine !== loads.current) return;
      if (!result.ok) setLoadError(result.error);
      else if (asRaw) {
        setRaw(result.data);
        setShowRaw(true);
      } else setDetail(result.data);
    } catch {
      if (mine === loads.current) setLoadError(LOAD_FAILED);
    } finally {
      if (mine === loads.current) setLoading(null);
    }
  }

  function openPane(row: BillingEventRow) {
    setOpenRow(row);
    setDetail(null);
    setRaw(null);
    setShowRaw(false);
    void load(row, false);
  }

  function closePane() {
    loads.current += 1;
    setOpenRow(null);
    setLoading(null);
    setLoadError(null);
  }

  function toggleRaw() {
    if (!openRow || loading !== null) return;
    if (showRaw) setShowRaw(false);
    else if (raw) setShowRaw(true);
    else void load(openRow, true);
  }

  // ── Replay ─────────────────────────────────────────────────────────────────────────────────────
  const { show } = useConsoleNotice();
  const [replayTarget, setReplayTarget] = useState<BillingEventRow | null>(null);
  const replay = useConsoleAction<{ ok: boolean; error: string | null }>();

  function askReplay(row: BillingEventRow) {
    // The pane closes first: two modal layers at once would fight over the keyboard.
    if (openRow) closePane();
    replay.reset();
    setReplayTarget(row);
  }

  function closeReplay() {
    setReplayTarget(null);
    replay.reset();
  }

  function confirmReplay() {
    if (!replayTarget) return;
    const { id } = replayTarget;
    replay.run(() => consoleReplayBillingEvent(id), {
      success: (d) => (d.ok ? "Replayed — the event went through this time." : ""),
      onDone: (d) => {
        setReplayTarget(null);
        if (!d.ok) show("error", `Replayed, but it failed again: ${d.error ?? "the gateway gave no reason"}.`);
      },
    });
  }

  const shown = openRow ? (showRaw && raw ? raw : detail) : null;
  // The loaded event is fresher than the list row (a replay may have cleared its error since).
  const paneError = shown ? shown.error : (openRow?.error ?? null);
  const unprocessed = (row: BillingEventRow) => row.state !== "processed";

  return (
    <div>
      {list.failing > 0 && f.state !== "failed" && (
        <Banner
          tone="danger"
          className="mb-4"
          title={`${plural(list.failing, "webhook")} failed and ${list.failing === 1 ? "hasn't" : "haven't"} gone through since`}
          action={
            <Link href={`${PATH}?tab=events&state=failed`} className="rounded-base text-sm font-medium underline underline-offset-2">
              Show failed
            </Link>
          }
        >
          Replay one once its cause is fixed, or wait for the gateway to send it again.
        </Banner>
      )}

      <FilterBar>
        <SearchField param="type" label="Event type" placeholder="Event type, e.g. invoice.*" />
        <SearchField param="tenant" label="Workspace address" placeholder="Workspace address" className="sm:w-56" />
        <SelectFilter param="gateway" label="Gateway" options={GATEWAY_OPTIONS} />
        <SelectFilter param="state" label="Outcome" options={STATE_OPTIONS} />
        <DateRangeFilter label="Received" />
      </FilterBar>
      <FilterChips chips={chips} clearHref={chips.length > 0 ? clearHref : undefined} />

      <Panel padded={false}>
        {list.rows.length === 0 ? (
          chips.length > 0 ? (
            <EmptyState variant="filtered" title="No events match these filters" body="Try a wider date range, or another outcome or gateway." clearHref={clearHref} />
          ) : (
            <EmptyState
              icon={<Webhook className="h-5 w-5" />}
              title="Nothing received yet"
              body="Check the webhook endpoints on the Overview tab are set in each gateway."
              action={
                <Link
                  href={PATH}
                  className="inline-flex h-8 items-center rounded-base border border-line-strong bg-surface px-3 text-[13px] font-medium text-text shadow-sm hover:bg-surface-sunken"
                >
                  See the webhook endpoints
                </Link>
              }
            />
          )
        ) : (
          <DataTable caption="Webhook events" stickyHeader minWidth={960}>
            <THead>
              <Th>Received</Th>
              <Th>Gateway</Th>
              <Th>Type</Th>
              <Th>Workspace</Th>
              <Th>Outcome</Th>
              <Th>Error</Th>
              <Th srOnly>Actions</Th>
            </THead>
            <TBody>
              {list.rows.map((row) => (
                // The first cell's button covers the row (its ::after), so a click anywhere opens the event.
                <Tr key={row.id} className={cn("relative hover:bg-surface-sunken", openRow?.id === row.id && "bg-surface-sunken")}>
                  <Td nowrap>
                    <button
                      type="button"
                      onClick={() => openPane(row)}
                      aria-label={`Open the ${row.type} event from ${gatewayLabel(row.gateway)}, received ${istStamp(row.receivedAt)}`}
                      className="rounded-base text-left font-medium text-text after:absolute after:inset-0 after:content-[''] hover:text-brand"
                    >
                      <time dateTime={row.receivedAt.toISOString()}>{istStamp(row.receivedAt)}</time>
                    </button>
                  </Td>
                  <Td nowrap>{gatewayLabel(row.gateway)}</Td>
                  <Td mono nowrap>
                    {row.type}
                  </Td>
                  <Td nowrap>
                    {row.tenant ? (
                      <Link href={`/workspaces/${row.tenant.slug}`} className="relative z-[1] font-medium text-text hover:text-brand hover:underline">
                        {row.tenant.slug}
                      </Link>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </Td>
                  <Td>
                    <LabelPill map={EVENT_STATE} value={row.state} />
                  </Td>
                  <Td muted>
                    {row.error ? (
                      <span className="block max-w-80 truncate text-danger" title={row.error}>
                        {row.error}
                      </span>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </Td>
                  <RowActionsCell>
                    {unprocessed(row) && <IconButton icon={RotateCcw} label={`Replay the ${row.type} event received ${istStamp(row.receivedAt)}`} onClick={() => askReplay(row)} />}
                  </RowActionsCell>
                </Tr>
              ))}
            </TBody>
          </DataTable>
        )}
      </Panel>
      <ListPager page={list.page} pageSize={list.pageSize} total={list.total} params={params} noun="event" />

      <SidePane open={openRow !== null} onClose={closePane} title={openRow ? openRow.type : "Webhook event"}>
        {openRow && (
          <div className="space-y-5 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <LabelPill map={EVENT_STATE} value={shown && shown.processedAt ? "processed" : openRow.state} />
              <span className="text-muted">{`${gatewayLabel(openRow.gateway)} · received ${dayMonthYear(openRow.receivedAt)}`}</span>
            </div>

            <DefinitionList
              columns={1}
              items={[
                { term: "Event id at the gateway", value: <CopyField value={openRow.eventId} label="event id" /> },
                {
                  term: "Workspace",
                  value: openRow.tenant ? (
                    <Link href={`/workspaces/${openRow.tenant.slug}`} className="font-medium text-brand hover:underline">
                      {openRow.tenant.slug}
                    </Link>
                  ) : (
                    <span className="text-muted">Not matched to a workspace</span>
                  ),
                },
                { term: "Received", value: istStamp(openRow.receivedAt) },
                { term: "Processed", value: shown?.processedAt ? istStamp(shown.processedAt) : openRow.processedAt ? istStamp(openRow.processedAt) : "Not yet" },
              ]}
            />

            {paneError && (
              <div>
                <p className="text-xs text-muted">Error</p>
                <p className="mt-1 rounded-lg border border-danger/40 bg-danger-bg px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap text-danger">{paneError}</p>
              </div>
            )}

            {unprocessed(openRow) && !shown?.processedAt && (
              <div className="space-y-2 rounded-lg border border-line bg-surface-sunken px-4 py-3">
                <p className="text-xs text-muted">This event hasn&apos;t gone through. Replaying it runs the same handler again, from what was stored when it arrived.</p>
                <Button type="button" size="sm" onClick={() => askReplay(openRow)}>
                  <RotateCcw aria-hidden="true" className="h-4 w-4" />
                  Replay…
                </Button>
              </div>
            )}

            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-[13px] font-medium text-text">Payload</h3>
                {shown &&
                  (shown.redacted ? (
                    <StatusPill tone="neutral">Personal details hidden</StatusPill>
                  ) : (
                    <StatusPill tone="warning">As the gateway sent it</StatusPill>
                  ))}
              </div>

              {caps.owner && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Button type="button" variant="secondary" size="sm" onClick={toggleRaw} aria-disabled={loading !== null || undefined} disabled={loading === "detail"}>
                    {loading === "raw" ? (
                      <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
                    ) : showRaw ? (
                      <EyeOff aria-hidden="true" className="h-4 w-4" />
                    ) : (
                      <Eye aria-hidden="true" className="h-4 w-4" />
                    )}
                    {showRaw ? "Hide personal details" : "Show raw payload"}
                  </Button>
                  <span className="text-xs text-warning">{showRaw ? "Personal data is showing — this view was recorded." : "Contains personal data; viewing is recorded."}</span>
                </div>
              )}

              <ActionNoticeRegion notice={loadError ? { tone: "error", message: loadError } : null} />

              {loading === "detail" && !shown ? (
                <p className="flex items-center gap-2 text-muted">
                  <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
                  Loading the payload…
                </p>
              ) : shown ? (
                <pre
                  tabIndex={0}
                  aria-label={shown.redacted ? "Payload, personal details hidden" : "Payload as the gateway sent it"}
                  className="max-h-[50vh] overflow-auto rounded-lg border border-line bg-surface-sunken p-3 font-mono text-xs leading-relaxed text-text"
                >
                  {payloadText(shown.payload)}
                </pre>
              ) : null}
            </div>
          </div>
        )}
      </SidePane>

      <ConfirmDialog
        open={replayTarget !== null}
        onClose={closeReplay}
        title="Replay webhook"
        confirmLabel="Replay"
        pending={replay.pending}
        error={replay.error}
        onConfirm={confirmReplay}
      >
        {replayTarget && (
          <>
            <p>
              Runs this event through the same handler again, from the payload stored when it arrived. The subscription, its invoices and the workspace&apos;s billing
              standing follow the outcome.
            </p>
            <ImpactList
              items={[
                { label: "Event", value: <span className="font-mono text-xs">{replayTarget.type}</span> },
                { label: "Gateway", value: gatewayLabel(replayTarget.gateway) },
                { label: "Workspace", value: replayTarget.tenant?.slug ?? "Not matched yet" },
                { label: "Received", value: istStamp(replayTarget.receivedAt) },
                ...(replayTarget.error ? [{ label: "Last error", value: <span className="block max-w-64 truncate" title={replayTarget.error}>{replayTarget.error}</span>, tone: "danger" as const }] : []),
              ]}
            />
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}
