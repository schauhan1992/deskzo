"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { checkWorkspaceName, signupProgress, startSignup, verifySignup, type SignupForm } from "@/actions/platform/signup";
import type { Country } from "@/lib/geo/countries";

type Stage = { at: "form" } | { at: "code"; email: string } | { at: "progress"; step: string } | { at: "failed"; message: string };

/**
 * The signup, in three screens: the form, the emailed code, and the workspace being set up — which
 * ends by going straight into it, signed in (src/actions/platform/signup.ts).
 */
export function SignupFlow({ suffix, countries, inviteRequired = true }: { suffix: string; countries: Country[]; inviteRequired?: boolean }) {
  const [stage, setStage] = useState<Stage>({ at: "form" });
  const [form, setForm] = useState<SignupForm>({ companyName: "", slug: "", ownerName: "", email: "", password: "", country: "IN", invite: "" });
  // Remembered with the name it was for, so an answer about an earlier name is never shown.
  const [nameCheck, setNameCheck] = useState<{ slug: string; ok: boolean; text: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const set = (key: keyof SignupForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));

  // The address, checked as it is typed — half a second after the last key.
  const slug = form.slug.trim().toLowerCase();
  useEffect(() => {
    if (!slug) return;
    const timer = setTimeout(() => {
      checkWorkspaceName(slug).then((r) => setNameCheck(r.ok ? { slug, ok: true, text: `${r.data.host} is free` } : { slug, ok: false, text: r.error }));
    }, 500);
    return () => clearTimeout(timer);
  }, [slug]);
  const shownCheck = nameCheck && nameCheck.slug === slug ? nameCheck : null;

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
          const r = await startSignup(form);
          if (r.ok) setStage({ at: "code", email: r.data.email });
          else setError(r.error);
        });
      }}
    >
      <div>
        <Label htmlFor="company">Company</Label>
        <Input id="company" value={form.companyName} onChange={set("companyName")} autoComplete="organization" required />
      </div>
      <div>
        <Label htmlFor="slug">Your address</Label>
        <div className="flex items-center rounded-base border border-line bg-surface pr-2 text-sm">
          <Input id="slug" value={form.slug} onChange={set("slug")} placeholder="yourcompany" className="border-0 shadow-none" autoComplete="off" required />
          <span className="whitespace-nowrap text-muted">{suffix}</span>
        </div>
        {shownCheck && <p className={`mt-1 text-xs ${shownCheck.ok ? "text-success" : "text-danger"}`}>{shownCheck.text}</p>}
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
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button type="submit" disabled={pending}>
        {pending ? "Sending your code…" : "Continue"}
      </Button>
    </form>
  );
}
