"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Archive, ArchiveRestore, CircleStop, Send } from "lucide-react";
import type { ConsoleResult } from "@/actions/platform/console";
import { consoleArchiveHelpItem, consolePublishHelpItem, consoleRestoreHelpItem, consoleUnpublishHelpItem } from "@/actions/platform/console-help";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { Button } from "@/components/ui/button";
import { plural, when } from "@/lib/console-shared/format";
import type { Caps } from "@/lib/console-shared/roles";
import type { PublicationState } from "@/lib/platform/help-content";
import { KIND_WORD, isEverywhere, tableOf, type HelpItemKind } from "./shared";

/**
 * The four things done to an item outside its editor — publish it now, take it down, archive it,
 * restore it — each a confirmation saying what changes and where (T1, or T3 with "publish" typed when
 * an admin puts something live in every workspace, which the server checks again). Used by the list's
 * ⋮ menu and by an item's own page.
 */

export type HelpVerb = "publish" | "unpublish" | "archive" | "restore";

/** What the dialog needs to know about the item. */
export type HelpVerbTarget = {
  id: string;
  kind: HelpItemKind;
  title: string;
  state: PublicationState;
  publishedAt: Date | null;
  modules: string[];
  countries: string[];
  /** Open workspaces it reaches now; null when not worked out. */
  reach: number | null;
};

/** Which verbs fit an item in this state. */
export function verbsFor(state: PublicationState): HelpVerb[] {
  switch (state) {
    case "draft":
      return ["publish", "archive"];
    case "scheduled":
      return ["publish", "unpublish", "archive"];
    case "live":
      return ["unpublish", "archive"];
    case "archived":
      return ["restore"];
  }
}

export const VERB_LABEL: Record<HelpVerb, string> = { publish: "Publish now…", unpublish: "Take down…", archive: "Archive…", restore: "Restore as draft…" };
const VERB_TITLE: Record<HelpVerb, string> = { publish: "Publish now", unpublish: "Take down", archive: "Archive", restore: "Restore as draft" };
const VERB_DONE: Record<HelpVerb, string> = { publish: "published", unpublish: "taken down", archive: "archived", restore: "restored as a draft" };

/** Who sees it: "every open workspace", "the 12 open workspaces it is for". */
function whereText(t: HelpVerbTarget): string {
  if (isEverywhere(t)) return "every workspace";
  return t.reach === null ? "the workspaces it is for" : `the ${plural(t.reach, "open workspace")} it is for`;
}

/** The consequence sentence for each confirmation — one line, as T1 asks. */
function consequence(verb: HelpVerb, t: HelpVerbTarget): string {
  const word = KIND_WORD[t.kind];
  const where = whereText(t);
  const servers = "Other servers pick it up within a minute.";
  switch (verb) {
    case "publish":
      return t.state === "scheduled" && t.publishedAt
        ? `It shows in ${where} now, instead of from ${when(t.publishedAt)} IST. ${servers}`
        : `The ${word} shows in ${where} from now on, under "From Deskzo". ${servers}`;
    case "unpublish":
      return t.state === "live" ? `It stops showing in ${where} and goes back to the drafts. ${servers}` : "It won't go live, and goes back to the drafts.";
    case "archive":
      return t.state === "live"
        ? `It stops showing in ${where} and moves to Archived, where it can't be edited — restore it as a draft to use it again. ${servers}`
        : t.state === "scheduled"
          ? "It won't go live, and moves to Archived, where it can't be edited — restore it as a draft to use it again."
          : "It moves to Archived, where it can't be edited — restore it as a draft to use it again.";
    case "restore":
      return t.kind === "POST"
        ? "It comes back as a draft. Nothing shows until it is published again."
        : `It comes back as a draft, at the end of the ${word}s. Nothing shows until it is published again.`;
  }
}

