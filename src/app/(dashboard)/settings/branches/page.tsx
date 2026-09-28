import { listBranchesForSettings, type BranchSettings } from "@/actions/branch";
import { SettingsPage } from "@/components/settings/settings-page";
import { BranchesManager } from "@/components/settings/branches-manager";
import { db } from "@/lib/db";
import { GST_NUMBERED_TYPES } from "@/lib/document-numbering";
import { isModuleEntitled } from "@/lib/modules-access";

/** How the numbering advice names the GST-numbered types. */
const PLURAL: Record<string, string> = { INVOICE: "invoices", CREDIT_NOTE: "credit notes", DELIVERY_CHALLAN: "delivery challans" };

/**
 * The GST-numbered types still counted in one series for the whole company, once there is more than
 * one active GSTIN — empty otherwise, and empty without a plan that issues them.
 *
 * Advice only (owner decision Q6): a second GSTIN never switches a type's series by itself. Whether
 * one company-wide series is acceptable across GSTINs is CA question C1; the recommendation is one
 * series per GSTIN.
 */
async function companyWideGstSeries(data: BranchSettings): Promise<string[]> {
  if (data.registrations.filter((r) => r.active).length < 2) return [];
  const [sales, purchases] = await Promise.all([isModuleEntitled("sales_documents"), isModuleEntitled("purchase_documents")]);
  if (!sales && !purchases) return [];
  const rows = await db.documentNumberSetting.findMany({
    where: { docType: { in: [...GST_NUMBERED_TYPES] } },
    select: { docType: true, scope: true },
  });
  // No row yet is the default, which is the company's series.
  return GST_NUMBERED_TYPES.filter((type) => (rows.find((r) => r.docType === type)?.scope ?? "COMPANY") === "COMPANY").map(
    (type) => PLURAL[type] ?? type,
  );
}

export default async function Page() {
  // Null without settings.manage — SettingsPage then says so, and there is nothing to hand the manager.
  const data = await listBranchesForSettings();
  const companyWide = data ? await companyWideGstSeries(data) : [];

  return (
    <SettingsPage
      title="Branches & GST registrations"
      description="One company, one PAN, one set of books — with a GST registration in each state you supply from, and as many branches under each as you have. Every document is raised from a branch, and prints its GSTIN, address and bank."
      settingsKey="branches"
    >
      {data && <BranchesManager data={data} companyWideGstSeries={companyWide} />}
    </SettingsPage>
  );
}
