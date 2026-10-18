"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { handoffAction } from "@/actions/auth";

/** Spends the pass as soon as the page opens — once, even under React's double effects in development. */
/** `next`: where the Deskzo app's pages land (src/lib/app/web-session.ts) — a new owner goes to Getting started. */
export function HandoffForm({ ticket, next }: { ticket: string; next?: string }) {
  const [error, setError] = useState<string | null>(ticket ? null : "This sign-in link is incomplete.");
  const started = useRef(false);

  useEffect(() => {
    if (!ticket || started.current) return;
    started.current = true;
    handoffAction(ticket, next).then((result) => {
      if (result?.error) setError(result.error);
    });
  }, [ticket, next]);

  if (error) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-text">{error}</p>
        <Link href="/login" className="text-brand hover:underline">
          Go to sign in
        </Link>
      </div>
    );
  }
  return <p className="text-sm text-muted">{next ? "Signing you in…" : "Signing you in to your new workspace…"}</p>;
}
