import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * The switches Settings › Customer emails keeps (src/lib/customer-emails.ts), apart from the list so a
 * booking can ask for its own without loading the rest. A workspace not migrated yet has the defaults.
 */

export type CustomerEmailSettingsView = { bookingInvite: boolean };

/** The switches kept here; the defaults in a workspace not migrated yet, or before anybody chose. */
export async function customerEmailSettings(): Promise<CustomerEmailSettingsView> {
  try {
    const row = await db.customerEmailSettings.findUnique({ where: { id: "global" }, select: { bookingInvite: true } });
    return { bookingInvite: row?.bookingInvite ?? true };
  } catch (err) {
    if (notMigratedYet(err)) return { bookingInvite: true };
    throw err;
  }
}

/** Whether a booking page emails its guest an invitation. */
export async function bookingInvitesOn(): Promise<boolean> {
  return (await customerEmailSettings()).bookingInvite;
}

export async function setBookingInvite(on: boolean, byUserId: string): Promise<void> {
  await db.customerEmailSettings.upsert({
    where: { id: "global" },
    create: { id: "global", bookingInvite: on, updatedById: byUserId },
    update: { bookingInvite: on, updatedById: byUserId },
    select: { id: true },
  });
}

export async function ticketAcknowledgementOn(): Promise<boolean> {
  try {
    return (await db.supportMailSettings.findUnique({ where: { id: "global" }, select: { acknowledge: true } }))?.acknowledge ?? true;
  } catch (err) {
    if (notMigratedYet(err)) return true;
    throw err;
  }
}

export async function setTicketAcknowledgement(on: boolean): Promise<void> {
  await db.supportMailSettings.upsert({ where: { id: "global" }, create: { id: "global", acknowledge: on }, update: { acknowledge: on }, select: { id: true } });
}
