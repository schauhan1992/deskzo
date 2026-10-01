"use server";

import type { SiteLeadStatus } from "@deskzo/control-client";
import { cmsAction, cmsActor, revalidateCms } from "@/lib/cms/guard";
import { exportLeadsCsv, getLead, listLeads, updateLead } from "@/lib/cms/leads";
import { CMS_EVERYONE, CMS_PUBLISHERS, type CmsResult, type LeadDetail, type LeadFilters, type LeadRow, type Paged } from "@/lib/cms/types";

/**
 * The leads inbox. Everybody reads it (viewers included); editors and admins work it.
 *
 *   cmsListLeads      everybody    filters { status, topic, from, to (yyyy-mm-dd, India days), q, page }, 30 a page, counts by status
 *   cmsGetLead        everybody
 *   cmsUpdateLead     publishers   { status?, notes? } — notes replaced whole
 *   cmsMarkLeadSpam   publishers
 *   cmsExportLeads    publishers   the filtered inbox as CSV text (at most 10,000 rows), audited
 */

export async function cmsListLeads(filters: LeadFilters = {}): Promise<CmsResult<Paged<LeadRow> & { counts: Record<SiteLeadStatus, number> }>> {
  return cmsAction(CMS_EVERYONE, async () => listLeads(filters ?? {}));
}

export async function cmsGetLead(id: string): Promise<CmsResult<LeadDetail>> {
  return cmsAction(CMS_EVERYONE, async () => getLead(String(id ?? "")));
}

export async function cmsUpdateLead(id: string, change: { status?: SiteLeadStatus; notes?: string | null }): Promise<CmsResult<LeadDetail>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    const lead = await updateLead(String(id ?? ""), change ?? {}, cmsActor(user));
    revalidateCms();
    return lead;
  });
}

export async function cmsMarkLeadSpam(id: string): Promise<CmsResult<LeadDetail>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    const lead = await updateLead(String(id ?? ""), { status: "SPAM" }, cmsActor(user));
    revalidateCms();
    return lead;
  });
}

export async function cmsExportLeads(filters: LeadFilters = {}): Promise<CmsResult<{ filename: string; csv: string; rows: number }>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => exportLeadsCsv(filters ?? {}, cmsActor(user)));
}
