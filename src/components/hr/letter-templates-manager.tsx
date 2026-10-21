"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FilePlus2, Pencil, Trash2 } from "lucide-react";
import { deleteLetterTemplate, saveLetterTemplate, type LetterTemplateRow } from "@/actions/letter-templates";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/bulk-select";
import { LETTER_FIELDS, STARTER_TEMPLATE, unknownLetterFields } from "@/lib/hr/letter-templates";

/**
 * HR's own templates for official documents (owner, 21 Oct 2026) — a bonafide certificate, an NDA, a
 * no-objection letter the built-in set doesn't have. Written with {{fields}} that a person's record fills in
 * when one is drafted from their page.
 */
export function LetterTemplatesManager({ templates }: { templates: LetterTemplateRow[] }) {
  const [editing, setEditing] = useState<LetterTemplateRow | "new" | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">
          Your own letters and documents, beside the built-in ones. Draft one from anybody&apos;s page under Letters — their details are filled in,
          and the draft can still be reworded before it&apos;s issued.
        </p>
        <Button onClick={() => setEditing("new")}>
          <FilePlus2 className="mr-1.5 h-4 w-4" />
          New template
        </Button>
      </div>

      {templates.length === 0 ? (
        <Card className="px-4 py-12 text-center text-sm text-subtle">No templates of your own yet.</Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {templates.map((t) => (
            <TemplateCard key={t.id} template={t} onEdit={() => setEditing(t)} />
          ))}
        </div>
      )}

      {editing && <TemplateDialog template={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function TemplateCard({ template, onEdit }: { template: LetterTemplateRow; onEdit: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function remove() {
    const used = template.letters > 0;
    const question = used
      ? `${template.name} has ${template.letters} letter(s) drafted from it, so it'll be switched off rather than deleted. Those letters stay as they are.`
      : `Delete ${template.name}?`;
    if (!window.confirm(question)) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteLetterTemplate(template.id);
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  }

  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium text-text">{template.name}</h3>
          <p className="font-mono text-[11px] text-subtle">…/{template.code}/YYYY/001</p>
        </div>
        <div className="flex items-center gap-1">
          {!template.active && <Badge>Off</Badge>}
          <Button size="sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${template.name}`}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={remove} disabled={pending} aria-label={`Delete ${template.name}`}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <p className="truncate text-xs text-muted">{template.subject}</p>
      <p className="line-clamp-3 whitespace-pre-wrap text-xs text-subtle">{template.body}</p>
      <p className="text-[11px] text-subtle">{template.letters === 0 ? "Not used yet" : `${template.letters} letter(s) drafted from it`}</p>
      {error && <p className="text-xs text-danger">{error}</p>}
    </Card>
  );
}

function TemplateDialog({ template, onClose }: { template: LetterTemplateRow | null; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: template?.name ?? STARTER_TEMPLATE.name,
    code: template?.code ?? STARTER_TEMPLATE.code,
    subject: template?.subject ?? STARTER_TEMPLATE.subject,
    body: template?.body ?? STARTER_TEMPLATE.body,
    active: template?.active ?? true,
  });
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const unknown = unknownLetterFields(`${form.subject}\n${form.body}`);

  /** Puts a field where the cursor is in the body, as an email template's picker does. */
  function insert(key: string) {
    const area = bodyRef.current;
    const token = `{{${key}}}`;
    if (!area) {
      setForm({ ...form, body: form.body + token });
      return;
    }
    const start = area.selectionStart ?? form.body.length;
    const end = area.selectionEnd ?? start;
    const body = form.body.slice(0, start) + token + form.body.slice(end);
    setForm({ ...form, body });
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(start + token.length, start + token.length);
    });
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveLetterTemplate({ id: template?.id, ...form });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog open onClose={onClose} title={template ? `Edit ${template.name}` : "New letter template"} wide>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_15rem]">
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_8rem]">
            <div className="space-y-1.5">
              <Label htmlFor="template-name">Name</Label>
              <Input id="template-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Bonafide certificate" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="template-code">Code</Label>
              <Input
                id="template-code"
                value={form.code}
                maxLength={5}
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase().replace(/[^A-Z]/g, "") })}
                placeholder="BON"
                className="font-mono uppercase"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="template-subject">Subject</Label>
            <Input id="template-subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="template-body">Letter</Label>
            <Textarea
              id="template-body"
              ref={bodyRef}
              rows={18}
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              className="font-mono text-xs leading-relaxed"
            />
            <p className="text-xs text-subtle">
              A field with nothing on someone&apos;s record leaves a blank line to fill in on the draft. To say something else instead, write{" "}
              <code className="font-mono">{"{{employee.department|our team}}"}</code>.
            </p>
            {unknown.length > 0 && (
              <p className="text-xs text-danger">
                Not a field: {unknown.map((k) => `{{${k}}}`).join(", ")}
              </p>
            )}
          </div>
          {template && (
            <label className="flex items-center gap-2 text-sm text-muted">
              <Checkbox checked={form.active} onChange={() => setForm({ ...form, active: !form.active })} aria-label="Offer this template" />
              Offered when drafting a letter
            </label>
          )}
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button onClick={save} disabled={pending || unknown.length > 0}>
              {pending ? "Saving…" : "Save template"}
            </Button>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>

        <aside className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Fields — click to put one in</p>
          <div className="max-h-[28rem] space-y-1 overflow-y-auto pr-1">
            {LETTER_FIELDS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => insert(f.key)}
                className="block w-full rounded-md border border-line px-2 py-1.5 text-left hover:bg-surface-sunken"
              >
                <span className="block text-xs text-text">{f.label}</span>
                <span className="block font-mono text-[10px] text-subtle">
                  {`{{${f.key}}}`} · {f.example}
                </span>
              </button>
            ))}
          </div>
        </aside>
      </div>
    </Dialog>
  );
}
