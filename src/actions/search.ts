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
import { companyPath, itemPath, leadPath, orderPath, ticketPath } from "@/lib/record-links";
import { formatCalendarDay } from "@/lib/time/zone";
import {
  SEARCH_GROUP_LIMIT,
  SEARCH_MAX_LENGTH,
  SEARCH_MIN_LENGTH,
  SEARCH_PAGE_LIMIT,
  SEARCH_RESULT_LIMIT,
  SEARCH_SCOPES,
  searchScope,
  type SearchHit,
  type SearchScope,
  type SearchScopeKey,
} from "@/lib/search/scopes";
import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";

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
  const [allowed, wording] = await Promise.all([Promise.all(SEARCH_SCOPES.map((s) => mayUse(user.id, s))), getWording()]);
  // In the workspace's own words (Settings → Wording): "Search in Enquiries".
  return SEARCH_SCOPES.filter((_, i) => allowed[i]).map((s) => ({ key: s.key, label: s.term ? slot(wording, s.label, s.term) : s.label, listPath: s.listPath }));
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

/** One list's matches, searching everything. */
export type SearchGroup = { key: SearchScopeKey; label: string; listPath: string; hits: SearchHit[]; more: boolean };
export type EverythingResult = { ok: true; groups: SearchGroup[] } | { ok: false; error: string };

/**
 * Every list this person may search, at once — the header's "Everything" (owner, 23 Oct 2026), and the full
 * results page with a bigger share of each.
 *
 * The same lists as one at a time, each through its own page's action, so nothing is found here that the list
 * wouldn't show. A list that fails is left out rather than failing the rest. A record found twice — a customer is
 * a company too — is kept under the first list it is found in, in SEARCH_SCOPES' order. Only lists with a match.
 */
export async function searchEverything(rawQuery: string, perScope: number = SEARCH_GROUP_LIMIT): Promise<EverythingResult> {
  const user = await requireUser();
  const query = typeof rawQuery === "string" ? rawQuery.trim().slice(0, SEARCH_MAX_LENGTH) : "";
  if (query.length < SEARCH_MIN_LENGTH) return { ok: true, groups: [] };
  const limit = Math.min(SEARCH_PAGE_LIMIT, Math.max(1, Math.trunc(Number(perScope)) || SEARCH_GROUP_LIMIT));

  const [allowed, wording] = await Promise.all([Promise.all(SEARCH_SCOPES.map((s) => mayUse(user.id, s))), getWording()]);
  const scopes = SEARCH_SCOPES.filter((_, i) => allowed[i]);
  const found = await Promise.all(
    scopes.map(async (scope) => {
      try {
        return await run(scope.key, query, { page: 1, pageSize: limit + 1 });
      } catch {
        return [];
      }
    }),
  );

  const seen = new Set<string>();
  const groups: SearchGroup[] = [];
  scopes.forEach((scope, i) => {
    const all = found[i]!.filter((h) => !seen.has(h.href));
    const hits = all.slice(0, limit);
    for (const h of hits) seen.add(h.href);
    if (hits.length === 0) return;
    groups.push({ key: scope.key, label: scope.term ? slot(wording, scope.label, scope.term) : scope.label, listPath: scope.listPath, hits, more: all.length > limit });
  });
  return { ok: true, groups };
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
        href: companyPath(c.companySeq),
      }));
    }
    case "contacts": {
      const { rows } = await listAllContactsPaged({ search, ...page });
      return rows.map((c) => ({
        id: c.id,
        title: c.name,
        subtitle: joined(c.company?.name, c.designation),
        // Contacts have no page of their own; they live on their company's.
        href: c.company ? `${companyPath(c.company.companySeq)}?tab=contacts` : `/contacts?q=${encodeURIComponent(c.name)}`,
      }));
    }
    case "leads": {
      const { rows } = await listLeadsPaged({ search, ...page });
      return rows.map((l) => ({
        id: l.id,
        title: l.title,
        subtitle: joined(formatLeadId(l.leadSeq), l.company?.name),
        href: leadPath(l.leadSeq),
      }));
    }
    case "orders": {
      const { rows } = await listOrdersPaged({ search, ...page });
      return rows.map((o) => ({
        id: o.id,
        title: o.company?.name ?? formatOrderId(o.orderSeq),
        subtitle: joined(formatOrderId(o.orderSeq), o.item?.name),
        href: orderPath(o.orderSeq),
      }));
    }
    case "renewals": {
      const { rows } = await listRenewalsPaged({ search, ...page });
      // A typed day, held at UTC midnight: the day itself, in any zone.
      return rows.map((r) => ({
        id: r.id,
        title: r.company?.name ?? formatOrderId(r.orderSeq),
        subtitle: joined(r.item?.name, r.endDate ? `renews ${formatCalendarDay(r.endDate)}` : null),
        // A renewal is an order record, so it opens as one.
        href: orderPath(r.orderSeq),
      }));
    }
    case "proposals":
    case "invoices": {
      const { rows } = await listTradeDocuments({ docType: key === "proposals" ? "PROPOSAL" : "INVOICE", search, ...page });
      // The document's date is a calendar day held at UTC midnight (src/actions/trade-document.ts).
      return rows.map((d) => ({
        id: d.id,
        title: d.docNumber ?? "Draft",
        subtitle: joined(d.company?.name, formatCalendarDay(d.issueDate)),
        href: documentPath(d.id),
      }));
    }
    case "tickets": {
      const { rows } = await listTicketsPaged({ search, ...page });
      return rows.map((t) => ({
        id: t.id,
        title: t.title,
        subtitle: joined(formatTicketId(t.ticketSeq), t.company?.name),
        href: ticketPath(t.ticketSeq),
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
        href: itemPath(i.itemSeq),
      }));
    }
  }
}
