"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { canSeeCompany, companyScope } from "@/lib/authz/company-scope";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { toDomain } from "@/lib/domain-intel/signatures";
import { inspectDomain } from "@/lib/domain-intel/lookup";
import { opportunitiesFrom, rankOpportunities } from "@/lib/domain-intel/opportunities";
import type { ActionResult } from "@/actions/company";
import { customerSide, isCustomerSide } from "@/lib/companies/roles";

/**
 * Domain Intel is for the companies we sell to (owner, 8 Oct 2026: "not required for vendor
 * companies"). A vendor's mail provider and DMARC record are no sales opening, so vendors, OEMs,
 * distributors, partners and commission parties are left out of the lists, the counts and the panel.
 */
const NOT_SOLD_TO = "Domain lookups are for customers and resellers — not vendors or partners.";
const GONE = "That company no longer exists.";

/**
 * The customers this person may see, as every company list does (src/lib/authz/company-scope.ts):
 * their own accounts, or every one with the reach to. Its own AND term, so a search's OR beside it
 * can never replace the account rule's.
 */
async function visibleSoldTo(userId: string): Promise<Prisma.CompanyWhereInput> {
  // Customers — a vendor that's also a customer too (src/lib/companies/roles.ts).
  return { AND: [await customerSide(), await companyScope(userId)] };
}

/** One company, when it is a customer this person may see — anything else answers as if it weren't there. */
async function visibleCustomer(userId: string, companyId: string): Promise<boolean> {
  const company = await db.company.findUnique({ where: { id: String(companyId ?? "") }, select: { ownerUserId: true, relationshipType: true } });
  return !!company && (await canSeeCompany(userId, company));
}

const profileSelect = {
  id: true,
  domain: true,
  finalUrl: true,
  httpStatus: true,
  siteTitle: true,
  siteDescription: true,
  platform: true,
  platformEvidence: true,
  hostProvider: true,
  hostEvidence: true,
  ipAddress: true,
  mxHosts: true,
  emailProvider: true,
  emailSecurityProvider: true,
  nsHosts: true,
  dnsProvider: true,
  registrar: true,
  registeredOn: true,
  expiresOn: true,
  spfRecord: true,
  dmarcRecord: true,
  dmarcPolicy: true,
  dkimFound: true,
  screenshotUrl: true,
  fetchedAt: true,
  error: true,
} satisfies Prisma.DomainProfileSelect;

/**
 * Looks the domain up and stores what came back.
 *
 * Deliberately on demand rather than on page load: it makes half a dozen outbound requests — public
 * DNS, the company's own homepage, and RDAP — and takes seconds, not milliseconds. The result is
 * cached on the profile until someone asks again, with `fetchedAt` on screen so nobody mistakes a
 * stale answer for a current one.
 */
export async function refreshDomainProfile(companyId: string): Promise<ActionResult<{ domain: string }>> {
  const user = await requireModuleUser("domains");

  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true, website: true, relationshipType: true, ownerUserId: true },
  });
  if (!company || !(await canSeeCompany(user.id, company))) return { ok: false, error: GONE };
  if (!(await isCustomerSide(company))) return { ok: false, error: NOT_SOLD_TO };

  const domain = toDomain(company.website);
  if (!domain) {
    return {
      ok: false,
      error: company.website
        ? `"${company.website}" doesn't look like a website address. Fix it on the company and try again.`
        : "This company has no website on file. Add one and the lookup can run.",
    };
  }

  try {
    const findings = await inspectDomain(domain);
    const data = {
      domain,
      finalUrl: findings.finalUrl,
      httpStatus: findings.httpStatus,
      siteTitle: findings.siteTitle,
      siteDescription: findings.siteDescription,
      platform: findings.platform,
      platformEvidence: findings.platformEvidence,
      hostProvider: findings.hostProvider,
      hostEvidence: findings.hostEvidence,
      ipAddress: findings.ipAddress,
      mxHosts: findings.mxHosts,
      emailProvider: findings.emailProvider,
      emailSecurityProvider: findings.emailSecurityProvider,
      nsHosts: findings.nsHosts,
      dnsProvider: findings.dnsProvider,
      registrar: findings.registrar,
      registeredOn: findings.registeredOn,
      expiresOn: findings.expiresOn,
      spfRecord: findings.spfRecord,
      dmarcRecord: findings.dmarcRecord,
      dmarcPolicy: findings.dmarcPolicy,
      dkimFound: findings.dkimFound,
      screenshotUrl: findings.screenshotUrl,
      fetchedAt: new Date(),
      // A previous failure shouldn't linger on a profile that has since succeeded.
      error: null,
    };

    await db.domainProfile.upsert({
      where: { companyId },
      create: { companyId, ...data },
      update: data,
    });

    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "DomainProfile",
      entityId: companyId,
      entityLabel: `Looked up ${domain} for ${company.name}`,
    });
    revalidatePath(`/companies/${companyId}`);
    revalidatePath("/domains");
    return { ok: true, data: { domain } };
  } catch (error) {
    // The whole lookup failing is rare — the individual steps swallow their own failures — so this
    // is recorded on the profile rather than shown once and lost.
    const message = error instanceof Error ? error.message : "The lookup failed.";
    await db.domainProfile.upsert({
      where: { companyId },
      create: { companyId, domain, error: message, fetchedAt: new Date() },
      update: { error: message, fetchedAt: new Date() },
    });
    revalidatePath(`/companies/${companyId}`);
    return { ok: false, error: message };
  }
}

