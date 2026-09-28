"use client";

import { useId, useState } from "react";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { cmsSetTwoFactorPolicy } from "@/actions/cms/settings";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { useCmsAction } from "@/components/cms/common/use-cms-action";
import { plural } from "@/lib/console-shared/format";
import type { CmsTwoFactorMode } from "@/lib/cms/types";
import { cn } from "@/lib/utils";

const CHOICES: { value: CmsTwoFactorMode; title: string; body: string; icon: typeof ShieldCheck }[] = [
  { value: "required", title: "Required", body: "Everyone signs in with a password and a code from an authenticator app. Anybody without one sets it up before anything else opens.", icon: ShieldCheck },
  { value: "optional", title: "Optional", body: "People who set up an authenticator are asked for its code; everybody else signs in with a password alone.", icon: ShieldOff },
];

/**
 * The CMS's two-factor policy, for admins: two radio cards, and choosing the other one asks first —
 * with who it affects. The cards show the policy in force; they move only once the change is saved
 * (src/actions/cms/settings.ts cmsSetTwoFactorPolicy, which writes the activity log).
 */
export function TwoFactorPolicy({
  mode,
  chosen,
  production,
  withoutAuthenticator,
  meEnrolled,
}: {
  mode: CmsTwoFactorMode;
  /** An admin chose it; otherwise it follows the installation (required in production). */
  chosen: boolean;
  production: boolean;
  /** Active people with no authenticator set up. */
  withoutAuthenticator: number;
  /** The admin looking at this has an authenticator. */
  meEnrolled: boolean;
}) {
  const name = useId();
  const descId = useId();
  const action = useCmsAction<{ mode: CmsTwoFactorMode }>();
  const [asking, setAsking] = useState<CmsTwoFactorMode | null>(null);

  function close() {
    if (action.pending) return;
    setAsking(null);
    action.reset();
  }

  function confirm() {
    if (!asking) return;
    const next = asking;
    action.run(() => cmsSetTwoFactorPolicy(next), {
      success: next === "required" ? "Two-factor is now required for everybody in the CMS." : "Two-factor is now optional in the CMS.",
      onDone: () => setAsking(null),
    });
  }

  return (
    <>
      <fieldset aria-describedby={descId}>
        <legend className="text-sm font-medium text-text">Two-factor sign-in</legend>
        <p id={descId} className="mt-0.5 text-xs text-muted">
          {chosen
            ? "Chosen by an admin — it stays this way until an admin changes it."
            : "Not chosen yet, so it follows this installation: required in production, optional elsewhere. Choosing one fixes it."}
        </p>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
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
      </fieldset>

      <ConfirmDialog
        open={asking !== null}
        onClose={close}
        title={asking === "optional" ? "Make two-factor optional" : "Require two-factor"}
        confirmLabel={asking === "optional" ? "Make it optional" : "Require it"}
        tone={asking === "optional" ? "danger" : "primary"}
        checks={asking === "optional" ? ["I understand a password alone will open the CMS for anybody without an authenticator."] : undefined}
        pending={action.pending}
        error={action.error}
        onConfirm={confirm}
      >
        {asking === "optional" ? (
          <>
            <ImpactList items={[{ label: "Two-factor", value: "Required → Optional", tone: "danger" }]} />
            <p>Authenticators already set up keep being asked for. Anybody without one signs in with a password alone — and can publish to the public site with it.</p>
            {production && <p className="font-medium text-danger">This is the production installation.</p>}
          </>
        ) : (
          <>
            <ImpactList
              items={[
                { label: "Two-factor", value: "Optional → Required", tone: "success" },
                { label: "Without an authenticator", value: withoutAuthenticator === 0 ? "Nobody" : plural(withoutAuthenticator, "person", "people"), tone: withoutAuthenticator ? "warning" : undefined },
              ]}
            />
            <p>
              {withoutAuthenticator === 0
                ? "Everybody already has an authenticator; nothing changes for them but the rule."
                : `${plural(withoutAuthenticator, "person", "people")} without one ${withoutAuthenticator === 1 ? "is" : "are"} asked to set one up on their next page, before anything else opens.`}
              {!meEnrolled && " That includes you — you'll set yours up straight after."}
            </p>
          </>
        )}
      </ConfirmDialog>
    </>
  );
}
