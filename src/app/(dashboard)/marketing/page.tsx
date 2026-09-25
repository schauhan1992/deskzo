import Link from "next/link";
import { AlertTriangle, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listAudiences, listCampaigns, listTemplates, marketingOverview } from "@/actions/marketing";
import { hasEffectivePermission } from "@/actions/permission";
import { currentUser } from "@/lib/session";
import { getOrganisation } from "@/lib/organisation";
import { postalAddressFor } from "@/lib/marketing/footer";
import { db } from "@/lib/db";
import { Card } from "@/components/ui/card";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { CampaignList } from "@/components/marketing/campaign-list";
import { CampaignEditor } from "@/components/marketing/campaign-editor";
import { TickBanner } from "@/components/marketing/tick-banner";

export default async function MarketingPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const enabled = await isModuleEnabled("marketing");
  if (!enabled) return <ModuleDisabledNotice moduleKey="marketing" />;

  const params = await searchParams;
  const user = await currentUser();
  const [overview, campaigns, canSend, canApprove, canManage, org, providers, audiences, templates] = await Promise.all([
    marketingOverview(),
    listCampaigns(params),
    user ? hasEffectivePermission(user.id, "marketing.send") : Promise.resolve(false),
    user ? hasEffectivePermission(user.id, "marketing.approve") : Promise.resolve(false),
    user ? hasEffectivePermission(user.id, "marketing.manage") : Promise.resolve(false),
    getOrganisation(),
    db.messagingProvider.count({ where: { enabled: true, classes: { has: "MARKETING" } } }),
    listAudiences(),
    listTemplates(),
  ]);

  if (!overview) {
    return (
      <div className="animate-fade-rise">
        <h1 className="text-xl font-semibold text-text">Marketing</h1>
        <Card className="mt-5 px-4 py-12 text-center text-sm text-subtle">
          You don&apos;t have access to marketing.
        </Card>
      </div>
    );
  }

  const counts = overview.counts as Record<string, number>;
  const sent = (counts.SENT ?? 0) + (counts.DELIVERED ?? 0) + (counts.OPENED ?? 0) + (counts.CLICKED ?? 0);
  const opened = (counts.OPENED ?? 0) + (counts.CLICKED ?? 0);

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Marketing</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Campaigns and journeys built from what the ERP already knows. Every recipient is checked against consent
            and suppression before anything goes out, and a reseller&apos;s end customers are never reachable from
            here.
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/marketing/send">
              <Button>
                <Send className="h-4 w-4" /> Send a mass mail
              </Button>
            </Link>
            <CampaignEditor audiences={audiences} templates={templates} />
          </div>
        )}
      </div>

      <div className="mt-4">
        <TickBanner health={overview.health} canRun={canSend} />
      </div>

      {providers === 0 && (
        <Card className="mt-4 border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
          <span className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              No provider is set up to carry marketing, so nothing can send. Add one in Settings → Organisation.
              Everything else — audiences, journeys, and steps that create tasks — works without one.
            </span>
          </span>
        </Card>
      )}

      {!postalAddressFor(org).text && (
        <Card className="mt-4 border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
          <span className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              No postal address for the email footer, and no registered office to fall back on. Most providers
              require one, and its absence is a common reason bulk mail is filtered — fill in the registered
              address in Settings → Organisation and this sorts itself out.
            </span>
          </span>
        </Card>
      )}

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Sent" value={sent} hint="in the last 30 days" />
        <Stat
          label="Opened"
          value={opened}
          hint={sent > 0 ? `${Math.round((opened / sent) * 100)}% — a weak signal, but a signal` : "nothing sent yet"}
        />
        <Stat
          label="Held back"
          value={counts.SUPPRESSED ?? 0}
          hint={(counts.SUPPRESSED ?? 0) > 0 ? "each one with a reason on the record" : "nobody suppressed"}
        />
        <Stat
          label="Running"
          value={overview.campaigns + overview.journeys}
          hint={`${overview.campaigns} campaign(s), ${overview.journeys} journey(s)`}
        />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <SelectParamFilter
          paramName="status"
          label="Status"
          options={[
            { value: "DRAFT", label: "Draft" },
            { value: "PENDING_APPROVAL", label: "Waiting for approval" },
            { value: "SCHEDULED", label: "Scheduled" },
            { value: "SENT", label: "Sent" },
            { value: "CANCELLED", label: "Stopped" },
          ]}
        />
      </div>

      <div className="mt-4">
        <CampaignList campaigns={campaigns} canSend={canSend} canApprove={canApprove} />
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-text">{value}</div>
      <div className="mt-0.5 text-xs text-muted">{hint}</div>
    </Card>
  );
}
