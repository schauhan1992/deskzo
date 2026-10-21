"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Share, X } from "lucide-react";

/**
 * The workspace app on a phone's home screen (src/lib/pwa.ts): registers its service worker (public/sw.js)
 * on every signed-in page, and on an iPhone or iPad not yet using it from the home screen, says how to put it
 * there — Safari has no install button of its own to show. "Not now" is remembered on this device.
 */

const DISMISSED = "deskzo:install-app-hint";
const noSubscription = () => () => {};

/** "iPhone" or "iPad" when this is one, opened in its browser rather than from the home screen. */
function appleDeviceInBrowser(): "iPhone" | "iPad" | null {
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (standalone) return null;
  const agent = navigator.userAgent;
  if (/iPhone|iPod/.test(agent)) return "iPhone";
  // iPadOS asks for desktop pages, so it says "Macintosh" — told apart by its touch screen.
  if (/iPad/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)) return "iPad";
  return null;
}

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED) === "1";
  } catch {
    return false;
  }
}

export function InstallApp({ appName, hint }: { appName: string; hint: boolean }) {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => undefined);
  }, []);

  // A fact about this browser, never about the server's render: nothing until it hydrates.
  const device = useSyncExternalStore(noSubscription, () => (dismissed() ? null : appleDeviceInBrowser()), () => null);
  const [closed, setClosed] = useState(false);
  if (!hint || !device || closed) return null;

  function close() {
    try {
      localStorage.setItem(DISMISSED, "1");
    } catch {
      // Private browsing: it shows again next time, nothing worse.
    }
    setClosed(true);
  }

  return (
    <div className="my-4 flex items-start gap-3 rounded-base border border-info/30 bg-info-bg px-3 py-2 text-sm text-info md:my-6">
      <p className="min-w-0 flex-1">
        Use {appName} like an app on your {device}: tap Share{" "}
        <Share aria-label="(the square with an arrow)" className="inline h-4 w-4 align-text-bottom" />, then{" "}
        <span className="font-medium">Add to Home Screen</span>. It opens full screen, signed in.
      </p>
      <button type="button" onClick={close} className="shrink-0 rounded-sm p-0.5 hover:bg-info/10" aria-label="Not now">
        <X aria-hidden="true" className="h-4 w-4" />
      </button>
    </div>
  );
}
