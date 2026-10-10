"use client";

import { useState } from "react";
import { Check, Copy, Download, ExternalLink, Nfc, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Sharing a card: its QR (the company's logo over the middle — the code is made with enough error
 * correction to read through it), its link, and how to put it on a phone's home screen or an NFC tag.
 */
export function CardShare({ url, qr, logoUrl, name, live }: { url: string; qr: string; logoUrl: string | null; name: string; live: boolean }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function copy() {
    setError(null);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy — select the link and copy it instead.");
    }
  }

  /** The QR as a PNG, with the logo drawn in, for a slide, a badge or a desk sign. */
  async function download() {
    setError(null);
    try {
      const size = 960;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no canvas");
      const code = await loadImage(qr);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(code, 0, 0, size, size);
      if (logoUrl) {
        try {
          const logo = await loadImage(logoUrl);
          const box = size * 0.22;
          const x = (size - box) / 2;
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(x - 12, x - 12, box + 24, box + 24);
          const scale = Math.min(box / logo.width, box / logo.height);
          const w = logo.width * scale;
          const h = logo.height * scale;
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(logo, (size - w) / 2, (size - h) / 2, w, h);
        } catch {
          // No logo, or one that won't draw: the plain code is still a working code.
        }
      }
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "card"}-qr.png`;
      a.click();
    } catch {
      setError("The QR couldn't be saved from this browser.");
    }
  }

  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="relative mx-auto h-44 w-44 shrink-0 sm:mx-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr} alt={`QR code for ${name}'s card`} className="h-full w-full rounded-lg" />
          {logoUrl && (
            <span className="absolute left-1/2 top-1/2 grid h-10 w-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-md bg-white p-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={logoUrl} alt="" className="max-h-full max-w-full object-contain" />
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <p className="text-sm font-medium text-text">Your card&apos;s link</p>
            <p className="mt-1 break-all rounded-base border border-line bg-surface-sunken px-2.5 py-1.5 font-mono text-xs text-text">{url}</p>
            {!live && <p className="mt-1 text-xs text-warning">Switched off: it shows your company&apos;s details for now.</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={copy}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy link"}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={download}>
              <Download className="h-3.5 w-3.5" />
              Download QR
            </Button>
            <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-base px-3 text-sm text-brand hover:bg-brand-subtle">
              <ExternalLink className="h-3.5 w-3.5" />
              Open card
            </a>
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          <ul className="space-y-1.5 text-xs text-muted">
            <li className="flex gap-2">
              <Smartphone className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              On your phone, open this page and add it to your home screen: your QR is then one tap away.
            </li>
            <li className="flex gap-2">
              <Nfc className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              Write the link to any NFC card or sticker with a free NFC app, and a tap opens your card.
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
