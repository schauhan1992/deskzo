"use server";

import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { isModuleEnabled } from "@/actions/module";
import { viewAsContext } from "@/lib/session";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { hasDialableNumber } from "@/lib/calls";
import { pushToPhone } from "@/lib/app/push";
import type { ActionResult } from "@/actions/company";

/**
 * "Ring my phone" in a call dialog (owner, 18 Oct 2026): the number goes to the Deskzo app on the caller's
 * own phone, which offers to dial it; the call comes back through call sync and is logged with what the
 * dialog was about (src/lib/app/calls.ts). Only to a phone of theirs that is signed in, approved and has
 * call sync on — and never as somebody else, nor to a reseller's customer, whom nobody here rings directly.
 */

const NOT_CALLS = "You can't log calls here.";
/** How long a phone has to pick it up. */
const REQUEST_SECONDS = 120;

async function callsUser() {
  const user = await requireModuleUser("calls");
  return (await isModuleEnabled("calls")) ? user : null;
}

/** Your phone that can take a call from here, the one seen most lately — or null. */
export async function myCallingPhone(): Promise<{ id: string; name: string } | null> {
  const user = await callsUser();
  if (!user || (await viewAsContext())) return null;
  const phone = await db.appDevice.findFirst({
    where: { userId: user.id, callSync: true, device: { status: "APPROVED" } },
    orderBy: { device: { lastSeenAt: "desc" } },
    select: { id: true, model: true, platform: true },
  });
  return phone ? { id: phone.id, name: phone.model ?? (phone.platform === "ios" ? "iPhone" : "Android phone") } : null;
}

export async function ringMyPhone(input: {
  companyId: string;
  contactId?: string;
  phoneNumber: string;
  leadId?: string;
  ticketId?: string;
  companyProductId?: string;
}): Promise<ActionResult<{ id: string; phone: string; pushed: boolean }>> {
  const user = await requireModuleUser("calls");
  if (!(await isModuleEnabled("calls"))) return { ok: false, error: NOT_CALLS };
  if (await viewAsContext()) return { ok: false, error: "You're viewing Deskzo as somebody else — their phone isn't yours to ring." };
  const phoneNumber = input.phoneNumber?.trim() ?? "";
  if (!hasDialableNumber(phoneNumber)) return { ok: false, error: "That number can't be dialled." };

  const company = await db.company.findUnique({ where: { id: input.companyId }, select: { id: true, name: true, ownerUserId: true, relationshipType: true, managedByResellerId: true } });
  if (!company || !(await canSeeCompany(user.id, company))) return { ok: false, error: "That company no longer exists." };
  if (company.managedByResellerId) return { ok: false, error: "This customer is looked after by a reseller — they're not called directly from here." };

  // What it is also about must be this company's, as for a call logged by hand.
  const belongs = (found: { companyId: string } | null) => !!found && found.companyId === company.id;
  const contact = input.contactId ? await db.contact.findUnique({ where: { id: input.contactId }, select: { companyId: true, name: true } }) : null;
  if (input.contactId && !belongs(contact)) return { ok: false, error: "That contact doesn't belong to this company." };
  if (input.leadId && !belongs(await db.lead.findUnique({ where: { id: input.leadId }, select: { companyId: true } }))) return { ok: false, error: "That lead isn't this company's." };
  if (input.ticketId && !belongs(await db.ticket.findUnique({ where: { id: input.ticketId }, select: { companyId: true } }))) return { ok: false, error: "That ticket isn't this company's." };
  if (input.companyProductId && !belongs(await db.companyProduct.findUnique({ where: { id: input.companyProductId }, select: { companyId: true } }))) {
    return { ok: false, error: "That order isn't this company's." };
  }

  const phone = await db.appDevice.findFirst({
    where: { userId: user.id, callSync: true, device: { status: "APPROVED" } },
    orderBy: { device: { lastSeenAt: "desc" } },
    select: { id: true, model: true, platform: true, pushToken: true },
  });
  if (!phone) return { ok: false, error: "None of your phones has the Deskzo app with call sync on. Pair one in Settings › Deskzo app." };

  const label = contact ? `${contact.name}, ${company.name}` : company.name;
  // One at a time: an earlier ring nobody picked up is replaced, not queued behind.
  await db.appCallRequest.updateMany({ where: { appDeviceId: phone.id, status: "WAITING" }, data: { status: "EXPIRED" } });
  const request = await db.appCallRequest.create({
    data: {
      userId: user.id,
      appDeviceId: phone.id,
      companyId: company.id,
      contactId: input.contactId || null,
      leadId: input.leadId || null,
      ticketId: input.ticketId || null,
      companyProductId: input.companyProductId || null,
      phoneNumber,
      label,
      expiresAt: new Date(Date.now() + REQUEST_SECONDS * 1000),
    },
    select: { id: true },
  });

  let pushed = false;
  if (phone.pushToken) {
    const sent = await pushToPhone(phone.pushToken, { type: "call", request: request.id, number: phoneNumber, label });
    pushed = sent === "sent";
    if (sent === "gone") await db.appDevice.update({ where: { id: phone.id }, data: { pushToken: null } });
  }
  return { ok: true, data: { id: request.id, phone: phone.model ?? (phone.platform === "ios" ? "iPhone" : "Android phone"), pushed } };
}

/** Where a ring you sent has got to: waiting for the phone, on the phone, logged, or run out. */
export async function ringState(id: string): Promise<"WAITING" | "TAKEN" | "LOGGED" | "EXPIRED"> {
  const user = await requireModuleUser("calls");
  const request = await db.appCallRequest.findFirst({ where: { id: typeof id === "string" ? id : "", userId: user.id }, select: { status: true, expiresAt: true } });
  if (!request) return "EXPIRED";
  if (request.status === "WAITING" && request.expiresAt < new Date()) return "EXPIRED";
  return request.status;
}
