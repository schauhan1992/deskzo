import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { hrefWith } from "@/components/console/commissions/format";
import { PartnerCommissionsTab, PartnerStatementsTab } from "@/components/console/commissions/partner-tabs";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { LabelPill } from "@/components/console/kit/status";
import { TabPanel } from "@/components/console/kit/tab-panel";
import { ConsoleTabs } from "@/components/console/kit/tabs";
import { ACTIVITY_PREFIX, PartnerActivityTab } from "@/components/console/partners/activity-tab";
import { PartnerBanners } from "@/components/console/partners/banners";
import { PartnerCustomersTab } from "@/components/console/partners/customers-tab";
import { PARTNERS_PATH, PARTNER_TABS_ID, countryName, partnerPath, territoriesText } from "@/components/console/partners/format";
import { PartnerHeaderActions, type EditSeed } from "@/components/console/partners/header-actions";
import { PartnerOverviewTab } from "@/components/console/partners/overview-tab";
import { PartnerPipelineTab } from "@/components/console/partners/pipeline-tab";
import { PartnerTermsTab } from "@/components/console/partners/terms-tab";
import { PartnerUsersTab } from "@/components/console/partners/users-tab";
import { dayMonthYear, istDayKey } from "@/lib/console-shared/format";
import { PARTNER_KIND, PARTNER_STATUS } from "@/lib/console-shared/labels";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import type { RawParams } from "@/lib/console-shared/params";
import { PARTNER_TABS, parseCommissionFilters, parsePartnerTab, type PartnerTab } from "@/lib/console-shared/partner-params";
import { capsFor } from "@/lib/console-shared/roles";
import { partnerCommissionsTab, partnerStatementsTab } from "@/lib/partners/commission-data";
import {
  parseActivityFilters,
  partnerActivity,
  partnerCustomers,
  partnerDirectory,
  partnerHeader,
  partnerOverview,
  partnerPipeline,
  partnerTermsView,
  partnerUsersView,
} from "@/lib/partners/console-data";
import { DEFAULT_TERMS, TAX_ID_KINDS } from "@/lib/partners/types";
import { consoleStaff } from "@/lib/platform/console-page";

const TAB_LABEL: Record<PartnerTab, string> = {
  overview: "Overview",
  customers: "Customers",
  pipeline: "Pipeline",
  commissions: "Commissions",
  statements: "Statements",
  users: "Users",
  terms: "Terms",
  activity: "Activity",
};

/** The query string as one string per key (the first of a repeated one), keys in a sane shape, values cut. */
function flat(raw: RawParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw).slice(0, 40)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string" && first.trim() && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key)) out[key] = first.trim().slice(0, 200);
  }
  return out;
}

export async function generateMetadata({ params }: PageProps<"/platform-console/partners/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  return { title: `${String(slug).slice(0, 64)} · Partners` };
}

/**
 * A partner's 360 (spec §9.2), built like the workspace 360: the header (an unknown address is a
 * 404), its banners, then every tab's loader at once and all eight panels rendered — the inactive
 * ones `hidden` — so switching is instant and every tab's text is in the first markup; `?tab=`
 * picks the one shown.
 *
 * Money — MRR, commission, tax ids, the payout mask, terms, statements — is loaded for SELLERS only
 * (`withMoney = caps.partnerMoney`); everyone else is told where it is. Reveal payout and Set payout
 * details are PAYERS'. Only the open tab reads its filters from the address (the Commissions tab its
 * unprefixed `status`, `currency`, `kind`, `from`, `to`, `page`; Activity its `a…` keys), and the open
 * tab's link keeps them, so switching away and back lands on the same list.
 */
