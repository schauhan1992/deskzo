"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { beginTwoFactorSetup, confirmTwoFactorSetup, disableOwnTwoFactor } from "@/actions/profile";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/card";

export function TwoFactorSetup({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState<"idle" | "confirmIdentity" | "setup" | "disable">("idle");
  const [secret, setSecret] = useState<string | null>(null);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function startSetup() {
    setError(null);
    startTransition(async () => {
      const result = await beginTwoFactorSetup({ currentPassword });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSecret(result.data.secret);
      setQrCodeDataUrl(result.data.qrCodeDataUrl);
      setCurrentPassword("");
      setStep("setup");
    });
  }

  function confirmSetup() {
    setError(null);
    startTransition(async () => {
      const result = await confirmTwoFactorSetup({ code });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setStep("idle");
      setCode("");
      router.refresh();
    });
  }

  function disable() {
    setError(null);
    startTransition(async () => {
      const result = await disableOwnTwoFactor({ currentPassword });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setStep("idle");
      setCurrentPassword("");
      router.refresh();
    });
  }

  if (step === "setup") {
    return (
      <div className="space-y-3">
        {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
        <p className="text-sm text-muted">
          Scan this with Microsoft Authenticator (or any authenticator app), then enter the 6-digit code it shows.
        </p>
        {qrCodeDataUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- a locally-generated data: URI, not a remote image
          <img src={qrCodeDataUrl} alt="Two-factor QR code" className="h-40 w-40 rounded-md border border-line" />
        )}
        <p className="text-xs text-subtle">
          Can&apos;t scan? Enter this key manually: <span className="font-mono">{secret}</span>
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="tfa-code">6-digit code</Label>
          <Input
            id="tfa-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoFocus
          />
        </div>
        <div className="flex gap-2">
          <Button type="button" size="sm" onClick={confirmSetup} disabled={isPending || code.length < 6}>
            {isPending ? "Verifying…" : "Confirm"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setStep("idle")} disabled={isPending}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  if (step === "confirmIdentity") {
    return (
      <div className="space-y-3">
        {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
        <p className="text-sm text-muted">
          {/*
            Said plainly, because being asked for a password to set up a password-adjacent thing
            looks like a bug unless the reason is given.
          */}
          Confirm it&rsquo;s you before changing how this account signs in. A session on a borrowed or
          stolen machine should not be enough to swap the authenticator.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="tfa-setup-password">Current password</Label>
          <Input
            id="tfa-setup-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoFocus
          />
        </div>
        <div className="flex gap-2">
          <Button type="button" size="sm" onClick={startSetup} disabled={isPending || !currentPassword}>
            {isPending ? "Checking…" : "Continue"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setCurrentPassword("");
              setError(null);
              setStep("idle");
            }}
            disabled={isPending}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  if (step === "disable") {
    return (
      <div className="space-y-3">
        {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="space-y-1.5">
          <Label htmlFor="tfa-disable-password">Current password</Label>
          <Input
            id="tfa-disable-password"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoFocus
          />
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="danger" size="sm" onClick={disable} disabled={isPending}>
            {isPending ? "Disabling…" : "Disable two-factor"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setStep("idle")} disabled={isPending}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between">
      <div>
        {enabled ? <Badge tone="green">Enabled</Badge> : <Badge tone="default">Not set up</Badge>}
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      </div>
      {enabled ? (
        <div className="flex gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => setStep("confirmIdentity")}>
            Replace authenticator
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setStep("disable")}>
            Disable
          </Button>
        </div>
      ) : (
        <Button type="button" size="sm" onClick={() => setStep("confirmIdentity")} disabled={isPending}>
          Set up two-factor
        </Button>
      )}
    </div>
  );
}
