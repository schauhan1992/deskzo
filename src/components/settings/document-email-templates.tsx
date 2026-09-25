"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TradeDocumentType } from "@prisma/client";
import { RotateCcw } from "lucide-react";
import { resetDocumentEmailTemplate, saveDocumentEmailTemplate } from "@/actions/document-mail";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { MERGE_FIELDS, mergeTemplate, type MergeValues } from "@/lib/documents/email-template";
import { cn } from "@/lib/utils";

type Template = {
  docType: TradeDocumentType;
  label: string;
  subject: string;
  body: string;
  customised: boolean;
  updatedBy: string | null;
};

const SAMPLE: MergeValues = Object.fromEntries(MERGE_FIELDS.map((f) => [f.key, f.example]));

/** The words sent with each kind of document, with a preview filled in from example values. */
export function DocumentEmailTemplates({ templates }: { templates: Template[] }) {
  const [active, setActive] = useState<TradeDocumentType>(templates[0]?.docType ?? "INVOICE");
  const current = templates.find((t) => t.docType === active)!;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 border-b border-line" role="tablist" aria-label="Document type">
        {templates.map((t) => (
          <button
            key={t.docType}
            type="button"
            role="tab"
            aria-selected={t.docType === active}
            onClick={() => setActive(t.docType)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
              t.docType === active ? "border-brand text-text" : "border-transparent text-muted hover:text-text",
            )}
          >
            {t.label}
            {t.customised && <span className="ml-1.5 text-[11px] font-normal text-subtle">edited</span>}
          </button>
        ))}
      </div>
      {/* Keyed so switching type starts from that type's saved words, not the last one's edits. */}
      <TemplateEditor key={current.docType} template={current} />
    </div>
  );
}

function TemplateEditor({ template }: { template: Template }) {
  const router = useRouter();
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const previewSubject = mergeTemplate(subject, SAMPLE);
  const previewBody = mergeTemplate(body, SAMPLE);
  const dirty = subject !== template.subject || body !== template.body;

  function save() {
    setNotice(null);
    startTransition(async () => {
      const r = await saveDocumentEmailTemplate({ docType: template.docType, subject, body });
      if (!r.ok) setNotice({ tone: "error", text: r.error });
      else {
        setNotice({ tone: "success", text: "Saved. The next email for this type uses it." });
        router.refresh();
      }
    });
  }

  function reset() {
    if (!window.confirm(`Go back to the built-in wording for ${template.label.toLowerCase()}s?`)) return;
    setNotice(null);
    startTransition(async () => {
      const r = await resetDocumentEmailTemplate(template.docType);
      if (!r.ok) setNotice({ tone: "error", text: r.error });
      else router.refresh();
    });
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-text">{template.label} email</h2>
          <p className="mt-0.5 text-xs text-muted">
            What the Mail button fills in. The sender can still change it before sending.
            {template.updatedBy ? ` Last changed by ${template.updatedBy}.` : ""}
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="tpl-subject">Subject</Label>
            <Input id="tpl-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="tpl-body">Message</Label>
            <Textarea id="tpl-body" rows={14} value={body} onChange={(e) => setBody(e.target.value)} maxLength={10000} className="font-mono text-[13px]" />
          </div>
          {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={pending || !dirty}>
              {pending ? "Saving…" : "Save"}
            </Button>
            {template.customised && (
              <Button variant="ghost" onClick={reset} disabled={pending}>
                <RotateCcw className="mr-1 h-3.5 w-3.5" />
                Back to the built-in wording
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold text-text">Preview</h2>
            <p className="mt-0.5 text-xs text-muted">Filled in with example values.</p>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {previewSubject.ok && previewBody.ok ? (
              <>
                <p className="font-medium text-text">{previewSubject.text}</p>
                <p className="whitespace-pre-line text-muted">{previewBody.text}</p>
              </>
            ) : (
              <ActionNotice tone="error">{!previewSubject.ok ? previewSubject.error : !previewBody.ok ? previewBody.error : ""}</ActionNotice>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold text-text">Fields you can use</h2>
            <p className="mt-0.5 text-xs text-muted">
              <code>{"{{field|fallback}}"}</code> uses the fallback when there&apos;s no value; <code>{"{{field|}}"}</code> leaves it out.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-line text-xs">
              {MERGE_FIELDS.map((f) => (
                <li key={f.key} className="flex items-baseline justify-between gap-3 px-5 py-1.5">
                  <code className="text-brand">{`{{${f.key}}}`}</code>
                  <span className="text-right text-muted">{f.label}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
