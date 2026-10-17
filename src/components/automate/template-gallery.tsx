"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { createBlankWorkflow, createWorkflowFromTemplate } from "@/actions/automate";
import type { Blank } from "@/lib/automate/templates";

/**
 * Automate's template gallery (Phase 3): each template's card says what it does step by step; "Use
 * this template" asks only for its blanks, then opens the draft in the builder. Nothing runs until it
 * is published there.
 */

export type TemplateCard = { key: string; name: string; description: string; steps: string[]; blanks: Blank[] };

function BlankField({ blank, value, onChange, people }: { blank: Blank; value: unknown; onChange: (v: unknown) => void; people: { id: string; name: string }[] }) {
  switch (blank.kind) {
    case "person":
      return (
        <Select value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          <option value="owner">Me</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      );
    case "people": {
      const chosen = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="max-h-40 overflow-y-auto rounded-base border border-line p-2">
          {[{ id: "owner", name: "Me" }, ...people].map((p) => (
            <label key={p.id} className="flex items-center gap-2 py-0.5 text-sm">
              <input type="checkbox" checked={chosen.includes(p.id)} onChange={() => onChange(chosen.includes(p.id) ? chosen.filter((c) => c !== p.id) : [...chosen, p.id])} />
              {p.name}
            </label>
          ))}
        </div>
      );
    }
    case "number":
      return <Input type="number" min={blank.min} max={blank.max} value={value === undefined ? String(blank.default) : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />;
    case "time":
      return <Input type="time" value={typeof value === "string" ? value : blank.default} onChange={(e) => onChange(e.target.value)} />;
    case "choice":
      return (
        <Select value={typeof value === "string" ? value : blank.default} onChange={(e) => onChange(e.target.value)}>
          {blank.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      );
  }
}

export function TemplateGallery({ templates, people }: { templates: TemplateCard[]; people: { id: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState<TemplateCard | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = (t: TemplateCard) => {
    setValues({});
    setError(null);
    setOpen(t);
  };
  const make = async () => {
    if (!open) return;
    setBusy(true);
    const made = await createWorkflowFromTemplate(open.key, values);
    setBusy(false);
    if (!made.ok) return setError(made.error);
    router.push(made.data.path);
  };
  const blank = async () => {
    setBusy(true);
    const made = await createBlankWorkflow();
    setBusy(false);
    if (made.ok) router.push(made.data.path);
    else setError(made.error);
  };

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Card className="flex flex-col justify-between gap-3 border-dashed p-4">
          <div>
            <h2 className="font-medium text-text">Start from nothing</h2>
            <p className="mt-1 text-sm text-muted">An empty workflow: choose what starts it, then add its steps.</p>
          </div>
          <Button variant="secondary" size="sm" disabled={busy} onClick={blank} className="self-start">
            New workflow
          </Button>
        </Card>
        {templates.map((t) => (
          <Card key={t.key} className="flex flex-col justify-between gap-3 p-4">
            <div>
              <h2 className="font-medium text-text">{t.name}</h2>
              <p className="mt-1 text-sm text-muted">{t.description}</p>
              <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-xs text-subtle">
                {t.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </div>
            <Button size="sm" disabled={busy} onClick={() => start(t)} className="self-start">
              Use this template
            </Button>
          </Card>
        ))}
      </div>
      {error && !open && <p className="mt-2 text-sm text-danger">{error}</p>}

      <Dialog open={!!open} onClose={() => setOpen(null)} title={open?.name ?? ""}>
        {open && (
          <div className="space-y-3">
            {open.blanks.length === 0 ? (
              <p className="text-sm text-muted">Nothing to fill in. It opens in the builder to read, test and publish.</p>
            ) : (
              open.blanks.map((b) => (
                <div key={b.key} className="space-y-1">
                  <Label>
                    {b.label}
                    {b.kind === "person" && b.required && <span className="text-danger"> *</span>}
                  </Label>
                  <BlankField blank={b} value={values[b.key]} people={people} onChange={(v) => setValues((cur) => ({ ...cur, [b.key]: v }))} />
                  {b.hint && <p className="text-xs text-subtle">{b.hint}</p>}
                </div>
              ))
            )}
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setOpen(null)}>
                Cancel
              </Button>
              <Button disabled={busy} onClick={make}>
                Open it in the builder
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
