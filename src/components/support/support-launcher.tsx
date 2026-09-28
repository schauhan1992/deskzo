"use client";

import { useEffect, useState } from "react";
import { SupportDialog } from "@/components/support/support-dialog";
import { OPEN_SUPPORT_EVENT } from "@/components/support/open-support";
import type { LauncherState } from "@/lib/support/types";

/**
 * The Contact Support dialog's home (src/components/support/support-dialog.tsx), mounted once by the
 * dashboard layout. Its button is "Contact Support" at the foot of the sidebar, which asks for it
 * through `openSupport()` (src/components/support/open-support.ts) — the owner's choice over a button
 * floating in the page's corner, where it covered whatever a page had there.
 *
 * Whether it exists at all is the server's decision: the layout renders this, and tells the sidebar to
 * show the button, only when `supportLauncherState()` returns a state — not for a view-as, platform
 * support staff, or while support is switched off (src/actions/support.ts). Nothing here
 * second-guesses that.
 *
 * Mounted for the whole visit rather than on demand: the draft, the uploads and a recording in
 * progress live in the dialog, and must survive it being closed and opened again.
 */
export function SupportLauncher({ state }: { state: LauncherState }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_SUPPORT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SUPPORT_EVENT, onOpen);
  }, []);

  return <SupportDialog state={state} open={open} onClose={() => setOpen(false)} />;
}
