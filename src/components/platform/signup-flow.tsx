"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { ChevronDown, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { checkWorkspaceName, heldAddress, signupProgress, startSignup, verifySignup, type SignupForm } from "@/actions/platform/signup";
import { MIN_SIGNUP_NAME, suggestedName } from "@/lib/workspace-names";
import type { Country } from "@/lib/geo/countries";

type Stage = { at: "form" } | { at: "code"; email: string } | { at: "progress"; step: string } | { at: "failed"; message: string };

/** A partner's live referral code, checked by the signup page (src/app/platform-site/signup/page.tsx) — from its link or the referral cookie. */
export type SignupReferral = { code: string; partnerName: string; via: "link" | "cookie" };

/**
 * The signup, in three screens: the form, the emailed code, and the workspace being set up — which
 * ends by going straight into it, signed in (src/actions/platform/signup.ts).
 *
 * A partner's code (spec §4.2): prefilled from a referral — "Referred by …", which the visitor may
 * remove — or typed into the "Have a partner code?" disclosure. It goes with the form, saying where it
 * came from; `startSignup` checks it again.
 *
 * An invitation code that holds an address for its customer — from the signup link (`invite`, looked
 * up by the page: `held`) or typed — fills the address in and locks it: "This address was set up for
 * you." It stays locked while that code is in the field; change the code and the address is the
 * visitor's own again. The registered business name is still asked for, but the address is no longer
 * made from it. `startSignup` holds it to the same rule.
 */
