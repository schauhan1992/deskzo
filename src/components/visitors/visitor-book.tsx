"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Users } from "lucide-react";
import type { VisitorPurpose, VisitorStatus } from "@prisma/client";
import { checkOut, closeStaleVisits } from "@/actions/visitor";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils";

type Entry = {
  id: string;
  purpose: VisitorPurpose;
  name: string;
  phone: string;
  company: string | null;
  email: string | null;
  note: string | null;
  photoDataUrl: string | null;
  checkedInAt: string | Date;
  checkedOutAt: string | Date | null;
  status: VisitorStatus;
  badgeNo: number | null;
  host: { id: string; name: string } | null;
  department: { name: string } | null;
  kiosk: { name: string } | null;
  companions: { id: string; name: string }[];
};

const purposeLabels: Record<VisitorPurpose, string> = {
  MEETING: "Meeting",
  INTERVIEW: "Interview",
  DELIVERY: "Delivery",
  VENDOR: "Vendor",
  OTHER: "Other",
};

const statusTone: Record<VisitorStatus, "green" | "default" | "amber"> = {
  IN: "green",
  OUT: "default",
  ABANDONED: "amber",
};

/**
 * The book.
 *
 * Who is still in the building comes first and is counted at the top, because that is the number
 * somebody wants in the one situation where this module stops being administrative — a fire alarm.
 */
export function VisitorBook({ entries }: { entries: Entry[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const onSite = entries.filter((e) => e.status === "IN");
  const stale = onSite.filter((e) => new Date(e.checkedInAt).toDateString() !== new Date().toDateString());

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="flex items-center gap-2.5">
            <Users className="h-4 w-4 text-muted" />
            <span className="text-sm text-text">
              <span className="font-semibold">{onSite.length}</span> in the building
            </span>
          </div>
          {stale.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-warning">
                {stale.length} never signed out from an earlier day
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    await closeStaleVisits();
                    router.refresh();
                  })
                }
              >
                Close them off
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {entries.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted">Nobody has signed in.</CardContent>
        </Card>
      ) : (
        entries.map((e) => (
          <Card key={e.id}>
            <CardContent className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                {e.photoDataUrl ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={e.photoDataUrl} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" />
                ) : (
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-sm text-subtle">
                    {e.badgeNo ? `#${e.badgeNo}` : "—"}
                  </div>
                )}
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-text">{e.name}</span>
                    <Badge tone="default">{purposeLabels[e.purpose]}</Badge>
                    <Badge tone={statusTone[e.status]}>
                      {e.status === "IN" ? "In" : e.status === "OUT" ? "Signed out" : "Not signed out"}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-muted">
                    {[e.company, e.phone, e.email].filter(Boolean).join(" · ")}
                  </p>
                  <p className="mt-0.5 text-xs text-subtle">
                    {e.host ? `To see ${e.host.name}` : e.department ? `For ${e.department.name}` : "No host recorded"}
                    {e.kiosk && ` · ${e.kiosk.name}`}
                    {` · in ${formatDateTime(new Date(e.checkedInAt))}`}
                    {e.checkedOutAt && ` · out ${formatDateTime(new Date(e.checkedOutAt))}`}
                  </p>
                  {e.companions.length > 0 && (
                    <p className="mt-0.5 text-xs text-muted">
                      With {e.companions.map((c) => c.name).join(", ")}
                    </p>
                  )}
                  {e.note && <p className="mt-1 text-xs text-muted">{e.note}</p>}
                </div>
              </div>

              {e.status === "IN" && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={async () => {
                    const result = await checkOut(e.id);
                    if (!result.ok) alert(result.error);
                    router.refresh();
                  }}
                >
                  <LogOut className="mr-1.5 h-3.5 w-3.5" />
                  Sign out
                </Button>
              )}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
