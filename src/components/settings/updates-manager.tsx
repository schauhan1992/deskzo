"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Pencil, Pin, Plus, Trash2 } from "lucide-react";
import { deleteUpdate, saveUpdate } from "@/actions/help";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { formatIstDateTime, istDateTimeInput } from "@/lib/india-time";

type Post = {
  id: string;
  title: string;
  body: string;
  linkUrl: string | null;
  pinned: boolean;
  publishedAt: string;
  scheduled: boolean;
  author: string | null;
};

type Draft = { id?: string; title: string; body: string; linkUrl: string; pinned: boolean; publishAt: string };
const EMPTY: Draft = { title: "", body: "", linkUrl: "", pinned: false, publishAt: "" };

/**
 * Writing What's new posts. A post goes out the moment it is saved unless given a later time, in
 * which case it waits — so an update can be written ahead of the release it describes.
 */
export function UpdatesManager({ posts }: { posts: Post[] }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    if (!draft) return;
    setNotice(null);
    startTransition(async () => {
      const r = await saveUpdate(draft);
      if (!r.ok) {
        setNotice({ tone: "error", text: r.error });
        return;
      }
      setNotice({
        tone: "success",
        text: draft.id ? "Saved." : draft.publishAt ? "Scheduled — it will appear at the time you chose." : "Posted — everybody will see a dot on What's new.",
      });
      setDraft(null);
      router.refresh();
    });
  }

  function remove(post: Post) {
    if (!window.confirm(`Remove “${post.title}”? It disappears from everybody's What's new.`)) return;
    setNotice(null);
    startTransition(async () => {
      const r = await deleteUpdate(post.id);
      if (!r.ok) setNotice({ tone: "error", text: r.error });
      else router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-text">{draft?.id ? "Edit update" : "New update"}</h2>
          {!draft && (
            <Button size="sm" onClick={() => setDraft(EMPTY)}>
              <Plus className="h-3.5 w-3.5" />
              Write an update
            </Button>
          )}
        </CardHeader>
        {draft && (
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="update-title">Title</Label>
              <Input
                id="update-title"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                placeholder="Renewal reminders now go out 90 days ahead"
                maxLength={120}
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="update-body">What&apos;s new</Label>
              <Textarea
                id="update-body"
                rows={5}
                value={draft.body}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                placeholder="What changed, who it affects, and anything they need to do."
                maxLength={4000}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="update-link">Read-more link (optional)</Label>
                <Input
                  id="update-link"
                  value={draft.linkUrl}
                  onChange={(e) => setDraft({ ...draft, linkUrl: e.target.value })}
                  placeholder="https://… or /renewals"
                  maxLength={2000}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="update-at">Publish at (India time)</Label>
                <Input id="update-at" type="datetime-local" value={draft.publishAt} onChange={(e) => setDraft({ ...draft, publishAt: e.target.value })} />
                <p className="text-xs text-subtle">{draft.id ? "Leave as it is to keep the original time." : "Leave empty to post it now."}</p>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-text">
              <input type="checkbox" checked={draft.pinned} onChange={(e) => setDraft({ ...draft, pinned: e.target.checked })} />
              Pin it to the top
            </label>
            <div className="flex gap-2">
              <Button onClick={save} disabled={pending}>
                {pending ? "Saving…" : draft.id ? "Save" : draft.publishAt ? "Schedule" : "Post now"}
              </Button>
              <Button variant="ghost" onClick={() => setDraft(null)} disabled={pending}>
                Cancel
              </Button>
            </div>
          </CardContent>
        )}
      </Card>

      {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-text">Posted</h2>
        </CardHeader>
        <CardContent className="p-0">
          {posts.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted">Nothing posted yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {posts.map((post) => (
                <li key={post.id} className="flex items-start gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-text">
                      {post.pinned && <Pin className="h-3.5 w-3.5 text-brand" aria-label="Pinned" />}
                      {post.title}
                      {post.scheduled && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-warning-bg px-1.5 text-[11px] font-normal text-warning">
                          <CalendarClock className="h-3 w-3" aria-hidden="true" />
                          Scheduled
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-subtle">
                      {post.scheduled ? "Goes out " : ""}
                      {formatIstDateTime(post.publishedAt)}
                      {post.author ? ` · ${post.author}` : ""}
                    </p>
                    <p className="mt-1 line-clamp-2 whitespace-pre-line text-xs text-muted">{post.body}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setDraft({
                        id: post.id,
                        title: post.title,
                        body: post.body,
                        linkUrl: post.linkUrl ?? "",
                        pinned: post.pinned,
                        publishAt: istDateTimeInput(post.publishedAt),
                      })
                    }
                    aria-label={`Edit ${post.title}`}
                    className="rounded-base p-1 text-muted hover:bg-surface-sunken hover:text-text"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(post)}
                    disabled={pending}
                    aria-label={`Remove ${post.title}`}
                    className="rounded-base p-1 text-muted hover:bg-danger-bg hover:text-danger"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
