"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { deleteAutomationConnection, revealAutomationSigningSecret, saveAutomationConnection, testAutomationConnection } from "@/actions/automate";

export type ConnectionItem = {
  id: string;
  provider: string;
  name: string;
  host: string | null;
  shared: boolean;
  ownerName: string;
  mine: boolean;
  lastUsed: string | null;
  lastError: string | null;
};

const KINDS: Record<string, { label: string; address: string; hint: string }> = {
  slack: { label: "Slack", address: "Incoming webhook address", hint: "In Slack: Apps › Incoming Webhooks › Add to a channel. It starts https://hooks.slack.com/." },
  teams: { label: "Microsoft Teams", address: "Workflow webhook address", hint: "In the Teams channel: Workflows › “Post to a channel when a webhook request is received”, then copy its address." },
  http: { label: "An outside API", address: "Base address", hint: "Its address up to the version — https://api.example.com/v1. A workflow adds the rest." },
};

type Header = { name: string; value: string };
type Editing = { id: string | null; provider: string; name: string; shared: boolean; url: string; headers: Header[] };

const blank = (provider = "slack"): Editing => ({ id: null, provider, name: "", shared: false, url: "", headers: [{ name: "", value: "" }] });

/**
 * Automate › Connections, the interactive part: the list with Edit, Send a test and Remove; the form
 * for a new one or a change; the signing secret on request; and the Google Sheets and WhatsApp status.
 */
