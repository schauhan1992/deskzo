"use client";

import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { consoleSetTimeZone } from "@/actions/platform/console-time-zone";
import { DefinitionList } from "@/components/console/kit/panel";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ChangedBy, type SettingChange } from "@/components/console/settings/signup-settings";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { OptionCombobox } from "@/components/ui/option-combobox";
import type { ZoneOption } from "@/lib/time/zones";

/**
 * Settings › Time zone: the console's clock, for all staff (`console.timezone`,
 * src/lib/platform/console-clock.ts). Every time the console shows is in it. Owners change it; everyone
 * else (`readOnly`) sees it in words. A workspace's own zone is its owner's, under its Settings.
 */
export function ConsoleTimeZoneSetting({
  zone,
  options,
  change,
  readOnly = false,
}: {
  zone: string;
  options: ZoneOption[];
  change: SettingChange | null;
  readOnly?: boolean;
}) {
  const action = useConsoleAction<null>();
  const [chosen, setChosen] = useState(zone);
  const label = options.find((o) => o.zone === zone)?.label ?? zone;
  const never = "Never changed — India time by default";

  if (readOnly) {
    return (
      <div className="space-y-4">
        <DefinitionList columns={1} items={[{ term: "The console's time zone", value: label }]} />
        <ChangedBy change={change} never={never} className="border-t border-line pt-3" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="max-w-md space-y-1.5">
        <label htmlFor="console-time-zone" className="text-sm font-medium text-text">
          The console&apos;s time zone
        </label>
        <OptionCombobox
          id="console-time-zone"
          options={options.map((o) => ({ id: o.zone, name: o.label }))}
          value={chosen}
          onSelect={(option) => {
            if (option) setChosen(option.id);
            action.reset();
          }}
          listLabel="Time zones"
          placeholder="Type a city or a country"
          disabled={action.pending}
        />
        <p className="text-xs text-subtle">For every member of staff. Each workspace keeps its own, chosen by its owner.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {/* Inert rather than disabled while pending, so focus stays on the button that was pressed. */}
        <Button
          type="button"
          size="sm"
          onClick={() => !action.pending && action.run(() => consoleSetTimeZone(chosen), { success: "The console's time zone is changed." })}
          disabled={chosen === zone}
          aria-disabled={action.pending || undefined}
          aria-busy={action.pending || undefined}
        >
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Save
        </Button>
        <ChangedBy change={change} never={never} />
      </div>
      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} className="empty:hidden" />
    </div>
  );
}
