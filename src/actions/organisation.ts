"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { encryptSecret } from "@/lib/crypto";
import { organisationSettingsSchema, einvoiceSettingsSchema } from "@/lib/validation/trade-document";
import { reviewUrlSchema } from "@/lib/validation/feedback";
import { clampRating, MAX_RATING, MIN_RATING } from "@/lib/feedback/rating";
import type { ActionResult } from "@/actions/company";

const MAX_SIGNATURE_BYTES = 256 * 1024;

/** These details appear on every invoice we issue, so changing them is an admin-level act. */
async function requireSettingsAccess() {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) {
    return { user: null, error: "You can't change organisation settings." };
  }
  return { user, error: null };
}

export async function updateOrganisation(input: unknown): Promise<ActionResult<{ ok: true }>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  const parsed = organisationSettingsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;
  const blank = (value: string | undefined) => (value ? value : null);

  const fields = {
    legalName: data.legalName.trim(),
    tradeName: blank(data.tradeName),
    gstin: blank(data.gstin),
    pan: blank(data.pan?.toUpperCase()),
    cin: blank(data.cin?.toUpperCase()),
    addressLine1: blank(data.addressLine1),
    addressLine2: blank(data.addressLine2),
    city: blank(data.city),
    state: blank(data.state),
    // The state code drives the CGST/SGST-vs-IGST decision, so fall back to the GSTIN's own prefix
    // rather than leaving it unset and silently taxing every sale as inter-state.
    stateCode: blank(data.stateCode) ?? (data.gstin ? data.gstin.slice(0, 2) : null),
    pincode: blank(data.pincode),
    country: blank(data.country),
    email: blank(data.email),
    phone: blank(data.phone),
    bankName: blank(data.bankName),
    bankAccountNumber: blank(data.bankAccountNumber),
    bankIfsc: blank(data.bankIfsc?.toUpperCase()),
    bankBranch: blank(data.bankBranch),
    upiId: blank(data.upiId),
    invoiceTerms: blank(data.invoiceTerms),
    invoiceNotes: blank(data.invoiceNotes),
    roundOffTotals: data.roundOffTotals,
  };

  await db.organisationSettings.upsert({
    where: { id: "global" },
    create: { id: "global", ...fields },
    update: fields,
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "OrganisationSettings",
    entityId: "global",
    entityLabel: "Organisation details",
  });
  revalidatePath("/settings/organisation");
  return { ok: true, data: { ok: true } };
}

export async function updateEInvoiceSettings(input: unknown): Promise<ActionResult<{ ok: true }>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  const parsed = einvoiceSettingsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  if (data.einvoiceEnabled && data.einvoiceProvider !== "mock") {
    const existing = await db.organisationSettings.findUnique({
      where: { id: "global" },
      select: { einvoicePasswordCipher: true, einvoiceClientSecretCipher: true },
    });
    const willHavePassword = data.einvoicePassword || existing?.einvoicePasswordCipher;
    const willHaveSecret = data.einvoiceClientSecret || existing?.einvoiceClientSecretCipher;
    if (!data.einvoiceUsername || !willHavePassword || !data.einvoiceClientId || !willHaveSecret) {
      return { ok: false, error: "The NIC portal needs a username, password, client ID and client secret." };
    }
  }

  const fields = {
    einvoiceEnabled: data.einvoiceEnabled,
    einvoiceProvider: data.einvoiceProvider,
    einvoiceUsername: data.einvoiceUsername || null,
    einvoiceClientId: data.einvoiceClientId || null,
    einvoiceMinValue: data.einvoiceMinValue ?? null,
    // A blank secret means "keep what's stored" — the form is never sent the decrypted value, so
    // overwriting on blank would silently wipe working credentials every time the page is saved.
    ...(data.einvoicePassword ? { einvoicePasswordCipher: await encryptSecret(data.einvoicePassword) } : {}),
    ...(data.einvoiceClientSecret ? { einvoiceClientSecretCipher: await encryptSecret(data.einvoiceClientSecret) } : {}),
  };

  await db.organisationSettings.upsert({
    where: { id: "global" },
    create: { id: "global", legalName: "", ...fields },
    update: fields,
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "OrganisationSettings",
    entityId: "global",
    entityLabel: `E-invoicing ${data.einvoiceEnabled ? "enabled" : "disabled"} (${data.einvoiceProvider})`,
  });
  revalidatePath("/settings/organisation");
  return { ok: true, data: { ok: true } };
}

