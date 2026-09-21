"use client";

import { useEffect, useState } from "react";

/**
 * The viewer's identity, printed faintly across everything.
 *
 * This is the only measure in the DLP module that survives the attack the others cannot touch. A
 * phone pointed at the monitor defeats every clipboard rule, every keyboard listener and every
 * screenshot counter in the codebase — and it captures this. The photograph then carries the name
 * and address of whoever was looking at the screen, and a leaked document that names its own source
 * is a very different problem from one that does not.
 *
 * Note what it does *not* do: it does not prevent the capture. It makes the capture attributable,
 * which is what actually changes behaviour, because the risk stops being abstract.
 */
export function Watermark({ label, opacity }: { label: string; opacity: number }) {
  // The clock is deliberately not read during render — the React compiler's purity rule forbids it,
  // and a value that changes every render would defeat memoisation anyway.
  const [stamp, setStamp] = useState("");

  useEffect(() => {
    const format = () =>
      new Date().toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
    // Deferred by a tick rather than called here: setting state synchronously in an effect body
    // forces a second render pass before paint, which the React compiler flags. Zero milliseconds
    // is imperceptible, and the label renders without the time until then.
    const first = setTimeout(() => setStamp(format()), 0);
    // Once a minute: precise enough to place a leak within the hour, and cheap enough not to matter.
    const timer = setInterval(() => setStamp(format()), 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  const text = stamp ? `${label} · ${stamp}` : label;

  return (
    <div
      aria-hidden
      // `select-none` and `pointer-events-none` so it never interferes with the app underneath, and
      // a z-index below the DLP overlays but above the content.
      className="pointer-events-none fixed inset-0 z-[80] select-none overflow-hidden"
      style={{ opacity: Math.min(Math.max(opacity, 3), 25) / 100 }}
    >
      {/* A rotated grid of repeats rather than one label: a crop of any corner of the screen still
          contains a whole one, so cropping the watermark out means cropping the data out too. */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 -rotate-[30deg]">
        {Array.from({ length: 14 }).map((_, row) => (
          <div key={row} className="flex gap-16 whitespace-nowrap py-7">
            {Array.from({ length: 6 }).map((__, col) => (
              <span key={col} className="text-[13px] font-semibold tracking-wide text-text">
                {text}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
