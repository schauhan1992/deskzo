"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getSurveyToFill, skipSplash } from "@/actions/survey";
import { SurveyFill } from "@/components/engagement/survey-fill";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type Pending = { id: string; title: string; description: string | null; anonymous: boolean };
type Loaded = Parameters<typeof SurveyFill>[0]["survey"];

/**
 * The blocking screen for a form somebody must fill in.
 *
 * It can be pushed away once. The skip is held in this component and recorded on the server so the
 * nag is honest about having been dismissed — and it returns on their next sign-in, because a
 * dismissal that sticks forever is not a requirement, it is a suggestion.
 *
 * Deliberately not a hard block. Trapping somebody who needs to get into the app right now produces
 * a form answered under duress, which is data nobody should act on.
 */
export function SurveySplash({ pending }: { pending: Pending }) {
  const router = useRouter();
  const [dismissed, setDismissed] = useState(false);
  const [survey, setSurvey] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);

  if (dismissed) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl py-8">
        {survey ? (
          <SurveyFill
            survey={survey}
            onDone={() => {
              setDismissed(true);
              router.refresh();
            }}
          />
        ) : (
          <Card>
            <CardContent className="space-y-4 py-8 text-center">
              <div>
                <h2 className="text-lg font-semibold text-text">{pending.title}</h2>
                {pending.description && (
                  <p className="mx-auto mt-1 max-w-md text-sm text-muted">{pending.description}</p>
                )}
              </div>
              <p className="mx-auto max-w-md text-sm text-muted">
                {pending.anonymous
                  ? "This one's anonymous — we'll know that you answered, never what you said."
                  : "Your answers on this one are recorded against your name."}
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button
                  disabled={loading}
                  onClick={async () => {
                    setLoading(true);
                    setSurvey(await getSurveyToFill(pending.id));
                    setLoading(false);
                  }}
                >
                  {loading ? "Opening…" : "Fill it in"}
                </Button>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    await skipSplash(pending.id);
                    setDismissed(true);
                  }}
                >
                  Not now
                </Button>
              </div>
              <p className="text-xs text-subtle">&quot;Not now&quot; works once — it&apos;ll be back next time you sign in.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
