/**
 * Who is still being onboarded, which dashboard tabs they get, and when the wizard opens — pure, so
 * the dashboard, the workspace layout, the wizard and check:onboarding share one answer.
 *
 *   · Pending: a person (a MEMBER account — never platform support or the Automation account) whose
 *     `onboardingCompletedAt` is still null. People already in a workspace when onboarding arrived were
 *     marked done by its migration; a new account starts null (the column's default).
 *   · Tabs: Getting Started · Dashboard · Recent Updates while pending, Getting Started first and the
 *     default; after, Dashboard · Recent Updates, and Getting Started is gone for good.
 *   · The wizard is mounted for a pending person signed in as themselves — never while viewing as
 *     somebody. It opens by itself once per sign-in (the browser's sessionStorage remembers), except
 *     while the layout is forcing a password change or two-factor enrolment on /profile; Getting
 *     Started's "Continue setup" opens it any time.
 */

export type OnboardingPerson = { kind: string | null | undefined; onboardingCompletedAt: Date | string | null | undefined } | null | undefined;

export function onboardingPending(person: OnboardingPerson): boolean {
  return !!person && person.kind === "MEMBER" && !person.onboardingCompletedAt;
}

export type DashboardTabKey = "getting-started" | "overview" | "updates";

export const DASHBOARD_TAB_LABELS: Record<DashboardTabKey, string> = {
  "getting-started": "Getting Started",
  overview: "Dashboard",
  updates: "Recent Updates",
};

export function dashboardTabKeys(pending: boolean): DashboardTabKey[] {
  return pending ? ["getting-started", "overview", "updates"] : ["overview", "updates"];
}

/** The tab to show: the one asked for if it is offered, else the first — so a stale `?tab=getting-started` lands on the dashboard. */
export function resolveDashboardTab(requested: string | null | undefined, keys: readonly DashboardTabKey[]): DashboardTabKey {
  return keys.find((k) => k === requested) ?? keys[0]!;
}

export type WizardGate = {
  /** The account signed in — not anybody it is viewing as. */
  person: OnboardingPerson;
  viewingAs: boolean;
  /** The layout is sending them to /profile for a new password or two-factor (src/app/(dashboard)/layout.tsx). */
  forcedSetup: boolean;
};

/** Whether the wizard is on the page at all — "Continue setup" opens it. */
export function wizardMounted(gate: WizardGate): boolean {
  return !gate.viewingAs && onboardingPending(gate.person);
}

/** Whether it opens by itself (once per sign-in, which the browser remembers). */
export function wizardAutoOpens(gate: WizardGate): boolean {
  return wizardMounted(gate) && !gate.forcedSetup;
}

/** Dispatched on `window` by "Continue setup"; the wizard listens. */
export const OPEN_ONBOARDING_EVENT = "onboarding:open";

/** The sessionStorage key that says the wizard has opened by itself for this sign-in. */
export const autoOpenedKey = (signInKey: string) => `onboarding.autoOpened.${signInKey}`;
