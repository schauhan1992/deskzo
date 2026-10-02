import Link from "next/link";
import { auth } from "@/lib/auth";
import { listCompanyOptions } from "@/actions/company";
import { listVisitAssignees } from "@/actions/visit";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { VisitForm } from "@/components/visits/visit-form";
import { istDateTimeInput } from "@/lib/india-time";

const HALF_HOUR_MS = 30 * 60_000;

/**
 * "now, rounded to the next half hour" in India — a sensible default for a visit you're planning
 * today. India's offset is a whole half hour, so a half hour in UTC is a half hour there too.
 */
function defaultSlot() {
  return istDateTimeInput(new Date(Math.ceil((Date.now() + 1) / HALF_HOUR_MS) * HALF_HOUR_MS));
}

export default async function NewVisitPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string; leadId?: string }>;
}) {
  const enabled = await isModuleEnabled("visits");
  if (!enabled) return <ModuleDisabledNotice moduleKey="visits" />;

  const [params, session, companies, assignees] = await Promise.all([
    searchParams,
    auth(),
    listCompanyOptions(),
    listVisitAssignees(),
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
          scheduledFor: defaultSlot(),
          address: "",
          distanceKm: "",
          userId: session!.user.id,
        }}
      />
    </div>
  );
}
