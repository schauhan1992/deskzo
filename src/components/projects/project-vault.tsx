"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import {
  deleteCredential,
  revealCredential,
  saveCredential,
  type CredentialSummary,
} from "@/actions/project-credential";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { IconButton } from "@/components/ui/icon-button";
import { useClock } from "@/components/time/clock-provider";
import { formatCalendarDay } from "@/lib/time/zone";

/**
 * The customer's passwords and keys.
 *
 * The secret is never on this page. It is not in a hidden field, not in a data attribute, not in a
 * disabled input — it is not in the response at all. Revealing it is a round trip that costs the
 * viewer their own password, and what comes back is held in component state until they navigate
 * away or close the box.
 *
 * Nothing here is copied to the clipboard automatically. A clipboard is readable by every other
 * page the person has open, and a convenience that quietly broadcasts a customer's admin password
 * is not a convenience.
 */
export function ProjectVault({
  projectId,
  credentials,
  canManage,
}: {
  projectId: string;
  credentials: CredentialSummary[];
  canManage: boolean;
}) {
  const router = useRouter();
  const clock = useClock();
  const [editing, setEditing] = useState<CredentialSummary | "new" | null>(null);
  const [revealing, setRevealing] = useState<CredentialSummary | null>(null);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
        <span className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted" />
          Credentials
        </span>
        {canManage && (
          <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Store one
          </Button>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        <p className="text-xs text-subtle">
          Encrypted at rest. Opening one needs your own password, is recorded against the credential, and tells
          the project manager. Anyone with access to the server can still decrypt these — for a bank or registrar
          login, use a proper vault.
        </p>

        {credentials.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted">Nothing stored for this project.</p>
        ) : (
          credentials.map((c) => (
            <div key={c.id} className="rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-text">{c.label}</div>
                  <div className="mt-0.5 space-y-0.5 text-xs text-muted">
                    {c.username && <div>{c.username}</div>}
                    {/* Shown, never linked: a stored URL is attacker-controlled text as far as this
                        page is concerned, and one click is all a phishing target needs. */}
                    {c.url && <div className="break-all">{c.url}</div>}
                    <div className="flex items-center gap-2 text-subtle">
                      <span>Password ••••••••</span>
                      {c.rotatedAt && <span>· changed {clock.date(c.rotatedAt)}</span>}
                      {/* The day typed, held as midnight UTC. */}
                      {c.expiresAt && <span>· expires {formatCalendarDay(c.expiresAt)}</span>}
                    </div>
                  </div>
                  {c.note && <p className="mt-1 text-xs text-muted">{c.note}</p>}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <Button size="sm" variant="secondary" onClick={() => setRevealing(c)}>
                    <Eye className="mr-1.5 h-3.5 w-3.5" />
                    Reveal
                  </Button>
                  {canManage && (
                    <>
                      <IconButton icon={Pencil} label="Edit" onClick={() => setEditing(c)} />
                      <IconButton
                        icon={Trash2}
                        label="Delete"
                        tone="danger"
                        onClick={async () => {
                          if (!confirm(`Delete "${c.label}"? The stored secret is gone for good.`)) return;
                          await deleteCredential(c.id);
                          router.refresh();
                        }}
                      />
                    </>
                  )}
                </div>
              </div>

              {c.reveals.length > 0 && (
                <p className="mt-2 border-t border-line pt-2 text-xs text-subtle">
                  Opened by {c.reveals.map((r) => `${r.userName} (${clock.date(r.at)})`).join(", ")}
                </p>
              )}
            </div>
          ))
        )}
      </CardContent>

      {revealing && <RevealDialog credential={revealing} onClose={() => setRevealing(null)} />}
      {editing && (
        <CredentialDialog
          projectId={projectId}
          credential={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </Card>
  );
}

function RevealDialog({ credential, onClose }: { credential: CredentialSummary; onClose: () => void }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await revealCredential(credential.id, password);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSecret(result.data.secret);
      // Clear it from state the moment it has been used — a form still holding the password when
      // the box closes is one more copy of it lying around.
      setPassword("");
      router.refresh();
    });
  }

  return (
    <Dialog open onClose={onClose} title={credential.label}>
      {secret === null ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Confirm it&apos;s you. This is recorded against the credential and the project manager is told.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="confirm-password">Your password</Label>
            <Input
              id="confirm-password"
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending || !password}>
              {pending ? "Checking…" : "Reveal"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {credential.username && (
            <div className="space-y-1">
              <Label>Username</Label>
              <p className="break-all rounded-base bg-surface-sunken px-3 py-2 font-mono text-sm text-text">
                {credential.username}
              </p>
            </div>
          )}
          <div className="space-y-1">
            <Label>Password</Label>
            <p className="break-all rounded-base bg-surface-sunken px-3 py-2 font-mono text-sm text-text">{secret}</p>
          </div>
          <p className="text-xs text-subtle">
            Close this when you&apos;re done. It isn&apos;t kept — opening it again costs another password.
          </p>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function CredentialDialog({
  projectId,
  credential,
  onClose,
  onSaved,
}: {
  projectId: string;
  credential: CredentialSummary | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(credential?.label ?? "");
  const [username, setUsername] = useState(credential?.username ?? "");
  const [url, setUrl] = useState(credential?.url ?? "");
  const [secret, setSecret] = useState("");
  const [note, setNote] = useState(credential?.note ?? "");
  // Held as midnight UTC of the day typed, so its UTC day is that day, in any zone. (`toString()` here
  // gave "Mon Oct 05", which a date field can't show.)
  const [expiresAt, setExpiresAt] = useState(credential?.expiresAt ? new Date(credential.expiresAt).toISOString().slice(0, 10) : "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await saveCredential({
        id: credential?.id,
        projectId,
        label,
        username,
        url,
        note,
        expiresAt,
        secret: secret || undefined,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onSaved();
    });
  }

  return (
    <Dialog open onClose={onClose} title={credential ? `Edit ${credential.label}` : "Store a credential"}>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="cred-label">What it opens</Label>
          <Input
            id="cred-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Microsoft 365 global admin"
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="cred-user">Username</Label>
            <Input id="cred-user" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cred-expires">Expires</Label>
            <Input id="cred-expires" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cred-url">Where</Label>
          <Input id="cred-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="portal.office.com" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cred-secret">{credential ? "New password (leave blank to keep the current one)" : "Password or key"}</Label>
          <Input
            id="cred-secret"
            type="password"
            value={secret}
            autoComplete="new-password"
            onChange={(e) => setSecret(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cred-note">Note</Label>
          <Textarea id="cred-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !label}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
