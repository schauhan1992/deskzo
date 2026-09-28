"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { ActionNoticeRegion, type NoticeTone } from "@/components/ui/action-notice";

export type { NoticeTone };

type Notice = { tone: NoticeTone; message: string };
type ConsoleNotice = { notice: Notice | null; show(tone: NoticeTone, message: string): void; clear(): void };

/**
 * Page-level outcomes ("Workspace reopened.") — one region under the page header, fed from anywhere
 * on the page, cleared on navigation. No toasts: a message that slides away on a timer is gone
 * before anyone who looked away has read it.
 *
 * Without a provider (a page rendered on its own, as the check suites do) the context is a working
 * no-op, so nothing that calls `show` needs the shell to render.
 */
const NoticeContext = createContext<ConsoleNotice>({ notice: null, show: () => {}, clear: () => {} });

export function NoticeProvider({ children, resetKey }: { children: ReactNode; resetKey?: string }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [seenKey, setSeenKey] = useState(resetKey);
  // A new page (the shell passes the pathname) starts without the last page's outcome — adjusted
  // during render rather than in an effect, so the stale notice never paints on the new page.
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setNotice(null);
  }

  const last = useRef<Notice | null>(null);
  const repeat = useRef<number | undefined>(undefined);

  const show = useCallback((tone: NoticeTone, message: string) => {
    window.clearTimeout(repeat.current);
    const next = { tone, message };
    const same = last.current?.tone === tone && last.current.message === message;
    last.current = next;
    if (!same) {
      setNotice(next);
      return;
    }
    // The same words twice ("Saved." after a second save) change nothing in the live region, so a
    // screen reader would stay silent. Empty it for a moment and it is announced again.
    setNotice(null);
    repeat.current = window.setTimeout(() => setNotice(next), 80);
  }, []);

  const clear = useCallback(() => {
    window.clearTimeout(repeat.current);
    last.current = null;
    setNotice(null);
  }, []);

  const value = useMemo(() => ({ notice, show, clear }), [notice, show, clear]);
  return <NoticeContext.Provider value={value}>{children}</NoticeContext.Provider>;
}

export function useConsoleNotice(): ConsoleNotice {
  return useContext(NoticeContext);
}

/** The region itself — always mounted, so a message that appears in it is announced. */
export function PageNotice() {
  const { notice } = useConsoleNotice();
  return <ActionNoticeRegion notice={notice} className="[&:not(:empty)]:mt-3" />;
}
