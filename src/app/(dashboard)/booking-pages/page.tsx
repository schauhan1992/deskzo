import { notFound } from "next/navigation";
import { listBookingPages } from "@/actions/booking";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { BookingPagesManager } from "@/components/booking/booking-pages-manager";
import { Card, CardContent } from "@/components/ui/card";
import { workspaceClock } from "@/lib/time/workspace";
import { leadPath } from "@/lib/record-links";
import { db } from "@/lib/db";
import { leadsInPlan } from "@/lib/leads/shown";

/**
 * Booking pages (owner, 14 Oct 2026 — src/lib/booking): the pages customers book meetings on, and what
 * has been booked. The "booking" module; `booking.manage` opens it — without it the page is not found.
 */
export default async function Page() {
  if (!(await isModuleEnabled("booking"))) return <ModuleDisabledNotice moduleKey="booking" />;
  const data = await listBookingPages();
  if (!data) notFound();
  const clock = await workspaceClock();
  const leads = await leadsInPlan();
  const leadIds = leads ? data.bookings.map((b) => b.leadId).filter((id): id is string => !!id) : [];
  const seqs = leadIds.length ? new Map((await db.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, leadSeq: true } })).map((l) => [l.id, l.leadSeq])) : new Map<string, number>();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Booking pages</h1>
        <p className="mt-1 text-sm text-muted">
          Pages where customers book a meeting in the time your team has free. A booking goes into the host&apos;s calendar with the invitation — with a meeting link when their Outlook, Google or Zoho calendar is connected — and{" "}
          {leads ? "opens a lead" : "adds the company and contact"}.
        </p>
      </div>
      {!data.ready ? (
        <Card>
          <CardContent className="py-6 text-sm text-muted">This workspace is still being updated. Come back in a few minutes.</CardContent>
        </Card>
      ) : (
        <BookingPagesManager
          pages={data.pages}
          hosts={data.hosts}
          pipelines={data.pipelines}
          origin={data.origin}
          zone={clock.zone}
          bookings={data.bookings.map((b) => ({ ...b, startsAt: b.startsAt.toISOString(), leadHref: b.leadId && seqs.has(b.leadId) ? leadPath(seqs.get(b.leadId)!) : null }))}
        />
      )}
    </div>
  );
}
