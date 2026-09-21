import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getCandidate } from "@/actions/candidate";
import { CandidateRecord } from "@/components/hr/candidate-record";

export default async function CandidatePage({ params }: { params: Promise<{ id: string }> }) {
  const enabled = await isModuleEnabled("hr");
  if (!enabled) return <ModuleDisabledNotice moduleKey="hr" />;

  const { id } = await params;
  const candidate = await getCandidate(id);
  if (!candidate) notFound();

  // The intake link has to be pasted into an email, so it needs an absolute URL. Taken from the
  // request rather than an env var, so it is right on localhost, on staging and in production
  // without anybody having to remember to set it.
  const head = await headers();
  const host = head.get("x-forwarded-host") ?? head.get("host") ?? "localhost:3000";
  const proto = head.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");

  return (
    <div className="animate-fade-rise">
      <CandidateRecord candidate={candidate} origin={`${proto}://${host}`} />
    </div>
  );
}
