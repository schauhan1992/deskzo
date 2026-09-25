import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getCandidate } from "@/actions/candidate";
import { CandidateRecord } from "@/components/hr/candidate-record";
import { tenantOrigin } from "@/lib/tenancy/resolve";

export default async function CandidatePage({ params }: { params: Promise<{ id: string }> }) {
  const enabled = await isModuleEnabled("hr");
  if (!enabled) return <ModuleDisabledNotice moduleKey="hr" />;

  const { id } = await params;
  const candidate = await getCandidate(id);
  if (!candidate) notFound();

  // The intake link has to be pasted into an email, so it needs an absolute URL. Taken from the
  // request rather than an env var, so it is right on localhost, on staging and in production
  // without anybody having to remember to set it.
  // The workspace's own address — links from here are pasted into WhatsApp and emails.
  const origin = await tenantOrigin();

  return (
    <div className="animate-fade-rise">
      <CandidateRecord candidate={candidate} origin={origin} />
    </div>
  );
}
