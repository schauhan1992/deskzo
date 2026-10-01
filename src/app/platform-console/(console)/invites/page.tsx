import type { Metadata } from "next";
import Link from "next/link";
import { LockOpen, Plus, Ticket } from "lucide-react";
import { Banner } from "@/components/console/kit/banner";
import { EmptyState } from "@/components/console/kit/empty-state";
import { SearchField } from "@/components/console/kit/filter-controls";
import { FilterBar, ViewTabs } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { InvitesTable } from "@/components/console/invites/invites-table";
import { NewInviteButton } from "@/components/console/invites/new-invite-dialog";
import { Pagination } from "@/components/ui/pagination";
import { plural } from "@/lib/console-shared/format";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { parseInviteFilters, withParams, type InviteFilters } from "@/lib/console-shared/params";
import { capsFor } from "@/lib/console-shared/roles";
import { consoleStaff } from "@/lib/platform/console-page";
import { invitesBoard } from "@/lib/platform/console-data";

export const metadata: Metadata = { title: "Invitations" };

const PATH = "/invites";
const num = (n: number) => n.toLocaleString("en-IN");

const STATUS_TABS: { key: InviteFilters["status"]; label: string }[] = [
  { key: "live", label: "Live" },
  { key: "used", label: "Used up" },
  { key: "expired", label: "Expired or ended" },
  { key: "all", label: "All" },
];

/** A tab with nothing in it says so in its own words. */
const EMPTY: Record<Exclude<InviteFilters["status"], "live">, string> = {
  used: "No invitation has been used up.",
  expired: "No invitation has expired or been ended.",
  all: "No invitations yet.",
};

/**
 * Invitations (spec §3.7): the codes that let somebody sign up and set up a workspace, how much of
 * each is used, and the workspaces made with them. Every staff member may look; managers make, end
 * and extend them (the button, the dialog and the row menus are drawn for them alone). The code is
 * shown once, in the dialog that made it — only its hash is stored.
 */
export default async function ConsoleInvitesPage({ searchParams }: PageProps<"/platform-console/invites">) {
  const staff = await consoleStaff(PAGE_ROLES.invites);
  const caps = capsFor(staff.role);
  const sp = await searchParams;
  const f = parseInviteFilters(sp);
  const board = await invitesBoard(f);
  const counts = board.counts;
  const totalPages = Math.max(1, Math.ceil(board.total / board.pageSize));

  const newInviteLink = (
    <Link
      href={withParams(PATH, sp, { new: 1 })}
      scroll={false}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-base bg-brand px-3 text-[13px] font-medium whitespace-nowrap text-brand-contrast shadow-sm hover:brightness-110"
    >
      <Plus aria-hidden="true" className="h-4 w-4" />
      New invitation
    </Link>
  );

  return (
    <>
      <PageHeader
        title="Invitations"
        subtitle={`${plural(counts.live, "invitation")} live · ${num(counts.used)} used up · ${num(counts.all)} in all${f.q ? " matching the search" : ""}`}
        actions={caps.manage ? <NewInviteButton plans={board.plans} signupUrl={board.signupUrl} workspaceSuffix={board.workspaceSuffix} mayHoldReserved={caps.manage} /> : undefined}
      />

      <div className="space-y-6">
        <Banner
          tone={board.signupOpen ? "info" : "brand"}
          icon={board.signupOpen ? <LockOpen className="h-4 w-4" /> : <Ticket className="h-4 w-4" />}
          title={
            board.signupOpen
              ? "Open signup is on: invitations are optional and can pre-select a plan."
              : "Signup is invite-only: people need one of these to sign up."
          }
          action={
            caps.viewSettings ? (
              <Link href="/settings#signup" className="text-[13px] font-medium whitespace-nowrap hover:underline">
                Signup settings
              </Link>
            ) : undefined
          }
        />

        <section aria-label="Invitations">
          <FilterBar trailing={<SearchField label="Search by note" placeholder="Search by note" />}>
            <ViewTabs
              label="Invitation status"
              items={STATUS_TABS.map((tab) => ({
                key: tab.key,
                label: tab.label,
                href: withParams(PATH, sp, { status: tab.key === "live" ? null : tab.key }),
                active: f.status === tab.key,
                count: counts[tab.key],
              }))}
            />
          </FilterBar>

          {board.rows.length > 0 ? (
            <>
              <Panel padded={false}>
                <InvitesTable rows={board.rows} caps={caps} />
              </Panel>
              {totalPages > 1 && (
                <Pagination
                  page={board.page}
                  pageSize={board.pageSize}
                  total={board.total}
                  totalPages={totalPages}
                  pageSizes={[board.pageSize]}
                  label={board.total === 1 ? "invitation" : "invitations"}
                />
              )}
            </>
          ) : (
            <Panel padded={false}>
              {f.q ? (
                <EmptyState variant="filtered" title="No invitation matches." body="Search by another part of the note." clearHref={withParams(PATH, sp, { q: null })} />
              ) : f.status === "live" ? (
                <EmptyState
                  icon={<Ticket className="h-5 w-5" />}
                  title="No live invitations"
                  body={
                    board.signupOpen
                      ? "Anybody can sign up now; an invitation still lets you choose the plan they start on."
                      : "Nobody can sign up without one. Make an invitation and send its code."
                  }
                  action={caps.manage ? newInviteLink : undefined}
                />
              ) : (
                <EmptyState icon={<Ticket className="h-5 w-5" />} title={EMPTY[f.status]} />
              )}
            </Panel>
          )}
        </section>
      </div>
    </>
  );
}
