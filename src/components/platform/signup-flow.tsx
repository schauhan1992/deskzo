"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { ChevronDown, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { SiteLogoMark } from "@/components/site/logo";
import { checkWorkspaceName, heldAddress, signupProgress, startSignup, verifySignup, type SignupForm } from "@/actions/platform/signup";
import { MIN_SIGNUP_NAME, suggestedName } from "@/lib/workspace-names";
import { DEFAULT_BRAND_NAME } from "@/lib/brand-names";
import {
  CODE_LENGTH,
  CODE_TTL_MINUTES,
  MIN_PASSWORD,
  codeShapeProblem,
  companyNameProblem,
  countryProblem,
  emailShapeProblem,
  firstIssue,
  inviteRequiredProblem,
  ownerNameProblem,
  passwordProblem,
  simpleSignupIssues,
  slugRequiredProblem,
  type SignupField,
  type SignupIssues,
} from "@/lib/signup-fields";
import type { Country } from "@/lib/geo/countries";

type Stage = { at: "form" } | { at: "code"; email: string } | { at: "progress"; step: string; ready?: boolean } | { at: "failed"; message: string };

/** A partner's live referral code, checked by the signup page (src/app/platform-site/signup/page.tsx) — from its link or the referral cookie. */
export type SignupReferral = { code: string; partnerName: string; via: "link" | "cookie" };

/** Each field's input, for focusing the first one with a problem. */
const FIELD_ID: Record<SignupField, string> = {
  companyName: "company",
  slug: "slug",
  ownerName: "owner",
  email: "email",
  password: "password",
  country: "country",
  invite: "invite",
  referral: "referral",
};

/** A field marked invalid shows it in its border as well as in words. */
const INVALID_BORDER = "aria-[invalid=true]:border-danger";

/** The ids a field's hint and error get, joined for `aria-describedby`. */
const describedBy = (...ids: (string | false | null | undefined)[]) => ids.filter(Boolean).join(" ") || undefined;

/**
 * The brand's mark, gently floating while something is under way — the form being checked, the code,
 * and above all the workspace being set up — with a polite live line saying what is actually happening
 * (the real step from `signupProgress`, never a made-up percentage). Still with reduced motion.
 */
export function SignupLoader({ brandName, status, large = false, children }: { brandName: string; status: string; large?: boolean; children?: ReactNode }) {
  return (
    <div className={large ? "flex flex-col items-center py-6 text-center" : "flex items-center gap-3"}>
      <span className={`flex shrink-0 flex-col items-center ${large ? "gap-3" : "gap-1.5"}`} aria-hidden="true">
        <span className="animate-float">
          <SiteLogoMark name={brandName} className={large ? "h-16 w-16 rounded-2xl text-2xl shadow-md" : "h-8 w-8"} />
        </span>
        <span className={`animate-float-shadow block rounded-full bg-text/25 blur-[2px] ${large ? "h-2 w-12" : "h-1 w-6"}`} />
      </span>
      <div className={large ? "mt-5 space-y-1.5" : "min-w-0"}>
        {children}
        <p role="status" aria-live="polite" className={large ? "text-sm text-muted" : "text-sm text-muted"}>
          {status}
        </p>
      </div>
    </div>
  );
}

/** A field's hint and its error, under it. */
function Note({ id, error, children }: { id: string; error?: string | null; children?: ReactNode }) {
  return (
    <>
      {children}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </>
  );
}

/** What the progress page says while a workspace is set up — the worker's own step, as it reports it. */
function progressLine(step: string, ready: boolean): string {
  if (ready || step === "Ready") return "Almost there — opening your workspace…";
  if (!step || step === "Waiting to start") return "Getting ready to start…";
  return /[.…]$/.test(step) ? step : `${step}…`;
}

