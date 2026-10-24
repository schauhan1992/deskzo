import { createSocket } from "node:dgram";
import { getSetting, setSetting } from "@/lib/platform/settings";

/**
 * Whether this server's clock agrees with India's official time.
 *
 * CERT-In's Directions of 28 April 2022 ask every service provider to keep its systems' clocks to the
 * NTP servers of the National Informatics Centre (NIC) or the National Physical Laboratory (NPL), or to
 * time traceable to them — a log is evidence only if its times can be trusted. The server's own time
 * service does the keeping (chrony or systemd-timesyncd, set up as docs/runbook.md §14 says); this asks
 * NPL and NIC once a day how far the clock is from theirs, and says so in the console. More than a
 * second off is an alert.
 *
 * One SNTP request (RFC 4330) each, over UDP 123: the offset is ((T2 − T1) + (T3 − T4)) / 2 — the
 * server's receive and transmit times against this machine's send and receive times, which cancels the
 * time the packet spent travelling as long as it took as long each way.
 */

export const INDIA_TIME_SERVERS = ["time.nplindia.org", "samay1.nic.in", "samay2.nic.in"] as const;
/** More than this apart is worth an alert. */
export const CLOCK_TOLERANCE_MS = 1_000;

export type ClockCheck = {
  at: string;
  /** The server that answered, or null when none did. */
  server: string | null;
  /** How far ahead this clock is (negative: behind), in milliseconds. */
  offsetMs: number | null;
  /** Round trip, in milliseconds. */
  delayMs: number | null;
  error: string | null;
};

const NTP_EPOCH = 2_208_988_800;

function ntpTime(buf: Buffer, at: number): number {
  const seconds = buf.readUInt32BE(at) - NTP_EPOCH;
  const fraction = buf.readUInt32BE(at + 4) / 2 ** 32;
  return (seconds + fraction) * 1000;
}

export function askTimeServer(host: string, timeoutMs = 3_000, port = 123): Promise<{ offsetMs: number; delayMs: number }> {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    const request = Buffer.alloc(48);
    request[0] = 0x1b; // LI 0, version 3, mode 3 (client)
    let t1 = 0;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`${host} didn't answer within ${timeoutMs / 1000} s`));
    }, timeoutMs);
    socket.on("error", (err) => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });
    socket.on("message", (msg) => {
      const t4 = Date.now();
      clearTimeout(timer);
      socket.close();
      if (msg.length < 48 || (msg[0] & 0x07) !== 4) return reject(new Error(`${host} sent something that isn't a time server's answer`));
      const t2 = ntpTime(msg, 32);
      const t3 = ntpTime(msg, 40);
      if (!t3) return reject(new Error(`${host} answered without a time`));
      resolve({ offsetMs: Math.round((t2 - t1 + (t3 - t4)) / 2), delayMs: Math.max(0, t4 - t1 - (t3 - t2)) });
    });
    t1 = Date.now();
    socket.send(request, port, host, (err) => {
      if (!err) return;
      clearTimeout(timer);
      socket.close();
      reject(err);
    });
  });
}

/** Asks NPL, then NIC, until one answers; records what it found as `platform.clockCheck`. */
export async function checkClock(servers: readonly string[] = INDIA_TIME_SERVERS, now = new Date()): Promise<ClockCheck> {
  const errors: string[] = [];
  for (const server of servers) {
    try {
      const { offsetMs, delayMs } = await askTimeServer(server);
      const check: ClockCheck = { at: now.toISOString(), server, offsetMs: -offsetMs, delayMs, error: null };
      await setSetting("platform.clockCheck", JSON.stringify(check), "offsite");
      return check;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  const check: ClockCheck = { at: now.toISOString(), server: null, offsetMs: null, delayMs: null, error: `No time server answered (${errors.join("; ")}). Outgoing UDP port 123 may be blocked.` };
  await setSetting("platform.clockCheck", JSON.stringify(check), "offsite");
  return check;
}

export async function lastClockCheck(): Promise<ClockCheck | null> {
  try {
    const raw = await getSetting("platform.clockCheck");
    return raw ? (JSON.parse(raw) as ClockCheck) : null;
  } catch {
    return null;
  }
}
