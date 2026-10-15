"use client";

import { useState } from "react";
import { consoleSaveHelpdeskFrom } from "@/actions/platform/console-mail";
import { Panel } from "@/components/console/kit/panel";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { Button } from "@/components/ui/button";

/**
 * Settings › Mail: whether workspaces' helpdesk replies through Deskzo's mail go out from each
 * workspace's own helpdesk address (owner, 15 Oct 2026 — src/lib/platform/helpdesk-from.ts). Turned on
 * once the Support account may send for the helpdesk domain; off, they go from the account's address.
 */
export function HelpdeskFromPanel({ on, domain, canEdit }: { on: boolean; domain: string | null; canEdit: boolean }) {
  const [value, setValue] = useState(on);
  const save = useConsoleAction<boolean>();
  const example = domain ? `wroffy@${domain}` : "<workspace>@<helpdesk domain>";

  return (
    <Panel
      title="Helpdesk replies"
      description={`Replies a workspace's helpdesk sends through Deskzo's Support mail. Off, they go from the Support account's own address with replies to the workspace's helpdesk address. On, they go from that helpdesk address itself (${example}) — what customers wrote to, as Zendesk and Freshdesk do. Turn it on only once the Support account may send for ${domain ?? "the helpdesk domain"}: its DKIM records, and its SPF entry beside Cloudflare's. A reply it still refuses goes from the account's own address.`}
    >
      {domain ? (
        <div className="space-y-3">
          <label className="flex items-start gap-2.5 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={value} onChange={(e) => setValue(e.target.checked)} disabled={!canEdit || save.pending} />
            <span className="text-text">Send helpdesk replies from each workspace&apos;s own helpdesk address</span>
          </label>
          {canEdit && (
            <Button type="button" size="sm" disabled={save.pending || value === on} onClick={() => save.run(() => consoleSaveHelpdeskFrom(value), { success: "Saved." })}>
              {save.pending ? "Saving…" : "Save"}
            </Button>
          )}
          {save.error && <p className="text-sm text-danger">{save.error}</p>}
        </div>
      ) : (
        <p className="text-sm text-muted">Tickets by email isn&apos;t set up on this platform (INBOUND_MAIL_DOMAIN), so there is no helpdesk address to send from.</p>
      )}
    </Panel>
  );
}
