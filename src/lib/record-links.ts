import { formatCompanyId, formatItemId, formatLeadId, formatOrderId, formatUserId } from "@/lib/order-id";
import { formatTicketId } from "@/lib/tickets";
import { formatVisitId } from "@/lib/visits";
import { formatExpenseId } from "@/lib/expenses";

/**
 * Where a link to a record points: its readable address, /companies/COM-000123.
 *
 * The detail routes still open a cuid (src/lib/record-url.ts), because links in old emails and
 * bookmarks have to keep working. They do it by redirecting, and a redirect is not free. Next
 * follows it and then fetches the new address again itself, so both requests render the page at
 * the same time. An app link that hands over the cuid therefore makes the reader wait for the page
 * twice over. These take the record's sequence, and so the link goes where it is going.
 *
 * Client-safe: nothing here reaches the database.
 *
 * Only the detail page itself takes a reference. /edit, /handover and /settlement still want the
 * cuid; they never redirect, so a cuid costs them nothing.
 */
export const companyPath = (companySeq: number) => `/companies/${formatCompanyId(companySeq)}`;
export const leadPath = (leadSeq: number) => `/leads/${formatLeadId(leadSeq)}`;
export const orderPath = (orderSeq: number) => `/orders/${formatOrderId(orderSeq)}`;
export const itemPath = (itemSeq: number) => `/items/${formatItemId(itemSeq)}`;
export const personPath = (userSeq: number) => `/people/${formatUserId(userSeq)}`;
export const ticketPath = (ticketSeq: number) => `/tickets/${formatTicketId(ticketSeq)}`;
export const visitPath = (visitSeq: number) => `/visits/${formatVisitId(visitSeq)}`;
export const expensePath = (expenseSeq: number) => `/expenses/${formatExpenseId(expenseSeq)}`;
