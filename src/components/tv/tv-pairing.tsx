"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { tvPairingCode, tvPairingStatus } from "@/actions/tv-public";

/**
 * What a TV shows until it's paired (owner, 17 Oct 2026): a six-digit code, large enough to read across a
 * room, and a QR code that opens Settings → TV screens with the code filled in. It asks every few seconds
 * whether it has been paired; once it has, it opens its board. A code that runs out is replaced by a fresh
 * one without anybody touching the TV.
 */
export function TvPairing() {
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null | "OFF" | "BUSY">(null);
  const [qr, setQr] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    tvPairingCode()
      .then((p) => {
        if (!live) return;
        setPairing(p ?? "OFF");
        if (p && p !== "BUSY") {
          QRCode.toDataURL(`${window.location.origin}/settings/tv-screens?code=${p.code}`, { margin: 1, width: 320, color: { dark: "#0b1020", light: "#ffffff" } })
            .then((url) => live && setQr(url))
            .catch(() => {});
        }
      })
      .catch(() => live && setPairing("OFF"));
    return () => {
      live = false;
    };
  }, [round]);

  // Too many TVs waiting at once: ask again in a minute.
  useEffect(() => {
    if (pairing !== "BUSY") return;
    const timer = setTimeout(() => setRound((r) => r + 1), 60_000);
    return () => clearTimeout(timer);
  }, [pairing]);

  useEffect(() => {
    if (!pairing || pairing === "OFF" || pairing === "BUSY") return;
    const timer = setInterval(() => {
      tvPairingStatus()
        .then((status) => {
          // A full load, so the board is fetched with the cookie that pairing just set.
          if (status === "PAIRED") window.location.replace("/tv/wins");
          else if (status === "EXPIRED") setRound((r) => r + 1);
        })
        .catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [pairing]);

  if (pairing === "OFF") return <p className="grid min-h-screen place-items-center text-2xl text-white/60">The wins board is switched off.</p>;
  if (pairing === "BUSY") {
    return <p className="grid min-h-screen place-items-center p-10 text-center text-2xl text-white/60">Too many TVs are waiting for a code right now — this one tries again in a minute.</p>;
  }

  return (
    <div className="grid min-h-screen place-items-center p-10">
      <div className="flex flex-col items-center gap-10 text-center lg:flex-row lg:text-left">
        <div className="space-y-6">
          <div className="text-lg uppercase tracking-widest text-white/50">Put this TV on the wins board</div>
          <div className="font-mono text-8xl font-bold tracking-[0.25em] text-white" aria-label="Pairing code">
            {pairing ? pairing.code : "······"}
          </div>
          <ol className="max-w-xl list-decimal space-y-2 pl-6 text-left text-2xl text-white/75">
            <li>On your phone or computer, scan the code, or open Deskzo → Settings → TV screens.</li>
            <li>Type these six digits, name the screen and choose its branch.</li>
            <li>This TV opens the board by itself.</li>
          </ol>
          <p className="text-base text-white/40">The code changes every few minutes. Only people allowed to put Deskzo on a TV can pair it.</p>
        </div>
        <div className="rounded-2xl bg-white p-4">
          {/* eslint-disable-next-line @next/next/no-img-element -- a QR code drawn here as a data URL; nothing to optimise */}
          {qr ? <img src={qr} alt="Scan to pair this TV" width={320} height={320} /> : <div className="h-80 w-80" />}
        </div>
      </div>
    </div>
  );
}
