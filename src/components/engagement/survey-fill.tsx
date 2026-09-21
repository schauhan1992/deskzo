"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Eye, EyeOff } from "lucide-react";
import type { SurveyQuestionKind } from "@prisma/client";
import { submitResponse } from "@/actions/survey";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/bulk-select";

type Question = {
  id: string;
  kind: SurveyQuestionKind;
  prompt: string;
  helpText: string | null;
  required: boolean;
  options: string[];
};

type Answer = { questionId: string; number?: number; text?: string; choices?: string[] };

/**
 * Filling one in.
 *
 * The banner stating whether this is anonymous or attributed is not decoration — it is the thing
 * that decides how frankly somebody answers, and showing the wrong one would be worse than showing
 * neither. It reads from the same flag the server enforces.
 */
export function SurveyFill({
  survey,
  onDone,
}: {
  survey: { id: string; title: string; description: string | null; anonymous: boolean; questions: Question[] };
  onDone?: () => void;
}) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  const set = (questionId: string, patch: Partial<Answer>) =>
    setAnswers((prev) => ({ ...prev, [questionId]: { ...prev[questionId], ...patch, questionId } }));

  if (done) {
    return (
      <Card>
        <CardContent className="space-y-3 py-10 text-center">
          <Check className="mx-auto h-8 w-8 text-success" />
          <p className="text-sm font-medium text-text">Thanks — that&apos;s in.</p>
          <p className="mx-auto max-w-sm text-sm text-muted">
            {survey.anonymous
              ? "Your answers were stored without any link to you. We know that you responded, not what you said."
              : "Your answers are recorded against your name, as this form said they would be."}
          </p>
          {onDone && <Button onClick={onDone}>Close</Button>}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">{survey.title}</CardHeader>
      <CardContent className="space-y-5">
        {survey.description && <p className="text-sm text-muted">{survey.description}</p>}

        <div
          className={`flex items-start gap-2.5 rounded-base p-3 text-xs leading-5 ${
            survey.anonymous ? "bg-success-bg text-success" : "bg-surface-sunken text-muted"
          }`}
        >
          {survey.anonymous ? <EyeOff className="mt-0.5 h-4 w-4 shrink-0" /> : <Eye className="mt-0.5 h-4 w-4 shrink-0" />}
          <p>
            {survey.anonymous ? (
              <>
                <span className="font-medium">This one is anonymous.</span> We record that you answered, so we
                know who still needs to — but your answers are stored with no link to you, and results stay
                hidden until at least five people have replied.
              </>
            ) : (
              <>
                <span className="font-medium">This one is attributed.</span> Your answers are recorded against
                your name and whoever set it up can see who said what.
              </>
            )}
          </p>
        </div>

        {survey.questions.map((q, i) => (
          <div key={q.id} className="space-y-2 border-t border-line pt-4 first:border-0 first:pt-0">
            <div>
              <Label>
                {i + 1}. {q.prompt}
                {!q.required && <span className="font-normal text-subtle"> (optional)</span>}
              </Label>
              {q.helpText && <p className="text-xs text-subtle">{q.helpText}</p>}
            </div>

            {(q.kind === "RATING" || q.kind === "SCALE_1_10") && (
              <div className="flex flex-wrap gap-1.5">
                {Array.from({ length: q.kind === "RATING" ? 5 : 10 }, (_, n) => n + 1).map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => set(q.id, { number: n })}
                    className={`h-9 w-9 rounded-base border text-sm ${
                      answers[q.id]?.number === n
                        ? "border-brand bg-brand text-white"
                        : "border-line text-muted hover:border-line-strong"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            )}

            {q.kind === "YES_NO" && (
              <div className="flex gap-2">
                {[["Yes", 1], ["No", 0]].map(([label, value]) => (
                  <button
                    key={String(label)}
                    type="button"
                    onClick={() => set(q.id, { number: value as number })}
                    className={`rounded-base border px-4 py-1.5 text-sm ${
                      answers[q.id]?.number === value
                        ? "border-brand bg-brand text-white"
                        : "border-line text-muted hover:border-line-strong"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            {q.kind === "SINGLE_CHOICE" && (
              <div className="space-y-1.5">
                {q.options.map((o) => (
                  <label key={o} className="flex items-center gap-2 text-sm text-text">
                    <input
                      type="radio"
                      name={q.id}
                      checked={answers[q.id]?.choices?.[0] === o}
                      onChange={() => set(q.id, { choices: [o] })}
                    />
                    {o}
                  </label>
                ))}
              </div>
            )}

            {q.kind === "MULTI_CHOICE" && (
              <div className="space-y-1.5">
                {q.options.map((o) => {
                  const chosen = answers[q.id]?.choices ?? [];
                  return (
                    <label key={o} className="flex items-center gap-2 text-sm text-text">
                      <Checkbox
                        checked={chosen.includes(o)}
                        onChange={() =>
                          set(q.id, { choices: chosen.includes(o) ? chosen.filter((c) => c !== o) : [...chosen, o] })
                        }
                      />
                      {o}
                    </label>
                  );
                })}
              </div>
            )}

            {q.kind === "TEXT" && (
              /*
               * `aria-label` rather than pointing the prompt above at this box: that same `<Label>`
               * captions all five question kinds, and four of them are groups of buttons or radios
               * with no single control to name — a htmlFor there would dangle on most questions.
               * The prompt is the wording a person would read out; the "1." is just position.
               */
              <Textarea
                aria-label={q.prompt}
                rows={3}
                value={answers[q.id]?.text ?? ""}
                onChange={(e) => set(q.id, { text: e.target.value })}
              />
            )}
          </div>
        ))}

        {error && <p className="text-sm text-danger">{error}</p>}

        <Button
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const result = await submitResponse({ surveyId: survey.id, answers: Object.values(answers) });
              if (!result.ok) {
                setError(result.error);
                return;
              }
              setDone(true);
              router.refresh();
            })
          }
        >
          {pending ? "Sending…" : "Submit"}
        </Button>
      </CardContent>
    </Card>
  );
}
