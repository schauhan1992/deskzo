"use server";

import { cmsAction, revalidateCms } from "@/lib/cms/guard";
import { checkRedirect, createRedirect, deleteRedirect, exportRedirectsCsv, getRedirect, importRedirects, listRedirects, previewRedirectImport, updateRedirect } from "@/lib/cms/redirects";
import { CMS_PUBLISHERS, type CmsResult, type Paged, type RedirectCheck, type RedirectFilters, type RedirectImportResult, type RedirectInput, type RedirectRow } from "@/lib/cms/types";

/**
 * The redirect manager, for editors and admins only (spec §1.5). Only an admin may point a redirect
 * at another site. src/lib/cms/redirects.ts does the work — normalising, the loop and chain checks,
 * the 5,000 limit — and writes the activity log (redirect.create / update / delete / import).
 *
 *   cmsListRedirects          publishers   filters { q, match, enabled, automatic, external, chained, sort, page }, 50 a page; `used` of `max`
 *   cmsGetRedirect            publishers
 *   cmsCheckRedirect          publishers   the dialog's live checks: the redirect as it would be saved, its issues and chain; nothing written
 *   cmsCreateRedirect         publishers   { from, to, status?, match?, enabled?, note? }
 *   cmsUpdateRedirect         publishers   only the fields given
 *   cmsDeleteRedirect         publishers
 *   cmsPreviewRedirectImport  publishers   CSV text (from, to, status, match, note; at most 1,000 rows): what each row would do
 *   cmsImportRedirects        publishers   the same, applied (refused rows skipped)
 *   cmsExportRedirects        publishers   every redirect as CSV text, guarded against formulas
 */

const rid = (value: unknown) => String(value ?? "").slice(0, 40);
const CSV_MAX = 1_000_000;

export async function cmsListRedirects(filters: RedirectFilters = {}): Promise<CmsResult<Paged<RedirectRow> & { used: number; max: number }>> {
  return cmsAction(CMS_PUBLISHERS, async () => listRedirects(filters ?? {}));
}

export async function cmsGetRedirect(redirectId: string): Promise<CmsResult<RedirectRow>> {
  return cmsAction(CMS_PUBLISHERS, async () => getRedirect(rid(redirectId)));
}

export async function cmsCheckRedirect(input: RedirectInput, exceptId?: string | null): Promise<CmsResult<RedirectCheck>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => checkRedirect(input ?? { from: "", to: "" }, user, exceptId ? rid(exceptId) : null));
}

export async function cmsCreateRedirect(input: RedirectInput): Promise<CmsResult<RedirectRow>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    const row = await createRedirect(input ?? { from: "", to: "" }, user);
    revalidateCms();
    return row;
  });
}

export async function cmsUpdateRedirect(redirectId: string, input: Partial<RedirectInput>): Promise<CmsResult<RedirectRow>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    const row = await updateRedirect(rid(redirectId), input ?? {}, user);
    revalidateCms();
    return row;
  });
}

export async function cmsDeleteRedirect(redirectId: string): Promise<CmsResult<null>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    await deleteRedirect(rid(redirectId), user);
    revalidateCms();
    return null;
  });
}

export async function cmsPreviewRedirectImport(csv: string): Promise<CmsResult<RedirectImportResult>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => previewRedirectImport(String(csv ?? "").slice(0, CSV_MAX + 1), user));
}

export async function cmsImportRedirects(csv: string): Promise<CmsResult<RedirectImportResult>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    const result = await importRedirects(String(csv ?? "").slice(0, CSV_MAX + 1), user);
    revalidateCms();
    return result;
  });
}

export async function cmsExportRedirects(): Promise<CmsResult<{ filename: string; csv: string; rows: number }>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => exportRedirectsCsv(user));
}
