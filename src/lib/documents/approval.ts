import type { DocumentApprovalStatus, TradeDocumentType } from "@prisma/client";

/**
 * Who may sign off a document, and what may be done to it while it waits.
 *
 * Pure, and kept apart from the actions for the usual reason: this is the part that decides whether
 * an invoice can leave the building, and it should be checkable without a database, a session or a
 * running app.
 *
 * ## Why the policy is the authority, and not a permission key
 *
 * Every other gate in this app is an RBAC permission, and this one deliberately is not. "Who can
 * approve an invoice" is already a question the policy answers three ways — by role, by name, and up
 * the reporting line — and the third of those is per-document, which no permission key can express:
 * Rahul's invoice needs Priya, Sana's needs Amit, and they are the same key. Adding a permission
 * beside the policy would mean configuring the same rule in two screens and fielding "she has the
 * permission, why is the button greyed out?".
 *
 * What stays in RBAC is `settings.manage`, which guards *editing* the policy — the policy decides
 * who approves, and RBAC decides who decides.
 */

export type ApprovalPolicy = {
  docType: TradeDocumentType;
  enabled: boolean;
  approverRoles: string[];
  approverUserIds: string[];
  managerApproves: boolean;
  /** Only documents worth more than this, in rupees with GST, need approval. Null: no value rule. */
  minValue: number | null;
  /** Any line discounted by more than this percent needs approval. Null: no discount rule. */
  maxDiscountPercent: number | null;
};

/** The resting policy for a type nobody has configured: approval off, so nothing changes. */
export function defaultApprovalPolicy(docType: TradeDocumentType): ApprovalPolicy {
  return { docType, enabled: false, approverRoles: [], approverUserIds: [], managerApproves: false, minValue: null, maxDiscountPercent: null };
}

/** What about a document decides whether it needs approval — see `approvalRequirement`. */
export type ApprovalDocument = {
  /** Its total including GST, in rupees — a foreign-currency quote at the rate it was written at. */
  valueInr: number;
  /** Each line's discount as a percent of that line before discount. */
  lineDiscountPercents: number[];
};

export type ApprovalRequirement = { required: boolean; why: string };

const inr = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
const percent = (n: number) => `${Math.round(n * 100) / 100}%`;

/**
 * Whether this particular document needs sign-off.
 *
 * With approval on and no thresholds, every document does — the behaviour before thresholds
 * existed. With thresholds, a document needs it when it breaks **either** rule:
 *
 *   · worth more than the value limit (GST included, in rupees), or
 *   · any line discounted by more than the discount limit — which catches the small quote given
 *     away at a loss, the one a value limit alone waves through.
 *
 * Setting only the discount rule means "approve heavy discounts, whatever the size". At the limit
 * exactly is under it: "above ₹2,00,000" means ₹2,00,000 itself goes straight through.
 *
 * Asked about the document as it is *now*, at submitting and again at issuing — which is what stops
 * a small approved quote from being edited up past the limit and issued on the old signature.
 */
export function approvalRequirement(policy: ApprovalPolicy, document: ApprovalDocument): ApprovalRequirement {
  if (!policy.enabled) return { required: false, why: "This kind of document doesn't need approval." };
  const { minValue, maxDiscountPercent } = policy;
  if (minValue === null && maxDiscountPercent === null) {
    return { required: true, why: "Every document of this kind needs approval." };
  }
  const worstDiscount = Math.max(0, ...document.lineDiscountPercents);
  const reasons: string[] = [];
  if (minValue !== null && document.valueInr > minValue) reasons.push(`it is over the ${inr(minValue)} approval limit`);
  // A hair of tolerance, so a 10% discount entered as an amount doesn't read as 10.0000001%.
  if (maxDiscountPercent !== null && worstDiscount > maxDiscountPercent + 0.005) {
    reasons.push(`a line is discounted ${percent(worstDiscount)}, more than the ${percent(maxDiscountPercent)} allowed without approval`);
  }
  if (reasons.length > 0) return { required: true, why: `Needs approval: ${reasons.join(", and ")}.` };
  const within = [
    minValue !== null ? `it is within the ${inr(minValue)} approval limit` : null,
    maxDiscountPercent !== null ? `no line is discounted more than ${percent(maxDiscountPercent)}` : null,
  ].filter(Boolean);
  return { required: false, why: `No approval needed — ${within.join(", and ")}.` };
}

export type ApprovalActor = {
  id: string;
  role: string;
  isSuperAdmin: boolean;
};

export type ApprovalSubject = {
  /** Who asked for sign-off. Null before anybody has. */
  submittedById: string | null;
  /**
   * The submitter's managers, nearest first.
   *
   * The whole chain rather than the immediate manager alone, so a document does not become
   * unapprovable because one person is on leave — and so a senior manager is never locked out of
   * something two levels below them.
   */
  submitterManagerIds: string[];
};

