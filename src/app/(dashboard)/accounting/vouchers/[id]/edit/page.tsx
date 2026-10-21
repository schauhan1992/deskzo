import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { getVoucher, voucherCapabilities, voucherFormOptions } from "@/actions/vouchers";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { VoucherForm } from "@/components/accounting/vouchers/voucher-form";

/** A draft voucher, rewritten. Anything past draft is changed by sending it back, or reversed once posted. */
export default async function EditVoucherPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isModuleEnabled("accounting"))) return <ModuleDisabledNotice moduleKey="accounting" />;
  const caps = await voucherCapabilities();
  if (!caps.create) notFound();
  const { id } = await params;
  const [voucher, options] = await Promise.all([getVoucher(id), voucherFormOptions()]);
  if (!voucher || !options) notFound();
  if (voucher.status !== "DRAFT") redirect(`/accounting/vouchers/${id}`);

  return (
    <div className="animate-fade-rise">
      <Link href={`/accounting/vouchers/${id}`} className="text-sm text-muted hover:text-text">
        ← {voucher.number}
      </Link>
      <h1 className="mt-1 text-xl font-semibold text-text">Edit voucher {voucher.number}</h1>
      <div className="mt-5">
        <VoucherForm
          options={options}
          initial={{
            id: voucher.id,
            number: voucher.number,
            type: voucher.type,
            date: voucher.date.toISOString().slice(0, 10),
            narration: voucher.narration,
            reference: voucher.reference ?? "",
            company: voucher.company,
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
    </div>
  );
}
