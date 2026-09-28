"use server";

import { cmsAction, cmsActor, revalidateCms } from "@/lib/cms/guard";
import { deleteMedia, getMediaRows, listMedia, mediaUsage, updateMediaAlt, uploadMedia, type UploadedFile } from "@/lib/cms/media";
import { CMS_EVERYONE, CMS_PUBLISHERS, CMS_WRITERS, CmsRefused, type CmsResult, type MediaRow, type MediaUsage, type Paged } from "@/lib/cms/types";

/**
 * The media library. src/lib/cms/media.ts does the work (type sniffing, size, dedupe, "in use").
 *
 *   cmsUploadMedia     writers      FormData { file: File, alt?: string } — one image per call
 *   cmsListMedia       everybody    newest first, 48 a page, searched by filename or alt
 *   cmsGetMedia        everybody    several by id
 *   cmsUpdateMediaAlt  writers
 *   cmsMediaUsage      everybody    where an image is used
 *   cmsDeleteMedia     publishers   refused while the image is used anywhere (the message says where)
 *
 * Uploads over 1 MB need next.config.ts `experimental.serverActions.bodySizeLimit` raised (docs/runbook.md).
 */

export async function cmsUploadMedia(form: FormData): Promise<CmsResult<MediaRow & { duplicate: boolean }>> {
  return cmsAction(CMS_WRITERS, async ({ user }) => {
    if (!(form instanceof FormData)) throw new CmsRefused("Choose an image to upload.");
    const file = form.get("file");
    const row = await uploadMedia(file && typeof file === "object" ? (file as unknown as UploadedFile) : null, typeof form.get("alt") === "string" ? form.get("alt") : "", cmsActor(user));
    revalidateCms();
    return row;
  });
}

export async function cmsListMedia(filters: { q?: string; page?: number; needsAlt?: boolean } = {}): Promise<CmsResult<Paged<MediaRow>>> {
  return cmsAction(CMS_EVERYONE, async () => listMedia(filters ?? {}));
}

export async function cmsGetMedia(ids: string[]): Promise<CmsResult<MediaRow[]>> {
  return cmsAction(CMS_EVERYONE, async () => getMediaRows(Array.isArray(ids) ? ids.map(String) : []));
}

export async function cmsUpdateMediaAlt(id: string, alt: string): Promise<CmsResult<MediaRow>> {
  return cmsAction(CMS_WRITERS, async ({ user }) => {
    const row = await updateMediaAlt(String(id ?? ""), alt, cmsActor(user));
    revalidateCms();
    return row;
  });
}

export async function cmsMediaUsage(id: string): Promise<CmsResult<MediaUsage[]>> {
  return cmsAction(CMS_EVERYONE, async () => mediaUsage(String(id ?? "")));
}

export async function cmsDeleteMedia(id: string): Promise<CmsResult<null>> {
  return cmsAction(CMS_PUBLISHERS, async ({ user }) => {
    await deleteMedia(String(id ?? ""), cmsActor(user));
    revalidateCms();
    return null;
  });
}
