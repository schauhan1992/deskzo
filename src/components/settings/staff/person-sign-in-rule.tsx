"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { getPersonSignIn, setPersonSignIn } from "@/actions/sign-in-rules";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { METHOD_LABELS, type SignInMethod } from "@/lib/workplace/sign-in-rules";

type State = NonNullable<Awaited<ReturnType<typeof getPersonSignIn>>>;

/**
 * Staff & roles → a person → Sign-in (owner, 2 Oct 2026): their own rule — "Microsoft only", single
 * sign-on, password only — or their role's, or the company's. Shown only to whoever may change how
 * people sign in (security.manage); everybody else never sees the section.
 */
export function PersonSignInRule({ userId, name }: { userId: string; name: string }) {
  const router = useRouter();
  const [state, setState] = useState<State | null | undefined>(undefined);
  const [method, setMethod] = useState<SignInMethod | "">("");
  const [pending, startTransition] = useTransition();
  const [said, setSaid] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    getPersonSignIn(userId)
      .then((next) => {
        if (!live) return;
        setState(next);
        setMethod(next?.method ?? "");
      })
      .catch(() => {
        if (live) setState(null);
      });
    return () => {
      live = false;
    };
  }, [userId]);

  if (!state) return null;

  const id = `staff-${userId}-sign-in`;
  const fallback = state.roleMethod ? `Their role's: ${state.roleName} — ${METHOD_LABELS[state.roleMethod]}` : "The company's setting";
  const dirty = method !== (state.method ?? "");

  function save() {
    setSaid(null);
    startTransition(async () => {
      const result = await setPersonSignIn({ userId, method: method || null });
      if (!result.ok) {
        setSaid({ tone: "error", text: result.error });
        return;
      }
      const next = await getPersonSignIn(userId).catch(() => null);
      setState(next);
      setMethod(next?.method ?? "");
      setSaid({ tone: "success", text: "Saved." });
      router.refresh();
    });
  }

  return (
    <div className="space-y-2 rounded-base border border-line px-4 py-3">
      <div className="text-sm text-text">Sign-in</div>
      {state.superAdmin ? (
        <p className="text-sm text-muted">The super admin always keeps password sign-in — it&apos;s the way back in if a provider breaks.</p>
      ) : (
        <>
          <label htmlFor={id} className="block text-xs text-muted">
            How {name} signs in
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Select id={id} value={method} disabled={pending} onChange={(e) => setMethod(e.target.value as SignInMethod | "")} className="w-auto">
              <option value="">{fallback}</option>
              {[...state.choices, ...(state.method && !state.choices.includes(state.method) ? [state.method] : [])].map((m) => (
                <option key={m} value={m}>
                  {METHOD_LABELS[m]}
                  {state.choices.includes(m) ? "" : " (switched off)"}
                </option>
              ))}
            </Select>
            <Button type="button" size="sm" variant="secondary" onClick={save} disabled={pending || !dirty}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
          <p className={state.lockedOut ? "text-xs text-danger" : "text-xs text-muted"}>
            {state.lockedOut ? "Can't sign in at all: the sign-in this rule names is switched off." : `Signs in with ${state.ways} now.`}
          </p>
        </>
      )}
      {said && (
        <p role={said.tone === "error" ? "alert" : "status"} className={said.tone === "error" ? "text-sm text-danger" : "text-sm text-success"}>
          {said.text}
        </p>
      )}
    </div>
  );
}
