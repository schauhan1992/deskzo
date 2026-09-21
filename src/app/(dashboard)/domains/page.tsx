import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { domainFilterOptions, domainSummary, listDomainProfiles } from "@/actions/domain";
import { Card } from "@/components/ui/card";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { DomainRows } from "@/components/domains/domain-rows";

/**
 * The prospecting view over everything the domain lookups found.
 *
 * The stat cards are framed as openings rather than counts — "no DMARC" is a list of companies
 * whose domain can be impersonated, which is a conversation, where "42 profiles" is trivia.
 */
export default async function DomainsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    platform?: string;
    emailProvider?: string;
    view?: string;
    page?: string;
    pageSize?: string;
  }>;
}) {
  const enabled = await isModuleEnabled("domains");
  if (!enabled) return <ModuleDisabledNotice moduleKey="domains" />;

  const params = await searchParams;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);

  const [result, summary, options] = await Promise.all([
    listDomainProfiles({
      page,
      pageSize,
      search: params.q,
      platform: params.platform,
      emailProvider: params.emailProvider,
      view: params.view,
    }),
    domainSummary(),
    domainFilterOptions(),
  ]);

  function tabHref(view?: string) {
    const next = { ...params, view, page: undefined };
    const query = Object.fromEntries(Object.entries(next).filter(([, v]) => v)) as Record<string, string>;
    return { pathname: "/domains", query };
  }

  return (
    <div className="animate-fade-rise">
      <div>
        <h1 className="text-xl font-semibold text-text">Domain Intel</h1>
        <p className="mt-1 text-sm text-muted">
          What public DNS and each company&apos;s own website say about them — who runs their email, what the site is
          built on, and whether the domain can be spoofed. Read on demand, never in the background.
        </p>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Looked up</div>
          <div className="mt-1 text-lg font-semibold text-text">
            {summary.scanned}
            <span className="ml-1 text-sm font-normal text-subtle">of {summary.withWebsite}</span>
          </div>
          <div className="mt-0.5 text-xs text-muted">companies with a website</div>
        </Card>
        <Card className={`px-4 py-3 ${summary.noDmarc > 0 ? "border-warning/40" : ""}`}>
          <div className="text-xs uppercase tracking-wide text-subtle">Spoofable</div>
          <div className={`mt-1 text-lg font-semibold ${summary.noDmarc > 0 ? "text-warning" : "text-text"}`}>
            {summary.noDmarc}
          </div>
          <div className="mt-0.5 text-xs text-muted">no DMARC — a security conversation</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">On Google Workspace</div>
          <div className="mt-1 text-lg font-semibold text-text">{summary.googleWorkspace}</div>
          <div className="mt-0.5 text-xs text-muted">a Microsoft 365 comparison each</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Self-hosted mail</div>
          <div className="mt-1 text-lg font-semibold text-text">{summary.selfHosted}</div>
          <div className="mt-0.5 text-xs text-muted">the clearest migrations on the list</div>
        </Card>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {[
          { label: "All", view: undefined },
          { label: "Not looked up yet", view: "unscanned" },
        ].map((tab) => (
          <Link
            key={tab.label}
            href={tabHref(tab.view)}
            className={`rounded-full px-3 py-1 text-sm transition-colors ${
              (tab.view === "unscanned") === (params.view === "unscanned")
                ? "bg-brand text-brand-contrast"
                : "border border-line-strong bg-surface text-muted hover:text-text"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search company or website…" />
        <SelectParamFilter
          paramName="emailProvider"
          label="Email"
          allLabel="Any"
          options={options.emailProviders.map((p) => ({ value: p, label: p }))}
        />
        <SelectParamFilter
          paramName="platform"
          label="Platform"
          allLabel="Any"
          options={options.platforms.map((p) => ({ value: p, label: p }))}
        />
      </div>

      <div className="mt-5">
        <DomainRows rows={result.rows} />
      </div>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={result.total}
        totalPages={totalPages(result.total, pageSize)}
        pageSizes={PAGE_SIZES}
      />
    </div>
  );
}
