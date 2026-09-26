"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { StaffRole } from "@wroffy/control-client";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { consoleAddStaff, consoleCreateInvite, consoleNewSetupLink, consoleSavePinKey, consoleSetStaffRole, consoleSetStaffTwoFactor } from "@/actions/platform/console";

/**
 * The console's small forms. Anything shown once — an invitation code, a password link — is shown
 * here, to whoever made it, and never again: only its hash is kept.
 */

function Once({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-base border border-line bg-surface-sunken p-3 text-sm">
      <p className="text-xs text-muted">{label} — shown this once:</p>
      <code className="mt-1 block break-all font-mono text-text">{value}</code>
    </div>
  );
}

export function InviteForm({ signupUrl, plans }: { signupUrl: string; plans: { key: string; name: string }[] }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [planKey, setPlanKey] = useState("");
  const [uses, setUses] = useState("1");
  const [days, setDays] = useState("14");
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setCode(null);
        startTransition(async () => {
          const r = await consoleCreateInvite({ note, uses: Number(uses), days: Number(days), planKey: planKey || null });
          if (!r.ok) return setError(r.error);
          setCode(r.data.code);
          setNote("");
          router.refresh();
        });
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_180px_90px_90px_auto] sm:items-end">
        <div>
          <Label htmlFor="invite-note">Who it is for</Label>
          <Input id="invite-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Acme Pvt Ltd — Priya" />
        </div>
        <div>
          <Label htmlFor="invite-plan">Starts on</Label>
          <Select id="invite-plan" value={planKey} onChange={(e) => setPlanKey(e.target.value)}>
            <option value="">The default plan</option>
            {plans.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="invite-uses">Uses</Label>
          <Input id="invite-uses" type="number" min={1} max={100} value={uses} onChange={(e) => setUses(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="invite-days">Days valid</Label>
          <Input id="invite-days" type="number" min={1} max={90} value={days} onChange={(e) => setDays(e.target.value)} />
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "Making…" : "Make invitation"}
        </Button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {code && <Once label={`Invitation code — they sign up at ${signupUrl}`} value={code} />}
    </form>
  );
}

export function PinKeyForm({ hasKey }: { hasKey: boolean }) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setMessage(null);
        startTransition(async () => {
          const r = await consoleSavePinKey(key);
          if (!r.ok) return setMessage({ ok: false, text: r.error });
          setKey("");
          setMessage({ ok: true, text: "Saved." });
          router.refresh();
        });
      }}
    >
      {/* Typed straight in and kept sealed; never shown back, not even to whoever saved it. */}
      <Input
        type="password"
        autoComplete="off"
        className="h-8 w-72"
        aria-label="data.gov.in API key"
        placeholder={hasKey ? "Replace the saved key" : "data.gov.in API key"}
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />
      <Button type="submit" size="sm" variant="secondary" disabled={pending || !key.trim()}>
        {pending ? "Saving…" : "Save key"}
      </Button>
      {message && <span className={message.ok ? "text-xs text-success" : "text-xs text-danger"}>{message.text}</span>}
    </form>
  );
}

const ROLES: { value: StaffRole; label: string }[] = [
  { value: "OWNER", label: "Owner — everything, and staff" },
  { value: "ADMIN", label: "Admin — workspaces and the platform" },
  { value: "SUPPORT", label: "Support — into workspaces on their grant" },
  { value: "BILLING", label: "Billing" },
  { value: "READONLY", label: "Read-only" },
];

export function AddStaffForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<StaffRole>("SUPPORT");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setLink(null);
        startTransition(async () => {
          const r = await consoleAddStaff({ email, name, role });
          if (!r.ok) return setError(r.error);
          setLink(r.data.setupUrl);
          setEmail("");
          setName("");
          router.refresh();
        });
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_220px_auto] sm:items-end">
        <div>
          <Label htmlFor="staff-name">Name</Label>
          <Input id="staff-name" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="staff-email">Email</Label>
          <Input id="staff-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="staff-role">Role</Label>
          <Select id="staff-role" value={role} onChange={(e) => setRole(e.target.value as StaffRole)}>
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add"}
        </Button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {link && <Once label="Emailed to them as well. Their link to choose a password, valid 3 days" value={link} />}
    </form>
  );
}

export function StaffRoleSelect({ userId, role }: { userId: string; role: StaffRole }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <span className="inline-flex flex-col gap-1">
      <Select
        className="h-8 w-32"
        aria-label="Role"
        value={role}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value as StaffRole;
          setError(null);
          startTransition(async () => {
            const r = await consoleSetStaffRole(userId, next);
            if (!r.ok) setError(r.error);
            router.refresh();
          });
        }}
      >
        {ROLES.map((r) => (
          <option key={r.value} value={r.value}>
            {r.value.toLowerCase()}
          </option>
        ))}
      </Select>
      {error && <span className="text-xs text-danger">{error}</span>}
    </span>
  );
}

export function NewSetupLink({ userId }: { userId: string }) {
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  if (link) return <Once label="Password link, valid 3 days" value={link} />;
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await consoleNewSetupLink(userId);
            if (r.ok) setLink(r.data.url);
            else setError(r.error);
          })
        }
      >
        Password link
      </Button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </span>
  );
}

/**
 * Whether staff must use an authenticator — an owner's choice (src/lib/platform/settings.ts). Until it
 * is made, it follows the environment: required in production, optional in development.
 */
export function TwoFactorPolicyForm({ mode, chosen, defaultMode }: { mode: "required" | "optional"; chosen: boolean; defaultMode: "required" | "optional" }) {
  const router = useRouter();
  const [value, setValue] = useState(mode);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="space-y-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (value === "optional" && !window.confirm("Make two-factor optional? Staff without an authenticator will reach the console with their password alone.")) return;
        setMessage(null);
        startTransition(async () => {
          const r = await consoleSetStaffTwoFactor(value);
          setMessage(r.ok ? { ok: true, text: "Saved — it applies from each person's next page." } : { ok: false, text: r.error });
          if (r.ok) router.refresh();
        });
      }}
    >
      <label className="flex items-start gap-2 text-text">
        <input type="radio" name="two-factor" className="mt-1" checked={value === "required"} onChange={() => setValue("required")} />
        <span>
          Required for everyone
          <span className="block text-xs text-muted">Nobody reaches the console without an authenticator; a first sign-in sets one up.</span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-text">
        <input type="radio" name="two-factor" className="mt-1" checked={value === "optional"} onChange={() => setValue("optional")} />
        <span>
          Optional
          <span className="block text-xs text-muted">A password is enough for anybody without an authenticator; anybody who set one up is still asked for its code.</span>
        </span>
      </label>
      {!chosen && <p className="text-xs text-muted">Not chosen yet — following this environment&apos;s default: {defaultMode}.</p>}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending || (chosen && value === mode)}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {message && <span className={message.ok ? "text-xs text-success" : "text-xs text-danger"}>{message.text}</span>}
      </div>
    </form>
  );
}
