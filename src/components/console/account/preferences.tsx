"use client";

import { useId, type ReactNode } from "react";
import { useDensity, useLandingPage, useSidebarCollapsed } from "@/components/console/kit/prefs";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { cn } from "@/lib/utils";

/**
 * My account › Preferences (spec §3.19): how the console looks and opens for this viewer — theme,
 * the page signing in lands on, table density and the collapsed sidebar. All of it is kept in this
 * browser's storage through the kit's `prefs.ts` stores, never on the server and never shown to
 * anybody else; the shell reads the same stores, so a choice here applies at once, in every tab.
 *
 * The server render shows the defaults (the stores' server snapshots), and the stored choice takes
 * over when the page hydrates.
 */

export function Preferences() {
  const [density, setDensity] = useDensity();
  const [landing, setLanding] = useLandingPage();
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  const themeId = useId();

  return (
    <div className="divide-y divide-line">
      <div className="pb-4">
        <PrefHeading id={themeId} hint="Light, dark, or whatever this device is set to.">
          Theme
        </PrefHeading>
        <div role="group" aria-labelledby={themeId} className="mt-2 inline-flex">
          <ThemeToggle defaultTheme="system" />
        </div>
      </div>
      <Segmented
        legend="Start page"
        hint="Where signing in takes you."
        value={landing}
        onChange={setLanding}
        options={[
          { value: "overview", label: "Overview" },
          { value: "workspaces", label: "Workspaces" },
        ]}
      />
      <Segmented
        legend="Table density"
        hint="Compact fits more rows on a screen."
        value={density}
        onChange={setDensity}
        options={[
          { value: "comfortable", label: "Comfortable" },
          { value: "compact", label: "Compact" },
        ]}
      />
      <Segmented
        legend="Sidebar"
        hint="Collapsed shows the icons only, on screens wide enough for a sidebar."
        value={collapsed ? "collapsed" : "expanded"}
        onChange={(v) => setCollapsed(v === "collapsed")}
        options={[
          { value: "expanded", label: "Expanded" },
          { value: "collapsed", label: "Collapsed" },
        ]}
      />
    </div>
  );
}

function PrefHeading({ id, hint, children }: { id?: string; hint: string; children: ReactNode }) {
  return (
    <div>
      <p id={id} className="text-[13px] font-medium text-text">
        {children}
      </p>
      <p className="mt-0.5 text-xs text-muted">{hint}</p>
    </div>
  );
}

/**
 * A choice of two or three, drawn as a segmented control but made of real radio buttons: arrow keys
 * move between the options, and a screen reader hears "Table density, Compact, 2 of 2".
 */
function Segmented<T extends string>({
  legend,
  hint,
  value,
  onChange,
  options,
}: {
  legend: string;
  hint: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
}) {
  const name = useId();
  const hintId = `${name}-hint`;
  return (
    <fieldset className="py-4 last:pb-0" aria-describedby={hintId}>
      <legend className="float-left w-full text-[13px] font-medium text-text">{legend}</legend>
      <p id={hintId} className="clear-left pt-0.5 text-xs text-muted">
        {hint}
      </p>
      <div className="mt-2 inline-flex rounded-base border border-line bg-surface-sunken p-0.5">
        {options.map((option) => {
          const chosen = option.value === value;
          return (
            <label
              key={option.value}
              className={cn(
                "inline-flex h-7 cursor-pointer items-center rounded-[6px] px-3 text-[13px] font-medium whitespace-nowrap transition-colors duration-150",
                // The input is visually hidden, so its focus ring is drawn on the segment around it.
                "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus",
                chosen ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text",
              )}
            >
              <input type="radio" name={name} value={option.value} checked={chosen} onChange={() => onChange(option.value)} className="sr-only" />
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
