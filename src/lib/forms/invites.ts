import type { FormAttendance, FormCategory, MarketingTopic } from "@prisma/client";
import { canSend, type RecipientState, type SendContext } from "@/lib/marketing/suppression";
import { TOPICS } from "@/lib/marketing/topics";

/**
 * Invitations, RSVPs and the attendance register — the rules, without the database.
 *
 * ## Why an invitation is sent as a personal message, not as marketing
 *
 * Somebody here picks a named customer and asks them to a roundtable, or to answer the questions
 * before a proposal. That is a one-to-one business message from their account team, not a mailshot,
 * so it does not wait for a recorded marketing consent that almost no existing customer has — a rule
 * that would make the feature useless on day one.
 *
 * It is not a free pass either. Everything that stops a service notice stops an invitation — a
 * reseller's customer, a bounced address, a spam complaint, an address checked and found dead — and
 * so do three things a notice ignores, because an invitation is closer to marketing than a notice is:
 *
 *   · they unsubscribed from our marketing;
 *   · somebody here suppressed the address by hand;
 *   · they opted out of this form's topic (events, for an event) in the preference centre.
 *
 * Asked once and answered here, so the invite dialog and the sender cannot disagree about who is
 * reachable.
 */

export type InviteBlock = { ok: true } | { ok: false; reason: string };

export function inviteVerdict(
  state: RecipientState,
  ctx: Pick<SendContext, "limits"> & { topic: MarketingTopic },
): InviteBlock {
  const base = canSend(state, { messageClass: "TRANSACTIONAL", channel: "EMAIL", topic: ctx.topic, limits: ctx.limits });
  if (!base.ok) return { ok: false, reason: base.detail };

  if (state.suppressions.some((s) => s.reason === "UNSUBSCRIBED")) {
    return { ok: false, reason: "They asked us to stop sending marketing." };
  }
  if (state.suppressions.some((s) => s.reason === "MANUAL")) {
    return { ok: false, reason: "Somebody here suppressed this address by hand." };
  }
  if (state.consent?.status === "UNSUBSCRIBED") {
    const topic = TOPICS.find((t) => t.key === ctx.topic)?.label.toLowerCase() ?? "this topic";
    return { ok: false, reason: `They opted out of ${topic}.` };
  }
  return { ok: true };
}

/**
 * Reminding the same person twice inside ten minutes is a double-click, not a decision.
 */
export const REMINDER_GAP_MS = 10 * 60_000;

export function tooSoonToResend(lastSentAt: Date | string | null, now: Date): boolean {
  return lastSentAt !== null && now.getTime() - new Date(lastSentAt).getTime() < REMINDER_GAP_MS;
}

export function inviteLink(origin: string, slug: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/forms/${encodeURIComponent(slug)}/${token}`;
}

// ─── Status ──────────────────────────────────────────────────────────────────

export type InviteStatusKey = "WITHDRAWN" | "COMING" | "NOT_COMING" | "ANSWERED" | "OPENED" | "SENT" | "NOT_SENT";

export const INVITE_STATUS: Record<InviteStatusKey, { label: string; tone: "default" | "green" | "blue" | "red" | "amber" }> = {
  WITHDRAWN: { label: "Withdrawn", tone: "default" },
  COMING: { label: "Coming", tone: "green" },
  NOT_COMING: { label: "Can't make it", tone: "amber" },
  ANSWERED: { label: "Answered", tone: "green" },
  OPENED: { label: "Link opened", tone: "blue" },
  SENT: { label: "Sent", tone: "default" },
  NOT_SENT: { label: "Not sent yet", tone: "red" },
};

type InviteFacts = {
  revokedAt: Date | string | null;
  openedAt: Date | string | null;
  lastSentAt: Date | string | null;
  submission: { attending: boolean | null } | null;
};

/**
 * Derived, never stored. An answer beats everything but a withdrawal, and on an event the answer is
 * the RSVP — "answered" says nothing about whether to keep them a seat.
 */
export function inviteStatus(invite: InviteFacts, category: FormCategory): InviteStatusKey {
  if (invite.revokedAt) return "WITHDRAWN";
  if (invite.submission) {
    if (category !== "EVENT") return "ANSWERED";
    return invite.submission.attending === false ? "NOT_COMING" : "COMING";
  }
  if (invite.openedAt) return "OPENED";
  return invite.lastSentAt ? "SENT" : "NOT_SENT";
}

// ─── Being open ──────────────────────────────────────────────────────────────

export type OpenState = { open: true } | { open: false; message: string };

/**
 * Whether the form is taking answers now.
 *
 * An event stops taking them once it has started — an RSVP for something already under way is not
 * one anybody can act on. A deadline is exclusive: closing at 6 pm means 6 pm is too late.
 */
export function formOpenState(
  form: {
    active: boolean;
    closesAt: Date | string | null;
    category: FormCategory;
    eventStartsAt: Date | string | null;
  },
  now: Date,
): OpenState {
  if (!form.active) return { open: false, message: "This form has been closed." };
  if (form.closesAt && now.getTime() >= new Date(form.closesAt).getTime()) {
    return { open: false, message: "This form stopped taking answers." };
  }
  if (form.category === "EVENT" && form.eventStartsAt && now.getTime() >= new Date(form.eventStartsAt).getTime()) {
    return { open: false, message: "This event has already started, so registration is closed." };
  }
  return { open: true };
}

/**
 * Whether one more "I'm coming" fits.
 *
 * `alreadyComing` excludes the person asking: somebody changing their answer from yes to yes, or
 * editing their dietary preference, is not taking a second seat.
 */
export function hasSeat(capacity: number | null, alreadyComing: number): boolean {
  return capacity === null || alreadyComing < capacity;
}

// ─── The event funnel ────────────────────────────────────────────────────────

export type Funnel = {
  invited: number;
  /** Invitees who answered at all — yes or no. */
  replied: number;
  coming: number;
  declined: number;
  /** Of `coming`, how many registered on the public link rather than from an invitation. */
  comingFromLink: number;
  attended: number;
  noShow: number;
  /** Coming, and not yet marked either way. */
  unmarked: number;
};

export function eventFunnel(input: {
  invites: { revokedAt: Date | string | null; answered: boolean }[];
  registrations: { attending: boolean | null; attendance: FormAttendance | null; viaInvite: boolean }[];
}): Funnel {
  const live = input.invites.filter((i) => !i.revokedAt);
  const coming = input.registrations.filter((r) => r.attending !== false);
  return {
    invited: live.length,
    replied: live.filter((i) => i.answered).length,
    coming: coming.length,
    declined: input.registrations.filter((r) => r.attending === false).length,
    comingFromLink: coming.filter((r) => !r.viaInvite).length,
    attended: coming.filter((r) => r.attendance === "ATTENDED").length,
    noShow: coming.filter((r) => r.attendance === "NO_SHOW").length,
    unmarked: coming.filter((r) => r.attendance === null).length,
  };
}

/** "12 of 20", or "12" when there is no limit — never "12 of null". */
export function seatsText(coming: number, capacity: number | null): string {
  return capacity === null ? String(coming) : `${coming} of ${capacity}`;
}
