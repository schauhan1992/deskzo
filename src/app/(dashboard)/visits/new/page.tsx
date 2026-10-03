import Link from "next/link";
import { auth } from "@/lib/auth";
import { listCompanyOptions } from "@/actions/company";
import { listVisitAssignees } from "@/actions/visit";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { VisitForm } from "@/components/visits/visit-form";
import { workspaceClock } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";

/**
 * "now, rounded to the next half hour" on the workspace's clock — a sensible default for a visit you're
 * planning today. Rounded on the wall clock rather than in UTC: some zones sit a quarter hour off it.
 */
function defaultSlot(clock: Clock) {
  const now = clock.parts(new Date());
  // Minutes past midnight overflow into the next day as `at` normalises them.
  const minutes = (Math.floor((now.hour * 60 + now.minute) / 30) + 1) * 30;
  return clock.input(clock.at(now.year, now.month, now.day, 0, minutes));
}

export default async function NewVisitPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string; leadId?: string }>;
}) {
  const enabled = await isModuleEnabled("visits");
  if (!enabled) return <ModuleDisabledNotice moduleKey="visits" />;

  const [params, session, companies, assignees, clock] = await Promise.all([
    searchParams,
    auth(),
    listCompanyOptions(),
    listVisitAssignees(),
    workspaceClock(),
  ]);

  return (
    <div>
      <div className="mb-5">
        <Link href="/visits" className="text-sm text-muted hover:text-text">
          ← Field visits
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-text">Plan a visit</h1>
        <p className="mt-1 text-sm text-muted">
          Check in when you arrive, write up the outcome afterwards, and claim the travel against it.
        </p>
      </div>

      <VisitForm
        companies={companies}
        assignees={assignees}
        currentUserId={session!.user.id}
        defaults={{
          companyId: params.companyId && companies.some((c) => c.id === params.companyId) ? params.companyId : "",
          contactId: "",
          leadId: params.leadId ?? "",
          locationId: "",
          purpose: "INTRO_MEETING",
          agenda: "",
          scheduledFor: defaultSlot(clock),
          address: "",
          distanceKm: "",
          userId: session!.user.id,
        }}
      />
    </div>
  );
}
