"use server";

import { cmsAction, revalidateCms } from "@/lib/cms/guard";
import { startGuide } from "@/lib/cms/guides";
import { CMS_WRITERS, type CmsResult, type PageDetail } from "@/lib/cms/types";

/**
 * The Help Center's guides (src/lib/cms/guides.ts). A guide is a page under help/: everything after
 * it is started is the Pages actions' (src/actions/cms/pages.ts).
 *
 *   cmsStartGuide   writers   a draft guide for a module that has none, at help/<its name>
 */
export async function cmsStartGuide(moduleKey: string): Promise<CmsResult<PageDetail>> {
  return cmsAction(CMS_WRITERS, async ({ user }) => {
    const page = await startGuide(String(moduleKey ?? "").slice(0, 60), user);
    revalidateCms();
    return page;
  });
}
