import type {
  CandidateStatus,
  LeadStatus,
  Prisma,
  TicketStatus,
  TradeDocumentStatus,
  WorkbookRecordStatus,
} from "@prisma/client";
import type { Allocatable } from "@/lib/workspace/allocation";
import { HANDOVER_ROTATION_DAYS } from "@/lib/vault/policy";

/**
 * Everything one person can be holding that somebody else may need to take over.
 *
 * ## Why this is a closed list rather than a sweep
 *
 * A hundred and eighteen relations point at `User`, and they are three different kinds of thing:
 *
 *   - **live ownership** — the account they run, the ticket queued to them, the lead they are
 *     working. This is the list below, and it is the only kind that may move.
 *   - **history** — who created, approved, verified, recorded, allocated or closed something.
 *     Rewriting any of these falsifies the record. Who approved that order is a fact about what
 *     happened, not a statement about who is responsible now.
 *   - **their own records** — payslips, attendance, leave balances, their expenses and visits,
 *     incentive earnings, the final settlement. These *are* theirs. Reassigning a payslip hands
 *     one person's salary history to another.
 *
 * A generic "update everything pointing at this user" gets two of those three catastrophically
 * wrong, and both failures are silent. So nothing here is derived: an area exists because somebody
 * decided it should, and anything not listed cannot be moved by this feature at all.
 *
 * ## Why targets are absent
 *
 * A sales target is a measurement of a person, not work assigned to them. Moving a departing rep's
 * quota onto their successor overstates the successor and erases the leaver — both sets of numbers
 * become fiction. A target needs closing or prorating, which is a different decision on a different
 * screen.
 *
 * ## Counting and moving are the same query
 *
 * `hold()` is what the preview counts and what `give()` is handed. They cannot disagree, which is
 * the failure that makes a preview worthless — the screen promising eleven and the writer moving
 * nine, with nothing saying which two were left behind.
 */

export type HandoverContext = {
  /** Who is performing the handover — recorded on anything that keeps provenance. */
  actorId: string;
  /** Whose work is moving. */
  fromUserId: string;
};

export type HandoverArea = {
  key: string;
  label: string;
  /** What moves, and — where it is not obvious — what deliberately stays put. */
  detail: string;
  /**
   * Whether sharing this area between several people is sensible.
   *
   * False where splitting would do damage rather than just look odd: a calling list split between
   * three owners has no owner, and an asset is a physical object in one person's hands.
   */
  splittable: boolean;
  /** The open records this person holds. Ordered so that a split is stable between preview and apply. */
  hold(client: Prisma.TransactionClient, userId: string): Promise<Allocatable[]>;
  /** Point these records at `toUserId`. Called once per successor, inside the transaction. */
  give(
    tx: Prisma.TransactionClient,
    ids: string[],
    toUserId: string,
    ctx: HandoverContext,
  ): Promise<void>;
};

/** A lost or won lead is history and stays with whoever worked it. */
const CLOSED_LEAD: LeadStatus[] = ["WON", "LOST", "DISQUALIFIED"];
/** Tickets somebody still has to do something about. */
const OPEN_TICKET: TicketStatus[] = ["OPEN", "IN_PROGRESS", "ON_HOLD"];
/** Documents still in play. A paid invoice names the person who sold it, and that is a fact. */
const LIVE_DOCUMENT: TradeDocumentStatus[] = ["DRAFT", "ISSUED"];
/** Calling rows not yet worked. A completed call belongs to the caller who made it. */
const UNWORKED_RECORD: WorkbookRecordStatus[] = ["PENDING", "IN_PROGRESS"];
/** Candidates still in the pipeline. */
const LIVE_CANDIDATE: CandidateStatus[] = ["PROSPECT", "OFFERED", "ACCEPTED"];

const byId = { id: "asc" } as const;

