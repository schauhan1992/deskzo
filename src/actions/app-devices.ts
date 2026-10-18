"use server";

import { revalidatePath } from "next/cache";
import QRCode from "qrcode";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { requireUser, viewAsContext } from "@/lib/session";
import { deskzoAppReady } from "@/lib/app/ready";
import { pairingState, startPairing, unpairPhone } from "@/lib/app/pairing";
import { pairingLink, spacedCode } from "@/lib/app/tokens";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import type { ActionResult } from "@/actions/company";

/**
 * Settings › Deskzo app (owner, 18 Oct 2026): pairing your own phone with the app, the phones you have
 * paired, and signing one out. Everybody's own — nobody pairs a phone for somebody else, and nobody does it
 * while viewing as somebody else. Administrators see and revoke every phone in Security › Devices, where
 * each one is a device like any browser (src/lib/app/pairing.ts).
 */

const NOT_YET = "The Deskzo app isn't available yet.";
const AS_YOURSELF = "You're viewing Deskzo as somebody else — a phone can only be paired or signed out as yourself.";

export async function startPhonePairing(): Promise<ActionResult<{ id: string; code: string; qr: string; expiresAt: string }>> {
  const user = await requireUser();
  if (!deskzoAppReady()) return { ok: false, error: NOT_YET };
  if (await viewAsContext()) return { ok: false, error: AS_YOURSELF };
  const pairing = await startPairing(user.id);
  const qr = await QRCode.toString(pairingLink(await tenantOrigin(), pairing.code), { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return { ok: true, data: { id: pairing.id, code: spacedCode(pairing.code), qr, expiresAt: pairing.expiresAt.toISOString() } };
}

/** Where a code you asked for has got to: still waiting, run out, or used by a phone. */
export async function phonePairingState(id: string) {
  const user = await requireUser();
  if (typeof id !== "string" || id.length > 40) return { state: "EXPIRED" as const };
  return pairingState(user.id, id);
}

export type MyPhone = {
  id: string;
  name: string;
  platform: string;
  appVersion: string | null;
  status: "APPROVED" | "PENDING" | "REJECTED" | "REVOKED";
  callSync: boolean;
  pairedAt: string;
  lastSeenAt: string;
};

/** Your phones: signed in, waiting for approval, and those signed out in the last month. */
export async function listMyPhones(): Promise<MyPhone[]> {
  const user = await requireUser();
  const rows = await db.appDevice.findMany({
    where: { userId: user.id, OR: [{ device: { status: { in: ["APPROVED", "PENDING"] } } }, { device: { decidedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } } }] },
    orderBy: { createdAt: "desc" },
    select: { id: true, platform: true, model: true, appVersion: true, callSync: true, createdAt: true, device: { select: { status: true, lastSeenAt: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.model ?? (r.platform === "ios" ? "iPhone" : "Android phone"),
    platform: r.platform,
    appVersion: r.appVersion,
    status: r.device.status,
    callSync: r.callSync && r.device.status === "APPROVED",
    pairedAt: r.createdAt.toISOString(),
    lastSeenAt: r.device.lastSeenAt.toISOString(),
  }));
}

/** Signs one of your phones out of the app, at once. */
export async function signOutPhone(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (await viewAsContext()) return { ok: false, error: AS_YOURSELF };
  const phone = await db.appDevice.findFirst({ where: { id: typeof id === "string" ? id : "", userId: user.id }, select: { id: true, model: true, platform: true, device: { select: { status: true } } } });
  if (!phone) return { ok: false, error: "That phone isn't one of yours." };
  if (phone.device.status === "REVOKED") return { ok: true, data: null };
  await unpairPhone(phone.id, user.id);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "AppDevice", entityId: phone.id, entityLabel: `Signed a phone out of the Deskzo app — ${phone.model ?? phone.platform}` });
  revalidatePath("/settings/phone");
  return { ok: true, data: null };
}
