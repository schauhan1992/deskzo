import { listRebateProgrammes } from "@/actions/rebate";
import { listBrands } from "@/actions/brand";
import { listVendorOptions } from "@/actions/company";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SettingsPage } from "@/components/settings/settings-page";
import { RebateProgrammesManager } from "@/components/rebates/programmes-manager";

/**
 * The standing backend-rebate programmes (owner, 1 Oct 2026) — src/actions/rebate.ts. Each suggests a
 * rebate on the orders it applies to; the figure on an order is what counts. Seen with `rebates.view`
 * (the catalogue's gate), changed with `rebates.manage`.
 */
export default async function Page() {
  const [orders, items] = await Promise.all([isModuleEnabled("orders"), isModuleEnabled("items")]);
  if (!orders) return <ModuleDisabledNotice moduleKey="orders" />;
  // Without the Items module there are no brands to name — a programme then applies by distributor only.
  const [data, brands, vendors] = await Promise.all([listRebateProgrammes(), items ? listBrands() : [], listVendorOptions()]);
  return (
    <SettingsPage
      settingsKey="rebate-programmes"
      description="The rebates OEMs and distributors pay back on what you sell — a percentage of what you pay or of what you sell for, perhaps only through one distributor, perhaps only with an approved deal registration. When an order matches one, it is suggested as the order is punched; the figure on the order is what counts. Rebates never count toward targets or incentives."
    >
      <RebateProgrammesManager
        programmes={data?.programmes ?? []}
        canManage={data?.canManage ?? false}
        brands={brands.map((b) => ({ id: b.id, name: b.name }))}
        vendors={vendors.map((v) => ({ id: v.id, name: v.name }))}
      />
    </SettingsPage>
  );
}
