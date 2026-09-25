"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, FileUp, Plus, Send } from "lucide-react";
import type { MarketingTopic, MessageChannel, TemplateFormat } from "@prisma/client";
import type { listTemplates } from "@/actions/marketing";
import { previewTemplate, saveTemplate, sendTestEmail } from "@/actions/marketing";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { EmailFrame } from "@/components/marketing/email-frame";
import { MERGE_FIELDS } from "@/lib/marketing/merge";
import { TOPICS } from "@/lib/marketing/topics";
import { cn } from "@/lib/utils";

type Template = Awaited<ReturnType<typeof listTemplates>>[number];
type Preview = { subject: string | null; html: string | null; problems: string[] };

const STARTER = `Hi {{firstName|there}},

`;

const HTML_STARTER = `<table width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif">
  <tr><td style="padding:24px">
    <h1 style="margin:0 0 12px;font-size:22px">Hello {{firstName|there}},</h1>
    <p style="margin:0 0 12px">Write your message here.</p>
    <p><a href="https://example.com" style="background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Find out more</a></p>
  </td></tr>
</table>`;

/**
 * Writing the email — typed as text, pasted as HTML, or uploaded from a file.
 *
 * The preview is the finished email, footer and all, rebuilt a moment after each change and shown in
 * a sandboxed frame: what you see is what the customer's inbox is sent, less the tracking.
 *
 * The merge-field list is clickable rather than documented, because the one mistake this editor
 * exists to prevent is a field that is empty for some recipients — and the fix for that is a
 * fallback, written as `{{firstName|there}}`. Clicking a field inserts the safe form, where the
 * cursor is.
 */
