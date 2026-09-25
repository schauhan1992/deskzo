"use server";

import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { isModuleEnabled } from "@/actions/module";
import { listCompaniesPaged, listCustomersPaged, listVendorsPaged } from "@/actions/company";
import { listAllContactsPaged } from "@/actions/contact";
import { listLeadsPaged } from "@/actions/lead";
import { listOrdersPaged } from "@/actions/order";
import { listRenewalsPaged } from "@/actions/renewal";
import { listTicketsPaged } from "@/actions/ticket";
import { listProjects } from "@/actions/project";
import { listItems } from "@/actions/item";
import { listTradeDocuments } from "@/actions/trade-document";
import { formatCompanyId, formatItemId, formatLeadId, formatOrderId } from "@/lib/order-id";
import { formatTicketId } from "@/lib/tickets";
import { documentPath } from "@/lib/trade-documents";
import { formatDate } from "@/lib/utils";
import {
  SEARCH_MAX_LENGTH,
  SEARCH_MIN_LENGTH,
  SEARCH_RESULT_LIMIT,
  SEARCH_SCOPES,
  searchScope,
  type SearchHit,
  type SearchScope,
  type SearchScopeKey,
} from "@/lib/search/scopes";

/**
 * The header's search box — see src/lib/search/scopes.ts.
 *
 * It owns no query. Each scope calls the list action behind that list's own page, with the same
 * text the page would put in `?q=`, and keeps the first few rows. So whatever decides what somebody
 * may see on the Leads page — their downline, `companies.viewAll`, the module switch — decides it
 * here too, and a scope nobody could open as a page is not offered at all.
 */

async function mayUse(userId: string, scope: SearchScope): Promise<boolean> {
  if (!(await isModuleEnabled(scope.module))) return false;
  return scope.permission ? can(userId, scope.permission) : true;
}

/** The scopes this person can search, in the order the dropdown shows them. */
export async function searchScopesForMe(): Promise<{ key: SearchScopeKey; label: string; listPath: string }[]> {
  const user = await requireUser();
  const allowed = await Promise.all(SEARCH_SCOPES.map((s) => mayUse(user.id, s)));
  return SEARCH_SCOPES.filter((_, i) => allowed[i]).map((s) => ({ key: s.key, label: s.label, listPath: s.listPath }));
}

export type SearchResult = { ok: true; hits: SearchHit[]; more: boolean } | { ok: false; error: string };

export async function searchRecords(scopeKey: string, rawQuery: string): Promise<SearchResult> {
  const user = await requireUser();
  const scope = searchScope(scopeKey);
  if (!scope) return { ok: false, error: "Choose what to search." };
  // The same refusal whether the module is off or the permission is missing: the box only offers
  // scopes that pass, so this is reached by a stale tab or a hand-made request, and neither is owed
  // the reason.
  if (!(await mayUse(user.id, scope))) return { ok: false, error: `You can't search ${scope.label.toLowerCase()}.` };

  const query = typeof rawQuery === "string" ? rawQuery.trim().slice(0, SEARCH_MAX_LENGTH) : "";
  if (query.length < SEARCH_MIN_LENGTH) return { ok: true, hits: [], more: false };

  const page = { page: 1, pageSize: SEARCH_RESULT_LIMIT + 1 };
  const hits = await run(scope.key, query, page);
  return { ok: true, hits: hits.slice(0, SEARCH_RESULT_LIMIT), more: hits.length > SEARCH_RESULT_LIMIT };
}

const joined = (...parts: (string | null | undefined)[]) => parts.filter((p) => p && p.trim()).join(" · ") || null;

/** One more row than is shown, so "See all results" can say whether there are more. */
async function run(key: SearchScopeKey, search: string, page: { page: number; pageSize: number }): Promise<SearchHit[]> {
  switch (key) {
    case "customers":
    case "companies":
    case "vendors": {
      const list = key === "customers" ? listCustomersPaged : key === "vendors" ? listVendorsPaged : listCompaniesPaged;
      const { rows } = await list({ search, ...page });
      return rows.map((c) => ({
        id: c.id,
        title: c.name,
        subtitle: joined(formatCompanyId(c.companySeq), c.industry?.name, c.owner?.name),
        href: `/companies/${c.id}`,
      }));
    }
    case "contacts": {
      const { rows } = await listAllContactsPaged({ search, ...page });
      return rows.map((c) => ({
        id: c.id,
        title: c.name,
        subtitle: joined(c.company?.name, c.designation),
        // Contacts have no page of their own; they live on their company's.
        href: c.company ? `/companies/${c.company.id}?tab=contacts` : `/contacts?q=${encodeURIComponent(c.name)}`,
      }));
    }
    case "leads": {
      const { rows } = await listLeadsPaged({ search, ...page });
      return rows.map((l) => ({
        id: l.id,
        title: l.title,
        subtitle: joined(formatLeadId(l.leadSeq), l.company?.name),
        href: `/leads/${l.id}`,
      }));
    }
    case "orders": {
      const { rows } = await listOrdersPaged({ search, ...page });
      return rows.map((o) => ({
        id: o.id,
        title: o.company?.name ?? formatOrderId(o.orderSeq),
        subtitle: joined(formatOrderId(o.orderSeq), o.item?.name),
        href: `/orders/${o.id}`,
      }));
    }
    case "renewals": {
      const { rows } = await listRenewalsPaged({ search, ...page });
      return rows.map((r) => ({
        id: r.id,
        title: r.company?.name ?? formatOrderId(r.orderSeq),
        subtitle: joined(r.item?.name, r.endDate ? `renews ${formatDate(r.endDate)}` : null),
        // A renewal is an order record, so it opens as one.
        href: `/orders/${r.id}`,
      }));
    }
    case "proposals":
    case "invoices": {
      const { rows } = await listTradeDocuments({ docType: key === "proposals" ? "PROPOSAL" : "INVOICE", search, ...page });
      return rows.map((d) => ({
        id: d.id,
        title: d.docNumber ?? "Draft",
        subtitle: joined(d.company?.name, formatDate(d.issueDate)),
        href: documentPath(d.id),
      }));
    }
    case "tickets": {
      const { rows } = await listTicketsPaged({ search, ...page });
      return rows.map((t) => ({
        id: t.id,
        title: t.title,
        subtitle: joined(formatTicketId(t.ticketSeq), t.company?.name),
        href: `/tickets/${t.id}`,
      }));
    }
    case "projects": {
      // Not paged — a project list is short, and this is the action the Projects page itself uses.
      const rows = await listProjects({ q: search });
      return rows.slice(0, page.pageSize).map((p) => ({
        id: p.id,
        title: p.name,
        subtitle: joined(p.code, p.company?.name),
        href: `/projects/${p.id}`,
      }));
    }
    case "items": {
      const { items } = await listItems({ search, ...page });
      return items.map((i) => ({
        id: i.id,
        title: i.name,
        subtitle: joined(formatItemId(i.itemSeq), i.sku),
        href: `/items/${i.id}`,
      }));
    }
  }
}