export async function getDomainProfile(companyId: string) {
  const user = await requireModuleUser("domains");
  if (!(await visibleCustomer(user.id, companyId))) return null;
  const profile = await db.domainProfile.findUnique({ where: { companyId }, select: profileSelect });
  return profile ? toPlain(profile) : null;
}

/** The profile plus the sales reading of it — computed, never stored, so the rules stay editable. */
export async function getDomainBriefing(companyId: string) {
  const user = await requireModuleUser("domains");
  const [profile, company] = await Promise.all([
    db.domainProfile.findUnique({ where: { companyId }, select: profileSelect }),
    db.company.findUnique({
      where: { id: companyId },
      select: {
        website: true,
        linkedinUrl: true,
        employeeCount: true,
        category: true,
        companyType: true,
        relationshipType: true,
        ownerUserId: true,
        industry: { select: { name: true } },
      },
    }),
  ]);
  if (!company || !(await isCustomerSide({ id: companyId, relationshipType: company.relationshipType })) || !(await canSeeCompany(user.id, { ...company, id: companyId }))) return null;

  const opportunities = profile
    ? rankOpportunities(
        opportunitiesFrom({
          emailProvider: profile.emailProvider,
          emailSecurityProvider: profile.emailSecurityProvider,
          spfRecord: profile.spfRecord,
          dmarcRecord: profile.dmarcRecord,
          dmarcPolicy: profile.dmarcPolicy,
          dkimFound: profile.dkimFound,
          platform: profile.platform,
          hostProvider: profile.hostProvider,
          registrar: profile.registrar,
          expiresOn: profile.expiresOn,
          httpStatus: profile.httpStatus,
          finalUrl: profile.finalUrl,
          employeeCount: company.employeeCount,
        }),
      )
    : [];

  return toPlain({ profile, company, opportunities, domain: toDomain(company.website) });
}

/** Every company with a website, for the module's own list — the prospecting view. */
export async function listDomainProfiles(params: {
  page: number;
  pageSize: number;
  search?: string;
  platform?: string;
  emailProvider?: string;
  /** "unscanned" narrows to companies with a website nobody has looked up yet. */
  view?: string;
}) {
  const user = await requireModuleUser("domains");

  // Each condition its own AND term: two filters on the profile (a platform and a mail provider) used
  // to overwrite each other as keys of one object, and so would the account rule and the search.
  const where: Prisma.CompanyWhereInput = {
    AND: [
      await visibleSoldTo(user.id),
      ...(params.view === "unscanned" ? [{ domainProfile: { is: null } }] : []),
      ...(params.platform ? [{ domainProfile: { is: { platform: params.platform } } }] : []),
      ...(params.emailProvider ? [{ domainProfile: { is: { emailProvider: params.emailProvider } } }] : []),
    ],
    website: { not: null },
    ...(params.search
      ? {
          OR: [
            { name: { contains: params.search, mode: "insensitive" } },
            { website: { contains: params.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.company.findMany({
      where,
      orderBy: { name: "asc" },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      select: {
        id: true,
        companySeq: true,
        name: true,
        website: true,
        relationshipType: true,
        stage: true,
        employeeCount: true,
        industry: { select: { name: true } },
        owner: { select: { name: true } },
        domainProfile: { select: profileSelect },
      },
    }),
    db.company.count({ where }),
  ]);

  return toPlain({ rows, total });
}

/** Distinct values actually present, so the filters only offer things that will match something. */
export async function domainFilterOptions() {
  const user = await requireModuleUser("domains");
  const visible = await visibleSoldTo(user.id);
  const [platforms, providers] = await Promise.all([
    db.domainProfile.findMany({
      where: { company: visible, platform: { not: null } },
      distinct: ["platform"],
      select: { platform: true },
      orderBy: { platform: "asc" },
    }),
    db.domainProfile.findMany({
      where: { company: visible, emailProvider: { not: null } },
      distinct: ["emailProvider"],
      select: { emailProvider: true },
      orderBy: { emailProvider: "asc" },
    }),
  ]);
  return {
    platforms: platforms.map((p) => p.platform!).filter(Boolean),
    emailProviders: providers.map((p) => p.emailProvider!).filter(Boolean),
  };
}

export async function domainSummary() {
  const user = await requireModuleUser("domains");
  const visible = await visibleSoldTo(user.id);
  const [withWebsite, scanned, noDmarc, googleWorkspace, selfHosted] = await Promise.all([
    db.company.count({ where: { AND: [visible], website: { not: null } } }),
    db.domainProfile.count({ where: { company: visible } }),
    db.domainProfile.count({ where: { company: visible, dmarcRecord: null } }),
    db.domainProfile.count({ where: { company: visible, emailProvider: "Google Workspace" } }),
    db.domainProfile.count({ where: { company: visible, emailProvider: { in: ["Self-hosted or other", "Shared hosting mail"] } } }),
  ]);
  return { withWebsite, scanned, noDmarc, googleWorkspace, selfHosted };
}
