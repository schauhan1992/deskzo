"use client";

import { useState } from "react";
import Link from "next/link";
import { SidePane } from "@/components/ui/side-pane";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { useClock } from "@/components/time/clock-provider";

/** One line on a company's timeline: something done on one of its leads, or a call (src/components/companies/company-detail.tsx). */
export type TimelineEntry = {
  id: string;
  type: string;
  notes: string;
  occurredAt: Date | string;
  user: { id: string; name: string };
  /** Where it belongs: its lead, or the company's Calls tab for a call on none. */
  link: { href: string; label: string };
  /** A lead's call entry, keyed as its call is — so that call isn't listed a second time. Server side only. */
  callOf?: string | null;
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
                  href={a.link.href}
                  className="text-xs font-medium text-muted hover:underline"
                  onClick={() => setOpen(false)}
                >
                  {a.link.label}
                </Link>
              </div>
              <div className="mt-0.5 text-xs text-subtle">
                {a.user.name} · {clock.date(a.occurredAt)}
              </div>
              <p className="mt-1 text-text">{a.notes}</p>
            </div>
          ))}
          {timeline.length === 0 && (
            <p className="text-sm text-subtle">No activity logged for this company yet — on its leads, or a call.</p>
          )}
        </div>
      </SidePane>
    </>
  );
}
