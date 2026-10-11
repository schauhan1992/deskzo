"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { connectGoogleSignatures, disconnectSignatures, setSignatureAutoSync, setZohoOrganisation } from "@/actions/signature";
import { useClock } from "@/components/time/clock-provider";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";

export type ConnectionView = {
  provider: "GOOGLE" | "ZOHO" | null;
  googleServiceEmail: string | null;
  zohoAdminEmail: string | null;
  zohoOrgId: string | null;
  autoSync: boolean;
  connectedAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  /** Whether the company's Zoho app (Settings → Security) is there to connect through. */
  zohoAppReady: boolean;
};

const OUTCOMES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Zoho Mail is connected. Signatures go out within a few minutes." },
  declined: { ok: false, text: "Zoho Mail wasn't connected — the approval was declined." },
  expired: { ok: false, text: "That took too long, or was started elsewhere. Try again." },
  "no-refresh": { ok: false, text: "Zoho didn't give a lasting grant. Try again; if it repeats, remove Deskzo's access in your Zoho account first." },
  "wrong-region": { ok: false, text: "That Zoho account is in another data centre than the one in Settings → Security." },
  "not-configured": { ok: false, text: "The Zoho app in Settings → Security isn't set up yet." },
  failed: { ok: false, text: "Zoho Mail couldn't be connected. Try again." },
};

/**
 * Where the signatures go: Google Workspace (a service account with domain-wide delegation) or Zoho
 * Mail (an administrator's grant) — one at a time. The steps are written out, because they happen in
 * the other company's admin console, not here.
 */
export function SignatureConnectionPanel({ view, outcome }: { view: ConnectionView; outcome: string | null }) {
  const router = useRouter();
  const clock = useClock();
  const [keyJson, setKeyJson] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [zoid, setZoid] = useState(view.zohoOrgId ?? "");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(outcome ? (OUTCOMES[outcome] ?? null) : null);
  const [pending, start] = useTransition();
  const run = (work: () => Promise<{ ok: boolean; error?: string }>, done: string) =>
    start(async () => {
      setMessage(null);
      const r = await work();
      setMessage(r.ok ? { ok: true, text: done } : { ok: false, text: r.error ?? "That didn't work." });
      if (r.ok) router.refresh();
    });

  return (
    <div className="space-y-5">
      {message && <p className={message.ok ? "text-sm text-success" : "text-sm text-danger"}>{message.text}</p>}

      <Card className="space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-text">Connected suite</h2>
          {view.provider === "GOOGLE" ? <Badge tone="green">Google Workspace</Badge> : view.provider === "ZOHO" ? <Badge tone="green">Zoho Mail</Badge> : <Badge>None yet</Badge>}
        </div>
        {view.provider && (
          <>
            <p className="text-sm text-muted">
              {view.provider === "GOOGLE" ? `Through the service account ${view.googleServiceEmail}` : `Approved by ${view.zohoAdminEmail ?? "a Zoho Mail administrator"}`}
              {view.connectedAt ? `, since ${clock.dateTimeShort(view.connectedAt)}` : ""}.
            </p>
            {view.lastError ? (
              <p className="rounded-base border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger">The last run stopped: {view.lastError}</p>
            ) : view.lastRunAt ? (
              <p className="text-xs text-subtle">Last run {clock.dateTimeShort(view.lastRunAt)}.</p>
            ) : null}
            {view.provider === "ZOHO" && !view.zohoOrgId && (
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="zoho-zoid">Organisation ID</Label>
                  <Input id="zoho-zoid" inputMode="numeric" value={zoid} onChange={(e) => setZoid(e.target.value)} placeholder="Zoho Mail Admin Console → Organization" />
                </div>
                <Button type="button" variant="secondary" disabled={pending} onClick={() => run(() => setZohoOrganisation(zoid), "Saved.")}>
                  Save
                </Button>
              </div>
            )}
            <label className="flex items-center gap-2 text-sm text-text">
              <input type="checkbox" checked={view.autoSync} disabled={pending} onChange={(e) => run(() => setSignatureAutoSync(e.target.checked), e.target.checked ? "Signatures are kept in step on their own." : "Signatures go out only when you press Sync.")} />
              Keep everybody&apos;s signature in step on its own — a changed title or phone goes out within minutes
            </label>
            <div>
              <Button type="button" variant="ghost" className="text-danger hover:bg-danger-bg hover:text-danger" disabled={pending} onClick={() => run(disconnectSignatures, "Disconnected. Signatures already in mailboxes stay there.")}>
                Disconnect
              </Button>
            </div>
          </>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card className="space-y-3 p-5">
          <h2 className="text-sm font-semibold text-text">Google Workspace</h2>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
            <li>In Google Cloud, in a project of your company&apos;s, turn on the Gmail API and make a service account. Make a JSON key for it.</li>
            <li>
              In the Google Admin console, open Security → Access and data control → API controls → Domain-wide delegation. Add the service account&apos;s client ID with
              the scope <code className="rounded bg-surface-sunken px-1 text-xs">https://www.googleapis.com/auth/gmail.settings.basic</code>.
            </li>
            <li>Paste the key here, with a Google Workspace administrator&apos;s address to try it on.</li>
          </ol>
          <div className="space-y-1.5">
            <Label htmlFor="google-key">Service account key (JSON)</Label>
            <Textarea id="google-key" rows={4} value={keyJson} onChange={(e) => setKeyJson(e.target.value)} placeholder='{"type": "service_account", …}' spellCheck={false} />
            <p className="text-xs text-subtle">Kept encrypted, never shown again.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="google-admin">Try it as</Label>
            <Input id="google-admin" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="admin@yourcompany.com" />
          </div>
          <Button
            type="button"
            disabled={pending || !keyJson.trim() || !adminEmail.trim()}
            onClick={() =>
              run(async () => {
                const r = await connectGoogleSignatures({ keyJson, adminEmail });
                if (r.ok) setKeyJson("");
                return r;
              }, "Google Workspace is connected. Signatures go out within a few minutes.")
            }
          >
            {pending ? "Trying it…" : view.provider === "GOOGLE" ? "Replace the key" : "Connect Google Workspace"}
          </Button>
        </Card>

        <Card className="space-y-3 p-5">
          <h2 className="text-sm font-semibold text-text">Zoho Mail</h2>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
            <li>Signatures use your Zoho app from Settings → Security — the one people connect their Zoho Mail through.</li>
            <li>A Zoho Mail administrator presses Connect and approves managing the organisation&apos;s accounts.</li>
            <li>Each person gets a signature called “Company signature (Deskzo)” in Zoho Mail, updated in place from then on.</li>
          </ol>
          {view.zohoAppReady ? (
            <a
              href={`/api/mail/zoho/connect?purpose=signatures&next=${encodeURIComponent("/signatures/manage?tab=connection")}`}
              className="inline-flex h-9 items-center rounded-base bg-brand px-3.5 text-sm font-medium text-brand-contrast shadow-sm hover:brightness-110"
            >
              {view.provider === "ZOHO" ? "Connect Zoho Mail again" : "Connect Zoho Mail"}
            </a>
          ) : (
            <p className="text-sm text-warning">Set up the Zoho app in Settings → Security first.</p>
          )}
        </Card>
      </div>
      <p className="text-xs text-subtle">Microsoft 365 is coming: Microsoft has no way to set signatures from outside, so it will be an Outlook add-in. Until then, Outlook users copy theirs from My email signature.</p>
    </div>
  );
}
