"use client";

/**
 * A signature shown as it will look in an email: in a sandboxed frame (no scripts, nothing it can
 * reach), so a mail client's view and not the page's styles decide how it reads.
 */
export function SignatureFrame({ html, height, scale = 1, title }: { html: string; height: number; scale?: number; title: string }) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:12px;background:#fff;}</style></head><body>${html}</body></html>`;
  return (
    <iframe
      title={title}
      srcDoc={doc}
      sandbox=""
      tabIndex={-1}
      className="block border-0"
      style={{ width: `${100 / scale}%`, height: height / scale, transform: `scale(${scale})`, transformOrigin: "0 0", marginBottom: height - height / scale }}
    />
  );
}

/**
 * Copies a signature the way mail clients paste it: as rich text (HTML), with plain text beside it.
 * Falls back to selecting a hidden copy and the old copy command where the clipboard API can't write HTML.
 */
export async function copyRichHtml(html: string, text: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) }),
      ]);
      return true;
    }
  } catch {
    // fall through to the older way
  }
  try {
    const holder = document.createElement("div");
    holder.contentEditable = "true";
    holder.style.position = "fixed";
    holder.style.left = "-9999px";
    holder.innerHTML = html;
    document.body.appendChild(holder);
    const range = document.createRange();
    range.selectNodeContents(holder);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const ok = document.execCommand("copy");
    selection?.removeAllRanges();
    holder.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Copies plain text (the HTML source), with the old copy command where the clipboard API isn't there. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
