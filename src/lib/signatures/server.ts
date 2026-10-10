import { timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { digestSecret } from "@/lib/crypto";
import { cardCompany, cardOffReason, workspaceToday } from "@/lib/cards/server";
import { SOCIALS, type SignatureData, type SocialKey } from "@/lib/signatures/render";
import { layoutByKey } from "@/lib/signatures/premium";
import { moduleAvailableForTenant } from "@/lib/modules-access";

/**
 * Deskzo Signatures on the server: the company's settings, and a person's signature built from their
 * record. Server-only.
 *
 * Images in an email must be on the web, so a signature points at the workspace's own addresses:
 * /sig/logo for the company's mark and /sig/p/<token> for a person's photo, where the token is the
 * user's id and a MAC under the workspace's key — unguessable, and good only for that one photo.
 */

export type SignatureSettingsView = {
  templateKey: string;
  lockTemplate: boolean;
  accentColor: string;
  website: string | null;
  socials: Partial<Record<SocialKey, string>>;
  disclaimer: string | null;
  bannerImageUrl: string | null;
  bannerLink: string | null;
  showPhoto: boolean;
  showCard: boolean;
};

export const DEFAULT_SIGNATURE_SETTINGS: SignatureSettingsView = {
  templateKey: "simple",
  lockTemplate: false,
  accentColor: "#2563eb",
  website: null,
  socials: {},
  disclaimer: null,
  bannerImageUrl: null,
  bannerLink: null,
  showPhoto: true,
  showCard: true,
};

export function readSocials(raw: Prisma.JsonValue | unknown): Partial<Record<SocialKey, string>> {
  const out: Partial<Record<SocialKey, string>> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const s of SOCIALS) {
    const v = (raw as Record<string, unknown>)[s.key];
    if (typeof v === "string" && v.trim()) out[s.key] = v.trim().slice(0, 200);
  }
  return out;
}

export async function signatureSettings(): Promise<SignatureSettingsView> {
  const row = await db.signatureSettings.findUnique({ where: { id: "global" } });
  if (!row) return DEFAULT_SIGNATURE_SETTINGS;
  return {
    templateKey: layoutByKey(row.templateKey) ? row.templateKey : "simple",
    lockTemplate: row.lockTemplate,
    accentColor: row.accentColor,
    website: row.website,
    socials: readSocials(row.socials),
    disclaimer: row.disclaimer,
    bannerImageUrl: row.bannerImageUrl,
    bannerLink: row.bannerLink,
    showPhoto: row.showPhoto,
    showCard: row.showCard,
  };
}

async function photoMac(userId: string): Promise<string> {
  const digest = await digestSecret(`signature-photo:${userId}`);
  return digest.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 22);
}

/** The address part for a person's signature photo: "<userId>.<mac>". */
export async function photoToken(userId: string): Promise<string> {
  return `${userId}.${await photoMac(userId)}`;
}

/** The user a photo token is for, or null when the token isn't one this workspace made. */
export async function userFromPhotoToken(token: string): Promise<string | null> {
  if (typeof token !== "string" || token.length > 120) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const userId = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const wanted = Buffer.from(await photoMac(userId));
  return given.length === wanted.length && timingSafeEqual(given, wanted) ? userId : null;
}

/** Everything a person's signature shows, from their record and the company's settings. */
export async function signatureDataFor(userId: string, settings: SignatureSettingsView, origin: string): Promise<SignatureData | null> {
  const [user, company, today] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        active: true,
        photoUpdatedAt: true,
        department: { select: { name: true } },
        employeeProfile: { select: { designation: true, exitedOn: true } },
        branch: { select: { addressLine1: true, addressLine2: true, city: true, state: true, pincode: true } },
        signature: { select: { mobile: true } },
        digitalCard: { select: { slug: true, active: true, switchedOffWhy: true } },
      },
    }),
    cardCompany(),
    workspaceToday(),
  ]);
  if (!user) return null;
  // A card link only where Cards is on — otherwise its page and QR answer 404 in every email.
  const cardsOn = settings.showCard && !!user.digitalCard && (await moduleAvailableForTenant("cards"));
  // /sig/logo serves only png, jpeg, webp or gif; an SVG letterhead would be a broken image.
  const logoServable = !!company.logoDataUrl && /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(company.logoDataUrl);
  const b = user.branch;
  const branchAddress = b ? [b.addressLine1, b.addressLine2, b.city, b.state, b.pincode].filter((p) => p?.trim()).join(", ") : "";
  const card = cardsOn && user.digitalCard && cardOffReason(user.digitalCard, user, today) === null ? user.digitalCard : null;
  return {
    name: user.name,
    title: user.employeeProfile?.designation ?? undefined,
    department: user.department?.name ?? undefined,
    company: company.name || undefined,
    phone: user.phone ?? undefined,
    mobile: user.signature?.mobile ?? undefined,
    email: user.email,
    website: settings.website ?? undefined,
    address: branchAddress || company.address || undefined,
    logoUrl: logoServable ? `${origin}/sig/logo` : undefined,
    photoUrl: settings.showPhoto && user.photoUpdatedAt ? `${origin}/sig/p/${await photoToken(user.id)}?v=${user.photoUpdatedAt.getTime()}` : undefined,
    accent: settings.accentColor,
    socials: settings.socials,
    cardUrl: settings.showCard && card ? `${origin}/c/${card.slug}` : undefined,
    qrUrl: settings.showCard && card ? `${origin}/c/${card.slug}/qr` : undefined,
    banner: settings.bannerImageUrl ? { imageUrl: settings.bannerImageUrl, link: settings.bannerLink ?? undefined } : undefined,
    disclaimer: settings.disclaimer ?? undefined,
  };
}
