"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Eye, Plus } from "lucide-react";
import type { MarketingTopic, MessageChannel } from "@prisma/client";
import type { listTemplates } from "@/actions/marketing";
import { previewTemplate, saveTemplate } from "@/actions/marketing";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { MERGE_FIELDS } from "@/lib/marketing/merge";
import { TOPICS } from "@/lib/marketing/topics";

type Template = Awaited<ReturnType<typeof listTemplates>>[number];

const STARTER = `Hi {{firstName|there}},

`;

/**
 * Writing the email.
 *
 * The merge-field list is clickable rather than documented, because the one mistake this editor
 * exists to prevent is a field that is empty for some recipients — and the fix for that is a
 * fallback, written as `{{firstName|there}}`. Clicking a field inserts the safe form.
 */
export function TemplateEditor({ template, trigger }: { template?: Template; trigger?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [preview, setPreview] = useState<{ subject: string | null; body: string | null; problems: string[] } | null>(
    null,
  );

  const [form, setForm] = useState({
    name: template?.name ?? "",
    channel: (template?.channel ?? "EMAIL") as MessageChannel,
    topic: (template?.topic ?? "RENEWALS") as MarketingTopic,
    subject: template?.subject ?? "",
    body: template?.body ?? STARTER,
    whatsappTemplateName: template?.whatsappTemplateName ?? "",
  });
  const set = <K extends keyof typeof form>(k: K) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value as (typeof form)[K] }));

  const insert = (key: string) => {
    // Inserted with a fallback already in place. A field with no fallback and no value blocks the
    // send, which is correct but only discovered later — better to start from the safe form.
    setForm((f) => ({ ...f, body: `${f.body}{{${key}|—}}` }));
    setPreview(null);
  };

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        {template ? "Edit" : <><Plus className="mr-1.5 h-3.5 w-3.5" />{trigger ?? "New template"}</>}
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title={template ? "Edit template" : "New template"}>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="tname">Name</Label>
              <Input id="tname" value={form.name} onChange={set("name")} placeholder="Renewal — 60 days out" />
              <p className="text-xs text-subtle">For you, not the customer.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tchannel">Channel</Label>
              <Select id="tchannel" value={form.channel} onChange={set("channel")}>
                <option value="EMAIL">Email</option>
                <option value="WHATSAPP">WhatsApp</option>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ttopic">Topic</Label>
            <Select id="ttopic" value={form.topic} onChange={set("topic")}>
              {TOPICS.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </Select>
            <p className="text-xs text-subtle">
              Only contacts who opted in to this topic will receive it. It is also what they see in the preference
              centre.
            </p>
          </div>

          {form.channel === "EMAIL" ? (
            <div className="space-y-1.5">
              <Label htmlFor="tsubject">Subject</Label>
              <Input
                id="tsubject"
                value={form.subject}
                onChange={set("subject")}
                placeholder="{{companyName}} — your renewal is due {{expiryDate}}"
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="twa">Approved template name</Label>
              <Input id="twa" value={form.whatsappTemplateName} onChange={set("whatsappTemplateName")} />
              <p className="text-xs text-warning">
                WhatsApp rejects anything that isn&apos;t a template it has already approved. This is the name
                registered with Meta, not the wording.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="tbody">Body</Label>
            <Textarea id="tbody" rows={10} value={form.body} onChange={set("body")} className="font-mono text-xs" />
          </div>

          <div className="space-y-1.5">
            <Label>Insert a field</Label>
            <div className="flex flex-wrap gap-1.5">
              {MERGE_FIELDS.map((field) => (
                <button
                  key={field.key}
                  type="button"
                  onClick={() => insert(field.key)}
                  title={field.source}
                  className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted hover:bg-surface-sunken hover:text-text"
                >
                  {field.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-subtle">
              Inserted as <span className="font-mono">{"{{field|—}}"}</span> — the part after the bar is what a
              recipient with no value sees. Without one, a blank blocks the send rather than greeting somebody as
              &ldquo;Hi ,&rdquo;.
            </p>
          </div>

          {warnings.length > 0 && (
            <Card className="border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
              {warnings.map((w) => (
                <p key={w} className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  {w}
                </p>
              ))}
            </Card>
          )}

          {preview && (
            <Card className="bg-surface-sunken px-3 py-2.5">
              <p className="text-[11px] uppercase tracking-wide text-subtle">Filled in with example values</p>
              {preview.subject && <p className="mt-1 text-sm font-medium text-text">{preview.subject}</p>}
              {preview.body && <p className="mt-1 whitespace-pre-line text-xs text-muted">{preview.body}</p>}
              {preview.problems.map((p) => (
                <p key={p} className="mt-1 text-xs text-danger">
                  {p}
                </p>
              ))}
            </Card>
          )}

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex flex-wrap gap-2">
            <Button
              disabled={pending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await saveTemplate({
                    id: template?.id,
                    name: form.name,
                    channel: form.channel,
                    topic: form.topic,
                    subject: form.subject,
                    body: form.body,
                    whatsappTemplateName: form.whatsappTemplateName,
                  });
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  setWarnings(result.data.warnings);
                  if (result.data.warnings.length === 0) setOpen(false);
                  router.refresh();
                });
              }}
            >
              {pending ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => {
                startTransition(async () => {
                  setPreview(await previewTemplate({ subject: form.subject, body: form.body }));
                });
              }}
            >
              <Eye className="mr-1.5 h-3.5 w-3.5" />
              Preview
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
