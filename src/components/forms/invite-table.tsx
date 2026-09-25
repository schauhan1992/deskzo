"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ban, Check, Link2 } from "lucide-react";
import { recordRsvp, revokeInvite } from "@/actions/forms";
import { INVITE_STATUS, type InviteStatusKey } from "@/lib/forms/invites";
import { Badge, Card } from "@/components/ui/card";
import { ActionNotice } from "@/components/ui/action-notice";

export type InviteRow = {
  id: string;
  email: string;
  status: InviteStatusKey;
  /** Written out on the server, in India time. */
  sentText: string;
  sendCount: number;
  openedText: string | null;
  contact: { id: string; name: string; designation: string | null };
  company: { id: string; name: string };
  invitedBy: { name: string } | null;
  link: string | null;
};

/**
 * Who was invited, and where each of them has got to.
 *
 * The personal link can be copied for somebody who would rather send it on WhatsApp, and an RSVP
 * given on the phone can be recorded here — against the invitation, so their own answer later
 * updates it rather than counting them twice.
 */
export function InviteTable({ rows, canInvite, event }: { rows: InviteRow[]; canInvite: boolean; event: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const run = (work: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  };

  if (rows.length === 0) {
    return <Card className="px-4 py-12 text-center text-sm text-subtle">Nobody matches that.</Card>;
  }

  return (
    <div className="space-y-2">
      {error && <ActionNotice tone="error">{error}</ActionNotice>}
      <Card className="divide-y divide-line">
        {rows.map((row) => {
          const status = INVITE_STATUS[row.status];
          const live = row.status !== "WITHDRAWN";
          return (
            <div key={row.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-text">{row.contact.name}</span>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </div>
                <div className="text-xs text-muted">
                  <Link href={`/companies/${row.company.id}`} className="hover:underline">
                    {row.company.name}
                  </Link>
                  {row.contact.designation && ` · ${row.contact.designation}`} · {row.email}
                </div>
                <div className="mt-0.5 text-[11px] text-subtle">
                  {row.sentText}
                  {row.sendCount > 1 && ` · sent ${row.sendCount} times`}
                  {row.invitedBy && ` · by ${row.invitedBy.name}`}
                  {row.openedText && ` · link opened ${row.openedText}`}
                </div>
              </div>

              {canInvite && live && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {event && row.status !== "COMING" && (
                    <SmallButton disabled={pending} onClick={() => run(() => recordRsvp(row.id, true))}>
                      <Check className="h-3 w-3" aria-hidden />
                      Coming
                    </SmallButton>
                  )}
                  {event && row.status !== "NOT_COMING" && (
                    <SmallButton disabled={pending} onClick={() => run(() => recordRsvp(row.id, false))}>
                      Can&apos;t come
                    </SmallButton>
                  )}
                  {row.link && (
                    <SmallButton
                      onClick={async () => {
                        await navigator.clipboard.writeText(row.link!);
                        setCopied(row.id);
                        setTimeout(() => setCopied(null), 2000);
                      }}
                    >
                      <Link2 className="h-3 w-3" aria-hidden />
                      {copied === row.id ? "Copied" : "Copy link"}
                    </SmallButton>
                  )}
                  <SmallButton
                    disabled={pending}
                    onClick={() => {
                      if (window.confirm(`Withdraw ${row.contact.name}'s invitation? Their link stops working.`)) run(() => revokeInvite(row.id));
                    }}
                  >
                    <Ban className="h-3 w-3" aria-hidden />
                    Withdraw
                  </SmallButton>
                </div>
              )}
            </div>
          );
        })}
      </Card>
      {event && canInvite && (
        <p className="text-[11px] text-subtle">
          &ldquo;Coming&rdquo; and &ldquo;Can&apos;t come&rdquo; record an answer given to you in person or on the phone.
        </p>
      )}
    </div>
  );
}

function SmallButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] font-medium text-muted hover:bg-surface-sunken hover:text-text disabled:opacity-50"
    >
      {children}
    </button>
  );
}
