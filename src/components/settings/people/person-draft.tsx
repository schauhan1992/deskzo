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

type Registry = {
  setCount: (id: string, count: number) => void;
  handlers: React.MutableRefObject<Record<string, Handlers>>;
};

// Two contexts: the registry never changes, so an editor registering (or its count changing) does not
// re-register every editor — only the header, which reads the counts, renders again.
const RegistryContext = createContext<Registry | null>(null);
const CountsContext = createContext<Record<string, number>>({});

export function PersonDraftProvider({ children }: { children: ReactNode }) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const handlers = useRef<Record<string, Handlers>>({});
  const setCount = useCallback((id: string, count: number) => setCounts((prev) => (prev[id] === count ? prev : { ...prev, [id]: count })), []);
  const registry = useMemo(() => ({ setCount, handlers }), [setCount]);
  return (
    <RegistryContext.Provider value={registry}>
      <CountsContext.Provider value={counts}>{children}</CountsContext.Provider>
    </RegistryContext.Provider>
  );
}

/** Registers an editor's unsaved changes with the page's "Save changes". */
export function useDraftEditor(id: string, count: number, handlers: Handlers) {
  const registry = useContext(RegistryContext);
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => {
    if (!registry) return;
    const ref = registry.handlers;
    ref.current[id] = {
      label: latest.current.label,
      save: (options) => latest.current.save(options),
      discard: () => latest.current.discard(),
    };
    return () => {
      delete ref.current[id];
      registry.setCount(id, 0);
    };
  }, [registry, id]);
  useEffect(() => {
    registry?.setCount(id, count);
  }, [registry, id, count]);
}

/** For the header: how many changes are waiting, and saving or dropping all of them. */
export function useDraft() {
  const registry = useContext(RegistryContext);
  const counts = useContext(CountsContext);
  const pending = Object.values(counts).reduce((a, b) => a + b, 0);
  const saveAll = async (options: SaveOptions): Promise<string | null> => {
    if (!registry) return null;
    for (const [id, h] of Object.entries(registry.handlers.current)) {
      if (!counts[id]) continue;
      const error = await h.save(options);
      if (error) return `Not saved (${h.label}): ${error}`;
    }
    return null;
  };
  const discardAll = () => {
    if (!registry) return;
    for (const h of Object.values(registry.handlers.current)) h.discard();
  };
  return { pending, saveAll, discardAll };
}
