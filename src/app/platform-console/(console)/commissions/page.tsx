import type { Metadata } from "next";
import { ReportPending } from "@/components/console/commissions/report-pending";
import { ReportsTab } from "@/components/console/commissions/reports-tab";
import { ReviewTab } from "@/components/console/commissions/review-tab";
import { GenerateStatementsButton, RunCommissionsButton } from "@/components/console/commissions/run-buttons";
import { StatementDrawer } from "@/components/console/commissions/statement-drawer";
import { StatementsTab } from "@/components/console/commissions/statements-tab";
import { COMMISSIONS_PATH, hrefWith } from "@/components/console/commissions/format";
import { PageHeader } from "@/components/console/kit/page-header";
import { TabPanel } from "@/components/console/kit/tab-panel";
import { ConsoleTabs } from "@/components/console/kit/tabs";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { exportParams, one, type RawParams } from "@/lib/console-shared/params";
import {
  COMMISSION_TABS,
  parseCommissionFilters,
  parseCommissionTab,
  parseReportFilters,
  parseStatementFilters,
  type CommissionTab,
} from "@/lib/console-shared/partner-params";
import { capsFor } from "@/lib/console-shared/roles";
import { commissionReview, partnerReport, statementDetail, statementsBoard } from "@/lib/partners/commission-data";
import { consoleClock } from "@/lib/platform/console-clock";
import { consoleStaff } from "@/lib/platform/console-page";
import { indiaClock } from "@/lib/time/zone";

export const metadata: Metadata = { title: "Commissions" };

/** The tab bar's id prefix. */
const TABS_ID = "cm";

const TAB_LABEL: Record<CommissionTab, string> = { review: "Review", statements: "Statements", reports: "Reports" };
const BARE_HREF: Record<CommissionTab, string> = {
  review: COMMISSIONS_PATH,
  statements: `${COMMISSIONS_PATH}?tab=statements`,
  reports: `${COMMISSIONS_PATH}?tab=reports`,
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

/**
 * Commissions (SELLERS: owner, admin, billing; spec §9.2): what partners are owed and what was paid.
 *
 *   Review       commission entries across partners — pending ones, the flagged first — with void,
 *                adjustments and the CSV
 *   Statements   the monthly statements; payers (owner, billing) approve, record payment and void,
 *                everyone here opens one in its drawer (`?statement=<id>`) and exports it
 *   Reports      revenue by partner and by country for an IST window, and its CSV
 *
 * The programme's money days — a report's window, the day an entry was earned, an adjustment's and a
 * payment's day — are India's, whatever zone the console keeps: commission is counted in India's
 * months, as its statements are (src/lib/partners/statements.ts). When staff did something — generated,
 * approved, voided — is on the console's clock.
 *
 * Review and Statements are both light (a page of fifty and a few counts), so both panels are always
 * rendered — switching between them is instant, and the Statements controls are in the first markup
 * whichever tab is open. Reports adds up every partner's and country's MRR, so it is worked out only
 * when it is the tab asked for; opened from the tab bar, its panel asks the server for it.
 *
 * Only the open tab reads the filters in the address; the others show their defaults, which is what
 * the address says once the tab bar has switched to them. Every control is drawn per role, and every
 * action checks the role again itself.
 */
export default async function ConsoleCommissionsPage({ searchParams }: PageProps<"/platform-console/commissions">) {
  const staff = await consoleStaff(PAGE_ROLES.commissions);
  const caps = capsFor(staff.role);
  const sp: RawParams = (await searchParams) ?? {};
  const tab = parseCommissionTab(sp);
  const own = (key: CommissionTab): RawParams => (key === tab ? sp : {});
  const statementId = one(sp, "statement", 40);

  const [review, board, report, detail, clock] = await Promise.all([
    commissionReview(parseCommissionFilters(own("review"))),
    statementsBoard(parseStatementFilters(own("statements"))),
    tab === "reports" ? partnerReport(parseReportFilters(sp)) : Promise.resolve(null),
    statementId ? statementDetail(statementId) : Promise.resolve(null),
    consoleClock(),
  ]);
  // The latest day an adjustment or a payment may be dated: India's today, as the server checks it.
  const todayKey = indiaClock.dateKey(board.asOf);

  /** A tab's own params for its links, without the tab and the drawer. */
  const linkParams = (key: CommissionTab) => {
    const p = flat(own(key));
    delete p.tab;
    delete p.statement;
    return p;
  };
  const exportArgs = (key: CommissionTab) => {
    const p = exportParams(own(key));
    delete p.tab;
    delete p.statement;
    return p;
  };
  // The open tab's link keeps its filters, so switching away and back lands on the same list.
  const tabHref = (key: CommissionTab) => (key === tab ? hrefWith(COMMISSIONS_PATH, key === "review" ? linkParams(key) : { ...linkParams(key), tab: key }) : BARE_HREF[key]);
  const toAct = board.counts.DRAFT + board.counts.APPROVED;

  return (
    <>
      <PageHeader
        title="Commissions"
        subtitle="What partners are owed: entries waiting for a statement, the monthly statements and their payment, and what the programme brought in."
        asOf={review.asOf}
        actions={
          caps.partnerMoney ? (
            <>
              <RunCommissionsButton />
              <GenerateStatementsButton nextPeriod={board.nextPeriod} />
            </>
          ) : undefined
        }
      />

      <div>
        <ConsoleTabs
          label="Commission sections"
          idPrefix={TABS_ID}
          active={tab}
          tabs={COMMISSION_TABS.map((key) => ({
            key,
            label: TAB_LABEL[key],
            href: tabHref(key),
            count: key === "review" ? review.total : key === "statements" ? toAct : undefined,
          }))}
        />
        <div className="mt-6">
          <TabPanel idPrefix={TABS_ID} tabKey="review" active={tab === "review"}>
            <ReviewTab data={review} params={linkParams("review")} exportArgs={exportArgs("review")} caps={caps} todayKey={todayKey} clock={clock} />
          </TabPanel>
          <TabPanel idPrefix={TABS_ID} tabKey="statements" active={tab === "statements"}>
            <StatementsTab board={board} params={linkParams("statements")} caps={caps} viewerId={staff.id} todayKey={todayKey} clock={clock} />
          </TabPanel>
          <TabPanel idPrefix={TABS_ID} tabKey="reports" active={tab === "reports"}>
            {report ? <ReportsTab report={report} exportArgs={exportArgs("reports")} caps={caps} /> : <ReportPending href={BARE_HREF.reports} />}
          </TabPanel>
        </div>
      </div>

      <StatementDrawer detail={detail} missing={statementId !== undefined && detail === null} caps={caps} viewerId={staff.id} twoPersonPayout={board.twoPersonPayout} todayKey={todayKey} />
    </>
  );
}
