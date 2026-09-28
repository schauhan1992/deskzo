"use server";

import {
  archivePage,
  changePageSlug,
  createPage,
  defaultPageDocument,
  deletePage,
  getPage,
  getPageVersionDocument,
  listPageVersions,
  pagePreviewLink,
  publishPage,
  restorePageVersion,
  savePageDraft,
  savePageVersion,
  unarchivePage,
  unpublishPage,
} from "@/lib/cms/content";
import { cmsAction, revalidateCms } from "@/lib/cms/guard";
import { CMS_EVERYONE, CMS_PUBLISHERS, CMS_WRITERS, type CmsResult, type PageDetail, type PageDocument, type PageSaved, type PageVersionRow } from "@/lib/cms/types";

/**
 * Pages. `ref` is a page's id, or "builtin-<slug>" for a built-in page (home, pricing, security,
 * contact, signin, signup, terms, privacy) — saved or not. src/lib/cms/content.ts does the work,
 * checks each document against the site's content model, and writes the activity log.
 *
 *   cmsCreatePage          writers      a new page (slug + title), as a draft
 *   cmsGetPage             everybody    draft, published copy, status, version
 *   cmsSavePageDraft       writers      the draft; refused with `conflict` over a newer save unless `force`
 *   cmsPublishPage         publishers   the draft (or `document`) goes live; a version is kept
 *   cmsUnpublishPage       publishers   an added page off the site (never a built-in one)
 *   cmsPageVersions        everybody    publish history
 *   cmsPageVersion         everybody    one version's document
 *   cmsRestorePageVersion  writers      a version back into the draft
 *   cmsSavePageVersion     writers      the draft kept as a version, with a note
 *   cmsChangePageSlug      publishers   an added page's address
 *   cmsArchivePage / cmsUnarchivePage / cmsDeletePage   publishers   added pages only; delete needs archive first
 *   cmsPagePreviewLink     everybody    a 15-minute link to the draft on the public site
 *   cmsDefaultPageDocument everybody    a built-in page's default content ("Reset to the default")
 */

const ref = (value: unknown) => String(value ?? "").slice(0, 60);

export async function cmsCreatePage(input: { slug: string; title: string }): Promise<CmsResult<PageDetail>> {
  return cmsAction(CMS_WRITERS, async ({ user }) => {
    const page = await createPage({ slug: String(input?.slug ?? ""), title: String(input?.title ?? "") }, user);
    revalidateCms();
    return page;
  });
}

export async function cmsGetPage(pageRef: string): Promise<CmsResult<PageDetail>> {
  return cmsAction(CMS_EVERYONE, async () => getPage(ref(pageRef)));
}

export async function cmsSavePageDraft(pageRef: string, input: { document: PageDocument; version: string; force?: boolean }): Promise<CmsResult<PageSaved>> {
  return cmsAction(CMS_WRITERS, async ({ user }) => {
    const saved = await savePageDraft(ref(pageRef), { document: input?.document, version: String(input?.version ?? ""), force: input?.force === true }, user);
    revalidateCms();
    return saved;
  });
}

export async function cmsPublishPage(pageRef: string, input: { document?: PageDocument; version?: string; force?: boolean; note?: string } = {}): Promise<CmsResult<PageSaved>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    const saved = await publishPage(ref(pageRef), { document: input?.document, version: input?.version ? String(input.version) : undefined, force: input?.force === true, note: input?.note ? String(input.note) : undefined }, user);
    revalidateCms();
    return saved;
  });
}

export async function cmsUnpublishPage(pageRef: string): Promise<CmsResult<PageSaved>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    const saved = await unpublishPage(ref(pageRef), user);
    revalidateCms();
    return saved;
  });
}

export async function cmsPageVersions(pageRef: string): Promise<CmsResult<PageVersionRow[]>> {
  return cmsAction(CMS_EVERYONE, async () => listPageVersions(ref(pageRef)));
}

export async function cmsPageVersion(pageRef: string, versionId: string): Promise<CmsResult<PageDocument>> {
  return cmsAction(CMS_EVERYONE, async () => getPageVersionDocument(ref(pageRef), String(versionId ?? "")));
}

export async function cmsRestorePageVersion(pageRef: string, versionId: string, input: { version?: string; force?: boolean } = {}): Promise<CmsResult<PageSaved>> {
  return cmsAction(CMS_WRITERS, async ({ user }) => {
    const saved = await restorePageVersion(ref(pageRef), String(versionId ?? ""), { version: input?.version ? String(input.version) : undefined, force: input?.force === true ? true : undefined }, user);
    revalidateCms();
    return saved;
  });
}

export async function cmsSavePageVersion(pageRef: string, note: string): Promise<CmsResult<PageVersionRow>> {
  return cmsAction(CMS_WRITERS, async ({ user }) => savePageVersion(ref(pageRef), String(note ?? ""), user));
}

export async function cmsChangePageSlug(pageRef: string, slug: string): Promise<CmsResult<PageSaved>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    const saved = await changePageSlug(ref(pageRef), String(slug ?? ""), user);
    revalidateCms();
    return saved;
  });
}

export async function cmsArchivePage(pageRef: string): Promise<CmsResult<null>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    await archivePage(ref(pageRef), user);
    revalidateCms();
    return null;
  });
}

export async function cmsUnarchivePage(pageRef: string): Promise<CmsResult<null>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    await unarchivePage(ref(pageRef), user);
    revalidateCms();
    return null;
  });
}

export async function cmsDeletePage(pageRef: string): Promise<CmsResult<null>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    await deletePage(ref(pageRef), user);
    revalidateCms();
    return null;
  });
}

export async function cmsPagePreviewLink(pageRef: string): Promise<CmsResult<{ url: string; expiresAt: Date }>> {
  return cmsAction(CMS_EVERYONE, async ({ user }) => pagePreviewLink(ref(pageRef), user));
}

export async function cmsDefaultPageDocument(slug: string): Promise<CmsResult<PageDocument | null>> {
  return cmsAction(CMS_EVERYONE, async () => defaultPageDocument(String(slug ?? "")));
}
