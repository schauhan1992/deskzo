"use client";

import { useEffect, useState, useTransition } from "react";
import { getWorldPlaces, startWorldPlacesSync, type WorldPlacesState } from "@/actions/reference-data";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { OutboundLink } from "@/components/ui/outbound-link";

const when = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(iso)) : "—";

const LABELS: Record<string, string> = {
  "geonames-states": "States & provinces",
  "geonames-cities": "Towns & cities (1,000+ people)",
  "geonames-postal": "Postal codes",
};

/**
 * World places: what is loaded from GeoNames, and a Sync button. The sync is a separate process
 * (see `startWorldPlacesSync`), so leaving the page does not stop it; this polls while it runs.
 */
export function WorldPlacesManager({ initial }: { initial: WorldPlacesState }) {
  const [state, setState] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { loaded, sync } = state;
  const running = sync.status === "RUNNING" && !sync.stale;

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      getWorldPlaces()
        .then((r) => r.ok && setState(r.data))
        .catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [running]);

  function sync_() {
    setError(null);
    startTransition(async () => {
      const r = await startWorldPlacesSync();
      if (!r.ok) setError(r.error);
      const next = await getWorldPlaces();
      if (next.ok) setState(next.data);
    });
  }

  const percent = sync.total ? Math.min(100, Math.round((sync.done / sync.total) * 100)) : null;

  return (
    <div className="max-w-2xl space-y-4">
      <Card>
        <CardHeader className="text-sm font-medium text-text">What is loaded</CardHeader>
        <CardContent>
          {loaded.length === 0 ? (
            <p className="text-sm text-muted">Nothing yet — addresses outside India are typed freely until world places are synced.</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {loaded.map((d) => (
                <li key={d.key} className="flex items-baseline justify-between gap-3 py-2">
                  <span className="text-text">{LABELS[d.key] ?? d.key}</span>
                  <span className="text-right text-muted">
                    {d.rows.toLocaleString("en-IN")}
                    <span className="block text-xs text-subtle">{when(d.loadedAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between gap-2 text-sm font-medium text-text">
          Sync from GeoNames
          {sync.status === "SUCCEEDED" && <Badge tone="green">Done</Badge>}
          {sync.status === "FAILED" && <Badge tone="red">Failed</Badge>}
          {running && <Badge tone="blue">Running</Badge>}
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted">
            Downloads GeoNames&apos; current files (about 55 MB) and replaces what is loaded — full postal codes for the UK, Canada and the
            Netherlands, the published form elsewhere. Takes a few minutes; you can leave this page. GeoNames updates daily, so once a month is plenty.
          </p>
          {running && (
            <div className="space-y-1">
              <div className="h-2 overflow-hidden rounded-full bg-surface-sunken">
                <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${percent ?? 5}%` }} />
              </div>
              <p className="text-xs text-muted">{sync.message}</p>
            </div>
          )}
          {!running && sync.message && sync.status !== "IDLE" && (
            <p className={`text-xs ${sync.status === "FAILED" ? "text-danger" : "text-muted"}`}>
              {when(sync.finishedAt)} — {sync.message}
            </p>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
          <Button onClick={sync_} disabled={pending || running}>
            {running ? "Syncing…" : "Sync now"}
          </Button>
          <p className="text-xs text-subtle">
            Place names and postal codes outside India from{" "}
            <OutboundLink href="https://www.geonames.org/" className="hover:text-text hover:underline">
              GeoNames
            </OutboundLink>
            , licensed CC BY 4.0.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
