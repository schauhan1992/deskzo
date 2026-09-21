"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { DEFAULT_BRANDING, type Branding } from "@/lib/branding";
import { brandingSettingsSchema } from "@/lib/validation/branding";
import type { ActionResult } from "@/actions/company";

/**
 * Read by the root layout on every request, so it must never throw — an unseeded database or a
 * missing row falls back to the defaults rather than taking the whole app down.
 */
export async function getBranding(): Promise<Branding> {
  try {
    const row = await db.brandingSettings.findUnique({ where: { id: "global" } });
    if (!row) return DEFAULT_BRANDING;
    return {
      appName: row.appName,
      shortName: row.shortName,
      tagline: row.tagline,
      logoDataUrl: row.logoDataUrl,
      faviconDataUrl: row.faviconDataUrl,
      primaryColor: row.primaryColor,
      defaultTheme: row.defaultTheme,
    };
  } catch {
    return DEFAULT_BRANDING;
  }
}

export async function updateBranding(input: unknown): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) {
    return { ok: false, error: "You can't change branding." };
  }
  const parsed = brandingSettingsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  await db.brandingSettings.upsert({
    where: { id: "global" },
    create: {
      id: "global",
      appName: data.appName.trim(),
      shortName: data.shortName || null,
      tagline: data.tagline || null,
      primaryColor: data.primaryColor,
      defaultTheme: data.defaultTheme,
    },
    update: {
      appName: data.appName.trim(),
      shortName: data.shortName || null,
      tagline: data.tagline || null,
      primaryColor: data.primaryColor,
      defaultTheme: data.defaultTheme,
    },
  });

  // Branding is in the root layout, so every route's shell is stale until the whole tree revalidates.
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

const MAX_IMAGE_BYTES = 256 * 1024;
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/svg+xml", "image/webp", "image/x-icon"];

/**
 * Logos are stored as data URLs on the settings row, which keeps deployment simple (no writable
 * disk, no bucket) at the cost of a size ceiling — hence the 256KB cap and the type allow-list.
 */
export async function uploadBrandingImage(kind: "logo" | "favicon", dataUrl: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) {
    return { ok: false, error: "You can't change branding." };
  }

  const match = /^data:([a-z+/-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) {
    return { ok: false, error: "That doesn't look like an image file." };
  }
  const [, mimeType, base64] = match;
  if (!ALLOWED_TYPES.includes(mimeType)) {
    return { ok: false, error: "Use a PNG, JPEG, SVG, WebP or ICO file." };
  }
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes > MAX_IMAGE_BYTES) {
    return { ok: false, error: `That image is ${Math.round(bytes / 1024)}KB — keep it under ${MAX_IMAGE_BYTES / 1024}KB.` };
  }

  await db.brandingSettings.upsert({
    where: { id: "global" },
    create: { id: "global", ...(kind === "logo" ? { logoDataUrl: dataUrl } : { faviconDataUrl: dataUrl }) },
    update: kind === "logo" ? { logoDataUrl: dataUrl } : { faviconDataUrl: dataUrl },
  });

  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

export async function removeBrandingImage(kind: "logo" | "favicon"): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) {
    return { ok: false, error: "You can't change branding." };
  }
  await db.brandingSettings.upsert({
    where: { id: "global" },
    create: { id: "global" },
    update: kind === "logo" ? { logoDataUrl: null } : { faviconDataUrl: null },
  });
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}
