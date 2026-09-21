import { db } from "@/lib/db";

/**
 * The two organisation settings the e-way rules need, readable from anywhere.
 *
 * Both of these lived as private helpers inside `src/actions/eway.ts`, which meant the screens that
 * do not go through that module — the consignment board, where somebody actually decides whether a
 * movement needs a bill — could not see them and fell back to the central ₹50,000. Two screens gave
 * two answers for the same goods. A setting is worth nothing if only one caller can read it.
 *
 * Plain reads with no authorisation of their own: a threshold and a feature flag are not secrets,
 * and every caller has already gated itself. Kept out of `"use server"` deliberately, so they can be
 * imported by anything.
 */
export async function ewayEnabled(): Promise<boolean> {
  const row = await db.organisationSettings.findUnique({
    where: { id: "global" },
    select: { ewayEnabled: true },
  });
  return Boolean(row?.ewayEnabled);
}

/**
 * A state's own floor for movement *inside* the state, if the business has set one.
 *
 * `undefined` rather than `THRESHOLD` when unset, so the rules module applies the central default
 * itself and there is one place that decides what "no answer" means.
 */
export async function intraStateThreshold(): Promise<number | undefined> {
  const row = await db.organisationSettings.findUnique({
    where: { id: "global" },
    select: { ewayIntraStateThreshold: true },
  });
  return row?.ewayIntraStateThreshold ? Number(row.ewayIntraStateThreshold) : undefined;
}
