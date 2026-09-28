"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowUpRight, LifeBuoy, LoaderCircle, X } from "lucide-react";
import { consoleEnterAsSupport } from "@/actions/platform/console";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNotice } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { OutboundLink } from "@/components/ui/outbound-link";
import { cn } from "@/lib/utils";

/**
 * Going in as support, on the workspace's own grant. The server hands back a one-time pass to the
 * workspace's address that works once, within a minute (src/lib/platform/handoff.ts) — so it is shown
 * as a link to open with a countdown beside it, never opened for you: a new tab opened after the
 * round trip would be stopped by the browser as a pop-up.
 *
 * The countdown's end is taken in the click, before the pass exists, so it runs out a moment early
 * rather than late; a one-second interval started there moves it, and is cleared on unmount.
 *
 * `respondToParam` (the header's instance only): `?do=enter` — the palette's "Enter this workspace as
 * support" — highlights the button and puts focus on it. Still one click: nothing is issued until
 * it is pressed.
 */

const PASS_MS = 60_000;

type Pass = { url: string; expiresAt: number };
type After = "none" | "expired" | "opened";

function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function EnterAsSupport({ tenantId, variant = "primary", respondToParam = false }: { tenantId: string; variant?: "primary" | "secondary"; respondToParam?: boolean }) {
  const params = useSearchParams();
  const ready = respondToParam && params.get("do") === "enter";
  const { pending, error, run, reset } = useConsoleAction<{ url: string }>();
  const [pass, setPass] = useState<Pass | null>(null);
  const [now, setNow] = useState(0);
  const [after, setAfter] = useState<After>("none");
  const timer = useRef<number | undefined>(undefined);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const running = timer;
    return () => window.clearInterval(running.current);
  }, []);

  // Sent here to go in: the one thing left to do is press the button, so start there.
  useEffect(() => {
    if (ready) buttonRef.current?.focus();
  }, [ready]);

  // The pass replaces the button that had focus; hand focus to the link that opens it.
  const focusLink = useCallback((node: HTMLElement | null) => {
    node?.querySelector<HTMLAnchorElement>("a")?.focus();
  }, []);

  function stop() {
    window.clearInterval(timer.current);
    timer.current = undefined;
  }

  function getPass() {
    if (pending) return;
    reset();
    stop();
    const expiresAt = Date.now() + PASS_MS;
    run(() => consoleEnterAsSupport(tenantId), {
      refresh: false,
      onDone: (data) => {
        setPass({ url: data.url, expiresAt });
        setNow(Date.now());
        setAfter("none");
        timer.current = window.setInterval(() => {
          const t = Date.now();
          setNow(t);
          if (t >= expiresAt) {
            stop();
            setPass(null);
            setAfter("expired");
          }
        }, 1000);
      },
    });
  }

  function opened() {
    // After the browser has followed the link: the pass is spent either way.
    window.setTimeout(() => {
      stop();
      setPass(null);
      setAfter("opened");
    }, 0);
  }

  function discard() {
    stop();
    setPass(null);
    setAfter("none");
    window.setTimeout(() => buttonRef.current?.focus(), 0);
  }

  const left = pass ? pass.expiresAt - now : 0;
  const announce = pass ? "Your pass is ready. It works once, within a minute." : after === "expired" ? "The pass expired unused." : "";

  return (
    <span className="inline-flex max-w-full flex-col items-start gap-1">
      {pass ? (
        <span ref={focusLink} className="inline-flex max-w-full flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-success/40 bg-success-bg py-1 pr-1 pl-3 text-sm">
          <span className="font-medium text-success">Your pass is ready</span>
          <OutboundLink
            href={pass.url}
            onClick={opened}
            className="inline-flex h-7 items-center gap-1 rounded-base bg-brand px-2.5 text-[13px] font-medium whitespace-nowrap text-brand-contrast shadow-sm hover:brightness-110"
          >
            Open workspace
            <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
            <span className="sr-only"> (opens in a new tab)</span>
          </OutboundLink>
          <span className={cn("text-xs whitespace-nowrap tabular-nums", left <= 10_000 ? "text-warning" : "text-muted")}>{`expires in ${countdown(left)}`}</span>
          <IconButton icon={X} label="Discard the pass" onClick={discard} />
        </span>
      ) : (
        <span className="inline-flex flex-wrap items-center gap-2">
          <Button
            ref={buttonRef}
            type="button"
            size="sm"
            variant={variant}
            onClick={getPass}
            aria-disabled={pending || undefined}
            aria-busy={pending || undefined}
            className={cn(pending && "cursor-wait opacity-70", ready && "ring-brand")}
          >
            {pending ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <LifeBuoy aria-hidden="true" className="h-4 w-4" />}
            Enter as support
          </Button>
          {ready && !pending && <span className="text-xs text-brand">One click for a one-minute pass</span>}
        </span>
      )}
      {!pass && after === "expired" && <span className="text-xs text-muted">That pass expired unused — get a new one.</span>}
      {!pass && after === "opened" && <span className="text-xs text-muted">Opened in a new tab. A pass works once.</span>}
      {error && <ActionNotice tone="error">{error}</ActionNotice>}
      <span aria-live="polite" className="sr-only">
        {announce}
      </span>
    </span>
  );
}
