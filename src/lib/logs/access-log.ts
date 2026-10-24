import { appendFile, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

/**
 * The web access log CERT-In asks for (Directions of 28 April 2022, §(iv): logs of all ICT systems,
 * kept 180 days, in India). One line per request the proxy sees, written by every web process to its
 * own file:
 *
 *   <LOG_DIR>/access/<YYYY-MM-DD, UTC>/<host>-<pid>.jsonl
 *   {"t":"2026-10-24T05:12:03.114Z","h":"acme.deskzo.com","m":"GET","p":"/leads","s":null,"ip":"203.0.113.9","ua":"Mozilla/5.0 …","u":"ckx…"}
 *
 *   t   when, in UTC, from this server's clock (kept to India's time servers — docs/runbook.md §14)
 *   h   the address asked for — which workspace, or the website, the console, the CMS
 *   m,p the method and the path. Never the query: tokens and searches live there
 *   s   the status, when the proxy answered itself (a redirect, a 404, a hold); null when the request
 *       went on to the page or API, whose own status the proxy never sees
 *   ip  the caller, as src/lib/client-ip.ts decides it (Cloudflare's header only when told to trust it)
 *   ua  the user agent, cut at 300 characters
 *   u   the signed-in person's id in that workspace, when there is one
 *
 * Lines are buffered and appended about once a second, never one write per request. Each process has
 * its own file, so the processes of a cluster (DESKZO_WEB_PROCESSES) never interleave a line. The
 * archiver (src/lib/logs/archive.ts) seals and copies each finished day off-site and keeps two weeks
 * here.
 *
 * On in production; elsewhere only with ACCESS_LOG=on. ACCESS_LOG=off turns it off anywhere — for a
 * server whose access log is kept by something in front of it instead.
 *
 * State is on globalThis: the proxy is bundled apart from the server's own code.
 */

export type AccessEntry = { host: string; method: string; path: string; status: number | null; ip: string | null; userAgent: string | null; userId: string | null };

type State = { lines: string[]; timer: NodeJS.Timeout | null; flushing: Promise<void> | null; made: Set<string> };

const FLUSH_MS = 1_000;
const FLUSH_LINES = 500;

function state(): State {
  const g = globalThis as { [key: symbol]: State | undefined };
  const key = Symbol.for("deskzo.access-log");
  return (g[key] ??= { lines: [], timer: null, flushing: null, made: new Set() });
}

/** Where logs live: LOG_DIR, or `logs` beside the app. On the persistent volume in production (/data/logs). */
export function logBase(): string {
  return path.resolve(process.env.LOG_DIR?.trim() || "logs");
}

export function accessLogDir(): string {
  return path.join(logBase(), "access");
}

export function accessLogEnabled(): boolean {
  const setting = process.env.ACCESS_LOG?.trim().toLowerCase();
  if (setting === "off" || setting === "0") return false;
  if (setting === "on" || setting === "1") return true;
  return process.env.NODE_ENV === "production";
}

/** This process's file for the UTC day of `at`. */
export function accessLogFile(at: Date): string {
  return path.join(accessLogDir(), at.toISOString().slice(0, 10), `${hostname().replace(/[^A-Za-z0-9._-]/g, "_")}-${process.pid}.jsonl`);
}

export function logAccess(entry: AccessEntry, at = new Date()): void {
  if (!accessLogEnabled()) return;
  const s = state();
  s.lines.push(
    JSON.stringify({
      t: at.toISOString(),
      h: entry.host.slice(0, 255),
      m: entry.method,
      p: entry.path.slice(0, 2048),
      s: entry.status,
      ip: entry.ip,
      ua: entry.userAgent ? entry.userAgent.slice(0, 300) : null,
      u: entry.userId,
    }),
  );
  if (s.lines.length >= FLUSH_LINES) void flushAccessLog();
  else if (!s.timer) {
    s.timer = setTimeout(() => void flushAccessLog(), FLUSH_MS);
    s.timer.unref?.();
  }
}

/**
 * Writes what is buffered. Lines go to the file of the day they were logged on, so a flush just after
 * midnight puts the last seconds of yesterday in yesterday's file. A failed write is reported once
 * and its lines dropped: a full disk must not take the app down with it.
 */
export async function flushAccessLog(): Promise<void> {
  const s = state();
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  if (s.flushing) await s.flushing;
  if (s.lines.length === 0) return;
  const lines = s.lines;
  s.lines = [];
  s.flushing = (async () => {
    const byFile = new Map<string, string[]>();
    for (const line of lines) {
      const file = accessLogFile(new Date(line.slice(6, 30)));
      const list = byFile.get(file) ?? [];
      list.push(line);
      byFile.set(file, list);
    }
    for (const [file, list] of byFile) {
      try {
        const dir = path.dirname(file);
        if (!s.made.has(dir)) {
          await mkdir(dir, { recursive: true });
          s.made.add(dir);
        }
        await appendFile(file, `${list.join("\n")}\n`, "utf8");
      } catch (err) {
        console.error(`[access-log] ${list.length} lines could not be written to ${file}:`, err instanceof Error ? err.message : err);
        s.made.clear();
      }
    }
  })();
  try {
    await s.flushing;
  } finally {
    s.flushing = null;
  }
}
