import Link from "next/link";
import { notFound } from "next/navigation";
import { CallButton } from "@/components/calls/call-button";
import { getTicket, listSupportAgents } from "@/actions/ticket";
import { listTasks } from "@/actions/task";
import { listAssignableUsers } from "@/actions/company";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { currentUser } from "@/lib/session";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { workspaceClock } from "@/lib/time/workspace";
import { formatOrderId } from "@/lib/order-id";
import {
  formatTicketId,
  getTicketSlaStatus,
  ticketPriorityTones,
  ticketStatusTones,
  ticketTypeLabels,
} from "@/lib/tickets";
import { TicketStatusControl } from "@/components/tickets/ticket-status-control";
import { TicketPriorityControl } from "@/components/tickets/ticket-priority-control";
import { AssignTicketButton } from "@/components/tickets/assign-ticket-button";
import { CommentThread } from "@/components/tickets/comment-thread";
import { DeleteTicketButton } from "@/components/tickets/delete-ticket-button";
import { TaskList } from "@/components/tasks/task-list";
import { CategoryChip } from "@/components/customers/category-chip";

/**
 * A ticket's full detail — SLA state, assignment, and the comment thread. Rendered on its own
 * page and again inside the Tickets split view.
 */
export async function TicketDetail({ id }: { id: string }) {
  const sessionUser = await currentUser();
  const userId = sessionUser!.id;
  const [ticket, users, canDelete, tasksEnabled, canDeleteAnyTask, clock] = await Promise.all([
    getTicket(id),
    listSupportAgents(),
    hasEffectivePermission(userId, "tickets.delete"),
    isModuleEnabled("tasks"),
    hasEffectivePermission(userId, "tasks.delete"),
    workspaceClock(),
  ]);
  if (!ticket) notFound();

  const [tasks, assignableUsers] = await Promise.all([
    tasksEnabled ? listTasks({ ticketId: id }) : Promise.resolve([]),
    tasksEnabled ? listAssignableUsers() : Promise.resolve([]),
  ]);

  const sla = getTicketSlaStatus(ticket.priority, ticket.status, ticket.createdAt, clock);

  return (
    <div className="@container space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-text">{formatTicketId(ticket.ticketSeq)}</h1>
            <Badge tone={ticketStatusTones[ticket.status]}>{ticket.status.replaceAll("_", " ")}</Badge>
            <Badge tone={ticketPriorityTones[ticket.priority]}>{ticket.priority}</Badge>
            <Badge tone={sla.tone}>{sla.label}</Badge>
          </div>
          <p className="mt-1 text-base font-medium text-text">{ticket.title}</p>
          <p className="mt-1 text-sm text-muted">
            <Link href={`/companies/${ticket.company.id}`} className="hover:underline">
              {ticket.company.name}
            </Link>
            <CategoryChip category={ticket.company.customerCategory} className="ml-1.5 align-middle" />
            {ticket.contact && ` · ${ticket.contact.name}`}
            {" · "}
            {ticketTypeLabels[ticket.ticketType]}
            {" · "}
            {ticket.companyProduct ? formatOrderId(ticket.companyProduct.orderSeq) : "Free Support"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CallButton
            companyId={ticket.company.id}
            companyName={ticket.company.name}
            ticketId={ticket.id}
            contact={ticket.contact ? { id: ticket.contact.id, name: ticket.contact.name, phone: ticket.contact.phone } : undefined}
          />
          {canDelete && <DeleteTicketButton ticketId={ticket.id} ticketSeq={ticket.ticketSeq} redirectTo="/tickets" />}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div>
          <div className="mb-1 text-xs uppercase tracking-wide text-subtle">Status</div>
          <TicketStatusControl ticketId={ticket.id} status={ticket.status} />
        </div>
        <div>
          <div className="mb-1 text-xs uppercase tracking-wide text-subtle">Priority</div>
          <TicketPriorityControl ticketId={ticket.id} priority={ticket.priority} />
        </div>
        <div>
          <div className="mb-1 text-xs uppercase tracking-wide text-subtle">Agent</div>
          <AssignTicketButton ticketId={ticket.id} assignedTo={ticket.assignedTo} users={users} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 @3xl:grid-cols-3">
        <div className="space-y-6 @3xl:col-span-2">
          <Card>
            <CardHeader className="text-sm font-medium text-text">Description</CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-sm text-text">
                {ticket.description || <span className="text-subtle">No description provided.</span>}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="text-sm font-medium text-text">Comments</CardHeader>
            <CardContent>
              <CommentThread ticketId={ticket.id} comments={ticket.comments} />
            </CardContent>
          </Card>

          {tasksEnabled && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Tasks</CardHeader>
              <CardContent>
                <TaskList
                  tasks={tasks}
                  users={assignableUsers}
                  currentUserId={userId}
                  canDeleteAny={canDeleteAnyTask}
                  context={{ companyId: ticket.company.id, ticketId: ticket.id }}
                />
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader className="text-sm font-medium text-text">Details</CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Company</span>
                <Link href={`/companies/${ticket.company.id}`} className="text-text hover:underline">
                  {ticket.company.name}
                </Link>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Contact</span>
                <span className="text-text">{ticket.contact?.name ?? "—"}</span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Support type</span>
                <span className="text-text">{ticketTypeLabels[ticket.ticketType]}</span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Order</span>
                {ticket.companyProduct ? (
                  <Link href={`/companies/${ticket.company.id}?tab=products`} className="text-text hover:underline">
                    {formatOrderId(ticket.companyProduct.orderSeq)} · {ticket.companyProduct.item.name}
                  </Link>
                ) : (
                  <span className="text-text">Free Support</span>
                )}
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Created by</span>
                <span className="text-text">{ticket.createdBy.name}</span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted">Created on</span>
                <span className="text-text">{clock.date(ticket.createdAt)}</span>
              </div>
              {ticket.resolvedAt && (
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Resolved on</span>
                  <span className="text-text">{clock.date(ticket.resolvedAt)}</span>
                </div>
              )}
              {ticket.closedAt && (
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Closed on</span>
                  <span className="text-text">{clock.date(ticket.closedAt)}</span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
