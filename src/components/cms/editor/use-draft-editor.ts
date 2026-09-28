"use client";

import { useEffect, useEffectEvent, useMemo, useReducer, useRef, useState } from "react";
import type { CmsConflict, CmsIssue, CmsResult } from "@/lib/cms/types";

/**
 * The state machine under the page and post editors: the document, undo and redo, whether it differs
 * from what the server holds, saving (by hand, Ctrl/⌘+S, or on its own every 30 seconds while there
 * are unsaved changes — never publishing), the optimistic-concurrency conflict, and the server's issues.
 *
 *   · Typing into one field is one undo step, not one per key: changes with the same `key` within a
 *     second and a half are folded together.
 *   · "Unsaved" compares fingerprints (the caller's normalised JSON), so typing a letter and deleting
 *     it again is not a change.
 *   · A save while one is running is queued and runs after it with the newest document.
 *   · A conflict stops autosave until the person chooses: reload their version (theirs replaces the
 *     draft, and Undo brings yours back) or keep theirs and overwrite.
 */

export const AUTOSAVE_MS = 30_000;
const COALESCE_MS = 1_500;
const HISTORY_LIMIT = 100;

type History<D> = { past: D[]; present: D; future: D[]; key: string | null; at: number };
type Action<D> =
  | { type: "update"; fn: (doc: D) => D; key: string | null; at: number }
  | { type: "load"; doc: D }
  | { type: "undo" }
  | { type: "redo" };

function reducer<D>(state: History<D>, action: Action<D>): History<D> {
  switch (action.type) {
    case "update": {
      const next = action.fn(state.present);
      if (next === state.present) return state;
      const fold = action.key !== null && action.key === state.key && action.at - state.at < COALESCE_MS;
      if (fold) return { ...state, present: next, future: [], at: action.at };
      return { past: [...state.past, state.present].slice(-HISTORY_LIMIT), present: next, future: [], key: action.key, at: action.at };
    }
    case "load":
      return { past: [...state.past, state.present].slice(-HISTORY_LIMIT), present: action.doc, future: [], key: null, at: 0 };
    case "undo": {
      if (!state.past.length) return state;
      const previous = state.past[state.past.length - 1];
      return { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future], key: null, at: 0 };
    }
    case "redo": {
      if (!state.future.length) return state;
      const [next, ...rest] = state.future;
      return { past: [...state.past, state.present], present: next, future: rest, key: null, at: 0 };
    }
  }
}

export type SaveFailure = { error: string; issues?: CmsIssue[]; conflict?: CmsConflict };

