import Link from "next/link";
import { notFound } from "next/navigation";
import type { VoucherType } from "@prisma/client";
import { isModuleEnabled } from "@/actions/module";
import { voucherCapabilities, voucherFormOptions } from "@/actions/vouchers";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { VoucherForm } from "@/components/accounting/vouchers/voucher-form";

const TYPES: VoucherType[] = ["PAYMENT", "RECEIPT", "CONTRA", "JOURNAL"];

/** A new voucher, saved as a draft — `?type=RECEIPT` opens it on that kind. */
export default async function NewVoucherPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  if (!(await isModuleEnabled("accounting"))) return <ModuleDisabledNotice moduleKey="accounting" />;
  const caps = await voucherCapabilities();
  if (!caps.create || !caps.migrated) notFound();
  const options = await voucherFormOptions();
  if (!options) notFound();
  const params = await searchParams;
  const type = TYPES.find((t) => t === params.type);

  return (
    <div className="animate-fade-rise">
      <Link href="/accounting/vouchers" className="text-sm text-muted hover:text-text">
        ← Vouchers
      </Link>
      <h1 className="mt-1 text-xl font-semibold text-text">New voucher</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Saved as a draft and numbered as it&apos;s saved. Nothing reaches the books until it&apos;s
        {caps.approvalRequired ? " approved by somebody else and then" : ""} posted.
      </p>
      <div className="mt-5">
        <VoucherForm options={options} initialType={type} />
      </div>
    </div>
  );
}
