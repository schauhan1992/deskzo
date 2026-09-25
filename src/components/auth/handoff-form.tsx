"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { handoffAction } from "@/actions/auth";

/** Spends the pass as soon as the page opens — once, even under React's double effects in development. */
export function HandoffForm({ ticket }: { ticket: string }) {
  const [error, setError] = useState<string | null>(ticket ? null : "This sign-in link is incomplete.");
  const started = useRef(false);

  useEffect(() => {
    if (!ticket || started.current) return;
    started.current = true;
    handoffAction(ticket).then((result) => {
      if (result?.error) setError(result.error);
    });
  }, [ticket]);

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
  return <p className="text-sm text-muted">Signing you in to your new workspace…</p>;
}
