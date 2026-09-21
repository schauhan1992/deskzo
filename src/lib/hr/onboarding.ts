import type { CandidateStatus, LetterType } from "@prisma/client";

/**
 * What still has to happen for somebody joining, and for somebody leaving.
 *
 * Pure functions over the real records, in the same shape as `src/lib/reseller-onboarding.ts` —
 * nothing here stores a tick. A checklist that keeps its own "done" flags drifts from reality the
 * first time somebody changes the underlying data without remembering to tick the box, and then it
 * is worse than no checklist because it is confidently wrong.
 *
 * Each item therefore reads the thing it is about: "has a salary structure" means a salary
 * structure row exists, not that anybody said so.
 */

export type ChecklistItem = {
  key: string;
  label: string;
  done: boolean;
  hint: string;
  /**
   * Something that will actively go wrong if left undone, as opposed to merely incomplete.
   * Payroll silently skipping somebody is the example this exists for.
   */
  blocking?: boolean;
  href?: string;
};

// ─── Joining ──────────────────────────────────────────────────────────────────

export type OnboardingInputs = {
  userId: string;
  joinedOn: Date | string | null;
  employeeCode: string | null;
  designation: string | null;
  panNumber: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  personalPhone: string | null;
  emergencyContactPhone: string | null;
  state: string | null;
  biometricId: string | null;
  hasSalaryStructure: boolean;
  hasAppointmentLetter: boolean;
  documentTypes: string[];
  openTasks: number;
  /** Company equipment already on their name. */
  assetsHeld: number;
  /** Of those, how many they have not yet confirmed receiving. */
  assetsUnconfirmed: number;
};

/**
 * Everything a new joiner needs before the machine works properly for them.
 *
 * The blocking items are the ones with consequences rather than tidiness: no salary structure and
 * payroll skips them entirely at month end; no work state and their professional tax is silently
 * zero; no bank details and the pay has nowhere to go.
 */
export function onboardingChecklist(i: OnboardingInputs): ChecklistItem[] {
  return [
    {
      key: "joined",
      label: "Joining date recorded",
      done: Boolean(i.joinedOn),
      hint: "Everything else — probation, gratuity, leave accrual — is measured from this date.",
      blocking: true,
      href: `/people/${i.userId}`,
    },
    {
      key: "identity",
      label: "Employee code & designation",
      done: Boolean(i.employeeCode) && Boolean(i.designation),
      hint: "The code appears on their payslip and every letter.",
      href: `/people/${i.userId}`,
    },
    {
      key: "salary",
      label: "Salary structure set",
      done: i.hasSalaryStructure,
      hint: "Without one, payroll skips this person entirely — silently.",
      blocking: true,
      href: `/people/${i.userId}`,
    },
    {
      key: "statutory",
      label: "PAN on file",
      done: Boolean(i.panNumber),
      hint: "Needed for TDS and for Form 16 at the end of the year.",
      blocking: true,
      href: `/people/${i.userId}`,
    },
    {
      key: "bank",
      label: "Bank account & IFSC",
      done: Boolean(i.bankAccountNumber) && Boolean(i.bankIfsc),
      hint: "Where the salary actually goes.",
      blocking: true,
      href: `/people/${i.userId}`,
    },
    {
      key: "state",
      label: "Work state recorded",
      done: Boolean(i.state),
      hint: "Drives the professional tax slab. Left blank, nothing is deducted and it goes unnoticed.",
      blocking: true,
      href: `/people/${i.userId}`,
    },
    {
      key: "contact",
      label: "Personal phone & emergency contact",
      done: Boolean(i.personalPhone) && Boolean(i.emergencyContactPhone),
      hint: "The one thing on the record you will need at the worst possible moment.",
      href: `/people/${i.userId}`,
    },
    {
      key: "documents",
      label: "CV and ID proof on file",
      done: i.documentTypes.includes("CV") && (i.documentTypes.includes("PAN_CARD") || i.documentTypes.includes("AADHAAR")),
      hint: "Upload the CV you hired on and at least one identity document.",
      href: `/people/${i.userId}`,
    },
    {
      key: "letter",
      label: "Appointment letter issued",
      done: i.hasAppointmentLetter,
      hint: "Draft it from the personnel file — it reads the salary and dates off the record.",
      href: `/people/${i.userId}`,
    },
    {
      key: "equipment",
      label: "Equipment issued",
      done: i.assetsHeld > 0,
      hint: "A laptop and anything else they need, recorded against them on the asset register rather than remembered.",
      href: "/assets",
    },
    {
      key: "biometric",
      label: "Biometric enrolment mapped",
      done: Boolean(i.biometricId),
      hint: "Enrol their finger on the terminal, then map the number here so punches find them.",
      href: "/people/devices",
    },
    {
      key: "tasks",
      label: "Setup tasks completed",
      done: i.openTasks === 0,
      hint: "Laptop, access card, accounts, first-week plan.",
      href: "/tasks",
    },
  ];
}

