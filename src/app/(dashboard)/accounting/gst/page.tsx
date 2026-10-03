import { AlertTriangle } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { gstr1, gstr3b, listReturnRegistrations } from "@/actions/tax-reports";
import { getOrganisation } from "@/lib/organisation";
import { GST_STATE_CODES } from "@/lib/gst-engine";
import type { RegistrationChoice } from "@/lib/branches/format";
import { Badge, Card } from "@/components/ui/card";
import { Amount, ReportHeader } from "@/components/accounting/report-chrome";
import { MonthPicker } from "@/components/accounting/month-picker";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { monthName } from "@/lib/ledger/period";
import { formatCurrency } from "@/lib/utils";
import { previousIstMonth } from "@/lib/india-time";
import { formatCalendarDay, indiaClock } from "@/lib/time/zone";

/** Money to the paisa, so a sum of three heads can't show a floating-point tail. */
const round2 = (n: number) => Math.round(n * 100) / 100;

/** "27AAPFU0939F1ZV · Maharashtra" — the GSTIN is what a return is filed under, the state is how people tell them apart. */
function registrationLabel(r: RegistrationChoice) {
  const state = GST_STATE_CODES[r.stateCode] ?? r.stateCode;
  return `${r.gstin} · ${state}${r.active ? "" : " (inactive)"}`;
}

/**
 * The two monthly GST returns.
 *
 * Both are built from the documents already in the system rather than stored, so there is one
 * version of the truth. The thing worth looking at first is the comparison against the ledger on
 * 3B — a return that the books can't support is what a departmental audit looks for.
 */
