"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setWorkspaceTimeZone, type TimeZoneSetting } from "@/actions/time-zone";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/input";
import { OptionCombobox } from "@/components/ui/option-combobox";
import { clockFor } from "@/lib/time/zone";

function everyHalfMinute(onChange: () => void): () => void {
  const timer = setInterval(onChange, 30_000);
  return () => clearInterval(timer);
}

/**
 * Settings → Profile → Time zone (owner, 2 Oct 2026): the workspace's clock, for everybody in it —
 * lists, records, reminders, and the times people type into forms. India's tax dates keep India's.
 */
export function TimeZoneCard({ setting }: { setting: TimeZoneSetting }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [zone, setZone] = useState(setting.zone);
  const [said, setSaid] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  // The time there now is the browser's to say — the server renders without it — kept current each half minute.
  const nowThere = useSyncExternalStore(everyHalfMinute, () => clockFor(zone).dateTime(new Date()), () => null);

  const options = setting.options.map((o) => ({ id: o.zone, name: o.label }));

  function save() {
    setSaid(null);
    startTransition(async () => {
      const result = await setWorkspaceTimeZone({ zone });
      if (!result.ok) {
        setSaid({ tone: "error", text: result.error });
        return;
      }
      setSaid({ tone: "success", text: "Saved. Every time in this workspace is now in this zone." });
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Time zone</CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted">
          Every time in this workspace is shown and read in this zone, for everybody in it — lists and records, reminders, and the times people type
          into forms. India&apos;s tax dates — GST and TDS periods, e-way bills, e-invoices and the financial year — stay on India time.
        </p>
        <div className="max-w-md space-y-1.5">
          <Label htmlFor="workspace-time-zone">Zone</Label>
          <OptionCombobox
            id="workspace-time-zone"
            options={options}
            value={zone}
            onSelect={(option) => {
              if (option) setZone(option.id);
              setSaid(null);
            }}
            listLabel="Time zones"
            placeholder="Type a city or a country"
            disabled={!setting.changeable || pending}
          />
          {nowThere && <p className="text-xs text-subtle">It is {nowThere} there now.</p>}
        </div>
        {!setting.changeable && <p className="text-sm text-muted">This workspace&apos;s time zone is set in its server&apos;s configuration.</p>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={save} disabled={!setting.changeable || pending || zone === setting.zone}>
            {pending ? "Saving…" : "Save time zone"}
          </Button>
          {said && (
            <span role={said.tone === "error" ? "alert" : "status"} className={said.tone === "error" ? "text-sm text-danger" : "text-sm text-success"}>
              {said.text}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
