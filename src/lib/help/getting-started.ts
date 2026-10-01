/**
 * The Getting Started steps: the handful of things that make the ERP work for a new company and for a
 * new person in it — the dashboard's first tab, and the wizard that pops up until they are finished
 * (src/components/onboarding/onboarding-wizard.tsx; owner's request, 1 Oct 2026).
 *
 * Nothing here is ticked by hand. Every step is done when the data says it is — a company profile
 * saved, a second user added, a photo uploaded — so the list cannot claim a company is set up when it
 * is not, and cannot nag about something already finished. Steps somebody cannot act on are left out
 * rather than shown greyed: a salesperson has no use for "fill in your company profile".
 *
 * Two steps are required — the company profile and two-factor sign-in. The rest may be skipped, and a
 * skipped step counts as finished. Company skips are remembered for everybody
 * (`OrganisationSettings.onboardingSkipped`), a person's own on their account (`User.onboardingSkipped`);
 * both arrive here as facts, so this file stays pure.
 */

export type StepKey = "organisation" | "logo" | "team" | "items" | "helpline" | "photo" | "two-factor";
export type StepGroup = "company" | "you";

/** Must be done: never skippable. */
export const REQUIRED_STEPS: readonly StepKey[] = ["organisation", "two-factor"];
/** The company's optional steps. Skipping one is `settings.manage`, and counts for everybody. */
export const COMPANY_SKIPPABLE: readonly StepKey[] = ["logo", "team", "items", "helpline"];
/** A person's own optional steps. */
export const PERSONAL_SKIPPABLE: readonly StepKey[] = ["photo"];
export const STEP_KEYS: readonly StepKey[] = ["organisation", "logo", "team", "items", "helpline", "photo", "two-factor"];

export const isStepKey = (value: unknown): value is StepKey => typeof value === "string" && (STEP_KEYS as readonly string[]).includes(value);
export const isRequiredStep = (key: StepKey) => REQUIRED_STEPS.includes(key);
/** Whose skip it is: the company's (everybody's) or the person's own. Null for a step that can't be skipped. */
export function skipScope(key: StepKey): "company" | "personal" | null {
  if (COMPANY_SKIPPABLE.includes(key)) return "company";
  if (PERSONAL_SKIPPABLE.includes(key)) return "personal";
  return null;
}

export type GettingStartedFacts = {
  /** Holds `settings.manage` — the company-setup steps. */
  admin: boolean;
  /** Holds `help.manage` — the help step (with `admin`: it is one of the company's). */
  helpManager: boolean;
  /** The Items module is on and visible to them. */
  itemsModule: boolean;

  /** The essentials of the company profile are saved — `profileComplete`. */
  organisationReady: boolean;
  hasLogo: boolean;
  activeUsers: number;
  itemCount: number;
  /** Somewhere to turn for help: a help article or video for the rail (or a helpline saved before it was retired). */
  helplineSet: boolean;

  hasPhoto: boolean;
  hasTwoFactor: boolean;

  /** `OrganisationSettings.onboardingSkipped`: the company's optional steps somebody skipped. */
  companySkipped?: readonly string[];
  /** `User.onboardingSkipped`: their own optional steps they skipped. */
  personalSkipped?: readonly string[];
};

export type GettingStartedStep = {
  key: StepKey;
  title: string;
  /** Why it matters — the wizard's line under the title, and the tab's under each step. */
  description: string;
  href: string;
  action: string;
  /** Where it can be done later, for "Skipped — do it any time from …". */
  where: string;
  /** What the data says. */
  done: boolean;
  required: boolean;
  skippable: boolean;
  /** Skipped, and not done since. */
  skipped: boolean;
  /** Done, or skipped — what onboarding waits for. */
  finished: boolean;
  /** Who the step is for, shown as the group heading. */
  group: StepGroup;
};

type StepDraft = Omit<GettingStartedStep, "required" | "skippable" | "skipped" | "finished">;

