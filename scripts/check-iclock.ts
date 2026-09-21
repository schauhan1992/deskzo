/**
 * Checks the eSSL / ZKTeco iclock parser against the payload shapes real terminals send.
 *
 * Firmware varies more than the documentation admits: some builds separate with tabs, some pad with
 * spaces, some send six trailing fields and some nine, and a re-sync replays the whole buffer. Each
 * case below is a shape that has to keep working.
 *
 *   npm run check:iclock
 */
import { handshakeResponse, parseAttlog, parseDeviceTimestamp, tableOf } from "../src/lib/hr/iclock";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}
function eq(label: string, actual: unknown, expected: unknown, why = "") {
  const ok = String(actual) === String(expected);
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}${why ? ` — ${why}` : ""}`);
  if (!ok) failures += 1;
}

console.log("\n— Timestamps —");
{
  const t = parseDeviceTimestamp("2026-09-18 09:15:00");
  eq("date part", t?.toISOString().slice(0, 10), "2026-09-18");
  eq("time part", t?.toISOString().slice(11, 19), "09:15:00", "read as UTC, so the stored value matches the display");
  check("seconds may be omitted", parseDeviceTimestamp("2026-09-18 09:15") !== null);
  check("nonsense is refused", parseDeviceTimestamp("18/09/2026 9:15 AM") === null);
  check("empty is refused", parseDeviceTimestamp("") === null);
}

console.log("\n— A tab-separated batch, as the firmware documents it —");
{
  const body = [
    "1\t2026-09-18 09:15:00\t0\t1\t0\t0\t0\t0",
    "2\t2026-09-18 09:22:14\t0\t1\t0\t0\t0\t0",
    "1\t2026-09-18 18:40:09\t1\t1\t0\t0\t0\t0",
  ].join("\n");
  const { punches, rejected } = parseAttlog(body);
  eq("rows parsed", punches.length, 3);
  eq("rows rejected", rejected.length, 0);
  eq("first enrolment number", punches[0].deviceUserId, "1");
  eq("first punch type", punches[0].punchType, 0, "check in");
  eq("verify mode", punches[0].verifyMode, 1, "fingerprint");
  eq("last punch type", punches[2].punchType, 1, "check out");
  eq("timestamp survived", punches[2].punchedAt.toISOString().slice(11, 19), "18:40:09");
  eq("raw line kept verbatim", punches[0].raw.includes("09:15:00"), "true");
}

console.log("\n— Space-padded, as several builds actually send —");
{
  const body = "14    2026-09-18 09:01:33    0    15    0";
  const { punches, rejected } = parseAttlog(body);
  eq("rows parsed", punches.length, 1);
  eq("rows rejected", rejected.length, 0);
  eq("enrolment number", punches[0].deviceUserId, "14");
  eq("verify mode", punches[0].verifyMode, 15, "face");
}

console.log("\n— Short rows, blank lines, CRLF —");
{
  const body = "7\t2026-09-18 10:00:00\r\n\r\n8\t2026-09-18 10:05:00\t1\r\n";
  const { punches, rejected } = parseAttlog(body);
  eq("rows parsed", punches.length, 2, "blank lines ignored, CRLF handled");
  eq("missing punch type is null, not zero", String(punches[0].punchType), "null", "unknown is not 'check in'");
  eq("present punch type is read", punches[1].punchType, 1);
  eq("rows rejected", rejected.length, 0);
}

console.log("\n— Rubbish is reported, not swallowed —");
{
  const { punches, rejected } = parseAttlog("1\tnot-a-date\t0\t1\ngarbage\n5\t2026-09-18 11:00:00\t0\t1");
  eq("good rows still parsed", punches.length, 1, "one bad row does not lose the batch");
  eq("bad rows reported", rejected.length, 2);
  check("the reason is specific", rejected[0].why.includes("timestamp"), rejected[0].why);
}

console.log("\n— A re-sync sends the same rows again —");
{
  const row = "1\t2026-09-18 09:15:00\t0\t1\t0\t0\t0\t0";
  const first = parseAttlog(row).punches[0];
  const second = parseAttlog(row).punches[0];
  check(
    "identical rows produce identical keys",
    first.deviceUserId === second.deviceUserId && first.punchedAt.getTime() === second.punchedAt.getTime(),
    "so the (device, enrolment, time) unique constraint collapses them",
  );
}

console.log("\n— The handshake —");
{
  const reply = handshakeResponse("ESSL12345678");
  check("names the serial back", reply.startsWith("GET OPTION FROM: ESSL12345678"));
  check("asks for the whole buffer", reply.includes("ATTLOGStamp=0"), "safe, because duplicates collide");
  check("enables realtime push", reply.includes("Realtime=1"));
  check("is plain text with no JSON", !reply.includes("{"));
}

console.log("\n— Which table a POST carries —");
{
  eq("ATTLOG", tableOf(new URLSearchParams("SN=X&table=ATTLOG")), "ATTLOG");
  eq("lowercase still matches", tableOf(new URLSearchParams("SN=X&table=attlog")), "ATTLOG");
  eq("OPERLOG", tableOf(new URLSearchParams("SN=X&table=OPERLOG")), "OPERLOG");
  eq("templates are neither", tableOf(new URLSearchParams("SN=X&table=BIODATA")), "OTHER", "refused, not stored");
  eq("missing table", tableOf(new URLSearchParams("SN=X")), "OTHER");
}

console.log(failures === 0 ? "\nAll iclock checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
