import { listOrderStepsForManage, listPipelineForManage } from "@/actions/pipeline";
import { SettingsPage } from "@/components/settings/settings-page";
import { PipelineManager } from "@/components/settings/pipeline-manager";
import { OrderStepsManager } from "@/components/settings/order-steps-manager";
import { moduleAvailableForTenant } from "@/lib/modules-access";

/**
 * Settings → Pipeline (owner, 2 Oct 2026) — src/actions/pipeline.ts, src/lib/pipeline. The stages the
 * workspace's leads move through, and — where Orders is in the plan — its own steps within an order's
 * statuses. `pipeline.manage` (the catalogue's gate) opens it.
 */
export default async function Page() {
  const [leads, ordersHere] = await Promise.all([listPipelineForManage(), moduleAvailableForTenant("orders")]);
  const orders = ordersHere ? await listOrderStepsForManage() : null;
  return (
    <SettingsPage
      settingsKey="pipeline"
      description="The stages your leads move through, in your own words — Enquiry, Site visit, Quotation, Booked. Each counts as one of a fixed set of meanings, and that is what the rest of the app acts on: won leads count towards targets, the forecast weighs open ones by how far along they are. Retiring a stage moves its leads on first; nothing about a lead's history is lost."
    >
      <div className="space-y-8">
        <section className="space-y-3" aria-labelledby="pipeline-leads">
          <h2 id="pipeline-leads" className="text-base font-semibold text-text">
            Leads
          </h2>
          <PipelineManager stages={leads?.stages ?? []} stored={leads?.stored ?? false} />
        </section>
        {orders && (
          <section className="space-y-3" aria-labelledby="pipeline-orders">
            <div>
              <h2 id="pipeline-orders" className="text-base font-semibold text-text">
                Orders
              </h2>
              <p className="mt-1 text-sm text-muted">
                An order&apos;s statuses stay as they are — approval, purchase, fulfilment. Within each, add the steps your work goes through — material ordered,
                installed, handed over — and move each order along them from its page.
              </p>
            </div>
            <OrderStepsManager steps={orders.steps} stored={orders.stored} />
          </section>
        )}
      </div>
    </SettingsPage>
  );
}