/**
 * The signature/stamp printed on issued documents. Stored as a data URL for the same reason as the
 * branding images — no writable disk is assumed anywhere in this deployment.
 */
export async function uploadSignature(dataUrl: string): Promise<ActionResult<{ ok: true }>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return { ok: false, error: "Use a PNG, JPEG or WebP image." };
  // Base64 is 4 characters per 3 bytes, so the encoded length bounds the decoded size closely enough.
  if ((match[2].length * 3) / 4 > MAX_SIGNATURE_BYTES) {
    return { ok: false, error: "That image is over 256KB — use a smaller one." };
  }

  await db.organisationSettings.upsert({
    where: { id: "global" },
    create: { id: "global", legalName: "", signatureDataUrl: dataUrl },
    update: { signatureDataUrl: dataUrl },
  });

  revalidatePath("/settings/organisation");
  return { ok: true, data: { ok: true } };
}

export async function removeSignature(): Promise<ActionResult<{ ok: true }>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  await db.organisationSettings.update({ where: { id: "global" }, data: { signatureDataUrl: null } });
  revalidatePath("/settings/organisation");
  return { ok: true, data: { ok: true } };
}

// ─── Letterhead ───────────────────────────────────────────────────────────────

/**
 * The paper HR letters are printed on.
 *
 * Deliberately separate from the app's branding. The mark at the top of an appointment letter is the
 * employer's; the one in the sidebar is the software's. They are usually the same image, and this
 * falls back to the branding logo when no letterhead logo is set — but an employer who white-labels
 * the app would otherwise be signing letters with somebody else's mark.
 */
export async function updateLetterhead(input: {
  letterheadFooter?: string;
  letterNumberPrefix?: string;
  letterSignatoryName?: string;
  letterSignatoryTitle?: string;
}): Promise<ActionResult<{ ok: true }>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  const prefix = (input.letterNumberPrefix ?? "").trim().toUpperCase();
  // The prefix goes into a reference number people quote back at you, and into a column that is
  // unique — a space or a slash would produce numbers nobody can read out over the phone.
  if (prefix && !/^[A-Z0-9-]{2,10}$/.test(prefix)) {
    return { ok: false, error: "The prefix should be 2–10 letters, digits or hyphens — it goes into every letter number." };
  }

  const fields = {
    letterheadFooter: input.letterheadFooter?.trim() || null,
    letterNumberPrefix: prefix || "WRF",
    letterSignatoryName: input.letterSignatoryName?.trim() || null,
    letterSignatoryTitle: input.letterSignatoryTitle?.trim() || null,
  };

  await db.organisationSettings.upsert({
    where: { id: "global" },
    create: { id: "global", legalName: "", ...fields },
    update: fields,
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "OrganisationSettings",
    entityId: "global",
    entityLabel: "Letterhead",
  });
  revalidatePath("/settings/organisation");
  return { ok: true, data: { ok: true } };
}

export async function uploadLetterheadLogo(dataUrl: string): Promise<ActionResult<{ ok: true }>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  const match = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return { ok: false, error: "Use a PNG, JPEG, WebP or SVG image." };
  if ((match[2].length * 3) / 4 > MAX_SIGNATURE_BYTES) {
    return { ok: false, error: "That image is over 256KB — use a smaller one." };
  }

  await db.organisationSettings.upsert({
    where: { id: "global" },
    create: { id: "global", legalName: "", letterheadLogoDataUrl: dataUrl },
    update: { letterheadLogoDataUrl: dataUrl },
  });
  revalidatePath("/settings/organisation");
  return { ok: true, data: { ok: true } };
}

export async function removeLetterheadLogo(): Promise<ActionResult<{ ok: true }>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };
  await db.organisationSettings.update({ where: { id: "global" }, data: { letterheadLogoDataUrl: null } });
  revalidatePath("/settings/organisation");
  return { ok: true, data: { ok: true } };
}

/**
 * How feedback links behave, and who gets offered the public review page.
 *
 * The threshold is stored rather than hard-coded because it is the one decision in the feedback
 * module with a policy attached to it: Google's review policy prohibits soliciting reviews only
 * from customers you already know are happy. Setting it to 1 offers the page to everybody, which
 * is the compliant setting. Whatever it is set to, every response is recorded here in full —
 * the threshold decides where somebody is sent, never whether their answer is kept.
 */
