"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { endSession } from "@/actions/access-control";
import { Badge } from "@/components/ui/card";
import { ActionNotice } from "@/components/ui/action-notice";

export type MySignIn = { id: string; atText: string; place: string | null; ip: string | null; device: string | null; current: boolean; ended: boolean; located: boolean };
export type MyDevice = { id: string; label: string; kindLabel: string; statusLabel: string; tone: "default" | "green" | "red" | "amber"; lastText: string; place: string | null };

/**
 * Your own devices and sign-ins, on your profile. Everything the security admins can see about where
 * you signed in, you can see too — and a session you don't recognise, you can end yourself.
 */
export function MyAccess({ devices, signIns }: { devices: MyDevice[]; signIns: MySignIn[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-subtle">Devices</div>
        {devices.length === 0 ? (
          <p className="text-sm text-subtle">None recorded yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {devices.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-text">
                  {d.label} <span className="text-muted">· {d.kindLabel.toLowerCase()}</span>
                </span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  {d.place && <span>{d.place}</span>}
                  <span>{d.lastText}</span>
                  <Badge tone={d.tone}>{d.statusLabel}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-subtle">Recent sign-ins</div>
        {error && <ActionNotice tone="error">{error}</ActionNotice>}
        <ul className="space-y-1.5">
          {signIns.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-text">
                {s.atText}
                <span className="text-muted">
                  {" "}
                  · {s.place ?? "location unknown"}
                  {s.device ? ` · ${s.device}` : ""}
                  {s.located ? " · location shared" : ""}
                </span>
              </span>
              <span className="flex items-center gap-2">
                {s.current && <Badge tone="green">This session</Badge>}
                {s.ended && <Badge>Ended</Badge>}
                {!s.current && !s.ended && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        setError(null);
                        const result = await endSession(s.id);
                        if (!result.ok) setError(result.error);
                        else router.refresh();
                      })
                    }
                    className="rounded-full border border-line px-2 py-0.5 text-[11px] font-medium text-muted hover:bg-surface-sunken hover:text-text"
                  >
                    End it
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
