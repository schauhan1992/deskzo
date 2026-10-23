import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { mayAccess } from "@/lib/authz/access";
import { parseRecordRef } from "@/lib/record-url";
import { getOrganisation } from "@/lib/organisation";
import { collectionConfig, msmeClaims } from "@/lib/collect/settings";
import { interestForCompany } from "@/lib/collect/msme";
import { companyPath } from "@/lib/record-links";
import { formatMoney } from "@/lib/currency";
import { formatCalendarDay } from "@/lib/time/zone";
import { workspaceClock } from "@/lib/time/workspace";
import { PrintButton } from "@/components/collect/print-button";

/**
 * A customer's late payments and the MSMED Act interest on them, set out for an MSME Samadhaan complaint
 * (owner, 23 Oct 2026 — src/lib/collect/msme.ts): who the supplier and buyer are, each late invoice, when it
 * should have been paid, what's unpaid and the interest. Printed from the browser. For whoever can see the
 * account's money, on an account they reach; anyone else is a 404.
 */
export default async function MsmeSummaryPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isModuleEnabled("receivables"))) return <ModuleDisabledNotice moduleKey="receivables" />;
  const user = await requireUser();
  const { id } = await params;
  const ref = parseRecordRef(id);
  const company = await db.company.findFirst({
    where: ref.kind === "seq" ? { companySeq: ref.seq } : { id: ref.id },
    select: { id: true, name: true, companySeq: true, locations: { orderBy: [{ isBilling: "desc" }, { createdAt: "asc" }], take: 1, select: { gstNumber: true, address: true, city: true, state: true } } },
  });
  if (!company || !(await can(user.id, "payments.view")) || !(await mayAccess(user.id, "companies", "view", company.id))) notFound();

  const [config, org, clock] = await Promise.all([collectionConfig(), getOrganisation(), workspaceClock()]);
  const claims = msmeClaims(config);
  const now = new Date();
  const rows = claims ? await interestForCompany(company.id, config.bankRate!, now, 36) : [];
  const unpaid = rows.reduce((t, r) => t + r.unpaid, 0);
  const interest = rows.reduce((t, r) => t + r.interest, 0);
  const buyer = company.locations[0];

  return (
    <div className="mx-auto max-w-4xl print:max-w-none">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`${companyPath(company.companySeq)}?tab=statement`} className="text-sm text-muted hover:text-text">
          ← {company.name}
        </Link>
        {rows.length > 0 && <PrintButton />}
      </div>
      <h1 className="mt-2 text-xl font-semibold text-text">Delayed payment under the MSMED Act, 2006</h1>
      <p className="mt-1 text-sm text-muted">As of {clock.date(now)} — for a complaint to the MSME Samadhaan portal (samadhaan.msme.gov.in) or the Facilitation Council.</p>

      {!claims ? (
        <p className="mt-6 text-sm text-muted">
          Interest is worked out once your Udyam number, category (micro or small) and the RBI bank rate are filled in, under Settings › Payment collection.
        </p>
      ) : (
        <>
          <div className="mt-6 grid gap-4 text-sm sm:grid-cols-2">
            <div className="rounded-base border border-line p-4">
              <div className="text-xs uppercase tracking-wide text-subtle">Supplier</div>
              <div className="mt-1 font-medium text-text">{org.legalName}</div>
              <div className="text-muted">Udyam {config.udyamNumber} · {config.msmeCategory === "MICRO" ? "Micro" : "Small"} enterprise</div>
              {org.gstin && <div className="text-muted">GSTIN {org.gstin}</div>}
            </div>
            <div className="rounded-base border border-line p-4">
              <div className="text-xs uppercase tracking-wide text-subtle">Buyer</div>
              <div className="mt-1 font-medium text-text">{company.name}</div>
              {buyer?.gstNumber && <div className="text-muted">GSTIN {buyer.gstNumber}</div>}
              {buyer && <div className="text-muted">{[buyer.address, buyer.city, buyer.state].filter(Boolean).join(", ")}</div>}
            </div>
          </div>

          {rows.length === 0 ? (
            <p className="mt-6 text-sm text-muted">No invoice to this customer in the last three years was paid late enough to run up interest.</p>
          ) : (
            <>
              <table className="mt-6 w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th className="py-2 pr-3 font-medium">Invoice</th>
                    <th className="py-2 pr-3 font-medium">Date</th>
                    <th className="py-2 pr-3 font-medium">Amount</th>
                    <th className="py-2 pr-3 font-medium">Last day to pay</th>
                    <th className="py-2 pr-3 font-medium">Days late</th>
                    <th className="py-2 pr-3 font-medium">Unpaid</th>
                    <th className="py-2 text-right font-medium">Interest</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.invoiceId} className="border-b border-line">
                      <td className="py-2 pr-3 text-text">{r.docNumber ?? "—"}</td>
                      <td className="whitespace-nowrap py-2 pr-3 text-muted">{formatCalendarDay(r.issueDate)}</td>
                      <td className="whitespace-nowrap py-2 pr-3 text-muted">{formatMoney(r.total, "INR")}</td>
                      <td className="whitespace-nowrap py-2 pr-3 text-muted">{formatCalendarDay(r.lastDay)}</td>
                      <td className="py-2 pr-3 text-muted">{r.days}</td>
                      <td className="whitespace-nowrap py-2 pr-3 text-text">{r.unpaid > 0 ? formatMoney(r.unpaid, "INR") : "Paid late"}</td>
                      <td className="whitespace-nowrap py-2 text-right text-text">{formatMoney(r.interest, "INR")}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-medium text-text">
                    <td className="py-2 pr-3" colSpan={5}>
                      Total
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3">{formatMoney(unpaid, "INR")}</td>
                    <td className="whitespace-nowrap py-2 text-right">{formatMoney(interest, "INR")}</td>
                  </tr>
                </tfoot>
              </table>
              <p className="mt-4 text-xs text-muted">
                Section 15 sets the last day to pay as the day agreed, at most 45 days after the invoice (15 days where nothing was agreed). Section 16 charges compound interest
                with monthly rests at three times the bank rate notified by the RBI — {rows[0]!.rate}% a year here, on a bank rate of {config.bankRate}% — from the day after, to the day
                the invoice was paid or to today. The invoice date stands in for the day of acceptance. Check the figures against your records before filing.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