export function gettingStartedSteps(f: GettingStartedFacts): GettingStartedStep[] {
  const drafts: StepDraft[] = [];

  if (f.admin) {
    drafts.push(
      {
        key: "organisation",
        title: "Fill in your company profile",
        description: "Legal name, GSTIN, state and registered address — what prints at the top of every quote and invoice.",
        href: "/settings/organisation",
        action: "Open profile",
        where: "Settings → Profile",
        done: f.organisationReady,
        group: "company",
      },
      {
        key: "logo",
        title: "Add your logo",
        description: "Shown in the sidebar and at the top of the dashboard, beside your company's name.",
        href: "/settings/branding",
        action: "Open branding",
        where: "Settings → Branding",
        done: f.hasLogo,
        group: "company",
      },
      {
        key: "team",
        title: "Bring in your team",
        description: "Give each person their own account and role, so everybody sees their own work — and only what they should.",
        href: "/settings/access",
        action: "Add people",
        where: "Settings → Users & access",
        done: f.activeUsers > 1,
        group: "company",
      },
    );
    if (f.itemsModule) {
      drafts.push({
        key: "items",
        title: "Add what you sell",
        description: "Products, licences and services, with prices and tax rates — quotes and orders are built from these.",
        href: "/items/new",
        action: "Add an item",
        where: "Items",
        done: f.itemCount > 0,
        group: "company",
      });
    }
    // A company step, so for somebody setting the company up — and only one who may change help.
    if (f.helpManager) {
      drafts.push({
        key: "helpline",
        title: "Tell people where to get help",
        description: "A help article or a training video for the Help panel on everybody's rail — where to look before asking.",
        href: "/settings/help",
        action: "Add help",
        where: "Settings → Help & support",
        done: f.helplineSet,
        group: "company",
      });
    }
  }

  drafts.push(
    {
      key: "photo",
      title: "Add your photo",
      description: "So people recognise you on tasks, tickets and the team pages.",
      href: "/profile",
      action: "Open my profile",
      where: "My profile",
      done: f.hasPhoto,
      group: "you",
    },
    {
      key: "two-factor",
      title: "Turn on two-factor sign-in",
      description: "A code from your phone as well as your password — the single best protection for your account.",
      href: "/profile",
      action: "Set it up",
      where: "My profile",
      done: f.hasTwoFactor,
      group: "you",
    },
  );

  const companySkipped = new Set(f.companySkipped ?? []);
  const personalSkipped = new Set(f.personalSkipped ?? []);
  return drafts.map((step) => {
    const scope = skipScope(step.key);
    const listed = scope === "company" ? companySkipped.has(step.key) : scope === "personal" ? personalSkipped.has(step.key) : false;
    const skipped = !step.done && listed;
    return { ...step, required: isRequiredStep(step.key), skippable: scope !== null, skipped, finished: step.done || skipped };
  });
}

export function progressOf(steps: GettingStartedStep[]): { done: number; total: number; percent: number } {
  const done = steps.filter((s) => s.finished).length;
  const total = steps.length;
  return { done, total, percent: total === 0 ? 100 : Math.round((done / total) * 100) };
}

/** Every step finished — what `completeOnboarding` checks again on the server. */
export const allFinished = (steps: GettingStartedStep[]) => steps.every((s) => s.finished);

/** The first step still to do, or null when there is none. */
export const firstUnfinished = (steps: GettingStartedStep[]): GettingStartedStep | null => steps.find((s) => !s.finished) ?? null;

/**
 * The company profile's essentials, as onboarding counts them: the legal name and the registered
 * address — with the state and PIN code in India, where tax follows the state.
 *
 * The GSTIN is asked for but not required: a business under the GST threshold has none, and a step
 * that can never be finished would hold the wizard open for good. (The e-invoice readiness check,
 * `isOrganisationReady` in src/lib/organisation.ts, still wants it.)
 */
export function profileComplete(org: {
  legalName: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  country: string | null;
}): boolean {
  const has = (v: string | null) => !!v && v.trim().length > 0;
  const india = !org.country || !org.country.trim() || org.country.trim().toLowerCase() === "india";
  return has(org.legalName) && has(org.addressLine1) && has(org.city) && (!india || (has(org.state) && has(org.pincode)));
}
