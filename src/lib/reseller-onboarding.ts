import type { ResellerOnboardingStatus, ResellerTier } from "@prisma/client";

export const resellerStatusValues = ["ONBOARDING", "ACTIVE", "SUSPENDED", "INACTIVE"] as const;

export const resellerStatusLabels: Record<ResellerOnboardingStatus, string> = {
  ONBOARDING: "Onboarding",
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
  INACTIVE: "Inactive",
};

export const resellerTierValues = ["SILVER", "GOLD", "PLATINUM"] as const;

export const resellerTierLabels: Record<ResellerTier, string> = {
  SILVER: "Silver",
  GOLD: "Gold",
  PLATINUM: "Platinum",
};

/** Only an ACTIVE reseller may have orders punched against them. */
export function canResellerTrade(status: ResellerOnboardingStatus) {
  return status === "ACTIVE";
}

export type OnboardingInputs = {
  agreementSignedOn: Date | string | null;
  creditLimit: unknown;
  tier: ResellerTier | null;
  panNumber: string | null;
  /** GSTIN from the reseller's primary location. */
  gstNumber: string | null;
};

export type ChecklistItem = { key: string; label: string; done: boolean; hint: string };

/**
 * What a reseller must have on file before they can be activated. Everything here is stored
 * somewhere it already belonged — PAN and GSTIN on the company/location records rather than
 * duplicated onto the profile — so the checklist reads the real data, not a copy of it.
 */
export function onboardingChecklist(inputs: OnboardingInputs): ChecklistItem[] {
  return [
    {
      key: "agreement",
      label: "Signed partner agreement",
      done: Boolean(inputs.agreementSignedOn),
      hint: "Record the date the agreement was signed and who approved it.",
    },
    {
      key: "kyc",
      label: "GSTIN & PAN on file",
      done: Boolean(inputs.panNumber) && Boolean(inputs.gstNumber),
      hint: "PAN goes on the reseller's payout details; GSTIN on their primary location.",
    },
    {
      key: "credit",
      label: "Credit limit & payment terms agreed",
      done: inputs.creditLimit !== null && inputs.creditLimit !== undefined,
      hint: "Set the credit limit they may carry. Payment terms come from the company profile.",
    },
    {
      key: "tier",
      label: "Partner tier & discount set",
      done: Boolean(inputs.tier),
      hint: "Pick a tier and its standard discount — item-level prices can still override it.",
    },
  ];
}

export function outstandingOnboardingItems(inputs: OnboardingInputs) {
  return onboardingChecklist(inputs).filter((i) => !i.done);
}

export function isOnboardingComplete(inputs: OnboardingInputs) {
  return outstandingOnboardingItems(inputs).length === 0;
}
