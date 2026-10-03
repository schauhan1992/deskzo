"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useClock } from "@/components/time/clock-provider";

/**
 * Keeps the TV screen current: the data every minute, the clock every few seconds — the workspace's
 * time, wherever the TV is. The clock is set after mounting, so the server's render and the browser's
 * never disagree about the time.
 */
export function TvRefresh({ seconds = 60 }: { seconds?: number }) {
  const router = useRouter();
  const clock = useClock();
  const [time, setTime] = useState<string | null>(null);

  useEffect(() => {
    const data = setInterval(() => router.refresh(), seconds * 1000);
    const tick = () => setTime(clock.time(new Date()));
    const first = setTimeout(tick, 0);
    const ticking = setInterval(tick, 5000);
    return () => {
      clearInterval(data);
      clearTimeout(first);
      clearInterval(ticking);
    };
  }, [router, seconds, clock]);

  return <span className="tabular-nums">{time ?? ""}</span>;
}
