"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Download, KeyRound } from "lucide-react";
import { makeApiKey, revokeApiKey, type ApiKeyRow } from "@/actions/api-keys";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { OutboundLink } from "@/components/ui/outbound-link";
import { useClock } from "@/components/time/clock-provider";
import { API_RATE_PER_MINUTE, API_SCOPES } from "@/lib/api/scopes";

/**
 * Settings › Developers & API (owner, 17 Oct 2026): the keys for the public API (src/lib/api) — made
 * here, acting as whoever made them, each with the scopes it may touch — and where its documentation
 * is. A new key's token is shown once, here, and never again.
 */

const AREAS = [...new Set(API_SCOPES.map((s) => s.area))];
const EXPIRIES = [
  { value: "", label: "Never — until revoked" },
  { value: "30", label: "In 30 days" },
  { value: "90", label: "In 90 days" },
  { value: "180", label: "In 6 months" },
  { value: "365", label: "In a year" },
];

export function ApiKeysManager({ keys, everyone, origin, docsUrl }: { keys: ApiKeyRow[]; everyone: boolean; origin: string; docsUrl: string }) {
  const router = useRouter();
  const clock = useClock();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [expires, setExpires] = useState("");
  const [made, setMade] = useState<{ token: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const base = `${origin}/api/v1`;

  const toggle = (key: string, on: boolean) => setScopes((s) => (on ? [...new Set([...s, key])] : s.filter((k) => k !== key)));

  function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await makeApiKey({ name, scopes, expiresInDays: expires ? Number(expires) : null });
      if (!r.ok) return setError(r.error);
      setMade({ token: r.data.token, name });
      setCopied(false);
      setName("");
      setScopes([]);
      setExpires("");
      router.refresh();
    });
  }

  function revoke(k: ApiKeyRow) {
    if (!window.confirm(`Revoke “${k.name}”? Anything using it stops working at once.`)) return;
    start(async () => {
      const r = await revokeApiKey(k.id);
      if (!r.ok) setError(r.error);
      router.refresh();
    });
  }

  const status = (k: ApiKeyRow) =>
    k.revokedAt ? <Badge tone="red">Revoked</Badge> : k.expiresAt && new Date(k.expiresAt) <= new Date() ? <Badge tone="amber">Expired</Badge> : <Badge tone="green">Live</Badge>;

  return (
    <div className="space-y-6">
      {made && (
        <Card className="border-success/40">
          <CardContent className="space-y-3 pt-5 text-sm">
            <p className="font-medium text-text">“{made.name}” is ready. Copy its key now — this is the only time it is shown.</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-base border border-line bg-surface-sunken px-3 py-2 font-mono text-xs text-text">{made.token}</code>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(made.token).then(() => setCopied(true));
                }}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="text-xs text-muted">Send it as <code className="font-mono">Authorization: Bearer &lt;key&gt;</code>. Keep it on a server — anyone holding it acts as you, within its scopes.</p>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMade(null)}>
              I&apos;ve saved it
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="text-sm font-medium text-text">{everyone ? "API keys in this workspace" : "Your API keys"}</CardHeader>
        <CardContent className="space-y-4 text-sm">
          {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-danger">{error}</p>}
          {keys.length === 0 ? (
            <p className="text-muted">No keys yet. Make one for each system that connects — Zapier, Make, your ERP — so each can be revoked on its own.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-sm">
                <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="py-2 pr-4">Name</th>
                    {everyone && <th className="py-2 pr-4">Acts as</th>}
                    <th className="py-2 pr-4">Scopes</th>
                    <th className="py-2 pr-4">Last used</th>
                    <th className="py-2 pr-4">Expires</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k.id} className="border-b border-line align-top last:border-0">
                      <td className="py-2 pr-4">
                        <div className="font-medium text-text">{k.name}</div>
                        <div className="font-mono text-xs text-subtle">{k.keyId}</div>
                      </td>
                      {everyone && <td className="py-2 pr-4 text-muted">{k.mine ? "You" : k.owner.name}</td>}
                      <td className="py-2 pr-4">
                        <div className="flex max-w-xs flex-wrap gap-1">
                          {k.scopes.map((s) => (
                            <span key={s} className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-muted">
                              {s}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="py-2 pr-4 text-muted">{k.lastUsedAt ? `${clock.dateTimeShort(new Date(k.lastUsedAt))}${k.lastUsedIp ? ` · ${k.lastUsedIp}` : ""}` : "Never"}</td>
                      <td className="py-2 pr-4 text-muted">{k.expiresAt ? clock.date(new Date(k.expiresAt)) : "—"}</td>
                      <td className="py-2 pr-4">{status(k)}</td>
                      <td className="py-2 text-right">
                        {!k.revokedAt && (
                          <Button type="button" variant="ghost" size="sm" onClick={() => revoke(k)} disabled={pending}>
                            Revoke
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <form onSubmit={create} className="space-y-4 border-t border-line pt-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="api-key-name">New key for</Label>
                <Input id="api-key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Zapier" maxLength={80} autoComplete="off" disabled={pending} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="api-key-expires">Expires</Label>
                <Select id="api-key-expires" value={expires} onChange={(e) => setExpires(e.target.value)} disabled={pending}>
                  {EXPIRIES.map((x) => (
                    <option key={x.value} value={x.value}>
                      {x.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <fieldset>
              <legend className="text-xs font-medium text-muted">What it may touch — your own permissions still decide what it sees and changes there</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {AREAS.map((area) => (
                  <div key={area} className="rounded-base border border-line px-3 py-2">
                    <p className="text-xs font-semibold text-text">{area}</p>
                    {API_SCOPES.filter((s) => s.area === area).map((s) => (
                      <label key={s.key} className="mt-1 flex items-start gap-2 text-sm text-muted">
                        <input type="checkbox" className="mt-1" checked={scopes.includes(s.key)} onChange={(e) => toggle(s.key, e.target.checked)} disabled={pending} />
                        <span>{s.label}</span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            </fieldset>
            <Button type="submit" disabled={pending || name.trim().length < 2 || scopes.length === 0}>
              <KeyRound className="h-4 w-4" /> {pending ? "Making…" : "Make key"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Documentation</CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted">
            The API answers at <code className="font-mono text-text">{base}</code>. A key acts as the person who made it — it can never see or do more than they can — and only within its scopes. {API_RATE_PER_MINUTE} calls a
            minute per key.
          </p>
          <pre className="overflow-x-auto rounded-base border border-line bg-surface-sunken p-3 font-mono text-xs text-text">{`curl ${base}/me \\\n  -H "Authorization: Bearer $DESKZO_API_KEY"`}</pre>
          <div className="flex flex-wrap gap-2">
            <OutboundLink href={docsUrl} className="inline-flex h-8 items-center rounded-base border border-line px-3 text-sm font-medium text-text hover:bg-surface-sunken">
              Developer documentation
            </OutboundLink>
            <a href="/api/v1/openapi.json" download className="inline-flex h-8 items-center gap-1.5 rounded-base border border-line px-3 text-sm font-medium text-text hover:bg-surface-sunken">
              <Download className="h-3.5 w-3.5" /> OpenAPI
            </a>
            <a href="/api/v1/postman.json" download className="inline-flex h-8 items-center gap-1.5 rounded-base border border-line px-3 text-sm font-medium text-text hover:bg-surface-sunken">
              <Download className="h-3.5 w-3.5" /> Postman collection
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