export function SignupFlow({
  suffix,
  countries,
  inviteRequired = true,
  referral = null,
  invite = "",
  held = null,
}: {
  suffix: string;
  countries: Country[];
  inviteRequired?: boolean;
  referral?: SignupReferral | null;
  /** An invitation code to start with — from the signup link. */
  invite?: string;
  /** The address `invite` holds, as the page looked it up; null when it holds none. */
  held?: string | null;
}) {
  const [stage, setStage] = useState<Stage>({ at: "form" });
  const [form, setForm] = useState<SignupForm>({ companyName: "", slug: "", ownerName: "", email: "", password: "", country: "IN", invite, referral: referral?.code ?? "", referralVia: referral?.via ?? "" });
  // The address an invitation code holds, with the code it belongs to — it applies only while that code is the one typed.
  const [hold, setHold] = useState<{ code: string; slug: string } | null>(held && invite.trim() ? { code: invite.trim(), slug: held } : null);
  const inviteCode = form.invite.trim();
  const activeHold = hold && hold.code === inviteCode ? hold : null;
  // Each code is asked about once: the lookup is limited, and its answer does not change while the form is open.
  const asked = useRef(new Set(invite.trim() ? [invite.trim()] : []));
  // The partner's name is shown until the visitor removes it; after that, the code is theirs to type or not.
  const [referredBy, setReferredBy] = useState(referral?.partnerName ?? null);
  // Remembered with the address and registered name it was for, so an answer about earlier ones is never shown.
  const [nameCheck, setNameCheck] = useState<{ key: string; ok: boolean; text: string } | null>(null);
  // The address follows the registered name until the visitor types one of their own.
  const [slugTyped, setSlugTyped] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const set = (key: keyof SignupForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));

  // The address, checked as it (or the registered name it must come from) is typed — half a second after
  // the last key. Not one held for the visitor: that was set up for them, and is not theirs to change.
  const slug = form.slug.trim().toLowerCase();
  const legalName = form.companyName.trim();
  const checkKey = `${slug}|${legalName}`;
  useEffect(() => {
    if (!slug || activeHold) return;
    const timer = setTimeout(() => {
      checkWorkspaceName(slug, legalName).then((r) => setNameCheck(r.ok ? { key: checkKey, ok: true, text: `${r.data.host} is free` } : { key: checkKey, ok: false, text: r.error }));
    }, 500);
    return () => clearTimeout(timer);
  }, [slug, legalName, checkKey, activeHold]);
  const shownCheck = !activeHold && nameCheck && nameCheck.key === checkKey ? nameCheck : null;

  // An invitation code typed in: does it hold an address for this visitor? Asked once per code, half a second after the last key.
  useEffect(() => {
    if (inviteCode.length < 8 || asked.current.has(inviteCode)) return;
    const timer = setTimeout(() => {
      asked.current.add(inviteCode);
      heldAddress(inviteCode)
        .then((r) => {
          if (r) setHold({ code: inviteCode, slug: r.slug });
        })
        .catch(() => asked.current.delete(inviteCode));
    }, 500);
    return () => clearTimeout(timer);
  }, [inviteCode]);
  const setLegalName = (e: { target: { value: string } }) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, companyName: value, ...(slugTyped ? {} : { slug: suggestedName(value) }) }));
  };
  const setSlug = (e: { target: { value: string } }) => {
    setSlugTyped(e.target.value.trim() !== "");
    setForm((f) => ({ ...f, slug: e.target.value }));
  };

  // While it is being set up: every two seconds, until it is ready or has failed.
  useEffect(() => {
    if (stage.at !== "progress") return;
    let stopped = false;
    const poll = async () => {
      const p = await signupProgress();
      if (stopped) return;
      // Another address — the new workspace's own — so the browser goes there itself.
      if (p.state === "ready") window.location.assign(p.url);
      else if (p.state === "failed") setStage({ at: "failed", message: p.message });
      else if (p.state === "gone") setStage({ at: "failed", message: "This signup has expired. Start again." });
      else {
        setStage({ at: "progress", step: p.step });
        setTimeout(poll, 2_000);
      }
    };
    const first = setTimeout(poll, 1_000);
    return () => {
      stopped = true;
      clearTimeout(first);
    };
    // Started once per entry into "progress"; the step text updating must not restart it.
  }, [stage.at]);

  if (stage.at === "progress") {
    return (
      <div className="mt-6 space-y-2 text-sm" role="status">
        <p className="text-text">Setting up your workspace…</p>
        <p className="text-muted">{stage.step}</p>
      </div>
    );
  }
  if (stage.at === "failed") return <p className="mt-6 text-sm text-danger">{stage.message}</p>;

  if (stage.at === "code") {
    return (
      <form
        className="mt-6 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          startTransition(async () => {
            const r = await verifySignup(code);
            if (r.ok) setStage({ at: "progress", step: "Waiting to start" });
            else setError(r.error);
          });
        }}
      >
        <p className="text-sm text-muted">We have sent a six-digit code to {stage.email}. It works for 15 minutes.</p>
        <div>
          <Label htmlFor="code">Code</Label>
          <Input id="code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={7} />
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <Button type="submit" disabled={pending || code.replace(/\s/g, "").length !== 6}>
          {pending ? "Checking…" : "Set up my workspace"}
        </Button>
      </form>
    );
  }

  return (
    <form
      className="mt-6 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const r = await startSignup(activeHold ? { ...form, slug: activeHold.slug } : form);
          if (r.ok) setStage({ at: "code", email: r.data.email });
          else setError(r.error);
        });
      }}
    >
      <div>
        <Label htmlFor="company">Registered business name</Label>
        <Input id="company" value={form.companyName} onChange={setLegalName} autoComplete="organization" aria-describedby="company-hint" required />
        <p id="company-hint" className="mt-1 text-xs text-muted">
          {activeHold ? "Exactly as on your GST registration or certificate of incorporation." : "Exactly as on your GST registration or certificate of incorporation — your address is made from it."}
        </p>
      </div>
      <div>
        <Label htmlFor="slug">Your address</Label>
        <div className={`flex items-center rounded-base border border-line pr-2 text-sm ${activeHold ? "bg-surface-sunken" : "bg-surface"}`}>
          <Input
            id="slug"
            value={activeHold ? activeHold.slug : form.slug}
            onChange={setSlug}
            readOnly={!!activeHold}
            placeholder="acmetechnologies"
            className="border-0 bg-transparent shadow-none"
            autoComplete="off"
            aria-describedby="slug-hint"
            required
          />
          <span className="whitespace-nowrap text-muted">{suffix}</span>
          {activeHold && <Lock aria-hidden="true" className="ml-2 h-4 w-4 shrink-0 text-muted" />}
        </div>
        {activeHold ? (
          <p id="slug-hint" className="mt-1 text-xs text-muted" role="status">
            This address was set up for you with your invitation.
          </p>
        ) : (
          <p id="slug-hint" className="mt-1 text-xs text-muted">At least {MIN_SIGNUP_NAME} letters or digits, made from your registered name — its words in order.</p>
        )}
        {shownCheck && <p className={`mt-1 text-xs ${shownCheck.ok ? "text-success" : "text-danger"}`} role="status">{shownCheck.text}</p>}
      </div>
      <div>
        <Label htmlFor="owner">Your name</Label>
        <Input id="owner" value={form.ownerName} onChange={set("ownerName")} autoComplete="name" required />
      </div>
      <div>
        <Label htmlFor="email">Work email</Label>
        <Input id="email" type="email" value={form.email} onChange={set("email")} autoComplete="email" required />
      </div>
      <div>
        <Label htmlFor="password">Password</Label>
        <Input id="password" type="password" value={form.password} onChange={set("password")} autoComplete="new-password" minLength={10} required />
        <p className="mt-1 text-xs text-subtle">At least 10 characters. You will be the workspace&apos;s owner, with every permission.</p>
      </div>
      <div>
        <Label htmlFor="country">Country</Label>
        <Select id="country" value={form.country} onChange={set("country")}>
          {countries.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="invite">{inviteRequired ? "Invitation code" : "Invitation code (if you have one)"}</Label>
        <Input id="invite" value={form.invite} onChange={set("invite")} autoComplete="off" required={inviteRequired} />
      </div>
      {referredBy ? (
        <div className="flex items-center justify-between gap-3 rounded-base border border-line bg-surface-sunken px-3 py-2">
          <p className="min-w-0 text-sm text-text">{`Referred by ${referredBy}`}</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setReferredBy(null);
              setForm((f) => ({ ...f, referral: "", referralVia: "" }));
            }}
          >
            Remove
          </Button>
        </div>
      ) : (
        <details className="group">
          <summary className="cursor-pointer list-none rounded-md text-sm font-medium text-muted hover:text-text [&::-webkit-details-marker]:hidden">
            <span className="inline-flex items-center gap-1">
              Have a partner code?
              <ChevronDown aria-hidden="true" className="h-4 w-4 transition-transform duration-200 group-open:rotate-180" />
            </span>
          </summary>
          <div className="mt-3">
            <Label htmlFor="referral">Partner code</Label>
            <Input
              id="referral"
              value={form.referral ?? ""}
              onChange={(e) => {
                const value = e.target.value;
                setForm((f) => ({ ...f, referral: value, referralVia: value.trim() ? "typed" : "" }));
              }}
              autoComplete="off"
              maxLength={40}
            />
          </div>
        </details>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button type="submit" disabled={pending}>
        {pending ? "Sending your code…" : "Continue"}
      </Button>
    </form>
  );
}
