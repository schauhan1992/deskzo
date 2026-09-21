"use client";

import { useState, useTransition } from "react";
import { Check, Eye, FileClock, Fingerprint, ShieldCheck, TriangleAlert } from "lucide-react";
import type { InternalFeedbackKind } from "@prisma/client";
import { submitAnonymousFeedback } from "@/actions/internal-feedback";
import { feedbackKindLabels, DAILY_FEEDBACK_LIMIT } from "@/lib/engagement/anonymity";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label, Select, Textarea } from "@/components/ui/input";

/**
 * The anonymous channel, and the page that explains why it can be trusted.
 *
 * The explanation is not marketing. Every claim on it corresponds to an assertion in
 * `check:engagement`, and the one thing the system *cannot* protect against — what somebody writes
 * — is stated as plainly as the things it can. A trust page that only lists reassurances is the
 * kind that stops being believed the first time somebody thinks about it properly.
 */
export function SpeakUpForm({
  people,
  remainingToday,
}: {
  people: { id: string; name: string }[];
  remainingToday: number;
}) {
  const [kind, setKind] = useState<InternalFeedbackKind>("SUGGESTION");
  const [aboutUserId, setAboutUserId] = useState("");
  const [rating, setRating] = useState("");
  const [body, setBody] = useState("");
  const [sent, setSent] = useState(false);
  const [left, setLeft] = useState(remainingToday);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (sent) {
    return (
      <Card>
        <CardContent className="space-y-3 py-10 text-center">
          <Check className="mx-auto h-8 w-8 text-success" />
          <p className="text-sm font-medium text-text">Sent.</p>
          <p className="mx-auto max-w-md text-sm text-muted">
            It has gone to HR and the directors. Nothing was recorded about who sent it, so nobody can come back
            to you about it — including us. If you want a reply, say so in the text and leave a way to reach you.
          </p>
          <Button variant="secondary" onClick={() => { setSent(false); setBody(""); setRating(""); setAboutUserId(""); }}>
            Send another
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
      <Card>
        <CardHeader className="text-sm font-medium text-text">Say something</CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="kind">What kind of thing</Label>
              <Select id="kind" value={kind} onChange={(e) => setKind(e.target.value as InternalFeedbackKind)}>
                {(Object.keys(feedbackKindLabels) as InternalFeedbackKind[]).map((k) => (
                  <option key={k} value={k}>{feedbackKindLabels[k]}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="about">About someone (optional)</Label>
              <Select id="about" value={aboutUserId} onChange={(e) => setAboutUserId(e.target.value)}>
                <option value="">About the company generally</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="rating">Rating (optional)</Label>
            <Select id="rating" value={rating} onChange={(e) => setRating(e.target.value)} className="max-w-48">
              <option value="">No rating</option>
              {[5, 4, 3, 2, 1].map((n) => (
                <option key={n} value={n}>{"★".repeat(n)}{"☆".repeat(5 - n)}</option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="body">What you want to say</Label>
            <Textarea
              id="body"
              rows={7}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Be as specific as you're comfortable being."
            />
            {/* The honest caveat, next to the box rather than in the small print. */}
            <p className="flex items-start gap-1.5 text-xs text-warning">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              We don&apos;t record who you are — but what you write still can. Describing something only two or
              three people witnessed will point at you however little we store.
            </p>
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={pending || body.trim().length < 10}
              onClick={() =>
                startTransition(async () => {
                  setError(null);
                  const result = await submitAnonymousFeedback({
                    kind,
                    aboutUserId: aboutUserId || undefined,
                    rating: rating ? Number(rating) : undefined,
                    body,
                  });
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  setLeft(result.data.remainingToday);
                  setSent(true);
                })
              }
            >
              {pending ? "Sending…" : "Send anonymously"}
            </Button>
            <span className="text-xs text-subtle">
              {left} of {DAILY_FEEDBACK_LIMIT} left today
            </span>
          </div>
        </CardContent>
      </Card>

      <TrustPanel />
    </div>
  );
}

/**
 * Why this can be trusted, in the terms somebody would actually want to check.
 *
 * Each of the first four claims is enforced by a named assertion in `check:engagement`. The fifth
 * is the limit, and it is given the same weight as the reassurances deliberately.
 */
function TrustPanel() {
  return (
    <Card className="h-fit">
      <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
        <ShieldCheck className="h-4 w-4 text-success" />
        How this stays anonymous
      </CardHeader>
      <CardContent className="space-y-3 text-xs leading-5">
        <Claim icon={Fingerprint} title="There is no column for your name">
          The table this is stored in has no field for who wrote an entry — not an empty one, none. There is
          nothing to fill in, accidentally or otherwise.
        </Claim>
        <Claim icon={FileClock} title="The time isn't kept, only the date">
          A timestamp to the second would line up with your login and your door swipe. Entries carry a date and
          nothing finer.
        </Claim>
        <Claim icon={Eye} title="Nothing is written to the audit trail">
          Every other action in this app records who did it. This one deliberately doesn&apos;t — an audit line
          next to a same-day entry would be as good as a signature.
        </Claim>
        <Claim icon={ShieldCheck} title="The daily limit can't be traced to your words">
          We count how many you&apos;ve sent today so nobody can flood the channel. That counter holds a number
          and a date, sits in a different table, and is never joined to what you wrote.
        </Claim>

        <div className="rounded-base bg-warning-bg p-3">
          <div className="flex items-center gap-1.5 font-medium text-warning">
            <TriangleAlert className="h-3.5 w-3.5" />
            What we can&apos;t protect
          </div>
          <p className="mt-1 text-warning">
            The words themselves. If you describe something only you and one other person saw, they will know.
            That isn&apos;t something any system can fix — it&apos;s worth a moment&apos;s thought before you
            send.
          </p>
        </div>

        <p className="text-subtle">
          Goes to HR, the directors and admins. The person an entry is about never sees it directly — HR decides
          what to raise and how.
        </p>
      </CardContent>
    </Card>
  );
}

function Claim({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof ShieldCheck;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-2.5">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
      <div>
        <div className="font-medium text-text">{title}</div>
        <p className="text-muted">{children}</p>
      </div>
    </div>
  );
}
