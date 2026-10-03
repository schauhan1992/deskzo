import Link from "next/link";
import { LabelPill, StatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, TBody, TFoot, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { formatMoney } from "@/lib/billing/money";
import { plural } from "@/lib/console-shared/format";
import { COMMISSION_KIND, COMMISSION_STATUS, STATEMENT_STATUS } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import type { ConsoleCommissionRow, CurrencyTotal } from "@/lib/partners/commission-data";
import { indiaClock, type Clock } from "@/lib/time/zone";
import { basisLine, bpText, partnerHref, statementHref } from "./format";
import { VoidEntryButton } from "./entry-actions";

/**
 * Commission entries as staff read them — the Review queue, a partner's Commissions tab and a
 * statement's drawer. Server-safe (the drawer draws it on the client too); the Void button is the
 * only client island in a row.
 *
 * The day an entry was earned is India's, whatever zone the console keeps — commission is counted in
 * India's months, as its statements are (src/lib/partners/statements.ts), so an entry dated here sits
 * in the month it reads. When staff voided one is on the console's clock, handed in by the caller:
 * `consoleClock()` on a server page, `useClock()` in the drawer.
 *
 * An entry worth a second look carries its reason as a chip; one refunded after the clawback window
 * says so (owner decision O3). Money is each entry's own currency; totals are one row per currency.
 */

const ENTRY_LINK = "font-medium text-text hover:text-brand hover:underline";

/** Only a PENDING entry can be voided: unattached, or on a statement still in draft (spec §5.9). */
function voidable(row: ConsoleCommissionRow): boolean {
  return row.status === "PENDING" && row.voided === null && (row.statement === null || row.statement.status === "DRAFT");
}

function FlagChips({ row }: { row: ConsoleCommissionRow }) {
  if (!row.flags.attribution && !row.flags.overMedian) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {row.flags.attribution && (
        <StatusPill tone="warning" title="This customer's attribution was flagged at signup (a conflict, or outside the partner's territories) and nobody has reviewed it yet.">
          Attribution flagged
        </StatusPill>
      )}
      {row.flags.overMedian && (
        <StatusPill tone="warning" title={`More than five times this partner's 90-day median in ${row.currency}.`}>
          Over 5× median
        </StatusPill>
      )}
    </span>
  );
}

function StatusCell({ row, clock }: { row: ConsoleCommissionRow; clock: Clock }) {
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <LabelPill map={COMMISSION_STATUS} value={row.status} />
      {row.clawbackNote && <span className="max-w-56 text-[11px] leading-4 whitespace-normal text-warning">{row.clawbackNote}</span>}
      {row.voided && (
        <span className="max-w-56 text-[11px] leading-4 whitespace-normal text-muted" title={row.voided.reason ?? undefined}>
          {`Voided ${clock.dayMonth(row.voided.at)} by ${row.voided.byName}`}
        </span>
      )}
    </span>
  );
}

function CustomerCell({ row }: { row: ConsoleCommissionRow }) {
  return (
    <>
      {row.customer ? (
        <span className="block">
          <Link href={`/workspaces/${encodeURIComponent(row.customer.slug)}`} className={ENTRY_LINK}>
            {row.customer.name}
          </Link>
          <span className="block font-mono text-[11px] text-subtle">{row.customer.slug}</span>
        </span>
      ) : (
        <span className="text-muted">—</span>
      )}
      <FlagChips row={row} />
    </>
  );
}

function KindCell({ row }: { row: ConsoleCommissionRow }) {
  const how = basisLine(row.basis, row.note);
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <span className="inline-flex items-center gap-1">
        <LabelPill map={COMMISSION_KIND} value={row.kind} />
        {row.reversal && <StatusPill tone="neutral">Reversal</StatusPill>}
      </span>
      {how && (
        <span className="max-w-60 truncate text-[11px] leading-4 text-muted" title={how}>
          {how}
        </span>
      )}
    </span>
  );
}

/** The day an entry was earned, India's, with its time there on hover. */
function EarnedDay({ at }: { at: Date }) {
  return (
    <time dateTime={at.toISOString()} title={`${indiaClock.dateTime(at)} (India time)`}>
      {indiaClock.date(at)}
    </time>
  );
}

function VoidCell({ row, caps }: { row: ConsoleCommissionRow; caps: Caps }) {
  if (!caps.partnerMoney || !voidable(row)) return null;
  const amount = formatMoney(row.amount, row.currency);
  return (
    <VoidEntryButton
      entry={{
        id: row.id,
        // Two entries can share an amount and a customer; the day tells their buttons apart.
        label: `${amount} ${row.customer ? `for ${row.customer.name}` : `(${row.partner.displayName})`}, earned ${indiaClock.date(row.earnedAt)}`,
        partner: row.partner.displayName,
        amount,
        customer: row.customer?.name ?? null,
        draftStatement: row.statement?.status === "DRAFT" ? row.statement.number : null,
        accrual: row.kind !== "ADJUSTMENT" && !row.reversal,
      }}
    />
  );
}

