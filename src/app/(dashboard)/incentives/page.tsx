import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { incentiveCapabilities, listEarnings } from "@/actions/incentive";
import { targetOptions } from "@/actions/target";
import { Card } from "@/components/ui/card";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { EarningQueue } from "@/components/incentives/earning-queue";
import { statusLabels } from "@/lib/incentives/compute";
import type { IncentiveStatus } from "@prisma/client";

export default async function IncentivesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; userId?: string }>;
}) {
  const enabled = await isModuleEnabled("incentives");
  if (!enabled) return <ModuleDisabledNotice moduleKey="incentives" />;

  const params = await searchParams;
  const caps = await incentiveCapabilities();
  if (!caps.queue) {
    return (
      <Card className="px-6 py-10 text-center text-sm text-muted">
        The incentive queue sits behind its own permission. Your own are on{" "}
        <a href="/incentives/mine" className="text-brand hover:underline">
          My incentives
        </a>
        .
      </Card>
    );
  }

  const [earnings, options] = await Promise.all([listEarnings(params), targetOptions()]);

  return (
    <div className="animate-fade-rise">
      <div>
        <h1 className="text-xl font-semibold text-text">Incentives</h1>
        <p className="mt-1 text-sm text-muted">
          What people have earned against their targets, and what is cleared to go out. Each figure carries the
          workings it was arrived at with — frozen, so a scheme edited next quarter can&apos;t rewrite what was paid
          last quarter.
        </p>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <SelectParamFilter
          paramName="status"
          label="Status"
          options={(Object.keys(statusLabels) as IncentiveStatus[]).map((s) => ({ value: s, label: statusLabels[s] }))}
        />
      </div>

      <div className="mt-4">
        <EarningQueue earnings={earnings} caps={caps} people={options.people} />
      </div>
    </div>
  );
}