export async function updateFeedbackSettings(input: {
  feedbackReviewUrl?: string;
  feedbackReviewMinRating?: number;
  feedbackLinkDays?: number;
  feedbackIntro?: string;
}): Promise<ActionResult<{ ok: true }>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  const parsedUrl = reviewUrlSchema.safeParse(input.feedbackReviewUrl ?? "");
  if (!parsedUrl.success) {
    return { ok: false, error: parsedUrl.error.issues[0]?.message ?? "That review link isn't a web address." };
  }

  const days = Math.min(365, Math.max(1, Math.round(input.feedbackLinkDays ?? 30)));
  const minRating = clampRating(input.feedbackReviewMinRating ?? 4);

  const fields = {
    feedbackReviewUrl: parsedUrl.data?.trim() || null,
    feedbackReviewMinRating: minRating,
    feedbackLinkDays: days,
    feedbackIntro: input.feedbackIntro?.trim() || null,
  };

  await db.organisationSettings.upsert({
    where: { id: "global" },
    create: { id: "global", legalName: "", ...fields },
    update: fields,
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "OrganisationSettings",
    entityId: "global",
    // Spelled out in the audit trail, because "who decided to only ask happy customers" is exactly
    // the question somebody asks six months later.
    entityLabel:
      minRating <= MIN_RATING
        ? "Feedback — every customer is offered the public review page"
        : `Feedback — only ${minRating}/${MAX_RATING} and above are offered the public review page`,
  });
  revalidatePath("/settings/organisation");
  revalidatePath("/feedback");
  return { ok: true, data: { ok: true } };
}

/**
 * How marketing behaves before anything reaches a provider.
 *
 * Quiet hours and the non-working-day skip are not politeness settings — a campaign that lands at
 * 2am on a Sunday tells a customer nobody here knows what day it is. The frequency cap is the one
 * that stops four separate campaigns, each perfectly reasonable on its own, from arriving in one
 * morning.
 */
export async function updateMarketingSettings(input: {
  marketingFromDomain?: string;
  marketingPostalAddress?: string;
  marketingQuietStartMinute?: number;
  marketingQuietEndMinute?: number;
  marketingSkipNonWorkingDays?: boolean;
  marketingMaxPerContactPerWeek?: number;
  marketingApprovalThreshold?: number;
}): Promise<ActionResult<{ ok: true }>> {
  const { user, error } = await requireSettingsAccess();
  if (!user) return { ok: false, error: error! };

  const minute = (value: number | undefined, fallback: number) =>
    Math.min(1439, Math.max(0, Math.round(value ?? fallback)));

  // Pasted addresses arrive in every shape — with a scheme, with a trailing path, with an @ in
  // front. Pulled apart with string operations rather than a regex, which is easier to read and
  // harder to get subtly wrong.
  const raw = (input.marketingFromDomain ?? "").trim().toLowerCase();
  const withoutScheme = raw.includes("://") ? raw.slice(raw.indexOf("://") + 3) : raw;
  const withoutUser = withoutScheme.includes("@") ? withoutScheme.slice(withoutScheme.indexOf("@") + 1) : withoutScheme;
  const domain = withoutUser.split("/")[0].trim() || null;
  if (domain && (!domain.includes(".") || /[^a-z0-9.-]/.test(domain))) {
    return { ok: false, error: "That isn't a domain — just the part after the @, like mail.wroffy.com." };
  }

  const fields = {
    marketingFromDomain: domain,
    marketingPostalAddress: input.marketingPostalAddress?.trim() || null,
    marketingQuietStartMinute: minute(input.marketingQuietStartMinute, 1200),
    marketingQuietEndMinute: minute(input.marketingQuietEndMinute, 540),
    marketingSkipNonWorkingDays: input.marketingSkipNonWorkingDays ?? true,
    // 0 disables the cap rather than blocking everything — see `withinFrequencyCap`.
    marketingMaxPerContactPerWeek: Math.max(0, Math.round(input.marketingMaxPerContactPerWeek ?? 2)),
    marketingApprovalThreshold: Math.max(1, Math.round(input.marketingApprovalThreshold ?? 200)),
  };

  await db.organisationSettings.upsert({
    where: { id: "global" },
    create: { id: "global", legalName: "", ...fields },
    update: fields,
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "OrganisationSettings",
    entityId: "global",
    entityLabel: `Marketing — ${fields.marketingMaxPerContactPerWeek === 0 ? "no frequency cap" : `at most ${fields.marketingMaxPerContactPerWeek} a week per contact`}, approval above ${fields.marketingApprovalThreshold}`,
  });
  revalidatePath("/settings/organisation");
  revalidatePath("/marketing");
  return { ok: true, data: { ok: true } };
}