/**
 * The signup, in three screens: the form, the emailed code, and the workspace being set up — which
 * ends by going straight into it, signed in (src/actions/platform/signup.ts).
 *
 * Every field says what is wrong with it, under it, and why (src/lib/signup-fields.ts): the simple
 * checks as each field is left, then everything the server finds — at once — when the form is sent,
 * with focus on the first field that needs another look. The address keeps its live check.
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
  brandName = DEFAULT_BRAND_NAME,
}: {
  suffix: string;
  countries: Country[];
  inviteRequired?: boolean;
  referral?: SignupReferral | null;
  /** An invitation code to start with — from the signup link. */
  invite?: string;
  /** The address `invite` holds, as the page looked it up; null when it holds none. */
  held?: string | null;
  /** The site's name, for the floating mark — the same one the header shows. */
  brandName?: string;
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
  const [partnerOpen, setPartnerOpen] = useState(false);
  // Remembered with the address and registered name it was for, so an answer about earlier ones is never shown.
  const [nameCheck, setNameCheck] = useState<{ key: string; ok: boolean; text: string } | null>(null);
  // The address follows the registered name until the visitor types one of their own.
  const [slugTyped, setSlugTyped] = useState(false);
  const [code, setCode] = useState("");
  // What is wrong with each field: found here as a field is left, or by the server when the form is sent.
  const [checked, setChecked] = useState<SignupIssues>({});
  const [fromServer, setFromServer] = useState<SignupIssues>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [codeNotice, setCodeNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const countryKnown = (c: string) => countries.some((x) => x.code === c);
  const values = () => ({ ...form, slug: activeHold ? activeHold.slug : form.slug });
  const problemOf = (field: SignupField, v: SignupForm): string | null => {
    switch (field) {
      case "companyName":
        return companyNameProblem(v.companyName);
      case "slug":
        return slugRequiredProblem(activeHold ? activeHold.slug : v.slug);
      case "ownerName":
        return ownerNameProblem(v.ownerName);
      case "email":
        return emailShapeProblem(v.email);
      case "password":
        return passwordProblem(v.password);
      case "country":
        return countryProblem(v.country, countryKnown);
      case "invite":
        return inviteRequiredProblem(v.invite, inviteRequired);
      case "referral":
        return null;
    }
  };
  const issueOf = (field: SignupField) => checked[field] ?? fromServer[field] ?? null;

  /** A field changed: the server's word on it no longer stands, and an error shown is checked again as it is fixed. */
  const change = (field: SignupField, patch: Partial<SignupForm>) => {
    const next = { ...form, ...patch };
    setForm(next);
    setFromServer((all) => (all[field] ? { ...all, [field]: undefined } : all));
    setChecked((all) => (all[field] ? { ...all, [field]: problemOf(field, next) ?? undefined } : all));
  };
  /** A field was left: its own checks, now. */
  const leave = (field: SignupField) => setChecked((all) => ({ ...all, [field]: problemOf(field, form) ?? undefined }));
  const set = (field: SignupField) => (e: { target: { value: string } }) => change(field, { [field]: e.target.value });

  function focusField(field: SignupField | null) {
    if (!field) return;
    const input = document.getElementById(FIELD_ID[field]);
    // The partner code sits in a disclosure: opened first, or the field can't take focus.
    if (field === "referral") {
      setPartnerOpen(true);
      input?.closest("details")?.setAttribute("open", "");
    }
    input?.focus();
  }

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
    change("companyName", { companyName: value, ...(slugTyped ? {} : { slug: suggestedName(value) }) });
  };
  const setSlug = (e: { target: { value: string } }) => {
    setSlugTyped(e.target.value.trim() !== "");
    change("slug", { slug: e.target.value });
  };

  // While it is being set up: every two seconds, until it is ready or has failed.
  useEffect(() => {
    if (stage.at !== "progress") return;
    let stopped = false;
    const poll = async () => {
      const p = await signupProgress();
      if (stopped) return;
      // Another address — the new workspace's own — so the browser goes there itself.
      if (p.state === "ready") {
        setStage({ at: "progress", step: "Ready", ready: true });
        window.location.assign(p.url);
      } else if (p.state === "failed") setStage({ at: "failed", message: p.message });
      else if (p.state === "gone") setStage({ at: "failed", message: "This signup has expired — start again, and we'll send you a new code." });
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

  /** The form, to the server: every problem comes back at once. Also how a new code is sent. */
  function send(then?: () => void) {
    setFormError(null);
    startTransition(async () => {
      const r = await startSignup(values());
      if (r.ok) {
        setStage({ at: "code", email: r.data.email });
        then?.();
        return;
      }
      const issues = r.issues ?? {};
      setStage({ at: "form" });
      setChecked({});
      setFromServer(issues);
      // Something that is no one field's — or, from an older server, the one line it sent.
      setFormError(r.formError ?? (firstIssue(issues) ? null : r.error));
      focusField(firstIssue(issues) as SignupField | null);
    });
  }

  if (stage.at === "progress") {
    return (
      <div className="mt-6">
        <SignupLoader brandName={brandName} status={progressLine(stage.step, !!stage.ready)} large>
          <p className="text-base font-semibold text-text">Setting up your workspace</p>
        </SignupLoader>
        <p className="mx-auto max-w-xs text-center text-xs text-subtle">It usually takes under a minute. Keep this page open — you&apos;ll go straight in when it&apos;s ready.</p>
      </div>
    );
  }
  if (stage.at === "failed") {
    return (
      <div className="mt-6 space-y-4">
        <p className="text-sm text-danger" role="alert">
          {stage.message}
        </p>
        <Button type="button" variant="secondary" onClick={() => setStage({ at: "form" })}>
          Start again
        </Button>
      </div>
    );
  }

  if (stage.at === "code") {
    const codeError = checked.code ?? fromServer.code ?? null;
    return (
      <form
        className="mt-6 space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (pending) return;
          setFormError(null);
          setCodeNotice(null);
          const shape = codeShapeProblem(code);
          if (shape) {
            setChecked({ code: shape });
            document.getElementById("code")?.focus();
            return;
          }
          startTransition(async () => {
            const r = await verifySignup(code);
            if (r.ok) {
              setStage({ at: "progress", step: "Waiting to start" });
              return;
            }
            setChecked({});
            setFromServer(r.issues ?? {});
            setFormError(r.formError ?? (r.issues?.code ? null : r.error));
            if (r.issues?.code) document.getElementById("code")?.focus();
          });
        }}
      >
        <p className="text-sm text-muted">
          We have sent a {CODE_LENGTH}-digit code to <span className="font-medium text-text">{stage.email}</span>. It works for {CODE_TTL_MINUTES} minutes.
        </p>
        <div>
          <Label htmlFor="code">Code</Label>
          <Input
            id="code"
            className={INVALID_BORDER}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setFromServer({});
              setChecked((all) => (all.code ? { code: codeShapeProblem(e.target.value) ?? undefined } : all));
            }}
            onBlur={() => code && setChecked({ code: codeShapeProblem(code) ?? undefined })}
            maxLength={7}
            aria-invalid={codeError ? true : undefined}
            aria-describedby={describedBy(codeError && "code-error")}
          />
          <Note id="code" error={codeError} />
        </div>
        {formError && (
          <p className="text-sm text-danger" role="alert">
            {formError}
          </p>
        )}
        {pending ? (
          <SignupLoader brandName={brandName} status="Checking…" />
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit">Set up my workspace</Button>
            <Button type="button" variant="ghost" onClick={() => send(() => {
              setCode("");
              setChecked({});
              setFromServer({});
              setCodeNotice(`We've sent a new code to ${stage.email}. The one before no longer works.`);
            })}>
              Send a new code
            </Button>
          </div>
        )}
        {codeNotice && !pending && (
          <p className="text-xs text-muted" role="status">
            {codeNotice}
          </p>
        )}
        <p className="text-xs text-subtle">
          Wrong address?{" "}
          <button type="button" className="font-medium text-brand hover:underline" onClick={() => setStage({ at: "form" })}>
            Change your details
          </button>{" "}
          — everything you typed is still there.
        </p>
      </form>
    );
  }

  const slugError = issueOf("slug") ?? (shownCheck && !shownCheck.ok ? shownCheck.text : null);
  return (
    <form
      className="mt-6 space-y-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (pending) return;
        setFormError(null);
        // The simple checks first, here — the same ones the server makes, so nothing goes out to be refused.
        const local = simpleSignupIssues(values(), { inviteRequired, countryKnown });
        setChecked(local);
        const first = firstIssue(local) as SignupField | null;
        if (first) {
          focusField(first);
          return;
        }
        send();
      }}
    >
      <div>
        <Label htmlFor="company">Registered business name</Label>
        <Input
          id="company"
          className={INVALID_BORDER}
          value={form.companyName}
          onChange={setLegalName}
          onBlur={() => leave("companyName")}
          autoComplete="organization"
          aria-invalid={issueOf("companyName") ? true : undefined}
          aria-describedby={describedBy("company-hint", issueOf("companyName") && "company-error")}
          required
        />
        <Note id="company" error={issueOf("companyName")}>
          <p id="company-hint" className="mt-1 text-xs text-muted">
            {activeHold ? "Exactly as on your GST registration or certificate of incorporation." : "Exactly as on your GST registration or certificate of incorporation — your address is made from it."}
          </p>
        </Note>
      </div>
      <div>
        <Label htmlFor="slug">Your address</Label>
        <div className={`flex items-center rounded-base border pr-2 text-sm ${slugError ? "border-danger" : "border-line"} ${activeHold ? "bg-surface-sunken" : "bg-surface"}`}>
          <Input
            id="slug"
            value={activeHold ? activeHold.slug : form.slug}
            onChange={setSlug}
            readOnly={!!activeHold}
            onBlur={() => leave("slug")}
            placeholder="acmetechnologies"
            className="border-0 bg-transparent shadow-none"
            autoComplete="off"
            aria-invalid={slugError ? true : undefined}
            aria-describedby={describedBy("slug-hint", slugError && "slug-error", !slugError && shownCheck?.ok && "slug-check")}
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
        {slugError ? (
          <p id="slug-error" className="mt-1 text-xs font-medium text-danger" role="status">
            {slugError}
          </p>
        ) : (
          shownCheck?.ok && (
            <p id="slug-check" className="mt-1 text-xs text-success" role="status">
              {shownCheck.text}
            </p>
          )
        )}
      </div>
      <div>
        <Label htmlFor="owner">Your name</Label>
        <Input
          id="owner"
          className={INVALID_BORDER}
          value={form.ownerName}
          onChange={set("ownerName")}
          onBlur={() => leave("ownerName")}
          autoComplete="name"
          aria-invalid={issueOf("ownerName") ? true : undefined}
          aria-describedby={describedBy(issueOf("ownerName") && "owner-error")}
          required
        />
        <Note id="owner" error={issueOf("ownerName")} />
      </div>
      <div>
        <Label htmlFor="email">Work email</Label>
        <Input
          id="email"
          className={INVALID_BORDER}
          type="email"
          value={form.email}
          onChange={set("email")}
          onBlur={() => leave("email")}
          autoComplete="email"
          aria-invalid={issueOf("email") ? true : undefined}
          aria-describedby={describedBy(issueOf("email") && "email-error")}
          required
        />
        <Note id="email" error={issueOf("email")} />
      </div>
      <div>
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          className={INVALID_BORDER}
          type="password"
          value={form.password}
          onChange={set("password")}
          onBlur={() => leave("password")}
          autoComplete="new-password"
          minLength={MIN_PASSWORD}
          aria-invalid={issueOf("password") ? true : undefined}
          aria-describedby={describedBy("password-hint", issueOf("password") && "password-error")}
          required
        />
        <Note id="password" error={issueOf("password")}>
          <p id="password-hint" className="mt-1 text-xs text-subtle">
            At least {MIN_PASSWORD} characters. You will be the workspace&apos;s owner, with every permission.
          </p>
        </Note>
      </div>
      <div>
        <Label htmlFor="country">Country</Label>
        <Select
          id="country"
          className={INVALID_BORDER}
          value={form.country}
          onChange={set("country")}
          onBlur={() => leave("country")}
          aria-invalid={issueOf("country") ? true : undefined}
          aria-describedby={describedBy(issueOf("country") && "country-error")}
        >
          {countries.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </Select>
        <Note id="country" error={issueOf("country")} />
      </div>
      <div>
        <Label htmlFor="invite">{inviteRequired ? "Invitation code" : "Invitation code (if you have one)"}</Label>
        <Input
          id="invite"
          className={INVALID_BORDER}
          value={form.invite}
          onChange={set("invite")}
          onBlur={() => leave("invite")}
          autoComplete="off"
          aria-invalid={issueOf("invite") ? true : undefined}
          aria-describedby={describedBy(issueOf("invite") && "invite-error")}
          required={inviteRequired}
        />
        <Note id="invite" error={issueOf("invite")} />
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
              change("referral", { referral: "", referralVia: "" });
            }}
          >
            Remove
          </Button>
        </div>
      ) : (
        <details className="group" open={partnerOpen || !!issueOf("referral")} onToggle={(e) => setPartnerOpen(e.currentTarget.open)}>
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
              className={INVALID_BORDER}
              value={form.referral ?? ""}
              onChange={(e) => {
                const value = e.target.value;
                change("referral", { referral: value, referralVia: value.trim() ? "typed" : "" });
              }}
              autoComplete="off"
              maxLength={40}
              aria-invalid={issueOf("referral") ? true : undefined}
              aria-describedby={describedBy(issueOf("referral") && "referral-error")}
            />
            <Note id="referral" error={issueOf("referral")} />
          </div>
        </details>
      )}
      {formError && (
        <p className="text-sm text-danger" role="alert">
          {formError}
        </p>
      )}
      {pending ? (
        <SignupLoader brandName={brandName} status="Checking your details and sending your code…" />
      ) : (
        <Button type="submit">Continue</Button>
      )}
    </form>
  );
}
