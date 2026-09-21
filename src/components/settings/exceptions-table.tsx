"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CalendarClock, Infinity as InfinityIcon, ShieldOff, Trash2 } from "lucide-react";
import { clearUserPermission, extendUserPermission, type listPermissionExceptions } from "@/actions/access";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";

type Result = Awaited<ReturnType<typeof listPermissionExceptions>>;
type Row = Result["rows"][number];

/**
 * Every personal exception in the company, on one screen.
 *
 * The app could describe one person's access in detail and had no way at all to answer "what
 * temporary access is live right now" — the question an access review starts with. Finding a lapsed
 * grant meant opening thirty drawers.
 *
 * Ordered by what needs doing rather than alphabetically: what has already lapsed, then what lapses
 * soonest, then the permanent ones. A list sorted by name is a list nobody acts on.
 */

const TIER_TONE: Record<string, "red" | "amber" | "default"> = {
  critical: "red",
  sensitive: "amber",
  standard: "default",
};

function daysUntil(date: Date | string) {
  const ms = new Date(date).getTime() - Date.now();
  return Math.ceil(ms / 86_400_000);
}

export function ExceptionsTable({ result, mayManage }: { result: Result; mayManage: boolean }) {
  const rows = result.rows;
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyLive, setOnlyLive] = useState(false);

  const shown = onlyLive ? rows.filter((r) => !r.expired) : rows;
  const lapsed = result.lapsed;
  const soon = result.endingSoon;

  const act = (id: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(id);
    setError(null);
    startTransition(async () => {
      const result = (await fn()) as { ok: boolean; error?: string };
      setBusy(null);
      if (!result.ok) setError(result.error ?? "That didn't work.");
      else router.refresh();
    });
  };

  if (rows.length === 0) {
    return (
      <Card className="px-6 py-10 text-center text-sm text-muted">
        Nobody has a personal exception. Everyone&rsquo;s access comes from their role, or from a report they
        manage.
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {lapsed > 0 && (
          <span className="flex items-center gap-1.5 rounded-base border border-warning/40 bg-warning-bg px-2.5 py-1 text-sm text-warning">
            <AlertTriangle className="h-3.5 w-3.5" />
            {lapsed} lapsed — no longer in force, still on file
          </span>
        )}
        {soon > 0 && (
          <span className="flex items-center gap-1.5 rounded-base bg-surface-sunken px-2.5 py-1 text-sm text-muted">
            <CalendarClock className="h-3.5 w-3.5" />
            {soon} ending within a week
          </span>
        )}
        {result.total > result.shown && (
          <span className="text-sm text-subtle">
            {/* Never a silent truncation: a list that just stops reads as "that is all of them". */}
            showing {result.shown} of {result.total}, most urgent first
          </span>
        )}
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={onlyLive} onChange={() => setOnlyLive((v) => !v)} className="h-4 w-4" />
          Only what is still in force
        </label>
      </div>

      {error && (
        <p className="rounded-base border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>
      )}

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Person</th>
              <th className="px-4 py-2.5">Permission</th>
              <th className="px-4 py-2.5">Why</th>
              <th className="px-4 py-2.5">Granted</th>
              <th className="px-4 py-2.5">Ends</th>
              {mayManage && <th className="px-4 py-2.5 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const id = `${r.userId}:${r.permission}`;
              const days = r.expiresAt ? daysUntil(r.expiresAt) : null;
              return (
                <tr
                  key={id}
                  className={`border-b border-line last:border-0 ${r.expired ? "opacity-60" : "hover:bg-surface-sunken"}`}
                >
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-text">{r.userName}</span>
                      <Badge>{r.userRole}</Badge>
                      {!r.userActive && <Badge tone="red">Deactivated</Badge>}
                    </div>
                    <span className="text-xs text-subtle">{r.userEmail}</span>
                  </td>

                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {/*
                        Allow and deny are opposite acts and were rendered identically. A deny is
                        the only way to take one capability off one admin, so it is the row that
                        must not be mistaken for a grant.
                      */}
                      {r.allowed ? (
                        <Badge tone="green">Granted</Badge>
                      ) : (
                        <Badge tone="red">
                          <ShieldOff className="h-3 w-3" />
                          Denied
                        </Badge>
                      )}
                      <span className="text-text">{r.label}</span>
                      {r.tier !== "standard" && <Badge tone={TIER_TONE[r.tier] ?? "default"}>{r.tier}</Badge>}
                    </div>
                  </td>

                  <td className="max-w-64 px-4 py-2.5 text-muted">
                    {r.reason || <span className="text-subtle">No reason recorded</span>}
                  </td>

                  <td className="whitespace-nowrap px-4 py-2.5 text-muted">
                    {formatDate(r.grantedOn)}
                    <span className="block text-xs text-subtle">
                      {/* A null grantor is what the seeder writes — not a departed employee. */}
                      {r.grantedByName ? `by ${r.grantedByName}` : "grantor not recorded"}
                    </span>
                  </td>

                  <td className="whitespace-nowrap px-4 py-2.5">
                    {r.expired ? (
                      <Badge tone="amber">Lapsed {formatDate(r.expiresAt!)}</Badge>
                    ) : r.expiresAt ? (
                      <span className={days !== null && days <= 7 ? "text-warning" : "text-muted"}>
                        {formatDate(r.expiresAt)}
                        <span className="block text-xs text-subtle">
                          {days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`}
                        </span>
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-subtle">
                        <InfinityIcon className="h-3.5 w-3.5" />
                        Permanent
                      </span>
                    )}
                  </td>

                  {mayManage && (
                    <td className="whitespace-nowrap px-4 py-2.5 text-right">
                      {r.expiresAt && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy === id}
                          onClick={() => {
                            const from = r.expired ? new Date() : new Date(r.expiresAt!);
                            from.setDate(from.getDate() + 30);
                            act(id, () =>
                              extendUserPermission({
                                userId: r.userId,
                                permission: r.permission,
                                expiresAt: from.toISOString().slice(0, 10),
                              }),
                            );
                          }}
                        >
                          +30 days
                        </Button>
                      )}
                      {r.expiresAt && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy === id}
                          onClick={() =>
                            act(id, () =>
                              extendUserPermission({ userId: r.userId, permission: r.permission, expiresAt: null }),
                            )
                          }
                        >
                          Make permanent
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy === id}
                        onClick={() => {
                          // Said out loud for a denial, because removing one *restores* access —
                          // the opposite of what "remove" reads as.
                          const warning = r.allowed
                            ? `Remove this grant? ${r.userName} keeps only what their role gives them.`
                            : `Remove this restriction? ${r.userName} will hold "${r.label}" again through their role.`;
                          if (!window.confirm(warning)) return;
                          act(id, () => clearUserPermission(r.userId, r.permission));
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Remove
                      </Button>
                    </td>
                  )}
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={mayManage ? 6 : 5} className="px-4 py-10 text-center text-sm text-muted">
                  Every exception on file has lapsed.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
