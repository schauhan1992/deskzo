"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LoaderCircle, TriangleAlert, UserPlus } from "lucide-react";
import { consoleAddStaff } from "@/actions/platform/console";
import { OnceSecret } from "@/components/console/kit/once-secret";
import { RolePill } from "@/components/console/kit/status";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { ROLE_LABEL } from "@/lib/console-shared/labels";
import { ALL_ROLES, ROLE_DESCRIPTIONS } from "@/lib/console-shared/roles";
import type { ConsoleRole } from "@/lib/console-shared/types";
import { cn } from "@/lib/utils";

/**
 * Adding a staff member (spec §3.16): the page header's primary button and the dialog it opens —
 * name, email, and the role as radio cards that say what each one may do. Nobody types a password
 * for anybody: the new member gets a one-time link to choose their own, emailed to them and shown
 * here once for the owner to pass on.
 *
 * Owners only. The page renders this button for an owner alone and the action checks again; the
 * dialog's title exists only while it is open, so no other role's page ever carries its wording.
 * It also opens from the address (`?add=1`, the command palette), once hydrated — a dialog is drawn
 * into `<body>`, which the server does not have — and drops the param when it closes.
 */

type Added = { name: string; email: string; role: ConsoleRole; setupUrl: string };

const NAME_MAX = 100;
const EMAIL_MAX = 254;
/** The server's own test (createStaff), so the button wakes exactly when the server would accept. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Least privilege until somebody picks otherwise. */
const START_ROLE: ConsoleRole = "READONLY";

const noSubscribe = () => () => {};

export function AddStaffButton() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  const action = useConsoleAction<{ id: string; setupUrl: string }>();

  const asked = searchParams.get("add") === "1";
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState<Added | null>(null);
  const [seen, setSeen] = useState(false);
  // Opened by the address: adjusted while rendering, so it is open on the first paint after the
  // param arrives rather than one effect later.
  if (asked !== seen) {
    setSeen(asked);
    if (asked) {
      setAdded(null);
      setOpen(true);
    }
  }

  function openFresh() {
    action.reset();
    setAdded(null);
    setOpen(true);
  }

  function close() {
    if (action.pending) return;
    action.reset();
    setOpen(false);
    setAdded(null);
    // Read from the address as it is now: the param that opened it must not open it again.
    const params = new URLSearchParams(window.location.search);
    if (params.has("add")) {
      params.delete("add");
      const query = params.toString();
      router.replace(query ? `${window.location.pathname}?${query}` : window.location.pathname, { scroll: false });
    }
  }

  return (
    <>
      <Button type="button" size="sm" onClick={openFresh}>
        <UserPlus aria-hidden="true" className="h-4 w-4" />
        Add someone
      </Button>
      <Dialog open={open && isClient} onClose={close} title={added ? "Staff member added" : "Add someone"}>
        {added ? <AddedMember added={added} onDone={close} /> : <AddStaffForm action={action} onAdded={setAdded} onCancel={close} />}
      </Dialog>
    </>
  );
}

/**
 * The five roles as radio cards, each with its one line of what it may do (`ROLE_DESCRIPTIONS`,
 * written in nouns so it is safe wherever it is shown). Shared with "Change role…" on the staff table.
 */
