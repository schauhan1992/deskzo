import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { moduleAccessFor } from "@/lib/modules-access";
import { getBranding } from "@/actions/branding";
import { getOrganisation, type Organisation } from "@/lib/organisation";
import { gettingStartedSteps, profileComplete, type GettingStartedStep } from "@/lib/help/getting-started";

/**
 * The facts behind somebody's Getting Started steps, read from the workspace — for the dashboard's tab
 * (`getGettingStarted`, src/actions/help.ts) and the wizard (src/actions/onboarding.ts). The steps
 * themselves are worked out by the pure src/lib/help/getting-started.ts.
 *
 * Not an action: callers resolve who is asking first (`requireUser`) and pass their id.
 */
export type GettingStartedFor = {
  steps: GettingStartedStep[];
  admin: boolean;
  helpManager: boolean;
  /** Read only for somebody shown the company steps. */
  organisation: Organisation | null;
  logoDataUrl: string | null;
  me: {
    name: string;
    kind: string;
    photoUpdatedAt: Date | null;
    twoFactorEnabledAt: Date | null;
    onboardingCompletedAt: Date | null;
    onboardingSkipped: string[];
  } | null;
};

export async function gettingStartedFor(userId: string): Promise<GettingStartedFor> {
  const [admin, helpManager, items, me, settings] = await Promise.all([
    can(userId, "settings.manage"),
    can(userId, "help.manage"),
    moduleAccessFor(userId, "items"),
    db.user.findUnique({
      where: { id: userId },
      select: { name: true, kind: true, photoUpdatedAt: true, twoFactorEnabledAt: true, onboardingCompletedAt: true, onboardingSkipped: true },
    }),
    db.organisationSettings.findUnique({ where: { id: "global" }, select: { onboardingSkipped: true } }),
  ]);
  const itemsModule = items === "available";
  // Company facts are read only for somebody who will be shown the company steps.
  const [organisation, branding, activeUsers, itemCount, helpLinks] = await Promise.all([
    admin ? getOrganisation() : null,
    admin ? getBranding() : null,
    // `db` lists people only — never platform support or the Automation account (src/lib/db.ts).
    admin ? db.user.count({ where: { active: true } }) : 0,
    admin && itemsModule ? db.item.count() : 0,
    // The company's own guides only. Deskzo's help is in every workspace and is never this step's to
    // tick; nor is the retired helpline, which no page shows any more.
    admin && helpManager ? db.helpLink.count({ where: { active: true } }) : 0,
  ]);
  const steps = gettingStartedSteps({
    admin,
    helpManager,
    itemsModule,
    organisationReady: organisation ? profileComplete(organisation) : false,
    hasLogo: !!branding?.logoDataUrl,
    activeUsers,
    itemCount,
    helplineSet: helpLinks > 0,
    hasPhoto: !!me?.photoUpdatedAt,
    hasTwoFactor: !!me?.twoFactorEnabledAt,
    companySkipped: settings?.onboardingSkipped ?? [],
    personalSkipped: me?.onboardingSkipped ?? [],
  });
  return { steps, admin, helpManager, organisation, logoDataUrl: branding?.logoDataUrl ?? null, me: me ?? null };
}
