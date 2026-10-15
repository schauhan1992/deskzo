"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { SupportMailSetup } from "@/actions/support-mail";
import { saveSupportMailSettings } from "@/actions/support-mail";
import type { ReplyFrom } from "@/lib/support-mail/reply-from";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

/**
 * Settings → Support email: where replies to customers go out from (owner, 15 Oct 2026 —
 * src/lib/support-mail/reply-from.ts). Deskzo's mail needs nothing set up; the company's mail server is
 * Settings › Messaging's, sending as the support address the company forwards from. Whatever is chosen, a
 * reply the company's server can't send still goes, through Deskzo's mail, and its ticket says why.
 */
export function SupportReplyFrom({ setup }: { setup: SupportMailSetup }) {
  const router = useRouter();
  const [route, setRoute] = useState<ReplyFrom>(setup.replyFrom);
  const [companyFrom, setCompanyFrom] = useState(setup.companyFrom ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const dirty = route !== setup.replyFrom || (route === "COMPANY" && companyFrom.trim().toLowerCase() !== (setup.companyFrom ?? ""));

  function save() {
    setError(null);
    setSaved(false);
    start(async () => {
      const result = await saveSupportMailSettings({
        acknowledge: setup.acknowledge,
        defaultAssigneeUserId: setup.defaultAssigneeUserId,
        replyFrom: route,
        companyFrom: route === "COMPANY" ? companyFrom : null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  const deskzo = setup.deskzoFrom;
  const server = setup.companyServer;
  const sendAs = setup.companyFrom;

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Replies to customers</CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted">Your replies and the &quot;we&apos;ve received it&quot; email go out in your company&apos;s name. Choose which mail sends them.</p>
        <div role="radiogroup" aria-label="Send replies from" className="space-y-3">
          <label className="flex cursor-pointer items-start gap-2.5">
            <input type="radio" name="support-reply-from" className="mt-1" checked={route === "DESKZO"} disabled={pending} onChange={() => setRoute("DESKZO")} />
            <span>
              <span className="block text-text">Deskzo&apos;s mail</span>
              <span className="block text-xs text-muted">
                {deskzo ? (
                  <>
                    From <span className="text-text">{deskzo.from}</span>
                    {deskzo.replyTo ? (
                      <>
                        , with replies to <span className="text-text">{deskzo.replyTo}</span>
                      </>
                    ) : null}
                    . Nothing to set up.
                  </>
                ) : (
                  "From Deskzo's support address, with replies to your helpdesk address. Nothing to set up."
                )}
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2.5">
            <input type="radio" name="support-reply-from" className="mt-1" checked={route === "COMPANY"} disabled={pending} onChange={() => setRoute("COMPANY")} />
            <span>
              <span className="block text-text">Your mail server</span>
              <span className="block text-xs text-muted">
                {server ? (
                  <>
                    Through {server.label}
                    {server.fromEmail ? ` (${server.fromEmail})` : ""}, set up under{" "}
                    <Link href="/settings/messaging" className="text-brand hover:underline">
                      Settings › Mail &amp; messaging
                    </Link>
                    .
                  </>
                ) : (
                  <>
                    Not set up yet — add one (SMTP, Microsoft 365, Amazon SES…) for transactional mail under{" "}
                    <Link href="/settings/messaging" className="text-brand hover:underline">
                      Settings › Mail &amp; messaging
                    </Link>
                    . Until then replies go through Deskzo&apos;s mail.
                  </>
                )}
              </span>
            </span>
          </label>
        </div>

        {route === "COMPANY" && (
          <div className="max-w-md space-y-1.5 pl-6">
            <Label htmlFor="support-company-from">Send as</Label>
            <Input
              id="support-company-from"
              type="email"
              inputMode="email"
              autoComplete="off"
              placeholder="support@yourcompany.com"
              value={companyFrom}
              onChange={(e) => setCompanyFrom(e.target.value)}
              disabled={pending}
            />
            <p className="text-xs text-subtle">
              Your support address — the one you forward here. Your mail server must be allowed to send as it.
              {server?.fromEmail ? ` Leave it empty to send as ${server.fromEmail}.` : ""}
            </p>
            {sendAs && route === setup.replyFrom && companyFrom.trim().toLowerCase() === sendAs && (
              <p className="text-xs text-muted">
                {setup.companyForwards
                  ? `Customers' answers go to ${sendAs}: mail forwarded from it has arrived here, so they come back to the ticket.`
                  : `Until an email forwarded from ${sendAs} arrives here, customers' answers go to your helpdesk address, so none is lost.`}
              </p>
            )}
          </div>
        )}

        <p className="rounded-base bg-surface-sunken px-3 py-2 text-xs text-muted">
          If your mail server can&apos;t send a reply, it goes through Deskzo&apos;s mail instead and the ticket says why. Customers&apos; answers always come back to
          the same ticket.
        </p>
        <div aria-live="polite">
          {error && <ActionNotice tone="error">{error}</ActionNotice>}
          {!error && saved && <ActionNotice tone="success">Saved.</ActionNotice>}
        </div>
        <Button type="button" size="sm" onClick={save} disabled={!dirty || pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </CardContent>
    </Card>
  );
}
