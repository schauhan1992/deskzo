"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { consoleExportStatement } from "@/actions/platform/console-commissions";
import { EmptyState } from "@/components/console/kit/empty-state";
import { ExportCsvButton } from "@/components/console/kit/export-button";
import { ImpactList } from "@/components/console/kit/impact";
import { DefinitionList, InsetBlock, SubHeading } from "@/components/console/kit/panel";
import { LabelPill } from "@/components/console/kit/status";
import { SidePane } from "@/components/ui/side-pane";
import { formatMoney } from "@/lib/billing/money";
import { dayMonthYear, monthLabel, plural, when } from "@/lib/console-shared/format";
import { STATEMENT_STATUS } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import type { ConsoleStatementDetail } from "@/lib/partners/commission-data";
import { ACCOUNTANT_POINTS, TAX_NOTE, bpText, partnerHref } from "./format";
import { EntriesTable } from "./entries-table";
import { StatementRowActions } from "./statements-table";

/**
 * One statement in a side pane over the Statements list (spec §9.2): its money and tax lines, who
 * did what when, the partner as the statement recorded it — with the bank details as a mask only —
 * and its entries. The page loads it from `?statement=<id>`; closing drops that param. It opens only
 * after hydration (a pane is drawn into `<body>`, which the server does not have).
 */

const noSubscribe = () => () => {};

export function StatementDrawer({
  detail,
  missing,
  caps,
  viewerId,
  twoPersonPayout,
  todayKey,
}: {
  detail: ConsoleStatementDetail | null;
  /** `?statement=` named one that does not exist (any more). */
  missing: boolean;
  caps: Caps;
  viewerId: string | null;
  twoPersonPayout: boolean;
  todayKey: string;
}) {
  const router = useRouter();
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  const key = detail?.id ?? (missing ? "missing" : null);
  // Closed by hand: hidden at once, before the address change brings the page without it. Once the
  // page arrives without it the slate is clean, so opening the same statement again works.
  const [closed, setClosed] = useState<string | null>(null);
  const [seenKey, setSeenKey] = useState(key);
  if (seenKey !== key) {
    setSeenKey(key);
    setClosed(null);
  }
  const open = isClient && key !== null && closed !== key;

  function close() {
    setClosed(key);
    const params = new URLSearchParams(window.location.search);
    params.delete("statement");
    const query = params.toString();
    router.replace(query ? `${window.location.pathname}?${query}` : window.location.pathname, { scroll: false });
  }

  return (
    <SidePane open={open} onClose={close} title={detail ? `Statement ${detail.number}` : "Statement"}>
      {detail ? (
        <StatementDetailBody detail={detail} caps={caps} viewerId={viewerId} twoPersonPayout={twoPersonPayout} todayKey={todayKey} />
      ) : (
        <EmptyState title="That statement no longer exists" body="It may have been removed, or the link is wrong. Close this to go back to the list." />
      )}
    </SidePane>
  );
}

