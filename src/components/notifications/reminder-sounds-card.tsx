"use client";

import { useState, useTransition } from "react";
import { Volume2 } from "lucide-react";
import { saveReminderSounds } from "@/actions/notification";
import { SOUND_KINDS, type ReminderSounds } from "@/lib/reminder-sounds";
import { playChime } from "@/components/notifications/chime";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/**
 * Which reminders chime while Deskzo is open (owner, 8 Oct 2026) — all on to begin with. Saved as each
 * box is ticked; "Play the sound" lets somebody hear it, and opens the browser's audio as it does.
 */
export function ReminderSoundsCard({ sounds }: { sounds: ReminderSounds }) {
  const [settings, setSettings] = useState<ReminderSounds>(sounds);
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function save(next: ReminderSounds) {
    setSettings(next);
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await saveReminderSounds(next);
      if (!result.ok) return setError(result.error);
      setNotice("Saved.");
    });
  }

  const allOff = settings.off === true;
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Reminder sounds</CardHeader>
      <CardContent className="space-y-3 text-sm">
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={!allOff}
            disabled={pending}
            onChange={(e) => save({ ...settings, off: !e.target.checked })}
            className="mt-0.5 h-4 w-4"
          />
          <span>
            Play a sound when a reminder arrives
            <span className="block text-xs text-subtle">While Deskzo is open in a tab — after you&apos;ve clicked anywhere on it once.</span>
          </span>
        </label>
        <fieldset disabled={allOff || pending} className="ml-6 space-y-2 disabled:opacity-50">
          <legend className="sr-only">Which reminders</legend>
          {SOUND_KINDS.map((k) => (
            <label key={k.key} className="flex items-start gap-2.5">
              <input
                type="checkbox"
                checked={settings[k.key] !== false}
                onChange={(e) => save({ ...settings, [k.key]: e.target.checked })}
                className="mt-0.5 h-4 w-4"
              />
              <span>
                {k.label}
                <span className="block text-xs text-subtle">{k.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              if (!playChime()) setTimeout(playChime, 120);
            }}
          >
            <Volume2 className="h-3.5 w-3.5" aria-hidden />
            Play the sound
          </Button>
          {notice && (
            <span role="status" className="text-xs text-success">
              {notice}
            </span>
          )}
          {error && (
            <span role="alert" className="text-xs text-danger">
              {error}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
