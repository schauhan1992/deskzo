import type { Metadata } from "next";
import Link from "next/link";
import { Banner } from "@/components/console/kit/banner";
import { PageHeader } from "@/components/console/kit/page-header";
import { StatusPill } from "@/components/console/kit/status";
import { AiSettings } from "@/components/console/settings/ai-settings";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { capsFor } from "@/lib/console-shared/roles";
import { aiSetup, platformAiUsage } from "@/lib/ai/accounts";
import { consoleClock } from "@/lib/platform/console-clock";
import { consoleStaff } from "@/lib/platform/console-page";

export const metadata: Metadata = { title: "Deskzo AI" };

/**
 * Settings › AI (owner, 17 Oct 2026; src/lib/ai): the accounts Deskzo AI calls models through, the models
 * with their rates in credits, which model each feature runs on, the kill switch, the packs on sale, a
 * trial's credits, and this month's use against what it cost. Settings' own gate; only an owner changes
 * anything (src/actions/platform/console-ai.ts checks again). No secret reaches the page.
 */
export default async function ConsoleAiSettingsPage() {
  const staff = await consoleStaff(PAGE_ROLES.settings);
  const caps = capsFor(staff.role);
  const clock = await consoleClock();
  const now = new Date();
  const month = clock.monthWindow(now);
  // Null until the release's migration has made the AI tables.
  const [setup, usage] = await Promise.all([aiSetup().catch(() => null), platformAiUsage(month.from, month.to).catch(() => [])]);

  return (
    <>
      <PageHeader
        title="Deskzo AI"
        chips={caps.owner ? undefined : <StatusPill tone="neutral">View only</StatusPill>}
        subtitle="Where the copilot and Automate's drafting run, what workspaces are charged for them in credits, and the switch that stops them everywhere."
        actions={
          <Link href="/settings" className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline">
            All settings
          </Link>
        }
      />
      {setup ? (
        <AiSettings setup={setup} usage={usage} monthLabel={clock.monthKey(now)} canEdit={caps.owner} />
      ) : (
        <Banner tone="warning" title="Not ready yet">
          {"This release's database migrations haven't run here, so there are no AI settings to show. Run npm run tenants:migrate, then reload."}
        </Banner>
      )}
    </>
  );
}