export function TemplateEditor({ template, trigger, onSaved }: { template?: Template; trigger?: string; onSaved?: (id: string) => void }) {
  const router = useRouter();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [savedId, setSavedId] = useState<string | undefined>(template?.id);

  const [form, setForm] = useState({
    name: template?.name ?? "",
    channel: (template?.channel ?? "EMAIL") as MessageChannel,
    topic: (template?.topic ?? "OFFERS") as MarketingTopic,
    subject: template?.subject ?? "",
    preheader: template?.preheader ?? "",
    body: template?.body ?? STARTER,
    format: (template?.format ?? "TEXT") as TemplateFormat,
    whatsappTemplateName: template?.whatsappTemplateName ?? "",
  });
  const set = <K extends keyof typeof form>(k: K) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value as (typeof form)[K] }));
  const isEmail = form.channel === "EMAIL";

  // The preview follows the typing, a moment behind it.
  useEffect(() => {
    if (!open || !isEmail) return;
    const timer = setTimeout(() => {
      void previewTemplate({ subject: form.subject, preheader: form.preheader, body: form.body, format: form.format }).then(setPreview);
    }, 500);
    return () => clearTimeout(timer);
  }, [open, isEmail, form.subject, form.preheader, form.body, form.format]);

  const insert = (key: string) => {
    // Inserted with a fallback already in place, where the cursor is. A field with no fallback and
    // no value blocks the send, which is correct but only discovered later.
    const token = `{{${key}|—}}`;
    const el = bodyRef.current;
    setForm((f) => {
      const at = el ? el.selectionStart : f.body.length;
      const end = el ? el.selectionEnd : f.body.length;
      return { ...f, body: `${f.body.slice(0, at)}${token}${f.body.slice(end)}` };
    });
  };

  const upload = (file: File) => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const data = new FormData();
      data.set("file", file);
      data.set("name", form.name || file.name.replace(/\.(zip|html?)$/i, ""));
      data.set("topic", form.topic);
      data.set("subject", form.subject);
      data.set("preheader", form.preheader);
      if (savedId) data.set("id", savedId);
      const response = await fetch("/api/marketing/templates/upload", { method: "POST", body: data });
      const result = (await response.json().catch(() => ({ ok: false, error: "The upload failed." }))) as { ok: true; data: { id: string; warnings: string[]; body: string } } | { ok: false; error: string };
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSavedId(result.data.id);
      setWarnings(result.data.warnings);
      // What was stored — cleaned, pictures re-pointed — so a Save after this saves the upload, not the old text.
      setForm((f) => ({ ...f, body: result.data.body, format: "HTML", name: f.name || file.name.replace(/\.(zip|html?)$/i, "") }));
      setNotice(`Uploaded ${file.name} and saved it.`);
      onSaved?.(result.data.id);
      router.refresh();
    });
  };

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        {template ? "Edit" : <><Plus className="mr-1.5 h-3.5 w-3.5" />{trigger ?? "New template"}</>}
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title={template ? "Edit template" : "New template"} wide={isEmail}>
        <div className={cn("grid gap-5", isEmail && "lg:grid-cols-2")}>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="tname">Name</Label>
                <Input id="tname" value={form.name} onChange={set("name")} placeholder="Diwali offer 2026" />
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
              <p className="text-xs text-subtle">Only contacts who agreed to hear about this topic receive it.</p>
            </div>

            {isEmail ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="tsubject">Subject</Label>
                  <Input id="tsubject" value={form.subject} onChange={set("subject")} placeholder="{{firstName|Hello}}, your Diwali offer inside" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tpre">Preview line</Label>
                  <Input id="tpre" value={form.preheader} onChange={set("preheader")} placeholder="The grey line an inbox shows after the subject" />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-text">Body</span>
                  <div className="inline-flex rounded-lg border border-line p-0.5" role="radiogroup" aria-label="Body format">
                    {(["TEXT", "HTML"] as const).map((f) => (
                      <button
                        key={f}
                        type="button"
                        role="radio"
                        aria-checked={form.format === f}
                        onClick={() => setForm((v) => ({ ...v, format: f, body: v.format === f ? v.body : v.body.trim() === STARTER.trim() || v.body.trim() === HTML_STARTER.trim() ? (f === "HTML" ? HTML_STARTER : STARTER) : v.body }))}
                        className={cn("rounded-md px-2.5 py-1 text-xs", form.format === f ? "bg-surface-sunken font-medium text-text" : "text-muted hover:text-text")}
                      >
                        {f === "TEXT" ? "Plain text" : "HTML"}
                      </button>
                    ))}
                  </div>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".html,.htm,.zip,text/html,application/zip"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) upload(file);
                    }}
                  />
                  <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => fileRef.current?.click()} className="ml-auto">
                    <FileUp className="h-3.5 w-3.5" /> Upload .html or .zip
                  </Button>
                </div>
                <p className="-mt-2 text-xs text-subtle">
                  Exported from Stripo, BEE, Mailchimp or Canva? Upload the .html — or a .zip of it with its images folder, and the
                  pictures are hosted for you. Scripts, forms and anything else that runs are removed.
                </p>
              </>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="twa">Approved template name</Label>
                <Input id="twa" value={form.whatsappTemplateName} onChange={set("whatsappTemplateName")} />
                <p className="text-xs text-warning">WhatsApp rejects anything that isn&apos;t a template it has already approved.</p>
              </div>
            )}

            <Textarea
              ref={bodyRef}
              id="tbody"
              aria-label="Body"
              rows={isEmail && form.format === "HTML" ? 16 : 10}
              value={form.body}
              onChange={set("body")}
              className="font-mono text-xs"
              spellCheck={form.format !== "HTML"}
            />

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
                Inserted as <span className="font-mono">{"{{field|—}}"}</span> — the part after the bar is what somebody with no value
                sees. An unsubscribe footer is added to every email unless you place <span className="font-mono">{"{{unsubscribeUrl}}"}</span> yourself.
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
            {notice && <p className="text-sm text-success">{notice}</p>}
            {error && <p className="text-sm text-danger">{error}</p>}

            <div className="flex flex-wrap gap-2">
              <Button
                disabled={pending}
                onClick={() => {
                  setError(null);
                  setNotice(null);
                  startTransition(async () => {
                    const result = await saveTemplate({
                      id: savedId,
                      name: form.name,
                      channel: form.channel,
                      topic: form.topic,
                      subject: form.subject,
                      preheader: form.preheader,
                      body: form.body,
                      format: form.format,
                      whatsappTemplateName: form.whatsappTemplateName,
                    });
                    if (!result.ok) {
                      setError(result.error);
                      return;
                    }
                    setSavedId(result.data.id);
                    setWarnings(result.data.warnings);
                    onSaved?.(result.data.id);
                    if (result.data.warnings.length === 0) setOpen(false);
                    else setNotice("Saved.");
                    router.refresh();
                  });
                }}
              >
                {pending ? "Working…" : "Save"}
              </Button>
              {isEmail && (
                <Button
                  variant="secondary"
                  disabled={pending || !savedId}
                  title={savedId ? "Filled in with example values, to your own inbox" : "Save the template first"}
                  onClick={() => {
                    setError(null);
                    setNotice(null);
                    startTransition(async () => {
                      const result = await sendTestEmail({ templateId: savedId! });
                      if (result.ok) setNotice(`Test sent to ${result.data.to} through ${result.data.provider}. It is the saved version.`);
                      else setError(result.error);
                    });
                  }}
                >
                  <Send className="mr-1.5 h-3.5 w-3.5" />
                  Send a test to me
                </Button>
              )}
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
          </div>

          {isEmail && (
            <div className="space-y-2">
              <p className="text-[11px] uppercase tracking-wide text-subtle">The email, filled in with example values</p>
              {preview?.subject && <p className="text-sm font-medium text-text">{preview.subject}</p>}
              {preview?.html ? <EmailFrame html={preview.html} title="Email preview" height={620} /> : <div className="grid h-40 place-items-center rounded-lg border border-dashed border-line text-xs text-subtle">The preview appears here.</div>}
              {preview?.problems.map((p) => (
                <p key={p} className="text-xs text-danger">
                  {p}
                </p>
              ))}
            </div>
          )}
        </div>
      </Dialog>
    </>
  );
}
