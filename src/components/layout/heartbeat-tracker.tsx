"use client";

import { useEffect } from "react";
import { recordHeartbeat } from "@/actions/activity-tracking";

const INTERVAL_MS = 30_000;

/** Invisible — pings `recordHeartbeat` every 30s while this tab is open and visible, pausing while backgrounded so switching away doesn't rack up "active" time. Mounted once in the dashboard layout. */
export function HeartbeatTracker() {
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;

    function tick() {
      recordHeartbeat().catch(() => {});
    }

    function start() {
      if (interval) return;
      tick();
      interval = setInterval(tick, INTERVAL_MS);
    }

    function stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") start();
      else stop();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    if (document.visibilityState === "visible") start();

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
    };
  }, []);

  return null;
}
