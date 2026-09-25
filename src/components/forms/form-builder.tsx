"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Copy, Eye, Lock, PencilLine, Plus, Trash2 } from "lucide-react";
import type { FormCategory, FormFillMode, MarketingTopic } from "@prisma/client";
import { saveForm } from "@/actions/forms";
import {
  FIELD_TYPES,
  MANDATORY_KEYS,
  cleanOptions,
  isChoice,
  keyFromLabel,
  parseFields,
  type FieldType,
  type FormField,
} from "@/lib/marketing/form-fields";
import { FORM_CATEGORIES, FILL_MODES, categoryOf } from "@/lib/forms/categories";
import { slugFromName } from "@/lib/forms/settings";
import { TOPICS } from "@/lib/marketing/topics";
import { formatIstDateTime, parseIstDateTime } from "@/lib/india-time";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/bulk-select";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { PersonCombobox, type PersonOption } from "@/components/ui/person-combobox";
import { ActionNotice } from "@/components/ui/action-notice";
import { InboundForm, type RenderableForm } from "@/components/marketing/inbound-form";
import { cn } from "@/lib/utils";

export type BuilderSettings = {
  name: string;
  slug: string;
  headline: string;
  intro: string;
  thankYouText: string;
  category: FormCategory;
  fillMode: FormFillMode;
  createsLead: boolean;
  topic: MarketingTopic;
  assignToUserId: string | null;
  /** India time, as a `datetime-local` input holds it. */
  closesAt: string;
  eventStartsAt: string;
  eventEndsAt: string;
  venue: string;
  capacity: string;
  active: boolean;
};

/** A question as the builder holds it: `uid` for React, and `fresh` until it has been saved once. */
type Draft = FormField & { uid: string; fresh: boolean };

let uidCounter = 0;
const nextUid = () => `q${Date.now().toString(36)}${(uidCounter += 1)}`;

/** Deterministic, because the first render happens on the server and its ids must match the browser's. */
function toDrafts(fields: FormField[]): Draft[] {
  return fields.map((f, i) => ({ ...f, uid: `saved-${i}-${f.key}`, fresh: false }));
}

/**
 * The keys a draft will be saved under. An existing question keeps the key its answers are stored
 * under whatever its wording becomes; a new one gets a key from its wording, once, at save.
 */
function withKeys(drafts: Draft[]): FormField[] {
  const taken = new Set(drafts.filter((d) => !d.fresh).map((d) => d.key));
  return drafts.map((d) => {
    const field: FormField = { key: d.key, label: d.label, type: d.type, required: d.required, options: d.options, placeholder: d.placeholder, help: d.help };
    if (!d.fresh) return field;
    const key = keyFromLabel(field.label || (field.type === "HEADING" ? "section" : "question"), taken);
    taken.add(key);
    return { ...field, key };
  });
}

/**
 * Building a form: what it is, who can fill it in, what happens to the answers, and the questions.
 *
 * The preview is the public page itself — the same component a customer sees, with sending switched
 * off — so what is previewed is what is published, not an approximation of it.
 */
