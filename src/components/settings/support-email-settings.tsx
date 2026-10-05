"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronRight, Copy, Inbox } from "lucide-react";
import type { SupportMailSetup } from "@/actions/support-mail";
import { saveSupportMailSettings } from "@/actions/support-mail";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Label, Select } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { useClock } from "@/components/time/clock-provider";

/**
 * Settings → Support email: the workspace's helpdesk address, how to forward the company's own support
 * mail to it from the mail service it uses, and the two choices about new tickets.
 *
 * Nothing on the company's domain changes. Its support@ keeps working as it does; a forwarding rule in
 * that mailbox sends a copy here, where each email becomes a ticket (src/lib/support-mail/receive.ts).
 */
export function SupportEmailSettings({ setup }: { setup: SupportMailSetup }) {
  const router = useRouter();
  const clock = useClock();
  const [acknowledge, setAcknowledge] = useState(setup.acknowledge);
  const [assignee, setAssignee] = useState(setup.defaultAssigneeUserId ?? "");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const dirty = acknowledge !== setup.acknowledge || assignee !== (setup.defaultAssigneeUserId ?? "");

  async function copy() {
    if (!setup.address) return;
    try {
      await navigator.clipboard.writeText(setup.address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // The address is on screen and selectable; nothing more to do.
    }
  }

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveSupportMailSettings({ acknowledge, defaultAssigneeUserId: assignee || null });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="text-sm font-medium text-text">Your helpdesk address</CardHeader>
        <CardContent className="space-y-3">
          {setup.address ? (
            <>
              <div className="flex flex-wrap items-center gap-3 rounded-base border border-line bg-surface-sunken px-3 py-2.5">
                <Inbox className="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
                <span translate="no" className="min-w-0 flex-1 select-all break-all font-mono text-sm text-text">
                  {setup.address}
                </span>
                <Button type="button" variant="secondary" size="sm" onClick={copy}>
                  {copied ? <Check className="h-4 w-4 text-success" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
                  {copied ? "Copied" : "Copy address"}
                </Button>
              </div>
              <p className="text-sm text-muted">
                Forward your support mail here and every email becomes a ticket. Your own address keeps working exactly as
                it does now, and nothing changes on your domain.
              </p>
              <p className="text-xs text-subtle">
                {setup.lastReceivedAt ? `Last email received ${clock.dateTime(setup.lastReceivedAt)}.` : "No email has arrived yet."}
              </p>
            </>
          ) : (
            <ActionNotice tone="info">
              Support email isn&apos;t switched on for this platform yet. Once it is, your helpdesk address appears here.
            </ActionNotice>
          )}
        </CardContent>
      </Card>

      {setup.gmailConfirmation && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Gmail asked to confirm forwarding</CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted">
              Received {clock.dateTime(setup.gmailConfirmation.receivedAt)}. Open the confirmation link below (it starts
              with https://mail-settings.google.com), or type the confirmation code into Gmail&apos;s forwarding settings.
            </p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-base border border-line bg-surface-sunken p-3 text-xs text-text">
              {setup.gmailConfirmation.body}
            </pre>
          </CardContent>
        </Card>
      )}

      {setup.address && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">How to forward your support mail</CardHeader>
          <CardContent className="space-y-1">
            <Steps title="Gmail or Google Workspace">
              <li>In Gmail, open Settings (the gear) → See all settings → Forwarding and POP/IMAP.</li>
              <li>Choose Add a forwarding address and enter your helpdesk address.</li>
              <li>Gmail sends a confirmation email to it. It appears on this page within a minute — open its link.</li>
              <li>Back in Gmail, choose Forward a copy of incoming mail to your helpdesk address, and save.</li>
              <li>
                A Google Workspace admin can instead add a routing rule in the Admin console (Apps → Google Workspace →
                Gmail → Routing) that also delivers to your helpdesk address.
              </li>
            </Steps>
            <Steps title="Microsoft 365 or Outlook">
              <li>In Outlook on the web, open Settings → Mail → Forwarding.</li>
              <li>Turn on forwarding, enter your helpdesk address, and tick Keep a copy of forwarded messages.</li>
              <li>
                For a shared mailbox, a Microsoft 365 admin sets this in the admin centre: Teams &amp; groups → Shared
                mailboxes → the mailbox → Email forwarding.
              </li>
              <li>
                If forwarding is refused, your admin has blocked forwarding to outside addresses; they can allow it for
                this mailbox in the Microsoft 365 Defender outbound spam policy.
              </li>
            </Steps>
            <Steps title="Zoho Mail">
              <li>In Zoho Mail, open Settings → Mail Forwarding and POP/IMAP.</li>
              <li>Add your helpdesk address, then confirm it with the code Zoho sends — it arrives in your Support inbox.</li>
              <li>Turn forwarding on, keeping a copy in your mailbox.</li>
            </Steps>
            <Steps title="Any other mail service">
              <li>Look for Forwarding, Redirect or Filters in its settings.</li>
              <li>Forward all mail arriving at your support address to your helpdesk address, keeping a copy.</li>
              <li>Send yourself a test email: it should appear as a ticket, or in the Support inbox if you aren&apos;t a contact yet.</li>
            </Steps>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="text-sm font-medium text-text">New tickets by email</CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-start gap-2.5">
            <input type="checkbox" checked={acknowledge} onChange={(e) => setAcknowledge(e.target.checked)} className="mt-0.5 h-4 w-4" />
            <span className="text-sm text-text">
              Reply to say we&apos;ve received it
              <span className="block text-xs text-subtle">
                The customer gets the ticket number, and can add to it by replying. Never sent to automatic replies.
              </span>
            </span>
          </label>
          <div className="max-w-sm space-y-1.5">
            <Label htmlFor="support-email-assignee">Give new tickets to</Label>
            <Select id="support-email-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Nobody — the support team is told</option>
              {setup.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
            <p className="text-xs text-subtle">
              Only people in a support team are listed. An email from somebody who isn&apos;t a contact yet waits in the
              Support inbox instead.
            </p>
          </div>
          <div aria-live="polite">
            {error && <ActionNotice tone="error">{error}</ActionNotice>}
            {!error && saved && <ActionNotice tone="success">Saved.</ActionNotice>}
          </div>
          <Button type="button" size="sm" onClick={save} disabled={!dirty || pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function Steps({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group rounded-base border border-line px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-text marker:hidden">
        <ChevronRight className="h-4 w-4 shrink-0 text-subtle transition-transform group-open:rotate-90" aria-hidden="true" />
        {title}
      </summary>
      <ol className="mt-2 list-decimal space-y-1 pl-9 text-sm text-muted">{children}</ol>
    </details>
  );
}