export type ApprovalVerdict = {
  may: boolean;
  /** Which rule allowed it, for the audit line and for explaining a refusal. */
  reason:
    | "super-admin"
    /** A super admin signing off their own — recorded distinctly, see `mayApprove`. */
    | "super-admin-own"
    | "role"
    | "named"
    | "manager"
    | "not-an-approver"
    | "own-document"
    | "approval-not-enabled";
};

/**
 * Whether this person may approve this document.
 *
 * The three configured routes are additive — any one is enough. Two rules stand above them:
 *
 *   · **An ordinary approver cannot approve their own.** A control the controlled person can wave
 *     through is not a control, and this is where most of the feature's value sits.
 *   · **A super admin can**, including their own, by explicit decision. In a company where the
 *     person who raises the quotation is also the person who signs it off, blocking it just means
 *     the document never moves — and a rule people route around is worse than one that admits its
 *     own exception. The trade-off is real and is handled by recording it rather than preventing it:
 *     a self-approval comes back as `super-admin-own`, which the audit line names in as many words,
 *     so "who approved their own work" stays an answerable question.
 */
export function mayApprove(params: {
  policy: ApprovalPolicy;
  actor: ApprovalActor;
  subject: ApprovalSubject;
}): ApprovalVerdict {
  const { policy, actor, subject } = params;

  if (!policy.enabled) return { may: false, reason: "approval-not-enabled" };

  const isOwn = Boolean(subject.submittedById && subject.submittedById === actor.id);

  // Checked before the own-document rule, which is what lets a super admin sign off their own.
  if (actor.isSuperAdmin) return { may: true, reason: isOwn ? "super-admin-own" : "super-admin" };

  if (isOwn) return { may: false, reason: "own-document" };

  if (policy.approverUserIds.includes(actor.id)) return { may: true, reason: "named" };
  if (policy.approverRoles.includes(actor.role)) return { may: true, reason: "role" };
  if (policy.managerApproves && subject.submitterManagerIds.includes(actor.id)) {
    return { may: true, reason: "manager" };
  }

  return { may: false, reason: "not-an-approver" };
}

/**
 * Whether this document is allowed to be issued.
 *
 * Issuing commits the number to a GST series and, for an invoice, files with the portal — it is the
 * irreversible step, so it is the one the gate belongs on. Submitting, editing and converting are
 * all still free while a document waits.
 */
export function mayIssue(params: {
  policy: ApprovalPolicy;
  approvalStatus: DocumentApprovalStatus;
  /** The document as it stands. Left out, every document of an approved-for type is taken to need it. */
  document?: ApprovalDocument;
}): { may: boolean; why: string | null } {
  if (!params.policy.enabled) return { may: true, why: null };
  if (params.document && !approvalRequirement(params.policy, params.document).required) return { may: true, why: null };
  if (params.approvalStatus === "APPROVED") return { may: true, why: null };

  const why =
    params.approvalStatus === "PENDING"
      ? "This is still waiting for approval."
      : params.approvalStatus === "REJECTED"
        ? "This was sent back. Make the changes and submit it again."
        : "This needs approving before it can be issued. Submit it for approval first.";
  return { may: false, why };
}

/**
 * What an edit does to a document's sign-off.
 *
 * An approved document that is then changed is no longer the document that was approved, so the
 * approval does not travel with it. This is not a nicety: without it somebody gets a small quote
 * signed off and edits the figure afterwards, and the record shows an approver who never saw the
 * number they appear to have agreed to.
 *
 * A pending one is left alone — it has not been agreed to yet, so there is nothing to invalidate,
 * and knocking it back to NOT_SUBMITTED would quietly withdraw a request somebody is waiting on.
 */
export function approvalAfterEdit(current: DocumentApprovalStatus): DocumentApprovalStatus {
  return current === "APPROVED" ? "NOT_SUBMITTED" : current;
}

/** Whether sign-off can be asked for. Re-submitting after a rejection is the normal path. */
export function maySubmit(params: {
  policy: ApprovalPolicy;
  approvalStatus: DocumentApprovalStatus;
  isDraft: boolean;
  document?: ApprovalDocument;
}): { may: boolean; why: string | null } {
  if (!params.policy.enabled) return { may: false, why: "This kind of document doesn't need approval." };
  // Nothing to ask for: under the limits, it can simply be issued.
  if (params.document) {
    const requirement = approvalRequirement(params.policy, params.document);
    if (!requirement.required) return { may: false, why: requirement.why };
  }
  if (!params.isDraft) return { may: false, why: "Only a draft can be submitted for approval." };
  if (params.approvalStatus === "PENDING") return { may: false, why: "It's already waiting for approval." };
  if (params.approvalStatus === "APPROVED") return { may: false, why: "It's already approved." };
  return { may: true, why: null };
}

export const approvalStatusLabels: Record<DocumentApprovalStatus, string> = {
  NOT_SUBMITTED: "Not submitted",
  PENDING: "Pending approval",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

export const approvalStatusTone: Record<DocumentApprovalStatus, "default" | "amber" | "green" | "red"> = {
  NOT_SUBMITTED: "default",
  PENDING: "amber",
  APPROVED: "green",
  REJECTED: "red",
};