export default async function GstPage({
  searchParams,
}: {
  /** `gstin` is a registration's id, not the GSTIN itself — the link names the registration, which keeps its id when its code changes. */
  searchParams: Promise<{ month?: string; year?: string; view?: string; gstin?: string }>;
}) {
  const enabled = await isModuleEnabled("accounting");
  if (!enabled) return <ModuleDisabledNotice moduleKey="accounting" />;

  const params = await searchParams;
  const now = new Date();
  // Defaults to last month, because that is the one being filed.
  // India's last month (india-time `previousIstMonth`): the host's, on a server in UTC, was still the
  // month before that until 05:30 IST on the 1st.
  const previous = previousIstMonth(now);
  const month = Number(params.month) || previous.month;
  const year = Number(params.year) || previous.year;
  // Absent means the head office's registration — the returns fall back to it themselves (spec §8.4).
  const gstRegistrationId = params.gstin || undefined;

  const [one, threeB, org, registrations] = await Promise.all([
    gstr1({ month, year, gstRegistrationId }),
    gstr3b({ month, year, gstRegistrationId }),
    getOrganisation(),
    listReturnRegistrations(),
  ]);

  if (!one || !threeB) {
    return (
      <Card className="px-6 py-10 text-center text-sm text-muted">
        GST returns sit behind the same permission as payments and the ledger.
      </Card>
    );
  }

  // The 11th of the month after: a calendar day, built and shown as the day itself.
  const filingDue = new Date(Date.UTC(year, month, 11));
  const unsupported = threeB.discrepancies.filter((d) => d.direction === "UNSUPPORTED");
  const underClaimed = threeB.discrepancies.filter((d) => d.direction === "UNDER_CLAIMED");
  const otherCredit = round2(
    threeB.inward.fromOther.cgst + threeB.inward.fromOther.sgst + threeB.inward.fromOther.igst,
  );

  /**
   * The picker's blank option is the registration the returns fall back to with no `gstin` in the
   * link (the head office's, else the first), and the rest are listed after it — so the default is
   * never offered twice, and choosing it again drops the parameter rather than pinning an id.
   */
  const fallback = registrations.find((r) => r.isHeadOffice) ?? registrations[0];
  const others = registrations.filter((r) => r.id !== fallback?.id);

  return (
    <div className="animate-fade-rise">
      <ReportHeader
        title="GST returns"
        subtitle={`${monthName(month)} ${year} · GSTR-1 due ${formatCalendarDay(filingDue)}, GSTR-3B by the 20th`}
        // The GSTIN these figures are for, from the return itself — not the organisation's, which is
        // only the head office's and says nothing about the registration picked here.
        organisation={`${org.legalName}${one.registration ? ` · GSTIN ${one.registration.gstin}` : ""}`}
      >
        {/* A return is filed per GSTIN; with one registration (or none) there is nothing to choose. */}
        {fallback && others.length > 0 ? (
          <div className="flex flex-wrap items-end gap-3">
            <SelectParamFilter
              paramName="gstin"
              label="GST registration"
              allLabel={registrationLabel(fallback)}
              options={others.map((r) => ({ value: r.id, label: registrationLabel(r) }))}
            />
            <MonthPicker month={month} year={year} />
          </div>
        ) : (
          <MonthPicker month={month} year={year} />
        )}
      </ReportHeader>

      {!one.registration && (
        <Card className="mt-4 border-warning/40 bg-warning-bg px-4 py-2.5 text-sm text-warning">
          No GST registration yet. Add your GSTIN under Settings → Organisation (head office) or Settings → Branches
          &amp; GST registrations — these returns are filed against it.
        </Card>
      )}

      {/* Two directions, opposite meanings. Telling somebody to worry about under-claiming — or to
          shrug at an unsupported figure — is worse than saying nothing. */}
      {unsupported.length > 0 && (
        <Card className="mt-4 border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">
          <p className="font-medium">The output tax here is more than the books can support.</p>
          <p className="mt-1">
            This is the direction that matters. An invoice has been raised that never posted, or a journal has
            reversed something it shouldn&apos;t. Find it before filing — a figure nothing backs is exactly what gets
            picked up later.
          </p>
          <ul className="mt-2 space-y-1">
            {unsupported.map((disc) => (
              <li key={disc.label} className="tabular-nums">
                {disc.label}: this return says {formatCurrency(disc.fromDocuments)}, the ledger holds{" "}
                {formatCurrency(disc.fromLedger)} — short by {formatCurrency(Math.abs(disc.difference))}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {underClaimed.length > 0 && (
        <Card className="mt-4 border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
          <p className="font-medium">The ledger holds output tax these documents don&apos;t show.</p>
          <p className="mt-1">
            Usually an entry posted by hand to a GST account. Nobody will chase you for it, but the return understates
            what was collected — check it before filing.
          </p>
          <ul className="mt-2 space-y-1">
            {underClaimed.map((disc) => (
              <li key={disc.label} className="tabular-nums">
                {disc.label}: this return says {formatCurrency(disc.fromDocuments)}, the ledger holds{" "}
                {formatCurrency(disc.fromLedger)}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {threeB.discrepancies.length === 0 && (
        <Card className="mt-4 border-success/40 bg-success-bg px-4 py-2.5 text-sm text-success">
          Output tax on this return matches the ledger on every head.
        </Card>
      )}

      {/* Credit that came from somewhere other than a vendor bill. Not a problem — it is money that
          would be left behind by a return built from the Bills list alone. */}
      {otherCredit > 0 && (
        <Card className="mt-4 px-4 py-3 text-sm text-muted">
          <p>
            <span className="font-medium text-text">{formatCurrency(otherCredit)}</span> of the credit below came from
            expense claims rather than vendor bills — an employee&apos;s hotel bill carries as much input credit as a
            distributor&apos;s invoice. It is included in what&apos;s payable.
          </p>
          <p className="mt-1 text-xs text-subtle">
            Claims record what was paid, not where it was supplied from, so this is split evenly between CGST and
            SGST. If any of it was an interstate supply, reclassify it with a journal before filing.
          </p>
        </Card>
      )}

      {one.problems.length > 0 && (
        <Card className="mt-4 border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-3.5 w-3.5" />
            {one.problems.length} thing(s) the portal will reject
          </p>
          <ul className="mt-2 space-y-1">
            {one.problems.slice(0, 8).map((p, i) => (
              <li key={`${p.docNumber}-${i}`}>
                <span className="font-mono text-xs">{p.docNumber}</span> — {p.issue}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* ── GSTR-3B ─────────────────────────────────────────────────────── */}
      <h2 className="mt-6 text-sm font-medium text-text">GSTR-3B — what&apos;s payable</h2>
      <p className="mt-0.5 text-xs text-muted">
        Output tax less the credit claimed. Each head is netted on its own, because a credit under one head
        can&apos;t simply be set against a liability under another.
      </p>

      <Card className="mt-3 overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">&nbsp;</th>
              <th className="px-4 py-2.5 text-right">Taxable value</th>
              <th className="px-4 py-2.5 text-right">CGST</th>
              <th className="px-4 py-2.5 text-right">SGST</th>
              <th className="px-4 py-2.5 text-right">IGST</th>
            </tr>
          </thead>
          <tbody>
            <TaxRow label="Outward supplies" hint="What we sold" row={threeB.outward} />
            <TaxRow
              label="Credit — vendor bills"
              hint="Bills raised against a vendor in the system"
              row={{ taxableValue: threeB.inward.taxableValue, ...threeB.inward.fromBills }}
            />
            {otherCredit > 0 && (
              <TaxRow
                label="Credit — expense claims"
                hint="Tax paid on approved claims, equally claimable"
                row={{ taxableValue: 0, ...threeB.inward.fromOther }}
              />
            )}
            <TaxRow label="Total credit claimed" hint="What reduces the liability" row={threeB.inward} />
            <tr className="border-t-2 border-line-strong bg-surface-sunken">
              <td className="px-4 py-2.5 font-semibold text-text">Payable</td>
              <td className="px-4 py-2.5" />
              <td className="px-4 py-2.5 text-right">
                <Amount value={threeB.netPayable.cgst} bold />
              </td>
              <td className="px-4 py-2.5 text-right">
                <Amount value={threeB.netPayable.sgst} bold />
              </td>
              <td className="px-4 py-2.5 text-right">
                <Amount value={threeB.netPayable.igst} bold />
              </td>
            </tr>
          </tbody>
        </table>
      </Card>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Total payable in cash</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-text">
            {formatCurrency(threeB.netPayable.total)}
          </div>
          <div className="mt-0.5 text-xs text-muted">Due by the 20th of {monthName(month === 12 ? 1 : month + 1)}.</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Credit carried forward</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-text">
            {formatCurrency(
              threeB.carriedForward.cgst + threeB.carriedForward.sgst + threeB.carriedForward.igst,
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted">
            More credit than liability isn&apos;t a refund — it carries into next month.
          </div>
        </Card>
      </div>

      {/* ── GSTR-1 ──────────────────────────────────────────────────────── */}
      <h2 className="mt-6 text-sm font-medium text-text">GSTR-1 — what was supplied</h2>
      <p className="mt-0.5 text-xs text-muted">
        B2B is listed invoice by invoice because your customer&apos;s input credit is matched against it. B2C is
        reported as totals only.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="B2B taxable" value={one.totals.b2bTaxable} hint={`${one.b2b.length} invoice line(s)`} />
        <Stat label="B2C taxable" value={one.totals.b2cTaxable} hint={`${one.b2c.length} rate/place group(s)`} />
        <Stat label="Total tax" value={one.totals.cgst + one.totals.sgst + one.totals.igst} hint="CGST + SGST + IGST" />
        <Stat
          label="Documents"
          value={null}
          hint={`${one.totals.invoiceCount} invoice(s), ${one.totals.creditNoteCount} credit note(s)`}
        />
      </div>

      <Card className="mt-3 overflow-hidden p-0">
        <div className="border-b border-line px-4 py-2.5 text-sm font-medium text-text">B2B — registered customers</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5">GSTIN</th>
                <th className="px-4 py-2.5">Customer</th>
                <th className="px-4 py-2.5">Document</th>
                <th className="px-4 py-2.5">Date</th>
                <th className="px-4 py-2.5">POS</th>
                <th className="px-4 py-2.5 text-right">Taxable</th>
                <th className="px-4 py-2.5 text-right">CGST</th>
                <th className="px-4 py-2.5 text-right">SGST</th>
                <th className="px-4 py-2.5 text-right">IGST</th>
                <th className="px-4 py-2.5 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {one.b2b.map((inv) => (
                <tr key={inv.docNumber} className="border-b border-line last:border-0">
                  <td className="px-4 py-2 font-mono text-xs text-muted">{inv.gstin}</td>
                  <td className="px-4 py-2 text-text">{inv.partyName}</td>
                  <td className="px-4 py-2">
                    <span className="font-mono text-xs text-muted">{inv.docNumber}</span>
                    {inv.isCreditNote && (
                      <Badge tone="amber" className="ml-1.5">
                        CN
                      </Badge>
                    )}
                  </td>
                  {/* The day the return reports it on: India's, in every workspace. */}
                  <td className="px-4 py-2 text-muted">{indiaClock.date(inv.issueDate)}</td>
                  <td className="px-4 py-2 text-muted">{inv.placeOfSupplyCode ?? "—"}</td>
                  <td className="px-4 py-2 text-right">
                    <Amount value={inv.taxableValue} />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Amount value={inv.cgstAmount} muted />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Amount value={inv.sgstAmount} muted />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Amount value={inv.igstAmount} muted />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Amount value={inv.total} bold />
                  </td>
                </tr>
              ))}
              {one.b2b.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-subtle">
                    No B2B supplies this month.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {one.b2c.length > 0 && (
        <Card className="mt-3 overflow-hidden p-0">
          <div className="border-b border-line px-4 py-2.5 text-sm font-medium text-text">
            B2C — unregistered customers, as totals
          </div>
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5">Place of supply</th>
                <th className="px-4 py-2.5 text-right">Rate</th>
                <th className="px-4 py-2.5 text-right">Taxable</th>
                <th className="px-4 py-2.5 text-right">CGST</th>
                <th className="px-4 py-2.5 text-right">SGST</th>
                <th className="px-4 py-2.5 text-right">IGST</th>
              </tr>
            </thead>
            <tbody>
              {one.b2c.map((row, i) => (
                <tr key={`${row.placeOfSupplyCode}-${row.taxRatePercent}-${i}`} className="border-b border-line last:border-0">
                  <td className="px-4 py-2 text-muted">{row.placeOfSupplyCode ?? "—"}</td>
                  <td className="px-4 py-2 text-right text-muted">{row.taxRatePercent}%</td>
                  <td className="px-4 py-2 text-right">
                    <Amount value={row.taxableValue} />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Amount value={row.cgstAmount} muted />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Amount value={row.sgstAmount} muted />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Amount value={row.igstAmount} muted />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card className="mt-3 overflow-hidden p-0">
        <div className="border-b border-line px-4 py-2.5 text-sm font-medium text-text">HSN summary</div>
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">HSN / SAC</th>
              <th className="px-4 py-2.5">Description</th>
              <th className="px-4 py-2.5 text-right">Qty</th>
              <th className="px-4 py-2.5 text-right">Taxable</th>
              <th className="px-4 py-2.5 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {one.hsn.map((row) => (
              <tr key={row.hsnCode} className="border-b border-line last:border-0">
                <td className="px-4 py-2 font-mono text-xs text-muted">
                  {row.hsnCode === "(none)" ? <span className="text-danger">missing</span> : row.hsnCode}
                </td>
                <td className="px-4 py-2 text-text">{row.description}</td>
                <td className="px-4 py-2 text-right tabular-nums text-muted">
                  {row.quantity} {row.unit ?? ""}
                </td>
                <td className="px-4 py-2 text-right">
                  <Amount value={row.taxableValue} />
                </td>
                <td className="px-4 py-2 text-right">
                  <Amount value={row.total} bold />
                </td>
              </tr>
            ))}
            {one.hsn.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-subtle">
                  Nothing supplied this month.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function TaxRow({
  label,
  hint,
  row,
}: {
  label: string;
  hint: string;
  row: { taxableValue: number; cgst: number; sgst: number; igst: number };
}) {
  return (
    <tr className="border-b border-line">
      <td className="px-4 py-2.5">
        <span className="text-text">{label}</span>
        <span className="block text-xs text-subtle">{hint}</span>
      </td>
      <td className="px-4 py-2.5 text-right">
        <Amount value={row.taxableValue} />
      </td>
      <td className="px-4 py-2.5 text-right">
        <Amount value={row.cgst} />
      </td>
      <td className="px-4 py-2.5 text-right">
        <Amount value={row.sgst} />
      </td>
      <td className="px-4 py-2.5 text-right">
        <Amount value={row.igst} />
      </td>
    </tr>
  );
}

function Stat({ label, value, hint }: { label: string; value: number | null; hint: string }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      {value !== null && <div className="mt-1 text-xl font-semibold tabular-nums text-text">{formatCurrency(value)}</div>}
      <div className={`text-xs text-muted ${value === null ? "mt-2 text-sm text-text" : "mt-0.5"}`}>{hint}</div>
    </Card>
  );
}
