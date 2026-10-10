"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { deleteCardTemplate, makeDefaultCardTemplate, saveCardTemplate } from "@/actions/card";
import {
  DEFAULT_RECORD_FIELDS,
  MAX_QUESTIONS,
  MAX_SHARED_FIELDS,
  RECORD_FIELDS,
  drawCard,
  type CardQuestion,
  type RecordFieldSetting,
} from "@/lib/cards/fields";
import type { TemplateRow } from "@/lib/cards/views";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { CardFace } from "@/components/cards/card-face";
import { FieldsEditor, type DraftField } from "@/components/cards/fields-editor";

type Draft = {
  id: string | null;
  name: string;
  color: string;
  layout: "CLASSIC" | "CENTRED";
  showLogo: boolean;
  recordFields: RecordFieldSetting[];
  sharedFields: DraftField[];
  allowOwnFields: boolean;
  shareBack: boolean;
  questions: CardQuestion[];
};

const BLANK: Draft = {
  id: null,
  name: "",
  color: "#1d4ed8",
  layout: "CLASSIC",
  showLogo: true,
  recordFields: DEFAULT_RECORD_FIELDS,
  sharedFields: [],
  allowOwnFields: true,
  shareBack: true,
  questions: [],
};

const recordLabel = (key: string) => RECORD_FIELDS.find((f) => f.key === key)?.label ?? key;

/**
 * The company's card designs. Changing one changes every card drawn from it the moment it is saved, so
 * the save button says how many.
 */
