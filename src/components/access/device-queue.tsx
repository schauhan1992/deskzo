"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Laptop, Smartphone, Tablet } from "lucide-react";
import type { DeviceKind, DeviceStatus } from "@prisma/client";
import { decideDevice } from "@/actions/access-control";
import { Badge, Card } from "@/components/ui/card";
import { ActionNotice } from "@/components/ui/action-notice";

export type DeviceRow = {
  id: string;
  kind: DeviceKind;
  label: string;
  status: DeviceStatus;
  auto: boolean;
  firstSeenText: string;
  lastSeenText: string;
  lastIp: string | null;
  lastPlace: string | null;
  decisionNote: string | null;
  decidedBy: string | null;
  user: { id: string; name: string; role: string; active: boolean };
  mine: boolean;
};

const ICON: Record<DeviceKind, typeof Laptop> = { MOBILE: Smartphone, TABLET: Tablet, COMPUTER: Laptop };
const STATUS: Record<DeviceStatus, { label: string; tone: "default" | "green" | "red" | "amber" }> = {
  PENDING: { label: "Waiting for approval", tone: "amber" },
  APPROVED: { label: "Approved", tone: "green" },
  REJECTED: { label: "Rejected", tone: "red" },
  REVOKED: { label: "Revoked", tone: "red" },
};

/**
 * The devices people sign in on, and the approval queue at the top of it.
 *
 * Revoking ends every session open on the device — the confirmation says so, because that is the
 * point of it: it is how a lost laptop stops being signed in.
 */
export function DeviceQueue({ rows, canDecide }: { rows: DeviceRow[]; canDecide: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const decide = (row: DeviceRow, decision: "APPROVE" | "REJECT" | "REVOKE") => {
    const note =
      decision === "APPROVE"
        ? ""
        : window.prompt(
            decision === "REVOKE"
              ? `Revoke ${row.user.name}'s ${row.label}? Every session open on it ends now. Reason (optional):`
              : `Reject ${row.user.name}'s ${row.label}? Reason (optional):`,
            "",
          );
    if (note === null) return;
    setNotice(null);
    startTransition(async () => {
      const result = await decideDevice(row.id, decision, note || undefined);
      if (!result.ok) {
        setNotice({ tone: "error", text: result.error });
        return;
      }
      setNotice({
        tone: "success",
        text:
          decision === "APPROVE"
            ? `${row.user.name}'s ${row.label} is approved. They're told, and the page they're waiting on lets them in.`
            : `${row.user.name}'s ${row.label} is ${decision === "REJECT" ? "rejected" : "revoked"}${result.data.endedSessions ? `, and ${result.data.endedSessions} open session${result.data.endedSessions === 1 ? " was" : "s were"} ended` : ""}.`,
      });
      router.refresh();
    });
  };

  return (
    <div className="space-y-2">
      {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
      {rows.length === 0 ? (
        <Card className="px-4 py-10 text-center text-sm text-subtle">No devices match that.</Card>
      ) : (
        <Card className="divide-y divide-line">
          {rows.map((row) => {
            const Icon = ICON[row.kind];
            const status = STATUS[row.status];
            return (
              <div key={row.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                <div className="flex min-w-0 items-start gap-3">
                  <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted" aria-hidden />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-text">{row.user.name}</span>
                      <span className="text-sm text-muted">{row.label}</span>
                      <Badge tone={status.tone}>{status.label}</Badge>
                      {row.auto && <span className="text-[11px] text-subtle">allowed automatically</span>}
                      {!row.user.active && <Badge>Account inactive</Badge>}
                    </div>
                    <div className="text-xs text-muted">
                      {row.lastPlace ?? "Location unknown"}
                      {row.lastIp && <span className="font-mono text-subtle"> · {row.lastIp}</span>}
                    </div>
                    <div className="text-[11px] text-subtle">
                      First seen {row.firstSeenText} · last used {row.lastSeenText}
                      {row.decidedBy && ` · ${row.status === "APPROVED" ? "approved" : "decided"} by ${row.decidedBy}`}
                      {row.decisionNote && ` — "${row.decisionNote}"`}
                    </div>
                  </div>
                </div>
                {canDecide && !row.mine && (
                  <div className="flex flex-wrap gap-1.5">
                    {row.status !== "APPROVED" && (
                      <Action disabled={pending} onClick={() => decide(row, "APPROVE")}>
                        Approve
                      </Action>
                    )}
                    {row.status === "PENDING" && (
                      <Action danger disabled={pending} onClick={() => decide(row, "REJECT")}>
                        Reject
                      </Action>
                    )}
                    {row.status === "APPROVED" && (
                      <Action danger disabled={pending} onClick={() => decide(row, "REVOKE")}>
                        Revoke
                      </Action>
                    )}
                  </div>
                )}
                {canDecide && row.mine && <span className="text-[11px] text-subtle">Your own — somebody else decides</span>}
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}

function Action({ children, onClick, disabled, danger }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${danger ? "border-danger/40 text-danger hover:bg-danger-bg" : "border-line text-text hover:bg-surface-sunken"}`}
    >
      {children}
    </button>
  );
}
