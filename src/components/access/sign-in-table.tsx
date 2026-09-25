"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LogOut, MapPin } from "lucide-react";
import { endSession } from "@/actions/access-control";
import { Badge, Card } from "@/components/ui/card";
import { OutboundLink } from "@/components/ui/outbound-link";
import { ActionNotice } from "@/components/ui/action-notice";

export type SignInRow = {
  id: string;
  atText: string;
  lastSeenText: string;
  user: { id: string; name: string; role: string };
  ip: string | null;
  place: string | null;
  deviceLabel: string | null;
  deviceKindLabel: string | null;
  provider: string;
  gps: { lat: number; lng: number; accuracyM: number | null } | null;
  flags: string[];
  ended: string | null;
  active: boolean;
};

const FLAG: Record<string, { label: string; tone: "amber" | "red" | "blue" }> = {
  NEW_DEVICE: { label: "New device", tone: "blue" },
  NEW_NETWORK: { label: "New network", tone: "blue" },
  IMPOSSIBLE_TRAVEL: { label: "Impossible travel", tone: "red" },
};

/** OpenStreetMap at the reported point. Opened in a new tab with no referrer — see OutboundLink. */
function mapHref(lat: number, lng: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
}

/**
 * Sign-ins, newest first: who, when, from which network and roughly where, on what — and, for a role
 * that records it, where the device said it was.
 */
export function SignInTable({ rows, canEnd }: { rows: SignInRow[]; canEnd: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  if (rows.length === 0) return <Card className="px-4 py-10 text-center text-sm text-subtle">No sign-ins match that.</Card>;

  return (
    <div className="space-y-2">
      {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[48rem] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="px-3 py-2 font-medium">Who</th>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Network (approximate)</th>
              <th className="px-3 py-2 font-medium">Device location</th>
              <th className="px-3 py-2 font-medium">Device</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-line align-top last:border-0">
                <td className="px-3 py-2.5">
                  <div className="font-medium text-text">{row.user.name}</div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {row.flags.map((f) => (
                      <Badge key={f} tone={FLAG[f]?.tone ?? "amber"}>
                        {FLAG[f]?.label ?? f}
                      </Badge>
                    ))}
                    {row.active && <Badge tone="green">Active now</Badge>}
                    {row.ended && <Badge>{row.ended}</Badge>}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted">
                  <div className="text-text">{row.atText}</div>
                  <div>last seen {row.lastSeenText}</div>
                </td>
                <td className="px-3 py-2.5 text-xs">
                  <div className="text-text">{row.place ?? "Unknown"}</div>
                  {row.ip && <div className="font-mono text-subtle">{row.ip}</div>}
                </td>
                <td className="px-3 py-2.5 text-xs">
                  {row.gps ? (
                    <OutboundLink href={mapHref(row.gps.lat, row.gps.lng)} className="inline-flex items-center gap-1 text-brand hover:underline">
                      <MapPin className="h-3 w-3" aria-hidden />
                      {row.gps.lat.toFixed(5)}, {row.gps.lng.toFixed(5)}
                      {row.gps.accuracyM !== null && <span className="text-subtle"> ±{row.gps.accuracyM} m</span>}
                    </OutboundLink>
                  ) : (
                    <span className="text-subtle">Not asked</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-xs">
                  <div className="text-text">{row.deviceLabel ?? "—"}</div>
                  <div className="text-subtle">
                    {row.deviceKindLabel}
                    {row.provider === "microsoft-entra-id" ? " · Microsoft" : ""}
                  </div>
                </td>
                <td className="px-2 py-2.5 text-right">
                  {canEnd && !row.ended && (
                    <button
                      type="button"
                      title="End this session"
                      aria-label={`End ${row.user.name}'s session`}
                      disabled={pending}
                      onClick={() => {
                        if (!window.confirm(`End ${row.user.name}'s session from ${row.atText}? They'll be sent back to sign in within seconds.`)) return;
                        setNotice(null);
                        startTransition(async () => {
                          const result = await endSession(row.id);
                          if (!result.ok) setNotice({ tone: "error", text: result.error });
                          else {
                            setNotice({ tone: "success", text: `${row.user.name}'s session is ended.` });
                            router.refresh();
                          }
                        });
                      }}
                      className="rounded p-1.5 text-muted hover:bg-surface-sunken hover:text-danger"
                    >
                      <LogOut className="h-4 w-4" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
