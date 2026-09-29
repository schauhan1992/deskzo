"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cmsSeoEditorContext } from "@/actions/cms/seo";
import type { SeoEditorContext } from "@/lib/cms/types";
import { scoreEntity, type EntityScore, type SeoInput } from "@/lib/seo";

/**
 * Live scoring in an editor. The site around the entity is loaded once, when the editor opens
 * (`cmsSeoEditorContext`); from then on every score is worked out in the browser by the pure engine
 * (src/lib/seo), from the draft as it is typed — settled for about 300 ms first, so a burst of
 * keystrokes is scored once. Nothing is sent anywhere while typing.
 */

export type SeoEditorKind = "page" | "post" | "category" | "tag";

export type LiveSeo = {
  context: SeoEditorContext | null;
  /** The draft's score, once the context is in; null before then. */
  score: EntityScore | null;
  input: SeoInput | null;
  /** The context is on its way. */
  loading: boolean;
  /** Why there are no scores, in words. */
  error: string | null;
  /** Typing has moved on since the score shown was worked out. */
  pending: boolean;
};

type Loaded = { key: string; context: SeoEditorContext | null; error: string | null };

const NOT_LOADED = "The scores didn't load. Reload the page to try again — editing and saving work as usual.";

/**
 * The site around one entity, fetched when the editor opens — and again when `refresh` changes (a
 * publish: the dashboard's number for the site's version moved), keeping the one it has meanwhile. A
 * null id (something not saved yet) fetches nothing.
 */
export function useSeoEditorContext(kind: SeoEditorKind, id: string | null, refresh: string | number = 0): { context: SeoEditorContext | null; loading: boolean; error: string | null } {
  const key = `${kind}:${id ?? ""}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    cmsSeoEditorContext(kind, id).then(
      (result) => {
        if (live) setLoaded({ key, context: result.ok ? result.data : null, error: result.ok ? null : result.error || NOT_LOADED });
      },
      () => {
        if (live) setLoaded({ key, context: null, error: NOT_LOADED });
      },
    );
    return () => {
      live = false;
    };
  }, [kind, id, key, refresh]);
  const current = loaded?.key === key ? loaded : null;
  return { context: current?.context ?? null, loading: !!id && !current, error: current?.error ?? null };
}

/**
 * Scores `source` with `build` (a module-level function: its identity must not change) against the
 * context, `delay` (300 ms) after the last change — at once for the first score, and for a fresh context.
 */
export function useLiveSeo<S>(
  kind: SeoEditorKind,
  id: string | null,
  source: S,
  build: (source: S, ctx: SeoEditorContext, now: Date) => SeoInput,
  { delay = 300, refresh = 0 }: { delay?: number; refresh?: string | number } = {},
): LiveSeo {
  const { context, loading, error } = useSeoEditorContext(kind, id, refresh);
  const [settled, setSettled] = useState<{ source: S; context: SeoEditorContext; now: Date } | null>(null);
  const primed = useRef<SeoEditorContext | null>(null);

  useEffect(() => {
    if (!context) return;
    // The first score as soon as the context arrives; after that, once typing pauses.
    const wait = primed.current === context ? delay : 0;
    primed.current = context;
    const timer = window.setTimeout(() => setSettled({ source, context, now: new Date() }), wait);
    return () => window.clearTimeout(timer);
  }, [source, context, delay]);

  const scored = useMemo(() => {
    if (!settled) return { input: null, score: null, error: null };
    try {
      const input = build(settled.source, settled.context, settled.now);
      return { input, score: scoreEntity(input), error: null };
    } catch {
      return { input: null, score: null, error: "This draft couldn't be scored. Saving it still works; the dashboard scores it once it is saved." };
    }
  }, [settled, build]);

  return {
    context,
    score: scored.score,
    input: scored.input,
    loading,
    error: error ?? scored.error,
    pending: !!context && (!settled || settled.source !== source || settled.context !== context),
  };
}
