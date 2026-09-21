/**
 * The eSSL / ZKTeco "iclock" (ADMS) push protocol, as a set of pure functions.
 *
 * The terminal is the client. Configured with a server address on its keypad, it opens an HTTP
 * connection and drives the whole exchange:
 *
 *   GET  /iclock/cdata?SN=…&options=all&pushver=2.4.1   handshake; we answer with its settings
 *   POST /iclock/cdata?SN=…&table=ATTLOG&Stamp=…        a batch of punches, tab separated
 *   POST /iclock/cdata?SN=…&table=OPERLOG               menu operations, enrolments, reboots
 *   GET  /iclock/getrequest?SN=…                        "anything for me to do?"
 *   POST /iclock/devicecmd?SN=…                         the result of a command we sent
 *
 * Everything is plain text. Replies must be text too — `OK` for an acknowledgement — and a device
 * that gets JSON or an HTML error page will usually just retry the same batch forever.
 *
 * Nothing here touches the database or the network, so the parsing can be tested against payloads
 * captured from a real terminal.
 */

/** What a terminal puts in an ATTLOG row. */
export type ParsedPunch = {
  deviceUserId: string;
  /** Local wall-clock time as the device sent it — no zone, because it sends none. */
  punchedAt: Date;
  punchType: number | null;
  verifyMode: number | null;
  raw: string;
};

export type ParseResult = {
  punches: ParsedPunch[];
  /** Lines that could not be read, kept so a device sending something unexpected is visible. */
  rejected: { line: string; why: string }[];
};

/**
 * Reads a batch of attendance rows.
 *
 * A row is tab-separated and the first four fields are the ones that matter:
 *
 *   1  2026-09-18 09:15:00  0  1  0  0
 *   │  │                    │  └ verify mode (1 finger, 4 card, 15 face)
 *   │  │                    └ punch type (0 in, 1 out, 2/3 break, 4/5 overtime)
 *   │  └ local time
 *   └ enrolment number on the device
 *
 * Firmware varies in how many trailing fields it sends and some builds pad with spaces rather than
 * tabs, so the split is on any run of whitespace and everything past the fourth field is ignored.
 */
export function parseAttlog(body: string): ParseResult {
  const punches: ParsedPunch[] = [];
  const rejected: ParseResult["rejected"] = [];

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const parts = line.split(/\s*\t\s*|\s{2,}/).filter((p) => p !== "");
    if (parts.length < 2) {
      rejected.push({ line, why: "fewer than two fields" });
      continue;
    }

    const [deviceUserId, ...rest] = parts;
    // The timestamp may itself have been split on the space between date and time.
    const stamp = rest[0]?.includes(":") && rest[0].includes("-") ? rest[0] : `${rest[0]} ${rest[1] ?? ""}`.trim();
    const punchedAt = parseDeviceTimestamp(stamp);
    if (!punchedAt) {
      rejected.push({ line, why: `unreadable timestamp "${stamp}"` });
      continue;
    }

    // Whatever was consumed by the timestamp determines where the numeric fields start.
    const consumed = stamp === rest[0] ? 1 : 2;
    const punchType = toInt(rest[consumed]);
    const verifyMode = toInt(rest[consumed + 1]);

    punches.push({ deviceUserId, punchedAt, punchType, verifyMode, raw: line });
  }

  return { punches, rejected };
}

function toInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * "2026-09-18 09:15:00" → a Date.
 *
 * Read as UTC deliberately. The terminal sends a wall-clock reading with no zone, and passing it to
 * `new Date(...)` would have the *server's* zone applied — so the same punch would land on a
 * different day depending on where the ERP happens to be hosted. Treating it as UTC keeps the
 * stored value identical to what the device displayed, and the device's own timezone is recorded
 * beside it for anyone who needs to convert.
 */
export function parseDeviceTimestamp(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, sec] = match;
  const date = new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec ?? "0")),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

export const PUNCH_TYPE_LABELS: Record<number, string> = {
  0: "Check in",
  1: "Check out",
  2: "Break out",
  3: "Break in",
  4: "Overtime in",
  5: "Overtime out",
};

export const VERIFY_MODE_LABELS: Record<number, string> = {
  0: "Password",
  1: "Fingerprint",
  2: "Card",
  3: "Password",
  4: "Card",
  15: "Face",
  16: "Face",
};

/**
 * The reply to the terminal's opening handshake.
 *
 * These are the device's marching orders, and the two that matter are `Stamp` (where to resume from
 * — `0` asks for everything it has) and the transaction toggles. `ATTLOGStamp=0` on a freshly
 * registered device pulls its whole buffer, which is exactly what you want the first time and
 * harmless afterwards because duplicate punches collide on the unique constraint.
 */
export function handshakeResponse(serial: string, options?: { attlogStamp?: string }): string {
  return [
    `GET OPTION FROM: ${serial}`,
    `ATTLOGStamp=${options?.attlogStamp ?? "0"}`,
    "OPERLOGStamp=9999",
    "ATTPHOTOStamp=None",
    // How long the device waits before asking again. Ten seconds keeps a punch no more than a few
    // seconds from appearing in the app without making the terminal chatter.
    "ErrorDelay=30",
    "Delay=10",
    "TransTimes=00:00;14:05",
    "TransInterval=1",
    // 1 = send attendance, 1 = send operation logs, the rest we do not want.
    "TransFlag=1111000000",
    "TimeZone=5.5",
    "Realtime=1",
    "Encrypt=0",
  ].join("\n");
}

/** Terminals treat any non-"OK" reply as a failure and re-send the batch. */
export const ACK = "OK";

/**
 * Which table a POST to /iclock/cdata carries.
 *
 * ATTLOG is attendance. OPERLOG is menu activity — enrolments, deletions, someone changing the
 * device time — which is worth keeping an eye on but is not attendance. Everything else (photos,
 * biometric templates) is refused rather than stored: this app has no use for a fingerprint
 * template and every reason not to hold one.
 */
export function tableOf(searchParams: URLSearchParams): "ATTLOG" | "OPERLOG" | "OTHER" {
  const table = (searchParams.get("table") ?? "").toUpperCase();
  if (table === "ATTLOG") return "ATTLOG";
  if (table === "OPERLOG") return "OPERLOG";
  return "OTHER";
}
