"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, Download } from "lucide-react";
import { createCaptureKey, revokeCaptureKey } from "@/actions/lead-capture";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import {
  API_PATH,
  LEAD_FIELDS,
  RESPONSES,
  curlExample,
  nodeExample,
  phpExample,
  renderMarkdown,
} from "@/lib/lead-capture/spec";

type Key = {
  id: string;
  name: string;
  keyId: string;
  sourceLabel: string | null;
  active: boolean;
  lastUsedAt: Date | string | null;
  useCount: number;
  createdAt: Date | string;
  revokedAt: Date | string | null;
  leads: number;
  createdBy: string | null;
};

const when = (v: Date | string | null) =>
  v ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(v)) : "Never";

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      aria-label={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <Copy className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-line bg-surface-sunken p-3 font-mono text-xs leading-5 text-text">
      {children}
    </pre>
  );
}

export function LeadCaptureManager({ keys, baseUrl }: { keys: Key[]; baseUrl: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [issued, setIssued] = useState<{ keyId: string; secret: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState<Key | null>(null);
  const [example, setExample] = useState<"curl" | "php" | "node">("curl");

  function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createCaptureKey({ name, sourceLabel });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setIssued({ ...result.data, name });
      setName("");
      setSourceLabel("");
      router.refresh();
    });
  }

  function download() {
    const blob = new Blob([renderMarkdown(baseUrl)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "lead-capture-api.md";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="text-sm font-medium text-text">API keys</CardHeader>
        <CardContent className="space-y-4 text-sm">
          {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-danger">{error}</p>}

          {keys.length === 0 ? (
            <p className="text-muted">No keys yet. Create one for each website or form that should send leads.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="py-2 pr-4">Name</th>
                    <th className="py-2 pr-4">Key ID</th>
                    <th className="py-2 pr-4">Leads</th>
                    <th className="py-2 pr-4">Last used</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k.id} className="border-b border-line last:border-0">
                      <td className="py-2 pr-4">
                        <div className="font-medium text-text">{k.name}</div>
                        {k.sourceLabel && <div className="text-xs text-subtle">{k.sourceLabel}</div>}
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs text-muted">{k.keyId}</td>
                      <td className="py-2 pr-4 tabular-nums text-muted">{k.leads}</td>
                      <td className="py-2 pr-4 text-muted">{when(k.lastUsedAt)}</td>
                      <td className="py-2 pr-4">{k.revokedAt ? <Badge tone="red">Revoked</Badge> : <Badge tone="green">Active</Badge>}</td>
                      <td className="py-2 text-right">
                        {!k.revokedAt && (
                          <Button type="button" variant="ghost" size="sm" onClick={() => setRevoking(k)}>
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

          <form onSubmit={create} className="flex flex-wrap items-end gap-3 border-t border-line pt-4">
            <div className="min-w-56 flex-1 space-y-1.5">
              <Label htmlFor="lck-name">New key for</Label>
              <Input id="lck-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="acme.com contact form" autoComplete="off" />
            </div>
            <div className="min-w-56 flex-1 space-y-1.5">
              <Label htmlFor="lck-source">Source label (optional)</Label>
              <Input
                id="lck-source"
                value={sourceLabel}
                onChange={(e) => setSourceLabel(e.target.value)}
                placeholder="What leads from it should say they came from"
                autoComplete="off"
              />
            </div>
            <Button type="submit" disabled={pending || name.trim().length < 2}>
              {pending ? "Creating…" : "Create API key"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
          <span>Documentation for your website developers</span>
          <Button type="button" variant="secondary" size="sm" onClick={download}>
            <Download className="h-3.5 w-3.5" /> Download (.md)
          </Button>
        </CardHeader>
        <CardContent className="space-y-5 text-sm">
          <div className="space-y-1.5">
            <p className="font-medium text-text">Endpoint</p>
            <Code>{`POST ${baseUrl}${API_PATH}`}</Code>
            <p className="text-muted">
              HTTP Basic authentication — the <span className="font-medium text-text">key ID</span> is the username and the{" "}
              <span className="font-medium text-text">secret</span> is the password. <span className="font-medium text-danger">Call it from the website&apos;s server, never from browser JavaScript</span> — anything in a page&apos;s
              script can be read by every visitor. A <code className="font-mono text-xs">GET</code> to the same address with the same credentials checks a key without creating anything.
            </p>
          </div>

          <div className="space-y-1.5">
            <p className="font-medium text-text">Fields</p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-line text-left uppercase tracking-wide text-muted">
                  <tr>
                    <th className="py-1.5 pr-3">Field</th>
                    <th className="py-1.5 pr-3">Type</th>
                    <th className="py-1.5 pr-3">Required</th>
                    <th className="py-1.5">What it does</th>
                  </tr>
                </thead>
                <tbody>
                  {LEAD_FIELDS.map((f) => (
                    <tr key={f.name} className="border-b border-line align-top last:border-0">
                      <td className="py-1.5 pr-3 font-mono text-text">{f.name}</td>
                      <td className="py-1.5 pr-3 text-muted">{f.type}</td>
                      <td className="py-1.5 pr-3 text-muted">{f.required === true ? "Yes" : f.required === false ? "No" : f.required}</td>
                      <td className="py-1.5 text-muted">{f.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-1.5">
            <p className="font-medium text-text">Responses</p>
            <ul className="space-y-1 text-muted">
              {RESPONSES.map((r) => (
                <li key={r.status}>
                  <span className="font-mono text-xs text-text">{r.status}</span> — {r.meaning}
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <p className="font-medium text-text">Example</p>
              {(["curl", "php", "node"] as const).map((e) => (
                <Button key={e} type="button" size="sm" variant={example === e ? "primary" : "ghost"} onClick={() => setExample(e)}>
                  {e === "curl" ? "curl" : e === "php" ? "PHP" : "Node.js"}
                </Button>
              ))}
            </div>
            <Code>{example === "curl" ? curlExample(baseUrl) : example === "php" ? phpExample(baseUrl) : nodeExample(baseUrl)}</Code>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!issued} onClose={() => setIssued(null)} title="Copy these now">
        {issued && (
          <div className="space-y-3 text-sm">
            <p className="text-muted">
              The key for <span className="font-medium text-text">{issued.name}</span>. The secret is shown this once and cannot be
              shown again — if it is lost, revoke the key and create another.
            </p>
            <div className="space-y-1">
              <Label>Key ID (username)</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded-md border border-line bg-surface-sunken px-2 py-1.5 font-mono text-xs">{issued.keyId}</code>
                <CopyButton value={issued.keyId} label="key ID" />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Secret (password)</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded-md border border-line bg-surface-sunken px-2 py-1.5 font-mono text-xs">{issued.secret}</code>
                <CopyButton value={issued.secret} label="secret" />
              </div>
            </div>
            <div className="flex justify-end pt-1">
              <Button type="button" onClick={() => setIssued(null)}>
                I&apos;ve saved them
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog open={!!revoking} onClose={() => setRevoking(null)} title="Revoke this key?">
        {revoking && (
          <div className="space-y-3 text-sm">
            <p className="text-muted">
              <span className="font-medium text-text">{revoking.name}</span> will stop being able to send leads immediately. Leads it
              already sent stay. This cannot be undone — to resume, create a new key.
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setRevoking(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = await revokeCaptureKey(revoking.id);
                    if (!result.ok) setError(result.error);
                    setRevoking(null);
                    router.refresh();
                  })
                }
              >
                Revoke
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
