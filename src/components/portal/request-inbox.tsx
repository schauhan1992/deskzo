"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MessageSquare, RefreshCw, UserPlus } from "lucide-react";
import { setPortalRequestStatus, type PortalRequestRow } from "@/actions/portal";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";

/**
 * What customers have asked for.
 *
 * Read as a queue rather than a report: new at the top, one click to pick something up, and a reply
 * recorded when it is closed. The reply is the part that matters — "declined" with no reason is a
 * row somebody will ask about in three weeks and nobody will be able to answer.
 */

const KIND = {
  RENEWAL: { label: "Renew", icon: RefreshCw, tone: "brand" as const },
  ADD_SEATS: { label: "More licences", icon: UserPlus, tone: "blue" as const },
  QUESTION: { label: "Question", icon: MessageSquare, tone: "default" as const },
};

const STATUS_TONE = { NEW: "red", IN_PROGRESS: "amber", DONE: "green", DECLINED: "default" } as const;

export function RequestInbox({ rows }: { rows: PortalRequestRow[] }) {
  const router = useRouter();
  const clock = useClock();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [closing, setClosing] = useState<{ id: string; status: "DONE" | "DECLINED" } | null>(null);
  const [response, setResponse] = useState("");
  const [filter, setFilter] = useState<"open" | "all">("open");

  const shown = filter === "open" ? rows.filter((r) => r.status === "NEW" || r.status === "IN_PROGRESS") : rows;

  const move = (id: string, status: "NEW" | "IN_PROGRESS" | "DONE" | "DECLINED", note?: string) => {
    setBusy(id);
    startTransition(async () => {
      await setPortalRequestStatus({ requestId: id, status, response: note ?? null });
      setBusy(null);
      setClosing(null);
      setResponse("");
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-1 border-b border-line">
        {(["open", "all"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`border-b-2 px-3 py-2 text-sm font-medium ${
              filter === f ? "border-brand text-text" : "border-transparent text-muted hover:text-text"
            }`}
          >
            {f === "open"
              ? `Open (${rows.filter((r) => r.status === "NEW" || r.status === "IN_PROGRESS").length})`
              : `Everything (${rows.length})`}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted">
            {filter === "open" ? "Nothing waiting." : "No customer has asked for anything yet."}
          </CardContent>
        </Card>
      ) : (
        shown.map((r) => {
          const kind = KIND[r.kind];
          const Icon = kind.icon;
          return (
            <Card key={r.id}>
              <CardContent className="space-y-2 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={kind.tone}>
                        <Icon className="h-3 w-3" />
                        {kind.label}
                      </Badge>
                      <Badge tone={STATUS_TONE[r.status]}>{r.status.toLowerCase().replace("_", " ")}</Badge>
                      <span className="text-xs text-muted">{clock.dateTimeShort(r.createdAt)}</span>
                    </div>
                    <p className="mt-1 text-sm font-medium text-text">
                      <Link href={`/companies/${r.companyId}`} className="text-brand hover:underline">
                        {r.companyName}
                      </Link>
                      <span className="font-normal text-muted"> · {r.personName}</span>
                      {r.personEmail && <span className="font-normal text-subtle"> · {r.personEmail}</span>}
                    </p>
                    {r.subscriptionName && (
                      <p className="text-sm text-muted">
                        {r.subscriptionName}
                        {r.quantity ? ` · ${r.quantity} more licence${r.quantity === 1 ? "" : "s"}` : ""}
                      </p>
                    )}
                    {r.message && <p className="mt-1 text-sm text-text">{r.message}</p>}
                  </div>
                </div>

                {r.status === "DONE" || r.status === "DECLINED" ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-base bg-surface-sunken px-3 py-2">
                    <p className="text-xs text-muted">
                      {r.handledByName ? `${r.handledByName}` : "Closed"}
                      {r.handledAt ? ` · ${clock.dateTimeShort(r.handledAt)}` : ""}
                      {r.response ? ` — ${r.response}` : ""}
                    </p>
                    <Button variant="ghost" size="sm" disabled={busy === r.id} onClick={() => move(r.id, "NEW")}>
                      Reopen
                    </Button>
                  </div>
                ) : closing?.id === r.id ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      autoFocus
                      className="min-w-48 flex-1"
                      // Nothing visible names this box, and the placeholder vanishes on the first
                      // keystroke — so the name has to say which of the two closes is being written.
                      aria-label={closing.status === "DONE" ? "What was done" : "Reason for declining"}
                      placeholder={closing.status === "DONE" ? "Quoted and sent — QT-1043" : "Why not?"}
                      value={response}
                      onChange={(e) => setResponse(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") move(r.id, closing.status, response);
                        if (e.key === "Escape") setClosing(null);
                      }}
                    />
                    <Button size="sm" disabled={busy === r.id} onClick={() => move(r.id, closing.status, response)}>
                      {closing.status === "DONE" ? "Mark done" : "Decline"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setClosing(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {r.status === "NEW" && (
                      <Button size="sm" variant="secondary" disabled={busy === r.id} onClick={() => move(r.id, "IN_PROGRESS")}>
                        I&rsquo;ll take this
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setClosing({ id: r.id, status: "DONE" });
                        setResponse("");
                      }}
                    >
                      Done
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setClosing({ id: r.id, status: "DECLINED" });
                        setResponse("");
                      }}
                    >
                      Decline
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}