/**
 * `compact` is the drawer's narrow form: earned, customer, kind, commission, status and the void
 * button — the statement and the partner are the drawer's own.
 */
export function EntriesTable({
  rows,
  caps,
  showPartner,
  totals,
  compact = false,
  statementParams = {},
  clock,
}: {
  rows: ConsoleCommissionRow[];
  caps: Caps;
  showPartner: boolean;
  /** One footer row per currency; the list's own totals, not only the page's. */
  totals?: CurrencyTotal[];
  compact?: boolean;
  /** The filters a statement link should open the Statements list with. */
  statementParams?: Record<string, string>;
  /** The console's clock, for when an entry was voided. */
  clock: Clock;
}) {
  const actions = caps.partnerMoney && rows.some(voidable);
  if (compact) {
    return (
      <DataTable caption="Entries on this statement" minWidth={420}>
        <THead>
          <Th>Earned</Th>
          <Th>Customer</Th>
          <Th>Kind</Th>
          <Th numeric>Commission</Th>
          <Th>Status</Th>
          {actions && <Th srOnly>Actions</Th>}
        </THead>
        <TBody>
          {rows.map((row) => (
            <Tr key={row.id}>
              <Td muted nowrap>
                <EarnedDay at={row.earnedAt} />
              </Td>
              <Td>
                <CustomerCell row={row} />
              </Td>
              <Td>
                <KindCell row={row} />
              </Td>
              <Td numeric className="font-medium">
                {formatMoney(row.amount, row.currency)}
              </Td>
              <Td>
                <StatusCell row={row} clock={clock} />
              </Td>
              {actions && (
                <RowActionsCell>
                  <VoidCell row={row} caps={caps} />
                </RowActionsCell>
              )}
            </Tr>
          ))}
        </TBody>
      </DataTable>
    );
  }

  // Columns before "Commission", for the totals row's label.
  const lead = showPartner ? 7 : 6;
  return (
    <DataTable caption="Commission entries" stickyHeader minWidth={showPartner ? 1240 : 1120}>
      <THead>
        <Th>Earned</Th>
        {showPartner && <Th>Partner</Th>}
        <Th>Customer</Th>
        <Th>Invoice</Th>
        <Th>Kind</Th>
        <Th numeric>Base</Th>
        <Th numeric>Rate</Th>
        <Th numeric>Commission</Th>
        <Th>Status</Th>
        <Th>Statement</Th>
        {actions && <Th srOnly>Actions</Th>}
      </THead>
      <TBody>
        {rows.map((row) => {
          const adjustment = row.kind === "ADJUSTMENT";
          return (
            <Tr key={row.id} className={row.flags.attribution || row.flags.overMedian ? "bg-warning-bg/40" : undefined}>
              <Td muted nowrap>
                <EarnedDay at={row.earnedAt} />
              </Td>
              {showPartner && (
                <Td>
                  <Link href={partnerHref(row.partner.slug)} className={ENTRY_LINK}>
                    {row.partner.displayName}
                  </Link>
                </Td>
              )}
              <Td>
                <CustomerCell row={row} />
              </Td>
              <Td mono nowrap>
                {row.invoice?.number ?? <span className="text-muted">—</span>}
              </Td>
              <Td>
                <KindCell row={row} />
              </Td>
              <Td numeric muted>
                {adjustment || row.base === 0 ? "—" : formatMoney(row.base, row.currency)}
              </Td>
              <Td numeric muted>
                {adjustment ? "—" : bpText(row.rateBp)}
              </Td>
              <Td numeric className="font-medium">
                {formatMoney(row.amount, row.currency)}
              </Td>
              <Td>
                <StatusCell row={row} clock={clock} />
              </Td>
              <Td nowrap>
                {row.statement ? (
                  <span className="inline-flex flex-col items-start gap-0.5">
                    <Link href={statementHref(row.statement.id, statementParams)} scroll={false} className="font-mono text-xs font-medium text-brand hover:underline">
                      {row.statement.number}
                    </Link>
                    <span className="text-[11px] leading-4 text-muted">{STATEMENT_STATUS[row.statement.status]?.label ?? row.statement.status}</span>
                  </span>
                ) : (
                  <span className="text-xs text-muted">Not yet</span>
                )}
              </Td>
              {actions && (
                <RowActionsCell>
                  <VoidCell row={row} caps={caps} />
                </RowActionsCell>
              )}
            </Tr>
          );
        })}
      </TBody>
      {totals && totals.length > 0 && (
        <TFoot>
          {totals.map((t) => (
            <tr key={t.currency}>
              <Td colSpan={lead}>
                {`Total in ${t.currency}`}
                <span className="ml-1.5 font-normal text-muted">{`· ${plural(t.count, "entry", "entries")}`}</span>
              </Td>
              <Td numeric>{formatMoney(t.amount, t.currency)}</Td>
              <Td colSpan={actions ? 3 : 2} />
            </tr>
          ))}
        </TFoot>
      )}
    </DataTable>
  );
}
