import type { PrivacyRequestKind, PrivacyRequestStatus } from "@deskzo/control-client";

/**
 * What the privacy request form (src/components/site/forms/privacy-request-form.tsx), its action
 * (src/actions/platform/site.ts sendPrivacyRequest) and the console's Privacy requests share — pure, so the
 * browser can have it. The requests themselves: src/lib/platform/privacy-requests.ts.
 */

export const PRIVACY_DUE_DAYS = 30;

export const PRIVACY_KINDS: { value: PrivacyRequestKind; label: string }[] = [
  { value: "ACCESS", label: "A copy of my personal data" },
  { value: "CORRECTION", label: "Correct or complete my data" },
  { value: "ERASURE", label: "Erase my data" },
  { value: "WITHDRAW_CONSENT", label: "Withdraw my consent" },
  { value: "NOMINATE", label: "Nominate someone to act for me" },
  { value: "GRIEVANCE", label: "A grievance about how my data was handled" },
  { value: "OTHER", label: "Something else about my data" },
];

export const PRIVACY_RELATIONS = [
  { value: "workspace", label: "I signed up for Deskzo, or own a workspace" },
  { value: "user", label: "I use my company's Deskzo workspace" },
  { value: "customer", label: "A company that uses Deskzo has my details" },
  { value: "visitor", label: "I visited this site or wrote to Deskzo" },
  { value: "other", label: "Something else" },
] as const;
export type PrivacyRelation = (typeof PRIVACY_RELATIONS)[number]["value"];

export const PRIVACY_STATUSES: { value: PrivacyRequestStatus; label: string }[] = [
  { value: "NEW", label: "New" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "DONE", label: "Done" },
  { value: "REFUSED", label: "Refused" },
];

export const PRIVACY_LIMITS = { name: 120, email: 254, company: 160, message: 4000, messageMin: 10, notes: 4000 } as const;

/** "PRQ-000123": what the person is told, and quotes back. */
export const privacyRef = (seq: number) => `PRQ-${String(seq).padStart(6, "0")}`;
export const privacyKindLabel = (kind: string) => PRIVACY_KINDS.find((k) => k.value === kind)?.label ?? kind;
export const privacyRelationLabel = (relation: string) => PRIVACY_RELATIONS.find((r) => r.value === relation)?.label ?? relation;
export const isPrivacyKind = (value: unknown): value is PrivacyRequestKind => PRIVACY_KINDS.some((k) => k.value === value);
export const isPrivacyRelation = (value: unknown): value is PrivacyRelation => PRIVACY_RELATIONS.some((r) => r.value === value);
export const isPrivacyStatus = (value: unknown): value is PrivacyRequestStatus => PRIVACY_STATUSES.some((s) => s.value === value);

