import type { Metadata } from "next";
import Link from "next/link";
import { CircleCheck, Handshake, Inbox, Network, Store, Users, Wallet } from "lucide-react";
import { consoleExportPartners } from "@/actions/platform/console-partners";
import { KpiGrid, KpiTile } from "@/components/console/charts/kpi-tile";
import { MoneyList } from "@/components/console/charts/money-list";
import { EmptyState } from "@/components/console/kit/empty-state";
import { ExportCsvButton } from "@/components/console/kit/export-button";
import { SearchField, SelectFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { PartnerDirectoryTable } from "@/components/console/partners/directory-table";
import { COUNTRY_OPTIONS, PARTNERS_PATH, REQUESTS_PATH, countryName } from "@/components/console/partners/format";
import { NewPartnerButton } from "@/components/console/partners/new-partner-dialog";
import { LinkPager } from "@/components/console/partners/pager";
import { ProgrammeSettingsButton } from "@/components/console/partners/programme-settings";
import { plural } from "@/lib/console-shared/format";
import { PARTNER_KIND, PARTNER_STATUS } from "@/lib/console-shared/labels";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { exportParams, withParams, type RawParams } from "@/lib/console-shared/params";
import { PARTNER_KINDS, PARTNER_STATUSES, parsePartnerDirectoryFilters } from "@/lib/console-shared/partner-params";
import { capsFor } from "@/lib/console-shared/roles";
import { partnerDirectory, programmeSettingsView } from "@/lib/partners/console-data";
import { DEFAULT_TERMS, PARTNER_SETTING_RANGES, TAX_ID_KINDS } from "@/lib/partners/types";
import { consoleStaff } from "@/lib/platform/console-page";
import { plansList } from "@/lib/platform/console-data";
import { indiaClock } from "@/lib/time/zone";

export const metadata: Metadata = { title: "Partners" };

const LINK_BUTTON =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-base border border-line-strong bg-surface px-3 text-[13px] font-medium whitespace-nowrap text-text shadow-sm hover:bg-surface-sunken";

/**
 * Partners (spec §9.2): the programme's distributors and resellers, every staff member reads them.
 *
 *   MANAGERS   New partner (also `?new=1`, the palette), the directory's CSV (the partners' contacts)
 *   SELLERS    money — each partner's customers' MRR, its pending commission, the programme's
 *              attributed MRR — and "Requests (N)", the queue of what waits on staff
 *   OWNERS     change the programme settings; everybody else reads them
 *
 * The KPIs cover the whole programme, not the filters. The filters live in the address, so a list can
 * be shared or reloaded; the CSV runs the same parser on the server, so it matches the list on screen.
 */
export default async function ConsolePartnersPage({ searchParams }: PageProps<"/platform-console/partners">) {
  const staff = await consoleStaff(PAGE_ROLES.partners);
  const caps = capsFor(staff.role);
  const sp: RawParams = (await searchParams) ?? {};
  const f = parsePartnerDirectoryFilters(sp);
  const [directory, settings, plans] = await Promise.all([
    partnerDirectory(f, caps.partnerMoney),
    programmeSettingsView(),
    // The New partner dialog's plan rates: plans on sale, never an internal one (MANAGERS only draw it).
    caps.managePartners ? plansList() : Promise.resolve([]),
  ]);
  const { kpis } = directory;

  const chips: { key: string; label: string }[] = [];
  if (f.q) chips.push({ key: "q", label: `Search: ${f.q}` });
  if (f.kind) chips.push({ key: "kind", label: `Kind: ${PARTNER_KIND[f.kind].label}` });
  if (f.status) chips.push({ key: "status", label: `Status: ${PARTNER_STATUS[f.status].label}` });
  if (f.country) chips.push({ key: "country", label: `Territory: ${countryName(f.country)}` });
  if (f.parent) chips.push({ key: "parent", label: `Distributor: ${directory.distributors.find((d) => d.slug === f.parent)?.displayName ?? f.parent}` });
  const filtered = chips.length > 0;

  const options = {
    distributors: directory.distributors,
    plans: plans.filter((p) => p.active && p.kind !== "INTERNAL").map((p) => ({ key: p.key, name: p.name })),
    taxIdKinds: TAX_ID_KINDS,
    defaults: DEFAULT_TERMS,
    // The earliest day terms may start: India's today, as the server checks it (src/lib/partners/terms.ts).
    todayKey: indiaClock.dateKey(directory.asOf),
  };

  const requestsLink = caps.partnerMoney ? (
    <Link href={REQUESTS_PATH} className={LINK_BUTTON}>
      <Inbox aria-hidden="true" className="h-4 w-4" />
      {`Requests (${kpis.toReview ?? 0})`}
    </Link>
  ) : null;

  return (
    <>
      <PageHeader
        title="Partners"
        subtitle={`${plural(kpis.active, "active partner")} · ${plural(kpis.customers, "attributed customer")}`}
        asOf={directory.asOf}
        actions={
          <>
            {requestsLink}
            <ProgrammeSettingsButton view={settings} canEdit={caps.owner} ranges={PARTNER_SETTING_RANGES} />
            {caps.managePartners && <NewPartnerButton options={options} />}
          </>
        }
      />

      <div className="space-y-6">
        <KpiGrid columns={caps.partnerMoney ? 3 : 4}>
          <KpiTile label="Active partners" icon={<CircleCheck className="h-4 w-4" />} value={kpis.active} tone="success" href={withParams(PARTNERS_PATH, {}, { status: "ACTIVE" })} />
          <KpiTile label="Distributors" icon={<Network className="h-4 w-4" />} value={kpis.distributors} secondary="Not terminated" href={withParams(PARTNERS_PATH, {}, { kind: "DISTRIBUTOR" })} />
          <KpiTile label="Resellers" icon={<Store className="h-4 w-4" />} value={kpis.resellers} secondary="Not terminated" href={withParams(PARTNERS_PATH, {}, { kind: "RESELLER" })} />
          <KpiTile label="Attributed customers" icon={<Users className="h-4 w-4" />} value={kpis.customers} secondary="Open workspaces a partner sold" />
          {caps.partnerMoney && (
            <KpiTile label="Attributed MRR" icon={<Wallet className="h-4 w-4" />} value={<MoneyList amounts={kpis.mrr ?? []} />} secondary="Per currency, never added across them" />
          )}
          {caps.partnerMoney && (
            <KpiTile
              label="Items to review"
              icon={<Inbox className="h-4 w-4" />}
              value={kpis.toReview ?? 0}
              tone={(kpis.toReview ?? 0) > 0 ? "warning" : "neutral"}
              secondary="Applications, deals, requests, flags"
              href={REQUESTS_PATH}
            />
          )}
        </KpiGrid>

        <div>
          <FilterBar trailing={caps.managePartners ? <ExportCsvButton action={consoleExportPartners.bind(null, exportParams(sp))} /> : undefined}>
            <SearchField label="Search partners" placeholder="Name, address or contact email" />
            <SelectFilter param="kind" label="Kind" options={PARTNER_KINDS.map((k) => ({ value: k, label: PARTNER_KIND[k].label }))} />
            <SelectFilter param="status" label="Status" options={PARTNER_STATUSES.map((s) => ({ value: s, label: PARTNER_STATUS[s].label }))} />
            <SelectFilter param="country" label="Territory" allLabel="Anywhere" options={COUNTRY_OPTIONS} />
            {directory.distributors.length > 0 && (
              <SelectFilter param="parent" label="Distributor" allLabel="Any" options={directory.distributors.map((d) => ({ value: d.slug, label: d.displayName }))} />
            )}
          </FilterBar>
          <FilterChips chips={chips.map((c) => ({ ...c, removeHref: withParams(PARTNERS_PATH, sp, { [c.key]: null }) }))} clearHref={filtered ? PARTNERS_PATH : undefined} />

          <Panel padded={false}>
            {directory.rows.length > 0 ? (
              <PartnerDirectoryTable rows={directory.rows} withMoney={caps.partnerMoney} />
            ) : filtered ? (
              <EmptyState variant="filtered" title="No partner matches these filters" body="Try another kind, status or territory, or clear the search." clearHref={PARTNERS_PATH} />
            ) : (
              <EmptyState
                icon={<Handshake className="h-5 w-5" />}
                title="No partners yet"
                body="Distributors and resellers appear here once they are added, or once an application is accepted."
              />
            )}
          </Panel>
          <LinkPager
            page={directory.page}
            pageSize={directory.pageSize}
            total={directory.total}
            noun="partner"
            hrefFor={(n) => withParams(PARTNERS_PATH, sp, { page: n > 1 ? n : null })}
          />
        </div>
      </div>
    </>
  );
}
