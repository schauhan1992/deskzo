"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { reportDlpEvent, reportScreenshot } from "@/actions/dlp";

/**
 * The browser half of the DLP policy.
 *
 * ## What this can and cannot do
 *
 * Everything here runs in the user's browser, which means everything here can be switched off by
 * the user's browser. Devtools removes the listeners; disabling JavaScript removes the whole file;
 * a phone camera never touched it in the first place. Anybody telling you otherwise is selling
 * something.
 *
 * What it genuinely achieves is narrower and still worth having:
 *
 *   1. **It stops the careless leak.** Most data that walks out of a company does so because
 *      copying a table into WhatsApp was the path of least resistance, not because anybody meant
 *      harm. Removing the easy path removes most of the volume.
 *   2. **It creates a record.** Every refusal is reported, so "who was trying to take this out"
 *      has an answer afterwards. That is what makes the determined case actionable.
 *   3. **It makes the policy visible.** Somebody who is told, on screen, that copying is disabled
 *      and screenshots are counted behaves differently from somebody who is not.
 *
 * The controls that hold regardless of the browser are elsewhere: the crawler block in
 * `src/proxy.ts`, the export cap, and the read-volume check in `src/lib/security/bulk-read.ts`.
 */

export type DlpPolicyProps = {
  blockCopy: boolean;
  blockCut: boolean;
  blockPaste: boolean;
  blockContextMenu: boolean;
  blockTextSelection: boolean;
  blockPrint: boolean;
  blockDevTools: boolean;
  blurOnBlur: boolean;
  screenshotLimitPerDay: number;
};

/** Typing into a field is not exfiltration, and treating it as such makes the app unusable. */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

