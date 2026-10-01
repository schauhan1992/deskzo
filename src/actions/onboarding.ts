"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { refuseWhileViewingAs, requireUser, viewAsContext } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { roleKeys } from "@/lib/authz/role-registry";
import { ADMIN_ROLE } from "@/lib/roles";
import { branchIdentity } from "@/lib/branches/identity";
import { isIndia } from "@/lib/geo/countries";
import { stateCodeFromName } from "@/lib/gst-engine";
import { updateOrganisation } from "@/actions/organisation";
import { gettingStartedFor } from "@/lib/help/onboarding-facts";
import { isStepKey, skipScope, type GettingStartedStep, type StepKey } from "@/lib/help/getting-started";
import { onboardingPending } from "@/lib/help/onboarding";
import { companyProfileIssues, COMPANY_PROFILE_FIELDS, type CompanyProfileInput, type CompanyProfileIssues } from "@/lib/help/company-profile";

/**
 * The Getting Started wizard's server side (src/components/onboarding/onboarding-wizard.tsx; owner's
 * request, 1 Oct 2026). Which steps somebody has and whether each is done is worked out from the data
 * (src/lib/help/getting-started.ts, facts from src/lib/help/onboarding-facts.ts) — nothing here ticks a
 * step by hand. What this adds:
 *
 *   · `onboardingState` — the steps, and what the wizard's embedded forms start from.
 *   · `skipStep` / `unskipStep` — optional steps only; a company step needs `settings.manage`, and its
 *     skip counts for everybody.
 *   · `completeOnboarding` — checks again that every step is finished, then sets
 *     `User.onboardingCompletedAt` once. After that Getting Started is gone for good.
 *   · `saveCompanyProfile` — the profile's essentials, saved through `updateOrganisation` with every
 *     other field of the profile kept as it is.
 *
 * Every change is audited, and none is made while viewing as somebody: an administrator borrowing an
 * account has not finished that person's onboarding for them.
 */

export type OnboardingResult<T> = { ok: true; data: T } | { ok: false; error: string; issues?: CompanyProfileIssues };

export type OnboardingState = {
  pending: boolean;
  steps: GettingStartedStep[];
  /** The profile's essentials, for the company step — null for somebody without that step. */
  profile: CompanyProfileInput | null;
  /** The head office has an address of its own, so its GSTIN is changed under Branches, not here. */
  gstinLocked: boolean;
  /** For "Bring in your team": null when they may not add people, and the step links to its page instead. */
  team: { roles: string[]; departments: { id: string; name: string }[] } | null;
  me: { id: string; name: string; photoUpdatedAt: string | null; twoFactorEnabled: boolean };
  logoDataUrl: string | null;
  /** The company is in India: GST rates and the ₹ on the item step. */
  india: boolean;
};

const REQUIRED_REFUSAL: Partial<Record<StepKey, string>> = {
  organisation: "The company profile can't be skipped — every quote and invoice prints it.",
  "two-factor": "Two-factor sign-in can't be skipped — it is what keeps your account yours if your password leaks.",
};

const COMPANY_ONLY = "Only somebody who can change the company's settings can skip a company step.";
const FINISHED = "You've finished getting started already.";

/** The wizard's starting point. Null while viewing as somebody, or for an account that has no onboarding. */
export async function onboardingState(): Promise<OnboardingState | null> {
  const user = await requireUser();
  if (await viewAsContext()) return null;
  const facts = await gettingStartedFor(user.id);
  if (!facts.me || facts.me.kind !== "MEMBER") return null;

  const org = facts.organisation;
  const hasTeamStep = facts.steps.some((s) => s.key === "team");
  const [mayAddPeople, headOffice] = await Promise.all([
    hasTeamStep ? can(user.id, "users.manage") : false,
    org ? branchIdentity(null) : null,
  ]);
  let roles: string[] = [];
  let departments: { id: string; name: string }[] = [];
  if (mayAddPeople) {
    [roles, departments] = await Promise.all([roleKeys(), db.department.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } })]);
  }

  return {
    pending: onboardingPending(facts.me),
    steps: facts.steps,
    profile: org
      ? {
          legalName: org.legalName ?? "",
          gstin: org.gstin ?? "",
          addressLine1: org.addressLine1 ?? "",
          city: org.city ?? "",
          state: org.state ?? "",
          pincode: org.pincode ?? "",
          country: org.country ?? "",
        }
      : null,
    gstinLocked: headOffice?.addressSource === "branch",
    team: mayAddPeople ? { roles: roles.filter((r) => r !== ADMIN_ROLE), departments } : null,
    me: {
      id: user.id,
      name: facts.me.name,
      photoUpdatedAt: facts.me.photoUpdatedAt?.toISOString() ?? null,
      twoFactorEnabled: !!facts.me.twoFactorEnabledAt,
    },
    logoDataUrl: facts.logoDataUrl,
    india: isIndia(org?.country),
  };
}

