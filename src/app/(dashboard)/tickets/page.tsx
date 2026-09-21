import Link from "next/link";
import { listTicketsPaged, countOpenTickets, listSupportAgents } from "@/actions/ticket";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { auth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { TicketsTable } from "@/components/tickets/tickets-table";
import { TicketSplitList } from "@/components/tickets/ticket-split-list";
import { TicketDetail } from "@/components/tickets/ticket-detail";
import { SplitListShell, SplitListEmpty, SplitListPage, resolveSelected } from "@/components/ui/split-list";
import { ViewModeToggle } from "@/components/ui/view-mode-toggle";
import { getViewMode } from "@/actions/view-mode";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { ticketTypeLabels } from "@/lib/tickets";
import { ticketStatusValues, ticketPriorityValues, ticketTypeValues } from "@/lib/validation/ticket";
import type { TicketStatus, TicketPriority, TicketType } from "@prisma/client";

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    priority?: string;
    type?: string;
    assignedTo?: string;
    q?: string;
    page?: string;
    pageSize?: string;
    sel?: string;
  }>;
}) {
  const enabled = await isModuleEnabled("helpdesk");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="helpdesk" />;
  }

  const [params, session] = await Promise.all([searchParams, auth()]);
  const userId = session!.user.id;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const filters = {
    status: params.status as TicketStatus | undefined,
    priority: params.priority as TicketPriority | undefined,
    ticketType: params.type as TicketType | undefined,
    assignedToUserId: params.assignedTo,
    search: params.q,
  };
  const [viewMode, canCreate, result, supportAgents, openCount] = await Promise.all([
    getViewMode("tickets"),
    hasEffectivePermission(userId, "tickets.create"),
    listTicketsPaged({ ...filters, page, pageSize }),
    listSupportAgents(),
    countOpenTickets(filters),
  ]);

  const selected = viewMode === "split" ? resolveSelected(result.rows, params.sel) : null;

  return (
    <SplitListPage active={viewMode === "split"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">Tickets</h1>
          <p className="mt-1 text-sm text-muted">
            {result.total} total · {openCount} open
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ViewModeToggle viewKey="tickets" mode={viewMode} />
          {canCreate && (
            <Link href="/tickets/new">
              <Button>New ticket</Button>
            </Link>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search title or company…" />
        <SelectParamFilter
          paramName="status"
          label="Status"
          options={ticketStatusValues.map((s) => ({ value: s, label: s.replaceAll("_", " ") }))}
        />
        <SelectParamFilter
          paramName="priority"
          label="Priority"
          options={ticketPriorityValues.map((p) => ({ value: p, label: p }))}
        />
        <SelectParamFilter
          paramName="type"
          label="Type"
          options={ticketTypeValues.map((t) => ({ value: t, label: ticketTypeLabels[t] }))}
        />
        <SelectParamFilter
          paramName="assignedTo"
          label="Assigned to"
          allLabel="Everyone"
          options={[
            { value: "unassigned", label: "Unassigned" },
            ...supportAgents.map((u) => ({ value: u.id, label: u.name })),
          ]}
        />
      </div>

      {viewMode === "split" ? (
        <SplitListShell
          countLabel={`${result.total} ticket${result.total === 1 ? "" : "s"}`}
          listPane={<TicketSplitList tickets={result.rows} selectedId={selected} />}
        >
          {selected ? <TicketDetail id={selected} /> : <SplitListEmpty message="No tickets match these filters." />}
        </SplitListShell>
      ) : (
        <>
          <Card className="mt-6 overflow-x-auto p-0">
            <TicketsTable tickets={result.rows} bulkAgents={supportAgents} />
          </Card>

          <Pagination
            page={page}
            pageSize={pageSize}
            total={result.total}
            totalPages={totalPages(result.total, pageSize)}
            pageSizes={PAGE_SIZES}
          />
        </>
      )}
    </SplitListPage>
  );
}
