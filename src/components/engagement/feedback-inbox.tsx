"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import type { InternalFeedbackKind } from "@prisma/client";
import { reviewFeedback } from "@/actions/internal-feedback";
import { feedbackKindLabels } from "@/lib/engagement/anonymity";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";

type Item = {
  id: string;
  kind: InternalFeedbackKind;
  rating: number | null;
  body: string;
  submittedOn: string | Date;
  reviewedAt: string | Date | null;
  reviewNote: string | null;
  aboutUser: { id: string; name: string } | null;
  reviewedBy: { name: string } | null;
};

const kindTone: Record<InternalFeedbackKind, "green" | "amber" | "red" | "blue" | "default"> = {
  PRAISE: "green",
  CONCERN: "amber",
  SUGGESTION: "blue",
  GRIEVANCE: "red",
  OTHER: "default",
};

/**
 * What has come in through the anonymous channel.
 *
 * There is nothing on this screen identifying a sender because there is nothing in the database
 * identifying one. The note at the top says so to whoever is reading — an HR manager who assumes
 * they could find out if they really needed to will eventually ask somebody to try.
 */
export function FeedbackInbox({ items }: { items: Item[] }) {
  const unreviewed = items.filter((i) => !i.reviewedAt);

  return (
    <div className="space-y-4">
      <Card className="border-success/40 bg-success-bg">
        <CardContent className="flex items-start gap-2.5 py-3 text-sm text-success">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Nothing here can be traced to a sender, by you or by anyone. No name is stored, no time finer than
            the date, and nothing was written to the audit trail. If an item needs following up, it has to be
            done from what it says.
          </p>
        </CardContent>
      </Card>

      {items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted">Nothing has come in yet.</CardContent>
        </Card>
      ) : (
        <>
          <p className="text-sm text-muted">
            {unreviewed.length} waiting · {items.length} in total
          </p>
          {items.map((i) => (
            <Item key={i.id} item={i} />
          ))}
        </>
      )}
    </div>
  );
}

function Item({ item }: { item: Item }) {
  const router = useRouter();
  const [note, setNote] = useState(item.reviewNote ?? "");
  const [pending, startTransition] = useTransition();

  return (
    <Card className={item.reviewedAt ? "opacity-70" : ""}>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={kindTone[item.kind]}>{feedbackKindLabels[item.kind]}</Badge>
          {item.aboutUser && <span className="text-sm text-text">About {item.aboutUser.name}</span>}
          {item.rating !== null && (
            <span className="text-xs text-muted">{"★".repeat(item.rating)}{"☆".repeat(5 - item.rating)}</span>
          )}
          {/* A date, never a time — the same coarsening the storage applies. */}
          <span className="text-xs text-subtle">{formatDate(new Date(item.submittedOn))}</span>
          {item.reviewedAt && <Badge tone="default">Reviewed</Badge>}
        </div>

        <p className="whitespace-pre-wrap text-sm text-text">{item.body}</p>

        {item.reviewedAt ? (
          <p className="border-t border-line pt-2 text-xs text-subtle">
            {item.reviewedBy?.name} marked this reviewed{item.reviewNote ? ` — ${item.reviewNote}` : ""}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
            {/*
              One of these per item on a long page, so the name carries the kind to tell them apart.
              The kind is on the badge already and says nothing about who sent it — the only thing
              distinguishing these cards that it would be safe to speak.
            */}
            <Input
              aria-label={`What was done about this ${feedbackKindLabels[item.kind].toLowerCase()}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What was done about it (optional)"
              className="min-w-48 flex-1"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  await reviewFeedback(item.id, note);
                  router.refresh();
                })
              }
            >
              {pending ? "Saving…" : "Mark reviewed"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