/** The drawer's body on its own — exported for a page that shows a statement in place. */
export function StatementDetailBody({
  detail,
  caps,
  viewerId,
  twoPersonPayout,
  todayKey,
}: {
  detail: ConsoleStatementDetail;
  caps: Caps;
  viewerId: string | null;
  twoPersonPayout: boolean;
  todayKey: string;
}) {
  const { currency, snapshot } = detail;
  const money = (minor: number) => formatMoney(minor, currency);
  const address = [snapshot.address.line1, snapshot.address.line2, snapshot.address.city, snapshot.address.region, snapshot.address.postalCode].filter(Boolean).join(", ");
  const payout = snapshot.payout;
  const shown = detail.entries.length;

  return (
    <div className="space-y-5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <LabelPill map={STATEMENT_STATUS} value={detail.status} />
        <span className="text-muted">{`${monthLabel(detail.period)} · ${currency}`}</span>
      </div>
      <p>
        <Link href={partnerHref(detail.partner.slug)} className="font-medium text-brand hover:underline">
          {detail.partner.displayName}
        </Link>
      </p>

      {caps.payPartners && (detail.status === "DRAFT" || detail.status === "APPROVED") && (
        <div className="flex flex-wrap items-center gap-2">
          <StatementRowActions row={detail} caps={caps} viewerId={viewerId} twoPersonPayout={twoPersonPayout} todayKey={todayKey} />
        </div>
      )}

      <section className="space-y-2">
        <SubHeading actions={caps.partnerMoney ? <ExportCsvButton action={() => consoleExportStatement(detail.id)} /> : undefined}>Money</SubHeading>
        <ImpactList
          items={[
            { label: "Earned", value: money(detail.earned) },
            { label: "Taken back", value: money(detail.reversed) },
            { label: "Adjustments", value: money(detail.adjustments) },
            { label: "Commission (total)", value: money(detail.total) },
            ...detail.taxLines.map((line) => ({
              label: `${line.label} (${line.kind === "ADD" ? "added" : "withheld"}${line.rateBp !== null ? `, ${bpText(line.rateBp)}` : ""})`,
              value: `${line.kind === "ADD" ? "+" : "−"}${money(line.amount)}`,
            })),
            { label: "Net payable", value: money(detail.netPayable), tone: "brand" as const },
          ]}
        />
        <InsetBlock className="space-y-2 text-xs text-muted">
          <p className="font-medium text-text">{TAX_NOTE}</p>
          <details>
            <summary className="cursor-pointer text-brand">What to ask your accountant</summary>
            <ul className="mt-2 list-disc space-y-1 pl-4">
              {ACCOUNTANT_POINTS.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </details>
        </InsetBlock>
      </section>

      <section className="space-y-2">
        <SubHeading>History</SubHeading>
        <DefinitionList
          columns={1}
          items={[
            { term: "Generated", value: `${when(detail.generatedAt)} · ${detail.generatedByName}` },
            ...(detail.approvedAt ? [{ term: "Approved", value: `${when(detail.approvedAt)}${detail.approvedByName ? ` · ${detail.approvedByName}` : ""}` }] : []),
            ...(detail.paidAt
              ? [{ term: "Paid", value: `${dayMonthYear(detail.paidAt)}${detail.paidByName ? ` · recorded by ${detail.paidByName}` : ""}${detail.paymentReference ? ` · reference ${detail.paymentReference}` : ""}` }]
              : []),
            ...(detail.paymentNote ? [{ term: "Payment note", value: detail.paymentNote }] : []),
            ...(detail.voidedAt ? [{ term: "Voided", value: `${when(detail.voidedAt)}${detail.voidedByName ? ` · ${detail.voidedByName}` : ""}${detail.voidReason ? ` — ${detail.voidReason}` : ""}` }] : []),
            { term: "Partner's invoice number", value: detail.partnerInvoiceNumber ?? (detail.status === "APPROVED" ? "Not entered yet" : "—") },
          ]}
        />
      </section>

      <section className="space-y-2">
        <SubHeading>The partner, as the statement recorded it</SubHeading>
        <DefinitionList
          columns={1}
          items={[
            { term: "Legal name", value: snapshot.legalName || "—" },
            { term: "Country", value: snapshot.country || "—" },
            { term: "Address", value: address || "—" },
            { term: "Tax ids", value: snapshot.taxIds.length ? snapshot.taxIds.map((t) => `${t.kind} ${t.value}`).join(" · ") : "None recorded" },
            {
              term: "Paid to",
              value: payout ? (
                <span className="block">
                  <span className="block">{`${payout.accountHolder} · ${payout.bankName || "Bank"}`}</span>
                  <span className="block font-mono text-xs">{`•••• ${payout.last4}${payout.ifsc ? ` · IFSC ${payout.ifsc}` : ""}${payout.swift ? ` · SWIFT ${payout.swift}` : ""} · ${payout.currency}`}</span>
                </span>
              ) : (
                "No payout details on file"
              ),
            },
          ]}
        />
      </section>

      <section className="space-y-2">
        <SubHeading>{`Entries (${plural(detail.entryCount, "entry", "entries")})`}</SubHeading>
        {shown === 0 ? (
          <p className="text-xs text-muted">{detail.status === "VOID" ? "A void statement holds no entries — they went back to pending." : "No entries."}</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-line">
            <EntriesTable rows={detail.entries} caps={caps} showPartner={false} compact />
          </div>
        )}
        {shown < detail.entryCount && <p className="text-xs text-muted">{`Showing the first ${shown}. Export CSV has them all.`}</p>}
      </section>
    </div>
  );
}