export type DraftEditor<D> = {
  doc: D;
  update: (fn: (doc: D) => D, key?: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** The document differs from what the server last confirmed. */
  dirty: boolean;
  saving: boolean;
  version: string;
  lastSavedAt: Date | null;
  conflict: CmsConflict | null;
  /** The issues the server answered with, while the document is still the one they were about. */
  serverIssues: CmsIssue[];
  /** The last save's failure (not a conflict, not issues): a refusal or a lost connection. */
  failure: string | null;
  /** Saves now. Resolves true once the document on screen is saved. */
  save: (opts?: { force?: boolean }) => Promise<boolean>;
  /** The server has this document now (after a publish or a restore): no longer unsaved. */
  markSaved: (doc: D, version: string) => void;
  /** Replaces the document with one from the server (their version, a restored one), as saved. Undo brings back what was on screen. */
  load: (doc: D, version: string) => void;
  /** Replaces the document without saving (reset to the default): an ordinary, undoable change. */
  replace: (doc: D) => void;
  clearConflict: () => void;
  /** A publish answered with a conflict: the same choice as a save. */
  raiseConflict: (conflict: CmsConflict) => void;
  showServerIssues: (issues: CmsIssue[]) => void;
  /** For useAutosave. */
  autosaveState: { queued: boolean; attempts: number; takeQueued: () => void };
};

export function useDraftEditor<D, T extends { version: string }>({
  initial,
  initialVersion,
  initialSavedAt,
  fingerprint,
  canSave,
  send,
  onSaved,
}: {
  initial: D;
  initialVersion: string;
  initialSavedAt: Date | null;
  fingerprint: (doc: D) => string;
  canSave: boolean;
  send: (doc: D, version: string, force: boolean) => Promise<CmsResult<T>>;
  onSaved?: (data: T, doc: D) => void;
}): DraftEditor<D> {
  const [history, dispatch] = useReducer(reducer<D>, initial, (doc): History<D> => ({ past: [], present: doc, future: [], key: null, at: 0 }));
  const [version, setVersion] = useState(initialVersion);
  const [savedPrint, setSavedPrint] = useState(() => fingerprint(initial));
  const [saving, setSaving] = useState(false);
  const [queued, setQueued] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(initialSavedAt);
  const [conflict, setConflict] = useState<CmsConflict | null>(null);
  const [issues, setIssues] = useState<{ print: string; list: CmsIssue[] } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  // Two presses of Ctrl+S in one tick both see `saving` as false; this does not.
  const inFlight = useRef(false);

  const doc = history.present;
  const print = useMemo(() => fingerprint(doc), [fingerprint, doc]);
  const dirty = print !== savedPrint;
  const serverIssues = issues && issues.print === print ? issues.list : [];

  const save = async (opts: { force?: boolean } = {}): Promise<boolean> => {
    if (!canSave) return false;
    if (inFlight.current) {
      setQueued(true);
      return false;
    }
    if (!dirty && !opts.force) return true;
    const sent = doc;
    const sentPrint = print;
    inFlight.current = true;
    setSaving(true);
    setFailure(null);
    try {
      const result = await send(sent, version, !!opts.force);
      if (result.ok) {
        setVersion(result.data.version);
        setSavedPrint(sentPrint);
        setLastSavedAt(new Date());
        setConflict(null);
        setIssues(null);
        onSaved?.(result.data, sent);
        return true;
      }
      if (result.conflict) setConflict(result.conflict);
      else if (result.issues?.length) {
        setIssues({ print: sentPrint, list: result.issues });
        setFailure(result.error);
      } else setFailure(result.error);
      return false;
    } catch {
      setFailure("Couldn't reach the server. Your changes are still here — saving again shortly.");
      return false;
    } finally {
      inFlight.current = false;
      setSaving(false);
      setAttempts((n) => n + 1);
    }
  };

  return {
    doc,
    update: (fn, key) => dispatch({ type: "update", fn, key: key ?? null, at: Date.now() }),
    undo: () => dispatch({ type: "undo" }),
    redo: () => dispatch({ type: "redo" }),
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    dirty,
    saving,
    version,
    lastSavedAt,
    conflict,
    serverIssues,
    failure,
    save,
    markSaved: (savedDoc, nextVersion) => {
      setVersion(nextVersion);
      setSavedPrint(fingerprint(savedDoc));
      setLastSavedAt(new Date());
      setConflict(null);
      setIssues(null);
      setFailure(null);
    },
    load: (loaded, nextVersion) => {
      dispatch({ type: "load", doc: loaded });
      setVersion(nextVersion);
      setSavedPrint(fingerprint(loaded));
      setConflict(null);
      setIssues(null);
      setFailure(null);
    },
    replace: (next) => dispatch({ type: "load", doc: next }),
    clearConflict: () => setConflict(null),
    raiseConflict: (next) => setConflict(next),
    showServerIssues: (list) => setIssues({ print, list }),
    autosaveState: { queued, attempts, takeQueued: () => setQueued(false) },
  };
}

/**
 * Autosave: 30 seconds after the document first differs from the saved one (not restarted by every
 * keystroke, so steady typing still saves every 30 seconds), and at once for a save asked for while
 * another was running. Waits while the browser's own check finds something the server would refuse,
 * and during a conflict. Leaving the tab for another saves too.
 */
export function useAutosave<D>(editor: DraftEditor<D>, { enabled, blocked }: { enabled: boolean; blocked: boolean }) {
  const { dirty, saving, conflict } = editor;
  const { queued, attempts } = editor.autosaveState;
  const run = useEffectEvent(() => {
    editor.autosaveState.takeQueued();
    void editor.save();
  });
  useEffect(() => {
    if (saving || conflict || !dirty) return;
    if (!queued && (!enabled || blocked)) return;
    const timer = window.setTimeout(() => run(), queued ? 0 : AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [saving, conflict, dirty, queued, enabled, blocked, attempts]);

  const onHidden = useEffectEvent(() => {
    if (document.visibilityState === "hidden" && dirty && enabled && !blocked && !conflict && !saving) void editor.save();
  });
  useEffect(() => {
    const listener = () => onHidden();
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  }, []);
}

/** Warns before the tab is closed or reloaded with unsaved changes. */
export function useBeforeUnload(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers still want a string here before they show their own wording.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [active]);
}

/**
 * Stops in-app navigation (a click on any link in the CMS — the sidebar, a breadcrumb) while there
 * are unsaved changes, and hands the address to `onBlocked` so the editor can ask first.
 */
export function useLinkGuard(active: boolean, onBlocked: (href: string) => void) {
  const blocked = useEffectEvent(onBlocked);
  useEffect(() => {
    if (!active) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download") || anchor.dataset.leaveOk !== undefined) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      event.preventDefault();
      event.stopPropagation();
      blocked(`${url.pathname}${url.search}${url.hash}`);
    };
    // The capture phase on the window runs before Next's own link handling.
    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
  }, [active]);
}

/** Ctrl/⌘+S saves; Ctrl/⌘+Z and Shift+Ctrl/⌘+Z (or Ctrl+Y) undo and redo outside text fields, where the field's own undo is kept. */
export function useEditorKeys({ onSave, onUndo, onRedo }: { onSave: () => void; onUndo: () => void; onRedo: () => void }) {
  const handle = useEffectEvent((event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      onSave();
      return;
    }
    const target = event.target as HTMLElement | null;
    const typing = !!target?.closest?.("input, textarea, select, [contenteditable='true']");
    if (typing) return;
    if (key === "z" && !event.shiftKey) {
      event.preventDefault();
      onUndo();
    } else if ((key === "z" && event.shiftKey) || key === "y") {
      event.preventDefault();
      onRedo();
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => handle(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}
