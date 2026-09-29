"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import type { listCloseTemplates } from "@/actions/close";
import { deleteCloseTemplate, reorderCloseTemplates, saveCloseTemplate } from "@/actions/close";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { PersonCombobox, type PersonOption } from "@/components/ui/person-combobox";
import { AUTO_CHECK_KEYS, AUTO_CHECK_LABELS, DEFAULT_DUE_DAY, isAutoCheckKey } from "@/lib/close/catalogue";

type Template = Awaited<ReturnType<typeof listCloseTemplates>>[number];

type Draft = { id: string | null; title: string; description: string; ownerId: string; dueDay: string; autoCheck: string; active: boolean };

const BLANK: Draft = { id: null, title: "", description: "", ownerId: "", dueDay: String(DEFAULT_DUE_DAY), autoCheck: "", active: true };

/** The short name of each automatic check, for the list and the picker. */
const CHECK_NAMES: Record<string, string> = {
  "bank-reconciled": "Bank reconciled",
  "invoices-issued": "Invoices issued",
  "revenue-recognised": "Revenue recognised",
  "schedules-posted": "Prepaids and accruals posted",
  "depreciation-run": "Depreciation run",
  "payroll-posted": "Payroll posted",
  "expenses-posted": "Expense claims posted",
  "ar-ties": "Receivables tie to the ledger",
  "ap-ties": "Payables tie to the ledger",
  "delivered-not-invoiced": "Nothing delivered waiting to be invoiced",
  "flux-explained": "Flagged changes explained",
};

