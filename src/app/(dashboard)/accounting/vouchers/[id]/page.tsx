import Link from "next/link";
import { notFound } from "next/navigation";
import { currentUser } from "@/lib/session";
import { isModuleEnabled } from "@/actions/module";
import { getVoucher, voucherCapabilities } from "@/actions/vouchers";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Badge, Card } from "@/components/ui/card";
import { Amount } from "@/components/accounting/report-chrome";
import { VoucherActions } from "@/components/accounting/vouchers/voucher-actions";
import { voucherStatusLabels, voucherStatusTone, voucherTypeLabels } from "@/lib/accounts/vouchers";
import { formatCalendarDay } from "@/lib/time/zone";
import { workspaceClock } from "@/lib/time/workspace";
import { companyPath } from "@/lib/record-links";

/**
 * One voucher: its lines, who wrote, approved, posted, cancelled or reversed it and when, the journal
 * entries it made, and what can be done next.
 */
export default async function VoucherPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isModuleEnabled("accounting"))) return <ModuleDisabledNotice moduleKey="accounting" />;
  const caps = await voucherCapabilities();
  if (!caps.read) notFound();
  const { id } = await params;
  const [voucher, viewer, clock] = await Promise.all([getVoucher(id), currentUser(), workspaceClock()]);
  if (!voucher) notFound();

  const totals = voucher.lines.reduce((t, l) => ({ debit: t.debit + Math.round(l.debit * 100), credit: t.credit + Math.round(l.credit * 100) }), { debit: 0, credit: 0 });
  const showDepartment = voucher.lines.some((l) => l.department);
  const showBranch = voucher.lines.some((l) => l.branch);
  const history = [
    { label: "Written", by: voucher.createdBy.name, at: voucher.createdAt },
    voucher.submittedAt && { label: "Sent for approval", by: voucher.submittedBy, at: voucher.submittedAt },
    voucher.approvedAt && { label: "Approved", by: voucher.approvedBy, at: voucher.approvedAt },
    voucher.postedAt && { label: "Posted", by: voucher.postedBy, at: voucher.postedAt },
    voucher.cancelledAt && { label: "Cancelled", by: voucher.cancelledBy, at: voucher.cancelledAt, note: voucher.cancelReason },
    voucher.reversedAt && { label: "Reversed", by: voucher.reversedBy, at: voucher.reversedAt, note: voucher.cancelReason },
  ].filter((h): h is { label: string; by: string | null; at: Date; note?: string | null } => !!h);

  return (
    <div className="animate-fade-rise">
      <Link href="/accounting/vouchers" className="text-sm text-muted hover:text-text">
        ← Vouchers
      </Link>
      <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-text">
              {voucherTypeLabels[voucher.type]} voucher <span className="font-mono">{voucher.number}</span>
            </h1>
            <Badge tone={voucherStatusTone[voucher.status]}>{voucherStatusLabels[voucher.status]}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted">{voucher.narration}</p>
        </div>
        <VoucherActions
          id={voucher.id}
          number={voucher.number}
          status={voucher.status}
          can={{ create: caps.create, approve: caps.approve, post: caps.post }}
          approvalRequired={caps.approvalRequired}
          isCreator={viewer?.id === voucher.createdById}
          copySource={{
            type: voucher.type,
            narration: voucher.narration,
            reference: voucher.reference ?? "",
            company: voucher.company ? { id: voucher.company.id, name: voucher.company.name } : null,
            lines: voucher.lines.map((l) => ({
              accountId: l.accountId,
              debit: l.debit,
              credit: l.credit,
              company: l.company,
              departmentId: l.departmentId,
              branchId: l.branchId,
              narration: l.narration,
            })),
          }}
        />
      </div>

      <Card className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 px-5 py-4 text-sm sm:grid-cols-3 lg:grid-cols-5">
        <div>
          <div className="text-xs uppercase tracking-wide text-subtle">Date</div>
          <div className="mt-0.5 text-text">{formatCalendarDay(voucher.date)}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-subtle">Amount</div>
          <div className="mt-0.5 font-semibold">
            <Amount value={voucher.amount} bold />
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-subtle">Bank / cash</div>
          <div className="mt-0.5 text-text">{voucher.moneyAccount?.name ?? "—"}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-subtle">Party</div>
          <div className="mt-0.5 text-text">
            {voucher.company ? (
              <Link href={companyPath(voucher.company.companySeq)} className="hover:underline">
                {voucher.company.name}
              </Link>
            ) : (
              "—"
            )}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-subtle">Reference</div>
          <div className="mt-0.5 text-text">{voucher.reference ?? "—"}</div>
        </div>
      </Card>

      <Card className="mt-4 overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Account</th>
              <th className="px-4 py-2.5">Party</th>
              {showDepartment && <th className="px-4 py-2.5">Cost centre</th>}
              {showBranch && <th className="px-4 py-2.5">Branch</th>}
              <th className="px-4 py-2.5 text-right">Debit</th>
              <th className="px-4 py-2.5 text-right">Credit</th>
            </tr>
          </thead>
          <tbody>
            {voucher.lines.map((l) => (
              <tr key={l.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2">
                  <Link href={`/accounting/ledger/${l.account.id}`} className="text-text hover:underline">
                    <span className="mr-2 font-mono text-xs text-subtle">{l.account.code}</span>
                    {l.account.name}
                  </Link>
                  {l.narration && <span className="block text-xs text-subtle">{l.narration}</span>}
                </td>
                <td className="px-4 py-2 text-muted">{l.company?.name ?? "—"}</td>
                {showDepartment && <td className="px-4 py-2 text-muted">{l.department?.name ?? "—"}</td>}
                {showBranch && <td className="px-4 py-2 text-muted">{l.branch?.name ?? "—"}</td>}
                <td className="px-4 py-2 text-right">
                  <Amount value={l.debit} />
                </td>
                <td className="px-4 py-2 text-right">
                  <Amount value={l.credit} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line-strong">
              <td className="px-4 py-2.5 font-semibold text-text" colSpan={2 + (showDepartment ? 1 : 0) + (showBranch ? 1 : 0)}>
                Total
              </td>
              <td className="px-4 py-2.5 text-right">
                <Amount value={totals.debit / 100} bold />
              </td>
              <td className="px-4 py-2.5 text-right">
                <Amount value={totals.credit / 100} bold />
              </td>
            </tr>
          </tfoot>
        </table>
      </Card>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="px-5 py-4">
          <h2 className="text-sm font-semibold text-text">History</h2>
          <ol className="mt-3 space-y-2.5 text-sm">
            {history.map((h) => (
              <li key={h.label} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-text">{h.label}</span>
                <span className="text-muted">
                  {h.by ? `by ${h.by}, ` : ""}
                  {clock.dateTimeShort(h.at)}
                </span>
                {h.note && <span className="w-full text-xs text-subtle">“{h.note}”</span>}
              </li>
            ))}
          </ol>
        </Card>
        <Card className="px-5 py-4">
          <h2 className="text-sm font-semibold text-text">In the books</h2>
          {voucher.journalEntries.length === 0 ? (
            <p className="mt-3 text-sm text-muted">Nothing yet — a voucher reaches the books when it&apos;s posted.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {voucher.journalEntries.map((e) => (
                <li key={e.id} className="flex flex-wrap items-baseline gap-x-2">
                  <Link href={`/accounting/journal?q=${encodeURIComponent(e.entryNumber)}`} className="font-mono text-xs text-brand hover:underline">
                    {e.entryNumber}
                  </Link>
                  <span className="text-muted">
                    {e.reversesId ? "the reversal" : "the voucher"}, dated {formatCalendarDay(e.date)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
