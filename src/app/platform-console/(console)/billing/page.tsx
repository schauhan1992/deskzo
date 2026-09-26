import Link from "next/link";
import { BillingSettingsForm, GatewayKeysForm } from "@/components/console/billing-forms";
import { Cell, DataTable, PageTitle, Section, when } from "@/components/console/console-ui";
import { formatMoney } from "@/lib/billing/money";
import { consoleStaff, isOwner } from "@/lib/platform/console-page";
import { billingOverview } from "@/lib/platform/console-data";

/**
 * The platform's billing: the gateways' keys (typed in here, never shown back), where their webhooks
 * go, open signup and the trial, and what the gateways have said lately (src/lib/billing).
 */
export default async function ConsoleBillingPage() {
  const staff = await consoleStaff(["OWNER", "ADMIN", "BILLING"]);
  const data = await billingOverview();
  const owner = isOwner(staff);
  return (
    <>
      <PageTitle title="Billing">
        Workspaces in India pay through Razorpay in rupees; everywhere else through Stripe. Prices are set per plan, under Plans.
        {data.failing > 0 && ` ${data.failing} webhook(s) failed and are waiting for the gateway to send them again.`}
      </PageTitle>

      <Section title="Gateways">
        <GatewayKeysForm set={data.secrets} editable={owner} />
        <div className="mt-4 space-y-1 text-xs text-muted">
          <p>Set these as the webhook addresses in each gateway&apos;s dashboard, with the signing secret above:</p>
          <p>
            Stripe: <code className="font-mono text-text">{data.webhooks.stripe}</code> — checkout.session.completed, customer.subscription.*, invoice.*
          </p>
          <p>
            Razorpay: <code className="font-mono text-text">{data.webhooks.razorpay}</code> — subscription.*
          </p>
          <p>
            And a scheduler calls <code className="font-mono text-text">{data.webhooks.tick}</code> every hour with <code className="font-mono">Authorization: Bearer $PLATFORM_TICK_SECRET</code>.
          </p>
        </div>
      </Section>

      <Section title="Signup and trials">
        <BillingSettingsForm signupOpen={data.signupOpen} trialDays={data.trialDays} autoDeprovision={data.autoDeprovision} editable={owner} />
      </Section>

      <Section title="What the gateways said">
        <DataTable head={["When", "Gateway", "Event", "Workspace", "Outcome"]} empty="Nothing received yet.">
          {data.events.map((e) => (
            <tr key={e.id}>
              <Cell className="whitespace-nowrap text-muted">{when(e.receivedAt)}</Cell>
              <Cell>{e.gateway.toLowerCase()}</Cell>
              <Cell className="font-mono text-xs">{e.type}</Cell>
              <Cell className="font-mono text-xs text-muted">{e.tenantId?.slice(0, 8) ?? "—"}</Cell>
              <Cell>{e.processedAt ? "processed" : e.error ? <span className="text-danger">{e.error.slice(0, 120)}</span> : "waiting"}</Cell>
            </tr>
          ))}
        </DataTable>
      </Section>

      <Section title="Invoices">
        <DataTable head={["Issued", "Workspace", "Number", "Amount", "Status"]} empty="None yet.">
          {data.invoices.map((i) => (
            <tr key={i.id}>
              <Cell className="whitespace-nowrap text-muted">{when(i.issuedAt)}</Cell>
              <Cell>
                <Link href={`/workspaces/${i.tenant.slug}`} className="text-brand hover:underline">
                  {i.tenant.slug}
                </Link>
              </Cell>
              <Cell>{i.number ?? "—"}</Cell>
              <Cell>{formatMoney(i.total, i.currency)}</Cell>
              <Cell>{i.status.toLowerCase()}</Cell>
            </tr>
          ))}
        </DataTable>
      </Section>
    </>
  );
}
