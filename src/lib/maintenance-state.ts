import type { Clock } from "@/lib/time/zone";

/**
 * The parts of maintenance mode with no database in them — what state a row means, and the page
 * people are shown — so the settings screen can preview the page as the message is typed. The rest,
 * and what maintenance mode is, are in src/lib/maintenance.ts.
 */

export type MaintenanceRow = { enabled: boolean; startsAt: Date | null; endsAt: Date | null; message: string | null; updatedAt?: Date | null };

export type MaintenanceState = {
  /**
   * off — nothing planned; scheduled — switched on for a start still to come; on — down now;
   * ended — its end time has passed, so it is over without anybody switching it off.
   */
  phase: "off" | "scheduled" | "on" | "ended";
  startsAt: Date | null;
  endsAt: Date | null;
  message: string;
};

export const DEFAULT_MESSAGE = "We're making some improvements. The app will be back shortly — thank you for your patience.";
export const MESSAGE_MAX = 500;
/** How far ahead a scheduled window is announced in the banner. */
export const ANNOUNCE_AHEAD_MS = 24 * 3_600_000;

export function maintenanceState(row: MaintenanceRow | null, now = new Date()): MaintenanceState {
  const message = row?.message?.trim() || DEFAULT_MESSAGE;
  const base = { startsAt: row?.startsAt ?? null, endsAt: row?.endsAt ?? null, message };
  if (!row?.enabled) return { phase: "off", ...base };
  if (row.endsAt && row.endsAt.getTime() <= now.getTime()) return { phase: "ended", ...base };
  if (row.startsAt && row.startsAt.getTime() > now.getTime()) return { phase: "scheduled", ...base };
  return { phase: "on", ...base };
}

/** Whether a scheduled window is close enough to announce. */
export function announced(state: MaintenanceState, now = new Date()): boolean {
  return state.phase === "scheduled" && !!state.startsAt && state.startsAt.getTime() - now.getTime() <= ANNOUNCE_AHEAD_MS;
}

// ─── The page ────────────────────────────────────────────────────────────────

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * Served straight from the proxy: plain HTML with nothing to load, because whatever the app is down
 * for may well be the thing a normal page would need. It asks `/api/maintenance/status` every half
 * minute and reloads when the answer changes, so nobody has to keep refreshing. The end is given on
 * the workspace's clock, and the page says which zone that is: nothing else on it does.
 */
export function maintenancePage(state: MaintenanceState, clock: Clock, appName = "Deskzo One"): string {
  const zone = clock.zone.replace(/_/g, " ");
  const back = state.endsAt ? `<p class="when">Expected back by <strong>${escape(clock.dateTime(state.endsAt))}</strong> (${escape(zone)} time).</p>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Down for maintenance — ${escape(appName)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;
         background:#f6f7f9; color:#15181d; }
  @media (prefers-color-scheme: dark) { body { background:#15181d; color:#e8eaed; } a { color:#8ab4f8; } }
  main { max-width:34rem; padding:2rem 1rem; text-align:center; }
  .mark { font-size:2.5rem; line-height:1; margin-bottom:1rem; }
  h1 { font-size:1.35rem; margin:0 0 .75rem; }
  p { margin:0 0 .75rem; }
  .message { white-space:pre-line; opacity:.85; }
  .when { opacity:.85; }
  .small { font-size:.85rem; opacity:.6; margin-top:1.5rem; }
</style></head>
<body><main>
  <div class="mark" aria-hidden="true">&#128736;</div>
  <h1>${escape(appName)} is down for maintenance</h1>
  <p class="message">${escape(state.message)}</p>
  ${back}
  <p class="small">This page checks every 30 seconds and reopens the app by itself when it is back.<br>
  Administrators can still <a href="/login">sign in</a>.</p>
  <script>
    async function tick() {
      try {
        const r = await fetch('/api/maintenance/status', { cache: 'no-store' });
        const d = await r.json();
        if (!d.down) { location.reload(); return; }
      } catch {}
      setTimeout(tick, 30000);
    }
    setTimeout(tick, 30000);
  </script>
</main></body></html>`;
}
