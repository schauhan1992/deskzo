import Link from "next/link";
import { notFound } from "next/navigation";
import { viewerHas } from "@/actions/permission";
import { listDuplicates } from "@/actions/company-merge";
import { DuplicatesList } from "@/components/companies/duplicates-list";
import { ActionNotice } from "@/components/ui/action-notice";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";

export const metadata = { title: "Duplicate companies" };

/**
 * Companies that are probably one company entered twice — the same GSTIN or PAN, the same name once
 * Pvt, Ltd and the like are set aside, a near-identical name, or a shared email domain or phone.
 * See src/lib/companies/duplicates.ts.
 */
export default async function DuplicateCompaniesPage() {
  if (!(await isModuleEnabled("companies"))) return <ModuleDisabledNotice moduleKey="companies" />;
  if (!(await viewerHas("companies.merge"))) notFound();
  const result = await listDuplicates();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Duplicate companies</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Companies that look like one company entered twice. Review a pair to merge it — everything under the duplicate moves to the one you keep,
          and its old links open it — or mark it as not a duplicate and it won&apos;t be offered again.
        </p>
      </div>
      {!result.ok ? (
        <ActionNotice tone="error">{result.error}</ActionNotice>
      ) : (
        <>
          <p className="text-xs text-subtle">
            {result.data.rows.length === 0
              ? `Checked ${result.data.scanned} companies.`
              : `${result.data.rows.length}${result.data.rows.length === 300 ? "+" : ""} pair${result.data.rows.length === 1 ? "" : "s"} among ${result.data.scanned} companies, the likeliest first.`}{" "}
            Only companies of the same kind are compared.{" "}
            <Link href="/companies/merge" className="underline underline-offset-2">
              Merge two companies by hand
            </Link>
          </p>
          <DuplicatesList rows={result.data.rows} />
        </>
      )}
    </div>
  );
}
