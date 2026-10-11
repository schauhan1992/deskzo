import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { BANNER_WIDTH, type SignatureBannerSpec } from "@/lib/signatures/render";

/**
 * Banners under the signature (`SignatureBanner`): set once by whoever manages signatures, for the
 * whole company or for the signatures of some templates, and shown while they run — from and to days
 * in the workspace's own calendar. A signature carries one banner at most: one meant for its template
 * before one meant for everybody, then the one that started last.
 *
 * A change is picked up by itself: every sync draws each signature afresh and sends what changed, and
 * Outlook asks for the signature as each message starts — so a banner starts and ends on its days
 * without anybody pressing anything.
 */

/** Uploaded pictures: the kinds every mail program shows (no WebP — classic Outlook doesn't), 1 MB at most. */
export const BANNER_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif"] as const;
export const BANNER_IMAGE_MAX_BYTES = 1024 * 1024;

export type BannerRow = {
  id: string;
  name: string;
  imageUrl: string | null;
  linkUrl: string | null;
  altText: string;
  width: number;
  startsOn: Date | null;
  endsOn: Date | null;
  paused: boolean;
  templateIds: unknown;
  updatedAt: Date;
};

/** Everything but the uploaded picture itself, which only its own route reads. */
export const BANNER_SELECT = {
  id: true,
  name: true,
  imageUrl: true,
  linkUrl: true,
  altText: true,
  width: true,
  startsOn: true,
  endsOn: true,
  paused: true,
  templateIds: true,
  updatedAt: true,
} as const;

export type BannerState = "live" | "scheduled" | "ended" | "paused";

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** Where a banner stands on `today` (YYYY-MM-DD, the workspace's calendar). */
export function bannerState(b: Pick<BannerRow, "paused" | "startsOn" | "endsOn">, today: string): BannerState {
  if (b.paused) return "paused";
  const start = day(b.startsOn);
  const end = day(b.endsOn);
  if (end && end < today) return "ended";
  if (start && start > today) return "scheduled";
  return "live";
}

export function bannerTemplateIds(b: Pick<BannerRow, "templateIds">): string[] {
  return Array.isArray(b.templateIds) ? (b.templateIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
}

/** The picture's address: the upload, served by the workspace (its version in the address, so a new picture is a new address), or the https address given. */
export function bannerImageSrc(b: Pick<BannerRow, "id" | "imageUrl" | "updatedAt">, origin: string): string {
  return b.imageUrl ?? `${origin}/api/signatures/banner/${b.id}?v=${b.updatedAt.getTime()}`;
}

export type LiveBanner = { id: string; templateIds: string[]; startsOn: string; updatedAt: number; spec: SignatureBannerSpec };

/** The banners running today, ready to draw. */
export async function liveBanners(today: string, origin: string): Promise<LiveBanner[]> {
  let rows: BannerRow[];
  try {
    rows = await db.signatureBanner.findMany({ where: { paused: false, removedAt: null }, select: BANNER_SELECT });
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
  return rows
    .filter((b) => bannerState(b, today) === "live")
    .map((b) => ({
      id: b.id,
      templateIds: bannerTemplateIds(b),
      startsOn: day(b.startsOn) ?? "",
      updatedAt: b.updatedAt.getTime(),
      spec: { image: bannerImageSrc(b, origin), link: b.linkUrl ?? "", alt: b.altText, width: b.width || BANNER_WIDTH.default },
    }));
}

/** The one banner a template's signatures carry: one meant for it before one for everybody, then the latest to start. */
export function pickBanner(templateId: string, banners: LiveBanner[]): LiveBanner | null {
  const rank = (b: LiveBanner) => (b.templateIds.includes(templateId) ? 1 : 0);
  return (
    banners
      .filter((b) => b.templateIds.length === 0 || b.templateIds.includes(templateId))
      .sort((a, b) => rank(b) - rank(a) || b.startsOn.localeCompare(a.startsOn) || b.updatedAt - a.updatedAt)[0] ?? null
  );
}

/** The banner as drawn, without counting its clicks — for previews. */
export function bannerFor(templateId: string, banners: LiveBanner[]): SignatureBannerSpec | null {
  return pickBanner(templateId, banners)?.spec ?? null;
}
