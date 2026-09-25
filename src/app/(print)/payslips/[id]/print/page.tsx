import { notFound } from "next/navigation";
import { getPayslip } from "@/actions/payroll";
import { getOrganisation, foreignCountry } from "@/lib/organisation";
import { PrintButton } from "@/components/documents/print-button";
import { formatCurrency, formatDate } from "@/lib/utils";
import { amountInWords } from "@/lib/gst-engine";
import { monthLabel } from "@/lib/hr/calendar";

/**
 * A payslip as a document.
 *
 * Numbers in a table are fine on screen and useless everywhere else — a payslip gets sent to a
 * landlord, a bank, or the next employer, and it has to be a page. Like the invoice printer it sits
 * beside, this ignores the app's theme entirely: a payslip is black on white because that is what
 * comes out of the printer.
 *
 * `getPayslip` does the access check — the person it belongs to, or somebody who runs payroll, and
 * never a draft to the employee. So a leaked URL is worth nothing to anybody else.
 */
export default async function PrintPayslipPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ embed?: string }>;
}) {
  const [{ id }, { embed }] = await Promise.all([params, searchParams]);
  const [slip, org] = await Promise.all([getPayslip(id), getOrganisation()]);
  if (!slip) notFound();

  const num = (v: unknown) => Number(v ?? 0);
  const profile = slip.user.employeeProfile;

  const earnings = [
    { label: "Basic", value: num(slip.basic) },
    { label: "House rent allowance", value: num(slip.hra) },
    { label: "Conveyance", value: num(slip.conveyance) },
    { label: "Medical", value: num(slip.medical) },
    { label: "Special allowance", value: num(slip.specialAllowance) },
    { label: "Other allowance", value: num(slip.otherAllowance) },
  ].filter((row) => row.value > 0);

  const deductions = [
    { label: "Provident fund", value: num(slip.pfEmployee) },
    { label: "ESI", value: num(slip.esiEmployee) },
    { label: "Professional tax", value: num(slip.professionalTax) },
    { label: "Income tax (TDS)", value: num(slip.incomeTax) },
    { label: slip.otherDeductionNote || "Other deduction", value: num(slip.otherDeduction) },
  ].filter((row) => row.value > 0);

  return (
    <div className="mx-auto max-w-3xl bg-white p-10 text-[13px] text-neutral-900 shadow-sm print:p-0 print:shadow-none">
      {embed !== "1" && (
        <div className="mb-6 flex justify-end print:hidden">
          <PrintButton />
        </div>
      )}

      <header className="border-b-2 border-neutral-800 pb-4">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-lg font-bold uppercase tracking-wide">{org.legalName || "—"}</h1>
            {org.addressLine1 && <p className="mt-0.5 text-xs text-neutral-600">{org.addressLine1}</p>}
            {(org.city || org.state) && (
              <p className="text-xs text-neutral-600">{[org.city, org.state, org.pincode, foreignCountry(org)].filter(Boolean).join(", ")}</p>
            )}
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-wide text-neutral-500">Payslip for</p>
            <p className="text-base font-semibold">{monthLabel(slip.run.month, slip.run.year)}</p>
          </div>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-x-8 gap-y-1 border-b border-neutral-300 py-4 text-xs">
        <Row label="Name" value={slip.user.name} strong />
        <Row label="Employee code" value={profile?.employeeCode ?? "—"} />
        <Row label="Designation" value={profile?.designation ?? "—"} />
        <Row label="Date of joining" value={profile?.joinedOn ? formatDate(profile.joinedOn) : "—"} />
        <Row label="PAN" value={profile?.panNumber ?? "—"} />
        <Row label="UAN" value={profile?.uanNumber ?? "—"} />
        <Row
          label="Bank account"
          value={
            profile?.bankAccountNumber
              ? `•••• ${profile.bankAccountNumber.slice(-4)}`
              : "—"
          }
        />
        <Row label="Paid days" value={`${num(slip.paidDays)} of ${num(slip.monthDays)}`} />
        {num(slip.lopDays) > 0 && <Row label="Loss of pay" value={`${num(slip.lopDays)} day(s)`} />}
      </section>

      <section className="grid grid-cols-2 gap-x-8 py-4">
        <div>
          <h2 className="border-b border-neutral-300 pb-1 text-xs font-bold uppercase tracking-wide">Earnings</h2>
          <table className="mt-2 w-full text-xs">
            <tbody>
              {earnings.map((row) => (
                <tr key={row.label}>
                  <td className="py-1 text-neutral-700">{row.label}</td>
                  <td className="py-1 text-right tabular-nums">{formatCurrency(row.value)}</td>
                </tr>
              ))}
              <tr className="border-t border-neutral-300 font-semibold">
                <td className="py-1.5">Gross earnings</td>
                <td className="py-1.5 text-right tabular-nums">{formatCurrency(num(slip.grossEarnings))}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div>
          <h2 className="border-b border-neutral-300 pb-1 text-xs font-bold uppercase tracking-wide">Deductions</h2>
          <table className="mt-2 w-full text-xs">
            <tbody>
              {deductions.length === 0 && (
                <tr>
                  <td className="py-1 text-neutral-500">None</td>
                  <td className="py-1 text-right tabular-nums">{formatCurrency(0)}</td>
                </tr>
              )}
              {deductions.map((row) => (
                <tr key={row.label}>
                  <td className="py-1 text-neutral-700">{row.label}</td>
                  <td className="py-1 text-right tabular-nums">{formatCurrency(row.value)}</td>
                </tr>
              ))}
              <tr className="border-t border-neutral-300 font-semibold">
                <td className="py-1.5">Total deductions</td>
                <td className="py-1.5 text-right tabular-nums">{formatCurrency(num(slip.totalDeductions))}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="border-y-2 border-neutral-800 py-3">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-bold uppercase tracking-wide">Net pay</span>
          <span className="text-lg font-bold tabular-nums">{formatCurrency(num(slip.netPay))}</span>
        </div>
        <p className="mt-1 text-xs text-neutral-600">{amountInWords(num(slip.netPay))}</p>
      </section>

      {num(slip.pfEmployer) + num(slip.esiEmployer) > 0 && (
        <section className="py-3 text-xs text-neutral-600">
          <p className="font-semibold uppercase tracking-wide">Employer contributions (not deducted from you)</p>
          <div className="mt-1 flex gap-6">
            {num(slip.pfEmployer) > 0 && <span>Provident fund {formatCurrency(num(slip.pfEmployer))}</span>}
            {num(slip.esiEmployer) > 0 && <span>ESI {formatCurrency(num(slip.esiEmployer))}</span>}
          </div>
        </section>
      )}

      <footer className="mt-6 border-t border-neutral-300 pt-3 text-[10px] text-neutral-500">
        <p>
          Computer generated — no signature required.
          {slip.run.paidAt && ` Paid ${formatDate(slip.run.paidAt)}.`}
        </p>
      </footer>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-neutral-500">{label}</span>
      <span className={`text-right ${strong ? "font-semibold" : ""}`}>{value}</span>
    </div>
  );
}