// ─── Leaving ──────────────────────────────────────────────────────────────────

export type OffboardingInputs = {
  userId: string;
  exitedOn: Date | string | null;
  loginActive: boolean;
  hasSettlement: boolean;
  settlementStatus: string | null;
  netPayable: number;
  letterTypes: string[];
  openTasks: number;
  /** Company equipment still on their name. */
  assetsHeld: number;
};

/**
 * Everything that has to happen when somebody leaves.
 *
 * Ordered by what costs you if it is missed. An ex-employee with a working login is first because
 * it is the one item on this list that is a security incident rather than an inconvenience, and the
 * one most often forgotten precisely because the person is no longer around to remind anybody.
 *
 * The no-dues item is deliberately gated on the settlement being *settled*, not merely prepared:
 * issuing a no-dues certificate while money is still recoverable is the company signing away its
 * own claim.
 */
export function offboardingChecklist(i: OffboardingInputs): ChecklistItem[] {
  const settled = i.settlementStatus === "PAID" || (i.settlementStatus === "APPROVED" && i.netPayable <= 0);

  return [
    {
      key: "exit",
      label: "Exit recorded",
      done: Boolean(i.exitedOn),
      hint: "Last working day, how they left, and why.",
      blocking: true,
      href: `/people/${i.userId}`,
    },
    {
      key: "access",
      label: "Login deactivated",
      done: !i.loginActive,
      hint: "An ex-employee with a working account is the one item here that is a security problem.",
      blocking: true,
      href: "/settings/access",
    },
    {
      key: "equipment",
      label: "Equipment returned",
      done: i.assetsHeld === 0,
      hint:
        i.assetsHeld === 1
          ? "One item is still on their name. Record it coming back before the settlement is paid — afterwards there is no leverage and no easy way to recover it."
          : `${i.assetsHeld} items are still on their name. Record them coming back before the settlement is paid.`,
      blocking: true,
      href: `/assets?custodianUserId=${i.userId}`,
    },
    {
      key: "tasks",
      label: "Accounts revoked & access card returned",
      done: i.openTasks === 0,
      hint: "Everything they had signed into, and anything the register doesn't track.",
      blocking: true,
      href: "/tasks",
    },
    {
      key: "settlement",
      label: "Full & final settlement prepared",
      done: i.hasSettlement,
      hint: "Salary, leave encashment, gratuity, less notice shortfall and recoveries.",
      blocking: true,
      href: `/people/${i.userId}/settlement`,
    },
    {
      key: "settlementPaid",
      label: "Settlement approved & paid",
      done: i.settlementStatus === "PAID",
      hint:
        i.netPayable < 0
          ? "They owe the company — recover it before closing this out."
          : "Approve it, then mark it paid once the transfer has gone.",
      href: `/people/${i.userId}/settlement`,
    },
    {
      key: "relieving",
      label: "Relieving letter issued",
      done: i.letterTypes.includes("RELIEVING"),
      hint: "Confirms the date they were relieved. The next employer will ask for it.",
      href: `/people/${i.userId}`,
    },
    {
      key: "experience",
      label: "Experience certificate issued",
      done: i.letterTypes.includes("EXPERIENCE"),
      hint: "Dates and the position held.",
      href: `/people/${i.userId}`,
    },
    {
      key: "nodues",
      label: "No-dues certificate issued",
      done: i.letterTypes.includes("NO_DUES"),
      hint: settled
        ? "Everything is clear — this can go out."
        : "Hold this until the settlement is closed; it certifies that nothing is outstanding.",
      href: `/people/${i.userId}`,
    },
  ];
}

