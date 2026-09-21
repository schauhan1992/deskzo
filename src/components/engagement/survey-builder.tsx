"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import type { SurveyAudience, SurveyKind, SurveyQuestionKind, SurveyStatus } from "@prisma/client";
import { saveSurvey } from "@/actions/survey";
import { audienceLabels, isChoice, questionKindLabels, surveyKindLabels } from "@/lib/engagement/anonymity";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { IconButton } from "@/components/ui/icon-button";
import { Checkbox } from "@/components/ui/bulk-select";

type Draft = { id?: string; kind: SurveyQuestionKind; prompt: string; helpText: string; required: boolean; options: string[] };

/**
 * Building a form, poll or vote.
 *
 * Anonymity is a radio choice rather than a checkbox tucked in a corner, because it is the single
 * decision that changes what respondents are promised — and once anybody has answered it cannot be
 * changed, which the server refuses and this screen says up front.
 */
export function SurveyBuilder({
  options,
  onSaved,
}: {
  options: { users: { id: string; name: string }[]; departments: { id: string; name: string }[] };
  onSaved?: () => void;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<SurveyKind>("FORM");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [anonymous, setAnonymous] = useState(true);
  const [mandatory, setMandatory] = useState(false);
  const [audience, setAudience] = useState<SurveyAudience>("EVERYONE");
  const [targetUserIds, setTargetUserIds] = useState<string[]>([]);
  const [targetDepartmentIds, setTargetDepartmentIds] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState("");
  const [status, setStatus] = useState<SurveyStatus>("DRAFT");
  const [questions, setQuestions] = useState<Draft[]>([
    { kind: "RATING", prompt: "", helpText: "", required: true, options: [] },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const update = (i: number, patch: Partial<Draft>) =>
    setQuestions((prev) => prev.map((q, j) => (i === j ? { ...q, ...patch } : q)));

  const toggle = (list: string[], set: (v: string[]) => void, id: string) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">New form</CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="s-kind">Kind</Label>
            <Select id="s-kind" value={kind} onChange={(e) => setKind(e.target.value as SurveyKind)}>
              {(Object.keys(surveyKindLabels) as SurveyKind[]).map((k) => (
                <option key={k} value={k}>{surveyKindLabels[k]}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-expiry">Closes on</Label>
            <Input id="s-expiry" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="s-title">Title</Label>
          <Input id="s-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="How is this quarter going?" />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="s-desc">Introduction</Label>
          <Textarea id="s-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        <div className="space-y-2 rounded-base border border-line p-3">
          <Label>Answers are</Label>
          <label className="flex items-start gap-2 text-sm text-text">
            <input type="radio" checked={anonymous} onChange={() => setAnonymous(true)} className="mt-1" />
            <span>
              Anonymous
              <span className="block text-xs text-subtle">
                You&apos;ll know who has answered, never what they said. Results stay hidden until five people have
                replied.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-text">
            <input type="radio" checked={!anonymous} onChange={() => setAnonymous(false)} className="mt-1" />
            <span>
              Attributed
              <span className="block text-xs text-subtle">
                You&apos;ll see who said what, and the form tells them so before they answer.
              </span>
            </span>
          </label>
          <p className="text-xs text-warning">This can&apos;t be changed once anybody has answered.</p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="s-audience">Who it goes to</Label>
            <Select id="s-audience" value={audience} onChange={(e) => setAudience(e.target.value as SurveyAudience)}>
              {(Object.keys(audienceLabels) as SurveyAudience[]).map((a) => (
                <option key={a} value={a}>{audienceLabels[a]}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-status">Publish as</Label>
            <Select id="s-status" value={status} onChange={(e) => setStatus(e.target.value as SurveyStatus)}>
              <option value="DRAFT">Draft — nobody sees it</option>
              <option value="OPEN">Open — notify them now</option>
            </Select>
          </div>
        </div>

        {audience === "DEPARTMENT" && (
          <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-base bg-surface-sunken p-3">
            {options.departments.map((d) => (
              <label key={d.id} className="flex items-center gap-2 text-sm text-text">
                <Checkbox
                  checked={targetDepartmentIds.includes(d.id)}
                  onChange={() => toggle(targetDepartmentIds, setTargetDepartmentIds, d.id)}
                />
                {d.name}
              </label>
            ))}
          </div>
        )}

        {audience === "INDIVIDUAL" && (
          <div className="flex max-h-48 flex-wrap gap-x-4 gap-y-2 overflow-y-auto rounded-base bg-surface-sunken p-3">
            {options.users.map((u) => (
              <label key={u.id} className="flex items-center gap-2 text-sm text-text">
                <Checkbox checked={targetUserIds.includes(u.id)} onChange={() => toggle(targetUserIds, setTargetUserIds, u.id)} />
                {u.name}
              </label>
            ))}
          </div>
        )}

        <label className="flex items-start gap-2 text-sm text-text">
          <Checkbox checked={mandatory} onChange={() => setMandatory(!mandatory)} />
          <span>
            Must be filled in
            <span className="block text-xs text-subtle">
              Covers their screen on next sign-in. They can push it away once, and it comes back next session
              until it&apos;s done.
            </span>
          </span>
        </label>

        <div className="space-y-3 border-t border-line pt-4">
          <Label>Questions</Label>
          {questions.map((q, i) => (
            <div key={i} className="space-y-2 rounded-base border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                {/*
                  Named by the question's position rather than by a paired label: these rows are a
                  list that grows and shrinks, so a hardcoded id would repeat across every one of
                  them, and the number is the only thing that tells a screen reader which question
                  is being edited.
                */}
                <Input
                  aria-label={`Question ${i + 1}`}
                  value={q.prompt}
                  onChange={(e) => update(i, { prompt: e.target.value })}
                  placeholder={`Question ${i + 1}`}
                  className="min-w-40 flex-1"
                />
                <Select
                  aria-label={`Question ${i + 1} type`}
                  value={q.kind}
                  onChange={(e) => update(i, { kind: e.target.value as SurveyQuestionKind })}
                >
                  {(Object.keys(questionKindLabels) as SurveyQuestionKind[]).map((k) => (
                    <option key={k} value={k}>{questionKindLabels[k]}</option>
                  ))}
                </Select>
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  <Checkbox checked={q.required} onChange={() => update(i, { required: !q.required })} />
                  Required
                </label>
                {questions.length > 1 && (
                  <IconButton
                    icon={Trash2}
                    label="Remove"
                    tone="danger"
                    onClick={() => setQuestions((prev) => prev.filter((_, j) => j !== i))}
                  />
                )}
              </div>
              {isChoice(q.kind) && (
                <Input
                  aria-label={`Question ${i + 1} options, separated by commas`}
                  value={q.options.join(", ")}
                  onChange={(e) => update(i, { options: e.target.value.split(",").map((o) => o.trim()).filter(Boolean) })}
                  placeholder="Options, separated by commas"
                />
              )}
            </div>
          ))}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setQuestions((prev) => [...prev, { kind: "SINGLE_CHOICE", prompt: "", helpText: "", required: true, options: [] }])}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add a question
          </Button>
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <Button
          disabled={pending || !title.trim()}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const result = await saveSurvey({
                kind, title, description, anonymous, mandatory, audience, status,
                expiresAt, targetUserIds, targetDepartmentIds,
                questions: questions.map((q) => ({ ...q, helpText: q.helpText || undefined })),
              });
              if (!result.ok) {
                setError(result.error);
                return;
              }
              router.refresh();
              onSaved?.();
            })
          }
        >
          {pending ? "Saving…" : status === "OPEN" ? "Publish and notify" : "Save as draft"}
        </Button>
      </CardContent>
    </Card>
  );
}
