import { Prisma, VisitPurpose, VisitStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { workspaceClock } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";
import { requireCompany, requireUserRef } from "./lookups";
import {
  createRow,
  diff,
  errorRow,
  keyOf,
  seqFromKey,
  updateRow,
  RowReader,
  type FieldChange,
  type Importer,
  type Resolved,
} from "./types";

/**
 * Field visits: a person, an account, a day, and what came of going there.
 *
 * ## A check-in time is evidence, not a field
 *
 * Every other column here describes an intention. `Checked in` and `Checked out` describe something
 * that happened to a body in space — somebody was at a customer's office at a particular time — and
 * mileage, expenses and incentives are all claimed against that. Bringing years of visit history in
 * from a spreadsheet during a migration is legitimate and is why these columns exist at all. Using
 * the same file to put an arrival time against a visit the record says nobody attended is not, and
 * the difference is small enough to be worth refusing at the door rather than trusting to intent.
 *
 * So the status and the timestamps have to agree. `CHECKED_IN` with no arrival time is refused: the
 * status asserts somebody is there, and a status that cannot say when is an assertion with nothing
 * behind it. A row that *adds or changes* an arrival **or a departure** time on a visit that stands
 * `CANCELLED` or `NO_SHOW` is refused for the mirror reason — those two statuses record that nobody
 * turned up, and a departure stamp is the same class of evidence as an arrival one: the pair is what
 * mileage and time on site are claimed against, so guarding only the arrival would leave half the
 * claim manufacturable. Note the "adds or changes": a visit checked into and then cancelled
 * afterwards is a shape the app itself produces, so restating what is already stored is left alone.
 * The guards are aimed at what a file would introduce, not at history it merely repeats.
 *
 * ## A visit cannot change company
 *
 * `Company` is required, but on a visit that already exists it has to be the company it is already
 * against. The visit carries a contact, a location and a lead that `createVisit` validates as
 * belonging to that account, and this importer deliberately never touches those three — so moving
 * the header alone would leave them pointing into somebody else's records. The expenses claimed
 * against the visit carry their own `companyId` too, and would keep the old one. Nothing in the app
 * offers that move either: `updateVisit` omits `companyId` from its payload entirely.
 *
 * ## A cell carries a day, not a moment
 *
 * Excel hands dates back as calendar days and `r.date()` reads them as such, so every comparison and
 * every keyless match here works in whole days. That is what keeps a real check-in of 10:30 from
 * being flattened to midnight by a file that never claimed to know the time: if the day is unchanged,
 * the field is not written. The cost is that a spreadsheet cannot distinguish two visits by the same
 * person to the same account on one day — a keyless file treats them as one. Anybody who needs them
 * apart has the `Visit` key, which is what it is for.
 *
 * The days are the workspace's (`workspaceClock()`): a stored visit is a moment, and its day is the one
 * it falls on there; a cell's day is written as the moment that day begins there. Both were read as
 * UTC dates, so a visit at 1 am in India was the day before's, and a day from a file landed at 05:30 —
 * or, west of UTC, on the evening before.
 */

const VISIT_SELECT = {
  id: true,
  visitSeq: true,
  companyId: true,
  userId: true,
  purpose: true,
  status: true,
  scheduledFor: true,
  checkInAt: true,
  checkOutAt: true,
  address: true,
  outcome: true,
  // No company name: the row's own Company cell has to name the company the visit is already
  // against, so `companyId` is all that is compared and there is nothing to render from the stored
  // side that `requireCompany` has not already resolved.
  user: { select: { name: true } },
} satisfies Prisma.VisitSelect;

type ExistingVisit = Prisma.VisitGetPayload<{ select: typeof VISIT_SELECT }>;

type ResolvedVisit = {
  companyId: string;
  companyName: string;
  userId: string;
  userName: string;
  purpose?: VisitPurpose;
  status?: VisitStatus;
  scheduledFor?: Date;
  checkInAt?: Date;
  checkOutAt?: Date;
  address?: string;
  outcome?: string;
  existing: ExistingVisit | null;
};

/** The day a cell can actually carry, on the workspace's clock. Both sides of every date comparison go through this. */
const dayOf = (d: Date | null | undefined, clock: Clock) => (d ? clock.dateKey(d) : "");

async function resolve(row: Record<string, string>): Promise<Resolved<ResolvedVisit>> {
  const clock = await workspaceClock();
  const r = new RowReader(row, clock);
  // A cell's day (midnight UTC, as `r.date` reads one) as the moment that day begins in the workspace.
  const startOf = (d: Date | undefined) => (d ? clock.midnight(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) : undefined);

  const company = await requireCompany("Company", r.text("Company"));
  if ("error" in company) return { error: company.error };

  const user = await requireUserRef("By", r.text("By"));
  if ("error" in user) return { error: user.error };

  const purpose = r.enum("Purpose", VisitPurpose);
  const status = r.enum("Status", VisitStatus);
  const scheduledFor = startOf(r.date("Scheduled for"));
  const checkInAt = startOf(r.date("Checked in"));
  const checkOutAt = startOf(r.date("Checked out"));
  if (r.error) return { error: r.error };

  const seq = seqFromKey("VIS", r.text("Visit"));
  const day = scheduledFor ? clock.dayRange(clock.dateKey(scheduledFor), clock.dateKey(scheduledFor)) : null;
  const existing = seq
    ? await db.visit.findUnique({ where: { visitSeq: seq }, select: VISIT_SELECT })
    : day
      ? // Without a key, the same person at the same account on the same day is the same visit.
        // Matching on nothing would make a keyless migration file double its rows every time
        // somebody re-ran it, which is the failure this whole design exists to avoid.
        await db.visit.findFirst({
          where: {
            companyId: company.value.id,
            userId: user.value.id,
            scheduledFor: day,
          },
          orderBy: { visitSeq: "asc" },
          select: VISIT_SELECT,
        })
      : null;

  if (seq && !existing) {
    return { error: `No visit with key ${keyOf("VIS", seq)} (Visit). Clear the Visit cell to log a new one.` };
  }
  // Only reachable down the keyed path — a keyless match is already made on this company — but
  // stated unconditionally so the rule does not depend on how the row happened to be matched.
  if (existing && existing.companyId !== company.value.id) {
    return {
      error: `${keyOf("VIS", existing.visitSeq)} is against another company, and a visit can't be moved by an import — its contact, location and lead belong to that account, as do the expenses claimed against it. Correct the Company cell, or clear the Visit cell to log a new visit.`,
    };
  }
  if (!existing && !scheduledFor) {
    return { error: "Scheduled for is required — a new visit has to say which day it was for." };
  }

  // What the record would stand at once this row has been applied. Judging the guards on that rather
  // than on the cells lets a row set a status whose evidence is already on the record.
  const effectiveStatus = status ?? existing?.status ?? VisitStatus.PLANNED;
  const effectiveIn = checkInAt ?? existing?.checkInAt ?? null;
  const effectiveOut = checkOutAt ?? existing?.checkOutAt ?? null;
  const addsCheckIn = !!checkInAt && dayOf(checkInAt, clock) !== dayOf(existing?.checkInAt, clock);
  const addsCheckOut = !!checkOutAt && dayOf(checkOutAt, clock) !== dayOf(existing?.checkOutAt, clock);

  if (effectiveStatus === VisitStatus.CHECKED_IN && !effectiveIn) {
    return { error: 'Status CHECKED_IN needs a "Checked in" time — the status says somebody arrived, so the row has to say when.' };
  }
  if ((addsCheckIn || addsCheckOut) && (effectiveStatus === VisitStatus.CANCELLED || effectiveStatus === VisitStatus.NO_SHOW)) {
    const which = addsCheckIn ? "Checked in" : "Checked out";
    return { error: `A "${which}" time can't be put against a ${effectiveStatus} visit — that status records that nobody turned up.` };
  }
  if (addsCheckOut && !effectiveIn) {
    return { error: 'A "Checked out" time needs a "Checked in" time — nobody leaves a visit they never arrived at.' };
  }
  if (effectiveIn && effectiveOut && dayOf(effectiveOut, clock) < dayOf(effectiveIn, clock)) {
    return { error: '"Checked out" is before "Checked in".' };
  }

  return {
    value: {
      companyId: company.value.id,
      companyName: company.value.name,
      userId: user.value.id,
      userName: user.value.name,
      purpose,
      status,
      scheduledFor,
      checkInAt,
      checkOutAt,
      address: r.text("Address") || undefined,
      outcome: r.text("Outcome") || undefined,
      existing,
    },
  };
}

/**
 * One list, read twice: `plan` renders the changes and `apply` writes the fragments beside them.
 *
 * Keeping the comparison and the write in the same entry is what stops the two drifting — a field
 * cannot be promised in the preview and then quietly left out of the update, because it is the same
 * line of code deciding both.
 */
type Candidate = { change: FieldChange | null; data: Prisma.VisitUncheckedUpdateInput };

// Company is absent from this list because a row naming a different one never reaches here, and a
// row naming the same one has nothing to write.
function candidatesFor(v: ResolvedVisit, existing: ExistingVisit, clock: Clock): Candidate[] {
  return [
    { change: diff("By", existing.user.name, v.userName), data: { userId: v.userId } },
    { change: v.purpose ? diff("Purpose", existing.purpose, v.purpose) : null, data: { purpose: v.purpose } },
    { change: v.status ? diff("Status", existing.status, v.status) : null, data: { status: v.status } },
    {
      change: v.scheduledFor ? diff("Scheduled for", dayOf(existing.scheduledFor, clock), dayOf(v.scheduledFor, clock)) : null,
      data: { scheduledFor: v.scheduledFor },
    },
    {
      change: v.checkInAt ? diff("Checked in", dayOf(existing.checkInAt, clock), dayOf(v.checkInAt, clock)) : null,
      data: { checkInAt: v.checkInAt },
    },
    {
      change: v.checkOutAt ? diff("Checked out", dayOf(existing.checkOutAt, clock), dayOf(v.checkOutAt, clock)) : null,
      data: { checkOutAt: v.checkOutAt },
    },
    { change: v.address ? diff("Address", existing.address, v.address) : null, data: { address: v.address } },
    { change: v.outcome ? diff("Outcome", existing.outcome, v.outcome) : null, data: { outcome: v.outcome } },
  ];
}

export const visitsImporter: Importer = {
  templateColumns: [
    "Visit",
    "Company",
    "By",
    "Purpose",
    "Status",
    "Scheduled for",
    "Checked in",
    "Checked out",
    "Address",
    "Outcome",
  ],

  async plan(row, line) {
    const resolved = await resolve(row);
    if ("error" in resolved) return errorRow(line, row.Visit || row.Company || "", resolved.error);
    const v = resolved.value;
    const clock = await workspaceClock();
    const day = dayOf(v.scheduledFor ?? v.existing?.scheduledFor, clock);
    const label = `${v.companyName} on ${day}`;

    if (!v.existing) {
      // Days as the workspace's, not as Dates — `createRow` writes a Date's UTC date.
      return createRow(line, `${v.companyName}:${day}`, label, {
        Company: v.companyName,
        By: v.userName,
        Purpose: v.purpose,
        Status: v.status,
        "Scheduled for": dayOf(v.scheduledFor, clock),
        "Checked in": dayOf(v.checkInAt, clock),
        "Checked out": dayOf(v.checkOutAt, clock),
        Address: v.address,
        Outcome: v.outcome,
      });
    }

    return updateRow(
      line,
      keyOf("VIS", v.existing.visitSeq),
      label,
      candidatesFor(v, v.existing, clock).map((c) => c.change),
    );
  },

  async apply(row) {
    const resolved = await resolve(row);
    if ("error" in resolved) throw new Error(resolved.error);
    const v = resolved.value;

    if (!v.existing) {
      await db.visit.create({
        data: {
          companyId: v.companyId,
          userId: v.userId,
          // resolve() refuses a new visit that names no day, so this is present here.
          scheduledFor: v.scheduledFor!,
          ...(v.purpose ? { purpose: v.purpose } : {}),
          ...(v.status ? { status: v.status } : {}),
          ...(v.checkInAt ? { checkInAt: v.checkInAt } : {}),
          ...(v.checkOutAt ? { checkOutAt: v.checkOutAt } : {}),
          ...(v.address ? { address: v.address } : {}),
          ...(v.outcome ? { outcome: v.outcome } : {}),
        },
      });
      return;
    }

    const data: Prisma.VisitUncheckedUpdateInput = {};
    for (const c of candidatesFor(v, v.existing, await workspaceClock())) if (c.change) Object.assign(data, c.data);
    // An empty update still moves updatedAt, which would make a re-imported file look like it had
    // touched every visit in it.
    if (Object.keys(data).length > 0) {
      await db.visit.update({ where: { id: v.existing.id }, data });
    }
  },
};
