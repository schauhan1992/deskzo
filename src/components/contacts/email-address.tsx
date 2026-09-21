"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  Loader2,
  Mail,
  ShieldQuestion,
  ThumbsDown,
  ThumbsUp,
  XCircle,
} from "lucide-react";
import type { EmailCheckMethod, EmailCheckStatus } from "@prisma/client";
import { markEmailConfirmed, verifyContactEmail } from "@/actions/email-verification";
import { emailCheckState, emailMethodLabels, emailStatusLabels } from "@/lib/email-verification";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils";
import { cn } from "@/lib/utils";

export type VerifiableContact = {
  id: string;
  email: string | null;
  emailStatus: EmailCheckStatus;
  emailCheckedValue: string | null;
  emailCheckedAt: Date | string | null;
  emailCheckMethod: EmailCheckMethod | null;
  emailCheckDetail: string | null;
};

/**
 * An email address with the state of its last check attached.
 *
 * The badge sits next to every address in the ERP so that the question "can I actually write to
 * this?" is answered where the address is read, rather than being something a rep discovers from a
 * bounce three days later. The icon is a button: unchecked invites a check, and anything already
 * checked opens what was found, when, and by whom.
 *
 * A check never alters the address. The worst it can do is tell you the one on file is wrong.
 */
export function EmailAddress({
  contact,
  /** "full" prints the address, "icon" is for a table's action column. */
  variant = "full",
  className,
}: {
  contact: VerifiableContact;
  variant?: "full" | "icon";
  className?: string;
}) {
  if (!contact.email) {
    return variant === "full" ? <span className={cn("text-subtle", className)}>—</span> : null;
  }

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      {variant === "full" ? (
        <a
          href={`mailto:${contact.email}`}
          className="flex min-w-0 items-center gap-1 text-muted hover:text-text hover:underline"
        >
          <Mail className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{contact.email}</span>
        </a>
      ) : (
        <a href={`mailto:${contact.email}`} title="Email" className="text-muted hover:text-text">
          <Mail className="h-4 w-4" />
        </a>
      )}
      <EmailCheckBadge contact={contact} />
    </span>
  );
}

const display: Record<
  EmailCheckStatus,
  { Icon: typeof CheckCircle2; className: string; hint: string }
> = {
  UNCHECKED: {
    Icon: ShieldQuestion,
    className: "text-subtle hover:text-brand",
    hint: "Not checked yet — click to verify",
  },
  VALID: { Icon: CheckCircle2, className: "text-success", hint: "Verified" },
  RISKY: { Icon: AlertTriangle, className: "text-warning", hint: "Reaches someone, but not a person at work" },
  INVALID: { Icon: XCircle, className: "text-danger", hint: "Bad address" },
};

/** The icon on its own, for rows that already print the address themselves. */
export function EmailCheckBadge({ contact }: { contact: VerifiableContact }) {
  const router = useRouter();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (anchorRef.current?.contains(target)) return;
      // The panel is portalled to <body>, so it isn't inside the anchor — without this, mousedown
      // on a button would close the panel and the click would never reach its handler.
      if (target?.closest?.("[data-menu-panel]")) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const { status, stale } = emailCheckState(contact);
  // A confirmed address gets the filled badge: it is the only state where a person, not a DNS
  // record, vouched for the mailbox — and that distinction is the whole point of the feature.
  const confirmed = status === "VALID" && contact.emailCheckMethod === "CONFIRMED";
  const { Icon, className, hint } = display[status];
  const ShownIcon = confirmed ? BadgeCheck : Icon;

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "That didn't work.");
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  if (!contact.email) return null;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => (status === "UNCHECKED" && !stale ? run(() => verifyContactEmail(contact.id)) : setOpen((o) => !o))}
        disabled={pending}
        title={
          status === "UNCHECKED"
            ? stale
              ? "The address changed since it was last checked — click to check it again"
              : hint
            : `${emailStatusLabels[status]} — ${contact.emailCheckDetail ?? hint}`
        }
        aria-label={`Email verification: ${emailStatusLabels[status]}`}
        className={cn("shrink-0 rounded-full transition-colors disabled:opacity-60", className)}
      >
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <ShownIcon className="h-3.5 w-3.5" />
        )}
      </button>

      <AnchoredPopover anchorRef={anchorRef} open={open} width={300} align="end">
        <div data-menu-panel className="space-y-2.5 rounded-xl border border-line bg-surface p-3 shadow-lg">
          <div className="flex items-center gap-1.5 text-sm font-medium text-text">
            <ShownIcon className={cn("h-4 w-4", className)} />
            {emailStatusLabels[status]}
          </div>

          <p className="text-xs text-muted">{contact.emailCheckDetail ?? hint}</p>

          {contact.emailCheckedAt && contact.emailCheckMethod && (
            <p className="text-[11px] text-subtle">
              {emailMethodLabels[contact.emailCheckMethod]} · {formatDateTime(contact.emailCheckedAt)}
            </p>
          )}

          {error && <p className="text-xs text-danger">{error}</p>}

          <div className="flex flex-wrap gap-1.5 border-t border-line pt-2.5">
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => verifyContactEmail(contact.id))}>
              Check again
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              title="You reached them at this address"
              onClick={() => run(() => markEmailConfirmed(contact.id, "CONFIRMED"))}
            >
              <ThumbsUp className="mr-1 h-3 w-3" />
              It works
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              className="text-danger hover:bg-danger-bg hover:text-danger"
              title="It bounced, or you were told it's wrong"
              onClick={() => run(() => markEmailConfirmed(contact.id, "WRONG"))}
            >
              <ThumbsDown className="mr-1 h-3 w-3" />
              It&apos;s wrong
            </Button>
          </div>

          <p className="text-[11px] leading-relaxed text-subtle">
            A check reads public DNS: it proves the domain accepts mail, not that the mailbox exists.
            Only a reply proves that, which is what &ldquo;It works&rdquo; records.
          </p>
        </div>
      </AnchoredPopover>
    </>
  );
}