export const HANDOVER_AREAS: HandoverArea[] = [
  {
    key: "accounts-owned",
    label: "Accounts they own",
    detail: "The customer relationship — who the account belongs to, and who its quotes default to.",
    splittable: true,
    hold: (c, userId) =>
      c.company.findMany({ where: { ownerUserId: userId }, orderBy: byId, select: { id: true } }),
    give: (tx, ids, toUserId) =>
      tx.company.updateMany({ where: { id: { in: ids } }, data: { ownerUserId: toUserId } }).then(() => undefined),
  },
  {
    key: "accounts-assigned",
    label: "Accounts assigned to them",
    detail: "Working assignment, which is separate from ownership — an account can have both.",
    splittable: true,
    hold: (c, userId) =>
      c.company.findMany({
        where: { assignedToUserId: userId },
        orderBy: byId,
        select: { id: true, ownerUserId: true },
      }),
    give: (tx, ids, toUserId, ctx) =>
      tx.company
        .updateMany({
          where: { id: { in: ids } },
          // `assignedBy` becomes whoever ran the handover, because that is who actually decided it.
          data: { assignedToUserId: toUserId, assignedByUserId: ctx.actorId, assignedAt: new Date() },
        })
        .then(() => undefined),
  },
  {
    key: "leads",
    label: "Open leads",
    detail: "Everything still in the pipeline. Won, lost and disqualified leads stay where they are.",
    splittable: true,
    hold: (c, userId) =>
      c.lead.findMany({
        where: { ownerUserId: userId, status: { notIn: CLOSED_LEAD } },
        orderBy: byId,
        select: { id: true, companyId: true },
      }).then((rows) => rows.map((r) => ({ id: r.id }))),
    give: (tx, ids, toUserId) =>
      tx.lead.updateMany({ where: { id: { in: ids } }, data: { ownerUserId: toUserId } }).then(() => undefined),
  },
  {
    key: "tickets",
    label: "Open tickets",
    detail: "Open, in progress and on hold. Resolved and closed tickets keep the agent who worked them.",
    splittable: true,
    hold: (c, userId) =>
      c.ticket.findMany({
        where: { assignedToUserId: userId, status: { in: OPEN_TICKET } },
        orderBy: byId,
        select: { id: true },
      }),
    give: (tx, ids, toUserId) =>
      tx.ticket.updateMany({ where: { id: { in: ids } }, data: { assignedToUserId: toUserId } }).then(() => undefined),
  },
  {
    key: "tasks",
    label: "Open tasks",
    detail: "Anything not ticked off, including renewal follow-ups and their own offboarding steps.",
    splittable: true,
    hold: (c, userId) =>
      c.task.findMany({ where: { assignedToUserId: userId, done: false }, orderBy: byId, select: { id: true } }),
    give: (tx, ids, toUserId) =>
      tx.task.updateMany({ where: { id: { in: ids } }, data: { assignedToUserId: toUserId } }).then(() => undefined),
  },
  {
    key: "documents",
    label: "Live quotes and invoices",
    detail:
      "Drafts and issued documents where they are the named salesperson — this is whose email and phone the customer is given. Paid and cancelled documents are left alone.",
    splittable: true,
    hold: (c, userId) =>
      c.tradeDocument.findMany({
        where: { salespersonId: userId, status: { in: LIVE_DOCUMENT } },
        orderBy: byId,
        select: { id: true },
      }),
    give: (tx, ids, toUserId) =>
      tx.tradeDocument.updateMany({ where: { id: { in: ids } }, data: { salespersonId: toUserId } }).then(() => undefined),
  },
  {
    key: "calling-lists",
    label: "Calling lists they built",
    detail: "Ownership of the list itself — who may re-share it and see its results.",
    // A list with three owners has none: re-sharing and the results view both assume one.
    splittable: false,
    hold: (c, userId) =>
      c.workbook.findMany({ where: { ownerUserId: userId }, orderBy: byId, select: { id: true } }),
    give: (tx, ids, toUserId) =>
      tx.workbook.updateMany({ where: { id: { in: ids } }, data: { ownerUserId: toUserId } }).then(() => undefined),
  },
  {
    key: "calling-records",
    label: "Calls queued to them",
    detail: "Rows they had not reached yet. Records they already called keep their name and their timings.",
    splittable: true,
    hold: (c, userId) =>
      c.workbookRecord.findMany({
        where: { assignedToUserId: userId, status: { in: UNWORKED_RECORD } },
        orderBy: byId,
        select: { id: true },
      }),
    give: (tx, ids, toUserId) =>
      tx.workbookRecord.updateMany({ where: { id: { in: ids } }, data: { assignedToUserId: toUserId } }).then(() => undefined),
  },
  {
    key: "reports",
    label: "People who report to them",
    detail:
      "Their direct reports need a manager, or leave requests and expense claims submit into a void.",
    splittable: true,
    hold: (c, userId) =>
      c.user.findMany({ where: { managerId: userId, active: true }, orderBy: byId, select: { id: true } }),
    give: (tx, ids, toUserId) =>
      tx.user.updateMany({ where: { id: { in: ids } }, data: { managerId: toUserId } }).then(() => undefined),
  },
  {
    key: "candidates",
    label: "Hiring they are running",
    detail: "Candidates still in the pipeline, as owner or as hiring manager.",
    splittable: true,
    hold: (c, userId) =>
      c.candidate.findMany({
        where: {
          status: { in: LIVE_CANDIDATE },
          OR: [{ ownerId: userId }, { managerId: userId }],
        },
        orderBy: byId,
        select: { id: true },
      }),
    give: async (tx, ids, toUserId, ctx) => {
      // Two columns, and a candidate can be on both. Each is moved only where it actually pointed
      // at the leaver, so somebody who was only the hiring manager does not silently become owner.
      await tx.candidate.updateMany({ where: { id: { in: ids }, ownerId: ctx.fromUserId }, data: { ownerId: toUserId } });
      await tx.candidate.updateMany({ where: { id: { in: ids }, managerId: ctx.fromUserId }, data: { managerId: toUserId } });
    },
  },
  {
    key: "inbound-forms",
    label: "Forms they own or that route to them",
    detail:
      "Event invitations, assessments and enquiry forms they built, and the ones whose new answers land with them. Left on a closed account, nobody can share the form or read what comes in.",
    splittable: false,
    hold: (c, userId) =>
      c.inboundForm.findMany({
        where: { OR: [{ assignToUserId: userId }, { ownerUserId: userId }] },
        orderBy: byId,
        select: { id: true },
      }),
    give: async (tx, ids, toUserId, ctx) => {
      // Two columns, each moved only where it pointed at the leaver — somebody who only received a
      // form's enquiries does not silently become the owner of it.
      await tx.inboundForm.updateMany({ where: { id: { in: ids }, assignToUserId: ctx.fromUserId }, data: { assignToUserId: toUserId } });
      await tx.inboundForm.updateMany({ where: { id: { in: ids }, ownerUserId: ctx.fromUserId }, data: { ownerUserId: toUserId } });
    },
  },
  {
    key: "vault-credentials",
    label: "Stored logins they own",
    detail:
      "Registrar, hosting and portal passwords on their name. Moved to the new owner and flagged for a change within fifteen days — a password somebody took with them when they left is not secret any more, whatever the rotation policy says.",
    /**
     * Splittable, and usually should be: the domains person takes the registrar logins and the
     * accounts person takes the tax portals. One successor inheriting forty unrelated passwords
     * is how a leaver's account is replaced by a single point of failure.
     */
    splittable: true,
    hold: (c, userId) => c.vaultCredential.findMany({ where: { ownerId: userId }, orderBy: byId, select: { id: true } }),
    give: async (tx, ids, toUserId) => {
      if (ids.length === 0) return;
      const rotateBy = new Date(Date.now() + HANDOVER_ROTATION_DAYS * 86400000);
      await tx.vaultCredential.updateMany({
        where: { id: { in: ids } },
        data: {
          ownerId: toUserId,
          /**
           * The deadline goes on the record rather than into a notification, because a
           * notification is read once and a deadline is still there in March. `rotateBy` is
           * separate from the record's own `rotateAfterDays` so the standing policy survives
           * intact — this is a fact about an event, not a change of policy.
           */
          rotateBy,
          rotateReason: "The previous owner left. Whatever this opens, they still know the password.",
        },
      });
    },
  },
  {
    key: "vault-shares",
    label: "Stored logins shared with them",
    detail:
      "Passwords somebody else owns but granted them access to. The grant moves to the successor and the leaver’s is removed — handing over what they owned while leaving what they were lent would close the front door and leave a window open.",
    splittable: true,
    hold: (c, userId) => c.vaultShare.findMany({ where: { userId }, orderBy: byId, select: { id: true } }),
    give: async (tx, ids, toUserId) => {
      if (ids.length === 0) return;
      const shares = await tx.vaultShare.findMany({
        where: { id: { in: ids } },
        select: { id: true, credentialId: true, level: true, expiresAt: true },
      });

      for (const share of shares) {
        /**
         * One share per person per credential, enforced by a unique index. So a successor who
         * already has access keeps what they have and the leaver’s row is simply removed —
         * re-pointing it would fail the constraint and take the whole handover down with it.
         */
        const existing = await tx.vaultShare.findUnique({
          where: { credentialId_userId: { credentialId: share.credentialId, userId: toUserId } },
          select: { id: true, level: true },
        });

        if (existing) {
          // Except where the inherited grant is the stronger one. Losing the ability to share a
          // password on because you already had a weaker grant would be a silent demotion.
          if (share.level === "MANAGE" && existing.level !== "MANAGE") {
            await tx.vaultShare.update({ where: { id: existing.id }, data: { level: "MANAGE" } });
          }
          await tx.vaultShare.delete({ where: { id: share.id } });
          continue;
        }

        await tx.vaultShare.update({ where: { id: share.id }, data: { userId: toUserId } });
      }
    },
  },
  {
    key: "assets",
    label: "Equipment in their custody",
    detail:
      "Laptops, phones and access cards on their name. Recorded as a movement the new holder has to confirm, not a silent change of column.",
    // A physical object is in one person's hands. Splitting is meaningless.
    splittable: false,
    hold: (c, userId) =>
      c.asset.findMany({ where: { custodianUserId: userId }, orderBy: byId, select: { id: true } }),
    give: async (tx, ids, toUserId, ctx) => {
      const assets = await tx.asset.findMany({
        where: { id: { in: ids } },
        select: { id: true, siteCompanyId: true, locationId: true },
      });
      // Through the movement ledger rather than the column, because custody is a claim about the
      // physical world. `acknowledgeMovement` is how the register learns it was actually true —
      // otherwise it confidently states that somebody holds a laptop they have never seen.
      await tx.assetMovement.createMany({
        data: assets.map((asset) => ({
          assetId: asset.id,
          type: "ASSIGNED" as const,
          occurredAt: new Date(),
          fromUserId: ctx.fromUserId,
          fromCompanyId: asset.siteCompanyId,
          fromLocationId: asset.locationId,
          toUserId,
          note: "Handover",
          recordedById: ctx.actorId,
        })),
      });
      await tx.asset.updateMany({
        where: { id: { in: ids } },
        data: { custodianUserId: toUserId, status: "ASSIGNED" },
      });
    },
  },
];

export const areaByKey = new Map(HANDOVER_AREAS.map((a) => [a.key, a]));
