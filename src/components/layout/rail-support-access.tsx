"use client";

import { useEffect, useState } from "react";
import { getSupportAccess, type SupportAccessState } from "@/actions/support-access";
import { SupportAccessCard } from "@/components/settings/support-access-card";

/**
 * Letting Deskzo support in, from the right rail (owner, 2 Oct 2026) — the super admin's alone, as in
 * Settings → Security, where the same card lives: whether support can see the workspace now, and
 * letting them in or ending it without leaving the page.
 *
 * Read again whenever the layout says support came in or left (`inside`): the card refreshes the page
 * after each change, and that is how this panel hears of it.
 */
export function RailSupportAccess({ inside }: { inside: boolean }) {
  const [state, setState] = useState<SupportAccessState | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    getSupportAccess()
      .then((next) => {
        if (live) setState(next);
      })
      .catch(() => {
        if (live) setState(null);
      });
    return () => {
      live = false;
    };
  }, [inside]);

  if (state === undefined) return <p className="text-sm text-muted">Loading…</p>;
  if (state === null) return <p className="text-sm text-muted">Only the super admin can let Deskzo support in.</p>;
  return <SupportAccessCard state={state} compact />;
}
