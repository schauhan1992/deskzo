import type { ConsentStatus, MessageChannel, MessageClass, MarketingTopic, SuppressionReason } from "@prisma/client";

/**
 * Whether anything may be sent to anybody, and if not, why not.
 *
 * The single most important file in the module, and the only place that decides. Two failures it
 * exists to prevent, both of which are silent:
 *
 *   · Reaching a reseller's end customer. The reseller owns that relationship; a mail from us goes
 *     round our own partner. `src/lib/reseller.ts` has said so since before there was anything to
 *     send, and nothing here may override it.
 *   · Mailing somebody an offer while their complaint sits unanswered, or their machine is still
 *     broken. Technically a successful send. Commercially, the worst mail we could possibly write.
 *
 * Two design rules worth stating:
 *
 *   · **Every reason is returned, not the first one.** A dry run that says "112 suppressed" is not
 *     actionable; "40 unsubscribed, 30 never consented, 42 unverified addresses" is three different
 *     jobs for three different people.
 *   · **Derived reasons are computed fresh, stored ones are facts we were told.** An unsubscribe is
 *     a row. An unresolved complaint is not — so resolving it restores marketability the moment it
 *     is resolved, rather than needing somebody to remember to delete something.
 */

export type SuppressionKey =
  | "RESELLER_MANAGED"
  | "NO_ADDRESS"
  | "INVALID_ADDRESS"
  | "HARD_BOUNCE"
  | "COMPLAINT"
  | "UNSUBSCRIBED"
  | "MANUAL"
  | "NO_CONSENT"
  | "UNVERIFIED_ADDRESS"
  | "UNANSWERED_COMPLAINT"
  | "OVERDUE_INVOICE"
  | "SLA_BREACH"
  | "FREQUENCY_CAP";

export type SuppressionFinding = {
  key: SuppressionKey;
  label: string;
  detail: string;
  /**
   * Whether this would block a transactional message too. A finding is only ever raised for a
   * class it actually blocks, so its presence is the decision; `hard` says whether it could ever
   * be argued with. A bounced address is hard — the mailbox does not exist, whatever we want to
   * tell them. An unsubscribe is soft: they opted out of offers, not out of being a customer.
   */
  hard: boolean;
};

/**
 * Worst first. The order decides which single reason is written onto the message row, so it has to
 * put the one somebody would act on first: "they are a reseller's customer" before "we have mailed
 * them twice already this week".
 */
const PRECEDENCE: SuppressionKey[] = [
  "RESELLER_MANAGED",
  "NO_ADDRESS",
  "INVALID_ADDRESS",
  "HARD_BOUNCE",
  "COMPLAINT",
  "UNSUBSCRIBED",
  "MANUAL",
  "UNANSWERED_COMPLAINT",
  "SLA_BREACH",
  "OVERDUE_INVOICE",
  "NO_CONSENT",
  "UNVERIFIED_ADDRESS",
  "FREQUENCY_CAP",
];

export const suppressionLabels: Record<SuppressionKey, string> = {
  RESELLER_MANAGED: "Reseller's customer",
  NO_ADDRESS: "No address",
  INVALID_ADDRESS: "Address doesn't work",
  HARD_BOUNCE: "Bounced before",
  COMPLAINT: "Marked us as spam",
  UNSUBSCRIBED: "Unsubscribed",
  MANUAL: "Suppressed by hand",
  NO_CONSENT: "Never opted in",
  UNVERIFIED_ADDRESS: "Address not verified",
  UNANSWERED_COMPLAINT: "Complaint unanswered",
  OVERDUE_INVOICE: "Invoice overdue",
  SLA_BREACH: "Ticket past its SLA",
  FREQUENCY_CAP: "Heard from us too recently",
};