/** Who may change a step's skip, and the step itself — or why not. */
async function skippable(userId: string, key: unknown): Promise<{ error: string } | { key: StepKey; scope: "company" | "personal"; step: GettingStartedStep | undefined }> {
  if (!isStepKey(key)) return { error: "There's no such step." };
  const scope = skipScope(key);
  if (!scope) return { error: REQUIRED_REFUSAL[key] ?? "That step can't be skipped." };
  const facts = await gettingStartedFor(userId);
  if (!facts.me || facts.me.kind !== "MEMBER") return { error: "This account has no getting-started steps." };
  if (facts.me.onboardingCompletedAt) return { error: FINISHED };
  if (scope === "company" && !facts.admin) return { error: COMPANY_ONLY };
  const step = facts.steps.find((s) => s.key === key);
  if (!step) return { error: "That step isn't one of yours." };
  return { key, scope, step };
}

async function writeSkips(userId: string, scope: "company" | "personal", change: (list: string[]) => string[]) {
  if (scope === "company") {
    const row = await db.organisationSettings.findUnique({ where: { id: "global" }, select: { onboardingSkipped: true } });
    const list = change(row?.onboardingSkipped ?? []);
    await db.organisationSettings.upsert({ where: { id: "global" }, create: { id: "global", legalName: "", onboardingSkipped: list }, update: { onboardingSkipped: list } });
  } else {
    const row = await db.user.findUnique({ where: { id: userId }, select: { onboardingSkipped: true } });
    await db.user.update({ where: { id: userId }, data: { onboardingSkipped: change(row?.onboardingSkipped ?? []) } });
  }
}

/** "Skip for now": an optional step only. A skipped step counts as finished; doing it later ticks it all the same. */
export async function skipStep(key: string): Promise<OnboardingResult<{ steps: GettingStartedStep[] }>> {
  const user = await requireUser();
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };
  const found = await skippable(user.id, key);
  if ("error" in found) return { ok: false, error: found.error };
  if (!found.step!.done && !found.step!.skipped) {
    await writeSkips(user.id, found.scope, (list) => [...new Set([...list, found.key])]);
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: found.scope === "company" ? "OrganisationSettings" : "User",
      entityId: found.scope === "company" ? "global" : user.id,
      entityLabel: `Getting started: skipped "${found.step!.title}"${found.scope === "company" ? " for the company" : ""}`,
    });
    revalidatePath("/dashboard");
  }
  return { ok: true, data: { steps: (await gettingStartedFor(user.id)).steps } };
}

/** "Do it now" after a skip: the step is to do again. */
export async function unskipStep(key: string): Promise<OnboardingResult<{ steps: GettingStartedStep[] }>> {
  const user = await requireUser();
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };
  const found = await skippable(user.id, key);
  if ("error" in found) return { ok: false, error: found.error };
  if (found.step!.skipped) {
    await writeSkips(user.id, found.scope, (list) => list.filter((k) => k !== found.key));
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: found.scope === "company" ? "OrganisationSettings" : "User",
      entityId: found.scope === "company" ? "global" : user.id,
      entityLabel: `Getting started: "${found.step!.title}" is to do again`,
    });
    revalidatePath("/dashboard");
  }
  return { ok: true, data: { steps: (await gettingStartedFor(user.id)).steps } };
}

/**
 * The end of the wizard: every step finished — checked again here, whatever the page said — and the
 * account marked done, once. A second call changes nothing.
 */
