"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { deleteCardEvent, saveCardEvent } from "@/actions/card";
import { MAX_QUESTIONS, type CardQuestion } from "@/lib/cards/fields";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

export type EventDraft = {
  id: string | null;
  name: string;
  venue: string;
  startsOn: string;
  endsOn: string;
  goal: string;
  cost: string;
  memberIds: string[];
  questions: CardQuestion[];
};

export type TeamChoice = { id: string; name: string; department: string | null; hasCard: boolean };

/**
 * An event the team works: its days, its goal and cost, who works it, and the questions its booth form
 * asks. People without a live card can be on the team — they can scan — but only a card has a booth form.
 */
export function EventEditor({ initial, people, canDelete }: { initial: EventDraft; people: TeamChoice[]; canDelete: boolean }) {
  const router = useRouter();
  const [d, setD] = useState(initial);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof EventDraft>(key: K, value: EventDraft[K]) => setD((prev) => ({ ...prev, [key]: value }));
  const team = new Set(d.memberIds);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return people.filter((p) => !needle || `${p.name} ${p.department ?? ""}`.toLowerCase().includes(needle));
  }, [people, q]);

  function save() {
    setError(null);
    start(async () => {
      const result = await saveCardEvent({
        ...d,
        goal: d.goal.trim() ? Number(d.goal) : null,
        cost: d.cost.trim() ? Number(d.cost) : null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/cards/events/${result.data.id}`);
      router.refresh();
    });
  }

  function remove() {
    if (!d.id) return;
    setError(null);
    start(async () => {
      const result = await deleteCardEvent(d.id!);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push("/cards/events");
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="ev-name">Name</Label>
          <Input id="ev-name" maxLength={120} value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Convergence India 2026" />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="ev-venue">Venue</Label>
          <Input id="ev-venue" maxLength={160} value={d.venue} onChange={(e) => set("venue", e.target.value)} placeholder="e.g. Pragati Maidan, Hall 5, stand B12" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ev-start">First day</Label>
          <Input id="ev-start" type="date" value={d.startsOn} onChange={(e) => set("startsOn", e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ev-end">Last day</Label>
          <Input id="ev-end" type="date" value={d.endsOn} min={d.startsOn || undefined} onChange={(e) => set("endsOn", e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ev-goal">Goal — people to meet</Label>
          <Input id="ev-goal" inputMode="numeric" value={d.goal} onChange={(e) => set("goal", e.target.value.replace(/[^0-9]/g, ""))} placeholder="Optional" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ev-cost">What it cost</Label>
          <Input id="ev-cost" inputMode="decimal" value={d.cost} onChange={(e) => set("cost", e.target.value.replace(/[^0-9.]/g, ""))} placeholder="Optional — for the cost per person" />
        </div>
      </div>

      <section className="space-y-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-text">The team</h3>
            <p className="text-xs text-muted">
              Share-backs from their cards on the event&apos;s days count towards it, and they can scan visitors&apos; cards. {team.size} chosen.
            </p>
          </div>
          <Input className="max-w-xs" placeholder="Find somebody" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find somebody" />
        </div>
        <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-base border border-line">
          {shown.map((p) => (
            <li key={p.id}>
              <label className="flex items-center gap-3 px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={team.has(p.id)}
                  onChange={(e) => set("memberIds", e.target.checked ? [...d.memberIds, p.id] : d.memberIds.filter((id) => id !== p.id))}
                />
                <span className="flex-1 text-text">
                  {p.name}
                  {p.department && <span className="text-muted"> · {p.department}</span>}
                </span>
                {p.hasCard ? <Badge tone="green">Card</Badge> : <Badge title="Can scan, but has no booth form">No card</Badge>}
              </label>
            </li>
          ))}
          {shown.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted">Nobody matches.</li>}
        </ul>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-text">Booth form questions</h3>
        <p className="text-xs text-muted">
          Name, email or phone, company and job title are always asked. Up to {MAX_QUESTIONS} of your own — what they&apos;re looking for, a budget, a timeline.
          Without any, the card&apos;s own questions are asked.
        </p>
        {d.questions.map((question, i) => (
          <div key={question.id} className="flex flex-wrap items-center gap-2">
            <Input
              className="min-w-[12rem] flex-1"
              maxLength={120}
              value={question.label}
              aria-label={`Question ${i + 1}`}
              placeholder="e.g. What are you looking for?"
              onChange={(e) => set("questions", d.questions.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
            />
            <label className="flex items-center gap-1.5 text-sm text-muted">
              <input
                type="checkbox"
                checked={question.required}
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
      </section>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {error && <p className="mr-auto text-sm text-danger">{error}</p>}
        {d.id && canDelete && (
          <Button type="button" variant="ghost" className="text-danger hover:bg-danger-bg hover:text-danger" onClick={remove} disabled={pending}>
            Delete event
          </Button>
        )}
        <Button type="button" onClick={save} disabled={pending}>
          {pending ? "Saving…" : d.id ? "Save" : "Create event"}
        </Button>
      </div>
    </div>
  );
}
