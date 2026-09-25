"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveMaintenance, type MaintenanceInput } from "@/actions/maintenance";
import { DEFAULT_MESSAGE, MESSAGE_MAX, maintenancePage, type MaintenanceState } from "@/lib/maintenance-state";
import { formatIstDateTime, istDateTimeInput, parseIstDateTime } from "@/lib/india-time";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

export type MaintenanceSettings = {
  now: Date;
  stillIn: string[];
  activeUsers: number;
  phase: MaintenanceState["phase"];
  startsAt: Date | null;
  endsAt: Date | null;
  message: string;
  updatedAt: Date | null;
  updatedBy: string | null;
  appName: string;
};

/** How long, when it is not "until I switch it off" or a time of its own. */
const DURATIONS = [
  { value: "", label: "Until I switch it off" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "1 hour" },
  { value: "120", label: "2 hours" },
  { value: "240", label: "4 hours" },
  { value: "at", label: "Until a time I choose…" },
];

export function MaintenanceForm({ settings }: { settings: MaintenanceSettings }) {
  const router = useRouter();
  const live = settings.phase === "on" || settings.phase === "scheduled";
  const [mode, setMode] = useState<"now" | "schedule">(settings.phase === "scheduled" ? "schedule" : "now");
  const [startsAt, setStartsAt] = useState(settings.phase === "scheduled" ? istDateTimeInput(settings.startsAt) : "");
  const [duration, setDuration] = useState(settings.endsAt && live ? "at" : "60");
  const [endsAt, setEndsAt] = useState(settings.endsAt && live ? istDateTimeInput(settings.endsAt) : "");
  const [message, setMessage] = useState(settings.message);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  /** The end, as India time for the form to send — worked out from the start and the duration. */
  function endFor(start: Date | null): string {
    if (duration === "") return "";
    if (duration === "at") return endsAt;
    return istDateTimeInput(new Date((start ?? settings.now).getTime() + Number(duration) * 60_000));
  }

  const previewStart = mode === "schedule" ? parseIstDateTime(startsAt) : settings.now;
  const previewEnd = endFor(previewStart) ? parseIstDateTime(endFor(previewStart)) : null;
  const preview = maintenancePage({ phase: "on", startsAt: previewStart, endsAt: previewEnd, message: message.trim() || DEFAULT_MESSAGE }, settings.appName);

  function save(next: MaintenanceInput["mode"]) {
    setNotice(null);
    setConfirming(false);
    startTransition(async () => {
      const start = next === "schedule" ? parseIstDateTime(startsAt) : null;
      const r = await saveMaintenance({ mode: next, startsAt: next === "schedule" ? startsAt : undefined, endsAt: next === "off" ? undefined : endFor(start), message });
      if (!r.ok) {
        setNotice({ tone: "error", text: r.error });
        return;
      }
      setNotice({
        tone: "success",
        text:
          next === "off"
            ? "Maintenance mode is off — everybody can use the app again."
            : r.data.phase === "on"
              ? "Maintenance mode is on. Everybody else now sees the maintenance page; you can carry on."
              : "Scheduled. Everybody will see a banner about it from a day before.",
      });
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <Card className={settings.phase === "on" ? "border-danger/50" : settings.phase === "scheduled" ? "border-brand/40" : ""}>
        <CardContent className="space-y-1 pt-4 text-sm">
          <p className="font-semibold text-text">
            {settings.phase === "on" && <span className="text-danger">The app is down for maintenance.</span>}
            {settings.phase === "scheduled" && <span>Maintenance is scheduled.</span>}
            {(settings.phase === "off" || settings.phase === "ended") && <span>The app is up for everybody.</span>}
          </p>
          {settings.phase === "on" && (
            <p className="text-muted">
              {settings.endsAt ? `It comes back by itself at ${formatIstDateTime(settings.endsAt)}.` : "It stays down until somebody switches it off."}
            </p>
          )}
          {settings.phase === "scheduled" && settings.startsAt && (
            <p className="text-muted">
              From {formatIstDateTime(settings.startsAt)}
              {settings.endsAt ? ` to ${formatIstDateTime(settings.endsAt)}` : ", until somebody switches it off"}. Everybody signed in sees a banner about it from a day
              before.
            </p>
          )}
          {settings.phase === "ended" && settings.endsAt && <p className="text-muted">The last window ended at {formatIstDateTime(settings.endsAt)}.</p>}
          {settings.updatedAt && settings.updatedBy && (
            <p className="text-xs text-subtle">
              Last changed by {settings.updatedBy}, {formatIstDateTime(settings.updatedAt)}.
            </p>
          )}
          {live && (
            <Button variant="secondary" size="sm" className="mt-2" disabled={pending} onClick={() => save("off")}>
              {settings.phase === "on" ? "Switch it off — bring the app back" : "Cancel the scheduled maintenance"}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-semibold text-text">{live ? "Change it" : "Take the app down"}</CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="flex flex-wrap gap-4">
            {(["now", "schedule"] as const).map((m) => (
              <label key={m} className="flex cursor-pointer items-center gap-2 text-text">
                <input type="radio" name="maintenance-mode" checked={mode === m} onChange={() => setMode(m)} />
                {m === "now" ? "Now" : "At a time I choose"}
              </label>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {mode === "schedule" && (
              <div className="space-y-1">
                <Label htmlFor="maintenance-start">Starts (India time)</Label>
                <Input id="maintenance-start" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="maintenance-duration">For</Label>
              <Select id="maintenance-duration" value={duration} onChange={(e) => setDuration(e.target.value)}>
                {DURATIONS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </Select>
            </div>
            {duration === "at" && (
              <div className="space-y-1">
                <Label htmlFor="maintenance-end">Ends (India time)</Label>
                <Input id="maintenance-end" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
              </div>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="maintenance-message">What people are told</Label>
            <Textarea
              id="maintenance-message"
              rows={3}
              maxLength={MESSAGE_MAX}
              placeholder={DEFAULT_MESSAGE}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <p className="text-xs text-subtle">
              Left empty, they see the text in grey above. {message.length}/{MESSAGE_MAX}
            </p>
          </div>

          <div className="rounded-base border border-line bg-surface-sunken px-3 py-2 text-xs text-muted">
            <p>
              <span className="font-medium text-text">Still able to use the app:</span> {settings.stillIn.join(", ") || "nobody"} — whoever can change
              organisation settings. The other {Math.max(0, settings.activeUsers - settings.stillIn.length)} active people see the page below.
            </p>
            <p className="mt-1">
              The sign-in page, unsubscribe links and the biometric terminals keep working. Customer links — the portal, forms, feedback — show the page too.
            </p>
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">What they will see</p>
            <iframe title="Preview of the maintenance page" srcDoc={preview} sandbox="" className="h-72 w-full rounded-base border border-line bg-white" />
          </div>

          {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}

          {mode === "now" ? (
            confirming ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-text">Take the app down for everybody else now?</span>
                <Button variant="danger" disabled={pending} onClick={() => save("now")}>
                  {pending ? "Switching on…" : "Yes, switch it on"}
                </Button>
                <Button variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button variant="danger" disabled={pending} onClick={() => setConfirming(true)}>
                {settings.phase === "on" ? "Save changes" : "Switch maintenance mode on now"}
              </Button>
            )
          ) : (
            <Button disabled={pending || !startsAt} onClick={() => save("schedule")}>
              {pending ? "Saving…" : settings.phase === "scheduled" ? "Save the new time" : "Schedule it"}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