export function CardTemplates({ templates, logoUrl, company }: { templates: TemplateRow[]; logoUrl: string | null; company: string | null }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (draft) {
    const cards = templates.find((t) => t.id === draft.id)?.cards ?? 0;
    return <TemplateEditor initial={draft} cards={cards} logoUrl={logoUrl} company={company} onDone={() => setDraft(null)} />;
  }

  const act = (work: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const result = await work();
      if (!result.ok) setError(result.error ?? "That didn't work.");
      else router.refresh();
    });

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button type="button" onClick={() => setDraft({ ...BLANK, name: templates.length ? "" : "Company card" })}>
          <Plus className="h-4 w-4" />
          New template
        </Button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {templates.length === 0 ? (
        <Card className="px-6 py-10 text-center text-sm text-muted">
          No templates yet. One is made from your branding the first time a card is issued — or make it now.
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {templates.map((t) => (
            <li key={t.id} className="flex items-center gap-3 rounded-xl border border-line bg-surface p-4">
              <span className="h-10 w-10 shrink-0 rounded-lg" style={{ backgroundColor: t.color }} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-medium text-text">
                  {t.name}
                  {t.isDefault && <Badge tone="brand">Default</Badge>}
                </p>
                <p className="text-xs text-muted">
                  {t.cards} {t.cards === 1 ? "card" : "cards"} · {t.layout === "CENTRED" ? "Centred" : "Classic"}
                  {t.shareBack ? " · asks to share back" : ""}
                </p>
              </div>
              <div className="flex flex-wrap justify-end gap-1">
                <Button type="button" variant="secondary" size="sm" onClick={() => setDraft({ ...t, sharedFields: t.sharedFields })}>
                  Edit
                </Button>
                {!t.isDefault && (
                  <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => act(() => makeDefaultCardTemplate(t.id))}>
                    Make default
                  </Button>
                )}
                {!t.isDefault && t.cards === 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Delete ${t.name}`}
                    className="text-danger hover:bg-danger-bg hover:text-danger"
                    disabled={pending}
                    onClick={() => act(() => deleteCardTemplate(t.id))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TemplateEditor({
  initial,
  cards,
  logoUrl,
  company,
  onDone,
}: {
  initial: Draft;
  cards: number;
  logoUrl: string | null;
  company: string | null;
  onDone: () => void;
}) {
  const router = useRouter();
  const [d, setD] = useState<Draft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setD((prev) => ({ ...prev, [key]: value }));

  const moveRecord = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= d.recordFields.length) return;
    const next = [...d.recordFields];
    [next[i], next[j]] = [next[j]!, next[i]!];
    set("recordFields", next);
  };

  const preview = drawCard({
    record: {
      name: "Priya Sharma",
      title: "Sales manager",
      department: "Sales",
      company: company ?? "Your company",
      phone: "+91 98765 43210",
      email: "priya@yourcompany.com",
      address: "The office she works at",
      hasPhoto: false,
    },
    recordFields: d.recordFields,
    hidden: [],
    shared: d.sharedFields.filter((f) => f.value.trim()),
    own: d.allowOwnFields ? [{ kind: "linkedin", label: "LinkedIn", value: "https://linkedin.com/in/priya" }] : [],
    allowOwnFields: d.allowOwnFields,
  });

  function save() {
    setError(null);
    start(async () => {
      const result = await saveCardTemplate(d);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
      onDone();
    });
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
      <div className="space-y-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="tpl-name">Name</Label>
            <Input id="tpl-name" maxLength={60} value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Sales team" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-color">Colour</Label>
            <div className="flex gap-2">
              <input
                id="tpl-color"
                type="color"
                className="h-9 w-12 cursor-pointer rounded-base border border-line bg-surface"
                value={d.color}
                onChange={(e) => set("color", e.target.value)}
              />
              <Input aria-label="Colour as hex" maxLength={7} value={d.color} onChange={(e) => set("color", e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-layout">Layout</Label>
            <Select id="tpl-layout" value={d.layout} onChange={(e) => set("layout", e.target.value as Draft["layout"])}>
              <option value="CLASSIC">Classic — photo at the side</option>
              <option value="CENTRED">Centred — photo above the name</option>
            </Select>
          </div>
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-text">
            <input type="checkbox" checked={d.showLogo} onChange={(e) => set("showLogo", e.target.checked)} />
            Show the company logo
          </label>
        </div>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-text">From each person&apos;s record</h3>
          <p className="text-xs text-muted">Kept in step with their record. Locked fields can&apos;t be left off by the person.</p>
          <ul className="divide-y divide-line rounded-base border border-line">
            {d.recordFields.map((f, i) => (
              <li key={f.key} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-[8rem] flex-1 text-text">{recordLabel(f.key)}</span>
                <label className="flex items-center gap-1.5 text-muted">
                  <input
                    type="checkbox"
                    checked={f.show}
                    onChange={(e) => set("recordFields", d.recordFields.map((x, j) => (j === i ? { ...x, show: e.target.checked, locked: e.target.checked && x.locked } : x)))}
                  />
                  Show
                </label>
                <label className="flex items-center gap-1.5 text-muted">
                  <input
                    type="checkbox"
                    checked={f.locked}
                    disabled={!f.show}
                    onChange={(e) => set("recordFields", d.recordFields.map((x, j) => (j === i ? { ...x, locked: e.target.checked } : x)))}
                  />
                  Locked
                </label>
                <span className="flex gap-1">
                  <Button type="button" variant="ghost" size="sm" aria-label="Move up" disabled={i === 0} onClick={() => moveRecord(i, -1)}>
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button type="button" variant="ghost" size="sm" aria-label="Move down" disabled={i === d.recordFields.length - 1} onClick={() => moveRecord(i, 1)}>
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-text">On every card</h3>
          <p className="text-xs text-muted">One value for everybody — the website, the head-office number. Nobody can change these.</p>
          <FieldsEditor fields={d.sharedFields} onChange={(next) => set("sharedFields", next)} max={MAX_SHARED_FIELDS} idPrefix="shared-field" addLabel="Add a shared field" />
        </section>

        <section className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="checkbox" checked={d.allowOwnFields} onChange={(e) => set("allowOwnFields", e.target.checked)} />
            People may add their own links and numbers
          </label>
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="checkbox" checked={d.shareBack} onChange={(e) => set("shareBack", e.target.checked)} />
            Ask whoever opens the card to share their details back
          </label>
          {d.shareBack && (
            <div className="space-y-2 rounded-base border border-line p-3">
              <p className="text-xs text-muted">
                Name, email or phone, company and job title are always asked. Add up to {MAX_QUESTIONS} questions of your own.
              </p>
              {d.questions.map((q, i) => (
                <div key={q.id} className="flex flex-wrap items-center gap-2">
                  <Input
                    className="min-w-[12rem] flex-1"
                    maxLength={120}
                    value={q.label}
                    aria-label={`Question ${i + 1}`}
                    placeholder="e.g. What are you looking for?"
                    onChange={(e) => set("questions", d.questions.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                  />
                  <label className="flex items-center gap-1.5 text-sm text-muted">
                    <input
                      type="checkbox"
                      checked={q.required}
                      onChange={(e) => set("questions", d.questions.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))}
                    />
                    Required
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="Remove the question"
                    className="text-danger hover:bg-danger-bg hover:text-danger"
                    onClick={() => set("questions", d.questions.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              {d.questions.length < MAX_QUESTIONS && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => set("questions", [...d.questions, { id: Math.random().toString(36).slice(2, 10), label: "", required: false }])}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add a question
                </Button>
              )}
            </div>
          )}
        </section>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {error && <p className="mr-auto text-sm text-danger">{error}</p>}
          <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={pending}>
            {pending ? "Saving…" : d.id && cards > 0 ? `Save — changes ${cards} ${cards === 1 ? "card" : "cards"} now` : "Save"}
          </Button>
        </div>
      </div>

      <div className="space-y-2 lg:sticky lg:top-4 lg:self-start">
        <p className="text-xs font-medium uppercase tracking-wide text-subtle">Preview</p>
        <CardFace card={preview} color={/^#[0-9a-f]{6}$/i.test(d.color) ? d.color : "#1d4ed8"} layout={d.layout} logoUrl={d.showLogo ? logoUrl : null} photoUrl={null} inert />
      </div>
    </div>
  );
}
