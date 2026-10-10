"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Each card's booth form for an event: open it on a tablet at the stand, or print its QR on a standee
 * so visitors fill it in on their own phones. Only while the event runs — before and after, the link
 * is just the card.
 */
export function BoothLinks({ links, live, mine }: { links: { name: string; url: string; qr: string }[]; live: boolean; mine: boolean }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);

  return (
    <section className="rounded-xl border border-line bg-surface">
      <div className="border-b border-line px-4 py-2.5">
        <h2 className="text-sm font-semibold text-text">{mine ? "Your booth form" : "Booth forms"}</h2>
        <p className="text-xs text-muted">
          {live
            ? "The card with the form first and this event's questions — open it on a tablet at the stand, or put its QR on a standee."
            : "Works while the event runs. Before and after, the link opens the plain card."}
        </p>
      </div>
      {links.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted">
          {mine ? "You need a digital card for a booth form — you can still add people you meet." : "Nobody on the team has a card switched on."}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {links.map((link) => (
            <li key={link.url} className="space-y-2 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-[8rem] flex-1 text-sm font-medium text-text">{link.name}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(link.url);
                      setCopied(link.url);
                      setTimeout(() => setCopied(null), 2000);
                    } catch {
                      setCopied(null);
                    }
                  }}
                >
                  {copied === link.url ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied === link.url ? "Copied" : "Copy link"}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setShown(shown === link.url ? null : link.url)}>
                  <QrCode className="h-3.5 w-3.5" />
                  {shown === link.url ? "Hide QR" : "QR"}
                </Button>
                <a href={link.url} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-base px-3 text-[13px] text-brand hover:bg-brand-subtle">
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open
                </a>
              </div>
              {shown === link.url && (
                <div className="flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={link.qr} alt={`QR code for ${link.name}'s booth form`} className="h-36 w-36 rounded-lg border border-line" />
                  <a href={link.qr} download={`booth-${link.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`} className="text-sm text-brand hover:underline">
                    Download the QR
                  </a>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
