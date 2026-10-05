"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { consoleResendSignupCode } from "@/actions/platform/console-signups";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { Button } from "@/components/ui/button";

/**
 * "Send a new code" for a signup whose address was never confirmed (src/lib/platform/signup-code.ts):
 * a new six-digit code to the address it was made with, replacing the old. Offered while the
 * signing-up browser's day lasts (`pageEndsAt`); after that, a new code can't finish it, and the row
 * says to sign up again instead.
 */
export function ResendCode({ signupId, email, pageEndsAt }: { signupId: string; email: string; pageEndsAt: Date }) {
  const [open, setOpen] = useState(false);
  const { pending, error, run, reset } = useConsoleAction<{ email: string; until: string }>();
  // Read once, when drawn: the page is reloaded after any change.
  const [now] = useState(() => Date.now());
  if (pageEndsAt.getTime() - now < 5 * 60_000) {
    return <p className="mt-1 max-w-[14rem] text-[11px] text-subtle">Their signup page has run out — ask them to sign up again.</p>;
  }
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="mt-1 -ml-2"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        <Send aria-hidden="true" className="h-3.5 w-3.5" />
        Send a new code
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => {
          if (!pending) setOpen(false);
        }}
        title="Send a new signup code"
        confirmLabel="Send the code"
        pending={pending}
        error={error}
        onConfirm={() =>
          run(() => consoleResendSignupCode(signupId), {
            success: (r) => `A new code went to ${r.email}.`,
            onDone: () => setOpen(false),
          })
        }
      >
        <ImpactList
          items={[
            { label: "Sent to", value: email },
            { label: "The old code", value: "Stops working" },
            { label: "Works for", value: "An hour" },
          ]}
        />
        <p>They enter it on the signup page, in the browser where they started. Nobody here sees the code.</p>
      </ConfirmDialog>
    </>
  );
}
