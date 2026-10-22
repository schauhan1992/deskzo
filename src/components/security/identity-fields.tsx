"use client";

import { Input } from "@/components/ui/input";

/**
 * "Confirm it's you" before something that can't be taken back — a restore, a workspace reset (owner,
 * 22 Oct 2026; checked on the server by src/lib/security/confirm-identity.ts). The person's own password,
 * and their two-factor code once the server says they have two-factor on (`showCode`).
 */
export function IdentityFields({
  idPrefix,
  password,
  onPassword,
  code,
  onCode,
  showCode,
}: {
  idPrefix: string;
  password: string;
  onPassword: (value: string) => void;
  code: string;
  onCode: (value: string) => void;
  showCode: boolean;
}) {
  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={`${idPrefix}-password`} className="text-xs font-medium text-text">
          Your password
        </label>
        <Input
          id={`${idPrefix}-password`}
          type="password"
          value={password}
          onChange={(e) => onPassword(e.target.value)}
          className="mt-1"
          autoComplete="current-password"
        />
        <p className="mt-1 text-xs text-subtle">To confirm it&apos;s you — the one you sign in with.</p>
      </div>
      {showCode && (
        <div>
          <label htmlFor={`${idPrefix}-code`} className="text-xs font-medium text-text">
            Two-factor code
          </label>
          <Input
            id={`${idPrefix}-code`}
            value={code}
            onChange={(e) => onCode(e.target.value)}
            className="mt-1 font-mono"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={8}
          />
        </div>
      )}
    </div>
  );
}
