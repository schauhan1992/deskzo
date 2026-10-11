"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { deleteSignatureMailbox, saveSignatureMailbox } from "@/actions/signature";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";

export type MailboxView = { id: string; address: string; name: string; phone: string; templateId: string | null; templateName: string };

type Draft = { id: string | null; address: string; name: string; phone: string; templateId: string };

const BLANK: Draft = { id: null, address: "", name: "", phone: "", templateId: "" };

/**
 * Shared mailboxes (sales@, support@) and the signature their messages carry in Outlook: when somebody
 * changes a message's From to one, the add-in puts its signature in instead of theirs.
 */
export function SignatureMailboxes({ mailboxes, templates, outlookOn }: { mailboxes: MailboxView[]; templates: { id: string; name: string }[]; outlookOn: boolean }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = (work: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) =>
    start(async () => {
      setError(null);
      const r = await work();
      if (!r.ok) return setError(r.error ?? "That didn't work.");
      after?.();
      router.refresh();
    });

  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-text">Shared mailboxes (Outlook)</h2>
          <p className="mt-0.5 text-sm text-muted">
            When somebody sends from a shared mailbox — they change the From to sales@ or support@ — Outlook&apos;s add-in puts in the mailbox&apos;s signature: its name and
            number where a person&apos;s would be, from the template you choose.
          </p>
          {!outlookOn && <p className="mt-1 text-xs text-warning">The Outlook add-in is off — turn it on in the Connection tab.</p>}
        </div>
        {!draft && (
          <Button type="button" variant="secondary" onClick={() => setDraft({ ...BLANK })}>
            <Plus className="h-4 w-4" />
            Add a mailbox
          </Button>
        )}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}

      {draft && (
        <div className="grid grid-cols-1 gap-3 rounded-lg border border-line p-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="mb-address">Address</Label>
            <Input id="mb-address" type="email" maxLength={200} value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} placeholder="sales@yourcompany.com" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mb-name">Signed as</Label>
            <Input id="mb-name" maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Acme Sales" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mb-phone">Phone</Label>
            <Input id="mb-phone" maxLength={40} value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} placeholder="+91 22 4000 1000" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mb-template">Template</Label>
            <Select id="mb-template" value={draft.templateId} onChange={(e) => setDraft({ ...draft, templateId: e.target.value })}>
              <option value="">The default</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="button" variant="ghost" onClick={() => setDraft(null)} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={pending}
              onClick={() => run(() => saveSignatureMailbox({ id: draft.id, address: draft.address, name: draft.name, phone: draft.phone, templateId: draft.templateId || null }), () => setDraft(null))}
            >
              {pending ? "Saving…" : "Save mailbox"}
            </Button>
          </div>
        </div>
      )}

      {mailboxes.length === 0 ? (
        !draft && <p className="text-sm text-subtle">None yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {mailboxes.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-text">{m.address}</p>
                <p className="text-xs text-muted">
                  Signed as {m.name}
                  {m.phone ? ` · ${m.phone}` : ""} · {m.templateName}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Change ${m.address}`}
                disabled={pending}
                onClick={() => setDraft({ id: m.id, address: m.address, name: m.name, phone: m.phone, templateId: m.templateId ?? "" })}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove ${m.address}`}
                className="text-danger hover:bg-danger-bg hover:text-danger"
                disabled={pending}
                onClick={() => run(() => deleteSignatureMailbox(m.id))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
