/**
 * The Getting Started tab: the handful of things that make the ERP work for a new company and for a
 * new person in it.
 *
 * Nothing here is ticked by hand. Every step is done when the data says it is — a GSTIN saved, a
 * second user added, a photo uploaded — so the list cannot claim a company is set up when it is not,
 * and cannot nag about something already finished. Steps somebody cannot act on are left out rather
 * than shown greyed: a salesperson has no use for "add your GSTIN".
 */

export type GettingStartedFacts = {
  /** Holds `settings.manage` — the company-setup steps. */
  admin: boolean;
  /** Holds `help.manage` — the helpline step. */
  helpManager: boolean;
  /** The Items module is on and visible to them. */
  itemsModule: boolean;

  organisationReady: boolean;
  hasLogo: boolean;
  activeUsers: number;
  itemCount: number;
  helplineSet: boolean;

  hasPhoto: boolean;
  hasTwoFactor: boolean;
};

export type GettingStartedStep = {
  key: string;
  title: string;
  description: string;
  href: string;
  action: string;
  done: boolean;
  /** Who the step is for, shown as the group heading. */
  group: "company" | "you";
};

export function gettingStartedSteps(f: GettingStartedFacts): GettingStartedStep[] {
  const steps: GettingStartedStep[] = [];

  if (f.admin) {
    steps.push(
      {
        key: "organisation",
        title: "Fill in your company profile",
        description: "Legal name, GSTIN, state and registered address — what prints at the top of every quote and invoice.",
        href: "/settings/organisation",
        action: "Open profile",
        done: f.organisationReady,
        group: "company",
      },
      {
        key: "logo",
        title: "Add your logo",
        description: "Shown in the sidebar and at the top of the dashboard, beside your company's name.",
        href: "/settings/branding",
        action: "Open branding",
        done: f.hasLogo,
        group: "company",
      },
      {
        key: "team",
        title: "Bring in your team",
        description: "Give each person their own account and role, so everybody sees their own work — and only what they should.",
        href: "/settings/access",
        action: "Add people",
        done: f.activeUsers > 1,
        group: "company",
      },
    );
    if (f.itemsModule) {
      steps.push({
        key: "items",
        title: "Add what you sell",
        description: "Products, licences and services, with prices and tax rates — quotes and orders are built from these.",
        href: "/items/new",
        action: "Add an item",
        done: f.itemCount > 0,
        group: "company",
      });
    }
  }

  if (f.helpManager) {
    steps.push({
      key: "helpline",
      title: "Tell people where to get help",
      description: "A helpline number and hours for the dashboard, plus any help articles and training videos.",
      href: "/settings/help",
      action: "Set up help",
      done: f.helplineSet,
      group: "company",
    });
  }

  steps.push(
    {
      key: "photo",
      title: "Add your photo",
      description: "So people recognise you on tasks, tickets and the team pages.",
      href: "/profile",
      action: "Open my profile",
      done: f.hasPhoto,
      group: "you",
    },
    {
      key: "two-factor",
      title: "Turn on two-factor sign-in",
      description: "A code from your phone as well as your password — the single best protection for your account.",
      href: "/profile",
      action: "Set it up",
      done: f.hasTwoFactor,
      group: "you",
    },
  );

  return steps;
}

export function progressOf(steps: GettingStartedStep[]): { done: number; total: number; percent: number } {
  const done = steps.filter((s) => s.done).length;
  const total = steps.length;
  return { done, total, percent: total === 0 ? 100 : Math.round((done / total) * 100) };
}