export function outstanding(items: ChecklistItem[]) {
  return items.filter((i) => !i.done);
}
export function blockingOutstanding(items: ChecklistItem[]) {
  return items.filter((i) => !i.done && i.blocking);
}
export function completeness(items: ChecklistItem[]) {
  return items.length === 0 ? 100 : Math.round((items.filter((i) => i.done).length / items.length) * 100);
}

// ─── Task templates ───────────────────────────────────────────────────────────

export type TaskTemplate = { title: string; description: string; role: "IT" | "HR" | "MANAGER"; dueDayOffset: number };

/**
 * The tasks raised when somebody is converted into an employee.
 *
 * Dated relative to the joining date rather than to today, so preparing an onboarding three weeks
 * early produces tasks due in three weeks — not eleven overdue ones the moment they are created.
 */
export const ONBOARDING_TASKS: TaskTemplate[] = [
  { title: "Issue laptop and set up accounts", description: "Email, CRM login, VPN if needed, and any software licences the role requires.", role: "IT", dueDayOffset: -1 },
  { title: "Issue access card and desk", description: "Building access, seating, and the biometric enrolment.", role: "HR", dueDayOffset: -1 },
  { title: "Enrol on the biometric terminal", description: "Register their finger, then map the enrolment number on the Biometric page.", role: "HR", dueDayOffset: 0 },
  { title: "Collect signed offer and documents", description: "Signed appointment letter, ID proofs, education certificates, previous relieving letter.", role: "HR", dueDayOffset: 1 },
  { title: "Plan the first week", description: "Who they meet, what they read, and what they should be able to do by Friday.", role: "MANAGER", dueDayOffset: -2 },
  { title: "30-day check-in", description: "How is it going, is anything blocking them, does the role match what was described.", role: "MANAGER", dueDayOffset: 30 },
];

/**
 * The tasks raised when an exit is recorded.
 *
 * Access revocation is dated to the last working day and not a day later, which is the whole point
 * of raising it as a task rather than trusting somebody to remember.
 */
export const OFFBOARDING_TASKS: TaskTemplate[] = [
  { title: "Revoke system access", description: "Email, CRM, VPN, shared drives, and any third-party tools they were signed into.", role: "IT", dueDayOffset: 0 },
  { title: "Collect laptop and access card", description: "And the SIM, if the company issued one.", role: "IT", dueDayOffset: 0 },
  { title: "Handover of work and accounts", description: "Use \"Hand over work\" on their record — accounts, leads, open tickets, live quotes, equipment and anyone reporting to them, in one pass. Due before the last day so they are still around to answer questions.", role: "MANAGER", dueDayOffset: -3 },
  { title: "Prepare full & final settlement", description: "Salary, leave encashment, gratuity, less notice shortfall and any recoveries.", role: "HR", dueDayOffset: 3 },
  { title: "Issue relieving and experience letters", description: "Once the settlement is closed and no dues remain.", role: "HR", dueDayOffset: 7 },
  { title: "Exit interview", description: "Why they are leaving, and what would have changed it.", role: "HR", dueDayOffset: -1 },
];

// ─── Candidate status ─────────────────────────────────────────────────────────

export const candidateStatusLabels: Record<CandidateStatus, string> = {
  PROSPECT: "In the pipeline",
  OFFERED: "Offer sent",
  ACCEPTED: "Offer accepted",
  DECLINED: "Declined",
  JOINED: "Joined",
  WITHDRAWN: "Withdrawn",
};

export const candidateStatusTone: Record<CandidateStatus, "default" | "green" | "blue" | "red" | "amber"> = {
  PROSPECT: "default",
  OFFERED: "amber",
  ACCEPTED: "blue",
  DECLINED: "red",
  JOINED: "green",
  WITHDRAWN: "default",
};

/** A candidate may only become an employee once they have said yes. */
export function canConvert(status: CandidateStatus) {
  return status === "ACCEPTED";
}

/**
 * The only letters that make sense for somebody who has not joined.
 *
 * Lives here rather than beside the action that uses it because a `"use server"` module publishes
 * every export as a client-callable endpoint, and all of them must be async functions.
 */
export const CANDIDATE_LETTERS: LetterType[] = ["OFFER", "INTERNSHIP", "CONTRACT_AGREEMENT"];
