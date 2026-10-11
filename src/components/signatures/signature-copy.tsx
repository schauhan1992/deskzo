"use client";

import { useRef, useState } from "react";
import { Check, ClipboardCopy, Code2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * A signature shown as a mail program will show it — on white, whatever the app's theme — with Copy
 * (the HTML and a plain-text twin, or the preview selected where the clipboard API is refused) and
 * Copy HTML.
 */
export function SignatureCopy({ html, text }: { html: string; text: string }) {
  const preview = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState<"rich" | "html" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const flash = (kind: "rich" | "html") => {
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 2500);
  };

  function copySelection(): boolean {
    const node = preview.current;
    const selection = window.getSelection();
    if (!node || !selection) return false;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
    const done = document.execCommand("copy");
    selection.removeAllRanges();
    return done;
  }

  async function copyRich() {
    setProblem(null);
    try {
      if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) throw new Error("no clipboard API");
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
      flash("rich");
    } catch {
      if (copySelection()) flash("rich");
      else setProblem("This browser wouldn't copy it. Select the signature and copy it yourself.");
    }
  }

  async function copyHtml() {
    setProblem(null);
    try {
      await navigator.clipboard.writeText(html);
      flash("html");
    } catch {
      setProblem("This browser wouldn't copy the HTML.");
    }
  }

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border border-line">
        {/* Mail is read on white — so is the preview. Built by renderSignature, which escapes everything. */}
        <div className="overflow-x-auto bg-white px-5 py-5 text-[#333333]">
          <div ref={preview} dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={copyRich}>
          {copied === "rich" ? <Check className="h-4 w-4" /> : <ClipboardCopy className="h-4 w-4" />}
          {copied === "rich" ? "Copied — now paste it" : "Copy signature"}
        </Button>
        <Button type="button" variant="secondary" onClick={copyHtml}>
          {copied === "html" ? <Check className="h-4 w-4" /> : <Code2 className="h-4 w-4" />}
          {copied === "html" ? "HTML copied" : "Copy HTML"}
        </Button>
      </div>
      {problem && <p className="text-sm text-danger">{problem}</p>}
    </div>
  );
}
