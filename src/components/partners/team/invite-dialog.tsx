"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LoaderCircle, TriangleAlert, UserPlus } from "lucide-react";
import { partnerInviteUser } from "@/actions/partners/team";
import { OnceSecret } from "@/components/console/kit/once-secret";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { TextField } from "@/components/partners/common/fields";
import { PartnerRolePill } from "@/components/partners/common/pills";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { PARTNER_ROLES, PARTNER_ROLE_DESCRIPTIONS, PARTNER_ROLE_LABELS, type PartnerRole } from "@/lib/partners/types";
import { cn } from "@/lib/utils";

/** A plain shape test, so the button's refusal is instant; the server's own test is the one that counts. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Least privilege until somebody picks otherwise. */
const START_ROLE: PartnerRole = "VIEWER";

const noSubscribe = () => () => {};

/**
 * The four portal roles as radio cards, each with its one line of what it may do. Shared by "Invite
 * someone" and "Change role…". The server decides what may not change (the last active admin stays
 * an admin) and says so; nothing here is locked in advance.
 */
export function PartnerRoleCards({
  legend,
  value,
  onChange,
  current,
  disabled,
}: {
  legend: string;
  value: PartnerRole;
  onChange: (role: PartnerRole) => void;
  current?: PartnerRole;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1.5 text-[13px] font-medium text-muted">{legend}</legend>
      <div className="grid gap-2">
        {PARTNER_ROLES.map((role) => {
          const chosen = value === role;
          return (
            <label
              key={role}
              className={cn(
                "flex items-start gap-2.5 rounded-lg border px-3 py-2.5",
                chosen ? "border-brand bg-brand-subtle" : "border-line",
                disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-surface-sunken",
              )}
            >
              <input type="radio" name={name} value={role} checked={chosen} onChange={() => onChange(role)} disabled={disabled} className="mt-0.5 h-4 w-4 shrink-0 accent-brand" />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <PartnerRolePill role={role} />
                  {current === role && <span className="text-[11px] text-subtle">Current role</span>}
                </span>
                <span className="mt-1 block text-xs text-muted">{PARTNER_ROLE_DESCRIPTIONS[role]}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

type Invited = { name: string; email: string; role: PartnerRole; setupUrl: string; emailed: boolean };
type InviteAction = ReturnType<typeof useConsoleAction<{ id: string; setupUrl: string; emailed: boolean }>>;

/**
 * "Invite someone": name, email and role; they get a one-time link to choose their own password —
 * emailed to them, and shown here once for the admin to pass on if the email goes astray. Opens from
 * the address too (`/team?invite=1`, for a link from elsewhere in the portal), once hydrated, and drops
 * the param when it closes.
 */
export function InviteUserButton() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  const action = useConsoleAction<{ id: string; setupUrl: string; emailed: boolean }>();
  const asked = searchParams.get("invite") === "1";
  const [open, setOpen] = useState(false);
  const [invited, setInvited] = useState<Invited | null>(null);
  const [seen, setSeen] = useState(false);
  if (asked !== seen) {
    setSeen(asked);
    if (asked) {
      setInvited(null);
      setOpen(true);
    }
  }

  function close() {
    if (action.pending) return;
    action.reset();
    setOpen(false);
    setInvited(null);
    const params = new URLSearchParams(window.location.search);
    if (params.has("invite")) {
      params.delete("invite");
      const query = params.toString();
      router.replace(query ? `${window.location.pathname}?${query}` : window.location.pathname, { scroll: false });
    }
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        onClick={() => {
          action.reset();
          setInvited(null);
          setOpen(true);
        }}
      >
        <UserPlus aria-hidden="true" className="h-4 w-4" />
        Invite someone
      </Button>
      <Dialog open={open && isClient} onClose={close} title={invited ? "Invitation sent" : "Invite someone to the partner portal"}>
        {invited ? <InvitedPerson invited={invited} onDone={close} /> : <InviteForm action={action} onInvited={setInvited} onCancel={close} />}
      </Dialog>
    </>
  );
}

function InviteForm({ action, onInvited, onCancel }: { action: InviteAction; onInvited: (invited: Invited) => void; onCancel: () => void }) {
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<PartnerRole>(START_ROLE);
  const [tried, setTried] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => nameRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const cleanName = name.replace(/\s+/g, " ").trim();
  const cleanEmail = email.trim().toLowerCase();
  const nameOk = cleanName.length >= 2 && cleanName.length <= 120;
  const emailOk = EMAIL.test(cleanEmail) && cleanEmail.length <= 254;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTried(true);
    if (!nameOk || !emailOk || action.pending) return;
    action.run(() => partnerInviteUser({ name: cleanName, email: cleanEmail, role }), {
      success: `${cleanName} is invited as ${PARTNER_ROLE_LABELS[role]}.`,
      onDone: (data) => onInvited({ name: cleanName, email: cleanEmail, role, setupUrl: data.setupUrl, emailed: data.emailed }),
    });
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4 p-0.5" aria-busy={action.pending || undefined}>
      <p className="text-sm text-muted">
        They get a one-time link to choose their own password — nobody else ever types it. Portal accounts see only your partner account, never a customer&apos;s workspace.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          inputRef={nameRef}
          label="Name"
          value={name}
          onChange={setName}
          max={120}
          required
          placeholder="Asha Rao"
          readOnly={action.pending}
          autoComplete="off"
          error={tried && !nameOk ? "Give their name (2 to 120 characters)." : null}
        />
        <TextField
          label="Email"
          type="email"
          inputMode="email"
          value={email}
          onChange={setEmail}
          required
          placeholder="asha@example.com"
          readOnly={action.pending}
          mono
          error={tried && cleanEmail && !emailOk ? "That doesn't look like an email address." : tried && !cleanEmail ? "Give their email address." : null}
          hint="Where the password link is sent."
        />
      </div>
      <PartnerRoleCards legend="Role" value={role} onChange={setRole} disabled={action.pending} />
      {role === "ADMIN" && (
        <p className="flex items-start gap-1.5 text-xs text-warning">
          <TriangleAlert aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>An admin can do everything you can — see commissions, change the company profile, and invite or switch off people.</span>
        </p>
      )}
      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={action.pending}>
          Cancel
        </Button>
        <Button type="submit" aria-disabled={action.pending || undefined} aria-busy={action.pending || undefined} className={action.pending ? "cursor-wait opacity-70" : undefined}>
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Invite as {PARTNER_ROLE_LABELS[role]}
        </Button>
      </div>
    </form>
  );
}

/** The one time the link is shown. It leaves the browser with the dialog. */
function InvitedPerson({ invited, onDone }: { invited: Invited; onDone: () => void }) {
  return (
    <div className="space-y-4 p-0.5">
      <p className="text-sm text-text">
        <strong className="font-medium">{invited.name}</strong> can sign in as <PartnerRolePill role={invited.role} /> once they&apos;ve chosen a password with this link.
      </p>
      <OnceSecret
        label={`Password link for ${invited.name}`}
        value={invited.setupUrl}
        copyLabel="Copy link"
        onDone={onDone}
        extra={
          invited.emailed ? (
            <p className="text-xs text-muted">{`Also emailed to ${invited.email}. It works once, for 3 days.`}</p>
          ) : (
            <p className="flex items-start gap-1.5 text-xs text-warning">
              <TriangleAlert aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>{`The email to ${invited.email} couldn't be sent — pass this link on yourself. It works once, for 3 days.`}</span>
            </p>
          )
        }
      />
    </div>
  );
}
