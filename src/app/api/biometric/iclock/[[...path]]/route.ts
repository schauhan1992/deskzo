import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ACK, handshakeResponse, parseAttlog, tableOf } from "@/lib/hr/iclock";
import { linkPunchesToUsers, rollupPunches } from "@/lib/hr/punch-rollup";

/**
 * Where eSSL / ZKTeco terminals push their attendance.
 *
 * ── Security, stated plainly ─────────────────────────────────────────────────
 *
 * The iclock protocol has no authentication. None. A terminal announces a serial number and starts
 * uploading, and the firmware offers no way to add a header, a token or a client certificate. That
 * is the protocol, not an oversight here, and it means this endpoint must be treated as a
 * LAN-facing one: reachable from the office network or over a VPN, never published to the internet.
 *
 * Given that, the defences that are actually available are used:
 *
 *   · A serial must be registered and active before a single row is accepted. An unknown serial
 *     gets a flat refusal and is recorded, so an unexpected terminal is visible rather than silent.
 *   · Nothing here creates people. An unrecognised enrolment number produces a punch attached to
 *     nobody, waiting to be mapped by hand — so a fabricated upload cannot invent an employee.
 *   · A day already covered by approved leave, or corrected by HR, is never overwritten
 *     (see src/lib/hr/punch-rollup.ts). The worst a rogue upload can do is add a present day for a
 *     person who is already mapped, which is visible on the attendance grid.
 *   · Bodies are size-capped, because the device sets no limit and a stuck one will happily post
 *     its entire flash.
 *
 * ── Replies ──────────────────────────────────────────────────────────────────
 *
 * Plain text, always. A device that receives JSON, HTML, or a redirect to the login page treats the
 * batch as failed and re-sends it — forever. That last one is why `/iclock` is excluded from the
 * auth middleware: without it, every upload would be answered with a 307 to /login and the terminal
 * would never make progress.
 */

/** Well past any real batch, far short of anything that would hurt. */
const MAX_BODY_BYTES = 2_000_000;

function text(body: string, status = 200) {
  return new NextResponse(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Resolves and stamps the calling terminal, or explains why it is not welcome. */
async function authenticateDevice(serial: string | null) {
  if (!serial) return { error: text("Missing SN", 400) };

  const device = await db.biometricDevice.findUnique({ where: { serialNumber: serial } });
  if (!device) {
    // Logged rather than ignored: the first thing somebody does is plug the terminal in and wonder
    // why nothing arrives, and the answer is almost always "its serial isn't registered yet".
    console.warn(`[biometric] refused unknown terminal serial=${serial}`);
    return { error: text("Device not registered", 401) };
  }
  if (!device.active) {
    return { error: text("Device disabled", 403) };
  }
  return { device };
}

export async function GET(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const { path } = await context.params;
  const url = new URL(request.url);
  const serial = url.searchParams.get("SN");

  const result = await authenticateDevice(serial);
  if (result.error) return result.error;
  const device = result.device;

  await db.biometricDevice.update({
    where: { id: device.id },
    data: {
      lastSeenAt: new Date(),
      deviceModel: url.searchParams.get("DeviceType") ?? device.deviceModel,
      firmware: url.searchParams.get("pushver") ?? device.firmware,
    },
  });

  const endpoint = (path ?? []).join("/");

  // The opening handshake: the device asks what it should do and we answer with its settings.
  if (endpoint === "cdata") {
    return text(handshakeResponse(device.serialNumber));
  }

  // "Anything for me?" — polled every few seconds. There is no command queue in this build, so the
  // honest answer is no. Returning anything other than OK here makes some firmware retry in a loop.
  if (endpoint === "getrequest") {
    return text(ACK);
  }

  return text(ACK);
}

export async function POST(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const { path } = await context.params;
  const url = new URL(request.url);
  const serial = url.searchParams.get("SN");

  const result = await authenticateDevice(serial);
  if (result.error) return result.error;
  const device = result.device;

  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) {
    console.warn(`[biometric] oversized upload from ${serial}: ${body.length} bytes`);
    return text("Payload too large", 413);
  }

  const endpoint = (path ?? []).join("/");
  await db.biometricDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });

  if (endpoint === "devicecmd") {
    // The result of a command we sent. Nothing sends commands yet, so this is just acknowledged.
    return text(ACK);
  }

  const table = tableOf(url.searchParams);
  if (table === "OPERLOG") {
    // Enrolments, deletions, someone changing the device clock. Not attendance, and storing menu
    // activity would be surveillance without a purpose, so it is acknowledged and dropped.
    return text(ACK);
  }
  if (table !== "ATTLOG") {
    // Photos and fingerprint templates land here. Refused on purpose — this app has no use for a
    // biometric template and every reason not to hold one.
    return text(ACK);
  }

  const { punches, rejected } = parseAttlog(body);
  if (rejected.length > 0) {
    console.warn(`[biometric] ${serial}: ${rejected.length} unreadable row(s), first: ${rejected[0].line}`);
  }
  if (punches.length === 0) return text(ACK);

  // `skipDuplicates` is what makes a terminal re-sending its whole buffer a no-op. They do this
  // after a reboot, after a clock change, and whenever ATTLOGStamp is reset — routinely, in other
  // words, and the unique constraint is the only thing standing between that and duplicate days.
  const created = await db.biometricPunch.createMany({
    data: punches.map((p) => ({
      deviceId: device.id,
      deviceUserId: p.deviceUserId,
      punchedAt: p.punchedAt,
      punchType: p.punchType,
      verifyMode: p.verifyMode,
      raw: p.raw,
    })),
    skipDuplicates: true,
  });

  const latest = punches.reduce((max, p) => (p.punchedAt > max ? p.punchedAt : max), punches[0].punchedAt);
  await db.biometricDevice.update({
    where: { id: device.id },
    data: {
      lastPunchAt: latest > (device.lastPunchAt ?? new Date(0)) ? latest : device.lastPunchAt,
      punchesReceived: { increment: created.count },
    },
  });

  if (created.count > 0) {
    await linkPunchesToUsers([...new Set(punches.map((p) => p.deviceUserId))]);
    await rollupPunches();
  }

  return text(ACK);
}
