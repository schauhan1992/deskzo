"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { ConsoleResult } from "@/actions/platform/console";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";

/**
 * One console action as a button: a server action with its arguments already bound on the page
 * (`consoleResume.bind(null, id)`), an optional "are you sure", and the answer shown beside it. The
 * page is refreshed after it works, so what it changed shows at once.
 */
export function ConsoleAction({
  action,
  label,
  confirm,
  variant = "secondary",
  done,
}: {
  action: () => Promise<ConsoleResult<unknown>>;
  label: string;
  confirm?: string;
  variant?: Variant;
  /** Said after it works, for an action whose effect is not visible on the page. */
  done?: string;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant={variant}
        disabled={pending}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          setMessage(null);
          startTransition(async () => {
            const r = await action();
            if (!r.ok) setMessage({ ok: false, text: r.error });
            else {
              if (done) setMessage({ ok: true, text: done });
              router.refresh();
            }
          });
        }}
      >
        {pending ? "Working…" : label}
      </Button>
      {message && <span className={message.ok ? "text-xs text-success" : "text-xs text-danger"}>{message.text}</span>}
    </span>
  );
}
