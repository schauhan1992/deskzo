import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { currentTenant } from "@/lib/tenancy/resolve";
import { PEOPLE_ONLY } from "@/lib/people";

/**
 * Seats: the people a workspace's plan lets hold an active account (src/lib/entitlements.ts).
 *
 * A seat is taken by an active member account — never a support account, which is the platform's
 * and not the customer's (src/lib/platform/support.ts). An inactive account frees its seat and takes
 * it back when it is switched on again, so every way an account becomes active asks here first:
 * creating one, switching one back on, converting a candidate, importing people.
 *
 * The answer from `seatProblem` is the quick one, for the form. The one that counts is `claimSeats`, inside the
 * transaction that switches the account on (security review, 23 Oct 2026): "one over for a moment" was the
 * thinking, but nothing bounded it — fifty adds sent at once with one seat free all passed the count.
 */

type SeatReader = Pick<Prisma.TransactionClient, "user">;

export async function seatsInUse(client: SeatReader = db): Promise<number> {
  return client.user.count({ where: { active: true, ...PEOPLE_ONLY } });
}

/** Thrown inside the transaction that would take a seat when none is free; its message is for whoever tried. */
export class SeatsFull extends Error {}

/**
 * Takes `adding` seats inside `tx`, or throws `SeatsFull`. Seat changes queue on one lock while they count and
 * write, so two can't both see the last free seat. Postgres's advisory locks belong to one database, so each
 * workspace queues only behind its own.
 */
export async function claimSeats(tx: Prisma.TransactionClient, adding = 1): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('deskzo:seats'))`;
  const problem = await seatProblem(adding, tx);
  if (problem) throw new SeatsFull(problem);
}

/** Null when there is room for `adding` more; otherwise what to tell whoever tried. */
export async function seatProblem(adding = 1, client: SeatReader = db): Promise<string | null> {
  const { entitlements } = await currentTenant();
  const limit = entitlements.seats;
  if (limit === null) return null;
  const used = await seatsInUse(client);
  if (used + adding <= limit) return null;
  const free = used >= limit ? "every seat is taken" : `only ${limit - used} ${limit - used === 1 ? "is" : "are"} free`;
  // A free trial's seats are the trial's, not a plan's: more come with choosing one (Settings › Billing).
  if (entitlements.trial) return `The free trial includes ${limit} ${limit === 1 ? "user" : "users"}, and ${free}. Choose a plan in Settings › Billing for more, or switch somebody off.`;
  return `This workspace's plan includes ${limit} ${limit === 1 ? "user" : "users"}, and ${free}. Switch somebody off, or ask the workspace owner to add seats.`;
}
