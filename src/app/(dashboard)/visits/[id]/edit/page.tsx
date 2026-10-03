import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getVisit, listVisitAssignees } from "@/actions/visit";
import { listCompanyOptions } from "@/actions/company";
import { VisitForm } from "@/components/visits/visit-form";
import { isVisitOpen } from "@/lib/visits";
import { workspaceClock } from "@/lib/time/workspace";
import { visitPath } from "@/lib/record-links";

export default async function EditVisitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [visit, session] = await Promise.all([getVisit(id), auth()]);
  if (!visit) notFound();

  if (!isVisitOpen(visit.status)) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">This visit is closed</h1>
        <p className="mt-2 text-sm text-muted">
          A completed or cancelled visit is a record of what happened, so it can&apos;t be rescheduled.
        </p>
        <Link href={visitPath(visit.visitSeq)} className="mt-3 inline-block text-sm text-brand hover:underline">
          ← Back to the visit
        </Link>
      </div>
    );
  }

  const [companies, assignees, clock] = await Promise.all([listCompanyOptions(), listVisitAssignees(), workspaceClock()]);

  return (
    <div>
      <div className="mb-5">
        <Link href={visitPath(visit.visitSeq)} className="text-sm text-muted hover:text-text">
          ← Back to the visit
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-text">Edit visit</h1>
      </div>

      <VisitForm
        companies={companies}
        assignees={assignees}
        currentUserId={session!.user.id}
        defaults={{
          id: visit.id,
          visitSeq: visit.visitSeq,
          companyId: visit.companyId,
          contactId: visit.contactId ?? "",
          leadId: visit.leadId ?? "",
          locationId: visit.locationId ?? "",
          purpose: visit.purpose,
          agenda: visit.agenda ?? "",
          // The time as it was planned on the workspace's clock, not in the server's own zone.
          scheduledFor: clock.input(visit.scheduledFor),
          address: visit.address ?? "",
          distanceKm: visit.distanceKm !== null ? String(visit.distanceKm) : "",
          userId: visit.userId,
        }}
      />
    </div>
  );
}
