"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Eye, History, Pin, PinOff, Share2, TriangleAlert } from "lucide-react";
import type { VaultField } from "@prisma/client";
import { setCredentialPin, type VaultRow } from "@/actions/vault";
import { Badge, Card } from "@/components/ui/card";
import { IconButton } from "@/components/ui/icon-button";
import { Avatar, AvatarStack } from "@/components/ui/avatar";
import { useClock } from "@/components/time/clock-provider";
import { formatCalendarDay } from "@/lib/time/zone";

/**
 * The vault as a grid.
 *
 * The same records the cards show, laid out for a different question. A card answers "what is this
 * login and what do I do with it"; this answers "which of these expire this month", "how many are
 * the client's", "who owns what" — the questions that are about the column rather than the row, and
 * that a stack of cards makes you read one at a time.
 *
 * It carries exactly the same secrets as the card view, which is none. Opening one still costs the
 * viewer their own password and still goes through `revealSecret`; nothing here is a shortcut past
 * that, and the compact layout is not an excuse to put a masked field in the markup.
 */
export function VaultTable({
  rows,
  onOpen,
  onShare,
  onTrail,
}: {
  rows: VaultRow[];
  onOpen: (row: VaultRow, field: VaultField) => void;
  onShare: (row: VaultRow) => void;
  onTrail: (row: VaultRow) => void;
}) {
  const router = useRouter();
  const clock = useClock();
  const [busy, setBusy] = useState<string | null>(null);

  async function togglePin(row: VaultRow) {
    setBusy(row.id);
    const result = await setCredentialPin(row.id, !row.pinned);
    setBusy(null);
    if (!result.ok) alert(result.error);
    router.refresh();
  }

  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="w-8 px-2 py-2" />
              <th className="px-3 py-2 font-medium">Login</th>
              <th className="px-3 py-2 font-medium">Category</th>
              <th className="px-3 py-2 font-medium">Whose</th>
              <th className="px-3 py-2 font-medium">Username</th>
              <th className="px-3 py-2 font-medium">Owner</th>
              <th className="px-3 py-2 font-medium">Shared with</th>
              <th className="px-3 py-2 font-medium">Password</th>
              <th className="px-3 py-2 font-medium">Billing</th>
              <th className="px-3 py-2 text-right font-medium">Opened</th>
              <th className="w-px px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0 align-middle hover:bg-surface-sunken/60">
                <td className="px-2 py-2">
                  {r.expiringSoon ? (
                    <CalendarClock className="h-4 w-4 text-danger" aria-label="Billing expiring" />
                  ) : r.pinned ? (
                    <Pin className="h-4 w-4 fill-brand text-brand" aria-label="Pinned" />
                  ) : null}
                </td>

                <td className="px-3 py-2">
                  <div className="font-medium text-text">{r.loginName}</div>
                  {/* Shown, never linked — the same rule the card follows. A stored URL is untrusted
                      text, and one click is all a phishing target needs. */}
                  {r.loginUrl && <div className="truncate text-xs text-subtle">{r.loginUrl}</div>}
                </td>

                <td className="px-3 py-2 text-muted">{r.category ?? "—"}</td>

                <td className="px-3 py-2">
                  {r.ownership === "CLIENT" ? (
                    <span className="text-text">{r.company?.name ?? "A client"}</span>
                  ) : (
                    <span className="text-subtle">Ours</span>
                  )}
                </td>

                <td className="px-3 py-2 text-muted">{r.username ?? r.email ?? "—"}</td>

                <td className="px-3 py-2">
                  <span className="flex items-center gap-1.5">
                    <Avatar size="xs" user={r.owner} />
                    <span className="text-muted">{r.mine ? "You" : r.owner.name}</span>
                  </span>
                </td>

                <td className="px-3 py-2">
                  {r.shares.length === 0 ? (
                    <span className="text-subtle">—</span>
                  ) : (
                    <AvatarStack
                      size="xs"
                      max={3}
                      users={r.shares
                        .filter((s) => s.userId)
                        .map((s) => ({ id: s.userId!, name: s.name, photoUpdatedAt: s.photoUpdatedAt }))}
                    />
                  )}
                </td>

                <td className="px-3 py-2">
                  {r.rotation.state === "overdue" ? (
                    <span className="flex items-center gap-1 text-danger">
                      <TriangleAlert className="h-3 w-3" />
                      {Math.abs(r.rotation.daysUntilDue ?? 0)}d overdue
                    </span>
                  ) : r.rotation.state === "due" ? (
                    <span className="text-warning">Due in {r.rotation.daysUntilDue}d</span>
                  ) : r.rotation.state === "unknown" ? (
                    <span className="text-subtle">Never changed</span>
                  ) : r.passwordChangedAt ? (
                    <span className="text-subtle">{clock.date(r.passwordChangedAt)}</span>
                  ) : (
                    <span className="text-subtle">—</span>
                  )}
                </td>

                <td className="px-3 py-2">
                  {r.daysToExpiry === null ? (
                    <span className="text-subtle">—</span>
                  ) : r.daysToExpiry < 0 ? (
                    <span className="text-danger">Expired</span>
                  ) : (
                    <span className={r.daysToExpiry <= 30 ? "text-warning" : "text-subtle"}>
                      {/* The day typed, held as midnight UTC. */}
                      {r.billingExpiry ? formatCalendarDay(r.billingExpiry) : "—"}
                    </span>
                  )}
                </td>

                <td className="px-3 py-2 text-right text-muted">
                  {r.openedCount > 0 ? (
                    <button type="button" onClick={() => onTrail(r)} className="hover:text-text hover:underline">
                      {r.openedCount}
                    </button>
                  ) : (
                    <span className="text-subtle">0</span>
                  )}
                </td>

                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-0.5">
                    <IconButton icon={Eye} label="Open the password" onClick={() => onOpen(r, "PASSWORD")} />
                    <IconButton
                      icon={r.pinned ? PinOff : Pin}
                      label={r.pinned ? "Unpin" : "Pin to the top"}
                      disabled={busy === r.id}
                      onClick={() => togglePin(r)}
                    />
                    <IconButton icon={History} label="Who opened it" onClick={() => onTrail(r)} />
                    {r.canManage && <IconButton icon={Share2} label="Share" onClick={() => onShare(r)} />}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && (
        <p className="py-10 text-center text-sm text-muted">
          Nothing here yet — add your first login, or ask a colleague to share one with you.
        </p>
      )}
    </Card>
  );
}

/** The word for a record's ownership, wherever it is shown. One spelling, one place. */
export function ownershipLabel(row: Pick<VaultRow, "ownership" | "company">) {
  if (row.ownership === "OURS") return "Ours";
  return row.company ? row.company.name : "A client";
}

/** A chip for the card view, where the column header is not there to explain it. */
export function OwnershipBadge({ row }: { row: Pick<VaultRow, "ownership" | "company"> }) {
  if (row.ownership === "OURS") return null;
  return <Badge tone="amber">{row.company ? `${row.company.name}'s` : "Client's"}</Badge>;
}
