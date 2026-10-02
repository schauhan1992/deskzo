"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setRoleSignIn } from "@/actions/sign-in-rules";
import { Select } from "@/components/ui/input";
import { METHOD_LABELS, type SignInMethod } from "@/lib/workplace/sign-in-rules";

/**
 * Settings → Security → Sign-in, by role (owner, 2 Oct 2026): how everybody in a role may sign in —
 * "Microsoft only", single sign-on, password only — or the company's own setting. A person's own rule,
 * set in Staff & roles, wins over their role's. Saved as each is chosen.
 */
export function RoleSignInRules({
  roles,
  choices,
}: {
  roles: { key: string; name: string; method: SignInMethod | null }[];
  /** What a rule may say now: the sign-ins the company has switched on, and the password. */
  choices: SignInMethod[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [methods, setMethods] = useState<Record<string, SignInMethod | null>>(Object.fromEntries(roles.map((r) => [r.key, r.method])));
  const [said, setSaid] = useState<{ role: string; tone: "success" | "error"; text: string } | null>(null);

  function choose(role: { key: string; name: string }, value: string) {
    const method = value === "" ? null : (value as SignInMethod);
    const before = methods[role.key] ?? null;
    setMethods((m) => ({ ...m, [role.key]: method }));
    setSaid(null);
    startTransition(async () => {
      const result = await setRoleSignIn({ role: role.key, method });
      if (!result.ok) {
        setMethods((m) => ({ ...m, [role.key]: before }));
        setSaid({ role: role.key, tone: "error", text: result.error });
        return;
      }
      setSaid({ role: role.key, tone: "success", text: "Saved." });
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-sm font-medium text-text">By role</h3>
        <p className="mt-0.5 text-sm text-muted">
          Tie everybody in a role to one way of signing in. A person&apos;s own rule, set in Staff &amp; roles, comes first; the super admin always keeps
          password sign-in, as the way back in.
        </p>
      </div>
      <ul className="divide-y divide-line rounded-base border border-line">
        {roles.map((role) => {
          const method = methods[role.key] ?? null;
          const id = `sign-in-role-${role.key}`;
          return (
            <li key={role.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <label htmlFor={id} className="text-sm text-text">
                {role.name}
              </label>
              <div className="flex items-center gap-2">
                {said?.role === role.key && (
                  <span role={said.tone === "error" ? "alert" : "status"} className={said.tone === "error" ? "text-xs text-danger" : "text-xs text-success"}>
                    {said.text}
                  </span>
                )}
                <Select id={id} value={method ?? ""} disabled={pending} onChange={(e) => choose(role, e.target.value)} className="w-auto">
                  <option value="">The company&apos;s setting</option>
                  {/* A rule naming a sign-in since switched off stays visible, so it can be changed. */}
                  {[...choices, ...(method && !choices.includes(method) ? [method] : [])].map((m) => (
                    <option key={m} value={m}>
                      {METHOD_LABELS[m]}
                      {choices.includes(m) ? "" : " (switched off)"}
                    </option>
                  ))}
                </Select>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
