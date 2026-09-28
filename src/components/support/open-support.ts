/**
 * Asking the Contact Support dialog to open, from anywhere on the page.
 *
 * The dialog lives once, in the dashboard layout (src/components/support/support-launcher.tsx); its
 * entry point lives in the sidebar, which the layout renders twice (the rail and the phone drawer).
 * An event joins them without the sidebar importing the dialog — and the dialog hands the focus back
 * to whichever button opened it, because it remembers what had the focus when it opened.
 *
 * Kept tiny and free of imports on purpose: the sidebar loads it on every page.
 */
export const OPEN_SUPPORT_EVENT = "wroffy:open-support";

export function openSupport() {
  window.dispatchEvent(new Event(OPEN_SUPPORT_EVENT));
}
