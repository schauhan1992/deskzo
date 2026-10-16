"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * Unsaved changes on one person's page, saved together by "Save changes" at the top.
 *
 * Each editor on the page (the module's actions, field masking, the daily limit) registers how many
 * changes it holds and how to save or drop them; the header adds them up, asks once for a reason and
 * an end date, and saves each in turn — every one through its own action, with its own checks.
 */

export type SaveOptions = { reason?: string; expiresAt?: string | null };
type Handlers = { save: (options: SaveOptions) => Promise<string | null>; discard: () => void; label: string };

type Draft = {
  counts: Record<string, number>;
  setCount: (id: string, count: number) => void;
  handlers: React.MutableRefObject<Record<string, Handlers>>;
};

const DraftContext = createContext<Draft | null>(null);

export function PersonDraftProvider({ children }: { children: ReactNode }) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const handlers = useRef<Record<string, Handlers>>({});
  const setCount = useCallback((id: string, count: number) => setCounts((prev) => (prev[id] === count ? prev : { ...prev, [id]: count })), []);
  const value = useMemo(() => ({ counts, setCount, handlers }), [counts, setCount]);
  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}

/** Registers an editor's unsaved changes with the page's "Save changes". */
export function useDraftEditor(id: string, count: number, handlers: Handlers) {
  const draft = useContext(DraftContext);
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => {
    if (!draft) return;
    const ref = draft.handlers;
    ref.current[id] = {
      label: latest.current.label,
      save: (options) => latest.current.save(options),
      discard: () => latest.current.discard(),
    };
    return () => {
      delete ref.current[id];
      draft.setCount(id, 0);
    };
  }, [draft, id]);
  useEffect(() => {
    draft?.setCount(id, count);
  }, [draft, id, count]);
}

/** For the header: how many changes are waiting, and saving or dropping all of them. */
export function useDraft() {
  const draft = useContext(DraftContext);
  const pending = draft ? Object.values(draft.counts).reduce((a, b) => a + b, 0) : 0;
  const saveAll = async (options: SaveOptions): Promise<string | null> => {
    if (!draft) return null;
    for (const [id, h] of Object.entries(draft.handlers.current)) {
      if (!draft.counts[id]) continue;
      const error = await h.save(options);
      if (error) return error;
    }
    return null;
  };
  const discardAll = () => {
    if (!draft) return;
    for (const h of Object.values(draft.handlers.current)) h.discard();
  };
  return { pending, saveAll, discardAll };
}