/** What the recipient looks like from the send pipeline's point of view. */
export type RecipientState = {
  company: { managedByResellerId: string | null };
  contact: {
    email: string | null;
    phone: string | null;
    /** The stored verdict, and the address it was reached on. */
    emailStatus: string;
    emailCheckedValue: string | null;
  };
  /** Stored suppressions already matched to this contact, its address, company or domain. */
  suppressions: { reason: SuppressionReason }[];
  /** The consent row for this exact channel and topic, if there is one. */
  consent: { status: ConsentStatus } | null;
  signals: {
    /** Feedback at 3 or below that nobody has answered. */
    unansweredFeedback: number;
    /** Days past due on the oldest unsettled invoice, or null if nothing is overdue. */
    daysOverdue: number | null;
    /** Open tickets past their SLA. */
    breachedTickets: number;
    /** Marketing messages already sent to this contact in the last seven days. */
    sentInLastWeek: number;
  };
};

export type SendContext = {
  messageClass: MessageClass;
  channel: MessageChannel;
  topic: MarketingTopic;
  limits: {
    maxPerContactPerWeek: number;
    /** An invoice this far past due stops the offers. 0 disables the rule. */
    overdueDaysBlock: number;
    /** Marketing to an address with no current verdict. Off is the permissive setting. */
    requireVerifiedAddress: boolean;
  };
};

/**
 * A stored verdict belongs to the address it was run against.
 *
 * Copied deliberately from `emailCheckState` in src/lib/email-verification.ts rather than imported,
 * because that module is shared with client components and this one must stay dependency-free —
 * but the rule has to be identical, or a contact would be marketable here and unverified there.
 */
function verdictApplies(contact: RecipientState["contact"]): boolean {
  const current = contact.email?.trim().toLowerCase() ?? null;
  const checked = contact.emailCheckedValue?.trim().toLowerCase() ?? null;
  return current !== null && checked !== null && current === checked;
}