export function RoleCards({
  legend,
  value,
  onChange,
  current,
  disabled,
}: {
  legend: string;
  value: ConsoleRole | null;
  onChange: (role: ConsoleRole) => void;
  /** Marked "Current role" — the one a change starts from. */
  current?: ConsoleRole;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1.5 text-[13px] font-medium text-muted">{legend}</legend>
      <div className="grid gap-2">
        {ALL_ROLES.map((role) => {
          const chosen = value === role;
          return (
            <label
              key={role}
              className={cn(
                "flex items-start gap-2.5 rounded-lg border px-3 py-2.5",
                chosen ? "border-brand bg-brand-subtle" : "border-line hover:bg-surface-sunken",
                disabled ? "cursor-default opacity-70" : "cursor-pointer",
              )}
            >
              <input
                type="radio"
                name={name}
                value={role}
                checked={chosen}
                onChange={() => onChange(role)}
                disabled={disabled}
                className="mt-0.5 h-4 w-4 shrink-0 accent-brand"
              />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <RolePill role={role} />
                  {current === role && <span className="text-[11px] text-subtle">Current role</span>}
                </span>
                <span className="mt-1 block text-xs text-muted">{ROLE_DESCRIPTIONS[role]}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** The form. Mounted only while the dialog is open and nothing is added yet, so it always starts empty. */
function AddStaffForm({
  action,
  onAdded,
  onCancel,
}: {
  action: ReturnType<typeof useConsoleAction<{ id: string; setupUrl: string }>>;
  onAdded: (added: Added) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [emailTouched, setEmailTouched] = useState(false);
  const [role, setRole] = useState<ConsoleRole>(START_ROLE);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // The dialog puts focus on its close button in its own effect, which runs after this one — so
    // wait a frame, then put it where the typing starts.
    const frame = window.requestAnimationFrame(() => nameRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const cleanName = name.trim();
  const cleanEmail = email.trim().toLowerCase();
  const nameOk = cleanName.length >= 2;
  const emailOk = EMAIL.test(cleanEmail);
  const ready = nameOk && emailOk && !action.pending;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready) return;
    action.run(() => consoleAddStaff({ name: cleanName, email: cleanEmail, role }), {
      success: "Staff member added.",
      onDone: (data) => onAdded({ name: cleanName, email: cleanEmail, role, setupUrl: data.setupUrl }),
    });
  }

  const nameId = `${id}-name`;
  const emailId = `${id}-email`;
  const emailHint = `${id}-email-hint`;
  const emailWrong = emailTouched && cleanEmail !== "" && !emailOk;

  return (
    // p-0.5: the dialog body scrolls, and a scroll box clips the focus ring of a field at its edge.
    <form onSubmit={submit} className="space-y-4 p-0.5" noValidate>
      <p className="text-sm text-muted">They get a one-time link to choose their own password — nobody else ever types it.</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={nameId}>Name</Label>
          <Input
            ref={nameRef}
            id={nameId}
            value={name}
            maxLength={NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            placeholder="Priya Sharma"
            autoComplete="off"
            data-1p-ignore=""
            readOnly={action.pending}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={emailId}>Email</Label>
          <Input
            id={emailId}
            type="email"
            inputMode="email"
            value={email}
            maxLength={EMAIL_MAX}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setEmailTouched(true)}
            placeholder="priya@example.com"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore=""
            aria-invalid={emailWrong || undefined}
            aria-describedby={emailHint}
            readOnly={action.pending}
          />
          <p id={emailHint} className={cn("text-xs", emailWrong ? "text-danger" : "text-muted")}>
            {emailWrong ? "That doesn't look like an email address." : "Where the password link is sent."}
          </p>
        </div>
      </div>

      <RoleCards legend="Role" value={role} onChange={setRole} disabled={action.pending} />

      {role === "OWNER" && (
        <p className="flex items-start gap-1.5 text-xs text-warning">
          <TriangleAlert aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>An owner has every power you have — staff, security policy and gateway keys included.</span>
        </p>
      )}

      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />

      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={action.pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!nameOk || !emailOk} aria-disabled={action.pending || undefined} aria-busy={action.pending || undefined} className={action.pending ? "cursor-wait opacity-70" : undefined}>
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Add as {ROLE_LABEL[role].label}
        </Button>
      </div>
    </form>
  );
}

/** The one time the setup link is shown. It is gone from the browser when the dialog closes. */
function AddedMember({ added, onDone }: { added: Added; onDone: () => void }) {
  return (
    <div className="space-y-4 p-0.5">
      <p className="text-sm text-text">
        <strong className="font-medium">{added.name}</strong> is on the staff as <RolePill role={added.role} />. They choose a password with this link, and can sign in
        straight after.
      </p>
      <OnceSecret
        label={`Password link for ${added.name}`}
        value={added.setupUrl}
        copyLabel="Copy password link"
        onDone={onDone}
        extra={<p className="text-xs text-muted">{`Also emailed to ${added.email}. The link lasts 3 days.`}</p>}
      />
    </div>
  );
}
