"use client";

import { useState } from "react";
import Link from "next/link";
import { SidePane } from "@/components/ui/side-pane";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { useClock } from "@/components/time/clock-provider";
import { leadPath } from "@/lib/record-links";

type TimelineEntry = {
  id: string;
  type: string;
  notes: string;
  occurredAt: Date | string;
  leadId: string;
  leadSeq: number;
  leadTitle: string;
  user: { id: string; name: string };
};

export function ActivityPanelButton({ timeline }: { timeline: TimelineEntry[] }) {
  const [open, setOpen] = useState(false);
  const clock = useClock();

  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Activity {timeline.length > 0 && `(${timeline.length})`}
      </Button>
      <SidePane open={open} onClose={() => setOpen(false)} title="Activity timeline">
        <div className="space-y-4">
          {timeline.map((a) => (
            <div key={a.id} className="text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge>{a.type.replaceAll("_", " ")}</Badge>
                <Link
                  href={leadPath(a.leadSeq)}
                  className="text-xs font-medium text-muted hover:underline"
                  onClick={() => setOpen(false)}
                >
                  {a.leadTitle}
                </Link>
              </div>
              <div className="mt-0.5 text-xs text-subtle">
                {a.user.name} · {clock.date(a.occurredAt)}
              </div>
              <p className="mt-1 text-text">{a.notes}</p>
            </div>
          ))}
          {timeline.length === 0 && (
            <p className="text-sm text-subtle">No activity logged across this company&rsquo;s leads yet.</p>
          )}
        </div>
      </SidePane>
    </>
  );
}
