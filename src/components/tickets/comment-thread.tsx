"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addTicketComment } from "@/actions/ticket";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";

type Comment = {
  id: string;
  body: string;
  createdAt: string | Date;
  user: { id: string; name: string };
};

export function CommentThread({ ticketId, comments }: { ticketId: string; comments: Comment[] }) {
  const router = useRouter();
  const clock = useClock();
  const [body, setBody] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await addTicketComment({ ticketId, body });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setBody("");
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {comments.map((c) => (
          <div key={c.id} className="rounded-md border border-line p-3">
            <div className="flex items-center justify-between text-xs text-muted">
              <span className="font-medium text-text">{c.user.name}</span>
              <span>{clock.date(c.createdAt)}</span>
            </div>
            <p className="mt-1.5 whitespace-pre-wrap text-sm text-text">{c.body}</p>
          </div>
        ))}
        {comments.length === 0 && <p className="text-sm text-subtle">No comments yet.</p>}
      </div>

      <form onSubmit={handleSubmit} className="space-y-2 border-t border-line pt-4">
        {error && <p className="text-xs text-danger">{error}</p>}
        <Textarea
          aria-label="Add a comment"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add a comment…"
          className="min-h-20"
          required
        />
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={isPending}>
            {isPending ? "Posting…" : "Post comment"}
          </Button>
        </div>
      </form>
    </div>
  );
}
