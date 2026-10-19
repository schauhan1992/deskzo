"use client";

import { useState, useTransition } from "react";
import { History } from "lucide-react";
import { companyActivity, leadActivity } from "@/actions/activity-feed";
import { SidePane } from "@/components/ui/side-pane";
import { Button } from "@/components/ui/button";
import { ActivityFeed } from "@/components/activity/activity-feed";
import type { ActivityGroupKey, ActivityPage } from "@/lib/activity/types";

/**
 * The Activity button on a customer's or vendor's page (owner, 19 Oct 2026): a side panel with everything
 * that happened to it, read as it opens — so it's current each time, and costs the page nothing.
 */
export function ActivityPanelButton({
  source,
  groups,
  people,
  zone,
}: {
  source: { kind: "company" | "lead"; id: string };
  groups: ActivityGroupKey[];
  people?: { id: string; name: string }[];
  zone: string;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<ActivityPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const show = () => {
    setOpen(true);
    setPage(null);
    setError(null);
    startTransition(async () => {
      const result = source.kind === "company" ? await companyActivity(source.id) : await leadActivity(source.id);
      if (result.ok) setPage(result.data);
      else setError(result.error);
    });
  };

  return (
    <>
      <Button type="button" variant="secondary" onClick={show}>
        <History className="size-4" aria-hidden="true" />
        Activity
      </Button>
      <SidePane open={open} onClose={() => setOpen(false)} title="Recent activity">
        {error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : page ? (
          <ActivityFeed source={source} initial={page} groups={groups} people={people} zone={zone} />
        ) : (
          <p className="text-sm text-muted">Loading…</p>
        )}
      </SidePane>
    </>
  );
}