export function suppressionReasons(state: RecipientState, ctx: SendContext): SuppressionFinding[] {
  const found: SuppressionFinding[] = [];
  const add = (key: SuppressionKey, detail: string, hard: boolean) =>
    found.push({ key, label: suppressionLabels[key], detail, hard });

  const marketing = ctx.messageClass === "MARKETING";
  const needsEmail = ctx.channel === "EMAIL";
  const needsPhone = ctx.channel === "WHATSAPP";

  // ── Hard, and not negotiable ───────────────────────────────────────────────

  // First, and never overridable. Not even for a transactional message: if a reseller's customer
  // needs telling something, the reseller tells them.
  if (state.company.managedByResellerId !== null) {
    add("RESELLER_MANAGED", "This company belongs to a reseller. Everything goes through them.", true);
  }

  if (needsEmail && !state.contact.email?.trim()) {
    add("NO_ADDRESS", "No email address on this contact.", true);
  }
  if (needsPhone && !state.contact.phone?.trim()) {
    add("NO_ADDRESS", "No phone number on this contact.", true);
  }

  if (needsEmail && verdictApplies(state.contact) && state.contact.emailStatus === "INVALID") {
    add("INVALID_ADDRESS", "The address was checked and doesn't work.", true);
  }

  for (const s of state.suppressions) {
    if (s.reason === "HARD_BOUNCE") {
      // Hard for every class. A bounced address does not work, whatever we want to tell them.
      add("HARD_BOUNCE", "Mail to this address bounced. Get a new one before trying again.", true);
    }
    if (s.reason === "COMPLAINT") {
      add("COMPLAINT", "They marked us as spam. Sending again risks the whole domain.", true);
    }
    // Marketing only, both of them. Somebody who unsubscribed from offers has not asked to stop
    // receiving their own invoices, and treating the two as one is how an opt-out turns into a
    // customer not being told their subscription lapsed.
    if (s.reason === "UNSUBSCRIBED" && marketing) {
      add("UNSUBSCRIBED", "They asked us to stop sending marketing.", false);
    }
    if (s.reason === "MANUAL" && marketing) {
      add("MANUAL", "Somebody here suppressed this address by hand.", false);
    }
  }

  // ── Marketing only, from here down ─────────────────────────────────────────
  if (!marketing) return order(found);

  if (!state.consent || state.consent.status !== "SUBSCRIBED") {
    add(
      "NO_CONSENT",
      state.consent?.status === "UNSUBSCRIBED"
        ? "They opted out of this topic."
        : "No recorded consent for this topic.",
      false,
    );
  }

  if (needsEmail && ctx.limits.requireVerifiedAddress && !verdictApplies(state.contact)) {
    add("UNVERIFIED_ADDRESS", "The address has never been checked, or has changed since.", false);
  }
  if (needsEmail && verdictApplies(state.contact) && state.contact.emailStatus === "RISKY") {
    add("UNVERIFIED_ADDRESS", "A shared or free-provider address — it reaches someone, but not reliably them.", false);
  }

  // The three that stop a sales message going to somebody we have already let down. Each is
  // derived, so fixing the underlying problem un-suppresses them immediately.
  if (state.signals.unansweredFeedback > 0) {
    add(
      "UNANSWERED_COMPLAINT",
      `${state.signals.unansweredFeedback} piece(s) of feedback at 3 or below that nobody has answered. Answer it first.`,
      false,
    );
  }
  if (state.signals.breachedTickets > 0) {
    add(
      "SLA_BREACH",
      `${state.signals.breachedTickets} open ticket(s) past the SLA. Fix it before selling them anything.`,
      false,
    );
  }
  if (
    ctx.limits.overdueDaysBlock > 0 &&
    state.signals.daysOverdue !== null &&
    state.signals.daysOverdue >= ctx.limits.overdueDaysBlock
  ) {
    add("OVERDUE_INVOICE", `An invoice is ${state.signals.daysOverdue} days overdue. Accounts should go first.`, false);
  }

  if (state.signals.sentInLastWeek >= ctx.limits.maxPerContactPerWeek) {
    add(
      "FREQUENCY_CAP",
      `Already had ${state.signals.sentInLastWeek} from us this week, and the cap is ${ctx.limits.maxPerContactPerWeek}.`,
      false,
    );
  }

  return order(found);
}

function order(found: SuppressionFinding[]): SuppressionFinding[] {
  // Deduplicated, because two stored suppressions can raise the same key.
  const seen = new Set<SuppressionKey>();
  return PRECEDENCE.flatMap((key) => {
    const hit = found.find((f) => f.key === key);
    if (!hit || seen.has(key)) return [];
    seen.add(key);
    return [hit];
  });
}

export type SendVerdict =
  | { ok: true; findings: [] }
  | { ok: false; reason: SuppressionKey; detail: string; findings: SuppressionFinding[] };

/** The decision, with the worst reason named and everything else kept for the breakdown. */
export function canSend(state: RecipientState, ctx: SendContext): SendVerdict {
  const findings = suppressionReasons(state, ctx);
  if (findings.length === 0) return { ok: true, findings: [] };
  const worst = findings[0];
  return { ok: false, reason: worst.key, detail: worst.detail, findings };
}

/** The dry-run breakdown: how many, and for what. Sorted worst first, like the findings are. */
export function summariseSuppressions(
  verdicts: SendVerdict[],
): { sendable: number; suppressed: number; byReason: { key: SuppressionKey; label: string; count: number }[] } {
  const counts = new Map<SuppressionKey, number>();
  let sendable = 0;
  for (const v of verdicts) {
    if (v.ok) {
      sendable += 1;
      continue;
    }
    counts.set(v.reason, (counts.get(v.reason) ?? 0) + 1);
  }
  return {
    sendable,
    suppressed: verdicts.length - sendable,
    byReason: PRECEDENCE.filter((k) => counts.has(k)).map((key) => ({
      key,
      label: suppressionLabels[key],
      count: counts.get(key)!,
    })),
  };
}