export function ConnectionsManager({
  connections,
  sheets,
  whatsappReady,
}: {
  connections: ConnectionItem[];
  sheets: { provider: string | null; connected: boolean; available: boolean };
  whatsappReady: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [secretError, setSecretError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () => {
    if (!editing) return;
    const url = editing.url.trim();
    // A change with no new address keeps the saved one (and its headers) as they are.
    const secretGiven = url !== "" || editing.id === null;
    const headers = Object.fromEntries(editing.headers.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value]));
    const payload = {
      id: editing.id ?? undefined,
      provider: editing.provider,
      name: editing.name,
      shared: editing.shared,
      ...(secretGiven ? { secret: editing.provider === "http" ? { url, headers } : { url } } : {}),
    };
    start(async () => {
      setFormError(null);
      const result = await saveAutomationConnection(payload);
      if (!result.ok) return setFormError(result.error);
      setEditing(null);
      router.refresh();
    });
  };

  const test = (id: string) =>
    start(async () => {
      setNotice(null);
      const result = await testAutomationConnection(id);
      setNotice(result.ok ? { id, ok: true, text: "Sent — look for it in the channel." } : { id, ok: false, text: result.error });
      router.refresh();
    });

  const remove = (c: ConnectionItem) => {
    if (!window.confirm(`Remove “${c.name}”? Workflows that use it will stop at that step until they're given another.`)) return;
    start(async () => {
      const result = await deleteAutomationConnection(c.id);
      if (!result.ok) setNotice({ id: c.id, ok: false, text: result.error });
      router.refresh();
    });
  };

  const reveal = () =>
    start(async () => {
      setSecretError(null);
      const result = await revealAutomationSigningSecret();
      if (result.ok) setSecret(result.data.secret);
      else setSecretError(result.error);
    });

  const kind = editing ? KINDS[editing.provider] : null;

  return (
    <div className="space-y-5">
      <Card className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-text">Apps and APIs</h2>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setFormError(null);
              setEditing(blank());
            }}
          >
            Add a connection
          </Button>
        </div>
        {connections.length === 0 ? (
          <p className="p-4 text-sm text-muted">None yet. Add a Slack or Teams channel to post to, or an outside API a workflow calls with its key.</p>
        ) : (
          <ul className="divide-y divide-line">
            {connections.map((c) => (
              <li key={c.id} className="space-y-1 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-text">{c.name}</span>
                      <Badge>{KINDS[c.provider]?.label ?? c.provider}</Badge>
                      {c.shared && <Badge tone="blue">Shared</Badge>}
                      {c.lastError && <Badge tone="red">Last call failed</Badge>}
                    </div>
                    <p className="mt-0.5 text-xs text-muted">
                      {c.host ?? "No address"} · {c.mine ? "Yours" : c.ownerName} · {c.lastUsed ? `Last used ${c.lastUsed}` : "Not used yet"}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {(c.provider === "slack" || c.provider === "teams") && (c.mine || c.shared) && (
                      <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => test(c.id)}>
                        Send a test
                      </Button>
                    )}
                    {c.mine && (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={pending}
                          onClick={() => {
                            setFormError(null);
                            setEditing({ ...blank(c.provider), id: c.id, name: c.name, shared: c.shared });
                          }}
                        >
                          Edit
                        </Button>
                        <button type="button" disabled={pending} className="px-2 text-xs font-medium text-danger hover:underline disabled:opacity-50" onClick={() => remove(c)}>
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {c.lastError && <p className="text-xs text-danger">{c.lastError}</p>}
                {notice?.id === c.id && <p className={notice.ok ? "text-xs text-success" : "text-xs text-danger"}>{notice.text}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="space-y-2 p-4">
          <h2 className="text-sm font-semibold text-text">Google Sheets</h2>
          {sheets.connected ? (
            <p className="text-sm text-muted">Your Google account may add rows. Workflows you own can append to any sheet you can edit.</p>
          ) : !sheets.available ? (
            <p className="text-sm text-muted">Google isn&rsquo;t set up for mailboxes in this workspace (Settings › Security), so Sheets can&rsquo;t be used yet.</p>
          ) : (
            <>
              <p className="text-sm text-muted">
                Rows are added as the workflow&rsquo;s owner, through their Google mailbox.
                {sheets.provider && sheets.provider !== "GOOGLE" ? " Your mailbox is connected through another provider now — connecting Google makes Google your mailbox." : ""}
              </p>
              <a href="/api/mail/google/connect?purpose=sheets&next=/automate/connections" className="inline-flex h-8 items-center rounded-base border border-line-strong bg-surface px-3 text-[13px] font-medium text-text shadow-sm hover:bg-surface-sunken">
                {sheets.provider === "GOOGLE" ? "Allow Google Sheets" : "Connect Google with Sheets"}
              </a>
            </>
          )}
        </Card>
        <Card className="space-y-2 p-4">
          <h2 className="text-sm font-semibold text-text">WhatsApp</h2>
          <p className="text-sm text-muted">
            {whatsappReady
              ? "Workflows send approved WhatsApp templates through the provider set up in Settings › Mail & messaging, and every message is logged with Marketing's."
              : "Workflows send WhatsApp through the provider in Settings › Mail & messaging. None is switched on for transactional messages yet."}
          </p>
          <Link href="/settings/messaging" className="text-xs font-medium text-brand hover:underline">
            Settings › Mail &amp; messaging
          </Link>
        </Card>
      </div>

      <Card className="space-y-2 p-4">
        <h2 className="text-sm font-semibold text-text">Signing secret</h2>
        <p className="text-sm text-muted">
          Every call a workflow makes to an outside API carries X-Deskzo-Timestamp and X-Deskzo-Signature — the hex HMAC-SHA256 of &ldquo;timestamp.body&rdquo; with this secret — so
          the app can check it came from this workspace. Each call also carries an Idempotency-Key that stays the same when it is retried.
        </p>
        {secret ? (
          <Input readOnly value={secret} onFocus={(e) => e.currentTarget.select()} className="max-w-xl font-mono text-xs" />
        ) : (
          <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={reveal}>
            Show the secret
          </Button>
        )}
        {secretError && <p className="text-xs text-danger">{secretError}</p>}
      </Card>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing?.id ? "Change a connection" : "Add a connection"}>
        {editing && kind && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            {editing.id === null && (
              <div className="space-y-1">
                <Label htmlFor="conn-kind">Kind</Label>
                <Select id="conn-kind" value={editing.provider} onChange={(e) => setEditing({ ...editing, provider: e.target.value })}>
                  {Object.entries(KINDS).map(([key, k]) => (
                    <option key={key} value={key}>
                      {k.label}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="conn-name">Name</Label>
              <Input id="conn-name" value={editing.name} maxLength={80} placeholder={editing.provider === "http" ? "Our ERP" : "#sales-wins"} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="conn-url">{kind.address}</Label>
              <Input
                id="conn-url"
                type="url"
                value={editing.url}
                autoComplete="off"
                placeholder={editing.id ? "Leave empty to keep the saved one" : "https://"}
                onChange={(e) => setEditing({ ...editing, url: e.target.value })}
              />
              <p className="text-xs text-subtle">{kind.hint}</p>
            </div>
            {editing.provider === "http" && (
              <div className="space-y-1">
                <Label>Headers it needs</Label>
                {editing.headers.map((h, i) => (
                  <div key={i} className="flex gap-1">
                    <Input
                      aria-label="Header name"
                      placeholder="Authorization"
                      value={h.name}
                      onChange={(e) => setEditing({ ...editing, headers: editing.headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                    />
                    <Input
                      aria-label="Header value"
                      placeholder="Bearer …"
                      autoComplete="off"
                      value={h.value}
                      onChange={(e) => setEditing({ ...editing, headers: editing.headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
                    />
                  </div>
                ))}
                <button type="button" className="text-xs font-medium text-brand hover:underline" onClick={() => setEditing({ ...editing, headers: [...editing.headers, { name: "", value: "" }] })}>
                  Add a header
                </button>
                {editing.id && <p className="text-xs text-subtle">A new address replaces the saved address and headers together — give both.</p>}
              </div>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={editing.shared} onChange={(e) => setEditing({ ...editing, shared: e.target.checked })} />
              Share with the workspace — anybody&rsquo;s workflows may use it
            </label>
            {formError && <p className="text-xs text-danger">{formError}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={pending}>
                {editing.id ? "Save" : "Add"}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </div>
  );
}
