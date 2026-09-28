"use client";

import { Dialog } from "@/components/ui/dialog";
import { PARTNER_PAGES, type PartnerPageKey } from "@/lib/partners/nav";

/** `g` then this letter goes to the page (the registry has no shortcuts of its own; they live with the shell that listens for them). */
export const PARTNER_SHORTCUTS: Partial<Record<PartnerPageKey, string>> = {
  dashboard: "d",
  customers: "c",
  invitations: "i",
  deals: "r",
  commissions: "m",
  statements: "s",
  resellers: "e",
  profile: "p",
  team: "t",
  activity: "a",
};

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((key, i) => (
        <span key={`${i}-${key}`} className="flex items-center gap-1">
          {i > 0 && <span className="text-[11px] text-subtle">then</span>}
          <kbd className="min-w-6 rounded border border-line bg-surface-sunken px-1.5 text-center font-mono text-[11px] leading-5 text-text">{key}</kbd>
        </span>
      ))}
    </span>
  );
}

/**
 * The portal's keyboard shortcuts, for the pages this user may open: `g` then a letter goes to a page,
 * `?` opens this sheet. None of them fires while typing in a field.
 */
export function PartnerShortcutsDialog({ open, onClose, visibleKeys }: { open: boolean; onClose: () => void; visibleKeys: PartnerPageKey[] }) {
  const pages = PARTNER_PAGES.filter((p) => PARTNER_SHORTCUTS[p.key] && visibleKeys.includes(p.key));
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts">
      <div className="space-y-5 p-0.5">
        <section>
          <h3 className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase">Go to</h3>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {pages.map((page) => (
              <li key={page.key} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block text-text">{page.label}</span>
                  <span className="block truncate text-xs text-muted">{page.description}</span>
                </span>
                <Keys keys={["g", PARTNER_SHORTCUTS[page.key]!]} />
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase">Anywhere</h3>
          <ul className="divide-y divide-line rounded-lg border border-line">
            <li className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="text-text">This list</span>
              <Keys keys={["?"]} />
            </li>
            <li className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="text-text">Close a dialog or menu</span>
              <Keys keys={["Esc"]} />
            </li>
          </ul>
          <p className="mt-2 text-xs text-muted">Shortcuts wait while you are typing in a field.</p>
        </section>
      </div>
    </Dialog>
  );
}
