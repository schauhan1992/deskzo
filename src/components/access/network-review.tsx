"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { allowNetwork, blockNetwork, dismissNetwork } from "@/actions/access-control";
import { Badge, Card } from "@/components/ui/card";
import { ActionNotice } from "@/components/ui/action-notice";

export type NetworkRow = {
  ip: string;
  place: string | null;
  isPrivate: boolean;
  standing: "ALLOWED" | "BLOCKED" | "UNKNOWN";
  rule: string | null;
  lastUserName: string | null;
  firstSeenText: string;
  lastSeenText: string;
  held: boolean;
  alerted: boolean;
  dismissed: boolean;
};

/**
 * Addresses people have arrived from. Allowing or blocking one writes a rule for that single address
 * for everybody — a range, or a rule for some roles only, is written on the Rules tab.
 */
export function NetworkReview({ rows }: { rows: NetworkRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const run = (work: () => Promise<{ ok: true } | { ok: false; error: string }>, success: string) => {
    setNotice(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) setNotice({ tone: "error", text: result.error });
      else {
        setNotice({ tone: "success", text: success });
        router.refresh();
      }
    });
  };

  return (
    <div className="space-y-2">
      {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
      {rows.length === 0 ? (
        <Card className="px-4 py-10 text-center text-sm text-subtle">Nothing to review. New addresses land here when a role asks to be told about them or to hold people on them.</Card>
      ) : (
        <Card className="divide-y divide-line">
          {rows.map((row) => (
            <div key={row.ip} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-text">{row.ip}</span>
                  {row.standing === "ALLOWED" && <Badge tone="green">Allowed{row.rule ? ` · ${row.rule}` : ""}</Badge>}
                  {row.standing === "BLOCKED" && <Badge tone="red">Blocked{row.rule ? ` · ${row.rule}` : ""}</Badge>}
                  {row.standing === "UNKNOWN" && row.held && <Badge tone="amber">Somebody was held</Badge>}
                  {row.standing === "UNKNOWN" && !row.held && row.alerted && <Badge tone="blue">New</Badge>}
                  {row.isPrivate && <Badge>Private network</Badge>}
                </div>
                <div className="text-xs text-muted">
                  {row.place ?? (row.isPrivate ? "Inside a private network — no location" : "Location unknown")}
                </div>
                <div className="text-[11px] text-subtle">
                  {row.lastUserName ? `Last: ${row.lastUserName}` : ""} · first seen {row.firstSeenText} · last {row.lastSeenText}
                </div>
              </div>
              {row.standing === "UNKNOWN" && (
                <div className="flex flex-wrap gap-1.5">
                  <Action
                    disabled={pending}
                    onClick={() => {
                      const name = window.prompt(`Name this network (e.g. "Pune office") — ${row.ip} will be allowed for everybody.`, row.place ?? "");
                      if (name !== null) run(() => allowNetwork(row.ip, name), `${row.ip} is allowed.`);
                    }}
                  >
                    Allow
                  </Action>
                  <Action
                    danger
                    disabled={pending}
                    onClick={() => {
                      const why = window.prompt(`Why block ${row.ip}? Everybody on it will be signed out and refused.`, "");
                      if (why !== null) run(() => blockNetwork(row.ip, why), `${row.ip} is blocked.`);
                    }}
                  >
                    Block
                  </Action>
                  {!row.dismissed && (
                    <Action disabled={pending} onClick={() => run(() => dismissNetwork(row.ip), "Set aside. Anybody held on it stays held.")}>
                      Set aside
                    </Action>
                  )}
                </div>
              )}
            </div>
          ))}
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
