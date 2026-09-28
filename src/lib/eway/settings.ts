import { db } from "@/lib/db";
import { THRESHOLD } from "@/lib/eway/rules";

/**
 * The two e-way settings the rules need, readable from anywhere.
 *
 * Both of these lived as private helpers inside `src/actions/eway.ts`, which meant the screens that
 * do not go through that module — the consignment board, where somebody actually decides whether a
 * movement needs a bill — could not see them and fell back to the central ₹50,000. Two screens gave
 * two answers for the same goods. A setting is worth nothing if only one caller can read it.
 *
 * Plain reads with no authorisation of their own: a threshold and a feature flag are not secrets,
 * and every caller has already gated itself. Kept out of `"use server"` deliberately, so they can be
 * imported by anything.
 *
 * The switch is the company's, like the e-invoice one; the threshold is each registration's.
 */
export async function ewayEnabled(): Promise<boolean> {
  const row = await db.organisationSettings.findUnique({
    where: { id: "global" },
    select: { ewayEnabled: true },
  });
  return Boolean(row?.ewayEnabled);
}

/**
 * The floor for movement that stays *inside* a registration's state — each state sets its own, so it
 * is kept per GST registration and entered by the user (CA question C6: the figure for each state).
 *
 * No argument, or null, is the head office's registration — what a document without one, or a screen
 * with no document yet, has always meant. An unknown registration, one without a figure, or no
 * registration at all gives the central ₹50,000, the same `THRESHOLD` the rules module falls back to.
 */
export async function intraStateThreshold(gstRegistrationId?: string | null): Promise<number> {
  const registration = gstRegistrationId
    ? await db.gstRegistration.findUnique({ where: { id: gstRegistrationId }, select: { ewayIntraStateThreshold: true } })
    : (
        await db.branch.findFirst({
          where: { isHeadOffice: true },
          select: { gstRegistration: { select: { ewayIntraStateThreshold: true } } },
        })
      )?.gstRegistration;
  return registration?.ewayIntraStateThreshold ? Number(registration.ewayIntraStateThreshold) : THRESHOLD;
}