/** The dialog for one verb on one item; nothing while `pending` is null. */
export function HelpVerbDialog({ pending, caps, onClose }: { pending: { verb: HelpVerb; target: HelpVerbTarget } | null; caps: Caps; onClose: () => void }) {
  const action = useConsoleAction<unknown>();
  const verb = pending?.verb ?? "publish";
  const target = pending?.target ?? null;
  // An admin putting something live in every workspace types "publish"; an owner doesn't need to.
  const typed = verb === "publish" && target !== null && isEverywhere(target) && !caps.owner ? "publish" : undefined;

  function close() {
    action.reset();
    onClose();
  }

  function confirm({ typed: word }: { typed: string; reason: string }) {
    if (!pending) return;
    const { id, kind, title } = pending.target;
    const table = tableOf(kind);
    const run = (): Promise<ConsoleResult<unknown>> => {
      switch (pending.verb) {
        case "publish":
          return consolePublishHelpItem(table, id, typed ? { confirm: word } : undefined);
        case "unpublish":
          return consoleUnpublishHelpItem(table, id);
        case "archive":
          return consoleArchiveHelpItem(table, id);
        case "restore":
          return consoleRestoreHelpItem(table, id);
      }
    };
    action.run(run, { success: `“${title}” ${VERB_DONE[pending.verb]}.`, onDone: () => onClose() });
  }

  return (
    <ConfirmDialog
      open={pending !== null}
      onClose={close}
      title={VERB_TITLE[verb]}
      confirmLabel={VERB_TITLE[verb]}
      tone={(verb === "archive" || verb === "unpublish") && target?.state === "live" ? "danger" : "primary"}
      typed={typed}
      pending={action.pending}
      error={action.error}
      onConfirm={confirm}
    >
      {target && (
        <>
          <p className="font-medium break-words">{target.title}</p>
          <p className="text-muted">{consequence(verb, target)}</p>
          {typed && (
            <p className="text-xs text-muted">
              No module or country is chosen, so it shows in every workspace — that needs <span className="font-mono text-text">publish</span> typed below.
            </p>
          )}
        </>
      )}
    </ConfirmDialog>
  );
}

const VERB_ICON: Record<HelpVerb, ReactNode> = {
  publish: <Send aria-hidden="true" className="h-4 w-4" />,
  unpublish: <CircleStop aria-hidden="true" className="h-4 w-4" />,
  archive: <Archive aria-hidden="true" className="h-4 w-4" />,
  restore: <ArchiveRestore aria-hidden="true" className="h-4 w-4" />,
};

// ─── An item's page: its header and its editor ───────────────────────────────────────────────────

/**
 * Whether the editor on an item's page holds changes not yet saved. The header's verbs act on the
 * item as saved, and the page drawn again afterwards starts the editor over: "Publish now…" with an
 * edit pending would put the old text live and drop the edit without a word. So while the editor has
 * changes, the verbs wait for them to be saved or discarded.
 */
const UnsavedContext = createContext<{ unsaved: boolean; setUnsaved: (unsaved: boolean) => void } | null>(null);

/** Around an item's page — its header and its editor — so the one knows when the other has changes. */
export function HelpItemScope({ children }: { children: ReactNode }) {
  const [unsaved, setUnsaved] = useState(false);
  const value = useMemo(() => ({ unsaved, setUnsaved }), [unsaved]);
  return <UnsavedContext.Provider value={value}>{children}</UnsavedContext.Provider>;
}

/** The editor saying whether it holds unsaved changes. Outside an item's page nothing listens. */
export function useReportUnsaved(unsaved: boolean): void {
  const setUnsaved = useContext(UnsavedContext)?.setUnsaved;
  useEffect(() => {
    if (!setUnsaved) return;
    setUnsaved(unsaved);
    // An editor that has gone holds nothing: the page drawn again starts a new one from what was saved.
    return () => setUnsaved(false);
  }, [setUnsaved, unsaved]);
}

/**
 * An item's own page: its verbs as header buttons, sharing one dialog. Managers only — the page
 * doesn't draw it for anybody else. Held while the editor below has unsaved changes (`HelpItemScope`).
 */
export function HelpItemActions({ target, caps }: { target: HelpVerbTarget; caps: Caps }) {
  const [pending, setPending] = useState<{ verb: HelpVerb; target: HelpVerbTarget } | null>(null);
  const unsaved = useContext(UnsavedContext)?.unsaved ?? false;
  return (
    <>
      {unsaved && <span className="text-xs text-muted">Save or discard your changes first.</span>}
      {verbsFor(target.state).map((verb) => (
        <Button
          key={verb}
          type="button"
          size="sm"
          variant={verb === "archive" ? "ghost" : "secondary"}
          disabled={unsaved}
          onClick={() => setPending({ verb, target })}
        >
          {VERB_ICON[verb]}
          {VERB_LABEL[verb]}
        </Button>
      ))}
      <HelpVerbDialog pending={pending} caps={caps} onClose={() => setPending(null)} />
    </>
  );
}