export default async function ConsolePartnerPage({ params, searchParams }: PageProps<"/platform-console/partners/[slug]">) {
  const staff = await consoleStaff(PAGE_ROLES.partners);
  const caps = capsFor(staff.role);
  const { slug } = await params;
  const header = await partnerHeader(slug);
  if (!header) notFound();

  const sp: RawParams = (await searchParams) ?? {};
  const tab = parsePartnerTab(sp);
  const own = (key: PartnerTab): RawParams => (key === tab ? sp : {});
  const money = caps.partnerMoney;
  const id = header.id;

  const [overview, customers, pipeline, users, terms, activity, commissions, statements, parents] = await Promise.all([
    partnerOverview(id, money),
    partnerCustomers(id, money),
    partnerPipeline(id),
    partnerUsersView(id),
    partnerTermsView(id, money),
    partnerActivity(id, parseActivityFilters(own("activity"), ACTIVITY_PREFIX), money),
    money ? partnerCommissionsTab(id, parseCommissionFilters(own("commissions"))) : Promise.resolve(null),
    money ? partnerStatementsTab(id) : Promise.resolve(null),
    // Edit's distributor picker (MANAGERS only draw it).
    caps.managePartners ? partnerDirectory({ kind: "DISTRIBUTOR", page: 1 }, false) : Promise.resolve(null),
  ]);
  if (!overview) notFound();

  const base = partnerPath(header.slug);
  const todayKey = istDayKey(header.asOf);
  const ownLink = (key: PartnerTab) => {
    const p = flat(own(key));
    delete p.tab;
    return p;
  };
  // The open tab's link keeps its filters; the others are bare, as the tab bar leaves the address.
  const tabHref = (key: PartnerTab) => (key === tab ? hrefWith(base, key === "overview" ? ownLink(key) : { ...ownLink(key), tab: key }) : key === "overview" ? base : `${base}?tab=${key}`);
  const activityHref = (n: number) => hrefWith(base, { ...ownLink("activity"), tab: "activity" }, { [`${ACTIVITY_PREFIX}page`]: n > 1 ? n : null });

  const partnerRef = { id, slug: header.slug, displayName: header.displayName };
  const edit: EditSeed | null = caps.managePartners
    ? {
        kind: overview.profile.kind,
        parentSlug: overview.profile.parent?.slug ?? null,
        legalName: overview.profile.legalName,
        displayName: overview.profile.displayName,
        country: overview.profile.country,
        territories: overview.profile.territories,
        contact: overview.contact,
        website: overview.profile.website,
        address: overview.address,
        taxIds: overview.money?.taxIds ?? null,
        publicListing: overview.profile.publicListing,
        publicBlurb: overview.profile.publicBlurb,
      }
    : null;

  const chips = (
    <>
      <LabelPill map={PARTNER_KIND} value={header.kind} />
      <LabelPill map={PARTNER_STATUS} value={header.status} />
    </>
  );

  const subtitle = (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      {header.parent && (
        <>
          <span className="text-xs">
            {"Under "}
            <Link href={partnerPath(header.parent.slug)} className="font-medium text-text hover:text-brand">
              {header.parent.displayName}
            </Link>
          </span>
          <span aria-hidden="true" className="text-subtle">
            ·
          </span>
        </>
      )}
      <span className="font-mono text-xs" title={header.territories.map((c) => `${countryName(c)} (${c})`).join(", ")}>
        {territoriesText(header.territories, 6)}
      </span>
      <span aria-hidden="true" className="text-subtle">
        ·
      </span>
      <span className="text-xs">{`${countryName(header.country)} · ${header.slug}`}</span>
      <span aria-hidden="true" className="text-subtle">
        ·
      </span>
      <span className="text-xs">{`created ${dayMonthYear(header.createdAt)}`}</span>
    </span>
  );

  const moneyNote = (what: string) => (
    <Panel>
      <p className="text-sm text-muted">{`${what} are visible to billing staff.`}</p>
    </Panel>
  );

  return (
    <>
      <PageHeader
        title={header.displayName}
        crumbs={[{ label: "Partners", href: PARTNERS_PATH }, { label: header.displayName }]}
        chips={chips}
        subtitle={subtitle}
        asOf={header.asOf}
        actions={
          caps.managePartners || caps.payPartners ? (
            <PartnerHeaderActions
              partner={{
                id,
                slug: header.slug,
                displayName: header.displayName,
                kind: header.kind,
                status: header.status,
                termsInForce: header.termsInForce,
                activeAdmins: header.activeAdmins,
                customersStillAttributed: header.customersStillAttributed,
                payoutOnFile: header.payoutOnFile,
              }}
              caps={caps}
              edit={edit}
              distributors={parents?.distributors ?? []}
              taxIdKinds={TAX_ID_KINDS}
            />
          ) : undefined
        }
      />

      <div className="space-y-6">
        <PartnerBanners header={header} caps={caps} />

        <div>
          <ConsoleTabs
            label="Partner sections"
            idPrefix={PARTNER_TABS_ID}
            active={tab}
            tabs={PARTNER_TABS.map((key) => ({
              key,
              label: TAB_LABEL[key],
              href: tabHref(key),
              count: key === "customers" ? customers.total : key === "users" ? users.activeUsers : undefined,
            }))}
          />
          <div className="mt-6">
            <TabPanel idPrefix={PARTNER_TABS_ID} tabKey="overview" active={tab === "overview"}>
              <PartnerOverviewTab header={header} overview={overview} caps={caps} />
            </TabPanel>
            <TabPanel idPrefix={PARTNER_TABS_ID} tabKey="customers" active={tab === "customers"}>
              <PartnerCustomersTab data={customers} withMoney={money} partnerName={header.displayName} />
            </TabPanel>
            <TabPanel idPrefix={PARTNER_TABS_ID} tabKey="pipeline" active={tab === "pipeline"}>
              <PartnerPipelineTab data={pipeline} caps={caps} partnerName={header.displayName} />
            </TabPanel>
            <TabPanel idPrefix={PARTNER_TABS_ID} tabKey="commissions" active={tab === "commissions"}>
              {commissions ? <PartnerCommissionsTab partner={partnerRef} data={commissions} caps={caps} /> : moneyNote("Commissions")}
            </TabPanel>
            <TabPanel idPrefix={PARTNER_TABS_ID} tabKey="statements" active={tab === "statements"}>
              {statements ? <PartnerStatementsTab partner={partnerRef} data={statements} caps={caps} viewerId={staff.id} /> : moneyNote("Statements")}
            </TabPanel>
            <TabPanel idPrefix={PARTNER_TABS_ID} tabKey="users" active={tab === "users"}>
              <PartnerUsersTab data={users} caps={caps} partnerName={header.displayName} />
            </TabPanel>
            <TabPanel idPrefix={PARTNER_TABS_ID} tabKey="terms" active={tab === "terms"}>
              <PartnerTermsTab
                view={terms}
                caps={caps}
                partner={{ id, displayName: header.displayName, kind: header.kind, terminated: header.status === "TERMINATED" }}
                defaults={DEFAULT_TERMS[header.kind]}
                plans={terms?.plans ?? []}
                todayKey={todayKey}
              />
            </TabPanel>
            <TabPanel idPrefix={PARTNER_TABS_ID} tabKey="activity" active={tab === "activity"}>
              <PartnerActivityTab data={activity} todayKey={todayKey} hrefFor={activityHref} />
            </TabPanel>
          </div>
        </div>
      </div>
    </>
  );
}
