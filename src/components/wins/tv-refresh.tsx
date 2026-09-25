"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeps the TV screen current: the data every minute, the clock every few seconds. The clock is set
 * after mounting, so the server's render and the browser's never disagree about the time.
 */
export function TvRefresh({ seconds = 60 }: { seconds?: number }) {
  const router = useRouter();
  const [time, setTime] = useState<string | null>(null);

  useEffect(() => {
    const data = setInterval(() => router.refresh(), seconds * 1000);
    const format = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
    const tick = () => setTime(format.format(new Date()));
    const first = setTimeout(tick, 0);
    const clock = setInterval(tick, 5000);
    return () => {
      clearInterval(data);
      clearTimeout(first);
      clearInterval(clock);
    };
  }, [router, seconds]);

  return <span className="tabular-nums">{time ?? ""}</span>;
}
