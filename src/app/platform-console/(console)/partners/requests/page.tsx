import type { Metadata } from "next";
import { Inbox } from "lucide-react";
import { EmptyState } from "@/components/console/kit/empty-state";
import { UrlTabs, ViewTabs } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { PARTNERS_PATH, REQUESTS_PATH } from "@/components/console/partners/format";
import { LinkPager } from "@/components/console/partners/pager";
import { ApplicationsQueue, AttributionsQueue, ChangesQueue, DealsQueue, ResellersQueue } from "@/components/console/partners/request-queues";
import { istDayKey, plural } from "@/lib/console-shared/format";
import { withParams, type RawParams } from "@/lib/console-shared/params";
import { REQUEST_TABS, parseRequestTab, type RequestTab } from "@/lib/console-shared/partner-params";
import { SELLERS, capsFor } from "@/lib/console-shared/roles";
import { parseRequestsFilters, partnerDirectory, requestsBoard } from "@/lib/partners/console-data";
import { DEFAULT_TERMS, TAX_ID_KINDS } from "@/lib/partners/types";
import { consoleStaff } from "@/lib/platform/console-page";
import { plansList } from "@/lib/platform/console-data";

export const metadata: Metadata = { title: "Partner requests" };

const TAB_LABEL: Record<RequestTab, string> = {
  applications: "Applications",
  deals: "Deals",
  changes: "Changes",
  resellers: "Resellers",
  attributions: "Attributions",
};

/** What each tab says when nothing waits — and when nothing at all has come in. */
const EMPTY: Record<RequestTab, { open: string; all: string; body: string }> = {
  applications: { open: "No applications waiting", all: "No applications yet", body: "Companies apply from the public “Become a partner” page." },
  deals: { open: "No deal registrations waiting", all: "No deal registrations yet", body: "Partners register companies they are selling to from their portal." },
  changes: { open: "No changes waiting", all: "No change requests yet", body: "Partners ask for profile and payout changes from their portal." },
  resellers: { open: "No new resellers waiting", all: "No reseller requests yet", body: "Distributors propose new resellers from their portal." },
  attributions: { open: "No flagged attributions waiting", all: "No flagged attributions", body: "A signup outside its partner's territories, or claimed by more than one partner, is flagged here." },
};

/**
 * Partner requests (SELLERS; spec §9.2): what partners and applicants sent that waits on staff, one
 * tab each — applications, deal registrations, profile and payout changes, new resellers, flagged
 * attributions. Each tab is its own load (real links, only the open one is read), "Waiting on staff"
 * by default, "Everything" with the decided ones too. Each decision is drawn only for the roles its
 * action allows, and every action checks again.
 */
export default async function ConsolePartnerRequestsPage({ searchParams }: PageProps<"/platform-console/partners/requests">) {
  const staff = await consoleStaff(SELLERS);
  const caps = capsFor(staff.role);
  const sp: RawParams = (await searchParams) ?? {};
  const tab = parseRequestTab(sp);
  const f = parseRequestsFilters(sp);
  // The dialogs that make partners need the plan list (plan rates) and, for an application, the distributors.
  const makesPartners = caps.managePartners && (tab === "applications" || tab === "resellers");
  const [board, plans, parents] = await Promise.all([
    requestsBoard(tab, f),
    makesPartners ? plansList() : Promise.resolve([]),
    caps.managePartners && tab === "applications" ? partnerDirectory({ kind: "DISTRIBUTOR", page: 1 }, false) : Promise.resolve(null),
  ]);
  const todayKey = istDayKey(board.asOf);
  const offered = plans.filter((p) => p.active && p.kind !== "INTERNAL").map((p) => ({ key: p.key, name: p.name }));
  const all = board.show === "all";
  const tabHref = (key: RequestTab) => withParams(REQUESTS_PATH, {}, { tab: key === "applications" ? null : key, show: all ? "all" : null });
  const showHref = (show: "open" | "all") => withParams(REQUESTS_PATH, {}, { tab: tab === "applications" ? null : tab, show: show === "all" ? "all" : null });

  let table;
  switch (board.tab) {
    case "applications":
      table = (
        <ApplicationsQueue
          rows={board.rows}
          caps={caps}
          options={caps.managePartners ? { distributors: parents?.distributors ?? [], plans: offered, taxIdKinds: TAX_ID_KINDS, defaults: DEFAULT_TERMS, todayKey } : null}
        />
      );
      break;
    case "deals":
      table = <DealsQueue rows={board.rows} caps={caps} />;
      break;
    case "changes":
      table = <ChangesQueue rows={board.rows} caps={caps} />;
      break;
    case "resellers":
      table = <ResellersQueue rows={board.rows} caps={caps} terms={caps.managePartners ? { plans: offered, defaults: DEFAULT_TERMS.RESELLER, todayKey } : null} />;
      break;
    default:
      table = <AttributionsQueue rows={board.rows} caps={caps} />;
  }

  const empty = EMPTY[tab];
  return (
    <>
      <PageHeader
        title="Partner requests"
        crumbs={[{ label: "Partners", href: PARTNERS_PATH }, { label: "Requests" }]}
        subtitle={board.counts.total > 0 ? `${plural(board.counts.total, "item")} waiting on staff.` : "Nothing waits on staff."}
        asOf={board.asOf}
      />

      <div className="space-y-4">
        <UrlTabs
          label="Request kinds"
          items={REQUEST_TABS.map((key) => ({ key, label: TAB_LABEL[key], href: tabHref(key), active: key === tab, count: board.counts[key] }))}
        />
        <ViewTabs
          label="Which requests"
          items={[
            { key: "open", label: "Waiting on staff", href: showHref("open"), active: !all, count: board.counts[tab] },
            { key: "all", label: "Everything", href: showHref("all"), active: all },
          ]}
        />
        <Panel padded={false}>
          {board.rows.length === 0 ? <EmptyState icon={<Inbox className="h-5 w-5" />} title={all ? empty.all : empty.open} body={empty.body} /> : table}
        </Panel>
        <LinkPager page={board.page} pageSize={board.pageSize} total={board.total} noun="item" hrefFor={(n) => withParams(REQUESTS_PATH, sp, { page: n > 1 ? n : null })} />
      </div>
    </>
  );
}