function ordinal(n: number): string {
  const rem = n % 100;
  if (rem >= 11 && rem <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`;
}

/**
 * The month-end checklist's templates: what every month's close is copied from.
 *
 * A change applies to months generated from now on — a month already opened keeps its tasks. Deactivating
 * a task keeps its history; deleting is offered only for one that no month has used.
 */
export function CloseTemplateEditor({ templates, people }: { templates: Template[]; people: PersonOption[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, onOk?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "That didn't work.");
        return;
      }
      onOk?.();
      router.refresh();
    });
  }

  function move(index: number, by: -1 | 1) {
    const ids = templates.map((t) => t.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + by, 0, moved!);
    run(() => reorderCloseTemplates(ids));
  }

  function edit(t: Template) {
    setError(null);
    setDraft({
      id: t.id,
      title: t.title,
      description: t.description ?? "",
      ownerId: t.ownerId ?? "",
      dueDay: String(t.dueDay),
      autoCheck: t.autoCheck ?? "",
      active: t.active,
    });
  }

  function save(d: Draft) {
    run(
      () =>
        saveCloseTemplate({
          id: d.id,
          title: d.title,
          description: d.description,
          ownerId: d.ownerId || null,
          dueDay: Number(d.dueDay),
          autoCheck: d.autoCheck || null,
          active: d.active,
        }),
      () => setDraft(null),
    );
  }

  function toggleActive(t: Template) {
    run(() =>
      saveCloseTemplate({ id: t.id, title: t.title, description: t.description, ownerId: t.ownerId, dueDay: t.dueDay, autoCheck: t.autoCheck, active: !t.active }),
    );
  }

  return (
    <div className="space-y-4">
      {error && !draft && <Card className="border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">{error}</Card>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted">
          Each month&apos;s checklist is copied from these, in this order, when the month is first opened (or on the 1st of the
          next month). Changes apply to months opened from now on.
        </p>
        <Button size="sm" onClick={() => setDraft({ ...BLANK })}>
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add a task
        </Button>
      </div>

      <Card className="overflow-hidden p-0">
        {templates.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-muted">
            No tasks. Add the jobs your month-end involves — each one can be ticked by an automatic check, or by hand.
          </p>
        ) : (
          <ol>
            {templates.map((t, i) => (
              <li key={t.id} className={`flex flex-wrap items-start gap-3 border-b border-line px-4 py-3 last:border-0 ${t.active ? "" : "bg-surface-sunken/60"}`}>
                <span className="w-6 shrink-0 pt-0.5 text-right text-xs tabular-nums text-subtle">{i + 1}.</span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
                    {t.title}
                    {!t.active && <Badge tone="default">Inactive</Badge>}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    {isAutoCheckKey(t.autoCheck) ? `Checked automatically: ${CHECK_NAMES[t.autoCheck]}` : "Ticked by hand"} · due the{" "}
                    {ordinal(t.dueDay)} working day · {t.owner ? t.owner.name : "no owner"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    onClick={() => move(i, -1)}
                    disabled={pending || i === 0}
                    aria-label={`Move ${t.title} up`}
                    className="rounded-base p-1.5 text-subtle hover:bg-surface-sunken hover:text-text disabled:opacity-40"
                  >
                    <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(i, 1)}
                    disabled={pending || i === templates.length - 1}
                    aria-label={`Move ${t.title} down`}
                    className="rounded-base p-1.5 text-subtle hover:bg-surface-sunken hover:text-text disabled:opacity-40"
                  >
                    <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => edit(t)} aria-label={`Edit ${t.title}`}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => toggleActive(t)} aria-label={`${t.active ? "Deactivate" : "Reactivate"} ${t.title}`}>
                    {t.active ? "Deactivate" : "Reactivate"}
                  </Button>
                  {t._count.tasks === 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      aria-label={`Delete ${t.title}`}
                      onClick={() => {
                        if (window.confirm(`Delete "${t.title}"? No month has used it yet.`)) run(() => deleteCloseTemplate(t.id));
                      }}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Dialog open={!!draft} onClose={() => setDraft(null)} title={draft?.id ? `Edit ${draft.title || "task"}` : "Add a task"}>
        {draft && <TemplateForm draft={draft} people={people} pending={pending} error={error} onSave={save} onCancel={() => setDraft(null)} />}
      </Dialog>
    </div>
  );
}

/** A template's fields. Exported so its render can be checked without opening the dialog. */
export function TemplateForm({
  draft: initial,
  people,
  pending,
  error,
  onSave,
  onCancel,
}: {
  draft: Draft;
  people: PersonOption[];
  pending: boolean;
  error: string | null;
  onSave: (d: Draft) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState(initial);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setD((cur) => ({ ...cur, [key]: value }));
  const f = (name: string) => `template-${initial.id ?? "new"}-${name}`;
  const due = Number(d.dueDay);
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={f("title")}>Task</Label>
        <Input id={f("title")} value={d.title} maxLength={200} onChange={(e) => set("title", e.target.value)} placeholder="Petty cash counted" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={f("description")}>What done looks like (optional)</Label>
        <Textarea id={f("description")} value={d.description} maxLength={2000} onChange={(e) => set("description", e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={f("check")}>Automatic check</Label>
        <Select id={f("check")} value={d.autoCheck} onChange={(e) => set("autoCheck", e.target.value)}>
          <option value="">None — ticked by hand</option>
          {AUTO_CHECK_KEYS.map((key) => (
            <option key={key} value={key}>
              {CHECK_NAMES[key]} — {AUTO_CHECK_LABELS[key]}
            </option>
          ))}
        </Select>
        <p className="text-xs text-subtle">
          {isAutoCheckKey(d.autoCheck)
            ? `Ticked automatically when: ${AUTO_CHECK_LABELS[d.autoCheck].toLowerCase()}. It runs every night and whenever the close page is opened.`
            : "Somebody ticks it, or marks it not applicable with a reason."}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={f("owner")}>Owner (optional)</Label>
          <PersonCombobox id={f("owner")} people={people} value={d.ownerId} onSelect={(p) => set("ownerId", p?.id ?? "")} placeholder="Nobody — search by name" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={f("due")}>Due on working day</Label>
          <Input id={f("due")} type="number" inputMode="numeric" min={1} max={31} step={1} value={d.dueDay} onChange={(e) => set("dueDay", e.target.value)} className="w-28" />
          <p className="text-xs text-subtle">
            {Number.isInteger(due) && due >= 1 && due <= 31
              ? `The ${ordinal(due)} working day (Mon–Fri) of the following month${due > 20 ? " — or its last, in a shorter month" : ""}.`
              : "A working day of the following month, 1 to 31."}
          </p>
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-text">
        <input type="checkbox" checked={d.active} onChange={(e) => set("active", e.target.checked)} />
        Active — copied into each new month
      </label>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending || !d.title.trim()} onClick={() => onSave(d)}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
