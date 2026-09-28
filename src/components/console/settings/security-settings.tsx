"use client";

import { useId, useState } from "react";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { consoleSetStaffTwoFactor } from "@/actions/platform/console";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { cn } from "@/lib/utils";
import { ChangedBy } from "./signup-settings";
import type { SettingChange } from "./signup-settings";

type Mode = "required" | "off";

const CHOICES: { value: Mode; title: string; body: string; icon: typeof ShieldCheck }[] = [
  { value: "required", title: "Required", body: "Everyone signs in with a password and a code from their authenticator app.", icon: ShieldCheck },
  { value: "off", title: "Off", body: "A password alone. Authenticators already set up are kept for when it is required again.", icon: ShieldOff },
];

/**
 * Whether staff need an authenticator to reach the console, for an owner (spec §3.18): two radio
 * cards, and choosing the other one asks first. Turning it off shows what that opens up and needs
 * an "I understand"; requiring it says who is asked for a code next — the owner changing it
 * included, when they signed in with a password alone. The cards show the policy in force; they
 * move only once the change is saved.
 */
export function TwoFactorPolicyEditor({
  mode,
  chosen,
  production = false,
  change,
}: {
  mode: Mode;
  /** An owner chose it; otherwise it follows the environment (required in production, off elsewhere). */
  chosen: boolean;
  /** This is the production installation. */
  production?: boolean;
  /** Who last set the policy, and when. */
  change?: SettingChange | null;
}) {
  const name = useId();
  const descId = useId();
  const action = useConsoleAction<null>();
  const [asking, setAsking] = useState<Mode | null>(null);

  function close() {
    setAsking(null);
    action.reset();
  }

  function confirm() {
    if (!asking) return;
    const next = asking;
    action.run(() => consoleSetStaffTwoFactor(next), {
      success: next === "off" ? "Two-factor turned off for staff." : "Two-factor is now required of every staff member.",
      onDone: () => setAsking(null),
    });
  }

  return (
    <>
      <fieldset aria-describedby={descId}>
        <legend className="text-sm font-medium text-text">Two-factor for staff</legend>
        <p id={descId} className="mt-0.5 text-xs text-muted">
          {chosen
            ? "Chosen by an owner — it stays this way whatever the installation."
            : `Not chosen yet, so it follows this installation: required in production, off elsewhere. Choosing one fixes it.`}
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {CHOICES.map((choice) => {
            const checked = mode === choice.value;
            const Icon = choice.icon;
            return (
              <label
                key={choice.value}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-3 transition-colors",
                  checked ? "border-brand bg-brand-subtle" : "border-line hover:bg-surface-sunken",
                  action.pending && "cursor-wait",
                )}
              >
                <input
                  type="radio"
                  name={name}
                  value={choice.value}
                  checked={checked}
                  disabled={action.pending}
                  onChange={() => {
                    if (choice.value === mode) return;
                    action.reset();
                    setAsking(choice.value);
                  }}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand)]"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-text">
                    <Icon aria-hidden="true" className={cn("h-4 w-4", choice.value === "required" ? "text-success" : "text-warning")} />
                    {choice.title}
                    {checked && <span className="text-[11px] font-normal text-muted">· in force</span>}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">{choice.body}</span>
                </span>
              </label>
            );
          })}
        </div>
        <ChangedBy change={change} className="mt-2" never="Not changed yet — the installation's default" />
      </fieldset>

      <ConfirmDialog
        open={asking !== null}
        onClose={close}
        title={asking === "off" ? "Turn two-factor off" : "Require two-factor"}
        confirmLabel={asking === "off" ? "Turn it off" : "Require it"}
        tone={asking === "off" ? "danger" : "primary"}
        checks={asking === "off" ? ["I understand a staff password alone will open the console."] : undefined}
        pending={action.pending}
        error={action.error}
        onConfirm={confirm}
      >
        {asking === "off" ? (
          <>
            <ImpactList items={[{ label: "Two-factor for staff", value: "Required → Off", tone: "danger" }]} />
            <p>
              Anyone with a staff password reaches the console — no code is asked for, owners included. Authenticators already set up are kept, for when
              it is required again.
            </p>
            {production && (
              <p className="font-medium text-danger">This is the production installation: System health counts two-factor off as failing.</p>
            )}
          </>
        ) : (
          <>
            <ImpactList items={[{ label: "Two-factor for staff", value: "Off → Required", tone: "success" }]} />
            <p>
              Everyone signed in without a code is asked for one on their next page — you too, if you signed in with a password alone. Staff who never set
              up an authenticator set one up before they get in.
            </p>
          </>
        )}
      </ConfirmDialog>
    </>
  );
}
