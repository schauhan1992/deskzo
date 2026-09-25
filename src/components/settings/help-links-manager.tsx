"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { HelpLinkKind } from "@prisma/client";
import { EyeOff, FileText, MonitorPlay, Pencil, Plus, Trash2 } from "lucide-react";
import { deleteHelpLink, saveHelpLink, type HelpLinkView } from "@/actions/help";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

type ManagedLink = HelpLinkView & { active: boolean; sortOrder: number };

const KINDS: { kind: HelpLinkKind; label: string; noun: string; icon: typeof FileText; hint: string; placeholder: string }[] = [
  {
    kind: "ARTICLE",
    label: "Help articles",
    noun: "article",
    icon: FileText,
    hint: "How-tos and guides, wherever they're written — a wiki, a shared document, or a page in the app.",
    placeholder: "https://… or /orders/new",
  },
  {
    kind: "VIDEO",
    label: "Video walkthroughs",
    noun: "video",
    icon: MonitorPlay,
    hint: "Training recordings. YouTube links show a thumbnail; every video opens in a new tab.",
    placeholder: "https://www.youtube.com/watch?v=…",
  },
];

/** The articles and videos listed in the rail's Help and Videos panels. */
export function HelpLinksManager({ links }: { links: ManagedLink[] }) {
  return (
    <div className="space-y-4">
      {KINDS.map((k) => (
        <KindSection key={k.kind} spec={k} links={links.filter((l) => l.kind === k.kind)} />
      ))}
    </div>
  );
}

type Draft = { id?: string; title: string; url: string; description: string; sortOrder: string; active: boolean };
const EMPTY: Draft = { title: "", url: "", description: "", sortOrder: "", active: true };

function KindSection({ spec, links }: { spec: (typeof KINDS)[number]; links: ManagedLink[] }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const Icon = spec.icon;

  function save() {
    if (!draft) return;
    setNotice(null);
    startTransition(async () => {
      const r = await saveHelpLink({
        id: draft.id,
        kind: spec.kind,
        title: draft.title,
        url: draft.url,
        description: draft.description,
        active: draft.active,
        sortOrder: draft.sortOrder.trim() ? Number(draft.sortOrder) : 0,
      });
      if (!r.ok) {
        setNotice({ tone: "error", text: r.error });
        return;
      }
      setNotice({ tone: "success", text: draft.id ? "Saved." : `Added — it's in the rail now.` });
      setDraft(null);
      router.refresh();
    });
  }

  function remove(link: ManagedLink) {
    if (!window.confirm(`Remove “${link.title}” from the ${spec.label.toLowerCase()}?`)) return;
    setNotice(null);
    startTransition(async () => {
      const r = await deleteHelpLink(link.id);
      if (!r.ok) setNotice({ tone: "error", text: r.error });
      else router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-text">
            <Icon className="h-4 w-4 text-brand" aria-hidden="true" />
            {spec.label}
          </h2>
          <p className="mt-0.5 text-xs text-muted">{spec.hint}</p>
        </div>
        {!draft && (
          <Button size="sm" variant="secondary" onClick={() => setDraft(EMPTY)}>
            <Plus className="h-3.5 w-3.5" />
            Add {spec.noun}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {draft && (
          <div className="space-y-3 rounded-lg border border-line bg-surface-sunken p-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_6rem]">
              <div className="space-y-1">
                <Label htmlFor={`${spec.kind}-title`}>Title</Label>
                <Input id={`${spec.kind}-title`} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={120} autoFocus />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${spec.kind}-url`}>Link</Label>
                <Input id={`${spec.kind}-url`} value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder={spec.placeholder} maxLength={2000} />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${spec.kind}-order`}>Order</Label>
                <Input
                  id={`${spec.kind}-order`}
                  type="number"
                  min={0}
                  max={9999}
                  value={draft.sortOrder}
                  onChange={(e) => setDraft({ ...draft, sortOrder: e.target.value })}
                  placeholder="0"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${spec.kind}-description`}>One line about it (optional)</Label>
              <Textarea
                id={`${spec.kind}-description`}
                rows={2}
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                maxLength={300}
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-text">
              <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
              Show it in the rail
            </label>
            <div className="flex gap-2">
              <Button size="sm" onClick={save} disabled={pending}>
                {pending ? "Saving…" : draft.id ? "Save" : `Add ${spec.noun}`}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)} disabled={pending}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}

        {links.length === 0 ? (
          !draft && <p className="text-sm text-muted">None yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {links.map((link) => (
              <li key={link.id} className="flex items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-text">
                    <span className="truncate">{link.title}</span>
                    {!link.active && (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-sunken px-1.5 text-[11px] font-normal text-muted">
                        <EyeOff className="h-3 w-3" aria-hidden="true" />
                        Hidden
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-subtle">{link.url}</p>
                  {link.description && <p className="mt-0.5 text-xs text-muted">{link.description}</p>}
                </div>
                <span className="shrink-0 pt-0.5 text-xs text-subtle" title="Order">
                  #{link.sortOrder}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setDraft({
                      id: link.id,
                      title: link.title,
                      url: link.url,
                      description: link.description ?? "",
                      sortOrder: String(link.sortOrder),
                      active: link.active,
                    })
                  }
                  aria-label={`Edit ${link.title}`}
                  className="rounded-base p-1 text-muted hover:bg-surface-sunken hover:text-text"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => remove(link)}
                  disabled={pending}
                  aria-label={`Remove ${link.title}`}
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
  );
}
