import type { ReactNode } from "react";

/**
 * One panel of a `ConsoleTabs` set. Every panel is rendered, the inactive ones `hidden` — so a tab
 * switch needs no request, and text in any tab is in the page's first markup. Focusable, so Tab
 * from the tab list lands in the panel even when it starts with plain text.
 */
export function TabPanel({ idPrefix, tabKey, active, children }: { idPrefix: string; tabKey: string; active: boolean; children: ReactNode }) {
  return (
    <section
      role="tabpanel"
      id={`${idPrefix}-panel-${tabKey}`}
      aria-labelledby={`${idPrefix}-tab-${tabKey}`}
      hidden={!active}
      tabIndex={0}
      className="space-y-6 rounded-base"
    >
      {children}
    </section>
  );
}