export async function completeOnboarding(): Promise<OnboardingResult<{ completedAt: string }>> {
  const user = await requireUser();
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };
  const facts = await gettingStartedFor(user.id);
  if (!facts.me || facts.me.kind !== "MEMBER") return { ok: false, error: "This account has no getting-started steps." };
  if (facts.me.onboardingCompletedAt) return { ok: true, data: { completedAt: facts.me.onboardingCompletedAt.toISOString() } };
  const left = facts.steps.filter((s) => !s.finished);
  if (left.length) {
    return { ok: false, error: `Not finished yet: ${left.map((s) => s.title).join("; ")}.` };
  }
  const at = new Date();
  // Conditional, so two tabs finishing at once set it once.
  const marked = await db.user.updateMany({ where: { id: user.id, onboardingCompletedAt: null }, data: { onboardingCompletedAt: at } });
  if (marked.count === 1) {
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "User", entityId: user.id, entityLabel: "Getting started finished" });
  }
  revalidatePath("/", "layout");
  const stored = await db.user.findUnique({ where: { id: user.id }, select: { onboardingCompletedAt: true } });
  return { ok: true, data: { completedAt: (stored?.onboardingCompletedAt ?? at).toISOString() } };
}

/**
 * The company step's form: the legal name, the GSTIN (India), and the registered address. Checked
 * field by field first (src/lib/help/company-profile.ts), then saved through `updateOrganisation` —
 * its rules, its audit row — with everything else on the profile (bank details, PAN, terms…) sent back
 * exactly as stored, since that action saves the whole profile.
 */
export async function saveCompanyProfile(input: CompanyProfileInput): Promise<OnboardingResult<{ steps: GettingStartedStep[] }>> {
  const user = await requireUser();
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "You can't change organisation settings." };

  const clean = Object.fromEntries(COMPANY_PROFILE_FIELDS.map((f) => [f, String(input?.[f] ?? "").trim().slice(0, 200)])) as CompanyProfileInput;
  const issues = companyProfileIssues(clean);
  const first = COMPANY_PROFILE_FIELDS.map((f) => issues[f]).find(Boolean);
  if (first) return { ok: false, error: first, issues };

  const [org, headOffice] = await Promise.all([gettingStartedFor(user.id).then((f) => f.organisation), branchIdentity(null)]);
  if (!org) return { ok: false, error: "You can't change organisation settings." };
  const india = isIndia(clean.country);
  const gstinLocked = headOffice.addressSource === "branch";
  const gstin = india ? clean.gstin.toUpperCase().replace(/\s+/g, "") : "";
  const stateCode = gstinLocked ? (india ? (stateCodeFromName(clean.state) ?? org.stateCode ?? "") : "") : gstin ? gstin.slice(0, 2) : india ? (stateCodeFromName(clean.state) ?? "") : "";
  const keep = (v: string | null) => v ?? "";
  const payload: Record<string, unknown> = {
    legalName: clean.legalName,
    tradeName: keep(org.tradeName),
    gstin,
    pan: keep(org.pan),
    cin: keep(org.cin),
    addressLine1: clean.addressLine1,
    addressLine2: keep(org.addressLine2),
    city: clean.city,
    state: clean.state,
    stateCode,
    pincode: india ? clean.pincode.replace(/\s+/g, "") : clean.pincode,
    country: clean.country,
    email: keep(org.email),
    phone: keep(org.phone),
    bankName: keep(org.bankName),
    bankAccountNumber: keep(org.bankAccountNumber),
    bankIfsc: keep(org.bankIfsc),
    bankBranch: keep(org.bankBranch),
    upiId: keep(org.upiId),
    invoiceTerms: keep(org.invoiceTerms),
    invoiceNotes: keep(org.invoiceNotes),
    roundOffTotals: org.roundOffTotals,
  };
  // Without a `gstin` key the action leaves the head office's registration as it is.
  if (gstinLocked) delete payload.gstin;
  const saved = await updateOrganisation(payload);
  if (!saved.ok) {
    // Its refusals about the GSTIN or the PAN belong beside the GSTIN field.
    return { ok: false, error: saved.error, ...(/GSTIN|PAN/.test(saved.error) && !gstinLocked ? { issues: { gstin: saved.error } } : {}) };
  }
  revalidatePath("/dashboard");
  return { ok: true, data: { steps: (await gettingStartedFor(user.id)).steps } };
}