export function DlpGuard({ policy }: { policy: DlpPolicyProps }) {
  const pathname = usePathname();
  const [notice, setNotice] = useState<{ text: string; tone: "warn" | "block" } | null>(null);
  const [screenshotWall, setScreenshotWall] = useState<string | null>(null);
  const [obscured, setObscured] = useState(false);

  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Held in a ref so the listeners below do not need re-binding on every navigation — they are
  // attached once and read the current path when something fires. Written in an effect rather than
  // during render: a ref assignment in the render body is a side effect, and the React compiler
  // rejects it for good reason — with concurrent rendering the assignment can happen for a render
  // that is then thrown away.
  const pathRef = useRef(pathname);
  useEffect(() => {
    pathRef.current = pathname;
  }, [pathname]);

  const say = useCallback((text: string, tone: "warn" | "block" = "warn") => {
    setNotice({ text, tone });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  useEffect(() => () => void (noticeTimer.current && clearTimeout(noticeTimer.current)), []);

  // --- Clipboard ------------------------------------------------------------------------------
  useEffect(() => {
    if (!policy.blockCopy && !policy.blockCut && !policy.blockPaste) return;

    const onClipboard = (event: ClipboardEvent) => {
      const type = event.type as "copy" | "cut" | "paste";
      const blocked =
        (type === "copy" && policy.blockCopy) ||
        (type === "cut" && policy.blockCut) ||
        (type === "paste" && policy.blockPaste);
      if (!blocked) return;

      // A paste into a field the user is filling in brings data *in*, which is not the leak this
      // is aimed at — and refusing it means nobody can paste an order number into a search box.
      // Copying out of a field is still a copy, so only paste gets the exemption.
      if (type === "paste" && isEditable(event.target)) return;

      event.preventDefault();
      const kind = type === "copy" ? "COPY_BLOCKED" : type === "cut" ? "CUT_BLOCKED" : "PASTE_BLOCKED";
      say(
        type === "paste"
          ? "Pasting is turned off by your organisation's policy."
          : "Copying is turned off by your organisation's policy. The attempt has been logged.",
      );
      void reportDlpEvent({ kind, path: pathRef.current });
    };

    document.addEventListener("copy", onClipboard, true);
    document.addEventListener("cut", onClipboard, true);
    document.addEventListener("paste", onClipboard, true);
    return () => {
      document.removeEventListener("copy", onClipboard, true);
      document.removeEventListener("cut", onClipboard, true);
      document.removeEventListener("paste", onClipboard, true);
    };
  }, [policy.blockCopy, policy.blockCut, policy.blockPaste, say]);

  // --- Right-click ----------------------------------------------------------------------------
  useEffect(() => {
    if (!policy.blockContextMenu) return;
    const onMenu = (event: MouseEvent) => {
      // Still available inside a field, where the menu is spell-check and undo rather than
      // "save image as" — taking it away there is pure friction with no security gain.
      if (isEditable(event.target)) return;
      event.preventDefault();
      say("The right-click menu is turned off by your organisation's policy.");
      void reportDlpEvent({ kind: "CONTEXT_MENU_BLOCKED", path: pathRef.current });
    };
    document.addEventListener("contextmenu", onMenu);
    return () => document.removeEventListener("contextmenu", onMenu);
  }, [policy.blockContextMenu, say]);

  // --- Selection ------------------------------------------------------------------------------
  useEffect(() => {
    if (!policy.blockTextSelection) return;
    // A class on <html> rather than inline styles, so the rule can carve out inputs in CSS — a
    // blanket `user-select: none` also stops somebody selecting the text they are editing.
    document.documentElement.classList.add("dlp-no-select");
    return () => document.documentElement.classList.remove("dlp-no-select");
  }, [policy.blockTextSelection]);

  // --- Printing -------------------------------------------------------------------------------
  useEffect(() => {
    if (!policy.blockPrint) return;

    // Two listeners because they catch different things: the shortcut, and everything else —
    // the browser menu, the OS print dialog, a print triggered by script.
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        say("Printing is turned off by your organisation's policy.", "block");
        void reportDlpEvent({ kind: "PRINT_BLOCKED", path: pathRef.current });
      }
    };
    const onBeforePrint = () => {
      setObscured(true);
      void reportDlpEvent({ kind: "PRINT_BLOCKED", path: pathRef.current });
    };
    const onAfterPrint = () => setObscured(false);

    document.addEventListener("keydown", onKey, true);
    window.addEventListener("beforeprint", onBeforePrint);
    window.addEventListener("afterprint", onAfterPrint);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("beforeprint", onBeforePrint);
      window.removeEventListener("afterprint", onAfterPrint);
    };
  }, [policy.blockPrint, say]);

  // --- Screenshots ----------------------------------------------------------------------------
  useEffect(() => {
    if (policy.screenshotLimitPerDay < 0) return;

    const handle = async () => {
      // Overwriting the clipboard is a genuine (if partial) deterrent on Windows, where PrintScreen
      // puts the image there: replacing it immediately means a paste into an email gets nothing.
      // It does nothing against Win+Shift+S, the Snipping Tool, or a second monitor's capture card,
      // and it is wrapped because a browser without clipboard permission throws here.
      try {
        await navigator.clipboard.writeText("");
      } catch {
        // No clipboard permission. Nothing to do, and not worth telling the user about.
      }

      const verdict = await reportScreenshot({ path: pathRef.current });
      if (!verdict.enforced) return;
      if (verdict.allowed) {
        say(verdict.reason);
        return;
      }
      setScreenshotWall(verdict.reason);
      setTimeout(() => setScreenshotWall(null), 6000);
    };

    const onKey = (event: KeyboardEvent) => {
      const key = event.key;
      // PrintScreen does not fire keydown reliably across browsers — Chrome on Windows gives us
      // keyup only. Win+Shift+S is handled by the OS and never reaches the page at all, which is
      // the honest limit of this detection and why the watermark matters more than the counter.
      if (key === "PrintScreen" || key === "Snapshot") {
        void handle();
        return;
      }
      // The macOS shortcuts do reach the page.
      if (event.metaKey && event.shiftKey && ["3", "4", "5"].includes(key)) {
        void handle();
      }
    };

    document.addEventListener("keyup", onKey, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keyup", onKey, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [policy.screenshotLimitPerDay, say]);

  // --- Developer tools ------------------------------------------------------------------------
  useEffect(() => {
    if (!policy.blockDevTools) return;

    // Detection by window geometry: a docked devtools panel makes the viewport smaller than the
    // window without the window moving. It is a heuristic and it is wrong sometimes — an undocked
    // panel is invisible to it, and a zoom change can trigger it — which is why it reports rather
    // than blocks, and why the activity kind's description says so.
    let reported = false;
    const check = () => {
      const widthGap = window.outerWidth - window.innerWidth;
      const heightGap = window.outerHeight - window.innerHeight;
      const open = widthGap > 200 || heightGap > 220;
      if (open && !reported) {
        reported = true;
        say("Developer tools are being used. This has been logged.", "block");
        void reportDlpEvent({ kind: "DEVTOOLS_OPENED", path: pathRef.current });
      } else if (!open) {
        reported = false;
      }
    };

    const timer = setInterval(check, 2000);
    return () => clearInterval(timer);
  }, [policy.blockDevTools, say]);

  // --- Screen sharing -------------------------------------------------------------------------
  useEffect(() => {
    if (!policy.blurOnBlur) return;
    const onBlur = () => setObscured(true);
    const onFocus = () => setObscured(false);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [policy.blurOnBlur]);

  return (
    <>
      {/* Covers the app while the window is not in front, or a print is in progress. Rendered as a
          sibling overlay rather than a filter on the content, because blurring a huge subtree is a
          per-frame cost on every scroll. */}
      {obscured && (
        <div
          aria-hidden
          className="fixed inset-0 z-[90] grid place-items-center bg-bg/95 backdrop-blur-xl"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-muted">
            <ShieldAlert className="h-4 w-4" />
            Hidden while this window is not in front.
          </p>
        </div>
      )}

      {screenshotWall && (
        <div
          role="alert"
          className="fixed inset-0 z-[95] grid place-items-center bg-bg/98 p-6 text-center backdrop-blur-2xl"
        >
          <div className="max-w-sm space-y-2">
            <ShieldAlert className="mx-auto h-8 w-8 text-danger" />
            <p className="text-sm font-semibold text-text">Screenshot limit reached</p>
            <p className="text-sm text-muted">{screenshotWall}</p>
          </div>
        </div>
      )}

      {notice && (
        <div
          role="status"
          className={`fixed bottom-5 left-1/2 z-[96] -translate-x-1/2 rounded-full px-4 py-2 text-[13px] font-medium shadow-lg ${
            notice.tone === "block" ? "bg-danger text-white" : "bg-text text-bg"
          }`}
        >
          {notice.text}
        </div>
      )}
    </>
  );
}
