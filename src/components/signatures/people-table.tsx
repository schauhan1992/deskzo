"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { syncSignaturesNow } from "@/actions/signature";
import { useClock } from "@/components/time/clock-provider";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type SignaturePersonRow = {
  userId: string;
  name: string;
  email: string;
  template: string;
  /** In their mailbox and the same as it would be drawn now. */
  state: "current" | "changed" | "pending" | "failed" | "skipped" | "none";
  syncedAt: string | null;
  error: string | null;
  /** When the Outlook add-in last fetched their signature, and whether it was the one they have now. */
  outlook: { at: string; current: boolean } | null;
};

const BADGE: Record<SignaturePersonRow["state"], { tone: "green" | "amber" | "red" | "default"; label: string }> = {
  current: { tone: "green", label: "In their mailbox" },
  changed: { tone: "amber", label: "Changed — goes out next" },
  pending: { tone: "amber", label: "Waiting to go out" },
  failed: { tone: "red", label: "Failed" },
  skipped: { tone: "default", label: "No mailbox" },
  none: { tone: "default", label: "Not sent" },
};

/**
 * Everybody's signature: which template, whether it is in their Gmail or Zoho Mail — with Sync now — and,
 * with the Outlook add-in on, when Outlook last fetched it. Outlook can't be synced: it asks for itself.
 */
export function SignaturePeopleTable({ rows, connected, outlookOn }: { rows: SignaturePersonRow[]; connected: boolean; outlookOn: boolean }) {
  const showMailbox = connected || !outlookOn;
  const router = useRouter();
  const clock = useClock();
  const [q, setQ] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? rows.filter((r) => `${r.name} ${r.email} ${r.template}`.toLowerCase().includes(needle)) : rows;
  }, [rows, q]);

  const sync = (userIds?: string[]) =>
    start(async () => {
      setMessage(null);
      const result = await syncSignaturesNow(userIds);
      if (!result.ok) return setMessage({ ok: false, text: result.error });
      const r = result.data;
      if (r.stopped) setMessage({ ok: false, text: r.stopped });
      else
        setMessage({
          ok: r.failed === 0,
          text: [`${r.synced} put in`, r.failed ? `${r.failed} failed` : null, r.skipped ? `${r.skipped} with no mailbox` : null, r.waiting ? `${r.waiting} left for the next run` : null].filter(Boolean).join(", ") + ".",
        });
      router.refresh();
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-xs" placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
        {connected && (
          <Button type="button" className="ml-auto" disabled={pending} onClick={() => sync()}>
            <RefreshCw className={pending ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            {pending ? "Putting them in…" : "Sync everybody now"}
          </Button>
        )}
      </div>
      {!connected && !outlookOn && (
        <p className="text-sm text-muted">Connect Google Workspace, Zoho Mail or the Outlook add-in (Connection tab) to put signatures into mailboxes. Until then, people copy theirs from My email signature.</p>
      )}
      {!connected && outlookOn && <p className="text-sm text-muted">Outlook asks for each person&apos;s signature as they write, so there is nothing to sync: a change reaches their next message.</p>}
      {message && <p className={message.ok ? "text-sm text-success" : "text-sm text-danger"}>{message.text}</p>}
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="border-b border-line text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Person</th>
              <th className="px-3 py-2 font-medium">Template</th>
              {showMailbox && <th className="px-3 py-2 font-medium">In their mailbox</th>}
              {outlookOn && <th className="px-3 py-2 font-medium">In Outlook</th>}
              {connected && <th className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.map((r) => (
              <tr key={r.userId}>
                <td className="px-3 py-2 align-top">
                  <p className="font-medium text-text">{r.name}</p>
                  <p className="text-xs text-muted">{r.email}</p>
                </td>
                <td className="px-3 py-2 align-top text-muted">{r.template}</td>
                {showMailbox && (
                  <td className="px-3 py-2 align-top">
                    <Badge tone={BADGE[r.state].tone}>{BADGE[r.state].label}</Badge>
                    {r.syncedAt && r.state === "current" && <p className="mt-1 text-xs text-subtle">{clock.dateTimeShort(r.syncedAt)}</p>}
                    {r.error && r.state !== "current" && <p className="mt-1 max-w-sm text-xs text-danger">{r.error}</p>}
                  </td>
                )}
                {outlookOn && (
                  <td className="px-3 py-2 align-top">
                    {r.outlook ? (
                      <>
                        <Badge tone={r.outlook.current ? "green" : "amber"}>{r.outlook.current ? "Fetched" : "Older one — next message"}</Badge>
                        <p className="mt-1 text-xs text-subtle">{clock.dateTimeShort(r.outlook.at)}</p>
                      </>
                    ) : (
                      <Badge>Not yet</Badge>
                    )}
                  </td>
                )}
                {connected && (
                  <td className="px-3 py-2 text-right align-top">
                    <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => sync([r.userId])}>
                      Sync
                    </Button>
                  </td>
                )}
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={2 + (showMailbox ? 1 : 0) + (outlookOn ? 1 : 0) + (connected ? 1 : 0)} className="px-3 py-8 text-center text-muted">
                  Nobody matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
