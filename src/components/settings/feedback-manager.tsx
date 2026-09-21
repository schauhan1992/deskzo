"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Info } from "lucide-react";
import type { Organisation } from "@/lib/organisation";
import { updateFeedbackSettings } from "@/actions/organisation";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { MAX_RATING, MIN_RATING, ratingLabels, thresholdNote } from "@/lib/feedback/rating";

/**
 * Where a happy customer is sent, and when.
 *
 * The threshold carries a warning rather than being quietly accepted, because it is the one setting
 * in the app with somebody else's policy attached to it — and whoever changes it should know that
 * before they do, not after a review disappears.
 */
export function FeedbackManager({ organisation }: { organisation: Organisation }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [form, setForm] = useState({
    feedbackReviewUrl: organisation.feedbackReviewUrl ?? "",
    feedbackReviewMinRating: String(organisation.feedbackReviewMinRating),
    feedbackLinkDays: String(organisation.feedbackLinkDays),
    feedbackIntro: organisation.feedbackIntro ?? "",
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };

  const note = thresholdNote(Number(form.feedbackReviewMinRating));
  const thresholds = Array.from({ length: MAX_RATING - MIN_RATING + 1 }, (_, i) => MIN_RATING + i);

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Customer feedback</CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted">
          Feedback links are one-time and expire. Every answer is stored here whatever the score — this only decides
          whether the customer is also offered your public review page afterwards.
        </p>

        <div className="space-y-1.5">
          <Label htmlFor="reviewUrl">Public review page</Label>
          <Input
            id="reviewUrl"
            value={form.feedbackReviewUrl}
            onChange={set("feedbackReviewUrl")}
            placeholder="https://g.page/r/…/review"
            className="font-mono text-xs"
          />
          <p className="text-xs text-subtle">
            Your Google Business Profile review link — in Google Business Profile, &ldquo;Ask for reviews&rdquo; gives
            you a short link ending in <span className="font-mono">/review</span>. Leave it blank and nobody is sent
            anywhere; the feedback is still recorded.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="minRating">Offer it from</Label>
            <Select id="minRating" value={form.feedbackReviewMinRating} onChange={set("feedbackReviewMinRating")}>
              {thresholds.map((n) => (
                <option key={n} value={n}>
                  {n === MIN_RATING ? "Everybody, whatever they rate" : `${n} stars and above — ${ratingLabels[n]}`}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="linkDays">A link lasts</Label>
            <Input
              id="linkDays"
              type="number"
              min={1}
              max={365}
              value={form.feedbackLinkDays}
              onChange={set("feedbackLinkDays")}
            />
            <p className="text-xs text-subtle">
              Days. Feedback on work done three months ago isn&apos;t feedback, and a link that never expires is a
              link that leaks.
            </p>
          </div>
        </div>

        <Card
          className={
            note.tone === "amber"
              ? "border-warning/40 bg-warning-bg px-3 py-2.5 text-xs text-warning"
              : "border-info/40 bg-info-bg px-3 py-2.5 text-xs text-info"
          }
        >
          <span className="flex items-start gap-1.5">
            {note.tone === "amber" ? (
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <span>{note.text}</span>
          </span>
        </Card>

        <div className="space-y-1.5">
          <Label htmlFor="intro">What the form says at the top</Label>
          <Textarea
            id="intro"
            rows={2}
            value={form.feedbackIntro}
            onChange={set("feedbackIntro")}
            placeholder="We'd like to know how we did. It takes about a minute…"
          />
          <p className="text-xs text-subtle">
            Written for the customer, not for us. Leave it blank for the default.
          </p>
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex items-center gap-3">
          <Button
            disabled={pending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await updateFeedbackSettings({
                  feedbackReviewUrl: form.feedbackReviewUrl,
                  feedbackReviewMinRating: Number(form.feedbackReviewMinRating),
                  feedbackLinkDays: Number(form.feedbackLinkDays),
                  feedbackIntro: form.feedbackIntro,
                });
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                setSaved(true);
                router.refresh();
              });
            }}
          >
            {pending ? "Saving…" : "Save"}
          </Button>
          {saved && <span className="text-xs text-success">Saved.</span>}
        </div>
      </CardContent>
    </Card>
  );
}