export function FormBuilder({
  formId,
  initial,
  initialFields,
  users,
  hasResponses = false,
}: {
  formId?: string;
  initial: BuilderSettings;
  initialFields: FormField[];
  users: PersonOption[];
  hasResponses?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [settings, setSettings] = useState<BuilderSettings>(initial);
  const [drafts, setDrafts] = useState<Draft[]>(() => toDrafts(initialFields));
  const [slugTouched, setSlugTouched] = useState(Boolean(formId));
  const [previewing, setPreviewing] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const event = settings.category === "EVENT";
  const set = <K extends keyof BuilderSettings>(key: K, value: BuilderSettings[K]) => setSettings((s) => ({ ...s, [key]: value }));

  const update = (uid: string, patch: Partial<Draft>) => setDrafts((all) => all.map((d) => (d.uid === uid ? { ...d, ...patch } : d)));
  const move = (index: number, by: number) =>
    setDrafts((all) => {
      const next = [...all];
      const [item] = next.splice(index, 1);
      next.splice(Math.max(0, Math.min(next.length, index + by)), 0, item!);
      return next;
    });
  const add = (type: FieldType) =>
    setDrafts((all) => [
      ...all,
      {
        uid: nextUid(),
        fresh: true,
        key: "",
        label: "",
        type,
        required: false,
        options: isChoice(type) ? ["", ""] : [],
        placeholder: null,
        help: null,
      },
    ]);

  const preview = useMemo<RenderableForm>(() => {
    const starts = parseIstDateTime(settings.eventStartsAt);
    return {
      id: "preview",
      slug: settings.slug || "preview",
      name: settings.name || "Untitled form",
      headline: settings.headline || null,
      intro: settings.intro || null,
      thankYouText: settings.thankYouText || null,
      topic: settings.topic,
      category: settings.category,
      eventStartsAt: starts,
      eventEndsAt: parseIstDateTime(settings.eventEndsAt),
      venue: settings.venue || null,
      eventWhen: starts ? formatIstDateTime(starts) : null,
      fields: parseFields(withKeys(drafts).map((f) => ({ ...f, options: cleanOptions(f.options) }))),
      ourName: "",
      closedMessage: null,
      full: false,
    };
  }, [settings, drafts]);

  const save = () => {
    setNotice(null);
    startTransition(async () => {
      const result = await saveForm({
        id: formId,
        ...settings,
        fields: withKeys(drafts).map((f) => ({ ...f, options: cleanOptions(f.options) })),
      });
      if (!result.ok) {
        setNotice({ tone: "error", text: result.error });
        return;
      }
      if (!formId) {
        router.push(`/marketing/forms/${result.data.id}`);
        return;
      }
      // Saved questions keep their keys from here on — the ones just generated included. Left fresh,
      // a question reworded before the next save would get a new key and leave its answers behind.
      setDrafts((all) => {
        const keyed = withKeys(all);
        return all.map((d, i) => ({ ...d, key: keyed[i]!.key, fresh: false }));
      });
      setNotice({ tone: "success", text: "Saved." });
      router.refresh();
    });
  };

  const switchCategory = (category: FormCategory) => {
    const untouched = !formId && JSON.stringify(withKeys(drafts).map((d) => d.label)) === JSON.stringify(categoryOf(settings.category).starter.map((f) => f.label));
    const next = categoryOf(category);
    setSettings((s) => ({
      ...s,
      category,
      // A new form takes the new kind's defaults; an existing one keeps what somebody set.
      ...(formId ? {} : { fillMode: next.defaults.fillMode, createsLead: next.defaults.createsLead, topic: next.defaults.topic }),
    }));
    if (untouched) setDrafts(toDrafts(next.starter));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-lg border border-line p-0.5">
          {[
            { on: false, label: "Build", Icon: PencilLine },
            { on: true, label: "Preview", Icon: Eye },
          ].map(({ on, label, Icon }) => (
            <button
              key={label}
              type="button"
              aria-pressed={previewing === on}
              onClick={() => setPreviewing(on)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium",
                previewing === on ? "bg-brand-subtle text-brand" : "text-muted hover:text-text",
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => router.back()} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={pending}>
            {pending ? "Saving…" : formId ? "Save changes" : "Create form"}
          </Button>
        </div>
      </div>

      {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}

      {previewing ? (
        <div className="rounded-xl bg-bg py-6">
          <InboundForm form={preview} preview />
        </div>
      ) : (
        <>
          <Section title="What it is">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="fb-name">Name</Label>
                <Input
                  id="fb-name"
                  value={settings.name}
                  onChange={(e) => {
                    const name = e.target.value;
                    setSettings((s) => ({ ...s, name, ...(slugTouched ? {} : { slug: slugFromName(name) }) }));
                  }}
                  placeholder="Pune CIO roundtable — October"
                />
                <p className="text-xs text-subtle">For the list here. The page shows the headline.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fb-category">Kind of form</Label>
                <Select id="fb-category" value={settings.category} onChange={(e) => switchCategory(e.target.value as FormCategory)}>
                  {FORM_CATEGORIES.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-subtle">{categoryOf(settings.category).blurb}</p>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="fb-slug">Web address</Label>
                <div className="flex items-center gap-1.5">
                  <span className="shrink-0 text-sm text-muted">/forms/</span>
                  <Input
                    id="fb-slug"
                    value={settings.slug}
                    onChange={(e) => {
                      setSlugTouched(true);
                      set("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"));
                    }}
                  />
                </div>
                {formId && hasResponses && (
                  <p className="text-xs text-warning">
                    Links to this form are already out there. Changing the address breaks the public link; personal
                    invitations keep working.
                  </p>
                )}
              </div>
            </div>
          </Section>

          <Section title="The page">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="fb-headline">Headline</Label>
                <Input id="fb-headline" value={settings.headline} onChange={(e) => set("headline", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fb-intro">Introduction</Label>
                <Textarea id="fb-intro" rows={3} value={settings.intro} onChange={(e) => set("intro", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fb-thanks">After they send it</Label>
                <Input id="fb-thanks" value={settings.thankYouText} onChange={(e) => set("thankYouText", e.target.value)} />
              </div>
            </div>
          </Section>

          {event && (
            <Section title="The event" note="Shown at the top of the form and in every invitation. Times are India time.">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="fb-starts">Starts</Label>
                  <Input id="fb-starts" type="datetime-local" value={settings.eventStartsAt} onChange={(e) => set("eventStartsAt", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="fb-ends">Finishes (optional)</Label>
                  <Input id="fb-ends" type="datetime-local" value={settings.eventEndsAt} onChange={(e) => set("eventEndsAt", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="fb-venue">Where</Label>
                  <Textarea
                    id="fb-venue"
                    rows={2}
                    value={settings.venue}
                    onChange={(e) => set("venue", e.target.value)}
                    placeholder={"The Westin, Koregaon Park\nor: Online — link sent on registration"}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="fb-seats">Seats (optional)</Label>
                  <Input
                    id="fb-seats"
                    inputMode="numeric"
                    value={settings.capacity}
                    onChange={(e) => set("capacity", e.target.value.replace(/[^0-9]/g, ""))}
                    placeholder="No limit"
                  />
                  <p className="text-xs text-subtle">Once they are taken, &ldquo;I&apos;ll be there&rdquo; is refused. &ldquo;Can&apos;t make it&rdquo; never is.</p>
                </div>
              </div>
            </Section>
          )}

          <Section title="Who can fill it in">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {FILL_MODES.map((mode) => (
                <label
                  key={mode.key}
                  className={cn(
                    "cursor-pointer rounded-lg border px-3 py-2.5",
                    settings.fillMode === mode.key ? "border-brand bg-brand-subtle/60" : "border-line hover:bg-surface-sunken",
                  )}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-text">
                    <input
                      type="radio"
                      name="fb-fill"
                      className="accent-[var(--color-brand)]"
                      checked={settings.fillMode === mode.key}
                      onChange={() => set("fillMode", mode.key)}
                    />
                    {mode.label}
                  </span>
                  <span className="mt-1 block text-xs text-muted">{mode.blurb}</span>
                </label>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="fb-closes">Stop taking answers at (optional)</Label>
                <Input id="fb-closes" type="datetime-local" value={settings.closesAt} onChange={(e) => set("closesAt", e.target.value)} />
                <p className="text-xs text-subtle">{event ? "An event also stops taking RSVPs once it starts." : "India time."}</p>
              </div>
              <div className="flex items-center gap-2 self-center pt-4">
                <Checkbox id="fb-active" checked={settings.active} onChange={(e) => set("active", e.target.checked)} />
                <Label htmlFor="fb-active" className="cursor-pointer">
                  Open — taking answers
                </Label>
              </div>
            </div>
          </Section>

          <Section title="What happens to the answers">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="fb-assign">Tell and route to</Label>
                <PersonCombobox
                  id="fb-assign"
                  people={users}
                  value={settings.assignToUserId ?? ""}
                  onSelect={(p) => set("assignToUserId", p?.id ?? null)}
                  placeholder="Lead assignment rules decide"
                />
                <p className="text-xs text-subtle">
                  An invited customer&apos;s answer goes to whoever invited them. Everything else goes to this person, or
                  where the lead rules send it.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fb-topic">Topic</Label>
                <Select id="fb-topic" value={settings.topic} onChange={(e) => set("topic", e.target.value as MarketingTopic)}>
                  {TOPICS.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-subtle">
                  Somebody who opted out of this in the preference centre is not sent an invitation to it.
                </p>
              </div>
              <div className="flex items-start gap-2 sm:col-span-2">
                <Checkbox id="fb-lead" checked={settings.createsLead} onChange={(e) => set("createsLead", e.target.checked)} />
                <Label htmlFor="fb-lead" className="cursor-pointer">
                  Make a lead from each new answer
                  <span className="block text-xs font-normal text-subtle">
                    With the answers in its description. Not for somebody declining an event.
                  </span>
                </Label>
              </div>
            </div>
          </Section>

          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-text">Questions</h2>
                <p className="text-xs text-subtle">Name and email are always asked — they are how the answer reaches somebody.</p>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {drafts.map((draft, index) => (
                <QuestionCard
                  key={draft.uid}
                  draft={draft}
                  first={index === 0}
                  last={index === drafts.length - 1}
                  onChange={(patch) => update(draft.uid, patch)}
                  onMove={(by) => move(index, by)}
                  onCopy={() =>
                    setDrafts((all) => [...all.slice(0, index + 1), { ...draft, uid: nextUid(), fresh: true, key: "" }, ...all.slice(index + 1)])
                  }
                  onRemove={() => setDrafts((all) => all.filter((d) => d.uid !== draft.uid))}
                />
              ))}

              <div className="rounded-lg border border-dashed border-line p-3">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted">
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  Add
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {FIELD_TYPES.map((t) => (
                    <button
                      key={t.type}
                      type="button"
                      title={t.hint}
                      onClick={() => add(t.type)}
                      className="rounded-full border border-line px-2.5 py-1 text-xs text-text hover:bg-surface-sunken"
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button onClick={save} disabled={pending}>
              {pending ? "Saving…" : formId ? "Save changes" : "Create form"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-text">{title}</h2>
        {note && <p className="text-xs text-subtle">{note}</p>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function QuestionCard({
  draft,
  first,
  last,
  onChange,
  onMove,
  onCopy,
  onRemove,
}: {
  draft: Draft;
  first: boolean;
  last: boolean;
  onChange: (patch: Partial<Draft>) => void;
  onMove: (by: number) => void;
  onCopy: () => void;
  onRemove: () => void;
}) {
  const mandatory = !draft.fresh && (MANDATORY_KEYS as string[]).includes(draft.key);
  const heading = draft.type === "HEADING";
  const id = `qc-${draft.uid}`;
  const textual = ["TEXT", "TEXTAREA", "EMAIL", "PHONE", "NUMBER"].includes(draft.type);

  return (
    <div className={cn("rounded-lg border border-line p-3", heading && "bg-surface-sunken")}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_12rem]">
            <div className="space-y-1">
              <Label htmlFor={`${id}-label`} className="text-xs">
                {heading ? "Heading" : "Question"}
              </Label>
              <Input
                id={`${id}-label`}
                value={draft.label}
                onChange={(e) => onChange({ label: e.target.value })}
                placeholder={heading ? "About your organisation" : "How many seats do you need?"}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-type`} className="text-xs">
                Type
              </Label>
              <Select
                id={`${id}-type`}
                value={draft.type}
                // The address question is validated as an address whatever it is set to, so it is not offered a choice.
                disabled={mandatory && draft.key === "email"}
                onChange={(e) => {
                  const type = e.target.value as FieldType;
                  onChange({
                    type,
                    required: type === "HEADING" ? false : draft.required,
                    options: isChoice(type) ? (draft.options.length ? draft.options : ["", ""]) : [],
                  });
                }}
              >
                {FIELD_TYPES.filter((t) => !mandatory || t.type !== "HEADING").map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {isChoice(draft.type) && (
            <div className="space-y-1">
              <Label htmlFor={`${id}-options`} className="text-xs">
                Options, one per line
              </Label>
              <Textarea
                id={`${id}-options`}
                rows={Math.min(8, Math.max(3, draft.options.length + 1))}
                value={draft.options.join("\n")}
                onChange={(e) => onChange({ options: e.target.value.split("\n") })}
              />
            </div>
          )}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`${id}-help`} className="text-xs">
                {heading ? "Text under the heading" : "Help text (optional)"}
              </Label>
              <Input id={`${id}-help`} value={draft.help ?? ""} onChange={(e) => onChange({ help: e.target.value || null })} />
            </div>
            {textual && (
              <div className="space-y-1">
                <Label htmlFor={`${id}-ph`} className="text-xs">
                  Placeholder (optional)
                </Label>
                <Input id={`${id}-ph`} value={draft.placeholder ?? ""} onChange={(e) => onChange({ placeholder: e.target.value || null })} />
              </div>
            )}
          </div>

          {!heading && (
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${id}-req`}
                checked={draft.required || mandatory}
                disabled={mandatory}
                onChange={(e) => onChange({ required: e.target.checked })}
              />
              <Label htmlFor={`${id}-req`} className="cursor-pointer text-xs">
                Required
              </Label>
              {mandatory && (
                <span className="inline-flex items-center gap-1 text-[11px] text-subtle">
                  <Lock className="h-3 w-3" aria-hidden />
                  Always asked
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-col gap-1">
          <IconAction label="Move up" disabled={first} onClick={() => onMove(-1)} Icon={ArrowUp} />
          <IconAction label="Move down" disabled={last} onClick={() => onMove(1)} Icon={ArrowDown} />
          <IconAction label="Duplicate" disabled={mandatory} onClick={onCopy} Icon={Copy} />
          <IconAction label="Remove" disabled={mandatory} onClick={onRemove} Icon={Trash2} />
        </div>
      </div>
    </div>
  );
}

function IconAction({
  label,
  onClick,
  disabled,
  Icon,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  Icon: typeof ArrowUp;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-md p-1.5 text-muted hover:bg-surface-sunken hover:text-text disabled:pointer-events-none disabled:opacity-30"
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}
